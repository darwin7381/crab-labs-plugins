// Universe 002m (L6CEH1, RV6 CEH: tokens_out 27 against 16,597 in the transcript, H2 r2): the thread budget counts output tokens from the final usage of
// each call (the transcript, the run's result), not from the stream's start-of-message snapshots. identity rule 6 「token 預算，超過就停」 (D1/D7: fresh =
// input + cache writes + output). The lane is a script that prints stream-json snapshots and writes a transcript with the real numbers; no model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_THREAD_BUDGET = '20000'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?pl2-ceh1-test') as typeof import('./lanes.ts')
delete process.env.LANES_THREAD_BUDGET
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-pl2-ceh1-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
// calls: [real output in the transcript, the snapshot's output in the stream]; input 1000 fresh per call (no cache)
const bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, sys, time
a = sys.argv[1:]
sid = a[a.index('--session-id') + 1] if '--session-id' in a else a[a.index('--resume') + 1]
plan = json.loads(open('${dir}/plan').read())
tr = open('${dir}/' + sid + '.jsonl', 'a')
for i, real in enumerate(plan['calls']):
    mid = 'msg_%d_%s' % (i, sid[:6])
    snap = {'input_tokens': 1000, 'cache_read_input_tokens': 0, 'cache_creation_input_tokens': 0, 'output_tokens': 2}
    print(json.dumps({'type': 'assistant', 'message': {'id': mid, 'usage': snap, 'content': [{'type': 'tool_use', 'id': 'tu%d' % i, 'name': 'Bash', 'input': {'command': 'echo %d' % i}}]}}), flush=True)
    time.sleep(0.15)
    full = dict(snap, output_tokens=real)
    tr.write(json.dumps({'type': 'assistant', 'message': {'id': mid, 'usage': full, 'content': [{'type': 'tool_use', 'id': 'tu%d' % i, 'name': 'Bash', 'input': {}}]}}) + '\\n'); tr.flush()
    print(json.dumps({'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': 'tu%d' % i, 'content': 'ok %d' % i}]}}), flush=True)
    time.sleep(0.15)
res = {'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'done'}
if plan.get('result_out'): res['usage'] = {'input_tokens': 1000 * len(plan['calls']), 'output_tokens': plan['result_out']}
print(json.dumps(res), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => { L.__setClaudeBin(restore); delete process.env.LANES_FLOOD_CONTROL })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const rows = (f: string): any[] => { try { return readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const peer = (id: string, from: string, text: string) => ({ id, source: 'mesh', from, verified: true, text, meta: {}, notif: { method: '', params: {} } } as any)

test('L6CEH1: callUsage / maxUsage / transcriptUsage read the final usage of a message', () => {
  const p = join(dir, 'tu.jsonl')
  writeFileSync(p, [{ type: 'assistant', message: { id: 'a', usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 3 } } },
    { type: 'assistant', message: { id: 'a', usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 900 } } },
    { type: 'assistant', message: { id: 'b', usage: { input_tokens: 1, output_tokens: 1 } } }].map(o => JSON.stringify(o)).join('\n') + '\n')
  const m = L.transcriptUsage(p, ['a'])
  expect([...m.keys()]).toEqual(['a'])
  expect(m.get('a')).toEqual({ in: 115, out: 900, fresh: 915 })                  // fresh never counts the cache read
  expect(L.maxUsage({ in: 115, out: 2, fresh: 17 }, m.get('a')!)).toEqual({ in: 115, out: 900, fresh: 915 })
})

test('L6CEH1: the exit row and the thread count the transcript\'s output, not the stream\'s snapshots', async () => {
  writeFileSync(join(dir, 'plan'), JSON.stringify({ calls: [3000, 4000] }))
  const d = await L.routeEvent(peer('mesh-c1', 'eve', 'mock-api 的逾時設定是多少？'))
  expect(await until(() => rows('lanes.jsonl').some(r => r.kind === 'exit' && r.event === 'mesh-c1'))).toBe(true)
  const ex = rows('lanes.jsonl').find(r => r.kind === 'exit' && r.event === 'mesh-c1')
  expect(ex.tokens_out).toBe(7000)                                              // was 4 (two snapshots of 2)
  expect(ex.tokens_fresh).toBe(2000 + 7000)
  expect(L.__lanesState().threads[L.__lanesState().lanes[d.lane!].thread].fresh).toBe(9000)
})

test('L6CEH1: the run\'s result totals count when they are larger than what the transcript had', async () => {
  writeFileSync(join(dir, 'plan'), JSON.stringify({ calls: [10, 10], result_out: 5000 }))
  await L.routeEvent(peer('mesh-c2', 'cain', '備份的保留天數是幾天？'))
  expect(await until(() => rows('lanes.jsonl').some(r => r.kind === 'exit' && r.event === 'mesh-c2'))).toBe(true)
  expect(rows('lanes.jsonl').find(r => r.kind === 'exit' && r.event === 'mesh-c2').tokens_out).toBe(5000)
})

test('L6CEH1: the in-run budget stop sees the output: 20,000 fresh are crossed at the third call (1k in + 12k out, then 1k + 9k), not never', async () => {
  writeFileSync(join(dir, 'plan'), JSON.stringify({ calls: [12000, 9000, 50, 50, 50] }))
  await L.routeEvent(peer('mesh-c3', 'eve', '請把 mock-api 近 20 頁日誌整理成報告'))
  expect(await until(() => rows('ledger.jsonl').some(r => r.kind === 'stop' && r.event === 'mesh-c3'))).toBe(true)
  const stop = rows('ledger.jsonl').find(r => r.kind === 'stop' && r.event === 'mesh-c3')
  expect(stop.refs.capped).toBe('budget'); expect(stop.refs.in_run).toBe(true)
  expect(stop.refs.calls).toBe(3)                                               // stopped as the third call started, not after the fifth
  expect(await until(() => rows('lanes.jsonl').some(r => r.kind === 'exit' && r.event === 'mesh-c3'))).toBe(true)
})
