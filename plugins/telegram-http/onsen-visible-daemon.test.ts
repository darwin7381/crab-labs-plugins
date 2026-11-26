// WO-145 end to end: real Telegram daemons (server.ts, lanes off) against their own Bot API stand-ins and one stand-in Onsen (a local HTTP server;
// nothing reaches core.kbro.ai or Telegram), in temp dirs (their HOME too).
//   on  (ONSEN_REACT_SEEN, ONSEN_STATUS_PIN, ONSEN_FORM_LINKS = adam): the pinned status (sent and pinned silently, edited on a change ≥ 5 s apart, line 2
//       from the facts, recorded as system:status's); ✍ when the parked message enters a turn (WO-165: the transcript shows it; written into the
//       session alone is in_session and leaves it; recorded as system:seen's); a reply's page
//       link keyed on Telegram and recorded without the key; a page answer from the inbox to the session (via web-form, form-<id>), echoed silently
//       (system:form-echo), acked, its facts; a reply_to form-<id> threads under the echo; the status message deleted → off, a marker file
//   off (no switch): the same steps change nothing: no ✍, no status message, no getChat / pin, the link as written, no /forms or /forms/inbox call
//   lanes on (ONSEN_FORM_LINKS = adam): a page answer goes to the main through the lanes (route rule web-form, an M1 item of kind joey), echoed, acked
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startBotApiMock, dm, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, freePort, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const CRED_ON = 'mesh_VISIBLEonSECRETsecretSECRETsecret01', CRED_OFF = 'mesh_VISIBLEoffSECRETsecretSECRETsecret0', CRED_LANES = 'mesh_VISIBLElanesSECRETsecretSECRETsecr'
let apiOn: BotApiMock, apiOff: BotApiMock, apiLanes: BotApiMock, on: TgDaemon, off: TgDaemon, lanes: TgDaemon, onsenPort: number
let up: ReturnType<typeof Bun.serve> | null = null
type Who = 'on' | 'off' | 'lanes'
type Got = { who: Who; method: string; path: string; body: any; at: number }
const got: Got[] = []
const inbox: Array<{ for: Who; id: number; form_id: number; chat: string; title: string; body: string; at: string; acked?: boolean }> = []
let next = 1, nform = 0
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function startOnsen(): void {
  up = Bun.serve({ port: onsenPort, hostname: '127.0.0.1', idleTimeout: 60, async fetch(req) {
    const u = new URL(req.url), path = u.pathname.replace(/^\/api\/onsen/, '')
    const auth = req.headers.get('authorization')
    const who: Who | null = auth === `Bearer ${CRED_ON}` ? 'on' : auth === `Bearer ${CRED_OFF}` ? 'off' : auth === `Bearer ${CRED_LANES}` ? 'lanes' : null
    if (!who) return Response.json({ error: 'auth' }, { status: 401 })
    const body = req.method === 'POST' ? await req.json() : undefined
    got.push({ who, method: req.method, path, body, at: Date.now() })
    if (path === '/messages/batch' || path === '/deliveries/batch' || path === '/status/batch') return Response.json({ results: body.items.map(() => ({ id: next++, duplicate: false })) })
    if (path === '/events') return Response.json({ id: next++, duplicate: false })
    if (path === '/forms' && req.method === 'POST') { nform++; return Response.json({ id: 500 + nform, key: `onsenform_TEST${nform}-k_y`, expires_at: '2026-12-02T00:00:00Z' }) }
    if (path === '/forms/inbox') {
      const end = Date.now() + Number(u.searchParams.get('wait') ?? 0) * 1000
      const mine = () => inbox.filter(i => i.for === who && !i.acked)
      while (Date.now() < end && !mine().length) await sleep(50)
      return Response.json({ agent: 'adam', items: mine().map(({ acked, for: _f, ...i }) => i) })
    }
    if (path === '/forms/close') {                                    // WO-153: Onsen 0.8.3's answers (the daemon only passes them on)
      if (body.id === 777) return Response.json({ id: 777, closed: true })
      if (body.id === 778) return Response.json({ id: 778, closed: true, already: true })
      if (body.id === 779) return Response.json({ error: 'not yours' }, { status: 403 })
      return Response.json({ error: 'no such open form' }, { status: 404 })
    }
    if (path === '/forms/ack') { let n = 0; for (const i of inbox) if (i.for === who && body.ids.includes(i.id) && !i.acked) { i.acked = true; n++ } return Response.json({ acked: n }) }
    // WO-189: Onsen's files (GET /v1/files/<id>, File.url): this agent's credential; 403 for one it may not see
    const fm = /^\/v1\/files\/(\d+)$/.exec(path)
    if (fm && req.method === 'GET') {
      if (fm[1] === '403') return Response.json({ error: 'not_authorized' }, { status: 403 })
      if (fm[1] === '11') return new Response('# 筆記\n第二行', { headers: { 'content-type': 'text/markdown' } })
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, Number(fm[1])]), { headers: { 'content-type': 'image/png' } })
    }
    return Response.json({ error: 'no route' }, { status: 404 })
  } })
}
const msgs = (who: Who) => got.filter(g => g.who === who && g.path === '/messages/batch').flatMap(g => g.body.items)
const evs = (who: Who) => got.filter(g => g.who === who && g.path === '/events').map(g => g.body)
const facts = (who: Who, id: string) => got.filter(g => g.who === who && g.path === '/deliveries/batch').flatMap(g => g.body.items)
  .filter((f: any) => f.client_msg_id === id).map((f: any) => `${f.state}${f.by ? `:${f.by}` : ''}`)
