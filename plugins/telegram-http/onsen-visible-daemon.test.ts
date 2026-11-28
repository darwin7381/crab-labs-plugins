import { test, expect, afterAll, beforeAll } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { personRow, queuedTags, startTgDaemon, until, freePort, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const TOKEN = 'fixture-member'
let apiOn: BotApiMock, on: TgDaemon, onsenPort: number
let up: ReturnType<typeof Bun.serve>
const got: Array<{ method: string; path: string; body: any }> = []
function startOnsen(): void {
  up = Bun.serve({ port: onsenPort, hostname: '127.0.0.1', idleTimeout: 60, async fetch(req) {
    const u = new URL(req.url), path = u.pathname.replace(/^\/api\/onsen/, '')
    const auth = req.headers.get('authorization')
    if (auth !== 'Bearer ' + TOKEN) return Response.json({}, { status: 401 })
    const body = req.method === 'POST' ? await req.json() : undefined
    got.push({ method: req.method, path, body })
    if (path === '/v1/messages' && req.method === 'POST') return Response.json({ data: { message_id: 'reply-9002', conversation_id: body.conversation_id, delivery: 'sent' } })
    if (path === '/forms/close') {                                    // WO-153: Onsen 0.8.3's answers (the daemon only passes them on)
      if (body.id === 777) return Response.json({ id: 777, closed: true })
      if (body.id === 778) return Response.json({ id: 778, closed: true, already: true })
      if (body.id === 779) return Response.json({ error: 'not yours' }, { status: 403 })
      return Response.json({ error: 'no such open form' }, { status: 404 })
    }
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
  apiOn = startBotApiMock()
  onsenPort = await freePort()
  startOnsen()
  const root = mkdtempSync(join(tmpdir(), 'onsen-forms-'))
  on = await startTgDaemon(apiOn, root, JOEY, { ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, FIXTURE_MEMBER_TOKEN: TOKEN })
})
afterAll(async () => { await on?.stop(); apiOn?.stop(); up?.stop(true) })

test('a form answer is queued once from the waiting Item with its original fields', async () => {
  const row = personRow(on, { message_id: 'form-msg-9001', form_id: 'ab51', conversation_id: 'c1', chat: String(JOEY),
    from: 'joey', title: '選方案', body: '{"choice":"B","note":"快"}', sent_at: new Date().toISOString() })
  const tags = () => queuedTags(on).filter(x => x.meta.message_id === 'form-form-msg-9001')
  expect(await until(() => tags().length === 1)).toBe(true)
  expect(tags()[0]).toMatchObject({ content: 'choice: B\nnote: 快', meta: { via: 'web-form', form_title: '選方案', form_id: 'ab51', chat_id: String(JOEY) } })
  expect(row.state).toBe('waiting')
  expect(apiOn.calls).toEqual([])
  expect(got.some(x => ['/forms/inbox', '/forms/ack', '/deliveries/batch'].includes(x.path))).toBe(false)
})

test('a page-only form keeps its opaque conversation and original message ID through the reply tool', async () => {
  const row = personRow(on, { message_id: 'message-a9', form_id: 'form-x9', conversation_id: 'room-c7',
    from: 'joey', title: '選方案', body: '{"choice":"B"}' })
  const ref = 'form-message-a9', chat = 'onsen:room-c7'
  expect(await until(() => queuedTags(on).some(t => t.meta.chat_id === chat && t.meta.message_id === ref))).toBe(true)
  const reply = await on.call('reply', { chat_id: chat, text: '收到 B', reply_to: ref })
  expect(reply.isError).toBe(false)
  expect(got.findLast(r => r.path === '/v1/messages')?.body).toMatchObject({ conversation_id: 'room-c7', reply_to_message_id: 'message-a9' })
  expect(got.some(r => r.path.includes('/by-client-id/'))).toBe(false)
  expect(row.state).toBe('waiting')
})

test('WO-153 form_close: listed with recording on, its answer is Onsen\'s (closed, already, 404, 403), a call without id or url never reaches Onsen; recording off: not listed', async () => {
  const c = await connect(on, [])
  const tools = (await c.listTools()).tools
  const fc = tools.find(t => t.name === 'form_close')!
  expect(fc).toBeDefined()
  const { FORM_CLOSE_DESC } = await import('./onsen-tool.ts')
  expect(fc.description).toBe(FORM_CLOSE_DESC)
  const closes = () => got.filter(g => g.path === '/forms/close')
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
  const c = await connect(on, [])
  const F = `http://127.0.0.1:${onsenPort}/api/onsen/v1/files`
  const row = personRow(on, { message_id: '9101', from: 'joey', conversation_id: 'c1', via: 'web',
    client: { chat: String(JOEY), msg_id: 'form-9101' }, text: '看這兩張\n〔圖片 a.png〕〔檔案 notes.md〕〔圖片 c.png〕',
    attachments: [{ kind: 'photo', name: 'a.png', mime: 'image/png', bytes: 5, url: `${F}/21` }, { kind: 'document', name: 'notes.md', mime: 'text/markdown', bytes: 16, url: `${F}/11` },
      { kind: 'photo', name: 'c.png', mime: 'image/png', bytes: 5, url: `${F}/403` }] })
  const message = () => queuedTags(on).find(x => x.meta.message_id === 'form-9101')
  expect(await until(() => !!message())).toBe(true)
  const m = message()!
  expect(m.content).toBe('看這兩張\n〔圖片 a.png〕〔檔案 notes.md〕〔圖片 c.png〕')                      // the preview words stay
  expect(m.meta).toMatchObject({ via: 'onsen', media_group_count: '3', attachment_kind_2: 'document', attachment_file_id_2: 'onsen:11', attachment_name_2: 'notes.md',
    attachment_mime_2: 'text/markdown', image_error_3: 'HTTP 403', attachment_file_id_3: 'onsen:403', attachment_kind_3: 'photo' })
  expect(m.meta.image_path.startsWith(join(on.stateDir, 'inbox'))).toBe(true)
  expect([...readFileSync(m.meta.image_path)]).toEqual([0x89, 0x50, 0x4e, 0x47, 21])
  expect(got.filter(g => g.path.startsWith('/v1/files/')).map(g => g.path).sort()).toEqual(['/v1/files/11', '/v1/files/21', '/v1/files/403'])
  const d = await call(c, 'download_attachment', { file_id: 'onsen:11' })
  expect(d.isError).toBe(false)
  expect(readFileSync(d.text, 'utf8')).toBe('# 筆記\n第二行')
  const bad = await call(c, 'download_attachment', { file_id: 'onsen:403' })                      // the retry: Onsen still refuses
  expect(bad.isError).toBe(true)
  expect(bad.text).toContain('HTTP 403')
  expect(row.state).toBe('waiting')
  await c.close()
}, 60000)
