import { afterEach, expect, setSystemTime, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMain, INTERRUPTED_LINE, type ItemKind, type MainEnv, type MainWall } from './lanes-main.ts'
import { Journal } from './lanes-state.ts'
import { OnsenClient } from './onsen-client.ts'
import { DeliveryFacts, LanesTap } from './onsen-status.ts'
import { decideWake, loadWakeTable } from './wake-decide.ts'

const sid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const T = Date.parse('2026-11-27T03:00:00Z')
afterEach(() => setSystemTime())

function daemon(age = 300_000, m2: 'idle' | 'walled' | 'offline' = 'walled') {
  setSystemTime(T)
  const dir = mkdtempSync(join(tmpdir(), 'wo200-'))
  const journal = new Journal(join(dir, 'journal'), () => Date.now())
  const wall: MainWall = { walled: true, lastWallMs: T - age, clearedMs: null, resets_at: '2026-12-02T07:00:00Z' }
  const offers: string[][] = [], texts: string[] = [], notices: string[] = []
  const requests: Array<{ method: string; path: string; body: any }> = []
  const calls = new Map<string, string>()
  const client = new OnsenClient({ agent: 'adam', base: 'http://fake', record: true, dir, credential: () => 'test', log: () => {},
    fetch: (async (input, init) => {
      const path = new URL(String(input)).pathname, body = init?.body ? JSON.parse(String(init.body)) : null
      requests.push({ method: init?.method ?? 'GET', path, body })
      const id = path.match(/^\/v1\/calls\/(\d+)$/)?.[1]
      return Response.json(id ? { data: { state: calls.get(id), thread_id: '9', conversation_id: '2', caller: 'scheduler' } }
        : path === '/deliveries/batch' ? { results: body.items.map(() => ({})) } : {})
    }) as typeof fetch })
  if (m2 !== 'offline') journal.write('main', '123', m2, { pid: 123, session_id: sid, retry_at: T + 3_600_000 })
  const env: MainEnv = { journal, agent: 'adam', usageWall: () => wall, memberState: () => wall.walled ? 'walled' : 'idle',
    offer: async n => { const p = n.params as any; offers.push(p.meta.did?.split(',') ?? []); texts.push(p.content); return true },
    streamOpen: () => true, pidAlive: () => true, info: () => null, done: () => {}, undone: () => {},
    tellJoey: (_s, rule) => notices.push(rule), log: () => {}, expectedSession: () => [sid], refused: () => {}, genChanged: () => {}, context: () => '',
    blocked: (r, retry_after) => { for (const id of r.person_message_ids) client.recordBlocked({ message_id: id, retry_after }) },
    checkCall: (id, why) => client.checkWaitingCall(id, why) }
  const main = createMain(env)
  main.initMain()
  const facts = new DeliveryFacts({ agent: 'adam', sink: f => client.recordDelivery(f) })
  const tap = new LanesTap({ facts, joey: () => null, gen: () => main.currentGen(), changed: () => {} })
  journal.observe((r, l) => tap.journal(r, l))
  const add = (kind: ItemKind, n: string, batched = false) => main.enqueue(kind, { method: 'notifications/claude/channel',
    params: { content: n, meta: { chat_id: '44', message_id: 'client-' + n } } },
    { fields: kind === 'joey' ? { person_message_ids: [n] } : { call_id: n }, batched })
  const flush = async () => { await Bun.sleep(0); await main.pump(); await Bun.sleep(0) }
  const hook = (event: string, prompt_id: string, other: object = {}) => main.mainEvent({ event, prompt_id, session_id: sid, pid: 123, ...other })
  const clear = () => { wall.walled = false; wall.clearedMs = Date.now(); main.statusChanged(wall.clearedMs) }
  return { env, journal, main, add, wall, offers, texts, notices, requests, calls, client, hook, clear, flush }
}

test('WO-200 (a) human probes an old wall immediately', async () => {
  const d = daemon(300_000, 'idle')
  const item = d.add('joey', '100')
  await d.flush()
  expect(d.offers).toEqual([[item]])
  expect(decideWake({ kind: 'joey_tg' }, { member: 'walled', personTarget: 'main_now' }, loadWakeTable()).target).toBe('main_now')
})

