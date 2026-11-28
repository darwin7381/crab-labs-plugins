// WO-175 item 2 (Chiron 08:53Z; CONTRACT §4 「回一件帶 call_id 的呼叫時，回覆的 refs 帶 {kind: "call", value: <call_id>}」): a reply names the Call it answers.
// Through the real router (LANES_WAKE_DECIDE), a lane that is a script waiting for the test to end its run, and the lane's reply_agent as its model would
// call it; what the Telegram daemon hands the agent-inbox daemon (/lanes/send, here the mesh-send hook) is what is checked: its `call` (server.ts puts it in
// /send's refs; onsen-reply-ref-daemon.test.ts checks that half). Chiron's lab 08:29Z (Call 422, no BTCC number): lab-relay.reflex.38's reply_agent with
// no line became a mail and was refused (「缺 ask」); its second, line=call reply_to=mesh-1795681792065-0cc1, reached Onsen with no reply_to_message_id and
// opened Call 423.
//   an item with a call id and no BTCC number: reply_agent with no line → a call back, reply_to = its event id, call = its call id; with reply_to = that
//   event id → the same; an item with a BTCC number answered with that number → the same; an item with no call id → no call; a send to someone else that
//   names the event → no call; the main's own send (callAnswered from its delivery's did, or the BTCC number) → the Call; the fact read is the event's
//   record in the journal (a fresh fold of the file has it: a daemon restart keeps it)
import { test, expect, afterAll } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { programView } from './screen-status.ts'
import { Journal } from './lanes-state.ts'
import { sendToAgent, type FleetDeps } from './fleet-mail.ts'
import { fakeItems } from './test-fixtures/onsen-items.ts'
import { itemRef } from './onsen-items.ts'
import { TakeMode } from './onsen-take.ts'
import { ItemReceiver } from './onsen-receive.ts'
import { Claims } from './onsen-claims.ts'
import { OnsenClient } from './onsen-client.ts'
import type { StatusView } from './onsen-status.ts'

const AGENT = 'wo175reply'
process.env.LANES_WAKE_DECIDE = AGENT
process.env.LANES_FLOOD_CONTROL = '0'
process.env.LANES_RECEIPT_STEPS = '0'
const inbox = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: req =>
  new URL(req.url).pathname === '/lanes/offer' ? Response.json({ offered: true }) : new Response(null, { status: 404 }) })
process.env.LANES_INBOX_PORT = String(inbox.port)
const L = await import('./lanes.ts?wo175reply') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-wo175reply-'))
process.env.LANES_DIR = dir
writeFileSync(join(dir, 'router.json'), readFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), 'utf8'))
const GO = join(dir, 'go')
const bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, re, sys, time
a = sys.argv
p = a[a.index('-p') + 1] if '-p' in a else ''
m = re.search(r'lane id：([^；）]+)', p)
go = '${GO}-' + (m.group(1) if m else 'x')
t0 = time.time()
while time.time() - t0 < 30:
    if os.path.exists(go):
        os.remove(go); break
    time.sleep(0.02)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restoreBin = L.__setClaudeBin(bin)
L.__setRetryBackoff(20)
const program: StatusView = { state: 'idle', detail: { queued_joey: 0 }, last_activity_at: new Date().toISOString() }
const mesh: any[] = []
L.__setMeshSend(async b => { mesh.push(b); return { text: `delivered to ${b.to}'s inbox`, msgId: undefined, delivered: true } })
L.lanesInit({ role: 'tg', agent: AGENT, workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false,
  registryNames: () => ['chiron', 'eve'], sendBot: async () => 700, joeyChatId: () => '1',
  mainStatus: () => programView(program), notifySession: async () => true, streamOpen: () => true } as any)
L.__setMainConnected('mcp-main')
afterAll(() => { inbox.stop(true); delete process.env.LANES_INBOX_PORT; L.__setClaudeBin(restoreBin); L.__setMeshSend(null)
  for (const k of ['LANES_WAKE_DECIDE', 'LANES_FLOOD_CONTROL', 'LANES_RECEIPT_STEPS']) delete process.env[k] })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
