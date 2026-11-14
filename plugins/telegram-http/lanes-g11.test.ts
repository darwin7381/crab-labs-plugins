// Universe 002k (G11): a run killed together with the daemon gets its exit row at boot, is counted, and its id is not reused. No network, no model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?g11-test') as typeof import('./lanes.ts')
const { LEDGER_KINDS, queryLedger } = await import('./lanes-digest.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-g11-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.sh'); writeFileSync(bin, `#!/bin/sh\nsleep 0.2\necho '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'\n`); chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => L.__setClaudeBin(restore))

// the daemon was killed while four runs were in flight / waiting:
//   adam.worker.71.r1   running, left a transcript            -> exit row, counted, the retry is r2
//   adam.reflex.72.r1   running, died before claude wrote one -> exit row, NOT counted (nothing to resume), the retry starts fresh
//   adam.reflex.73.r1   had ended earlier (exit row exists) and waits for its retry backoff -> not touched, not counted twice
//   adam.reflex.74      queued, never started                  -> untouched
mkdirSync(join(dir, 'queue'), { recursive: true })
const mkLane = (kind: string, n: number, runs: number, withTranscript: boolean) => {
  const id = `adam.${kind}.${n}`, tr = join(dir, `s${n}.jsonl`)
  if (withTranscript) writeFileSync(tr, '{"type":"user"}\n')
  return { id, kind, n, session_id: `s${n}`, thread: `adam#t-g11-${n}`, status: 'running', created: '', last: '', transcript: tr, runs, tokens_in: 0, tokens_out: 0 }
}
const lanes = [mkLane('worker', 71, 0, true), mkLane('reflex', 72, 0, false), mkLane('reflex', 73, 1, true), mkLane('reflex', 74, 0, false)]
writeFileSync(join(dir, 'state.json'), JSON.stringify({ counters: {}, lanes: Object.fromEntries(lanes.map(l => [l.id, l])),
  threads: Object.fromEntries(lanes.map(l => [l.thread, { id: l.thread, lane: l.id, peer: null, hops: 0, tokens: 0, created: '', last: '' }])) }))
const item = (l: any, state: string, run: string | undefined, evId: string) => ({ ev: { id: evId, source: 'mesh', from: 'scheduler', text: `[scheduled] ${evId}`, meta: {}, notif: { method: '', params: {} } },
  lane: l.id, state, lease_until: Date.now() + 120_000, attempts: state === 'queued' ? 0 : 1, priority: 5, enqueued: new Date().toISOString(), pid: 999999, ...(run ? { run } : {}) })
for (const [l, st, run, ev] of [[lanes[0], 'leased', 'adam.worker.71.r1', 'mesh-g71'], [lanes[1], 'leased', 'adam.reflex.72.r1', 'mesh-g72'], [lanes[2], 'leased', 'adam.reflex.73.r1', 'mesh-g73'], [lanes[3], 'queued', undefined, 'mesh-g74']] as const)
  writeFileSync(join(dir, 'queue', `${ev}.json`), JSON.stringify(item(l, st, run, ev)))
writeFileSync(join(dir, 'lanes.jsonl'), [
  { ts: '2026-11-13T02:00:00.000Z', lane: 'adam.worker.71', kind: 'spawn', run: 'adam.worker.71.r1', event: 'mesh-g71', attempt: 1 },
  { ts: '2026-11-13T02:00:01.000Z', lane: 'adam.reflex.72', kind: 'spawn', run: 'adam.reflex.72.r1', event: 'mesh-g72', attempt: 1 },
  { ts: '2026-11-13T02:00:02.000Z', lane: 'adam.reflex.73', kind: 'spawn', run: 'adam.reflex.73.r1', event: 'mesh-g73', attempt: 1 },
  { ts: '2026-11-13T02:00:09.000Z', lane: 'adam.reflex.73', kind: 'exit', run: 'adam.reflex.73.r1', event: 'mesh-g73', exit_code: 1, signal: null },
].map(r => JSON.stringify(r)).join('\n') + '\n')

L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const st = L.__lanesState()
const rows = (n: string): any[] => { try { return readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const exits = (run: string) => rows('lanes.jsonl').filter(r => r.kind === 'exit' && r.run === run)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(30) } return f() }

