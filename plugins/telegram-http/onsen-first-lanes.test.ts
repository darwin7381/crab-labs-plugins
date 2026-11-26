// WO-192 acceptance 6: the lanes' words to Joey take the same path as the main's reply (server.ts sendBot → onsen-first): one Onsen message each,
// written before Telegram, by the right sender (the lane's id; the router's notices `router`), its delivery reported. A real tg daemon (lanes on,
// ONSEN_FIRST = adam) against a Bot API stand-in and a stand-in Onsen 0.31.0; a worker lane whose "claude" calls notify_joey; the router's notice is
// the peer-flood one (eve, a registered peer, sends faster than LANES_PEER_NEW_PER_MIN = 1). A lane's line whose Telegram send fails: the lane is told
// 「已寫進 Onsen…會再送」, nothing is owed again (no second Onsen message), and Telegram gets it once it is back.
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, freePort, type TgDaemon } from './test-fixtures/tg-daemon.ts'
import { startOnsenStandin, type OnsenStandin } from './test-fixtures/onsen-standin.ts'

const JOEY = 1828
const CRED = 'mesh_FIRSTlanesSECRETsecretSECRETsecret01'
const BODY = (lane: string) => `## 完成 ${lane}\n\n名單整理好了。`
let api: BotApiMock, d: TgDaemon, onsen: OnsenStandin, root = ''
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'onsen-first-lanes-'))
  mkdirSync(join(root, 'bin'), { recursive: true })
  const bin = join(root, 'bin', 'claude')
  // a worker lane says its line to Joey (notify_joey); any other lane only ends its run
  writeFileSync(bin, `#!/usr/bin/env python3
import json, os, sys, urllib.request
lane = os.environ.get('LANE_ID', '?')
if '.worker.' not in lane:
    print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True); sys.exit(0)
a = sys.argv[1:]
srv = json.load(open(a[a.index('--mcp-config') + 1]))['mcpServers']['lane']
def post(body, sid=None):
    h = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Authorization': srv['headers']['Authorization']}
    if sid: h['mcp-session-id'] = sid
    r = urllib.request.urlopen(urllib.request.Request(srv['url'], data=json.dumps(body).encode(), headers=h, method='POST'), timeout=20)
    raw, out = r.read().decode(), None
    for line in raw.splitlines():
        if line.startswith('data:'): out = json.loads(line[5:])
    return (out if out is not None else (json.loads(raw) if raw.strip().startswith('{') else None)), r.headers.get('mcp-session-id') or sid
_, sid = post({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 'fake-lane', 'version': '0'}}})
post({'jsonrpc': '2.0', 'method': 'notifications/initialized'}, sid)
body = ${JSON.stringify(BODY('__LANE__'))}.replace('__LANE__', lane)
res, _ = post({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'notify_joey', 'arguments': {'text': body, 'outcome': 'changed'}}}, sid)
open(os.path.join(${JSON.stringify(root)}, 'said-' + lane), 'w').write(json.dumps(res))
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
  chmodSync(bin, 0o755)
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ eve: { url: 'http://127.0.0.1:1/' }, adam: { url: 'http://127.0.0.1:1/' } }))
  mkdirSync(join(root, 'cred'), { recursive: true }); writeFileSync(join(root, 'cred', 'c'), CRED + '\n')
  onsen = startOnsenStandin({ [CRED]: 'lanes' }, await freePort())
  api = startBotApiMock({ has_topics_enabled: true, allows_users_to_create_topics: false }, { pollHoldMs: 300 })   // a worker lane needs its topic
  d = await startTgDaemon(api, root, JOEY, { LANES_CLAUDE_BIN: bin, LANES_RETRY_BACKOFF_MS: '600000', LANES_CLOSE_GRACE_MS: '300', LANES_PEER_NEW_PER_MIN: '1',
    AGENT_INBOX_REGISTRY: join(root, 'registry.json'), ONSEN_BASE: `http://127.0.0.1:${onsen.port}/api/onsen`, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'c'),
    ONSEN_PEER_LOOKUP: '0', ONSEN_CLAUDE_BIN: '/nonexistent/claude', ONSEN_FIRST: 'adam', ONSEN_FIRST_RETRY_MS: '100,100,100', ONSEN_FIRST_RESEND_MS: '600,600,600' })
}, 60000)
afterAll(async () => { await d?.stop(); api?.stop(); onsen?.stop() })

