// 002w (002v r3 F03, u002v-F03-s5-r3-20261120-075430): a fork goes its own way and does not merge back (overview.md 「複製之後各走各的，不會自動合回去」). In
// that play the fork handed its result to the main with handoff_main; the main stopped and relayed it to Joey. A fork's handoff_main is refused: its
// result is its own line to Joey (notify_joey), and the main reads it in the digest. Every other lane kind keeps its hand-over. A fake lane binary; no model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?w-fork-test') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-w-fork-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
const GO = join(dir, 'go'), bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, time
t0 = time.time()
while time.time() - t0 < 60 and not os.path.exists('${GO}'): time.sleep(0.02)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
afterAll(() => { try { writeFileSync(GO, 'ok') } catch {}; L.__setClaudeBin(restore); delete process.env.LANES_FLOOD_CONTROL })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }

test('002w fork: a fork lane\'s handoff_main is refused (nothing handed, its Joey line still its own); the lane context says so; a reflex lane\'s hand-over still goes through', async () => {
  const d = await L.routeEvent({ id: 'mesh-wf-1', source: 'mesh', from: 'eve', verified: true, text: '方案 B 試得怎樣？', btcc_msg_id: '65001', meta: {}, notif: { method: '', params: {} } } as any)
  expect(d.target).toBe('lane')
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  const lane = L.__lanesState().lanes[d.lane!], tok = L.__runTok(d.lane!)!
  const handed = () => L.__main().items((r: any) => r.kind === 'handoff' && r.event === 'mesh-wf-1').length
  lane.kind = 'fork'; lane.fork_from = 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed'
  const r = await L.callLaneTool(tok, 'handoff_main', { text: '寫入佔 27.3%，請主線回報 Joey。' })
  expect(r).toContain('refused: a fork does not hand its work back'); expect(r).toContain('notify_joey')
  expect(handed()).toBe(0)
  expect((L.__events().get('mesh-wf-1')!.obligations as any[]).some(o => o.kind === 'main')).toBe(false)     // no hand-over was requested on the record
  expect(L.laneContext(lane, { ev: { id: 'mesh-wf-1', text: 'x' } } as any)).toContain('你沒有 handoff_main')
  lane.kind = 'reflex'; delete lane.fork_from
  const ok = await L.callLaneTool(tok, 'handoff_main', { text: '這件事要主線決定。' })
  expect(ok).not.toContain('refused'); expect(handed()).toBe(1)
  writeFileSync(GO, 'ok'); await until(() => !L.__runTok(d.lane!))
})
