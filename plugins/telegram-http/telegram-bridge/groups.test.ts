import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from './agent.ts'
import { FakeOnsen, FakeTelegram, until } from './fakes.ts'
import { Bridge, configFromEnv } from './telegram-bridge.ts'
import { messageKey } from './groups.ts'

const a = '101:lab-a', b = '102:lab-b'
const supergroup = { id: -100212, type: 'supergroup' }, group = { id: -23, type: 'group' }
const from = { id: 42, first_name: 'Guest' }, date = 1_700_000_000
let bridge: Bridge, tg: FakeTelegram, onsen: FakeOnsen, dir: string, logs: string[]

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wo217-bridge-'))
  tg = new FakeTelegram()
  onsen = new FakeOnsen()
  logs = []
  const log = (level: string, message: string) => logs.push(level + ' ' + message)
  const cfg = configFromEnv({ HOME: dir, TELEGRAM_BRIDGE_MACHINE: 'lab', TELEGRAM_BRIDGE_STATE_DIR: dir,
    TELEGRAM_API_ROOT: tg.root, ONSEN_BASE: onsen.base, TELEGRAM_BRIDGE_POLL_TIMEOUT_S: '1', TELEGRAM_BRIDGE_SORRY_S: '0.1' })
  bridge = new Bridge(cfg, { log })
  bridge.onsen.token = () => 'test'
  onsen.creds.set('test', cfg.name)
  for (const [member, token, username] of [['lab-a', a, 'lab_a_bot'], ['lab-b', b, 'lab_b_bot']] as const) {
    const sd = join(dir, member)
    mkdirSync(sd)
    writeFileSync(join(sd, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['42'],
      groups: { [group.id]: { allowFrom: ['42'] }, [supergroup.id]: { requireMention: true, allowFrom: [] } },
      mentionPatterns: member === 'lab-b' ? ['[', '小乙'] : [] }))
    tg.addBot(token, username)
    const agent = new Agent(member, sd, 'test', { token, mtime: 0 }, { bridgeDir: dir, tgOptions: cfg.tg, log })
    agent.username = username
    bridge.agents.set(member, agent)
  }
  await bridge.register()
  await bridge.syncEndpoints()
})
afterEach(async () => {
  await bridge.stop()
  tg.stop()
  onsen.stop()
  rmSync(dir, { recursive: true, force: true })
})

const confirmed = () => until(() => tg.unconfirmed(a) + tg.unconfirmed(b) === 0, 5000, 'both pollers confirmed')
function memberUpdate(oldStatus: string, newStatus: string, user = 101) {
  return { my_chat_member: { chat: group, date, old_chat_member: { status: oldStatus, user: { id: user } },
    new_chat_member: { status: newStatus, user: { id: user } } } }
}

test('two bots POST one unmentioned group line, confirm both aliases and each ack once', async () => {
  const requests = spyOn(bridge.onsen, 'req')
  const message = { message_id: 5, from, chat: supergroup, date, text: '你好' }
  tg.push(a, { message })
  await confirmed()
  tg.push(b, { message })
  await confirmed()
  expect(onsen.messages).toHaveLength(1)
  expect(onsen.messages[0]).toMatchObject({ member: 'lab-a', chat: '-100212', mentions: [], idem_key: 'tg:-100212:5' })
  const posts = requests.mock.calls.map((call, i) => ({ call, i })).filter(({ call }) => call[1] === '/bridge/messages')
  expect(posts.map(({ call }) => [(call[2] as any).member, call[3]?.idem])).toEqual([['lab-a', 'tg:-100212:5'], ['lab-b', 'tg:-100212:5']])
  const result = await requests.mock.results[posts[1]!.i]!.value
  expect(result.json.data).toMatchObject({ duplicate: true, message_id: onsen.messages[0].id })
  expect(bridge.agents.get('lab-b')!.stats.duplicates).toBe(1)
  expect(logs.filter(l => /^(warn|error)/.test(l))).toEqual([])
  for (const t of [a, b]) expect(tg.callsOf(t, 'setMessageReaction').map(r => r.reaction[0].emoji)).toEqual(['👀'])
  expect(onsen.bad).toEqual([])
})

