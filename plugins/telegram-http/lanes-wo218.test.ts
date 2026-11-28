import { afterAll, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InEvent } from './lanes.ts'

const dir = mkdtempSync(join(tmpdir(), 'wo218-'))
copyFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), join(dir, 'router.json'))
const inbox = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ offered: true }) })
const saved = Object.fromEntries(['LANES_DIR', 'LANES_INBOX_PORT', 'LANES_MAX', 'LANES_WAKE_DECIDE'].map(k => [k, process.env[k]]))
process.env.LANES_DIR = dir
process.env.LANES_INBOX_PORT = String(inbox.port)
process.env.LANES_MAX = '0' // keep the lane's run queued so the test can inspect it
delete process.env.LANES_WAKE_DECIDE
const L = await import('./lanes.ts?wo218') as typeof import('./lanes.ts')
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  authOk: () => false, registryNames: () => ['codex', 'eve'], streamOpen: () => true, mainStatus: () => ({ state: 'idle', detail: {} }) })
L.__setMainConnected('mcp-main')
afterAll(() => {
  inbox.stop(true)
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const state = L.__lanesState()
const items = (event: string) => L.__main().items(row => row.event === event)
function answer(id: string, fields: Partial<InEvent> = {}): InEvent {
  const meta: Record<string, string> = fields.no_reply === false ? {} : { no_reply: 'true' }
  return { id, from: 'eve', source: 'mesh', verified: true, text: id, no_reply: true, meta,
    notif: { method: 'notifications/claude/channel', params: { content: id, meta } }, ...fields }
}
function laneCall(n: number, status: 'idle' | 'closed') {
  const lane = `adam.reflex.${n}`, thread = `adam#t-abc${n}`, at = new Date().toISOString()
  state.lanes[lane] = { id: lane, n, kind: 'reflex', session_id: `s${n}`, status, thread, created: at, last: at,
    transcript: join(dir, `lane-${n}.jsonl`), runs: 1, tokens_in: 0, tokens_out: 0 }
  state.threads[thread] = { id: thread, lane, peer: 'eve', hops: 1, tokens: 0, created: at, last: at }
  const reply_to_id = String(21800 + n)
  state.outbound[reply_to_id] = { owner: lane, thread }
  return { lane, thread, reply_to_id }
}

test('Codex’s first answer supplies its thread and wakes the idle main with nothing owed at Stop', async () => {
  const pid = process.pid
  for (const [id, rule] of [['fleet', 'mesh-no-reply'], ['wo164', 'wake:peer-no-reply']] as const) {
    process.env.LANES_WAKE_DECIDE = id === 'wo164' ? 'adam' : ''
    try {
      await L.__mainEvent({ event: 'Stop', pid })
      const ev = answer(id, { from: 'codex', thread: id === 'fleet' ? 'codex#t-de01' : 'codex#t-de02', reply_to_id: '21800' })
      state.outbound['21800'] = { owner: 'main', thread: null }
      const threadsBefore = Object.keys(state.threads)
      const d = await L.routeEvent(ev)
      expect(d).toMatchObject({ rule, target: 'main', thread: ev.thread })
      expect(d).not.toHaveProperty('batch')
      expect(Object.keys(state.threads)).toEqual(threadsBefore)
      expect(state.outbound['21800'].thread).toBeNull()
      expect(L.__events().get(id)).toMatchObject({ owner: 'router', answers: 'main', thread: ev.thread, obligations: [{ kind: 'main', state: 'open' }] })
      expect(L.__events().mainObs(id)).toEqual([])
      for (let i = 0; i < 100 && items(id)[0]?.state !== 'offered'; i++) await Bun.sleep(10)
      expect(items(id)).toMatchObject([{ state: 'offered' }])
      await L.__mainEvent({ event: 'UserPromptSubmit', pid, prompt_id: id, dids: [items(id)[0].id] })
      expect(items(id)[0].state).toBe('bound')
      expect((await L.__mainEvent({ event: 'Stop', pid, prompt_id: id })).block).toBeUndefined()
      await L.__mainEvent({ event: 'Stop', pid, prompt_id: id, phase: 'final' })
      expect(L.__events().get(id)?.obligations).toMatchObject([{ kind: 'main', state: 'met' }])
    } finally { delete process.env.LANES_WAKE_DECIDE }
  }
})

test('a peer answer to an open lane’s call is queued for that lane with nothing owed', async () => {
  const { lane, thread, reply_to_id } = laneCall(1, 'idle')
  const ev = answer('open', { reply_to_id })
  expect(await L.routeEvent(ev)).toMatchObject({ rule: 'mesh-no-reply', target: 'lane', lane })
  expect(L.__journal().rows('run', r => r.event === ev.id)).toMatchObject([{ state: 'queued', lane, ev: { no_reply: true } }])
  expect(L.__events().get(ev.id)).toMatchObject({ answers: lane, thread, obligations: [] })
  expect(items(ev.id)).toHaveLength(0)
})

test('a peer answer to a closed lane’s call goes to the main', async () => {
  const { reply_to_id } = laneCall(2, 'closed')
  const ev = answer('closed', { reply_to_id })
  expect(await L.routeEvent(ev)).toMatchObject({ target: 'main', note: 'lane missing/closed → main' })
  expect(items(ev.id)).toHaveLength(1)
  expect(L.__events().mainObs(ev.id)).toEqual([])
})

test('a no_reply notice with no thread or reply_to_id stays in the ledger', async () => {
  const ev = answer('announcement')
  expect(await L.routeEvent(ev)).toMatchObject({ rule: 'mesh-no-reply', target: 'ledger' })
  expect(items(ev.id)).toHaveLength(0)
})

test('an answer on a stopped thread gets the same quiet decision as thread_owner', async () => {
  const { lane, thread, reply_to_id } = laneCall(3, 'idle')
  state.threads[thread].stopped = 'hop limit'
  const control = await L.routeEvent(answer('ordinary', { no_reply: false, reply_to_id }))
  expect(control).toMatchObject({ rule: 'thread-gate', target: 'ledger', lane, thread })
  const ev = answer('stopped', { reply_to_id })
  expect(await L.routeEvent(ev)).toEqual(control)
  expect(L.__events().get(ev.id)).toMatchObject({ stop: { why: 'already-stopped' }, obligations: [] })
  expect(items(ev.id)).toHaveLength(0)
})

test('a silent notice quoting the main’s call stays in the ledger and gives the main zero items', async () => {
  state.outbound['21804'] = { owner: 'main', thread: null }
  const ev = answer('interim', { reply_to_id: '21804', urgency: 'silent' })
  expect(await L.routeEvent(ev)).toMatchObject({ rule: 'mesh-no-reply', target: 'ledger' })
  expect(L.__events().get(ev.id)).toMatchObject({ owner: 'router', answers: 'main', obligations: [] })
  expect(items(ev.id)).toHaveLength(0)
})