/** WO-165: Claude Code takes a message into a turn: its user record in the main's transcript (the daemon's TurnWatch reads it; seen comes from it) */
function takeIn(d: TgDaemon, id: string, extra = ''): void {
  const dir = join(d.home, '.claude', 'projects', d.ws.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const f = join(dir, 'main-session.jsonl')
  const tag = `<channel source="plugin:telegram-http:telegram-http" chat_id="${JOEY}" message_id="${id}" user="joey" user_id="${JOEY}"${extra} ts="x">`
  writeFileSync(f, JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: `${tag}\nx\n</channel>` }, timestamp: new Date().toISOString() }) + '\n', { flag: 'a' })
}

async function connect(d: TgDaemon, got: Array<{ content: string; meta: any }>): Promise<Client> {
  const c = new Client({ name: 'onsen-vis-test', version: '0' }, { capabilities: {} })
  c.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') got.push({ content: String((n.params as any)?.content ?? ''), meta: (n.params as any)?.meta ?? {} }) }
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${d.port}/mcp`)))
  return c
}
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const r: any = await c.callTool({ name, arguments: args })
  return { text: String(r.content?.[0]?.text ?? ''), isError: r.isError === true }
}

beforeAll(async () => {
  apiOn = startBotApiMock({}, { pollHoldMs: 300 }); apiOff = startBotApiMock({}, { pollHoldMs: 300 }); apiLanes = startBotApiMock({}, { pollHoldMs: 300 })
  onsenPort = await freePort()
  startOnsen()
  const root = mkdtempSync(join(tmpdir(), 'onsen-vis-daemon-'))
  mkdirSync(join(root, 'cred'), { recursive: true })
  writeFileSync(join(root, 'cred', 'on'), CRED_ON + '\n'); writeFileSync(join(root, 'cred', 'off'), CRED_OFF + '\n'); writeFileSync(join(root, 'cred', 'lanes'), CRED_LANES + '\n')
  const base = { ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, GENESIS_LANES: '0', ONSEN_PEER_LOOKUP: '0', ONSEN_CLAUDE_BIN: '/nonexistent/claude' }
  on = await startTgDaemon(apiOn, join(root, 'on'), JOEY, { ...base, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'on'),
    ONSEN_REACT_SEEN: 'adam', ONSEN_STATUS_PIN: 'adam', ONSEN_FORM_LINKS: 'someone-else, adam', ONSEN_STATUS_PIN_HOLD_MS: '0' })
  off = await startTgDaemon(apiOff, join(root, 'off'), JOEY, { ...base, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'off'), ONSEN_FORM_LINKS: 'someone-else' })
  lanes = await startTgDaemon(apiLanes, join(root, 'lanes'), JOEY, { ...base, GENESIS_LANES: '1', ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'lanes'), ONSEN_FORM_LINKS: 'adam' })
}, 90000)
afterAll(async () => { await on?.stop(); await off?.stop(); await lanes?.stop(); apiOn?.stop(); apiOff?.stop(); apiLanes?.stop(); up?.stop(true) })

const L1 = /^⚫ 失連（\d\d:\d\d 起）：沒有 session$/
const URL_TEXT = '## 請選方案\n選好按送出：[打開頁面](https://ops.fud.city/wo/145?a=1#pick)，或 https://example.com/x'

test('on: the pinned status, ✍, a keyed link recorded without the key, a page answer to the session; deleted → off', async () => {
  const pinMsg = () => apiOn.of('sendMessage').find(c => L1.test(String(c.body.text).split('\n')[0]!))
  // the status message: sent silently, pinned silently, recorded as system:status's (the main has no session: offline no_registration)
  expect(await until(() => !!pinMsg() && apiOn.of('pinChatMessage').length > 0, 15000)).toBe(true)
  const sent = pinMsg()!
  expect(sent.body).toMatchObject({ chat_id: String(JOEY), disable_notification: true })
  expect(String(sent.body.text)).toMatch(L1)
  const pinId = Number(apiOn.of('pinChatMessage')[0]!.body.message_id)
  expect(apiOn.of('pinChatMessage')[0]!.body).toMatchObject({ chat_id: String(JOEY), disable_notification: true })
  expect(apiOn.pinned.get(String(JOEY))).toBe(pinId)
  expect(await until(() => msgs('on').some((m: any) => m.sender === 'system:status' && m.client_msg_id === String(pinId) && m.meta?.silent === true), 10000)).toBe(true)
  const tPin = Date.now()
  // Joey's message, no session: parked (delivered, not seen) → line 2, at least 5 s after the send
  apiOn.push(dm(JOEY, 8001, '請看一下'))
  expect(await until(() => facts('on', '8001').includes('delivered'), 10000)).toBe(true)
  expect(await until(() => apiOn.of('editMessageText').some(c => Number(c.body.message_id) === pinId && /\n你傳的：1 則還沒進去$/.test(String(c.body.text))), 15000)).toBe(true)
  const e1 = apiOn.of('editMessageText').find(c => Number(c.body.message_id) === pinId)!
  expect(e1.at - tPin).toBeGreaterThan(4000)
  expect(apiOn.of('setMessageReaction').length).toBe(0)                                  // no 👀 configured, nothing seen yet: no reaction
  // a session opens: the parked message is written into it: in_session by main (WO-165), no ✍ yet; it enters a turn (the transcript shows it): seen by
  // main → ✍ on it, recorded as system:seen's
  const inbound: Array<{ content: string; meta: any }> = []
  const c = await connect(on, inbound)
  expect(await until(() => inbound.some(x => x.meta.message_id === '8001'), 15000)).toBe(true)
  expect(await until(() => facts('on', '8001').includes('in_session:main'), 10000)).toBe(true)
  await sleep(1500)
  expect(facts('on', '8001')).toEqual(['delivered', 'in_session:main'])
  expect(apiOn.of('setMessageReaction').length).toBe(0)
  takeIn(on, '8001')
  expect(await until(() => facts('on', '8001').includes('seen:main'), 10000)).toBe(true)
  expect(await until(() => apiOn.of('setMessageReaction').length === 1, 5000)).toBe(true)
  expect(apiOn.of('setMessageReaction')[0]!.body).toMatchObject({ chat_id: String(JOEY), message_id: 8001, reaction: [{ type: 'emoji', emoji: '✍' }] })
  expect(apiOn.of('setMessageReaction')[0]!.body.is_big).toBeFalsy()
  expect(await until(() => evs('on').some(e => e.kind === 'reaction' && e.actor === 'system:seen' && e.target_client_msg_id === '8001' && e.data?.emoji === '✍'), 10000)).toBe(true)
  expect(await until(() => apiOn.of('editMessageText').some(c => Number(c.body.message_id) === pinId && /\n你傳的：1 則看到了還沒回$/.test(String(c.body.text))), 15000)).toBe(true)
  // the agent reacts itself: its reaction stands (no ✍ over it)
  expect((await call(c, 'react', { chat_id: String(JOEY), message_id: '8001', emoji: '👍' })).isError).toBe(false)
  await sleep(300)
  expect(apiOn.of('setMessageReaction').map(x => x.body.reaction[0].emoji)).toEqual(['✍', '👍'])
  // the main's reply with a page link: Telegram gets the key (before the #fragment, after the query), Onsen records the text as written
  const r = await call(c, 'reply', { chat_id: String(JOEY), text: URL_TEXT })
  expect(r.isError).toBe(false)
  const form = got.find(g => g.who === 'on' && g.path === '/forms')!
  expect(form.body).toEqual({ chat: String(JOEY), title: '選好按送出：打開頁面，或', url: 'https://ops.fud.city/wo/145?a=1#pick' })   // WO-153: the link as written, no key
  const tg = apiOn.of('sendRichMessage').at(-1)!.body.rich_message.markdown
  expect(tg).toBe('## 請選方案\n選好按送出：[打開頁面](https://ops.fud.city/wo/145?a=1&k=onsenform_TEST1-k_y#pick)，或 https://example.com/x')
  expect(await until(() => msgs('on').some((m: any) => m.sender === 'main' && m.body === URL_TEXT), 10000)).toBe(true)
  expect(JSON.stringify(got.filter(g => g.path === '/messages/batch' || g.path === '/events'))).not.toContain('onsenform_TEST1')
  expect(on.log()).not.toContain('onsenform_TEST1')
  // answered: line 2 goes
  expect(await until(() => apiOn.of('editMessageText').some(c => Number(c.body.message_id) === pinId && L1.test(String(c.body.text))), 15000)).toBe(true)
  // a page answer: into the session as Joey's message (via web-form, form-<id>), echoed silently, acked; its facts
  inbox.push({ for: 'on', id: 9001, form_id: 501, chat: String(JOEY), title: '選方案', body: '{"choice":"B","note":"快"}', at: new Date().toISOString() })
  expect(await until(() => inbound.some(x => x.meta.message_id === 'form-9001'), 30000)).toBe(true)
  const fa = inbound.find(x => x.meta.message_id === 'form-9001')!
  expect(fa.content).toBe('choice: B\nnote: 快')
  expect(fa.meta).toMatchObject({ chat_id: String(JOEY), via: 'web-form', form_title: '選方案', form_id: '501', user_id: String(JOEY) })
  expect(await until(() => inbox.find(i => i.id === 9001)!.acked === true, 10000)).toBe(true)
  const echo = apiOn.of('sendMessage').find(c => String(c.body.text).startsWith('〔你在頁面送出的｜選方案〕'))!
  expect(echo.body).toMatchObject({ chat_id: String(JOEY), text: '〔你在頁面送出的｜選方案〕\nchoice: B\nnote: 快', disable_notification: true })
  expect(await until(() => msgs('on').some((m: any) => m.sender === 'system:form-echo' && m.meta?.silent === true), 10000)).toBe(true)
  expect(await until(() => facts('on', 'form-9001').join(',') === 'delivered,in_session:main', 10000)).toBe(true)
  takeIn(on, 'form-9001', ' via="web-form" form_title="選方案" form_id="501"')
  expect(await until(() => facts('on', 'form-9001').join(',') === 'delivered,in_session:main,seen:main', 10000)).toBe(true)
  expect(apiOn.of('setMessageReaction').length).toBe(2)                                  // no ✍ for a page answer (no Telegram message)
  // the main answers it: reply_to form-9001 threads under the echo on Telegram
  const echoId = Number(msgs('on').find((m: any) => m.sender === 'system:form-echo')!.client_msg_id)
  expect((await call(c, 'reply', { chat_id: String(JOEY), text: '收到 B', reply_to: 'form-9001' })).isError).toBe(false)
  const rr = apiOn.of('sendRichMessage').at(-1)!.body
  expect(rr.rich_message.markdown).toBe('收到 B')
  expect(rr.reply_parameters).toMatchObject({ message_id: echoId })
  expect((await call(c, 'react', { chat_id: String(JOEY), message_id: 'form-9001', emoji: '👍' })).isError).toBe(false)
  expect(apiOn.of('setMessageReaction').at(-1)!.body).toMatchObject({ message_id: echoId, reaction: [{ type: 'emoji', emoji: '👍' }] })
  // the status message deleted by Joey: the next edit is refused → off (a marker), nothing more in that chat
  apiOn.deleted.add(pinId)
  apiOn.push(dm(JOEY, 8002, '再一則'))                                                      // line 2 changes
  const marker = join(on.stateDir, 'onsen', `status-pin-off-${JOEY}.json`)
  expect(await until(() => existsSync(marker), 20000)).toBe(true)
  expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ why: 'deleted', message_id: pinId })
  const n = apiOn.calls.filter(x => ['editMessageText', 'getChat', 'pinChatMessage'].includes(x.method)).length
  apiOn.push(dm(JOEY, 8003, '第三則'))
  await sleep(6500)
  expect(apiOn.calls.filter(x => ['editMessageText', 'getChat', 'pinChatMessage'].includes(x.method)).length).toBe(n)
  expect(apiOn.of('sendMessage').filter(c => L1.test(String(c.body.text).split('\n')[0]!)).length).toBe(1)   // never a second status message
  const h = await fetch(`http://127.0.0.1:${on.port}/healthz`).then(r => r.json()) as any
  // WO-165: 8002 and 8003 reached the session and never entered a turn (no transcript record): in_session, no ✍ (until 1.56.0: ✍ on both)
  expect(facts('on', '8003')).toEqual(['delivered', 'in_session:main'])
  expect(h.onsen.status).toMatchObject({ react_seen: { reacted: 1, skipped_agent: 0, refused: false }, status_pin: { sent: 1, stopped: 1 }, forms: { delivered: 1, acked: 1 } })
  await c.close()
}, 120000)

