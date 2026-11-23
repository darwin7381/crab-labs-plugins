// lanes-topics item 2, end to end: a real tg daemon (lanes on) against the Bot API stand-in. Joey types inside topic 7001; the <channel> meta the main
// gets shows topic="7001" and the topic's name; the typing action goes into the topic; every part of the main's reply (rich text, plain chunks, a photo)
// carries message_thread_id when the topic is decided (reply_to Joey's message, the bot's own message, or an explicit topic), and none otherwise;
// /lanes typed in the topic is answered there; a restart keeps it. Lanes off: no topic anywhere, the reply tool has no `topic` (the fleet's behaviour).
import { test, expect, afterAll, beforeAll, describe } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, dm, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, sleep, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex')
const msgItems = (d: TgDaemon): any[] => {
  try { return readFileSync(join(d.stateDir, 'lanes', 'state.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.rec === 'msg' && r.notif) } catch { return [] }
}
const thread = (c: { body: Record<string, any> }) => c.body.message_thread_id == null ? undefined : Number(c.body.message_thread_id)

describe('lanes on', () => {
  let api: BotApiMock, d: TgDaemon, root: string
  beforeAll(async () => {
    api = startBotApiMock({ has_topics_enabled: true, allows_users_to_create_topics: false })
    root = mkdtempSync(join(tmpdir(), 'lanes-topics-send-'))
    d = await startTgDaemon(api, root, JOEY)
  }, 40000)
  afterAll(async () => { await d?.stop(); api?.stop() })

  test('Joey types inside topic 7001: typing goes into the topic; the main\'s <channel> meta shows topic and topic_name, not the creation message as a reply', async () => {
    api.push(dm(JOEY, 55, '進度？', { topic: 7001, topicName: '工作：示範' }))
    expect(await until(() => api.of('sendChatAction').length >= 1)).toBe(true)
    expect(thread(api.of('sendChatAction')[0])).toBe(7001)
    expect(await until(() => msgItems(d).some(r => r.notif.params?.meta?.message_id === '55'))).toBe(true)
    const meta = msgItems(d).find(r => r.notif.params.meta.message_id === '55').notif.params.meta
    expect(meta).toMatchObject({ topic: '7001', topic_name: '工作：示範' })
    expect(meta.reply_to_message_id).toBeUndefined(); expect(meta.message_thread_id).toBeUndefined()
    api.push(dm(JOEY, 56, '平常講話'))
    expect(await until(() => api.of('sendChatAction').length >= 2)).toBe(true)
    expect(thread(api.of('sendChatAction')[1])).toBeUndefined()
    expect(await until(() => msgItems(d).some(r => r.notif.params?.meta?.message_id === '56'))).toBe(true)
    expect(msgItems(d).find(r => r.notif.params.meta.message_id === '56').notif.params.meta.topic).toBeUndefined()
  }, 20000)

  test('the reply tool: rich text answering Joey\'s topic message goes into the topic WITH the quote; one answering his outside message, or none, outside', async () => {
    const tools: any = await (await d.client()).listTools()
    expect(Object.keys(tools.tools.find((t: any) => t.name === 'reply').inputSchema.properties)).toContain('topic')
    const ins = (await d.client()).getInstructions() ?? ''
    expect(ins).toContain('topic/topic_name'); expect(ins.length).toBeLessThan(2000)
    const n0 = api.of('sendRichMessage').length
    const r = await d.call('reply', { chat_id: String(JOEY), text: '做到第二步', reply_to: '55' })
    expect(r.isError).toBe(false); expect(r.text).toContain('in topic 7001 「工作：示範」')
    const c = api.of('sendRichMessage')[n0]
    expect(thread(c)).toBe(7001); expect(c.body.reply_parameters).toEqual({ message_id: 55 })
    await d.call('reply', { chat_id: String(JOEY), text: '收到', reply_to: '56' })
    await d.call('reply', { chat_id: String(JOEY), text: '主動說一句' })
    expect(api.of('sendRichMessage').slice(n0 + 1).map(thread)).toEqual([undefined, undefined])
    // the bot's own message in the topic: a reply quoting it goes there too
    const own = Number(r.text.match(/id: (\d+)/)![1])
    await d.call('reply', { chat_id: String(JOEY), text: '補充', reply_to: String(own) })
    expect(thread(api.of('sendRichMessage').at(-1)!)).toBe(7001)
    // explicit
    await d.call('reply', { chat_id: String(JOEY), text: '指定', topic: '7001' })
    expect(thread(api.of('sendRichMessage').at(-1)!)).toBe(7001)
    await d.call('reply', { chat_id: String(JOEY), text: '指定外面', topic: '0', reply_to: '55' })
    expect(thread(api.of('sendRichMessage').at(-1)!)).toBeUndefined()
  }, 20000)

  test('every part carries it: each plain chunk of a long reply (the quote on the first only), and a photo', async () => {
    const n0 = api.of('sendMessage').length
    const r = await d.call('reply', { chat_id: String(JOEY), text: 'x'.repeat(9000), format: 'text', reply_to: '55' })
    expect(r.text).toContain('sent 3 parts')
    const parts = api.of('sendMessage').slice(n0)
    expect(parts.map(thread)).toEqual([7001, 7001, 7001])
    expect(parts.map(p => p.body.reply_parameters?.message_id)).toEqual([55, undefined, undefined])
    const png = join(root, 'p.png'); writeFileSync(png, PNG)
    const p0 = api.of('sendPhoto').length
    await d.call('reply', { chat_id: String(JOEY), text: '圖', reply_to: '55', files: [png] })
    expect(await until(() => api.of('sendPhoto').length > p0)).toBe(true)
    expect(thread(api.of('sendPhoto')[p0])).toBe(7001)
  }, 20000)

  test('/lanes typed inside the topic is answered inside it; typed outside, outside', async () => {
    const n0 = api.of('sendMessage').length
    api.push(dm(JOEY, 60, '/lanes', { topic: 7001, command: true }))
    expect(await until(() => api.of('sendMessage').length > n0)).toBe(true)
    expect(thread(api.of('sendMessage')[n0])).toBe(7001)
    api.push(dm(JOEY, 61, '/lanes', { command: true }))
    expect(await until(() => api.of('sendMessage').length > n0 + 1)).toBe(true)
    expect(thread(api.of('sendMessage')[n0 + 1])).toBeUndefined()
  }, 20000)

  test('a daemon restart: a reply to Joey\'s topic message still goes into the topic', async () => {
    await d.stop()
    d = await startTgDaemon(api, root, JOEY)
    const n0 = api.of('sendRichMessage').length
    await d.call('reply', { chat_id: String(JOEY), text: '重啟後', reply_to: '55' })
    expect(thread(api.of('sendRichMessage')[n0])).toBe(7001)
  }, 40000)
})

test('server.ts: every Telegram send goes through the one topic decision, except the named ops notices that are about no topic', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  // ops traffic to opsRecipients / a pairing: not an answer to anything in a topic
  const EXEMPT = [
    'bot.api.sendMessage(senderId, "Paired! Say hi to Claude.")',                  // pairing approved
    'bot.api.sendMessage(chat_id, text, { reply_markup: keyboard })',               // permission prompt
    'void bot.api.sendMessage(chat_id, text).then(m => {',                         // system alert
    'const m = await bot.api.sendMessage(chat, text, kb ? { reply_markup: kb } : {})',   // duty officer
    'void bot.api.sendMessage(chat_id, text).catch(e => {',                        // login expired
    'void sendTextWithMaybeKeyboard(chat_id, title, keyboard).catch(e =>',          // startup picker
    'await sendTextWithMaybeKeyboard(String(chat_id), msg)\n',                      // roamer: target not connected
  ]
  const re = /bot\.api\.(sendMessage|sendPhoto|sendDocument|sendChatAction)\(|callBotApi\('send|(?<!function )sendTextWithMaybeKeyboard\(/g
  const unrouted: string[] = []
  for (const m of src.matchAll(re)) {
    const at = m.index!, line = src.slice(src.lastIndexOf('\n', at) + 1, src.indexOf('\n', at) + 1)
    if (EXEMPT.some(e => line.includes(e.replace(/\n$/, '')) && (!e.endsWith('\n') || line.trimEnd().endsWith(e.trim())))) continue
    const win = src.slice(at, at + 420)
    if (/\.\.\.topicF\b|\.\.\.tf\b|topicFields\(|, opts\)|, here\)|\{ chat: chatId, topic: topicOfMessage\(cbm\)/.test(win)) continue
    unrouted.push(line.trim())
  }
  expect(unrouted).toEqual([])
  // nothing else builds the field
  expect([...src.matchAll(/\{ message_thread_id: /g)].length).toBe(1)             // the one in topicFields (the other is the router event's field)
})

describe('lanes off: the fleet\'s behaviour', () => {
  let api: BotApiMock, d: TgDaemon
  beforeAll(async () => {
    api = startBotApiMock({ has_topics_enabled: true, allows_users_to_create_topics: false })
    d = await startTgDaemon(api, mkdtempSync(join(tmpdir(), 'lanes-topics-send-off-')), JOEY, { GENESIS_LANES: '0' })
  }, 40000)
  afterAll(async () => { await d?.stop(); api?.stop() })

  test('no topic on typing or on the reply, no `topic` in the reply tool, no topic line in the instructions', async () => {
    api.push(dm(JOEY, 55, '進度？', { topic: 7001, topicName: '工作：示範' }))
    expect(await until(() => api.of('sendChatAction').length >= 1)).toBe(true)
    expect(thread(api.of('sendChatAction')[0])).toBeUndefined()
    await sleep(200)
    const tools: any = await (await d.client()).listTools()
    expect(Object.keys(tools.tools.find((t: any) => t.name === 'reply').inputSchema.properties)).not.toContain('topic')
    expect((await d.client()).getInstructions() ?? '').not.toContain('topic/topic_name')
    const r = await d.call('reply', { chat_id: String(JOEY), text: 'ok', reply_to: '55' })
    expect(r.text).toBe('sent (id: ' + r.text.match(/id: (\d+)/)![1] + ')')
    const c = api.of('sendRichMessage').at(-1)!
    expect(thread(c)).toBeUndefined(); expect(c.body.reply_parameters).toEqual({ message_id: 55 })
  }, 20000)
})
