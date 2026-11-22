// Universe 002l (D8, RV3 H05/F03; N4, RV2 E02): a lane knows its limits, is told before it is cut, and a cut run keeps its hand-over. design/identity rule 6
// 「超過就停、升級主線」; design/stability 「每個回合結束前要回報一句，做不到就擋下來」. The lane process is a script that prints stream-json; no model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_FLOOD_CONTROL = '0'
process.env.LANES_THREAD_BUDGET = '100000'                                    // read once at import: this instance only
process.env.LANES_MAX_TURNS_REFLEX = '6'
const L = await import('./lanes.ts?d8-test') as typeof import('./lanes.ts')
delete process.env.LANES_THREAD_BUDGET
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-d8-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.py')
// each call: one assistant message with a Bash tool_use, then its tool result; the script looks at its steer file the way the hook does and notes what it saw
writeFileSync(bin, `#!/usr/bin/env python3
import sys, json, time, os
mode = open('${dir}/mode').read().strip()
lane = os.environ.get('LANE_ID')
steer = os.path.join(os.environ.get('LANES_DIR'), 'run', 'steer', lane + '.in.jsonl')
def call(i, fresh):
    print(json.dumps({'type': 'assistant', 'message': {'id': 'm%d' % i, 'content': [{'type': 'text', 'text': '第 %d 頁' % i}, {'type': 'tool_use', 'id': 't%d' % i, 'name': 'Bash', 'input': {'command': './bin/svc GET logs?page=%d' % i}}],
        'usage': {'input_tokens': 10, 'cache_read_input_tokens': 50000, 'cache_creation_input_tokens': fresh, 'output_tokens': 5}}}), flush=True)
    print(json.dumps({'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': 't%d' % i, 'content': 'page %d: 5xx=%d' % (i, i * 3)}]}}), flush=True)
    time.sleep(0.25)
    if os.path.exists(steer):
        open('${dir}/seen.txt', 'a').write(open(steer).read())
if mode == 'budget':
    for i in range(1, 30): call(i, 30000)
    time.sleep(20)
elif mode == 'turns':
    for i in range(1, 6): call(i, 100)
    print(json.dumps({'type': 'result', 'subtype': 'error_max_turns', 'is_error': True, 'num_turns': 6}), flush=True); sys.exit(1)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => { L.__setClaudeBin(restore); delete process.env.LANES_FLOOD_CONTROL; delete process.env.LANES_MAX_TURNS_REFLEX })
const sent: Array<{ text: string; silent: boolean }> = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async (_c: string, text: string, o: any) => { sent.push({ text, silent: !!o?.silent }); return 9800 + sent.length }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const st = L.__lanesState()
const rows = (n: string): any[] => { try { return readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(25) } return f() }
const seen = (): string => { try { return readFileSync(join(dir, 'seen.txt'), 'utf8') } catch { return '' } }
const ev = (id: string, text = '請把 log 20 頁的 5xx 全部數完再回報') => ({ id, source: 'mesh', from: 'eve', verified: true, text, meta: {}, notif: { method: '', params: {} } } as any)
const stops = (event: string) => rows('ledger.jsonl').filter(r => r.kind === 'stop' && r.event === event)

test('D8/N4: the lane reads its limits in the per-run block (turn cap, thread budget left)', () => {
  const lane = { id: 'adam.reflex.99', kind: 'reflex', n: 99, thread: 'adam#t-x', session_id: 's', status: 'new', created: '', last: '', transcript: '', runs: 0, tokens_in: 0, tokens_out: 0 } as any
  const c = L.laneContext(lane, { ev: {} } as any)
  expect(c).toContain('這一趟最多 6 次模型呼叫'); expect(c).toContain('token 預算還剩 100000'); expect(c).toContain('〔系統通知｜車道上限〕')
  expect(c.indexOf('# 這一趟的上限')).toBeLessThan(c.indexOf('〔車道資訊結束'))
  expect(L.identityCard(lane)).not.toContain('100000')                                  // per-run numbers never go into the per-kind card (D15)
})

test('D8: at 80% of the thread budget the run is told to hand over (system notice at its next tool boundary); still cut at the budget, the stop row keeps the last tool results', async () => {
  writeFileSync(join(dir, 'mode'), 'budget'); writeFileSync(join(dir, 'seen.txt'), '')
  const d = await L.routeEvent(ev('mesh-b1'))
  expect(await until(() => stops('mesh-b1').length === 1)).toBe(true)
  const w = rows('lanes.jsonl').filter(r => r.kind === 'limit_warning' && r.lane === d.lane)
  expect(w.map(r => r.which)).toEqual(['budget'])
  expect(seen()).toContain('"kind":"system"'); expect(seen()).toContain('預算快用完了'); expect(seen()).toContain('handoff_main')
  const s = stops('mesh-b1')[0]
  expect(s.refs.capped).toBe('budget'); expect((L.__events().get('mesh-b1')!.obligations as any[]).some(o => o.kind === 'main')).toBe(true)   // PL1: the stop reaches the main as its M3 hand-over
  expect(s.refs.partial).toContain('最後的工具結果：'); expect(s.refs.partial).toMatch(/page \d+: 5xx=\d+/)   // not only 「還沒有文字結果；用過 Bash」
})

test('D8/N4: the steer hook renders a system notice without the Joey frame, and never holds a run at Stop for one', () => {
  const d = mkdtempSync(join(tmpdir(), 'lanes-d8-hook-'))
  mkdirSync(join(d, 'run', 'steer'), { recursive: true })
  writeFileSync(join(d, 'run', 'steer', 'adam.reflex.5.in.jsonl'), JSON.stringify({ id: 'sys-r1-turns', kind: 'system', text: '這一趟只剩 2 次模型呼叫' }) + '\n')
  const run = (event: string) => spawnSync('python3', [join(import.meta.dir, 'lanes-hooks', 'lane-steer-hook.py')], { input: JSON.stringify({ hook_event_name: event, tool_name: 'Bash' }), env: { ...process.env, LANE_ID: 'adam.reflex.5', LANES_DIR: d }, encoding: 'utf8' }).stdout
  expect(run('Stop').trim()).toBe('')                                                              // Stop: not handed over, nothing blocks
  const out = JSON.parse(run('PostToolUse'))
  expect(out.hookSpecificOutput.additionalContext).toBe('〔系統通知｜車道上限〕這一趟只剩 2 次模型呼叫')
  expect(run('PostToolUse').trim()).toBe('')                                                       // once
})