test('off: the same steps change nothing (no ✍, no status message, no pin / getChat, the link as written, no forms call)', async () => {
  apiOff.push(dm(JOEY, 8601, '請看一下'))
  expect(await until(() => facts('off', '8601').includes('delivered'), 10000)).toBe(true)
  const inbound: Array<{ content: string; meta: any }> = []
  const c = await connect(off, inbound)
  expect(await until(() => inbound.some(x => x.meta.message_id === '8601'), 15000)).toBe(true)
  takeIn(off, '8601')
  expect(await until(() => facts('off', '8601').includes('seen:main'), 10000)).toBe(true)
  expect((await call(c, 'reply', { chat_id: String(JOEY), text: URL_TEXT })).isError).toBe(false)
  expect(apiOff.of('sendRichMessage').at(-1)!.body.rich_message.markdown).toBe(URL_TEXT)
  await sleep(1500)
  expect(apiOff.calls.map(x => x.method).filter(m => !['getMe', 'deleteWebhook', 'setMyCommands', 'sendChatAction', 'getMyCommands', 'setMyDescription', 'setChatMenuButton'].includes(m)))
    .toEqual(['sendRichMessage'])
  expect(got.filter(g => g.who === 'off' && g.path.startsWith('/forms')).length).toBe(0)
  expect(msgs('off').filter((m: any) => m.direction === 'out').map((m: any) => m.sender)).toEqual(['main'])
  expect(evs('off').length).toBe(0)
  const h = await fetch(`http://127.0.0.1:${off.port}/healthz`).then(r => r.json()) as any
  expect(h.onsen.status.react_seen).toBeUndefined(); expect(h.onsen.status.status_pin).toBeUndefined(); expect(h.onsen.status.forms).toBeUndefined()
  expect(existsSync(join(off.stateDir, 'onsen', 'status-pin.json'))).toBe(false)
  await c.close()
}, 60000)

