// Onsen (WO-139, second step): the daemon's other send paths. A real Telegram daemon (lanes off) against the Bot API stand-in and a stand-in Onsen:
// the main's reaction, Joey editing his own message, a command the daemon answers itself (Joey's and a stranger's), the inbound ack reaction; and every
// other path named in server.ts (source pins). Nothing reaches core.kbro.ai.
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, dm, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, freePort, type TgDaemon } from './test-fixtures/tg-daemon.ts'
import { inboundEdit, withSender, withDefaultSender, withoutRecord, sendCtx, DEFAULT_CTX } from './onsen-client.ts'

const JOEY = 1828, STRANGER = 4242
const CRED = 'mesh_PATHSTESTsecretSECRETsecret0123456789'
let api: BotApiMock, d: TgDaemon, up: ReturnType<typeof Bun.serve>
const got: Array<{ path: string; body: any }> = []
const items = () => got.filter(g => g.path === '/messages/batch').flatMap(g => g.body.items)
const evs = () => got.filter(g => g.path === '/events').map(g => g.body)

beforeAll(async () => {
  api = startBotApiMock({}, { pollHoldMs: 300 })
  const root = mkdtempSync(join(tmpdir(), 'onsen-paths-')), port = await freePort()
  mkdirSync(join(root, 'cred'), { recursive: true }); writeFileSync(join(root, 'cred', 'mesh-credential'), CRED)
  let next = 1
  up = Bun.serve({ port, hostname: '127.0.0.1', async fetch(req) {
    const path = new URL(req.url).pathname.replace(/^\/api\/onsen/, ''), body = req.method === 'POST' ? await req.json() : undefined
    got.push({ path, body })
    if (path === '/messages/batch') return Response.json({ results: body.items.map(() => ({ id: next++, duplicate: false })) })
    if (path === '/events') return Response.json({ id: next++, duplicate: false, message_id: 1 })
    return Response.json({ error: 'no route' }, { status: 404 })
  } })
  d = await startTgDaemon(api, root, JOEY, { GENESIS_LANES: '0', ONSEN_BASE: `http://127.0.0.1:${port}/api/onsen`, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'mesh-credential') })
  // the ack reaction on (the fixture's access.json has none)
  const a = JSON.parse(readFileSync(join(d.stateDir, 'access.json'), 'utf8')); a.ackReaction = '👀'
  writeFileSync(join(d.stateDir, 'access.json'), JSON.stringify(a))
}, 40000)
afterAll(async () => { await d?.stop(); api?.stop(); up?.stop(true) })

test('send contexts: a named path wins over the default; withoutRecord marks a call not to be recorded', () => {
  expect(withSender('system:alert', () => withDefaultSender('system:control', () => sendCtx()))?.sender).toBe('system:alert')
  expect(withDefaultSender('system:control', () => sendCtx())?.sender).toBe('system:control')
  expect(withoutRecord(() => sendCtx())?.skip).toBe(true)
  expect(DEFAULT_CTX.sender).toBe('system:daemon')
  expect(inboundEdit('adam', { message_id: 7, chat: { id: JOEY }, from: { id: JOEY }, text: '新的', edit_date: 1764000100 }))
    .toMatchObject({ idem_key: `tg:adam:${JOEY}:edit:7:1764000100`, kind: 'edit', target_client_msg_id: '7', actor: `tg:${JOEY}`, body: '新的' })
})

test('the inbound ack reaction is a reaction event by system:ack; the main\'s react is a reaction event by main', async () => {
  api.push(dm(JOEY, 3100, '有收到嗎'))
  expect(await until(() => evs().some(e => e.kind === 'reaction' && e.target_client_msg_id === '3100'), 10000)).toBe(true)
  expect(evs().find(e => e.target_client_msg_id === '3100')).toMatchObject({ actor: 'system:ack', data: { emoji: '👀' } })
  const r = await d.call('react', { chat_id: String(JOEY), message_id: '3100', emoji: '🫡' })
  expect(r.isError).toBe(false)
  expect(await until(() => evs().some(e => e.actor === 'main' && e.kind === 'reaction'), 10000)).toBe(true)
  expect(evs().find(e => e.actor === 'main')).toMatchObject({ target_client_msg_id: '3100', data: { emoji: '🫡' } })
}, 20000)

