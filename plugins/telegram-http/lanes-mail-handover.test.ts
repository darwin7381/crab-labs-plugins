// Chiron #10841 (2026-11-23), his condition for the mail lane's new closing words: a run that opens mail and hands it to the main must not
// give Joey a line of its own (the main reports once). lanes-golive C2 harness: mail is read by a lane (Chiron's needs, rescue-site inbox-tiers.html 第 2 題). The 讀信箱 reminder dispatches the mail lane; the
// mailbox is its work queue; it has the mailbox tools (list, open, check, reply) through the agent-inbox daemon; an opened mail owes Joey the run's one
// line; reply_agent is mail by default and a call only with a because (or as the answer to a call); the main's mail and feed pass the lanes checks too.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ASK_MISSING, BECAUSE_MISSING } from './fleet-mail.ts'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?mail-handover') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-mail-handover-'))
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
const restore = L.__setClaudeBin(bin)
const meshOut: any[] = [], mailCalls: any[] = [], sent: string[] = []
L.__setMeshSend(async b => { meshOut.push(b); return { text: `sent to ${b.to}`, msgId: 61000 + meshOut.length, delivered: true } })
L.__setMailTool(async b => { mailCalls.push(b); return b.name === 'mailbox_reply' ? { text: '回信放進對方信箱了（#9001，不用回）。', isError: false, to: 'eve' }
  : b.name === 'mailbox_open' ? { text: '#77 來自 eve｜維護時段\n要你：回時段\n\n下週幾？', isError: false } : { text: '1 封未讀、0 封已讀還沒勾掉：\n#77｜eve｜維護時段', isError: false } })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'],
  sendBot: async (_c: string, text: string) => { sent.push(text); return 9000 + sent.length }, joeyChatId: () => '1' } as any)
afterAll(() => { try { writeFileSync(GO, 'ok') } catch {}; L.__setClaudeBin(restore); L.__setMailTool(null); delete process.env.LANES_FLOOD_CONTROL })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
let n = 0
const reminder = () => { const text = '讀信箱（1 封未讀，最舊的等了 70 分鐘）：先用 mailbox_list'
  return { id: `mesh-mh-${++n}`, source: 'mesh', from: 'fleet-watchdog', verified: true, text, meta: { no_reply: 'true' }, no_reply: true, wake: 'mail', line: 'mail',
    notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any }
const peer = (text: string) => ({ id: `mesh-mh-${++n}`, source: 'mesh', from: 'eve', verified: true, text, meta: {}, line: 'call', notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any)
const done = async (lane: string) => { writeFileSync(GO, 'ok'); await until(() => !L.__runTok(lane)); await sleep(30) }

test('a mail-lane run that opened a mail and handed it to the main: the lane gives Joey no line of its own; the Joey line is the main\'s', async () => {
  const d = await L.routeEvent(reminder())
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  const tok = L.__runTok(d.lane!)!
  await L.callLaneTool(tok, 'mailbox_list', {})
  await L.callLaneTool(tok, 'mailbox_open', { id: 77 })
  const r = await L.callLaneTool(tok, 'handoff_main', { text: '#77 eve，期限無；要 adam 決定維護時段；信裡：下週幾；建議：每週三 02:00（沿用上次）；沒查：eve 的行事曆。我結掉的：無。' })
  expect(r).toContain('handed to the main')
  await L.callLaneTool(tok, 'receipt', { outcome: 'done', happened: '讀信箱 1 封', did: '打開 #77，交回主線', promised: '無', needs_main: '#77 決定維護時段' })
  await done(d.lane!)
  await sleep(300)
  const ev = L.__events().get(tok.evId)!
  expect((ev.obligations as any[]).map(o => `${o.kind}:${o.state}`)).toEqual(['joey:handed', 'main:open'])   // the opened mail's Joey line went with the hand-over
  expect(sent).toEqual([])
})