test('lanes on: a page answer goes to the main through the lanes (rule web-form, an M1 item of kind joey), echoed silently, acked', async () => {
  inbox.push({ for: 'lanes', id: 9101, form_id: 601, chat: String(JOEY), title: '排程', body: '週四 10:00', at: new Date().toISOString() })
  expect(await until(() => inbox.find(i => i.id === 9101)!.acked === true, 30000)).toBe(true)
  const jl = (f: string) => { try { return readFileSync(join(lanes.ws, '.lanes', f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
  expect(jl('routing.jsonl').filter(r => r.event === `tg-${JOEY}-form-9101`)).toEqual([expect.objectContaining({ rule: 'web-form', target: 'main', lane: null })])
  const journal = (() => { try { return readFileSync(join(lanes.stateDir, 'lanes', 'state.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } })()
  const item = journal.find(r => r.rec === 'msg' && r.notif?.params?.meta?.message_id === 'form-9101')
  expect(item).toMatchObject({ kind: 'joey', state: 'queued', notif: { params: { content: '週四 10:00', meta: { via: 'web-form', form_title: '排程', form_id: '601' } } } })
  expect(await until(() => facts('lanes', 'form-9101').includes('delivered'), 10000)).toBe(true)
  expect(apiLanes.of('sendMessage').find(c => String(c.body.text).startsWith('〔你在頁面送出的｜排程〕'))!.body).toMatchObject({ text: '〔你在頁面送出的｜排程〕\n週四 10:00', disable_notification: true })
  expect(apiLanes.of('setMessageReaction').length).toBe(0)                               // ONSEN_REACT_SEEN off here
  expect(apiLanes.of('pinChatMessage').length).toBe(0)                                   // ONSEN_STATUS_PIN off here
}, 60000)

test('WO-153 form_close: listed with recording on, its answer is Onsen\'s (closed, already, 404, 403), a call without id or url never reaches Onsen; recording off: not listed', async () => {
  const c = await connect(on, [])
  const tools = (await c.listTools()).tools
  const fc = tools.find(t => t.name === 'form_close')!
  expect(fc).toBeDefined()
  const { FORM_CLOSE_DESC } = await import('./onsen-tool.ts')
  expect(fc.description).toBe(FORM_CLOSE_DESC)
  const closes = () => got.filter(g => g.who === 'on' && g.path === '/forms/close')
  const r1 = await call(c, 'form_close', { id: 777, reason: '已經在 Telegram 回答了' })
  expect(r1).toEqual({ text: '{"id":777,"closed":true}', isError: false })
  expect(closes().at(-1)!.body).toEqual({ id: 777, reason: '已經在 Telegram 回答了' })
  expect(await call(c, 'form_close', { id: 778 })).toEqual({ text: '{"id":778,"closed":true,"already":true}', isError: false })
  const r404 = await call(c, 'form_close', { url: 'https://ops.fud.city/wo/145?a=1#pick' })
  expect(r404.isError).toBe(true); expect(r404.text).toContain('no such open form (404)')
  expect(closes().at(-1)!.body).toEqual({ url: 'https://ops.fud.city/wo/145?a=1#pick' })
  const r403 = await call(c, 'form_close', { id: 779 })
  expect(r403.isError).toBe(true); expect(r403.text).toContain('not your form (403)')
  const n = closes().length
  const r0 = await call(c, 'form_close', { reason: 'x' })
  expect(r0.isError).toBe(true); expect(closes().length).toBe(n)
  await c.close()
  // recording off for the agent (ONSEN_RECORD=0): the tool is not listed
  const api0 = startBotApiMock({}, { pollHoldMs: 300 })
  const root0 = mkdtempSync(join(tmpdir(), 'onsen-vis-norec-'))
  const d0 = await startTgDaemon(api0, root0, JOEY, { ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, GENESIS_LANES: '0', ONSEN_RECORD: '0', ONSEN_CLAUDE_BIN: '/nonexistent/claude' })
  try {
    const c0 = await connect(d0, [])
    expect((await c0.listTools()).tools.some(t => t.name === 'form_close')).toBe(false)
    expect((await c0.listTools()).tools.some(t => t.name === 'chat_history')).toBe(true)
    await c0.close()
  } finally { await d0.stop(); api0.stop() }
}, 60000)

test('WO-189: a message Joey wrote in Onsen with files: each taken with this agent\'s credential; image_path (by position), the .md as the attachment set with onsen:<id> (download_attachment answers it), a picture it may not see: image_error, the text all the same', async () => {
  const inbound: Array<{ content: string; meta: any }> = []
  const c = await connect(on, inbound)
  const F = `http://127.0.0.1:${onsenPort}/api/onsen/v1/files`
  inbox.push({ for: 'on', id: 9101, form_id: 601, chat: String(JOEY), title: '', body: '看這兩張\n〔圖片 a.png〕〔檔案 notes.md〕〔圖片 c.png〕', at: new Date().toISOString(),
    say: true, attachments: [{ kind: 'photo', name: 'a.png', mime: 'image/png', bytes: 5, url: `${F}/21` }, { kind: 'document', name: 'notes.md', mime: 'text/markdown', bytes: 16, url: `${F}/11` },
      { kind: 'photo', name: 'c.png', mime: 'image/png', bytes: 5, url: `${F}/403` }] } as any)
  expect(await until(() => inbound.some(x => x.meta.message_id === 'form-9101'), 30000)).toBe(true)
  const m = inbound.find(x => x.meta.message_id === 'form-9101')!
  expect(m.content).toBe('看這兩張\n〔圖片 a.png〕〔檔案 notes.md〕〔圖片 c.png〕')                      // the preview words stay
  expect(m.meta).toMatchObject({ via: 'onsen', media_group_count: '3', attachment_kind_2: 'document', attachment_file_id_2: 'onsen:11', attachment_name_2: 'notes.md',
    attachment_mime_2: 'text/markdown', image_error_3: 'HTTP 403', attachment_file_id_3: 'onsen:403', attachment_kind_3: 'photo' })
  expect(m.meta.image_path.startsWith(join(on.stateDir, 'inbox'))).toBe(true)
  expect([...readFileSync(m.meta.image_path)]).toEqual([0x89, 0x50, 0x4e, 0x47, 21])
  expect(got.filter(g => g.who === 'on' && g.path.startsWith('/v1/files/')).map(g => g.path).sort()).toEqual(['/v1/files/11', '/v1/files/21', '/v1/files/403'])
  const d = await call(c, 'download_attachment', { file_id: 'onsen:11' })
  expect(d.isError).toBe(false)
  expect(readFileSync(d.text, 'utf8')).toBe('# 筆記\n第二行')
  const bad = await call(c, 'download_attachment', { file_id: 'onsen:403' })                      // the retry: Onsen still refuses
  expect(bad.isError).toBe(true)
  expect(bad.text).toContain('HTTP 403')
  expect(await until(() => inbox.find(i => i.id === 9101)!.acked === true, 10000)).toBe(true)
  await c.close()
}, 60000)