test('WO-200 (b) human probes once at the 60-second boundary', async () => {
  const d = daemon(10_000), item = d.add('joey', '101')
  await d.flush()
  setSystemTime(T + 49_999)
  await d.main.tick()
  expect(d.offers).toEqual([])
  setSystemTime(T + 50_000)
  await d.main.tick(); await d.main.tick()
  expect(d.offers).toEqual([[item]])
})

test('WO-200 (c) program waits through a human probe and is offered once on clear', async () => {
  const d = daemon(), call = d.add('peer', '5'), person = d.add('joey', '101')
  d.calls.set('5', 'accepted')
  await d.flush()
  expect(d.offers).toEqual([[person]])
  await d.hook('UserPromptSubmit', 'p', { dids: [person] })
  expect((await d.hook('PostToolUse', 'p', { tool_name: 'Read' })).additionalContext).toBeUndefined()
  await d.hook('Stop', 'p', { phase: 'final' }); await d.flush()
  expect(d.offers).toEqual([[person]])
  d.clear(); await d.flush(); await d.main.tick()
  expect(d.offers).toEqual([[person], [call]])
})

test('WO-200 ordinary registration keeps an older handoff out of a prompt naming a human message', async () => {
  const d = daemon(0, 'offline')
  d.wall.walled = false
  const handoff = d.main.enqueue('handoff', { method: 'notifications/claude/channel', params: { content: 'handoff', meta: {} } })
  // As in the daemon, stream registration and SessionStart can both ask M1 to offer in the same turn of the event loop.
  d.main.streamOpened(123)
  await d.hook('SessionStart', '', { source: 'startup' })
  const weekly = d.add('joey', 'weekly')
  await d.hook('UserPromptSubmit', 'p-weekly', { dids: [weekly] })
  const bound = d.main.turnWork(d.main.currentGen()!, 'p-weekly').items.map(r => r.id)
  expect(bound).toEqual([weekly])
  expect(d.journal.get('msg', handoff)?.state).toBe('offered')
})

test('WO-200 a human probe and a keeper clear each wake an overlapping offer pass', async () => {
  for (const wake of ['person', 'clear']) {
    const d = daemon()
    d.calls.set('9', 'accepted')
    const program = d.add('peer', '9')
    // The first pass is still in flight. No manual pump or timer drives the second delivery.
    const expected = wake === 'person' ? d.add('joey', '109') : program
    if (wake === 'clear') d.clear()
    await Bun.sleep(0)
    expect(d.offers).toEqual([[expected]])
  }
})

test('WO-200 M2 timer offers nothing while keeper state is fresh', async () => {
  const d = daemon()
  d.calls.set('9', 'accepted')
  d.add('peer', '9')
  setSystemTime(T + 3_600_001)
  await d.main.tick(); await d.flush()
  expect(d.offers).toEqual([])
  expect(d.requests).toEqual([])
})

test('WO-200 M2 timer keeps the existing probe and backoff without fresh keeper state', async () => {
  const d = daemon()
  d.env.usageWall = () => null
  d.calls.set('9', 'accepted')
  const item = d.add('peer', '9')
  await d.flush()
  expect(d.offers).toEqual([])
  setSystemTime(T + 3_600_000)
  const offer = d.env.offer
  let attempts = 0
  d.env.offer = async () => { attempts++; return false }
  await d.main.tick(); await d.flush()
  d.env.offer = offer
  await d.main.tick(); await d.flush()
  expect(attempts).toBe(1)
  expect(d.offers).toEqual([])
  setSystemTime(Number(d.main.currentGen()!.retry_at))
  await d.main.tick(); await d.flush(); await d.main.tick()
  expect(d.offers).toEqual([[item]])
})