let n = 0
/** a peer's call as the agent-inbox daemon hands it to the router (laneEventOf): with no BTCC number its id is mesh-<time>-<hex>, as on the lab (BTCC :9) */
function item(o: { btcc?: string; call_id?: string; from?: string; verified?: boolean } = {}): any {
  n += 1
  const from = o.from ?? 'chiron', text = `請算 23×${n}，把結果回給 ${from}`
  const meta: Record<string, string> = { user: from, ...(o.btcc ? { btcc_msg_id: o.btcc } : {}) }
  return { id: o.btcc ? `mesh-${o.btcc}` : `mesh-${1795681792065 + n}-0c${n.toString(16).padStart(2, '0')}`, source: 'mesh', from, verified: o.verified ?? true, text,
    item_kind: 'peer_call', line: 'call', ...(o.btcc ? { btcc_msg_id: o.btcc } : {}), ...(o.call_id ? { call_id: o.call_id } : {}),
    meta, notif: { method: 'notifications/claude/channel', params: { content: text, meta } } }
}
async function start(ev: any): Promise<{ lane: string; tok: any }> {
  const d = await L.routeEvent(ev)
  expect(d.target).toBe('lane')
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  return { lane: d.lane!, tok: L.__runTok(d.lane!)! }
}
async function end(lane: string) { writeFileSync(`${GO}-${lane}`, 'ok'); expect(await until(() => !L.__runTok(lane))).toBe(true); await sleep(40) }
const sentFor = (to: string) => mesh.filter(b => b.to === to).at(-1)

test('the main\'s send: the Call from its delivery\'s did (m-…) or the BTCC number it quotes; the fact is the event\'s record, kept in the journal across a restart', async () => {
  const a = item({ call_id: '427', verified: false })                                       // an unverified caller goes to the main
  const b = item({ btcc: '12604', call_id: '428', verified: false })
  expect((await L.routeEvent(a)).target).toBe('main')
  const did = (ev: any) => L.__main().items((r: any) => r.event === ev.id).at(-1)!.id as string
  expect(did(a)).toMatch(/^m-/)
  expect(await until(() => L.__main().items(r => r.event === a.id)[0]?.state === 'offered', 2000)).toBe(true)
  const prompt = { pid: process.pid, prompt_id: 'bound-main-call' }
  await L.__mainEvent({ event: 'UserPromptSubmit', ...prompt, dids: [did(a)] })
  expect((await L.routeEvent(b)).target).toBe('main')
  expect(L.callAnswered('chiron', did(a))).toEqual({ kind: 'peer_call', id: '427' })
  expect(L.callAnswered('Chiron', `${did(b)},${did(a)}`)?.id).toBe('428')                  // a did list (the item and what rode with it): the first that is that agent's Call
  expect(L.callAnswered('chiron', '12604')).toEqual({ kind: 'peer_call', id: '428' })
  expect(await L.callForReply('chiron', 12604)).toBe('428')
  expect(await L.callForReply('chiron', '')).toBeNull()
  expect(await L.resolveMainCall('chiron', '')).toEqual({ reply_to: a.id, call: '427' })
  expect(L.callAnswered('chiron', '99999')).toBeNull()                                     // no such event
  expect(L.callAnswered('eve', did(a))).toBeNull()
  // a restart folds the same file: the record still names the Call (the lookup reads nothing else)
  const j = new Journal(join(dir, 'lanes', 'state.jsonl'))
  expect(j.load()).toBeGreaterThan(0)
  expect(j.get('event', a.id)?.call).toEqual({ kind: 'peer_call', id: '427' })
  expect(j.get('event', 'mesh-12604')?.call).toEqual({ kind: 'peer_call', id: '428' })
  expect(j.get('msg', did(a))?.event).toBe(a.id)
  const outbound: any[] = []
  const deps = { callReply: L.resolveMainCall, call: async (...args: any[]) => { outbound.push(args); return 'delivered' } } as FleetDeps
  await sendToAgent({ line: 'call', to: 'chiron', text: 'answer from main' }, deps, false)
  expect(outbound.at(-1)).toEqual(['chiron', 'answer from main', undefined, true, undefined, '427'])
  await sendToAgent({ line: 'call', to: 'chiron', reply_to: '12604', text: 'earlier call' }, deps, false)
  expect(outbound.at(-1)).toEqual(['chiron', 'earlier call', 12604, true, undefined, '428'])
  expect(await L.resolveMainCall('eve', undefined)).toBeNull()
  await L.__mainEvent({ event: 'Stop', ...prompt, phase: 'final' })
})

test('Chiron\'s lab: an item with a call id and no BTCC number, answered by reply_agent with no line: a call back, reply_to = its event id, naming its Call', async () => {
  const ev = item({ call_id: '422' })
  expect(ev.btcc_msg_id).toBeUndefined()
  const { lane, tok } = await start(ev)
  expect(L.callOfEvent(ev.id)).toEqual({ kind: 'peer_call', id: '422' })
  const k = mesh.length
  const out = await L.callLaneTool(tok, 'reply_agent', { to: 'chiron', text: '23 × 1 = 23' })
  expect(out).toContain('delivered')                                                       // not 「缺 ask」 (a mail with no ask)
  expect(mesh.length).toBe(k + 1)
  expect(sentFor('chiron')).toMatchObject({ to: 'chiron', line: 'call', reply_to: ev.id, no_reply: true, call: '422' })
  await end(lane)
})