test('G11: a run that was running when the daemon stopped gets an exit row (signal daemon-restart) and is counted', () => {
  const e = exits('adam.worker.71.r1')
  expect(e.length).toBe(1)
  expect(e[0]).toMatchObject({ lane: 'adam.worker.71', kind: 'exit', event: 'mesh-g71', exit_code: null, signal: 'daemon-restart', restored: true, counted: true, session_id: 's71' })
  expect(st.lanes['adam.worker.71'].runs).toBe(1)
  const persisted = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  expect(persisted.lanes['adam.worker.71'].runs).toBe(1)                                    // saved, not only in memory
})

test('G11: the ledger line "crashed: daemon restarted" (lane_lifecycle) and its place in the ledger kinds and the activity list', () => {
  expect(LEDGER_KINDS).toContain('lane_lifecycle')
  const l = rows('ledger.jsonl').filter(r => r.kind === 'lane_lifecycle')
  expect(l.map(r => r.event).sort()).toEqual(['mesh-g71', 'mesh-g72'])                       // the two runs that were cut; the third had ended before
  expect(l[0]).toMatchObject({ notify_main: false, lane: expect.stringContaining('adam.'), refs: { signal: 'daemon-restart' } })
  expect(l.find(r => r.event === 'mesh-g71')!.text).toContain('crashed: daemon restarted'); expect(l.find(r => r.event === 'mesh-g71')!.text).toContain('adam.worker.71.r1')
  const q = queryLedger(readFileSync(join(dir, 'ledger.jsonl'), 'utf8'), {}, Date.now())
  expect(q).toContain('crashed: daemon restarted')                                           // the activity list shows it, not "（沒有文字）"
  expect(queryLedger(readFileSync(join(dir, 'ledger.jsonl'), 'utf8'), { kind: 'lane_lifecycle' }, Date.now())).toContain('adam.worker.71.r1')
})

test('G11: a run that left no conversation is closed but not counted (the retry starts a fresh session, it does not --resume nothing)', () => {
  const e = exits('adam.reflex.72.r1')
  expect(e.length).toBe(1); expect(e[0]).toMatchObject({ signal: 'daemon-restart', counted: false })
  expect(st.lanes['adam.reflex.72'].runs).toBe(0)
})

test('G11: a run that had already ended (its exit row exists) is not closed twice or counted again; a queued item is untouched', () => {
  expect(exits('adam.reflex.73.r1').length).toBe(1); expect(exits('adam.reflex.73.r1')[0].exit_code).toBe(1)
  expect(st.lanes['adam.reflex.73'].runs).toBe(1)
  expect(exits('adam.reflex.74.r1').length).toBe(0); expect(st.lanes['adam.reflex.74'].runs).toBe(0)
})

test('G11: the next spawn of the cut worker is r2, not r1 again; the dead attempt keeps its own exit row', async () => {
  L.sweepQueue()
  expect(await until(() => rows('lanes.jsonl').some(r => r.kind === 'spawn' && r.event === 'mesh-g71' && r.attempt === 2))).toBe(true)
  const sp = rows('lanes.jsonl').filter(r => r.kind === 'spawn' && r.event === 'mesh-g71')
  expect(sp.map(r => r.run)).toEqual(['adam.worker.71.r1', 'adam.worker.71.r2'])             // two spawns, two different run ids
  expect(sp[1]).toMatchObject({ attempt: 2, resume: true })
  expect(await until(() => exits('adam.worker.71.r2').length === 1)).toBe(true)
  expect(exits('adam.worker.71.r1').length).toBe(1)                                          // the first is still the one daemon-restart row
  expect(st.lanes['adam.worker.71'].runs).toBe(2)
})

test('G11: a second restore with nothing running writes nothing more', async () => {
  await sleep(800)                                                                           // the retries of the first restore have ended
  const before = rows('lanes.jsonl').length, led = rows('ledger.jsonl').length
  const L2 = await import('./lanes.ts?g11-test-again') as typeof import('./lanes.ts')
  L2.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
  expect(rows('lanes.jsonl').filter(r => r.signal === 'daemon-restart').length).toBe(2)       // still the two from the first restore
  expect(rows('ledger.jsonl').filter(r => r.kind === 'lane_lifecycle').length).toBe(2)
  expect(rows('lanes.jsonl').length).toBeGreaterThanOrEqual(before); expect(rows('ledger.jsonl').length).toBeGreaterThanOrEqual(led)
})