test('WO-200 a keeper clear in the same second releases a refused message', async () => {
  const d = daemon(), item = d.add('joey', '108')
  await d.flush()
  await d.hook('UserPromptSubmit', 'p', { dids: [item] })
  setSystemTime(T + 123)
  await d.hook('StopFailure', 'p', { error: 'rate_limit' })
  d.wall.walled = false
  d.wall.clearedMs = T
  d.main.statusChanged(T)
  await d.flush()
  expect(d.offers).toEqual([[item], [item]])
})

test('WO-200 (d) two refusals write blocked receipts and replay in order once', async () => {
  const d = daemon(), ids: string[] = []
  for (const n of ['101', '102']) {
    const item = d.add('joey', n)
    ids.push(item)
    await d.flush()
    await d.hook('UserPromptSubmit', n, { dids: [item] })
    await d.hook('StopFailure', n, { error: 'rate_limit' })
    d.wall.resets_at = null
    setSystemTime(Date.now() + 60_000)
    await d.main.tick()
  }
  await d.client.syncNow(true)
  expect(d.requests.filter(r => r.method === 'PUT')).toEqual(['101', '102'].map(n => ({
    method: 'PUT', path: '/v1/messages/' + n + '/receipt', body: { handling: { state: 'blocked', blocked_by: 'usage_limit', retry_after: n === '101' ? '2026-12-02T07:00:00Z' : null } },
  })))
  expect(d.requests.some(r => r.path.includes('messages') && r.method === 'POST')).toBe(false)
  expect(d.requests.flatMap(r => r.body?.items ?? []).some(f => f.state === 'turn_end')).toBe(false)
  expect(d.offers).toEqual(ids.map(id => [id]))
  d.clear(); await d.flush()
  expect(d.offers).toEqual([[ids[0]], [ids[1]], ids])
  await d.hook('UserPromptSubmit', 'retry', { dids: ids })
  await d.hook('Stop', 'retry', { phase: 'final' }); await d.flush(); await d.main.tick()
  expect(d.offers).toHaveLength(3)
  await d.client.syncNow(true)
  expect(d.requests.flatMap(r => r.body?.items ?? []).filter(f => f.state === 'seen').map(f => f.turn_id)).toEqual(['101', '102', 'retry', 'retry'])
  expect(d.notices).toEqual(['main-wall-up', 'main-wall-down'])
})

test('WO-200 (e) the keeper clear immediately offers an account cut with the interrupted line', async () => {
  const d = daemon(), item = d.add('joey', '107')
  await d.flush()
  await d.hook('UserPromptSubmit', 'work', { dids: [item] })
  await d.hook('PreToolUse', 'work', { tool_name: 'Read' })
  await d.hook('StopFailure', 'work', { error: 'rate_limit' })
  expect(d.journal.get('msg', item)).toMatchObject({ state: 'queued', reason: 'interrupted', cut_by: 'stop_failure:rate_limit' })
  await d.main.tick()
  expect(d.offers).toEqual([[item]])
  d.clear(); await Bun.sleep(0)
  expect(d.offers).toEqual([[item], [item]])
  expect(d.texts[1]).toStartWith(INTERRUPTED_LINE)
  expect(d.texts[1]).not.toContain('接著做沒做完的')
})

test('WO-200 (f) final Call gets one thread line and only the open Call reaches main', async () => {
  const d = daemon()
  d.calls.set('5', 'failed'); d.calls.set('6', 'accepted')
  const stale = d.add('peer', '5'), open = d.add('peer', '6')
  await d.flush()
  expect(d.requests).toEqual([])
  d.clear(); await d.flush(); await d.main.tick()
  expect(d.offers).toEqual([[open]])
  expect(d.journal.get('msg', stale)).toMatchObject({ state: 'done', reason: 'call_already_final' })
  expect(d.requests.filter(r => r.method === 'POST')).toEqual([expect.objectContaining({ path: '/v1/conversations/2/messages',
    body: expect.objectContaining({ thread_ids: ['9'], body: { format: 'markdown', text: '上限解除時這件已經是 failed，沒有交給主線' } }) })])
})

