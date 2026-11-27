import { afterEach, expect, setSystemTime, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMain, INTERRUPTED_LINE, type MainEnv, type MainWall } from './lanes-main.ts'
import { Journal } from './lanes-state.ts'

const T = Date.parse('2026-11-27T16:03:00Z') // 00:03 the next day in Taipei
const dirs: string[] = []
afterEach(() => {
  setSystemTime()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup() {
  setSystemTime(T)
  const dir = mkdtempSync(join(tmpdir(), 'wo204-'))
  dirs.push(dir)
  const journal = new Journal(join(dir, 'journal'), () => Date.now())
  const sid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  journal.write('main', '123', 'idle', { pid: 123, session_id: sid })
  const wall: MainWall = { walled: false, clearedMs: null }
  const offers: { ids: string[]; text: string; at: number }[] = [], notices: string[] = [], menus: boolean[] = []
  const env: MainEnv = { journal, agent: 'adam', usageWall: () => wall,
    memberState: () => wall.walled ? 'walled' : 'idle', owed: r => !!r.event,
    menu: async drive => { menus.push(!!drive); return { text: '選單已收', asks: false } },
    offer: async n => {
      const p = n.params as { meta: { did: string }; content: string }
      offers.push({ ids: p.meta.did.split(','), text: p.content, at: Date.now() })
      return true
    }, streamOpen: () => true, pidAlive: () => true, info: () => null, done: () => {}, undone: () => {},
    tellJoey: (_text, rule) => notices.push(rule), log: () => {}, expectedSession: () => [sid], refused: () => {}, genChanged: () => {}, context: () => '' }
  const main = createMain(env)
  main.initMain()
  const hook = (event: string, prompt_id: string, more: object = {}) => main.mainEvent({ event, prompt_id, pid: 123, session_id: sid, ...more })
  const add = (kind: 'joey' | 'peer', text: string) => main.enqueue(kind, { method: 'notifications/claude/channel', params: { content: text, meta: {} } }, { event: text })
  const refuse = async (prompt: string) => {
    wall.walled = true; wall.lastWallMs = Date.now()
    await hook('StopFailure', prompt, { error: 'rate_limit' })
    await Bun.sleep(0)
  }
  const clear = async () => {
    setSystemTime(Date.now() + 1_000)
    wall.walled = false; wall.clearedMs = Date.now()
    main.statusChanged(wall.clearedMs)
    await Bun.sleep(0) // No manual pump or watchdog tick drives a clear.
  }
  const resumes = () => journal.rows('msg', r => !!r.wall_resume)
  return { main, env, journal, offers, notices, menus, add, hook, refuse, clear, wall, resumes }
}

test('an interrupted bare prompt gets one dated resume on clear, through the menu and into a bound turn', async () => {
  const d = setup()
  await d.hook('UserPromptSubmit', 'typed')
  await d.refuse('typed')
  setSystemTime(T + 120_000)
  await d.main.tick()
  expect(d.offers).toEqual([])
  expect(d.menus).toEqual([])
  const [resume] = d.resumes()
  expect(resume).toMatchObject({ state: 'queued', reason: 'stop_failure:rate_limit', waited: 'wall', wall_resume: d.main.currentGen()!.wall_since })
  await d.clear()
  expect(d.menus).toEqual([true])
  expect(d.offers).toEqual([{ ids: [resume.id], text: '額度通了，上一回合 00:03（台北）被用量上限打斷，接著做沒做完的；沒有要接的就直接結束這一回合。', at: d.wall.clearedMs! }])
  expect(resume.state).toBe('offered')
  await d.hook('UserPromptSubmit', 'continued', { dids: [resume.id] })
  expect(resume.state).toBe('bound')
  await d.hook('Stop', 'continued', { phase: 'final' })
  await d.main.tick()
  expect(d.offers).toHaveLength(1)
  expect(d.notices).toEqual(['main-wall-up', 'main-wall-down'])
})

test('a refused item with no output is the only probe', async () => {
  const d = setup(), id = d.add('joey', 'work')
  await Bun.sleep(0)
  await d.hook('UserPromptSubmit', 'p', { dids: [id] })
  await d.refuse('p'); await d.clear()
  expect(d.offers.map(o => o.ids)).toEqual([[id], [id]])
  expect(d.offers[1].text).toBe('work')
  expect(d.resumes()).toHaveLength(0)
})

test('a refused resume stays one item through another clear of the same episode', async () => {
  const d = setup()
  await d.refuse('typed'); await d.clear()
  const [r] = d.resumes()
  await d.hook('UserPromptSubmit', 'retry', { dids: [r.id] })
  await d.hook('PreToolUse', 'retry', { tool_name: 'Read' })
  setSystemTime(T + 60_000)
  await d.refuse('retry')
  expect(r.state).toBe('queued')
  await d.clear(); await d.main.tick()
  expect(d.offers.map(o => o.ids)).toEqual([[r.id], [r.id]])
  expect(d.offers[1].text).toContain('00:04（台北）')
  expect(d.resumes()).toHaveLength(1)
  expect(d.notices).toEqual(['main-wall-up'])
})

test('a peer waiting at clear supersedes the resume without taking it as a rider', async () => {
  const d = setup()
  await d.refuse('typed')
  const peer = d.add('peer', 'peer work')
  await Bun.sleep(0)
  expect(d.offers).toHaveLength(0)
  await d.clear(); await d.main.tick()
  expect(d.offers.map(o => o.ids)).toEqual([[peer]])
  expect(d.resumes()[0]).toMatchObject({ state: 'done', reason: 'wall_resume_superseded' })
})

test('all items cut by the account cap reach one offer at clear, each with the interruption line', async () => {
  const d = setup()
  const a = d.add('joey', 'first'), b = d.add('peer', 'second')
  await Bun.sleep(0)
  await d.hook('UserPromptSubmit', 'p', { dids: [a, b] })
  await d.hook('PreToolUse', 'p', { tool_name: 'Read' })
  await d.refuse('p')
  setSystemTime(T + 60_000)
  await d.main.tick()
  expect(d.offers).toHaveLength(1)
  await d.clear(); await d.main.tick()
  expect(d.offers.map(o => o.ids)).toEqual([[a], [a, b]])
  expect(d.offers[1].text.split(INTERRUPTED_LINE)).toHaveLength(3)
  expect(d.offers[1].at).toBe(d.wall.clearedMs!)
  expect(d.resumes()).toHaveLength(0)
  expect(d.notices).toEqual(['main-wall-up'])
})

test('a person can finish the episode while walled and retire its queued resume', async () => {
  const d = setup()
  await d.refuse('typed')
  const person = d.add('joey', 'question')
  setSystemTime(T + 60_000)
  await Bun.sleep(0); await d.main.tick()
  expect(d.offers.map(o => o.ids)).toEqual([[person]])
  await d.hook('UserPromptSubmit', 'human', { dids: [person] })
  expect((await d.hook('PostToolUse', 'human')).additionalContext).toBeUndefined()
  expect((await d.hook('Stop', 'human')).block).toBeUndefined()
  await d.hook('Stop', 'human', { phase: 'final' })
  await d.clear(); await d.main.tick()
  expect(d.resumes()[0]).toMatchObject({ state: 'done', reason: 'wall_resume_moot' })
  expect(d.offers.map(o => o.ids)).toEqual([[person]])
})

test('an existing 1.59.2 refusal can resume on a clear after upgrade', async () => {
  const d = setup()
  d.journal.write('main', '123', 'walled', { kind: 'rate_limit', wall_since: new Date(T).toISOString(), wall_refused_at: T })
  d.main.initMain()
  await d.clear()
  expect(d.resumes()).toHaveLength(1)
  expect(d.offers.map(o => o.ids)).toEqual([[d.resumes()[0].id]])
})

test('a refused item leads the same clear offer as an older item cut after output', async () => {
  const d = setup(), a = d.add('joey', 'first')
  await Bun.sleep(0)
  await d.hook('UserPromptSubmit', 'p', { dids: [a] })
  const b = d.add('peer', 'later')
  await d.hook('PostToolUse', 'p', { tool_name: 'Read' }) // output for a, then pull b
  await d.refuse('p')
  expect(d.journal.get('msg', a)?.reason).toBe('interrupted')
  expect(d.journal.get('msg', b)?.reason).toBe('stop_failure:rate_limit')
  await d.clear(); await d.main.tick()
  expect(d.offers.map(o => o.ids)).toEqual([[a], [b, a]])
  expect(d.offers[1].text.split(INTERRUPTED_LINE)).toHaveLength(2)
  expect(d.resumes()).toHaveLength(0)
})

test('a peer arriving while the probe drives the menu takes the resume offer', async () => {
  const d = setup()
  await d.refuse('p')
  let closed!: () => void
  d.env.menu = () => new Promise(resolve => { closed = () => resolve({ text: '選單已收', asks: false }) })
  await d.clear()
  const id = d.add('peer', 'arrived during menu')
  closed(); await Bun.sleep(0)
  expect(d.offers.map(o => o.ids)).toEqual([[id]])
  expect(d.resumes()[0]?.reason).toBe('wall_resume_superseded')
})

test('a Call which ended while walled leaves the resume available', async () => {
  const d = setup()
  await d.refuse('p')
  const id = d.main.enqueue('peer', { method: 'notifications/claude/channel', params: { content: 'Call' } },
    { event: 'call-9', fields: { call_id: '9' } })
  d.env.checkCall = async () => ({ final: 'completed' })
  await d.clear()
  expect(d.journal.get('msg', id)).toMatchObject({ state: 'done', reason: 'call_already_final' })
  expect(d.offers.map(o => o.ids)).toEqual([[d.resumes()[0].id]])
})

test('a second bare refusal leaves the episode’s earlier account cut as its only probe', async () => {
  const d = setup(), id = d.add('joey', 'original')
  await Bun.sleep(0)
  await d.hook('UserPromptSubmit', 'work', { dids: [id] })
  await d.hook('PreToolUse', 'work', { tool_name: 'Read' })
  await d.refuse('work')
  await d.refuse('another typed prompt')
  expect(d.resumes()).toHaveLength(0)
  await d.clear()
  expect(d.offers.map(o => o.ids)).toEqual([[id], [id]])
})