test('basic group dedupes different bot-local ids by person, second and raw caption; the gate still checks the sender', async () => {
  const m = { from, date, chat: group, caption: '附件' }
  tg.push(a, { message: { ...m, message_id: 7 } })
  tg.push(b, { message: { ...m, message_id: 81 } })
  tg.push(b, { message: { ...m, message_id: 82, date: date + 1 } })
  tg.push(b, { message: { ...m, message_id: 83, caption: '不同' } })
  tg.push(b, { message: { ...m, message_id: 84, from: { id: 99 } } })
  await confirmed()
  expect(onsen.messages.map(m => m.idem_key).sort()).toEqual([
    'tg:-23:42:1700000000:c7225dbf105eeed5', 'tg:-23:42:1700000001:c7225dbf105eeed5',
    'tg:-23:42:1700000000:f2632a784b0d7c93',
  ].sort())
})

test('three basic-group album photos get three keys across both bots, including two without captions', async () => {
  for (const [token, offset] of [[a, 10], [b, 80]] as const) {
    for (let i = 0; i < 3; i++) {
      const file = offset + '-photo-' + i
      tg.files.set('f/' + file, new Uint8Array([i]))
      tg.push(token, { message: { chat: group, from, date, message_id: offset + i, media_group_id: 'album',
        ...(i === 0 ? { caption: '三張' } : {}), photo: [{ file_id: file, file_unique_id: 'photo-' + i, file_size: 1 }] } })
    }
  }
  await confirmed()
  expect(onsen.messages).toHaveLength(3)
  expect(new Set(onsen.messages.map(m => m.idem_key)).size).toBe(3)
  expect(onsen.files.size).toBe(3)
  expect([...bridge.agents.values()].reduce((n, bot) => n + bot.stats.duplicates, 0)).toBe(3)
})

test('basic-group keys include stable album, file and forward identities', () => {
  const key = (extra: Record<string, unknown>) => messageKey('lab-a', { chat: group, from, date, ...extra })
  for (const kind of ['photo', 'video', 'video_note', 'voice', 'sticker', 'animation', 'audio', 'document']) {
    const media = (id: string, unique: string) => kind === 'photo' ? [{ file_id: id, file_unique_id: unique }] : { file_id: id, file_unique_id: unique }
    expect(key({ [kind]: media('bot A', 'one') })).toBe(key({ [kind]: media('bot B', 'one') }))
    expect(key({ [kind]: media('bot A', 'one') })).not.toBe(key({ [kind]: media('bot A', 'two') }))
    expect(key({ [kind]: media('id', 'one'), media_group_id: 'first' })).not.toBe(key({ [kind]: media('id', 'one'), media_group_id: 'next' }))
  }
  const origin = { type: 'channel', chat: { id: -10048 }, date, message_id: 11 }
  expect(key({ forward_origin: origin })).not.toBe(key({ forward_origin: { ...origin, message_id: 12 } }))
  const link = (url: string) => ({ text: '圖', entities: [{ type: 'text_link', offset: 0, length: 1, url }] })
  expect(key(link('tg://user?id=1'))).not.toBe(key(link('tg://user?id=2')))
  const rich = (file_id: string, text: string) => ({ rich_message: { blocks: [
    { type: 'paragraph', text }, { type: 'photo', photo: [{ file_id, file_unique_id: 'pic' }] },
  ] } })
  expect(key(rich('bot-a-pic', '甲'))).toBe(key(rich('bot-b-pic', '甲')))
  expect(key(rich('bot-a-pic', '甲'))).not.toBe(key(rich('bot-a-pic', '乙')))
})