test('WO-200 offline and restored Calls are checked before a hook can pull them', async () => {
  for (const cause of ['offline', 'restart']) {
    const d = daemon(300_000, cause === 'offline' ? 'offline' : 'idle')
    d.wall.walled = false
    // A batched Call cannot lead an offer. On restart this is an older journal without wait metadata.
    const item = d.add('peer', '8', true)
    const m = cause === 'restart' ? createMain(d.env) : d.main
    if (cause === 'restart') m.initMain()
    else expect((await m.mainEvent({ event: 'SessionStart', session_id: sid, pid: 123 })).accepted).toBe(true)
    await m.mainEvent({ event: 'UserPromptSubmit', prompt_id: 'work', session_id: sid, pid: 123 })
    const boundary = () => m.mainEvent({ event: 'PostToolUse', prompt_id: 'work', session_id: sid, pid: 123 })
    expect((await boundary()).additionalContext).toBeUndefined() // lookup has no state
    expect(d.journal.get('msg', item)?.state).toBe('queued')
    d.calls.set('8', cause === 'restart' ? 'expired' : 'cancelled')
    expect((await boundary()).additionalContext).toBeUndefined()
    expect((await boundary()).additionalContext).toBeUndefined()
    expect(d.journal.get('msg', item)).toMatchObject({ state: 'done', call_state: d.calls.get('8') })
    expect(d.requests.filter(r => r.method === 'POST').map(r => r.body.body.text)).toEqual([
      cause === 'restart' ? '重新啟動時這件已經是 expired，沒有交給主線' : '主線恢復連線時這件已經是 cancelled，沒有交給主線',
    ])
    expect(d.offers).toEqual([])
  }
})

test('WO-200 a wall returning during Call lookup keeps the program queued', async () => {
  const d = daemon(), item = d.add('peer', '5')
  await d.flush()
  let complete!: (result: 'open') => void
  d.env.checkCall = () => new Promise(resolve => { complete = resolve })
  d.clear()
  d.wall.walled = true
  d.wall.lastWallMs = Date.now()
  complete('open')
  await d.flush()
  expect(d.offers).toEqual([])
  expect(d.journal.get('msg', item)?.state).toBe('queued')
  d.env.checkCall = async () => 'open'
  d.clear(); await d.flush()
  expect(d.offers).toEqual([[item]])
})

const resumeText = '上一回合 11:00（台北）被打斷（用量上限），接著做沒做完的；沒有要接的就直接結束這一回合。'
async function bareRefusal() {
  const d = daemon(0, 'idle')
  await d.hook('UserPromptSubmit', 'work')
  await d.hook('StopFailure', 'work', { error: 'rate_limit' })
  return d
}

test('WO-204 (a,d) the menu precedes a bare resume, once across repeated refusals and daemon restart', async () => {
  const d = await bareRefusal()
  const episode = d.main.currentGen()!.wall_since
  setSystemTime(T + 60_000)
  await d.hook('UserPromptSubmit', 'another')
  await d.hook('StopFailure', 'another', { error: 'billing_error' })
  const steps: string[] = []
  d.env.menu = async drive => { if (drive) steps.push('menu'); return null }
  d.env.offer = async (n, via, pid) => {
    steps.push(`${via}/${pid} ${(n.params as any).content}`)
    // The session can open its turn before the stream write returns.
    await d.hook('UserPromptSubmit', 'resume')
    return true
  }
  setSystemTime(T + 180_000)
  await d.main.tick()
  expect(steps).toEqual([])
  d.clear(); await Bun.sleep(0)
  expect(steps).toEqual(['menu', 'tg/123 ' + resumeText.replace('11:00', '11:01')])
  expect(d.main.currentGen()).toMatchObject({ state: 'in_turn', prompt_id: 'resume', resume_sent: T + 60_000, resumes: 1 })
  expect(d.journal.rows('msg')).toEqual([])

  d.wall.walled = true
  await d.hook('StopFailure', 'resume', { error: 'rate_limit' })
  setSystemTime(T + 181_000)
  const journal = new Journal(d.journal.path)
  journal.load()
  const restarted = createMain({ ...d.env, journal })
  restarted.initMain()
  d.wall.walled = false
  d.wall.clearedMs = Date.now()
  restarted.statusChanged(d.wall.clearedMs)
  await restarted.tick()
  expect(restarted.currentGen()).toMatchObject({ state: 'walled', wall_since: episode, resume_sent: T + 60_000, resumes: 1 })
  expect(steps).toHaveLength(2)
})

