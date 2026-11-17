// Universe 002k (H11): the thread budget is checked after every assistant turn of a run (not only before it starts), and each lane kind has a --max-turns and
// a --max-budget-usd backstop. The lane process is a script that prints stream-json. No network, no model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_FLOOD_CONTROL = '0'                                      // this file sends many new threads from one peer: the flood gate (H14) is not what it tests
process.env.LANES_THREAD_BUDGET = '250000'                                   // read once at import: set it for this instance only
const L = await import('./lanes.ts?h11-test') as typeof import('./lanes.ts')
delete process.env.LANES_THREAD_BUDGET
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-h11-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
writeFileSync(join(dir, 'mode'), 'loop')
const bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import sys, json, time
argv = sys.argv[1:]
open('${dir}/argv.jsonl', 'a').write(json.dumps(argv) + '\\n')
mode = open('${dir}/mode').read().strip()
def msg(i, text, inp=90000, tool=False, reads=0):
    c = [{'type': 'text', 'text': text}]
    if tool: c.append({'type': 'tool_use', 'id': 't%d' % i, 'name': 'Bash', 'input': {'command': 'curl-free read page %d' % i}})
    # 002l (D7): the budget counts fresh tokens (input + cache writes + output); cache reads are given separately
    print(json.dumps({'type': 'assistant', 'message': {'id': 'm%d' % i, 'content': c, 'usage': {'input_tokens': 10, 'cache_read_input_tokens': reads, 'cache_creation_input_tokens': inp, 'output_tokens': 5}}}), flush=True)
if mode == 'reads':
    for i in range(1, 6):
        msg(i, 'fork call %d' % i, inp=1000, reads=620000, tool=True)
    print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'done'}), flush=True)
elif mode == 'loop':
    for i in range(1, 40):
        msg(i, '第 %d 頁讀完了，繼續下一頁' % i, tool=True)
        time.sleep(0.15)
    time.sleep(20)
elif mode == 'turns':
    msg(1, '查到一半'); print(json.dumps({'type': 'result', 'subtype': 'error_max_turns', 'is_error': True, 'num_turns': 12}), flush=True); sys.exit(1)
elif mode == 'usd':
    msg(1, '花很多'); print(json.dumps({'type': 'result', 'subtype': 'error_max_budget_usd', 'is_error': True}), flush=True); sys.exit(1)
else:
    msg(1, '好', inp=1000); print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => { L.__setClaudeBin(restore); delete process.env.LANES_FLOOD_CONTROL })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const st = L.__lanesState()
const rows = (n: string): any[] => { try { return readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const setMode = (m: string) => writeFileSync(join(dir, 'mode'), m)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(25) } return f() }
const ev = (id: string, extra: object = {}) => ({ id, source: 'mesh', from: 'eve', verified: true, text: '請把 docs 20 頁全部讀完再回報', meta: {}, notif: { method: '', params: {} }, ...extra } as any)
const spawns = (laneId: string) => rows('lanes.jsonl').filter(r => r.kind === 'spawn' && r.lane === laneId)
const stops = (event: string) => rows('ledger.jsonl').filter(r => r.kind === 'stop' && r.event === event)

test('H11: a run that reaches the thread budget in the run is stopped (SIGTERM), with a wake stop row that says 預算 and carries the partial result', async () => {
  setMode('loop')
  const t0 = Date.now()
  const d = await L.routeEvent(ev('mesh-h1'))
  expect(d.target).toBe('lane')
  expect(await until(() => stops('mesh-h1').length === 1)).toBe(true)
  expect(Date.now() - t0).toBeLessThan(6000)                                            // seconds, not the 20 s of the script
  const s = stops('mesh-h1')[0]
  expect(s).toMatchObject({ kind: 'stop', notify_main: true, lane: d.lane, refs: { capped: 'budget', in_run: true, budget: 250000 } })
  expect(s.text).toContain('預算'); expect(s.text).toContain('250000'); expect(s.text).toContain('這一趟已經中止')
  expect(s.text).toContain('第 3 頁讀完了，繼續下一頁')                                   // the last text of the run when it was stopped (3 x 90,015 >= 250,000)
  expect(await until(() => L.__main().items(r => r.kind === 'handoff' && r.event === 'mesh-h1').length === 1)).toBe(true)   // what the event still owes goes to the main (M3 exit rule)
  const exit = rows('lanes.jsonl').find(r => r.kind === 'exit' && r.lane === d.lane)!
  expect(exit.signal).toBe('SIGTERM'); expect(exit.tokens_in).toBeGreaterThanOrEqual(250000); expect(exit.tokens_in).toBeLessThan(450000)   // stopped within a turn or two of the budget, not at 20 pages
  const th = st.threads[st.lanes[d.lane!].thread]
  expect(th.fresh).toBe(exit.tokens_fresh)                                                // the run's fresh tokens are in the thread (002l D7)
  await sleep(300)
  expect(spawns(d.lane!).length).toBe(1)                                                  // a stop is not a failure: no retry
  expect(rows('queue.jsonl').length).toBe(0)
})

