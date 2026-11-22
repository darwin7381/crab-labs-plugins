// Universe 002k (C5): a thread stop drains the events already queued for its lane: one ledger fyi each, no run, no second handoff.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?c5-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-c5-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.sh')
writeFileSync(bin, `#!/bin/sh\nsleep 1.5\necho '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'\n`); chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => L.__setClaudeBin(restore))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
L.__setMeshSend(async () => ({ text: 'sent', msgId: 1, delivered: true }))
const st = L.__lanesState()
const rows = (n: string): any[] => { try { return readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(30) } return f() }
const mev = (id: string, from: string, text: string, extra: object = {}) => ({ id, source: 'mesh', from, verified: true, text, meta: {}, notif: { method: '', params: {} }, ...extra } as any)
const spawns = (lane: string) => rows('lanes.jsonl').filter(r => r.kind === 'spawn' && r.lane === lane).length

test('C5: a stop by the lane\'s own reply_agent (hop limit) drains the events queued behind the running run', async () => {
  const d1 = await L.routeEvent(mev('mesh-s1', 'eve', 'mock-api 的 /v2/notifications 今天會不會維護？', { btcc_msg_id: '1' }))
  expect(d1.target).toBe('lane')
  const th = st.threads[st.lanes[d1.lane!].thread]
  expect((await L.routeEvent(mev('mesh-s2', 'eve', '補充：我 14:00 要用。', { thread: th.id, hop: 2, reply_to_id: 'x' }))).target).toBe('lane')
  expect((await L.routeEvent(mev('mesh-s3', 'eve', '如果會維護，能不能延到 15:00 之後？', { thread: th.id, hop: 3, reply_to_id: 'x' }))).target).toBe('lane')
  th.hops = 6                                                                                  // the next send would be hop 7 > 6
  const tok = { runId: `${d1.lane}.r1`, lane: d1.lane, evId: 'mesh-s1', closers: [], critical: false, trigger: 'peer', cls: 'peer', escalated: false, pushed: false } as any
  expect(await L.callLaneTool(tok, 'reply_agent', { line: 'call', because: 'test (the call line)', to: 'eve', text: '再說一次' })).toContain('hop limit')
  expect(th.stopped).toContain('hop 7')
  const drained = rows('ledger.jsonl').filter(r => r.refs?.drained)
  expect(drained.map(r => r.event).sort()).toEqual(['mesh-s2', 'mesh-s3'])                        // one fyi each
  for (const r of drained) { expect(r).toMatchObject({ kind: 'fyi', thread: th.id }); expect(r.text).toContain('沒有處理') }
  for (const id of ['mesh-s2', 'mesh-s3']) expect(L.__events().get(id)).toMatchObject({ owner: d1.lane, thread: th.id })   // PL1: the main reads them on their M3 records
  expect(drained.find(r => r.event === 'mesh-s3')!.text).toContain('15:00')
  expect(rows('routing.jsonl').filter(r => r.rule === 'thread-stopped-drain').length).toBe(2)
  expect(await until(() => rows('lanes.jsonl').some(r => r.kind === 'exit' && r.lane === d1.lane))).toBe(true)
  await sleep(300)
  expect(spawns(d1.lane!)).toBe(1)                                                              // the running run finished; the queued events got none
  expect(rows('ledger.jsonl').filter(r => r.kind === 'escalation' && ['mesh-s2', 'mesh-s3'].includes(r.event)).length).toBe(0)   // and no handoff for them (the first run, a script that reports nothing, hands over its own event only)
})

test('C5: a stop at routing time (an event over the hop limit) drains the queue too; other threads are untouched', async () => {
  writeFileSync(bin, `#!/bin/sh\nsleep 1.2\necho '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'\n`)
  const a = await L.routeEvent(mev('mesh-t1', 'cain', 'p95 現在多少？', { btcc_msg_id: '2' }))
  const b = await L.routeEvent(mev('mesh-u1', 'eve', '另一件事：備份保留幾天？', { btcc_msg_id: '3' }))
  const tha = st.threads[st.lanes[a.lane!].thread], thb = st.threads[st.lanes[b.lane!].thread]
  await L.routeEvent(mev('mesh-t2', 'cain', '補充', { thread: tha.id, hop: 2, reply_to_id: 'x' }))
  await L.routeEvent(mev('mesh-u2', 'eve', '補充', { thread: thb.id, hop: 2, reply_to_id: 'x' }))
  const stop = await L.routeEvent(mev('mesh-t3', 'cain', '又一則', { thread: tha.id, hop: 99, reply_to_id: 'x' }))
  expect(stop.rule).toBe('thread-gate'); expect(tha.stopped).toBeTruthy()
  const drained = rows('ledger.jsonl').filter(r => r.refs?.drained && r.thread === tha.id)
  expect(drained.map(r => r.event)).toEqual(['mesh-t2'])
  expect(rows('ledger.jsonl').filter(r => r.refs?.drained && r.thread === thb.id).length).toBe(0)         // eve's other thread: not stopped, not drained
  expect(await until(() => spawns(b.lane!) >= 2, 6000)).toBe(true)                                         // its queued follow-up still runs
  expect(spawns(a.lane!)).toBe(1)
})

test('C5: an item that was already restored or retried for a stopped thread is dropped at start, not run', async () => {
  const lane = Object.values(st.lanes).find(l => st.threads[l.thread]?.stopped)!
  const before = spawns(lane.id)
  L.__putQueue({ ev: mev('mesh-late', 'cain', '遲到的一則', { thread: lane.thread }), lane: lane.id, state: 'queued', lease_until: 0, attempts: 0, priority: 5, enqueued: new Date().toISOString() })
  L.sweepQueue()
  await sleep(200)
  expect(spawns(lane.id)).toBe(before)
  expect(rows('ledger.jsonl').some(r => r.event === 'mesh-late' && r.refs?.drained)).toBe(true)
})
