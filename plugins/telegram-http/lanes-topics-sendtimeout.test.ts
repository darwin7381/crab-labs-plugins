// lanes-topics item 7 (always on, lanes on or off): a Telegram send that gets no answer fails in bounded time. 2026-11-23 19:19 TPE the channel bot's
// reply (rich text: callBotApi's bare fetch) had no result for over 120 s, with nothing in the log. Every send to a chat has TELEGRAM_SEND_TIMEOUT_S
// (default 45; 1 here): the tool call errors with words that say the message MAY have been delivered, nothing is sent again (no rich → plain retry), one
// log line per timeout; every reply message delivered is one info line (never the text). Long polling (getUpdates) is not bounded.
// A real tg daemon with lanes OFF, against the Bot API stand-in.
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, dm, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
let api: BotApiMock, d: TgDaemon
beforeAll(async () => {
  api = startBotApiMock({}, { pollHoldMs: 2500 })
  d = await startTgDaemon(api, mkdtempSync(join(tmpdir(), 'lanes-topics-sendtimeout-')), JOEY, { GENESIS_LANES: '0', TELEGRAM_SEND_TIMEOUT_S: '1' })
}, 40000)
afterAll(async () => { await d?.stop(); api?.stop() })
const timed = async (name: string, args: Record<string, unknown>) => { const t0 = Date.now(); const r = await d.call(name, args); return { ...r, ms: Date.now() - t0 } }
const MAYBE = 'no answer from Telegram within 1 s; the message may or may not have been delivered. It was not sent again'

test('a normal send still works, and the reply leaves one info line per message with no text in it', async () => {
  const r = await d.call('reply', { chat_id: String(JOEY), text: 'SECRET-TEXT-xyz 正常送出' })
  expect(r.isError).toBe(false)
  const id = r.text.match(/id: (\d+)/)![1]
  expect(await until(() => d.log().includes(`reply sent: method=sendRichMessage chat=${JOEY} message=${id} topic=- ms=`))).toBe(true)
  expect(d.log()).not.toContain('SECRET-TEXT-xyz')
}, 15000)

test('rich text with no answer: the tool call errors within the bound, says it may have been delivered, and is NOT resent as plain text', async () => {
  api.hang.fn = m => m === 'sendRichMessage'
  const plain0 = api.of('sendMessage').length, rich0 = api.of('sendRichMessage').length
  const r = await timed('reply', { chat_id: String(JOEY), text: '這則會卡住' })
  api.hang.fn = null
  expect(r.isError).toBe(true)
  expect(r.text).toContain(MAYBE)
  expect(r.ms).toBeLessThan(4000)
  expect(api.of('sendRichMessage').length).toBe(rich0 + 1)
  expect(api.of('sendMessage').length).toBe(plain0)                                       // no fallback, no second copy
  expect(await until(() => /telegram send timeout: sendRichMessage got no answer in \d+ ms \(bound 1 s\); not sent again/.test(d.log()))).toBe(true)
  expect(d.log()).not.toContain('這則會卡住')
}, 15000)

test('the grammy paths too: plain text, an edit (not retried as plain), a reaction', async () => {
  api.hang.fn = m => m === 'sendMessage'
  const a = await timed('reply', { chat_id: String(JOEY), text: 'plain', format: 'text' })
  expect(a.isError).toBe(true); expect(a.text).toContain(`sendMessage: ${MAYBE}`); expect(a.ms).toBeLessThan(4000)
  api.hang.fn = m => m === 'editMessageText'
  const e0 = api.of('editMessageText').length
  const e = await timed('edit_message', { chat_id: String(JOEY), message_id: '5001', text: '改' })
  expect(e.isError).toBe(true); expect(e.text).toContain(MAYBE); expect(e.ms).toBeLessThan(4000)
  expect(api.of('editMessageText').length).toBe(e0 + 1)
  api.hang.fn = m => m === 'setMessageReaction'
  const x = await timed('react', { chat_id: String(JOEY), message_id: '5001', emoji: '👍' })
  expect(x.isError).toBe(true); expect(x.text).toContain(MAYBE)
  api.hang.fn = null
  expect((await d.call('reply', { chat_id: String(JOEY), text: 'after', format: 'text' })).isError).toBe(false)   // the next send goes through
}, 20000)

test('long polling is not bounded: a getUpdates held 2.5 s (longer than the 1 s bound) ends normally and updates still arrive', async () => {
  expect(await until(() => api.polls.some(p => p.end != null && p.end - p.start >= 2000), 10000)).toBe(true)
  expect(d.log()).not.toContain('telegram send timeout: getUpdates')
  const n0 = api.of('sendChatAction').length
  api.push(dm(JOEY, 77, '還在嗎'))
  expect(await until(() => api.of('sendChatAction').length > n0, 8000)).toBe(true)
}, 25000)

test('server.ts: the bound is not behind the lanes switch; callBotApi and every grammy send go through it', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  const at = src.indexOf('bot.api.config.use((prev, method, payload, signal) =>')
  expect(at).toBeGreaterThan(0)
  expect(src.slice(src.lastIndexOf('\n', at - 2), at)).not.toContain('LANES_ON')
  expect(src).toContain("const BOUNDED_SENDS = new Set(['sendMessage', 'sendRichMessage', 'sendPhoto', 'sendDocument', 'sendChatAction', 'editMessageText', 'setMessageReaction',")
  expect(src).not.toMatch(/BOUNDED_SENDS = new Set\([^)]*getUpdates/)
  expect(src.slice(src.indexOf('async function callBotApi('), src.indexOf('async function callBotApi(') + 400)).toContain('const data = await boundedSend(method, async signal => {')
})
