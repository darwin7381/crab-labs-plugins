// WO-141 follow-up (Epeius, mail #200294) end to end: a real Telegram daemon (server.ts, lanes on, the fleet router) against the Bot API stand-in, a
// usage-wall state file this test writes the way usage_wall.py does, and a lane binary that answers with the usage limit (429) until it is told not to.
// A mailbox ring's lane run walls (the lanes' wall up; their own probe 10 minutes away); the state file walls; a second ring waits; the state file clears
// (probe_after_switch): server.ts onWallChange hands the clear to the lanes in the same step, their wall comes down and the queued run starts within
// seconds (plutus 11-26: 6 minutes later, at the lanes' own probe). Mesh events reach the daemon as the agent-inbox daemon sends them: POST /lanes/route.
import { test, expect, afterAll } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const root = mkdtempSync(join(tmpdir(), 'wo141-wall-d-'))
const wallDir = join(root, 'usage-wall'), WALLED = join(root, 'walled'), GO = join(root, 'go'), bin = join(root, 'lane.py')
mkdirSync(wallDir, { recursive: true })
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, time
open('${root}/runs.log', 'a').write('run\\n')
if os.path.exists('${WALLED}'):
    print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': True, 'terminal_reason': 'api_error', 'api_error_status': 429, 'result': "API Error: 429 You've hit your weekly limit"}), flush=True)
    raise SystemExit(1)
print(json.dumps({'type': 'assistant', 'message': {'id': 'm1', 'usage': {'input_tokens': 10, 'output_tokens': 2}, 'content': [{'type': 'text', 'text': 'ok'}]}}), flush=True)
t0 = time.time()
while time.time() - t0 < 20 and not os.path.exists('${GO}'): time.sleep(0.05)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'done'}), flush=True)
`)
chmodSync(bin, 0o755)
const EPISODE = 'adam-20261125T222335Z'
function writeState(over: Record<string, unknown>): void {
  writeFileSync(join(wallDir, 'claude-adam.json'), JSON.stringify({ agent: 'adam', tmux: 'claude-adam', session: 's1', transcript: null, in_wall: true, episode: EPISODE,
    since: new Date().toISOString(), kind: 'seven_day', text: "You've hit your weekly limit", resets_at: null, cleared_at: null, cleared_by: null,
    updated_at: new Date().toISOString(), ...over }))
}
const api = startBotApiMock()
let d: TgDaemon | null = null
afterAll(async () => { try { writeFileSync(GO, '1') } catch {}; await d?.stop(); api.stop() })
const rows = (n: string): any[] => { try { return readFileSync(join(d!.ws, '.lanes', n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const RING = '讀信箱（1 封未讀，最舊的等了 0 分鐘）：先用 mailbox_list（mcp__plugin_agent-inbox_agent-inbox__mailbox_list）看清單'
let n = 0
async function ring(): Promise<string> {
  const id = `mesh-ring-${++n}`
  const tok = readFileSync(join(root, 'tok', String(d!.port)), 'utf8').trim()
  const r = await fetch(`http://127.0.0.1:${d!.port}/lanes/route`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id, source: 'mesh', from: 'mailbox', verified: true, text: RING, no_reply: true, wake: 'mail', line: 'mail',
      meta: { no_reply: 'true', ring: 'true', wake: 'mail', line: 'mail' }, notif: { method: 'notifications/claude/channel', params: { content: RING, meta: {} } } }) })
  expect(r.status).toBe(200)
  return id
}
const wallNow = async (): Promise<any> => {
  const tok = readFileSync(join(root, 'tok', String(d!.port)), 'utf8').trim()
  return (await fetch(`http://127.0.0.1:${d!.port}/lanes/state`, { headers: { authorization: `Bearer ${tok}` } }).then(r => r.json()) as any).wall ?? null
}

test('the daemon\'s usage wall clears: the lanes\' wall comes down in the same step and the queued run starts within seconds, not at their own probe', async () => {
  writeFileSync(WALLED, '1')
  d = await startTgDaemon(api, root, 1828, { USAGE_WALL_READ: '1', USAGE_WALL_DIR: wallDir, USAGE_WALL_CACHE_MS: '200', LANES_CLAUDE_BIN: bin,
    LANES_WALL_PROBE_MS: '600000', LANES_RETRY_BACKOFF_MS: '50' })
  expect(await until(() => { try { return !!readFileSync(join(root, 'tok', String(d!.port)), 'utf8').trim() } catch { return false } }, 10000)).toBe(true)
  const first = await ring()                                              // its run hits the limit: the lanes' wall up
  expect(await until(async () => !!(await wallNow()), 10000)).toBe(true)
  writeState({})                                                          // the daemon's state walls (a StopFailure of the main)
  await new Promise(r => setTimeout(r, 1500))
  const second = await ring()                                             // waits behind the wall
  await new Promise(r => setTimeout(r, 1000))
  const spawns = () => rows('lanes.jsonl').filter(r => r.kind === 'spawn')
  const k = spawns().length
  expect(await wallNow()).not.toBeNull()
  rmSync(WALLED)                                                          // the account switch: a model call gets through again
  const cleared = Date.now()
  writeState({ in_wall: false, cleared_at: new Date(cleared).toISOString(), cleared_by: 'probe_after_switch' })
  expect(await until(async () => !(await wallNow()), 5000)).toBe(true)
  expect(await until(() => spawns().length > k, 5000)).toBe(true)
  const at = Date.parse(spawns()[k].ts)
  console.log(`state file cleared → lanes' wall down → next run spawned (ms): ${at - cleared}`)
  expect(at - cleared).toBeLessThan(3000)
  expect(rows('lanes.jsonl').find(r => r.kind === 'wall_follow')).toMatchObject({ why: 'clear', cleared_by: 'probe_after_switch', then: 'down' })
  expect([first, second].some(e => spawns().slice(k).some(s => s.event === e))).toBe(true)
  expect(d!.log()).toContain('usage wall: ')
  writeFileSync(GO, '1')
}, 60_000)