test('H11: the tokens of the thread\'s earlier runs count: a thread already at 200k stops after the first turn of its next run; the pre-run check still holds the one after', async () => {
  const d = await L.routeEvent(ev('mesh-h2'))
  const lane = st.lanes[d.lane!]
  await until(() => stops('mesh-h2').length === 1)
  const th = st.threads[lane.thread]
  th.fresh = 0                                                                            // a thread that has spent 200k in earlier runs
  const th2 = await L.routeEvent(ev('mesh-h3', { thread: lane.thread, hop: 2, reply_to_id: 'x', from: 'eve' }))
  expect(th2.target).toBe('lane')
  expect(await until(() => stops('mesh-h3').length === 1)).toBe(true)
  const after = rows('lanes.jsonl').filter(r => r.kind === 'exit' && r.event === 'mesh-h3').at(-1)!
  expect(th.fresh).toBeGreaterThanOrEqual(250000)
  // now over budget: the NEXT event never starts a run (the router's own thread gate, which was there before) and the thread is stopped
  const n = spawns(d.lane!).length
  await L.routeEvent(ev('mesh-h4', { thread: lane.thread, hop: 3, reply_to_id: 'x' }))
  expect(await until(() => stops('mesh-h4').length === 1)).toBe(true)
  expect(stops('mesh-h4')[0].text).toContain('token budget 27'); expect(th.stopped).toContain('token budget'); expect(spawns(d.lane!).length).toBe(n); expect(after.signal).toBe('SIGTERM')
})

test('H11: the --max-turns and --max-budget-usd backstops by kind, before --disallowedTools; env overrides; 0 switches one off', () => {
  expect(L.laneMaxTurns('reflex')).toBe(12); expect(L.laneMaxTurns('synthesis')).toBeLessThan(12 + 1)
  expect(L.laneMaxTurns('worker')).toBeGreaterThan(L.laneMaxTurns('reflex')); expect(L.laneMaxTurns('fork')).toBeGreaterThan(L.laneMaxTurns('reflex'))
  expect(L.laneMaxUsd('reflex')).toBeGreaterThan(0); expect(L.laneMaxUsd('worker')).toBeGreaterThan(L.laneMaxUsd('reflex'))
  process.env.LANES_MAX_TURNS_REFLEX = '7'; process.env.LANES_MAX_BUDGET_USD_REFLEX = '1.5'; process.env.LANES_MAX_TURNS_WORKER = '0'
  expect(L.laneMaxTurns('reflex')).toBe(7); expect(L.laneMaxUsd('reflex')).toBe(1.5); expect(L.laneMaxTurns('worker')).toBe(0)
  delete process.env.LANES_MAX_TURNS_REFLEX; delete process.env.LANES_MAX_BUDGET_USD_REFLEX; delete process.env.LANES_MAX_TURNS_WORKER
})

test('H11: the spawned process gets the flags of its kind', async () => {
  setMode('ok')
  const k = readFileSync(join(dir, 'argv.jsonl'), 'utf8').trim().split('\n').length
  process.env.LANES_MAX_TURNS_REFLEX = '9'
  const d = await L.routeEvent(ev('mesh-h5', { from: 'eve' }))
  delete process.env.LANES_MAX_TURNS_REFLEX
  expect(await until(() => readFileSync(join(dir, 'argv.jsonl'), 'utf8').trim().split('\n').length > k)).toBe(true)
  const a = JSON.parse(readFileSync(join(dir, 'argv.jsonl'), 'utf8').trim().split('\n').at(-1)!)
  expect(a[a.indexOf('--max-turns') + 1]).toBe('9'); expect(a[a.indexOf('--max-budget-usd') + 1]).toBe('5')
  expect(a.indexOf('--max-turns')).toBeLessThan(a.indexOf('--disallowedTools'))
  expect(a.slice(a.indexOf('--disallowedTools'))).toEqual(['--disallowedTools', 'AskUserQuestion', 'ExitPlanMode'])
  expect(d.target).toBe('lane')
})

