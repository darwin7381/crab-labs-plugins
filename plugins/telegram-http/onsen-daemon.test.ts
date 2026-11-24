// Onsen (WO-139): a real Telegram daemon (server.ts) against the Bot API stand-in and a stand-in Onsen (a local HTTP server; nothing reaches core.kbro.ai).
// Joey's message, the main's reply (two parts), its edit, a failed send; chat_history listed and answered; Onsen down across a daemon restart: nothing lost,
// nothing twice; the daemon never sends Telegram anything different because of Onsen.
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, dm, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, freePort, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const CRED = 'mesh_DAEMONTESTsecretSECRETsecret0123456789'
type Got = { method: string; path: string; auth: string; via: string; body: any }
let api: BotApiMock, d: TgDaemon, root: string, onsenPort: number, env: Record<string, string>
const got: Got[] = []
const store = new Map<string, any>()
let up: ReturnType<typeof Bun.serve> | null = null
let next = 1
function startOnsen(): void {
  up = Bun.serve({ port: onsenPort, hostname: '127.0.0.1', async fetch(req) {
    const u = new URL(req.url), path = u.pathname.replace(/^\/api\/onsen/, '')
    const body = req.method === 'POST' ? await req.json() : undefined
    got.push({ method: req.method, path: path + u.search, auth: req.headers.get('authorization') ?? '', via: req.headers.get('x-onsen-via') ?? '', body })
    if (req.headers.get('authorization') !== `Bearer ${CRED}`) return Response.json({ error: 'auth' }, { status: 401 })
    const keep = (it: any) => { const was = store.get(it.idem_key); if (was) return { id: was.id, duplicate: true }; const row = { ...it, id: next++ }; store.set(it.idem_key, row); return { id: row.id, duplicate: false } }
    if (path === '/messages/batch') return Response.json({ results: body.items.map(keep) })
    if (path === '/events') return Response.json({ ...keep(body), message_id: 1 })
    if (path === '/messages' && req.method === 'GET') {
      const rows = [...store.values()].filter(r => r.direction).sort((a, b) => b.id - a.id)
      return Response.json({ messages: rows.map(r => ({ id: r.id, at: r.sent_at, direction: r.direction, sender: r.sender === `tg:${JOEY}` ? 'joey' : r.sender, kind: r.kind,
        body: r.body.slice(0, 300), truncated: r.body.length > 300, edited: false, client_msg_id: r.client_msg_id, status: r.status, chat: r.chat })), total: rows.length })
    }
    return Response.json({ error: 'no route' }, { status: 404 })
  } })
}
const items = () => got.filter(g => g.path === '/messages/batch').flatMap(g => g.body.items)
const evs = () => got.filter(g => g.path === '/events').map(g => g.body)

beforeAll(async () => {
  api = startBotApiMock({}, { pollHoldMs: 300 })
  root = mkdtempSync(join(tmpdir(), 'onsen-daemon-'))
  onsenPort = await freePort()
  mkdirSync(join(root, 'cred'), { recursive: true })
  writeFileSync(join(root, 'cred', 'mesh-credential'), CRED + '\n')
  env = { GENESIS_LANES: '0', ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'mesh-credential') }
  startOnsen()
  d = await startTgDaemon(api, root, JOEY, env)
}, 40000)
afterAll(async () => { await d?.stop(); api?.stop(); up?.stop(true) })

test('Joey\'s message is one `in` item: sender tg:<id>, idem_key tg:<agent>:<chat>:in:<message_id>', async () => {
  api.push(dm(JOEY, 2166, '先記這一則'))
  expect(await until(() => items().some(i => i.client_msg_id === '2166'), 10000)).toBe(true)
  const it = items().find(i => i.client_msg_id === '2166')
  expect(it).toMatchObject({ idem_key: `tg:adam:${JOEY}:in:2166`, agent: 'adam', client: 'telegram', chat: String(JOEY), direction: 'in', sender: `tg:${JOEY}`, body: '先記這一則', kind: 'text', status: 'ok' })
  expect(got.find(g => g.path === '/messages/batch')!.auth).toBe(`Bearer ${CRED}`)
}, 15000)

