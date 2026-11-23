// lanes-golive C2: mail is read by a lane (Chiron's needs, rescue-site inbox-tiers.html 第 2 題). The 讀信箱 reminder dispatches the mail lane; the
// mailbox is its work queue; it has the mailbox tools (list, open, check, reply) through the agent-inbox daemon; an opened mail owes Joey the run's one
// line; reply_agent is mail by default and a call only with a because (or as the answer to a call); the main's mail and feed pass the lanes checks too.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ASK_MISSING, BECAUSE_MISSING } from './fleet-mail.ts'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?golive-c2') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-golive-c2-'))
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
const meshOut: any[] = [], mailCalls: any[] = []
L.__setMeshSend(async b => { meshOut.push(b); return { text: `sent to ${b.to}`, msgId: 61000 + meshOut.length, delivered: true } })
L.__setMailTool(async b => { mailCalls.push(b); return b.name === 'mailbox_reply' ? { text: '回信放進對方信箱了（#9001，不用回）。', isError: false, to: 'eve' }
  : b.name === 'mailbox_open' ? { text: '#77 來自 eve｜維護時段\n要你：回時段\n\n下週幾？', isError: false } : { text: '1 封未讀、0 封已讀還沒勾掉：\n#77｜eve｜維護時段', isError: false } })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'],
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
afterAll(() => { try { writeFileSync(GO, 'ok') } catch {}; L.__setClaudeBin(restore); L.__setMailTool(null); delete process.env.LANES_FLOOD_CONTROL })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
let n = 0
const reminder = () => { const text = '讀信箱（1 封未讀，最舊的等了 70 分鐘）：先用 mailbox_list'
  return { id: `mesh-c2-${++n}`, source: 'mesh', from: 'fleet-watchdog', verified: true, text, meta: { no_reply: 'true' }, no_reply: true, wake: 'mail', line: 'mail',
    notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any }
const peer = (text: string) => ({ id: `mesh-c2-${++n}`, source: 'mesh', from: 'eve', verified: true, text, meta: {}, line: 'call', notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any)
const done = async (lane: string) => { writeFileSync(GO, 'ok'); await until(() => !L.__runTok(lane)); await sleep(30) }

test('C2: the 讀信箱 reminder dispatches THE mail lane (one per agent); a reminder while a mailbox run waits adds nothing', async () => {
  const d = await L.routeEvent(reminder())
  expect(d).toMatchObject({ rule: 'wake-mail', target: 'lane' })
  const lane = L.__lanesState().lanes[d.lane!]
  expect(lane.kind).toBe('mail')
  expect(L.__lanesState().mail_lane).toBe(lane.id)
  expect(await until(() => !!L.__runTok(lane.id))).toBe(true)
  const d2 = await L.routeEvent(reminder())                 // one run in progress: one queued after it
  expect(d2).toMatchObject({ target: 'lane', lane: lane.id })
  const d3 = await L.routeEvent(reminder())                 // a run already waits: nothing more
  expect(d3).toMatchObject({ rule: 'wake-mail', target: 'ledger', lane: lane.id })
  expect(d3.note).toContain('already waiting')
  await done(lane.id)
  expect(await until(() => !!L.__runTok(lane.id))).toBe(true)        // the queued run starts after the first
  await done(lane.id)
}, 20000)

test('C2: a mail-lane run owes Joey nothing for a list; an opened mail owes the run its one line; the mailbox tools go to the agent-inbox daemon', async () => {
  const d = await L.routeEvent(reminder())
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  const tok = L.__runTok(d.lane!)!
  const obs = () => (L.__events().get(tok.evId)!.obligations as any[]).map(o => o.kind)
  expect(obs()).not.toContain('joey')
  expect(await L.callLaneTool(tok, 'mailbox_list', {})).toContain('#77')
  expect(obs()).not.toContain('joey')
  expect(await L.callLaneTool(tok, 'mailbox_open', { id: 77 })).toContain('下週幾')
  expect(obs()).toContain('joey')
  expect(await L.callLaneTool(tok, 'mailbox_reply', { id: 77, body: '每週三 02:00' })).toContain('#9001')
  expect(mailCalls.map(c => c.name)).toEqual(['mailbox_list', 'mailbox_open', 'mailbox_reply'])
  expect(mailCalls[0]).toMatchObject({ lane: d.lane })
  await done(d.lane!)
})

test('C2: only the mail lane has the mailbox: its tool list adds the four agent-inbox tools; another lane is refused', async () => {
  expect(L.laneToolsFor('mail').map((t: any) => t.name)).toEqual(expect.arrayContaining(['mailbox_list', 'mailbox_open', 'mailbox_check', 'mailbox_reply', 'reply_agent', 'handoff_main']))
  expect(L.laneToolsFor('reflex').map((t: any) => t.name)).not.toContain('mailbox_open')
  const d = await L.routeEvent(peer('維護時段是什麼？'))
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  expect(await L.callLaneTool(L.__runTok(d.lane!)!, 'mailbox_open', { id: 1 })).toContain('belongs to the mail lane')
  await done(d.lane!)
})

test('C2: reply_agent is mail by default (the fleet rule words: ask required), a call needs because unless it answers a call; mail carries no thread or hop', async () => {
  const d = await L.routeEvent(peer('週報給我？'))
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  const tok = L.__runTok(d.lane!)!
  expect(await L.callLaneTool(tok, 'reply_agent', { to: 'eve', text: '給你' })).toBe(`reply_agent refused - nothing was sent: ${ASK_MISSING}`)
  expect(await L.callLaneTool(tok, 'reply_agent', { line: 'call', to: 'eve', text: '給你' })).toBe(`reply_agent refused - nothing was sent: ${BECAUSE_MISSING}`)
  expect(meshOut.length).toBe(0)
  expect(await L.callLaneTool(tok, 'reply_agent', { to: 'eve', title: 'adam 週報', ask: '收下就好', text: '週報在 out/w47.md', no_reply: true })).toContain('sent to eve')
  expect(meshOut.at(-1)).toMatchObject({ to: 'eve', line: 'mail', title: 'adam 週報', ask: '收下就好', no_reply: true })
  expect(meshOut.at(-1).thread).toBeUndefined(); expect(meshOut.at(-1).hop).toBeUndefined()
  await done(d.lane!)
})

test('C2 server.ts: the agent-inbox not-main guard covers every inbox tool; the main\'s mail and feed go through the lanes checks; the mail lane\'s mailbox is the agent\'s own (fleet-mail.ts)', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  expect(src).toContain('(INBOX_ONLY ? isInboxToolName(req.params.name) : Lanes.MAIN_TELEGRAM_TOOLS.includes(req.params.name))')
  expect(src).toContain("return [...INBOX_TOOLS, DECIDE_TOOL].some(t => t.name === name) || ['call', 'send_mail', 'feed_post'].includes(name)")   // WO-126: mailbox_decide is the main's
  const deps = src.slice(src.indexOf('function laneMainDeps('), src.indexOf('function laneMainDeps(') + 300)
  expect(deps).toContain('btcc: laneMailBtcc'); expect(deps).toContain('core: laneMainCore')
  expect(src).toContain("await Lanes.checkPeerSend('main', to, text, !!reply); if (refused) return { status: 403, json: { detail: refused } }")   // 1.34.2: a reply answers the mail
  expect(src).toContain("await Lanes.checkPeerSend('main', 'the feed wall'")
  expect(src).toContain("handleFleetRpc(m, Lanes.LANES_ON ? laneMainDeps((m as any)?.params?.arguments ?? {}) : fleetDeps)")
  expect(src).toContain("const res: any = await callInboxTool(name, args, { ...fleetDeps, openBy: 'lane', lane }, false)")   // WO-124: the lane's open is 車道讀過; WO-126: the lane id
  expect(src).toContain("await Lanes.checkPeerSend(lane, to, String(args.body ?? ''), true)")
})