test('WO-204 (c) both orders of refusal and account cut reach the same clear offer', async () => {
  for (const cutFirst of [true, false]) {
    const d = daemon()
    const ids: string[] = []
    for (const [i, cut] of [cutFirst, !cutFirst].entries()) {
      const id = d.add('joey', String(110 + i))
      ids.push(id)
      await d.flush()
      expect(d.offers[i]).toEqual([id])
      await d.hook('UserPromptSubmit', id, { dids: [id] })
      if (cut) await d.hook('PreToolUse', id, { tool_name: 'Read' })
      await d.hook('StopFailure', id, { error: 'billing_error' })
      setSystemTime(Date.now() + 60_001)
    }
    d.clear(); await Bun.sleep(0)
    expect(d.offers).toEqual([[ids[0]], [ids[1]], ids])
    expect(d.texts[2].split(INTERRUPTED_LINE)).toHaveLength(2)
    expect(d.texts[2]).not.toContain('接著做沒做完的')
  }
})

test('WO-204 (e,g) a waiting Call takes the clear, a cancelled Call gets its thread line and leaves a bare resume', async () => {
  for (const final of [false, true]) {
    const d = await bareRefusal()
    const item = d.add('peer', '7')
    d.calls.set('7', final ? 'cancelled' : 'accepted')
    await d.flush()
    expect(d.offers).toEqual([])
    d.clear(); await Bun.sleep(0)
    if (final) {
      expect(d.journal.get('msg', item)).toMatchObject({ state: 'done', reason: 'call_already_final' })
      expect(d.requests.filter(r => r.method === 'POST').map(r => r.body.body.text)).toEqual(['上限解除時這件已經是 cancelled，沒有交給主線'])
      expect(d.texts).toEqual([resumeText])
    } else {
      expect(d.offers).toEqual([[item]])
      expect(d.texts[0]).not.toContain('接著做沒做完的')
    }
  }
})

test('WO-204 (f) a successful person turn ends the episode before the keeper clears', async () => {
  const d = await bareRefusal()
  setSystemTime(T + 60_000)
  const item = d.add('joey', '122')
  await d.flush()
  await d.hook('UserPromptSubmit', 'person', { dids: [item] })
  await d.hook('Stop', 'person', { phase: 'final' })
  expect(d.main.currentGen()?.wall_since).toBeUndefined()
  d.clear(); await d.main.tick()
  expect(d.offers).toEqual([[item]])
})

test('WO-204 a failed stream write leaves the bare resume available on the same clear', async () => {
  const d = await bareRefusal(), offer = d.env.offer
  d.env.offer = async () => false
  d.clear(); await Bun.sleep(0)
  expect(d.main.currentGen()?.resume_sent).toBeUndefined()
  d.env.offer = offer
  await d.main.tick(); await d.main.tick()
  expect(d.texts).toEqual([resumeText])
  expect(d.main.currentGen()?.resume_sent).toBe(d.main.currentGen()?.cut_turn.at)
})

test('WO-204 a person can finish during the wall while an older account cut still waits for the clear', async () => {
  const d = daemon(), cut = d.add('joey', '123')
  await d.flush()
  await d.hook('UserPromptSubmit', 'work', { dids: [cut] })
  await d.hook('PreToolUse', 'work', { tool_name: 'Read' })
  await d.hook('StopFailure', 'work', { error: 'rate_limit' })
  setSystemTime(T + 60_001)
  const person = d.add('joey', '124')
  await d.flush()
  await d.hook('UserPromptSubmit', 'person', { dids: [person] })
  await d.hook('Stop', 'person', { phase: 'final' })
  await d.flush()
  expect(d.offers).toEqual([[cut], [person]])
  d.clear(); await Bun.sleep(0)
  expect(d.offers).toEqual([[cut], [person], [cut]])
  expect(d.texts[2]).toStartWith(INTERRUPTED_LINE)
})