test('each writer forwards all Telegram account mentions, including new ones on a duplicate', async () => {
  const req = spyOn(bridge.onsen, 'req')
  const msg = { from, chat: group, date }
  const caption = '👋 @LAB_B_BOT @unknown A B'
  const entities = [{ type: 'mention', offset: 3, length: 10 }, { type: 'mention', offset: 14, length: 8 },
    { type: 'text_mention', offset: 23, length: 1, user: { id: 303, username: 'other_bot' } },
    { type: 'text_mention', offset: 25, length: 1, user: { id: 404 } }]
  tg.push(a, { message: { ...msg, message_id: 1, caption, caption_entities: entities.slice(0, 2) } })
  await confirmed()
  tg.push(b, { message: { ...msg, message_id: 81, caption, caption_entities: entities } })
  await confirmed()
  const posts = req.mock.calls.filter(c => c[1] === '/bridge/messages').map(c => c[2] as any)
  const key = 'tg:' + messageKey('lab-a', { ...msg, caption })
  expect(posts.map(p => [p.member, p.idem_key, p.mentions])).toEqual([
    ['lab-a', key, ['@LAB_B_BOT', '@unknown']],
    ['lab-b', key, ['@LAB_B_BOT', '@unknown', '@other_bot', '404']],
  ])
  expect(onsen.messages).toHaveLength(1)
  expect(bridge.agents.get('lab-b')!.stats.duplicates).toBe(1)
  tg.push(a, { message: { ...msg, message_id: 2, text: '/help@remote_bot @remote_bot', entities: [
    { type: 'bot_command', offset: 0, length: 16 }, { type: 'mention', offset: 17, length: 11 },
  ] } })
  tg.push(a, { message: { ...msg, message_id: 3, text: '小乙' } })
  tg.push(a, { message: { ...msg, message_id: 4, text: 'reply', reply_to_message: { message_id: 2, from: { username: 'lab_b_bot' } } } })
  await confirmed()
  expect(onsen.messages.slice(1).map(m => m.mentions)).toEqual([['@remote_bot', '@remote_bot'], [], []])
})

test('nested rich text keeps its basic-group key when the second bot sees more mention entities', async () => {
  const calls = spyOn(bridge.onsen, 'req')
  const rich = (text: unknown) => ({ blocks: [{ type: 'blockquote', blocks: [{ type: 'paragraph', text }] }] })
  const message = { chat: group, from, date, message_id: 7 }
  tg.push(a, { message: { ...message, rich_message: rich('@far_bot /help@next_bot 客人') } })
  await confirmed()
  tg.push(b, { message: { ...message, message_id: 81, rich_message: rich([
    { type: 'mention', username: 'far_bot' }, ' ', { type: 'bot_command', bot_command: '/help@next_bot' },
    ' ', { type: 'text_mention', user_id: 404, text: '客人' },
  ]) } })
  await confirmed()
  const posts = calls.mock.calls.filter(c => c[1] === '/bridge/messages').map(c => c[2] as any)
  expect(posts.map(p => p.mentions)).toEqual([[], ['@far_bot', '@next_bot', '404']])
  expect(posts[0].idem_key).toBe(posts[1].idem_key)
  expect(onsen.messages).toHaveLength(1)
})

test('a bare group slash is text and either bridge writes an addressed command for Onsen', async () => {
  tg.text(a, from.id, '/clear', { chat: supergroup })
  tg.text(a, from.id, '/clear@lab_b_bot', { chat: supergroup, entities: [{ type: 'bot_command', offset: 0, length: 16 }] })
  await confirmed()
  expect(onsen.messages.map(m => [m.text, m.kind, m.mentions])).toEqual([
    ['/clear', 'text', []], ['/clear@lab_b_bot', 'command', ['@lab_b_bot']],
  ])
})

test('membership transitions and migration are ordered PUTs; the new chat still needs its own allowlist entry', async () => {
  for (const u of [memberUpdate('left', 'member'), memberUpdate('member', 'administrator'), memberUpdate('administrator', 'kicked'),
    memberUpdate('left', 'member', 102), { message: { chat: group, migrate_to_chat_id: -10023, message_id: 6 } },
    { message: { from, date, chat: { id: -10023, type: 'supergroup' }, text: 'new group', message_id: 3 } }]) tg.push(a, u)
  await confirmed()
  const path = '/v1/bridge/chats/-23/members/lab-a', at = new Date(date * 1000).toISOString()
  expect(onsen.chatWrites).toEqual([{ path, body: { state: 'in', at } }, { path, body: { state: 'left', at } },
    { path: '/v1/bridge/chats/-23', body: { moved_to: '-10023' } }])
  expect(tg.callsOf(a, 'getUpdates')[0].allowed_updates).toContain('my_chat_member')
  expect(onsen.messages).toEqual([])
  expect(tg.callsOf(a, 'setMessageReaction')).toEqual([])
})

