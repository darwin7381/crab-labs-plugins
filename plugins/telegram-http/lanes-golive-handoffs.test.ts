// lanes-golive: open hand-overs survive the main's compaction. The daemon, the one writer, keeps .lanes/open-handoffs.md (read-only): one line per open main
// obligation (a lane's hand-over, an item routed to the main): event｜來自 from｜handoff id｜what｜自 since｜期限 due, rewritten on every change of them.
// The fleet's re-anchor hook reads it (not edited here).
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?golive-handoffs') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-golive-handoffs-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
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
L.__setMeshSend(async b => ({ text: `sent to ${b.to}`, msgId: 63000, delivered: true }))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const file = () => readFileSync(join(dir, 'open-handoffs.md'), 'utf8')

test('the file exists from the start (nothing owed), read-only', () => {
  expect(file()).toContain('（沒有）')
  expect(statSync(join(dir, 'open-handoffs.md')).mode & 0o222).toBe(0)
})

test('a lane\'s hand-over is a line (event, from, hand-over id, what, since, due) while the main owes it; met, the line goes', async () => {
  const text = '請 adam 代表你答應週五交付規格'
  const d = await L.routeEvent({ id: 'mesh-ho-1', source: 'mesh', from: 'eve', verified: true, text, meta: {}, line: 'call', notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any)
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  expect(await L.callLaneTool(L.__runTok(d.lane!)!, 'handoff_main', { text: 'Eve 要我們答應週五交付規格：要主線決定' })).toContain('handed to the main')
  const line = file().split('\n').find(l => l.startsWith('- mesh-ho-1'))!
  expect(line).toMatch(/^- mesh-ho-1｜來自 eve｜ho-[0-9a-f]+｜Eve 要我們答應週五交付規格：要主線決定.*｜自 \d\d-\d\d \d\d:\d\d｜期限 \d\d-\d\d \d\d:\d\d$/)
  expect(L.openHandoffsLines().length).toBe(1)
  L.__events().set('mesh-ho-1', o => o.kind === 'main', { state: 'met', by: 'test' })
  expect(file()).not.toContain('mesh-ho-1'); expect(file()).toContain('（沒有）')
  writeFileSync(GO, 'ok'); await until(() => !L.__runTok(d.lane!))
}, 20000)
