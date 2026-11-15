// Universe 002l (S0 item 4): while a usage wall stays up the router backs off (the probe interval doubles after each failed probe, up to a cap) instead of
// respawning the queued event at a fixed interval (V1-G: 14 respawns ~45 s apart). Review §十一 「撞額度時要退避，不要每 47 秒重開」. The "model" is a script.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?pl-s0wall-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-pls0w-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
writeFileSync(join(dir, 'result.json'), JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429, result: "You've hit your weekly limit · resets 10:49pm (Asia/Taipei)" }) + '\n')
const bin = join(dir, 'lane.sh'); writeFileSync(bin, `#!/bin/sh\ncat '${join(dir, 'result.json')}'\nexit 1\n`); chmodSync(bin, 0o755)
const OK = join(dir, 'ok.sh'); writeFileSync(OK, `#!/bin/sh\necho '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'\nexit 0\n`); chmodSync(OK, 0o755)
const restore = L.__setClaudeBin(bin)
process.env.LANES_WALL_PROBE_MAX_MS = '1000'
L.__setWallProbe(120)
afterAll(() => { L.__setClaudeBin(restore); L.__setWallProbe(300_000); delete process.env.LANES_WALL_PROBE_MAX_MS })
const sent: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async (_c: string, t: string) => { sent.push(t); return 1 }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const rows = (): any[] => { try { return readFileSync(join(dir, 'lanes.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }

test('S0: wallBackoffMs doubles for a usage or login wall up to the cap, and keeps the base for an overload or API error', () => {
  delete process.env.LANES_WALL_PROBE_MAX_MS                                                        // the default cap: 30 min
  expect([0, 1, 2, 3, 4].map(n => L.wallBackoffMs('usage', n, 45_000))).toEqual([45_000, 90_000, 180_000, 360_000, 720_000])
  expect(L.wallBackoffMs('auth', 12, 45_000)).toBe(1_800_000)
  process.env.LANES_WALL_PROBE_MAX_MS = '1000'
  expect(L.wallBackoffMs('usage', 30, 45_000)).toBe(45_000)                                         // a cap below the base never shortens it
  expect(L.wallBackoffMs('usage', 30, 120)).toBe(1000)
  expect(L.wallBackoffMs('overload', 5, 60_000)).toBe(60_000); expect(L.wallBackoffMs('error', 9, 60_000)).toBe(60_000)
})

test('S0: behind a usage wall the queued event is probed at growing intervals (not a fixed one), Joey is told once, and the event is run when it lifts', async () => {
  await L.routeEvent({ id: 'mesh-g1', source: 'mesh', from: 'eve', verified: true, text: 'WO-27 排第幾？', meta: {}, notif: { method: '', params: {} } } as any)
  expect(await until(() => rows().filter(r => r.kind === 'spawn').length >= 5, 10000)).toBe(true)
  const t = rows().filter(r => r.kind === 'spawn').map(r => Date.parse(r.ts))
  const gaps = t.slice(1).map((x, i) => x - t[i])
  expect(gaps[1]).toBeGreaterThan(gaps[0] * 1.4); expect(gaps[2]).toBeGreaterThan(gaps[1] * 1.4)       // 120 → 240 → 480 ms …
  expect(gaps[3]).toBeLessThan(1600)                                                                 // … capped (1000 ms here)
  expect(sent.filter(s => s.includes('額度用完')).length).toBe(1)
  expect(sent[0]).toContain('間隔加倍')
  L.__setClaudeBin(OK)
  expect(await until(() => !L.wallActive(), 4000)).toBe(true)
  expect(await until(() => rows().some(r => r.kind === 'exit' && r.event === 'mesh-g1' && r.exit_code === 0), 4000)).toBe(true)
}, 20000)