test('WO-204 a Call queued while the menu closes takes precedence; an unknown Call keeps the clear available', async () => {
  const d = await bareRefusal()
  let call: string
  d.env.menu = async () => {
    call ??= d.add('peer', '8')
    return null
  }
  d.clear(); await Bun.sleep(0)
  expect(d.offers).toEqual([])
  expect(d.main.currentGen()?.resume_sent).toBeUndefined()
  d.calls.set('8', 'accepted')
  await d.main.tick()
  expect(d.offers).toEqual([[call!]])
})

function liveMain() {
  const d = daemon(0, 'idle')
  d.wall.walled = false
  return d
}

test('WO-209 (1,4) a bare turn killed before final Stop gets exactly one line on the next idle stream', async () => {
  const d = liveMain(), meta = { chat_id: 'lanes', user: 'lanes', via: 'lanes', no_reply: 'true' }
  const writes: any[] = []
  d.env.offer = async (n, via, pid) => { writes.push({ n, via, pid }); return true }
  await d.hook('UserPromptSubmit', 'bare')
  setSystemTime(T + 120_000)
  d.env.pidAlive = pid => pid !== 123
  await d.main.tick()
  expect(d.journal.lastMain).toMatchObject({ state: 'gone', cut_turn: { at: T + 120_000, why: 'gen_end' } })
  d.env.streamOpen = () => false
  await d.hook('SessionStart', '', { pid: 124 })
  expect(writes).toBeEmpty()
  d.main.streamOpened(124)
  await d.main.tick()
  expect(writes).toEqual([{ via: 'tg', pid: 124, n: { method: 'notifications/claude/channel', params: {
    content: '上一回合 11:02（台北）被打斷（對話結束），接著做沒做完的；沒有要接的就直接結束這一回合。', meta } } }])
  expect(d.main.currentGen()).toMatchObject({ resume_sent: T + 120_000, resumes: 1 })
  expect(d.journal.rows('msg')).toBeEmpty()
  await d.hook('Stop', 'continued', { pid: 124, phase: 'final' })
  await d.hook('SessionEnd', '', { pid: 124 })
  d.env.streamOpen = () => true
  await d.hook('SessionStart', '', { pid: 125 })
  await d.main.tick()
  expect(writes).toHaveLength(1)
  expect(d.main.currentGen()?.cut_turn).toBeUndefined()
  expect(d.main.currentGen()?.resume_sent).toBeUndefined()
  expect(d.main.currentGen()?.resumes).toBe(1)
})

test('WO-209 (2) an item of an ended turn is re-offered and a digest does not turn a bare prompt into an item turn', async () => {
  for (const kind of ['alert', 'digest'] as const) {
    const d = liveMain(), id = d.main.enqueue(kind, { method: 'notifications/claude/channel', params: { content: 'item' } })
    await d.flush()
    await d.hook('UserPromptSubmit', 'work', { dids: [id] })
    expect(d.journal.get('msg', id)?.state).toBe('bound')
    await d.hook('SessionEnd', '')
    await d.hook('SessionStart', '', { pid: 124 })
    await d.main.tick()
    if (kind === 'alert') {
      expect(d.offers).toEqual([[id], [id]])
      expect(d.main.currentGen()?.cut_turn).toBeUndefined()
    } else {
      expect(d.offers).toEqual([[]])
      expect(d.texts[0]).toContain('（對話結束）')
    }
  }
})

test('WO-209 (3) plutus: a bare account refusal survives death, a keeper clear while gone, and a journal reload', async () => {
  const d = await bareRefusal()
  setSystemTime(T + 600_000)
  await d.hook('SessionEnd', '')
  d.clear()
  const journal = new Journal(d.journal.path)
  journal.load()
  const next = createMain({ ...d.env, journal })
  next.initMain()
  await next.mainEvent({ event: 'SessionStart', session_id: sid, pid: 124 })
  await next.tick()
  expect(d.texts).toEqual([resumeText])
  expect(next.currentGen()).toMatchObject({ state: 'idle', cut_turn: { why: 'rate_limit', at: T }, resume_sent: T, resumes: 1 })
  expect(journal.rows('msg')).toBeEmpty()
})