test('Joey edits his message: an edit event by tg:<id> with the new text; a stranger\'s edit is not recorded', async () => {
  const date = Math.floor(Date.now() / 1000)
  api.push({ edited_message: { message_id: 3100, date, edit_date: date + 5, chat: { id: JOEY, type: 'private' }, from: { id: JOEY, is_bot: false, first_name: 'J' }, text: '有收到嗎？（改）' } })
  api.push({ edited_message: { message_id: 9, date, edit_date: date + 5, chat: { id: STRANGER, type: 'private' }, from: { id: STRANGER, is_bot: false, first_name: 'S' }, text: 'x' } })
  expect(await until(() => evs().some(e => e.kind === 'edit' && e.actor === `tg:${JOEY}`), 10000)).toBe(true)
  expect(evs().find(e => e.actor === `tg:${JOEY}`)).toMatchObject({ target_client_msg_id: '3100', body: '有收到嗎？（改）', idem_key: `tg:adam:${JOEY}:edit:3100:${date + 5}` })
  await Bun.sleep(400)
  expect(evs().some(e => e.actor === `tg:${STRANGER}`)).toBe(false)
}, 20000)

test('a command the daemon answers: Joey\'s /status is an `in` command and its answer is system:control; a stranger\'s /start and its answer are not recorded', async () => {
  api.push(dm(JOEY, 3200, '/status', { command: true }))
  expect(await until(() => items().some(i => i.client_msg_id === '3200'), 10000)).toBe(true)
  expect(items().find(i => i.client_msg_id === '3200')).toMatchObject({ direction: 'in', kind: 'command', body: '/status', sender: `tg:${JOEY}` })
  expect(await until(() => items().some(i => i.sender === 'system:control' && /Paired as/.test(i.body)), 10000)).toBe(true)
  // dmPolicy pairing: a stranger's /start is answered (allowlist drops it); neither the command nor the answer is recorded
  const accessFile = join(d.stateDir, 'access.json'), was = readFileSync(accessFile, 'utf8')
  writeFileSync(accessFile, JSON.stringify({ ...JSON.parse(was), dmPolicy: 'pairing' }))
  const n0 = items().length, sent0 = api.of('sendMessage').length
  api.push(dm(STRANGER, 50, '/start', { command: true }))
  expect(await until(() => api.of('sendMessage').slice(sent0).some(c => String(c.body.chat_id) === String(STRANGER)), 10000)).toBe(true)   // answered as before
  writeFileSync(accessFile, was)
  await Bun.sleep(400)
  expect(items().slice(n0).some(i => i.chat === String(STRANGER))).toBe(false)
}, 20000)

test('every other path names its author (source pins)', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  for (const s of [
    "Onsen.withSender('system:pairing', () => bot.api.sendMessage(senderId,",
    "Onsen.withDefaultSender('system:control', () => bot.api.sendMessage(chatId, chunks[i],",
    "Onsen.withSender('system:permission', () => bot.api.sendMessage(chat_id, text, { reply_markup: keyboard }))",
    "Onsen.withSender('main', () => bot.api.setMessageReaction(args.chat_id as string,",
    "notify: text => Onsen.withSender('system:alert', () => {",
    "send: (chats, text, buttons) => Onsen.withSender('system:duty-officer', async () => {",
    "Onsen.withSender('system:duty-officer', () => bot.api.editMessageText(s.chat, s.msg, text,",
    "surface: ({ title, buttons }) => Onsen.withSender('system:startup-picker', () => {",
    "notify: text => Onsen.withSender('system:login-watchdog', () => {",
    "if (ctx.callbackQuery) return Onsen.withSender('system:button', () => next())",
    "Onsen.withoutRecord(() => ctx.reply(",
    "Onsen.withSender('system:permission', () => bot.api.setMessageReaction(chat_id, msgId,",
    // WO-176: a press in Onsen edits every copy of a permission prompt
    "Onsen.withSender('system:permission', () => bot.api.editMessageText(cp.chat, cp.msg,",
    "Onsen.withSender('system:ack', () => bot.api",
    "Onsen.sendCtx() ?? Onsen.DEFAULT_CTX",
  ]) expect(src).toContain(s)
})
