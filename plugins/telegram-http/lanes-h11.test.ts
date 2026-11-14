// Universe 002k (H11): the thread budget is checked after every assistant turn of a run (not only before it starts), and each lane kind has a --max-turns and
// a --max-budget-usd backstop. The lane process is a script that prints stream-json. No network, no model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isWakeEntry } from './lanes-digest.ts'
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
def msg(i, text, inp=90000, tool=False):
    c = [{'type': 'text', 'text': text}]
    if tool: c.append({'type': 'tool_use', 'id': 't%d' % i, 'name': 'Bash', 'input': {'command': 'curl-free read page %d' % i}})
    print(json.dumps({'type': 'assistant', 'message': {'id': 'm%d' % i, 'content': c, 'usage': {'input_tokens': 10, 'cache_read_input_tokens': inp, 'cache_creation_input_tokens': 0, 'output_tokens': 5}}}), flush=True)
if mode == 'loop':
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
  expect(s.text).toContain('中止前的結果：第 3 頁讀完了，繼續下一頁')                    // the last text of the run when it was stopped (3 x 90,010 >= 250,000)
  expect(isWakeEntry(s)).toBe(true)                                                       // the main is woken
  const exit = rows('lanes.jsonl').find(r => r.kind === 'exit' && r.lane === d.lane)!
  expect(exit.signal).toBe('SIGTERM'); expect(exit.tokens_in).toBeGreaterThanOrEqual(250000); expect(exit.tokens_in).toBeLessThan(450000)   // stopped within a turn or two of the budget, not at 20 pages
  const th = st.threads[st.lanes[d.lane!].thread]
  expect(th.tokens).toBe(exit.tokens_in)                                                  // the run's tokens are in the thread
  await sleep(300)
  expect(spawns(d.lane!).length).toBe(1)                                                  // a stop is not a failure: no retry
  expect(rows('queue.jsonl').length).toBe(0)
})

test('H11: the tokens of the thread\'s earlier runs count: a thread already at 200k stops after the first turn of its next run; the pre-run check still holds the one after', async () => {
  const d = await L.routeEvent(ev('mesh-h2'))
  const lane = st.lanes[d.lane!]
  await until(() => stops('mesh-h2').length === 1)
  const th = st.threads[lane.thread]
  th.tokens = 0                                                                           // a thread that has spent 200k in earlier runs
  const th2 = await L.routeEvent(ev('mesh-h3', { thread: lane.thread, hop: 2, reply_to_id: 'x', from: 'eve' }))
  expect(th2.target).toBe('lane')
  expect(await until(() => stops('mesh-h3').length === 1)).toBe(true)
  const after = rows('lanes.jsonl').filter(r => r.kind === 'exit' && r.event === 'mesh-h3').at(-1)!
  expect(th.tokens).toBeGreaterThanOrEqual(250000)
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