test('WO-209 (6) a bare model error waits for the item backoff and for program delivery; only an own final Stop rearms', async () => {
  const d = liveMain()
  d.env.wallBackoff = (err, probes) => { expect(err).toBe('overloaded'); expect(probes).toBe(0); return 2000 }
  const fail = (p: string) => d.hook('StopFailure', p, { error: 'overloaded' })
  await fail('bare')
  expect(d.main.currentGen()?.cut_turn).toEqual({ at: T, why: 'overloaded', retry_at: T + 2000 })
  setSystemTime(T + 1999)
  await d.main.tick()
  expect(d.texts).toBeEmpty()
  setSystemTime(T + 2000)
  d.wall.walled = true; d.wall.lastWallMs = T - 120_000  // a person could probe; a program still waits
  await d.main.tick()
  expect(d.texts).toBeEmpty()
  d.clear(); await d.flush()
  expect(d.texts).toEqual([resumeText.replace('用量上限', '模型回應錯誤 overloaded')])
  await fail('resume')
  await d.hook('Stop', 'subagent', { phase: 'final', sub: true })
  await d.hook('Stop', 'still-open', { phase: 'check' })
  await d.hook('SessionEnd', '')
  await d.hook('SessionStart', '', { pid: 124 })
  setSystemTime(T + 60_000)
  await d.main.tick()
  expect(d.texts).toHaveLength(1)
  expect(d.main.currentGen()).toMatchObject({ resume_sent: T, resumes: 1 })
  await d.hook('Stop', 'good', { pid: 124, phase: 'final' })
  await d.hook('StopFailure', 'new cut', { pid: 124, error: 'overloaded' })
  setSystemTime(T + 62_000)
  await d.main.tick()
  expect(d.texts).toHaveLength(2)
  expect(d.texts[1]).toContain('11:01（台北）被打斷（模型回應錯誤 overloaded）')
  expect(d.main.currentGen()).toMatchObject({ resume_sent: T + 60_000, resumes: 2 })
})