async function route(ev: Record<string, unknown>): Promise<any> {
  const tok = readFileSync(join(root, 'tok', String(d.port)), 'utf8').trim()
  const text = String(ev.text)
  return fetch(`http://127.0.0.1:${d.port}/lanes/route`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: JSON.stringify({ source: 'mesh', verified: true, meta: {}, notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } }, ...ev }) }).then(r => r.json())
}
const workOrder = (n: number) => route({ id: `mesh-of-${n}`, from: 'board', line: 'call', text: `[board][WO-${n}] 請 adam 整理名單` })
const A = (has: string) => onsen.writes('lanes').filter(m => String(m.item.body).includes(has))
const sent = (has: string) => api.calls.filter(c => (c.method === 'sendRichMessage' || c.method === 'sendMessage') && JSON.stringify(c.body).includes(has))
const delivered = (id: number) => onsen.msgs.find(m => m.id === id)?.delivery?.state === 'sent'

test('a lane\'s notify_joey: one Onsen message by the lane, written before Telegram, delivered', async () => {
  expect(await workOrder(1)).toMatchObject({ rule: 'mesh-board', target: 'lane' })
  expect(await until(() => A('adam.worker.1').length === 1 && sent('adam.worker.1').length === 1, 20000)).toBe(true)
  const w = A('adam.worker.1')[0]!
  expect(w.path).toBe('/messages')
  expect(w.item).toMatchObject({ sender: 'adam.worker.1', direction: 'out', delivery: { client: 'telegram', state: 'pending' } })
  expect(w.item.body).toBe(`〔adam·工作線#1〕\n${BODY('adam.worker.1')}`)
  expect(w.at).toBeLessThanOrEqual(sent('adam.worker.1')[0]!.at)
  expect(w.item.thread).toBe(String(sent('adam.worker.1')[0]!.body.message_thread_id))           // its topic, as the Telegram message's
  expect(await until(() => delivered(w.id), 5000)).toBe(true)
  expect(onsen.reports('lanes', w.id)[0]!.body.client_msg_ids.length).toBe(1)
  await Bun.sleep(300)
  expect(A('adam.worker.1').length).toBe(1)                                         // no second record of it (the transformer did not record the send)
  expect(onsen.seen.filter(s => s.path === '/messages/batch').flatMap(s => s.body.items).filter((i: any) => String(i.body).includes('adam.worker.1') && i.direction === 'out')).toEqual([])
  expect(JSON.parse(readFileSync(join(root, 'said-adam.worker.1'), 'utf8')).result.content[0].text).toMatch(/^sent to Joey \(message_id \d+/)
}, 40000)

test('a router notice (peer flood): one Onsen message by `router`, delivered', async () => {
  await route({ id: 'mesh-eve-1', from: 'eve', line: 'mail', text: '第一件事：幫我看報表' })
  await route({ id: 'mesh-eve-2', from: 'eve', line: 'mail', text: '第二件事：另一份報表' })
  expect(await until(() => A('流量管制').length === 1 && sent('流量管制').length === 1, 15000)).toBe(true)
  const w = A('流量管制')[0]!
  expect(w.item).toMatchObject({ sender: 'router', direction: 'out', delivery: { client: 'telegram', state: 'pending' } })
  expect(w.item.body.startsWith('〔adam·分流器〕\n〔流量管制〕eve')).toBe(true)
  expect(await until(() => delivered(w.id), 5000)).toBe(true)
  expect(A('流量管制').length).toBe(1)
}, 30000)

test('a lane\'s line while Telegram fails: the lane hears 已寫進 Onsen…會再送 (said, not owed again); Telegram gets it once back; one Onsen message', async () => {
  api.fail.fn = (m, b) => (m === 'sendRichMessage' || m === 'sendMessage') && JSON.stringify(b).includes('adam.worker.2'); api.fail.code = 502; api.fail.desc = 'Bad Gateway'
  try {
    expect(await workOrder(2)).toMatchObject({ target: 'lane' })
    expect(await until(() => { try { readFileSync(join(root, 'said-adam.worker.2')); return true } catch { return false } }, 20000)).toBe(true)
    const said = JSON.parse(readFileSync(join(root, 'said-adam.worker.2'), 'utf8')).result
    expect(said.isError ?? false).toBe(false)
    expect(said.content[0].text.startsWith('已寫進 Onsen（網頁看得到）；Telegram 還沒送到：')).toBe(true)
    expect(A('adam.worker.2').length).toBe(1)
    expect(d.log()).not.toContain('push to Joey failed')
  } finally { api.fail.fn = null; api.fail.code = undefined; api.fail.desc = undefined }
  const w = A('adam.worker.2')[0]!
  expect(await until(() => delivered(w.id), 8000)).toBe(true)
  expect(A('adam.worker.2').length).toBe(1)
}, 40000)
