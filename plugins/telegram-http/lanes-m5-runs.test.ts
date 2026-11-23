// M5, the run record: each lane run is queued → leased → running → exited(reason), reason ∈ normal | cap_turns | cap_usd | budget | wall:<kind> |
// died | timeout, read from the run's result JSON and exit code (exitReason), never from error text. Busy is "has a queued, leased or running record".
// The journal is the queue: at boot a run left running died with the daemon. The failures of class E and the lane half of L (002g run limit, 002j wall,
// 002k G11, 002l S0-4, 002m G06, 002n E02) are played here with scripts standing in for `claude -p`. No model, no network.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?m5-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-m5-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const script = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p }
const OK = script('ok.sh', `sleep 0.05\necho '{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","result":"done"}'\nexit 0`)
const WALLED = script('walled.sh', `sleep 0.05\necho '{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error","api_error_status":429,"result":"API Error: Request rejected (429)"}'\nexit 1`)
const DIE = script('die.sh', 'exit 3')
const HANG = script('hang.sh', `exec python3 -c 'import time; time.sleep(30)' "$@"`)   // keeps its arguments (the run's mcp config) in its command line
const restore = L.__setClaudeBin(OK)
L.__setRetryBackoff(20); L.__setWallProbe(300)
const sent: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async (_c: string, text: string) => { sent.push(text); return 500 + sent.length }, joeyChatId: () => '1' } as any)
afterAll(() => { L.__setClaudeBin(restore); L.__setRetryBackoff(5000); L.__setWallProbe(300_000); L.__setLaneMaxRun(900_000); delete process.env.LANES_FLOOD_CONTROL })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const rows = (n: string): any[] => { try { return readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const runLines = (ev: string) => rows('lanes/state.jsonl').filter(l => l.rec === 'run' && l.event === ev)
const exits = (ev: string) => runLines(ev).filter(l => l.state === 'exited')
let n = 0
const sched = (what: string) => ({ id: `mesh-m5-${++n}`, source: 'mesh', from: 'scheduler', verified: true, text: `[scheduled][${what}][run:${600 + n}][P3][routine] ${what}`, meta: {},
  notif: { method: 'notifications/claude/channel', params: { content: what, meta: {} } } } as any)

test('exitReason: the result record and the exit code say how a run ended; never the error text', () => {
  const R = (result: any, code: number | null = 0, o: object = {}) => L.exitReason({ result, code, signal: null, ...o })
  expect(R({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed' })).toBe('normal')
  expect(R({ subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns' }, 1)).toBe('cap_turns')
  expect(R({ subtype: 'error_max_budget_usd', is_error: true }, 1)).toBe('cap_usd')
  expect(R({ is_error: true, terminal_reason: 'api_error', api_error_status: 429 }, 1)).toBe('wall:rate_limit')
  expect(R({ is_error: true, terminal_reason: 'api_error', api_error_status: 529 }, 1)).toBe('wall:server_error')
  expect(R({ is_error: true, terminal_reason: 'api_error', api_error_status: 500 }, 1)).toBe('wall:server_error')
  expect(R({ is_error: true, terminal_reason: 'api_error', api_error_status: 401 }, 1)).toBe('wall:authentication_failed')
  expect(R({ is_error: true, terminal_reason: 'api_error', api_error_status: null }, 1)).toBe('wall:api_error')      // not logged in (probe b0)
  expect(R({ is_error: true, result: "You've hit your weekly limit" }, 1)).toBe('died')                               // the words alone say nothing
  expect(R(null, 3)).toBe('died'); expect(L.exitReason({ result: null, code: null, signal: 'SIGKILL' })).toBe('died')
  expect(R(null, null, { timedOut: true })).toBe('timeout'); expect(R(null, null, { budget: true })).toBe('budget')
})

test('the lifecycle: queued → leased → running → exited(normal), each a journal line; busy is "has such a record"', async () => {
  L.__setClaudeBin(OK)
  const ev = sched('backup-check')
  const d = await L.routeEvent(ev)
  expect(L.laneBusy(d.lane!)).toBe(true)
  expect(await until(() => exits(ev.id).length === 1)).toBe(true)
  const st = runLines(ev.id).map(l => l.state)
  expect(st).toEqual(['queued', 'leased', 'running', 'exited'])
  expect(exits(ev.id)[0]).toMatchObject({ reason: 'normal', exit_code: 0, attempt: 1 })
  expect(runLines(ev.id).find(l => l.state === 'running').pid).toBeGreaterThan(0)
  expect(L.laneBusy(d.lane!)).toBe(false)
  expect(rows('lanes.jsonl').find(r => r.kind === 'exit' && r.event === ev.id).reason).toBe('normal')
})

test('002g run limit: a run that hangs is stopped at the limit (timeout), run again while its event still owes something', async () => {
  L.__setClaudeBin(HANG); L.__setLaneMaxRun(150)
  const ev = sched('slow-check')
  await L.routeEvent(ev)
  expect(await until(() => exits(ev.id).length >= 1)).toBe(true)
  expect(exits(ev.id)[0].reason).toBe('timeout')
  L.__setClaudeBin(OK); L.__setLaneMaxRun(900_000)
  expect(await until(() => exits(ev.id).some(e => e.reason === 'normal'))).toBe(true)
  expect(runLines(ev.id).filter(l => l.state === 'queued').map(l => l.attempt)).toEqual([1, 2])
})

test('002f / 002m G06: a run that dies is run again after its backoff; the third death hands the event to the main with where each run died', async () => {
  L.__setClaudeBin(DIE)
  const ev = sched('dying-check')
  await L.routeEvent(ev)
  expect(await until(() => exits(ev.id).length === 3)).toBe(true)
  expect(exits(ev.id).map(e => e.reason)).toEqual(['died', 'died', 'died'])
  const h = await until(() => L.__main().items(r => r.kind === 'handoff' && r.event === ev.id).length === 1)
  expect(h).toBe(true)
  const text = String(L.__main().items(r => r.kind === 'handoff' && r.event === ev.id)[0].notif.params.content)
  expect(text).toContain('連續 3 次沒處理完'); expect(text).toContain('第 1 次'); expect(text).toContain('行程以 exit 3 結束')
  L.__setClaudeBin(OK)
})

test('002j, 002l S0-4: a walled run is not an attempt: one wall record, one notice, nothing else dispatched, probes back off; the first run that gets through lifts it and the queue runs', async () => {
  L.__setClaudeBin(WALLED)
  const k = sent.length
  const a = sched('w-1'), b = sched('w-2')
  await L.routeEvent(a); await L.routeEvent(b)
  expect(await until(() => L.wallActive())).toBe(true)
  expect(await until(() => exits(a.id).length >= 1)).toBe(true)   // the wall record is set before the run's exit line is on disk (flaked 4 of 6 on a loaded box, Epeius 2026-11-23)
  expect(exits(a.id)[0].reason).toBe('wall:rate_limit')
  expect(runLines(a.id).filter(l => l.state === 'queued').map(l => l.attempt)).toEqual([1, 1])     // queued again as it was: not an attempt
  await sleep(100)
  expect(sent.slice(k).filter(t => t.includes('額度')).length).toBe(1)
  expect(L.wallBackoffMs('rate_limit', 3, 300)).toBe(2400); expect(L.wallBackoffMs('server_error', 3, 300)).toBe(300)   // a usage or login wall backs off; overload does not
  const crit = { id: `mesh-m5-crit`, source: 'mesh', from: 'alert-dispatcher', verified: true, text: '[P1][critical] mock-backup 全掛', meta: {}, notif: { method: '', params: {} } } as any
  await L.routeEvent(crit)
  L.dueTick(Date.now() + 1)
  expect(await until(() => sent.some(t => t.includes('沒有車道能查證')))).toBe(true)            // a critical alert behind the wall is due at once
  L.__setClaudeBin(OK)
  expect(await until(() => !L.wallActive(), 6000)).toBe(true)
  expect(await until(() => [a, b].every(e => exits(e.id).some(x => x.reason === 'normal')), 6000)).toBe(true)
  expect(sent.slice(k).filter(t => t.includes('模型恢復了')).length).toBe(1)
  expect(L.__main().items(r => r.kind === 'handoff' && (r.event === a.id || r.event === b.id) && String(r.notif.params.content).includes('次沒處理完')).length).toBe(0)   // nothing written off as failed
}, 20_000)

test('002k G11: at boot a run left running died with the daemon: exited(died, daemon-restart), its exit row, its ledger line, counted only when it left a conversation; the event runs again as the next run (r2); a second boot writes nothing more', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'lanes-m5-boot-'))
  copyFileSync(ROUTER, join(d2, 'router.json'))
  const tx = join(d2, 'worker-1.jsonl'); writeFileSync(tx, '{}\n')
  writeFileSync(join(d2, 'state.json'), JSON.stringify({ counters: { worker: 1 }, lanes: { 'adam.worker.1': { id: 'adam.worker.1', kind: 'worker', n: 1, session_id: 's-w1', thread: 'adam#t-w1', status: 'running',
    created: '', last: '', transcript: tx, runs: 0, tokens_in: 0, tokens_out: 0 } }, threads: { 'adam#t-w1': { id: 'adam#t-w1', lane: 'adam.worker.1', peer: null, hops: 0, tokens: 0, created: '', last: '' } } }))
  mkdirSync(join(d2, 'lanes'), { recursive: true })
  const ev = { id: 'ev-g11', source: 'mesh', from: 'main', text: '寫月報', meta: {}, notif: { method: '', params: {} } }
  const t = new Date().toISOString()
  writeFileSync(join(d2, 'lanes', 'state.jsonl'), [
    { ts: t, rec: 'run', id: 'ev-g11#1', state: 'queued', event: 'ev-g11', lane: 'adam.worker.1', attempt: 1, ev, priority: 3, enqueued: t },
    { ts: t, rec: 'run', id: 'ev-g11#1', state: 'leased', event: 'ev-g11', lane: 'adam.worker.1', attempt: 1, run: 'adam.worker.1.r1' },
    { ts: t, rec: 'run', id: 'ev-g11#1', state: 'running', event: 'ev-g11', lane: 'adam.worker.1', attempt: 1, run: 'adam.worker.1.r1', pid: 2_000_000_000 },
  ].map(x => JSON.stringify(x)).join('\n') + '\n')
  process.env.LANES_DIR = d2
  const B = await import('./lanes.ts?m5-boot') as typeof import('./lanes.ts')
  B.__setClaudeBin(HANG)
  B.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: d2, transcriptDir: d2, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => [] } as any)
  process.env.LANES_DIR = dir
  const j = () => readFileSync(join(d2, 'lanes', 'state.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.rec === 'run' && l.event === 'ev-g11')
  expect(j().find(l => l.state === 'exited')).toMatchObject({ id: 'ev-g11#1', reason: 'died', signal: 'daemon-restart' })
  const exitRow = readFileSync(join(d2, 'lanes.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(r => r.kind === 'exit')
  expect(exitRow).toMatchObject({ run: 'adam.worker.1.r1', signal: 'daemon-restart', restored: true, counted: true })
  expect(readFileSync(join(d2, 'ledger.jsonl'), 'utf8')).toContain('crashed: daemon restarted')
  expect(B.__lanesState().lanes['adam.worker.1'].runs).toBe(1)                                        // it left a conversation: counted
  expect(await until(() => j().some(l => l.state === 'leased' && l.run === 'adam.worker.1.r2'))).toBe(true)   // the next run is r2, not r1 again
  const before = j().length
  const B2 = await import('./lanes.ts?m5-boot2') as typeof import('./lanes.ts')
  B.__setClaudeBin(OK)
  process.env.LANES_DIR = d2
  B2.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: d2, transcriptDir: d2, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => [] } as any)
  process.env.LANES_DIR = dir
  expect(j().filter(l => l.state === 'exited' && l.signal === 'daemon-restart').length).toBe(2)       // the r2 run that B left running, once; r1 not again
  expect(j().length).toBeGreaterThan(before)
  await sleep(300)
  Bun.spawnSync(['pkill', '-f', d2])                                                                  // nothing of this test is left running
})

test('002q T6-R: at boot a run the daemon restart cut is run again only while its event still owes something (the journal fold): a CLOSED event (line and receipt met) gets no new run', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'lanes-m5-t6-'))
  copyFileSync(ROUTER, join(d2, 'router.json'))
  const lanes = Object.fromEntries([1, 2].map(i => [`adam.reflex.${i}`, { id: `adam.reflex.${i}`, kind: 'reflex', n: i, session_id: `s-r${i}`, thread: `adam#t-r${i}`, status: 'running',
    created: '', last: '', transcript: join(d2, `r${i}.jsonl`), runs: 1, tokens_in: 0, tokens_out: 0 }]))
  const threads = Object.fromEntries([1, 2].map(i => [`adam#t-r${i}`, { id: `adam#t-r${i}`, lane: `adam.reflex.${i}`, peer: null, hops: 0, tokens: 0, created: '', last: '' }]))
  writeFileSync(join(d2, 'state.json'), JSON.stringify({ counters: { reflex: 2 }, lanes, threads }))
  mkdirSync(join(d2, 'lanes'), { recursive: true })
  const t = new Date().toISOString()
  const ob = (kind: string, state: string, x: object = {}) => ({ id: `${kind}-x`, kind, level: kind === 'joey' ? 'line' : 'run', state, ...x })
  const lines: any[] = []
  for (const [id, lane, obs, st] of [['mesh-t6-closed', 'adam.reflex.1', [ob('joey', 'met', { by: 'notify_joey', ref: '1003' }), ob('receipt', 'met', { run_id: '801' })], 'closed'],
                                     ['mesh-t6-open', 'adam.reflex.2', [ob('joey', 'open'), ob('receipt', 'open', { run_id: '802' })], 'open']] as const) {
    const ev = { id, source: 'mesh', from: 'scheduler', text: '[scheduled][backup][run:0] 備份', meta: {}, notif: { method: '', params: {} } }
    lines.push({ ts: t, rec: 'event', id, state: st, class: 'scheduled', owner: lane, lane, obligations: obs },
      { ts: t, rec: 'run', id: `${id}#2`, state: 'queued', event: id, lane, attempt: 2, ev, priority: 5, enqueued: t },
      { ts: t, rec: 'run', id: `${id}#2`, state: 'running', event: id, lane, attempt: 2, run: `${lane}.r2`, pid: 2_000_000_001 })
  }
  writeFileSync(join(d2, 'lanes', 'state.jsonl'), lines.map(x => JSON.stringify(x)).join('\n') + '\n')
  process.env.LANES_DIR = d2
  const B = await import('./lanes.ts?m5-t6') as typeof import('./lanes.ts')
  B.__setClaudeBin(HANG)
  B.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: d2, transcriptDir: d2, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => [] } as any)
  process.env.LANES_DIR = dir
  const j = () => readFileSync(join(d2, 'lanes', 'state.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const runs = (ev: string) => j().filter(l => l.rec === 'run' && l.event === ev)
  for (const ev of ['mesh-t6-closed', 'mesh-t6-open']) expect(runs(ev).find(l => l.state === 'exited')).toMatchObject({ reason: 'died', signal: 'daemon-restart' })
  expect(await until(() => runs('mesh-t6-open').some(l => l.state === 'queued' && l.attempt === 3))).toBe(true)   // it still owes its line and its receipt: run again
  await sleep(100)
  expect(runs('mesh-t6-closed').filter(l => l.state === 'queued').length).toBe(1)                           // closed: no attempt 3 (002p queued one 0.6 s after the restart)
  expect(j().find(l => l.rec === 'wake' && l.id === 'mesh-t6-closed')).toMatchObject({ state: 'no_wake' })
  expect(j().find(l => l.rec === 'wake' && l.id === 'mesh-t6-closed').reason).toContain('owes nothing more')
  expect(await until(() => runs('mesh-t6-open').some(l => l.state === 'running' && l.attempt === 3))).toBe(true)
  B.__setClaudeBin(OK)
  for (let i = 0; i < 50 && Bun.spawnSync(['pgrep', '-f', d2]).exitCode === 0; i++) { Bun.spawnSync(['pkill', '-f', d2]); await sleep(100) }   // nothing of this test is left running
  expect(Bun.spawnSync(['pgrep', '-f', d2]).exitCode).toBe(1)
})

test('002n E02: a run cut at --max-turns is classified cap_turns from its result record; a cap is a stop, never a retry; M3 decides what follows (here the receipt it still owes goes to the main)', async () => {
  const CAP = script('cap.sh', `echo '{"type":"result","subtype":"error_max_turns","is_error":true,"terminal_reason":"max_turns"}'\nexit 1`)
  L.__setClaudeBin(CAP)
  const ev = { id: 'mesh-m5-cap', source: 'mesh', from: 'scheduler', verified: true, text: '[scheduled][heartbeat][high-frequency][run:699][P3][routine] heartbeat', meta: {}, notif: { method: '', params: {} } } as any
  await L.routeEvent(ev)
  expect(await until(() => exits(ev.id).length === 1)).toBe(true)
  expect(exits(ev.id)[0].reason).toBe('cap_turns')
  expect(rows('ledger.jsonl').find(r => r.kind === 'stop' && r.event === ev.id).refs.capped).toBe('turns')
  await sleep(50)
  expect(runLines(ev.id).filter(l => l.state === 'queued').length).toBe(1)                            // a cap is a stop, never a retry
  expect(L.__main().items(r => r.kind === 'handoff' && r.event === ev.id).length).toBe(1)
  L.__setClaudeBin(OK)
})