test.each(['Esc', 'asked', 'clear', 'resume', 'new prompt'])('WO-209 (7) %s does not request continuation', async end => {
  const d = liveMain()
  await d.hook('UserPromptSubmit', 'old')
  if (end === 'Esc') expect(d.main.statusIdle(true, T + 1, T + 1)).toBe(true)
  else if (end === 'asked') {
    d.main.markEnd('asked')
    await d.hook('SessionEnd', '')
    await d.hook('SessionStart', '', { pid: 124 })
  } else if (end === 'new prompt') await d.hook('UserPromptSubmit', 'new')
  else await d.hook('SessionStart', '', { source: end, session_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' })
  await d.main.tick()
  expect(d.main.currentGen()?.cut_turn).toBeUndefined()
  expect(d.texts).toBeEmpty()
})

test.each([2, 0, null, 'unreadable'])('WO-209 (8) a gen end snapshots its own background count (%s)', async count => {
  const d = liveMain(), queried: Array<string | null> = []
  d.env.registry = { mainForAdoption: () => null, backgroundAgents: session => {
    queried.push(session)
    if (typeof count === 'string') throw new Error(count)
    return count
  } }
  await d.hook('UserPromptSubmit', 'bare')
  await d.hook('SessionEnd', '')
  expect(queried).toEqual([sid])
  d.env.registry.backgroundAgents = () => 9  // the new gen's count is irrelevant
  await d.hook('SessionStart', '', { pid: 124 })
  await d.flush()
  expect(d.texts).toEqual([resumeText.replace('用量上限', '對話結束') + (count === 2 ? '當時有 2 個背景工作在跑，重開後已經不在。' : '')])
})

test.each([0, 2])('WO-209 (9) wall-down reports Taipei time and only the %i messages still held', async n => {
  const d = await bareRefusal(), down: string[] = []
  d.env.tellJoey = (text, rule) => { if (rule === 'main-wall-down') down.push(text) }
  for (let i = 0; i < n; i++) d.add('joey', String(i))
  d.main.enqueue('digest', { method: 'notifications/claude/channel', params: {} })
  await d.hook('Stop', 'good', { phase: 'final' })
  expect(down).toHaveLength(1)
  expect(down[0]).toContain('11:00（台北）')
  if (n) expect(down[0]).toContain('保留的 2 則')
  else expect(down[0]).not.toContain('保留')
})

test.each(['refusal', 'final Stop'])('WO-209 counts a successful stream write even if a %s and a gen end arrive before it returns', async edge => {
  const d = await bareRefusal()
  let release!: (ok: boolean) => void
  const writes: string[] = []
  d.env.offer = n => { writes.push((n.params as any).content); return new Promise(resolve => { release = resolve }) }
  d.clear()
  expect(writes).toEqual([resumeText])
  setSystemTime(T + 6000)
  if (edge === 'final Stop') await d.hook('Stop', 'resume', { phase: 'final' })
  await d.hook('StopFailure', 'again', { error: 'server_error' })
  await d.hook('SessionEnd', '')
  release(true)
  await Bun.sleep(0)
  expect(d.journal.lastMain).toMatchObject({ state: 'gone', resumes: 1 })
  await d.hook('SessionStart', '', { pid: 124 })
  const g = d.main.currentGen()!
  if (edge === 'refusal') {
    expect(g).toMatchObject({ cut_turn: { at: T, why: 'rate_limit' }, resume_sent: T })
  } else {
    expect(g.resume_sent).toBeUndefined()
    expect(g.cut_turn).toMatchObject({ at: T + 6000, why: 'server_error' })
    setSystemTime(g.cut_turn.retry_at)
  }
  d.env.offer = async n => { writes.push((n.params as any).content); return true }
  await d.main.tick()
  expect(writes.length).toBe(edge === 'refusal' ? 1 : 2)
  expect(g.resumes).toBe(writes.length)
})

test('WO-209 a reused pid and a journal reload inherit the last registration, including its cleared guard and lifetime total', async () => {
  const d = liveMain()
  await d.hook('UserPromptSubmit', 'bare')
  await d.hook('SessionEnd', '')
  await d.hook('SessionStart', '', { pid: 124 })
  await d.flush()
  await d.hook('Stop', 'finished', { phase: 'final', pid: 124 })
  await d.hook('SessionEnd', '', { pid: 124 })
  await d.hook('SessionStart', '') // pid 123 again, whose earlier turn had a cut
  expect(d.main.currentGen()?.cut_turn).toBeUndefined()
  setSystemTime(T + 60_000)
  await d.hook('UserPromptSubmit', 'another')
  await d.hook('SessionEnd', '')
  const journal = new Journal(d.journal.path)
  journal.load()
  const next = createMain({ ...d.env, journal })
  next.initMain()
  await next.mainEvent({ event: 'SessionStart', pid: 125, session_id: sid })
  await next.tick()
  expect(next.currentGen()).toMatchObject({ cut_turn: { at: T + 60_000 }, resume_sent: T + 60_000, resumes: 2 })
  expect(d.texts).toHaveLength(2)
})

test.each(['SessionEnd', 'StopFailure'])('WO-209 %s log counts the answered item without its riding digest', async event => {
  const d = liveMain(), logs: string[] = []
  d.env.log = (_level, text) => logs.push(text)
  d.env.info = () => ({ text: 'digest', fields: {} })
  const id = d.main.enqueue('alert', { method: 'notifications/claude/channel', params: { content: 'work' } })
  await d.flush()
  await d.hook('UserPromptSubmit', 'both', { dids: [id] })
  expect(d.journal.rows('msg', r => r.state === 'bound')).toHaveLength(2)
  await d.hook('PreToolUse', 'both', { tool_name: 'Read' })
  await d.hook(event, 'both', { error: 'server_error' })
  expect(logs.find(l => l.includes('the model had answered'))).toMatch(/1 (?:item\(s\) )?the model had answered/)
  expect(d.journal.lastMain?.cut_turn).toBeUndefined()
})