test('membership and migration from an unlisted group make no Onsen request even when the destination is allowed', async () => {
  const req = spyOn(bridge.onsen, 'req')
  const chat = { type: 'group', id: -404 }
  for (const [old, next] of [['left', 'member'], ['member', 'kicked']] as const) {
    const { my_chat_member } = memberUpdate(old, next)
    tg.push(a, { my_chat_member: { ...my_chat_member, chat } })
  }
  tg.push(a, { message: { chat, message_id: 3, migrate_to_chat_id: supergroup.id } })
  await confirmed()
  expect(req.mock.calls.filter(c => c[1].startsWith('/bridge/chats/'))).toHaveLength(0)
  expect(onsen.chatWrites).toEqual([])
})

test('missing chat endpoints log once per kind across bots and the next message is still written', async () => {
  for (const [token, id] of [[a, 101], [b, 102]] as const) {
    for (let i = 0; i < 2; i++) onsen.answers.push({ path: /PUT .*\/bridge\/chats\//, status: 404, json: { detail: 'Not Found' } })
    tg.push(token, memberUpdate('left', 'member', id))
    tg.push(token, { message: { chat: group, migrate_to_chat_id: -10023 } })
    tg.text(token, from.id, 'after', { chat: group })
    await confirmed()
  }
  expect(logs.filter(l => l.includes('404'))).toHaveLength(2)
  expect(onsen.messages.length).toBeGreaterThan(0)
  expect([...bridge.pollers.values()].map(p => p.stats.failed_tries)).toEqual([0, 0])
})

test('a basic group gets one outage reply even with different message numbers', async () => {
  onsen.mode = '503'
  for (const [token, id] of [[a, 7], [b, 81]] as const) tg.push(token, { message: { chat: group, from, date, text: 'offline', message_id: id } })
  await until(() => [...bridge.pollers.values()].every(p => p.stats.failed_tries > 0) && tg.sent.length > 0, 3000, 'outage notice')
  onsen.mode = 'up'
  await confirmed()
  expect(tg.sent.filter(r => r.text?.includes('Onsen 現在連不上'))).toHaveLength(1)
  expect(onsen.messages).toHaveLength(1)
})

test('supergroup edits share their version key; basic group edits address the bot-local message', async () => {
  const requests = spyOn(bridge.onsen, 'req')
  for (const token of [a, b]) {
    for (const chat of [supergroup, group]) tg.push(token, { edited_message: { chat, from, date, edit_date: date + 1, text: 'edit', message_id: 7 } })
    await confirmed()
  }
  const keys = requests.mock.calls.filter(r => r[1] === '/bridge/messages/edit').map(r => r[3]?.idem)
  expect(keys).toEqual(['tg:-100212:7:edit:1700000001', 'tg:lab-a:-23:7:edit:1700000001',
    'tg:-100212:7:edit:1700000001', 'tg:lab-b:-23:7:edit:1700000001'])
})

const feedMessage = (member: string, id: string, text: string) => ({
  type: 'message', seq: id, at: new Date().toISOString(), member, chat: String(supergroup.id),
  message: { id, from: member, body: { text }, attachments: [] },
})

test('the speaker draws its message once, only the receiving bot draws in_session, and the chosen bot draws the web echo', async () => {
  const chat = String(supergroup.id), line = feedMessage('lab-a', 'line', 'from A')
  await bridge.drawBatch([line, { ...line, seq: 'replay' },
    { type: 'receipt', seq: 'receipt', member: 'lab-b', chat, state: 'in_session', client_msg_id: '63', at: line.at },
    { ...feedMessage('lab-b', 'echo', 'from web'), message: { id: 'echo', from: 'guest', body: { text: 'from web' } }, origin_client: 'onsen' }])
  await until(() => tg.callsOf(b, 'setMessageReaction').length > 0, 1000, 'recipient reaction')
  expect(tg.sentTo(a, chat).map(r => r.markdown)).toEqual(['from A'])
  expect(tg.sentTo(b, chat).map(r => r.markdown)).toEqual(['〔guest 在 Onsen 傳的〕\n\nfrom web'])
  expect(tg.callsOf(b, 'setMessageReaction')).toEqual([{ chat_id: chat, message_id: 63, reaction: [{ type: 'emoji', emoji: '✍' }] }])
  expect(tg.callsOf(a, 'setMessageReaction')).toEqual([])
  expect(onsen.reports.map(r => r.id)).toEqual(['line', 'echo'])
  await bridge.drawBatch([])
  expect(tg.sent).toHaveLength(2)
})

test('a DM uses the embedded Telegram topic name first and the stored name as fallback', async () => {
  const chat = { id: from.id, type: 'private' }
  onsen.identities.set(String(chat.id), 'tg-42')
  bridge.two.noteTopic('lab-a', String(chat.id), '7', '先前的名稱')
  const m = { chat, from, date, message_thread_id: 7, text: '私訊' }
  tg.push(a, { message: { ...m, message_id: 50, reply_to_message: { forum_topic_created: { name: '建立時的名稱' } } } })
  tg.push(a, { message: { ...m, message_id: 51 } })
  await confirmed()
  expect(onsen.messages.map(m => [m.client_msg_id, m.topic_name])).toEqual([['50', '建立時的名稱'], ['51', '建立時的名稱']])
})

test('one group topic serves both bots in feed order, including its inbound Telegram rename', async () => {
  const chat = String(supergroup.id), thread = 'thread-7'
  const open = { type: 'thread', member: 'lab-b', seq: 'open', chat, client_thread: null, thread, name: '原名', state: 'open' }
  await bridge.drawBatch([open, { ...feedMessage('lab-a', 'first', 'first'), thread }, { ...open, seq: 'again', member: 'lab-a' }])
  const ct = onsen.threads[0]?.client_thread
  expect(ct).toBeTruthy()
  expect(onsen.threads).toEqual([{ member: 'lab-b', chat, thread, client_thread: ct }, { member: 'lab-a', chat, thread, client_thread: ct }])
  expect(tg.sentTo(a)[0]?.params.message_thread_id).toBe(Number(ct))
  expect(tg.callsOf(a, 'createForumTopic')).toEqual([])
  tg.push(b, { message: { chat: supergroup, message_thread_id: Number(ct), forum_topic_edited: { name: '新名' } } })
  await confirmed()
  tg.push(a, { message: { chat: supergroup, from, date, message_id: 55, message_thread_id: Number(ct), text: 'after rename',
    reply_to_message: { forum_topic_created: { name: '原名' } } } })
  await confirmed()
  expect(onsen.messages[0]).toMatchObject({ client_thread: ct, topic_name: '新名' })
  expect(Object.keys(bridge.state.data.topics)).toEqual([chat + ':' + ct])
})

test('restart reads legacy topic keys, keeps the newest shared group name and isolates DMs', () => {
  const chat = String(supergroup.id), ct = '42', thread = 't'
  const record = { member: 'lab-a', chat, client_thread: ct, thread, name: 'old', state: 'open', at: 1 }
  writeFileSync(bridge.state.file, JSON.stringify({ topics: {
    ['lab-b:' + chat + ':t']: { ...record, member: 'lab-b', at: 2, name: 'shared' },
    ['lab-a:' + chat + ':t']: record,
    'lab-a:123:t': { ...record, chat: '123', name: 'private' },
  } }))
  const restarted = new Bridge(bridge.cfg)
  expect(restarted.two.threadOf('lab-a', chat, thread).client_thread).toBe(ct)
  expect(restarted.two.topicName('lab-a', chat, ct)).toBe('shared')
  expect(restarted.two.topicName('lab-a', '123', ct)).toBe('private')
  expect(restarted.two.topicName('lab-b', '123', ct)).toBeNull()
  restarted.state.flush()
})