test('H11: a run that ends on --max-turns or --max-budget-usd is a stop (not retried), the partial result is in the row', async () => {
  setMode('turns')
  const d1 = await L.routeEvent(ev('mesh-h6'))
  expect(await until(() => stops('mesh-h6').length === 1)).toBe(true)
  expect(stops('mesh-h6')[0]).toMatchObject({ notify_main: true, refs: { capped: 'turns', in_run: false } }); expect(stops('mesh-h6')[0].text).toContain('回合上限'); expect(stops('mesh-h6')[0].text).toContain('查到一半')
  await sleep(300); expect(spawns(d1.lane!).length).toBe(1)
  setMode('usd')
  const d2 = await L.routeEvent(ev('mesh-h7'))
  expect(await until(() => stops('mesh-h7').length === 1)).toBe(true)
  expect(stops('mesh-h7')[0].refs.capped).toBe('usd'); expect(stops('mesh-h7')[0].text).toContain('預算'); expect(stops('mesh-h7')[0].text).toContain('花很多')
  await sleep(300); expect(spawns(d2.lane!).length).toBe(1)
})

test('H11: an ordinary run is not touched', async () => {
  setMode('ok')
  const d = await L.routeEvent(ev('mesh-h8'))
  expect(await until(() => rows('lanes.jsonl').some(r => r.kind === 'exit' && r.lane === d.lane))).toBe(true)
  expect(stops('mesh-h8').length).toBe(0); expect(rows('lanes.jsonl').find(r => r.kind === 'exit' && r.lane === d.lane)!.signal).toBeNull()
})

test('002l D7: cache reads do not count against the thread budget: a fork-like run that re-reads 620k per call five times (3.1M of reads) is not stopped', async () => {
  setMode('reads')
  const d = await L.routeEvent(ev('mesh-h9'))
  expect(d.target).toBe('lane')
  expect(await until(() => rows('lanes.jsonl').some(r => r.kind === 'exit' && r.event === 'mesh-h9'))).toBe(true)
  const exit = rows('lanes.jsonl').find(r => r.kind === 'exit' && r.event === 'mesh-h9')!
  expect(exit.signal).toBeNull(); expect(exit.calls).toBe(5)
  expect(exit.tokens_in).toBeGreaterThan(3_000_000)                                      // the input-side total is still recorded
  expect(exit.tokens_fresh).toBe(5 * 1015)                                               // what the budget counts: 10 input + 1000 cache writes + 5 output per call
  expect(stops('mesh-h9').length).toBe(0)
  expect(st.threads[st.lanes[d.lane!].thread].fresh).toBe(5 * 1015)
})

test('002l D1/D7: freshTokens counts uncached input, cache writes and output, never cache reads', () => {
  expect(L.freshTokens({ input_tokens: 3, cache_read_input_tokens: 600000, cache_creation_input_tokens: 21000, output_tokens: 400 })).toBe(21403)
  expect(L.freshTokens({ cache_read_input_tokens: 9902 })).toBe(0)
  expect(L.freshTokens(undefined)).toBe(0)
})

test('H05: the run record carries what the budget accounting holds: running has the thread budget before the run, exited the run\'s tokens and the budget after it', () => {
  const runs = (event: string) => rows('lanes/state.jsonl').filter(l => l.rec === 'run' && l.event === event)
  const thread = (e: string) => st.lanes[runs(e).find(l => l.lane)!.lane].thread
  // mesh-h1: a fresh thread, stopped in the run at the budget
  const r1 = runs('mesh-h1'), run1 = r1.find(l => l.state === 'running')!, end1 = r1.find(l => l.state === 'exited')!
  expect(run1.budget).toEqual({ thread: thread('mesh-h1'), used: 0, limit: 250000 })
  const exit1 = rows('lanes.jsonl').find(r => r.kind === 'exit' && r.event === 'mesh-h1')!
  expect(end1).toMatchObject({ reason: 'budget', tokens: { in: exit1.tokens_in, out: exit1.tokens_out, fresh: exit1.tokens_fresh, calls: exit1.calls } })
  expect(end1.budget.limit).toBe(250000); expect(end1.budget.used).toBeGreaterThanOrEqual(250000)
  // mesh-h3: a later run of a thread that already spent tokens starts with them; its end adds its own
  const run3 = runs('mesh-h3').find(l => l.state === 'running')!, end3 = runs('mesh-h3').find(l => l.state === 'exited')!
  expect(run3.budget.used).toBe(0)                                                       // the test set the thread back to 0 before it
  expect(end3.budget.used).toBe(end3.tokens.fresh)
  // mesh-h8: an ordinary run in its own thread: used after = the run's fresh tokens, under the limit
  const end8 = runs('mesh-h8').find(l => l.state === 'exited')!
  expect(end8.reason).toBe('normal'); expect(end8.tokens.fresh).toBe(1015); expect(end8.budget).toMatchObject({ used: 1015, limit: 250000 })
})
