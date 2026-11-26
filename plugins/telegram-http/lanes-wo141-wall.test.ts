// WO-141 follow-up (Epeius, mail #200294; his WO-141 comment 05:04Z): the lanes' wall follows the daemon's usage wall. plutus 11-26, the timeline
// replayed (times compressed): 22:22:23Z a lane run hits the weekly limit (the lanes' wall up); 22:23:35Z the daemon's usage-wall state walled;
// 22:47:21Z BTCC rings the mailbox (the mail lane queued behind the wall); 00:16:54Z the daemon's state clears (an account switch, its keeper's probe:
// probe_after_switch). Before: the lanes kept their own wall until their own probe (10/20/30 min back-off) at 00:22:34Z, the mail lane at 00:23:06Z.
// Now the clear ends the lanes' wall in the same step and the queued mail lane starts within seconds; while the daemon says walled the lanes probe
// nothing of their own; a clear nothing backs makes them probe at once; each clear is followed once. The lane process is a script; no model, no network.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?wo141-wall') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-wo141-wall-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
const GO = join(dir, 'go'), bin = join(dir, 'lane.py')
// one model call (an assistant record), then waits for GO, then a normal result: a run that reached the model
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, sys, time
argv = sys.argv[1:]
open('${dir}/runs.log', 'a').write(('bare' if 'Reply with the single word OK.' in argv else 'run') + '\\n')
print(json.dumps({'type': 'assistant', 'message': {'id': 'm1', 'usage': {'input_tokens': 10, 'output_tokens': 2}, 'content': [{'type': 'text', 'text': 'ok'}]}}), flush=True)
t0 = time.time()
while time.time() - t0 < 30 and not os.path.exists('${GO}'): time.sleep(0.02)
try: os.remove('${GO}')
except OSError: pass
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'OK'}), flush=True)
`)
chmodSync(bin, 0o755)
const restoreBin = L.__setClaudeBin(bin)
L.__setMailTool(async () => ({ text: '0 封未讀', isError: false }))
// what the daemon's usage-wall state says (server.ts usageWall: null = no fresh state)
let uw: { walled: boolean; clearedMs: number | null; by?: string | null } | null = null
const sent: string[] = []
L.lanesInit({ role: 'tg', agent: 'plutus', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false,
  registryNames: () => ['eve'], sendBot: async (_c: string, t: string) => { sent.push(t); return 900 + sent.length }, joeyChatId: () => '1',
  usageWall: () => uw } as any)
afterAll(() => { try { writeFileSync(GO, 'ok') } catch {}; L.__setClaudeBin(restoreBin); L.__setWallProbe(300_000); delete process.env.LANES_FLOOD_CONTROL })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 8000): Promise<boolean> { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(20) } return fn() }
const rows = (n: string): any[] => { try { return readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const runs = (): string[] => { try { return readFileSync(join(dir, 'runs.log'), 'utf8').trim().split('\n').filter(Boolean) } catch { return [] } }
const spawns = (ev: string) => rows('lanes.jsonl').filter(r => r.kind === 'spawn' && r.event === ev)
const follows = () => rows('lanes.jsonl').filter(r => r.kind === 'wall_follow')
const RING = '讀信箱（1 封未讀，最舊的等了 0 分鐘）：先用 mailbox_list（mcp__plugin_agent-inbox_agent-inbox__mailbox_list）看清單'
let n = 0
const ring = () => ({ id: `mesh-2001${59 + n++}`, source: 'mesh', from: 'mailbox', verified: true, text: RING, no_reply: true, wake: 'mail', line: 'mail',
  meta: { no_reply: 'true', ring: 'true', wake: 'mail', line: 'mail' }, notif: { method: 'notifications/claude/channel', params: { content: RING, meta: {} } } } as any)
async function finish(): Promise<void> {
  for (let i = 0; i < 20 && L.__lanesState() && Object.values(L.__lanesState().lanes).some((l: any) => L.__runTok(l.id)); i++) { writeFileSync(GO, 'ok'); await sleep(150) }
  try { rmSync(GO) } catch {}
}

test('the plutus timeline: the daemon\'s clear (probe_after_switch) ends the lanes\' wall in the same step; the queued mail lane starts within seconds; before it, no probe of the lanes\' own', async () => {
  L.__setWallProbe(300)                                                    // the lanes' own probe would be due long before the clear
  L.__wallUp('rate_limit', "You've hit your weekly limit", 'plutus.reflex.11.r2')   // 22:22:23Z: a lane run hit the limit
  uw = { walled: true, clearedMs: null }                                   // 22:23:35Z: the daemon's state walled
  await sleep(500)                                                         // the lanes' probe time passes: the daemon says walled, so no probe
  const ev = ring()                                                        // 22:47:21Z: BTCC rings the mailbox
  const d = await L.routeEvent(ev)
  expect(d).toMatchObject({ target: 'lane' })
  await sleep(800)
  expect(spawns(ev.id)).toEqual([])                                        // queued behind the wall: no run is a probe while the daemon is walled
  expect(runs()).toEqual([])                                               // and no bare probe either
  expect(L.wallActive()).toBe(true)
  const cleared = Date.now()                                               // 00:16:54Z: the account switch; the keeper's probe answered
  uw = { walled: false, clearedMs: cleared, by: 'probe_after_switch' }
  L.usageWallChanged({ walled: false, clearedMs: cleared, by: 'probe_after_switch' })   // server.ts onWallChange, the clear branch
  expect(L.wallActive()).toBe(false)                                       // the same step
  expect(await until(() => spawns(ev.id).length === 1, 3000)).toBe(true)
  const at = Date.parse(spawns(ev.id)[0].ts)
  console.log(`daemon clear → mail lane spawn (ms): ${at - cleared}`)
  expect(at - cleared).toBeLessThan(2000)
  expect(follows().at(-1)).toMatchObject({ why: 'clear', cleared_by: 'probe_after_switch', then: 'down' })
  expect(rows('lanes.jsonl').some(r => r.kind === 'wall_probe')).toBe(false)   // the lanes' own back-off never ran
  await finish()
})

test('a clear nothing backs (the state no longer fresh): the lanes probe at once (one run), and its answer takes the wall down', async () => {
  L.__setWallProbe(600_000)                                                // the lanes' own probe: 10 minutes away
  L.__wallUp('rate_limit', 'weekly limit', 'test')
  uw = { walled: true, clearedMs: null }
  const ev = ring()
  await L.routeEvent(ev)
  await sleep(300)
  expect(spawns(ev.id)).toEqual([])
  uw = null                                                                // the keeper died: the state is not fresh any more
  L.usageWallChanged(null)
  expect(follows().at(-1)).toMatchObject({ why: 'clear', cleared_at: null, then: 'probe' })
  expect(await until(() => spawns(ev.id).length === 1, 3000)).toBe(true)  // the queued item is the probe, now, not in 10 minutes
  expect(L.wallActive()).toBe(true)                                        // until it gets through
  writeFileSync(GO, 'ok')
  expect(await until(() => !L.wallActive(), 5000)).toBe(true)              // it reached the model: the wall comes down as before
  await finish()
})

test('each clear is followed once: a lane that walls again after it keeps its own wall and back-off; a clear the daemon missed telling (a restart) is followed at the probe', async () => {
  L.__setWallProbe(300)
  await sleep(20)
  const c1 = Date.now() - 10
  uw = { walled: false, clearedMs: c1, by: 'ok_turn' }
  L.__wallUp('rate_limit', 'weekly limit', 'test')                         // the lanes walled after the daemon's clear (a lane on another limit)
  expect(L.__lanesState().wall_clear_used ?? 0).toBeLessThan(c1)
  const before = follows().length
  await sleep(600)                                                         // its probe time: c1 is older than this wall's start, but not followed yet
  // the clear (ok_turn: the main's own turn got through) is followed once: down, then a run walls again on the same clear: its own back-off
  expect(follows().length).toBe(before + 1)
  expect(follows().at(-1)).toMatchObject({ why: 'probe', cleared_by: 'ok_turn', then: 'down' })
  expect(L.wallActive()).toBe(false)
  L.__wallUp('rate_limit', 'weekly limit again', 'test')
  await sleep(600)
  expect(follows().length).toBe(before + 1)                                // the same clear: not followed again
  expect(L.wallActive()).toBe(true)                                        // its own probe (a bare run here) decides
  await until(() => runs().includes('bare'), 3000)
  writeFileSync(GO, 'ok')
  expect(await until(() => !L.wallActive(), 5000)).toBe(true)
  // no fresh state at all: the lanes' own probe, as before
  uw = null
  L.__setWallProbe(300)
  L.__wallUp('overload', 'overloaded', 'test')
  const k = runs().length
  expect(await until(() => runs().length > k, 3000)).toBe(true)
  writeFileSync(GO, 'ok')
  expect(await until(() => !L.wallActive(), 5000)).toBe(true)
  await finish()
})
