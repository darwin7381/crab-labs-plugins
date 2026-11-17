// Universe 002m (L6B1, RV6 B03 r3: the lane's ledger_query(since="-24h", text="restart mock-api"), the tool's own example, found nothing although B01 and B02
// had restarted mock-api; it counted "first restart" and restarted a third time): every restart a lane runs is a structured ledger action that the example
// finds. Runbook §4 (a third restart in 24 h needs Joey first); 002k B20. The lane is a script printing stream-json; no model, no network.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?pl2-b1-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-pl2-b1-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json
mode = open('${dir}/mode').read().strip()
cmd = {'svc': './bin/svc POST mock-api/restart', 'blocked': './bin/svc POST mock-api/restart', 'plain': './bin/svc GET mock-api/health'}[mode]
print(json.dumps({'type': 'assistant', 'message': {'id': 'm1', 'usage': {'input_tokens': 3, 'output_tokens': 4}, 'content': [{'type': 'tool_use', 'id': 'tu1', 'name': 'Bash', 'input': {'command': cmd}}]}}), flush=True)
res = '{"error": "mock-api restart failed: 503"}' if mode == 'blocked' else '{"ok": true, "restarted": "mock-api"}'
print(json.dumps({'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': 'tu1', 'content': res}]}}), flush=True)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => { L.__setClaudeBin(restore); delete process.env.LANES_FLOOD_CONTROL })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const rows = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const WORDS = ['', '早上', '中午', '下午', '晚上']
const alert = (id: string, n: number) => ({ id, source: 'mesh', from: 'alert-dispatcher', verified: true, text: `[P2][warning] mock-api p95 偏高（${WORDS[Number(id.slice(-1))]}）`, meta: {}, notif: { method: '', params: {} } } as any)
const exits = () => readFileSync(join(dir, 'lanes.jsonl'), 'utf8').split('\n').filter(l => l.includes('"kind":"exit"')).length

test('L6B1: restartCommand reads the workspace svc and the usual restart commands', () => {
  expect(L.restartCommand('./bin/svc POST mock-api/restart')).toBe('mock-api')
  expect(L.restartCommand("cd /w && ./bin/svc POST '/mock-api/restart'")).toBe('mock-api')
  expect(L.restartCommand('svc POST mock-backup/restart && sleep 5')).toBe('mock-backup')
  expect(L.restartCommand('sudo systemctl restart nginx.service')).toBe('nginx')
  expect(L.restartCommand('docker restart api-1')).toBe('api-1')
  expect(L.restartCommand('kubectl -n prod rollout restart deploy/mock-api')).toBe('mock-api')
  expect(L.restartCommand('./bin/svc GET mock-api/health')).toBeNull()
  expect(L.restartCommand('./bin/svc GET mock-api/logs?q=restart')).toBeNull()
})

test('L6B1: two restarts by two lanes are two "restart mock-api" actions; the tool\'s own example finds both; a failed one says so; a health check is none', async () => {
  writeFileSync(join(dir, 'mode'), 'svc')
  await L.routeEvent(alert('mesh-1', 3)); expect(await until(() => exits() >= 1)).toBe(true)
  await L.routeEvent(alert('mesh-2', 7)); expect(await until(() => exits() >= 2)).toBe(true)
  writeFileSync(join(dir, 'mode'), 'blocked')
  await L.routeEvent(alert('mesh-3', 11)); expect(await until(() => exits() >= 3)).toBe(true)
  writeFileSync(join(dir, 'mode'), 'plain')
  await L.routeEvent(alert('mesh-4', 15)); expect(await until(() => exits() >= 4)).toBe(true)
  const acts = rows().filter(r => r.refs?.restart)
  expect(acts.length).toBe(3)
  expect(acts.map(r => r.refs.ok)).toEqual([true, true, false])
  for (const r of acts) { expect(r.kind).toBe('action'); expect(r.text).toMatch(/^restart mock-api/) }
  expect(acts[2].text).toContain('restart mock-api（沒有成功）')
  expect(L.LANE_LEDGER_QUERY_DESCRIPTION).toContain('ledger_query(since="-24h", text="restart mock-api")')
  const tok = { runId: 'x.r1', lane: Object.keys(L.__lanesState().lanes)[0], evId: 'ev', closers: [], critical: false, trigger: 'alert', cls: 'alert', escalated: false, pushed: false } as any
  const out = await L.callLaneTool(tok, 'ledger_query', { since: '-24h', text: 'restart mock-api' })
  expect(out.split('\n').filter(l => l.includes('｜action｜') && l.includes('restart mock-api')).length).toBe(3)
  expect(out).not.toContain('沒有符合的紀錄')
})
