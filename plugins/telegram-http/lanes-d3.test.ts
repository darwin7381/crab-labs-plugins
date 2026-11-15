// Universe 002l (D3, RV1 A07 #11): /lanes close of a RUNNING lane gives its run a grace to say where it is, writes the close row after the run has ended
// (with what it reported and its last tool results), and never tells Joey that progress was recorded before it was. design/stability 「看不到、關不掉」:
// 「Telegram 可以列出與關閉」. The lane process is a script; no model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?d3-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-d3-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.py')
// pages of work; at each tool boundary it reads its steer file like the hook; mode 'obey' reports its progress and ends when told to close, 'deaf' does not
writeFileSync(bin, `#!/usr/bin/env python3
import sys, json, time, os
mode = open('${dir}/mode').read().strip()
steer = os.path.join(os.environ['LANES_DIR'], 'run', 'steer', os.environ['LANE_ID'] + '.in.jsonl')
for i in range(1, 200):
    print(json.dumps({'type': 'assistant', 'message': {'id': 'm%d' % i, 'content': [{'type': 'tool_use', 'id': 't%d' % i, 'name': 'Bash', 'input': {'command': 'fetch page %d' % i}}], 'usage': {'input_tokens': 5, 'output_tokens': 5}}}), flush=True)
    print(json.dumps({'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': 't%d' % i, 'content': 'page %d of 20 done' % i}]}}), flush=True)
    time.sleep(0.1)
    if mode == 'obey' and os.path.exists(steer) and '關閉了這條車道' in open(steer).read():
        print(json.dumps({'type': 'assistant', 'message': {'id': 'n1', 'content': [{'type': 'tool_use', 'id': 'n1', 'name': 'mcp__lane__notify_joey', 'input': {'text': 'WO-227 進度 %d/20 頁，其餘沒做' % i}}], 'usage': {'input_tokens': 5, 'output_tokens': 5}}}), flush=True)
        print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'stopped at page %d' % i}), flush=True)
        sys.exit(0)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => { L.__setClaudeBin(restore); delete process.env.LANES_FLOOD_CONTROL; delete process.env.LANES_CLOSE_GRACE_MS })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const st = L.__lanesState()
const rows = (n: string): any[] => { try { return readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(25) } return f() }
const ev = (id: string) => ({ id, source: 'mesh', from: 'eve', verified: true, text: 'WO-227 二十頁都整理一下', meta: {}, notif: { method: '', params: {} } } as any)
const closeRows = (lane: string) => rows('ledger.jsonl').filter(r => r.refs?.closed === lane)

test('D3: a running lane told to close reports where it is within the grace; the close row comes after it ended and carries its report', async () => {
  writeFileSync(join(dir, 'mode'), 'obey'); process.env.LANES_CLOSE_GRACE_MS = '5000'
  const d = await L.routeEvent(ev('mesh-c1'))
  expect(await until(() => rows('lanes.jsonl').some(r => r.kind === 'spawn' && r.lane === d.lane))).toBe(true)
  await sleep(400)
  const reply = await L.lanesCommand(`/lanes close ${d.lane}`, 'joey_lab')
  expect(reply).toContain('正在關閉'); expect(reply).toContain('結束後'); expect(reply).not.toContain('已寫進帳本')   // nothing is claimed before it happened
  expect(st.lanes[d.lane!].status).toBe('closed')
  expect(closeRows(d.lane!).length).toBe(0)                                             // not yet: the run is still in its grace
  expect(await until(() => closeRows(d.lane!).length === 1)).toBe(true)
  const c = closeRows(d.lane!)[0]
  expect(c.notify_main).toBe(true); expect(c.refs).toMatchObject({ was_running: true, stopped: null, reported: 1 })
  expect(c.text).toContain('它自己收尾結束了'); expect(c.text).toMatch(/notify_joey：WO-227 進度 \d+\/20 頁/)
  const exit = rows('lanes.jsonl').find(r => r.kind === 'exit' && r.lane === d.lane)!
  expect(exit.signal).toBeNull(); expect(exit.exit_code).toBe(0)
})

test('D3: a run that does not end within the grace is stopped; the close row says so and keeps its last tool result', async () => {
  writeFileSync(join(dir, 'mode'), 'deaf'); process.env.LANES_CLOSE_GRACE_MS = '700'
  const d = await L.routeEvent(ev('mesh-c2'))
  expect(await until(() => rows('lanes.jsonl').some(r => r.kind === 'spawn' && r.lane === d.lane))).toBe(true)
  await sleep(300)
  await L.lanesCommand(`/lanes close ${d.lane}`, 'joey_lab')
  expect(await until(() => closeRows(d.lane!).length === 1)).toBe(true)
  const c = closeRows(d.lane!)[0]
  expect(c.refs.stopped).toBe('SIGTERM'); expect(c.text).toContain('已停掉'); expect(c.text).toContain('（沒有回報）')
  expect(c.text).toMatch(/最後的工具結果：.*page \d+ of 20 done/)
})

test('D3: a lane that is not running is closed at once; the reply says only what is true', async () => {
  const d = await L.routeEvent(ev('mesh-c3'))
  await until(() => rows('lanes.jsonl').some(r => r.kind === 'spawn' && r.lane === d.lane))
  await sleep(200)
  const r = L.__runTok(d.lane!)
  if (r) await until(() => !L.__runTok(d.lane!), 3000)
  // the deaf script runs long: stop it, then close an idle lane
  process.env.LANES_CLOSE_GRACE_MS = '100'
  await L.lanesCommand(`/lanes close ${d.lane}`, 'joey_lab')
  await until(() => closeRows(d.lane!).length === 1)
  st.lanes['adam.reflex.77'] = { id: 'adam.reflex.77', kind: 'reflex', n: 77, session_id: 's77', thread: 'adam#t-77', status: 'idle', created: '', last: new Date().toISOString(), transcript: '/x', runs: 1, tokens_in: 0, tokens_out: 0 } as any
  const out = await L.lanesCommand('/lanes close adam.reflex.77', 'joey_lab')
  expect(out).toContain('已關閉'); expect(out).toContain('沒有在執行')
  expect(closeRows('adam.reflex.77')[0].refs.was_running).toBe(false)
})