for (const mode of ['pull', 'take', 'take with BTCC id']) test(mode + ' binds a call back to its caller even when only because names the event', async () => {
  const ev = item({ call_id: '9', btcc: mode === 'take with BTCC id' ? '12608' : undefined })
  const f = fakeItems()
  const client = new OnsenClient({ dir, agent: 'adam', record: true, base: f.base, credential: () => 'test-member', log: () => {} })
  const take = new TakeMode('adam', client.request.bind(client), () => {}, () => {}, 'mac-mini')
  const claims = new Claims(join(dir, 'claims.json'), client, () => {}, () => {})
  try {
    if (mode !== 'pull') {
      const row = f.add(ev.btcc_msg_id ? '124' : '122', 'call', { from: 'chiron', call_id: '9' })
      ev.onsen_items = [itemRef(row)]
      await take.probe()
      L.useItemReceiver(new ItemReceiver(take, claims, () => {}))
    }
    const { lane, tok } = await start(ev)
    try {
      if (mode === 'take') expect(ev.id).toBe('item-122-v1')
      const sent = await L.callLaneTool(tok, 'reply_agent', { line: 'call', to: 'chiron', because: ev.id, text: '23 × 7 = 161' })
      expect(sent).toContain('delivered')
      expect(sentFor('chiron')).toMatchObject({ reply_to: ev.btcc_msg_id ?? ev.id, call: '9', no_reply: true })
    } finally { await end(lane) }
  } finally { L.useItemReceiver(undefined); claims.stop(); take.stop(); client.stop(); await f.stop() }
})

test('the same answered with line=call and reply_to = the event id (what the lane wrote on the lab): the Call is named', async () => {
  const ev = item({ call_id: '423' })
  const { lane, tok } = await start(ev)
  await L.callLaneTool(tok, 'reply_agent', { line: 'call', to: 'chiron', reply_to: ev.id, text: '23 × 2 = 46' })
  expect(sentFor('chiron')).toMatchObject({ line: 'call', reply_to: ev.id, no_reply: true, call: '423' })
  await end(lane)
})

test('an item with a BTCC number and a call id, answered with that number (and with no line): the Call is named as well', async () => {
  const ev = item({ btcc: '12601', call_id: '424' })
  const { lane, tok } = await start(ev)
  await L.callLaneTool(tok, 'reply_agent', { line: 'call', to: 'chiron', reply_to: '12601', text: '23 × 3 = 69' })
  expect(sentFor('chiron')).toMatchObject({ reply_to: '12601', no_reply: true, call: '424' })
  await end(lane)
  const ev2 = item({ btcc: '12602', call_id: '425' })
  const r2 = await start(ev2)
  await L.callLaneTool(r2.tok, 'reply_agent', { to: 'chiron', text: '23 × 4 = 92' })
  expect(sentFor('chiron')).toMatchObject({ line: 'call', reply_to: '12602', call: '425' })
  await end(r2.lane)
})

test('an item with no call id (before its Call exists): the reply names none', async () => {
  const ev = item({ btcc: '12603' })
  const { lane, tok } = await start(ev)
  expect(L.callOfEvent(ev.id)).toBeNull()
  await L.callLaneTool(tok, 'reply_agent', { to: 'chiron', text: '23 × 5 = 115' })
  const b = sentFor('chiron')
  expect(b).toMatchObject({ line: 'call', reply_to: '12603' })
  expect(b.call).toBeUndefined()
  await end(lane)
})

test('a send to another agent that names the event: no Call (an answer goes back to the one who called)', async () => {
  const ev = item({ call_id: '426' })
  const { lane, tok } = await start(ev)
  await L.callLaneTool(tok, 'reply_agent', { line: 'call', to: 'eve', reply_to: ev.id, text: 'FYI：chiron 問的是 23×6' })
  const b = sentFor('eve')
  expect(b).toBeTruthy()
  expect(b.call).toBeUndefined()
  expect(L.callAnswered('eve', ev.id)).toBeNull()
  expect(L.callAnswered('chiron', ev.id)).toEqual({ kind: 'peer_call', id: '426' })
  await end(lane)
})
