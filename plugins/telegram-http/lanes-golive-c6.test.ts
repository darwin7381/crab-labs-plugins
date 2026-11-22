// lanes-golive C6: what rings Joey follows the current rules (ORG-CHART §0 #2 「做了什麼就報什麼、全進 Joey 手機…永遠不是砍通知」, #5 例行無變化一句話,
// high-frequency 只打回執). The lab's tiers (silent scheduled / peer / board / routine alert lines, a frequency cap, a quiet follow-up, a quiet line after
// a ring, a quiet main reply) are not the fleet default: the default profile pushes every line; `tiered` stays an explicit switch (/lanes notify).
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const prev = process.env.LANES_NOTIFY_PROFILE
delete process.env.LANES_NOTIFY_PROFILE
const L = await import('./lanes.ts?golive-c6') as typeof import('./lanes.ts')
if (prev !== undefined) process.env.LANES_NOTIFY_PROFILE = prev
const dir = mkdtempSync(join(tmpdir(), 'lanes-golive-c6-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))      // the lab table: silent classes
const GO = join(dir, 'go'), bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, time
t0 = time.time()
while time.time() - t0 < 30 and not os.path.exists('${GO}'): time.sleep(0.02)
try: os.remove('${GO}')
except OSError: pass
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
L.__setClaudeBin(bin)
const sent: Array<{ text: string; silent?: boolean }> = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async (_c: string, text: string, o: any) => { sent.push({ text, silent: o?.silent }); return 500 + sent.length }, joeyChatId: () => '1' } as any)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }

test('C6: the fleet default profile pushes every class, whatever the router table says (the lab table has silent rows); no frequency cap', () => {
  expect(L.notifyProfile()).toBe('default')
  for (const cls of ['scheduled', 'peer', 'board', 'alert', 'alert-info', 'thread', 'fork', 'mail', 'alert-critical', 'joey']) expect(L.tierFor(cls, false).tier).toBe('push')
  for (let i = 0; i < 5; i++) L.__lanesState().pushes['adam#t-cap'] = [...(L.__lanesState().pushes['adam#t-cap'] ?? []), Date.now()]
  expect(L.notifyDecision('scheduled', false, 'adam#t-cap').tier).toBe('push')
})

test('C6: a scheduled run\'s line and a peer run\'s line reach Joey as ordinary pushes (not disable_notification)', async () => {
  for (const [id, from, text, meta] of [['mesh-c6-1', 'scheduler', '[scheduled][daily][run:61] 每日檢查', { run_id: '61' }], ['mesh-c6-2', 'eve', '問一下備份時段', {}]] as const) {
    const d = await L.routeEvent({ id, source: 'mesh', from, verified: true, text, meta, line: 'call', notif: { method: 'notifications/claude/channel', params: { content: text, meta } } } as any)
    expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
    const out = await L.callLaneTool(L.__runTok(d.lane!)!, 'notify_joey', { text: `${id}：處理好了`, outcome: 'changed' })
    expect(out).toContain('sent to Joey')
    expect(sent.at(-1)).toMatchObject({ silent: false })
    writeFileSync(GO, 'ok'); await until(() => !L.__runTok(d.lane!)); await sleep(30)
  }
}, 20000)

test('C6 (#5): a high-frequency routine whose lane says "normal" stays in the receipt when nobody can judge the line (no Jev): Joey gets nothing', async () => {
  const text = '[scheduled][inbox-poll][run:62][high-frequency] 看信'
  const d = await L.routeEvent({ id: 'mesh-c6-hf', source: 'mesh', from: 'scheduler', verified: true, text, meta: { run_id: '62', frequency: 'high' },
    notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any)
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  const n = sent.length
  const out = await L.callLaneTool(L.__runTok(d.lane!)!, 'notify_joey', { text: '沒有新信', outcome: 'normal' })
  expect(out).toContain('owes Joey no line')
  expect(sent.length).toBe(n)
  writeFileSync(GO, 'ok'); await until(() => !L.__runTok(d.lane!)); await sleep(30)
}, 20000)
