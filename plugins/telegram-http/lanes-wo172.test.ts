// WO-172 item 1 in the lanes: what a lane sends to a colleague (reply_agent) carries its run as turn_id; the router's own notices carry none; the main's
// turn is asked of the tg daemon by the inbox daemon (its send_to_agent) through /lanes/turn. The tg daemon's /lanes/ routes run behind a real HTTP
// server here and an inbox-role instance asks them as the inbox daemon does. A fake lane binary that waits, a mesh stub; no model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
process.env.LANES_FLOOD_CONTROL = '0'
let L: typeof import('./lanes.ts')
const srv = createServer((req, res) => { void L.handleLanesHttp(new URL(req.url ?? '/', 'http://127.0.0.1'), req, res) })
await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
process.env.LANES_TG_PORT = String((srv.address() as AddressInfo).port)
L = await import('./lanes.ts?wo172-tg') as typeof import('./lanes.ts')
const I = await import('./lanes.ts?wo172-inbox') as typeof import('./lanes.ts')
delete process.env.LANES_TG_PORT
const dir = mkdtempSync(join(tmpdir(), 'lanes-wo172-'))
process.env.LANES_DIR = dir
copyFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), join(dir, 'router.json'))
const GO = join(dir, 'go'), bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, time
t0 = time.time()
while time.time() - t0 < 60 and not os.path.exists('${GO}'): time.sleep(0.02)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
const meshOut: any[] = []
L.__setMeshSend(async b => { meshOut.push(b); return { text: `sent to ${b.to}`, msgId: 73000 + meshOut.length, delivered: true } })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => true, registryNames: () => ['eve'],
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
const idir = mkdtempSync(join(tmpdir(), 'lanes-wo172-inbox-'))
process.env.LANES_DIR = idir
I.lanesInit({ role: 'inbox', agent: 'adam', workspaceDir: idir, transcriptDir: idir, httpPort: 0, log: () => {}, authOk: () => true, registryNames: () => ['eve'] } as any)
process.env.LANES_DIR = dir
afterAll(() => { try { writeFileSync(GO, 'ok') } catch {}; L.__setClaudeBin(restore); L.__setMeshSend(null); srv.close(); delete process.env.LANES_FLOOD_CONTROL })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }

test("a lane's reply_agent carries the lane's run (its turn); runOfLane names it; nothing once the run is over", async () => {
  const ev = { id: 'mesh-172-1', source: 'mesh', from: 'eve', verified: true, text: '週報的數字對嗎？', btcc_msg_id: '74001', meta: {},
    notif: { method: 'notifications/claude/channel', params: { content: '週報的數字對嗎？', meta: {} } } } as any
  const d = await L.routeEvent(ev)
  expect(d.target).toBe('lane')
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  const tok = L.__runTok(d.lane!)!
  expect(L.runOfLane(d.lane!)).toBe(tok.runId)
  const k = meshOut.length
  await L.callLaneTool(tok, 'reply_agent', { line: 'call', to: 'eve', text: '對，已核過。', reply_to: '74001' })
  const sent = meshOut.slice(k).find(b => b.to === 'eve' && b.urgency !== 'silent')
  expect(sent).toMatchObject({ lane: d.lane, turn_id: tok.runId })
  writeFileSync(GO, 'ok')
  expect(await until(() => !L.__runTok(d.lane!))).toBe(true)
  expect(L.runOfLane(d.lane!)).toBeNull()
  // the router's own notices (silent) carry no turn
  for (const b of meshOut.filter(b => b.urgency === 'silent')) expect(b.turn_id).toBeUndefined()
})

test("the main's turn: here (tg role) and as the inbox daemon asks it (/lanes/turn) for the main's send_to_agent; none out of a turn", async () => {
  L.__setMainConnected('mcp-main')
  const pid = process.pid
  await L.__mainEvent({ event: 'Stop', pid })
  expect(await L.mainTurnId()).toBeNull()
  expect(await I.mainTurnId()).toBeNull()
  await L.__mainEvent({ event: 'UserPromptSubmit', pid, prompt_id: 'p-172' })
  expect(await L.mainTurnId()).toBe('p-172')
  expect(await I.mainTurnId()).toBe('p-172')
  await L.__mainEvent({ event: 'Stop', pid, prompt_id: 'p-172', phase: 'final' })
  expect(await until(() => L.__main().mainPhase() === 'idle')).toBe(true)
  expect(await I.mainTurnId()).toBeNull()
})
