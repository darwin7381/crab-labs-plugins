// Universe 002l (D13, RV3 G07 #0): lane slots follow the live quota reading (env or file, set by the quota poller / the lab driver); with no reading the
// fixed cap. design/stability 「名額要跟著即時額度調」. The lane process is a script that sleeps; no model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?pl-d13-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-pld13-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.sh'); writeFileSync(bin, '#!/bin/sh\nsleep 1.2\n'); chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => { L.__setClaudeBin(restore); delete process.env.LANES_FLOOD_CONTROL; delete process.env.LANES_QUOTA_USED })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const rows = (n: string): any[] => { try { return readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(25) } return f() }
const quota = (o: unknown) => writeFileSync(join(dir, 'run', 'quota.json'), JSON.stringify(o))
const running = () => { const s = rows('lanes.jsonl'); const sp = s.filter(r => r.kind === 'spawn').map(r => r.run), ex = new Set(s.filter(r => r.kind === 'exit').map(r => r.run)); return sp.filter(r => !ex.has(r)).length }
const ev = (id: string) => ({ id, source: 'mesh', from: 'eve', verified: true, text: `問題 ${id}`, meta: {}, notif: { method: '', params: {} } } as any)

test('D13: no quota reading: the fixed cap (LANES_MAX, 4)', () => {
  expect(L.quotaUsed()).toBeNull(); expect(L.laneSlots()).toBe(4)
})

test('D13: at >= 90% weekly use one slot: three new events run one after another, none is dropped', async () => {
  quota({ used: 0.92, at: new Date().toISOString() })
  expect(L.laneSlots()).toBe(1)
  for (const id of ['q1', 'q2', 'q3']) expect((await L.routeEvent(ev(id))).target).toBe('lane')
  await sleep(200)
  expect(running()).toBe(1)
  let peak = 0
  await until(() => { peak = Math.max(peak, running()); return rows('lanes.jsonl').filter(r => r.kind === 'exit').length === 3 }, 10000)
  expect(peak).toBe(1)
  expect(rows('lanes.jsonl').filter(r => r.kind === 'exit').length).toBe(3)
  expect((await L.lanesCommand('/lanes', 'joey_lab'))).toContain('名額 1/4（額度已用 92%）')
}, 15000)

test('D13: the reading is followed as it changes: 80% half the slots, 50% the cap; percent and plain-number forms; the env wins; a stale reading is ignored', () => {
  quota({ weekly_used_pct: 80 }); expect(L.laneSlots()).toBe(2)
  quota(0.5); expect(L.laneSlots()).toBe(4)
  quota({ used: 0.95, at: new Date(Date.now() - 3 * 3600_000).toISOString() }); expect(L.quotaUsed()).toBeNull(); expect(L.laneSlots()).toBe(4)
  process.env.LANES_QUOTA_USED = '91'; expect(L.laneSlots()).toBe(1)
  delete process.env.LANES_QUOTA_USED
  expect(rows('lanes.jsonl').some(r => r.kind === 'slots' && r.slots === 2)).toBe(true)      // each change is on the record
})