test('the main\'s reply (two parts) is two `out` items from main with part 1/2, 2/2; its edit is an edit event; what Telegram got is unchanged', async () => {
  const text = `${'甲'.repeat(3000)}\n\n${'乙'.repeat(3000)}`
  const r = await d.call('reply', { chat_id: String(JOEY), text, reply_to: '2166' })
  expect(r.isError).toBe(false)
  const ids = r.text.match(/ids: (\d+), (\d+)/)!.slice(1)
  expect(await until(() => ids.every(id => items().some(i => i.client_msg_id === id)), 10000)).toBe(true)
  const parts = ids.map(id => items().find(i => i.client_msg_id === id))
  expect(parts[0]).toMatchObject({ direction: 'out', sender: 'main', kind: 'rich', idem_key: `tg:adam:${JOEY}:out:${ids[0]}`, reply_to_client_msg_id: '2166', meta: { part: 1, parts: 2 } })
  expect(parts[1]).toMatchObject({ sender: 'main', meta: { part: 2, parts: 2 } })
  expect(parts[0].body + '\n\n' + parts[1].body).toBe(text)
  const sent = api.of('sendRichMessage').slice(-2)
  expect(sent.map(c => c.body.rich_message.markdown)).toEqual([parts[0].body, parts[1].body])
  const e = await d.call('edit_message', { chat_id: String(JOEY), message_id: ids[0]!, text: '改成這樣' })
  expect(e.isError).toBe(false)
  expect(await until(() => evs().some(x => x.kind === 'edit'), 10000)).toBe(true)
  expect(evs().find(x => x.kind === 'edit')).toMatchObject({ agent: 'adam', chat: String(JOEY), target_client_msg_id: ids[0], actor: 'main', body: '改成這樣' })
}, 20000)

test('a send Telegram refuses is one failed item (out-failed key, the error), and the tool still fails as before', async () => {
  api.fail.fn = m => m === 'sendMessage'
  const r = await d.call('reply', { chat_id: String(JOEY), text: 'plain fails', format: 'text' })
  api.fail.fn = null
  expect(r.isError).toBe(true)
  expect(await until(() => items().some(i => i.status === 'failed'), 10000)).toBe(true)
  const f = items().find(i => i.status === 'failed')
  expect(f.idem_key).toMatch(new RegExp(`^tg:adam:${JOEY}:out-failed:`)); expect(f.body).toBe('plain fails'); expect(f.error).toContain('400')
  // a rich send that falls back to plain is ONE message (the plain one), not a failed one plus a sent one
  api.fail.fn = m => m === 'sendRichMessage'
  const n0 = items().length
  const ok = await d.call('reply', { chat_id: String(JOEY), text: 'rich falls back' })
  api.fail.fn = null
  expect(ok.isError).toBe(false)
  expect(await until(() => items().length > n0, 10000)).toBe(true)
  await Bun.sleep(300)
  expect(items().slice(n0).map(i => [i.status, i.kind, i.body])).toEqual([['ok', 'text', 'rich falls back']])
}, 20000)

test('chat_history is listed for the main and answers from Onsen, oldest first, with the tool header', async () => {
  const tools = await (await d.client()).listTools()
  expect(tools.tools.map(t => t.name)).toContain('chat_history')
  const r = await d.call('chat_history', { limit: 50 })
  expect(r.isError).toBe(false)
  const lines = r.text.split('\n')
  expect(lines[0]).toMatch(/｜Joey｜#\d+ tg:2166｜先記這一則$/)
  expect(r.text).toContain('｜main｜')
  expect(lines.at(-1)).toMatch(/^共 \d+ 則，顯示 \d+ 則$/)
  expect(got.filter(g => g.path.startsWith('/messages?')).every(g => g.via === 'tool')).toBe(true)
}, 15000)

test('Onsen down across a daemon restart: what was said meanwhile is kept, sent once Onsen is back, and nothing is sent twice', async () => {
  up!.stop(true); up = null
  api.push(dm(JOEY, 2200, 'Onsen 停的時候說的'))
  const r = await d.call('reply', { chat_id: String(JOEY), text: '停的時候回的' })
  expect(r.isError).toBe(false)                                            // Telegram is not affected
  // chat_history answers from the local spool meanwhile
  let local = { text: '' }
  expect(await until(async () => (local = await d.call('chat_history', {})).text.includes('Onsen 停的時候說的'), 10000)).toBe(true)
  expect(local.text).toContain('本機暫存'); expect(local.text).toContain('停的時候回的')
  await d.stop()
  d = await startTgDaemon(api, root, JOEY, env)
  startOnsen()
  expect(await until(() => items().some(i => i.client_msg_id === '2200') && items().some(i => i.body === '停的時候回的'), 20000)).toBe(true)
  await Bun.sleep(500)
  const keys = items().map(i => i.idem_key)
  const unique = new Set([...store.keys()])
  expect(store.size).toBe(unique.size)
  // every message the store holds was kept once (a resend after the restart would be a duplicate: the store dedupes, and nothing new appears)
  expect(keys.filter(k => k === `tg:adam:${JOEY}:in:2200`).length).toBeGreaterThanOrEqual(1)
  expect([...store.values()].filter(r => r.client_msg_id === '2200').length).toBe(1)
  const h = await fetch(`http://127.0.0.1:${d.port}/healthz`).then(x => x.json()) as any
  expect(h.onsen.record).toBe(true); expect(h.onsen.pending_bytes).toBe(0)
  expect(d.log()).not.toContain(CRED)
}, 60000)
