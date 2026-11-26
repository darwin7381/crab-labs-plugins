// telegram-bridge-stage2.test.ts (board WO-196 part B, stage two: the command menu, threads and topics, the restart line, the person's
// reactions, groups). Same fakes as stage one (fakes.ts); a home of its own.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeOnsen, FakeTelegram, until } from './fakes.ts'
import { LIFTED_TEXT, LINE_TEXT, menuOf } from './stage-two.ts'
import { Bridge, configFromEnv } from './telegram-bridge.ts'

const root = mkdtempSync(join(tmpdir(), 'tgb2-'))
const home = join(root, 'home')
const JOEY = 1828173984, GROUP = -1001234, GUEST = 4242
const TOK = '7100000001:ZZgammaSECRETgammaSECRETgamma'
const CRED = 'mesh_bridge2_' + 'q'.repeat(24)
const T = 20_000
let tg: FakeTelegram, onsen: FakeOnsen, b: Bridge, stop: () => Promise<void>
const logs: string[] = []
const put = (p: string, body: unknown) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body)) }
const stateDir = join(home, 'cc-workspaces', 'claude-gamma', '.telegram-state')
const chat = String(JOEY)
const msgItem = (id: string, text: string, extra: any = {}) => ({ type: 'message', member: 'gamma', conversation_id: 'cv', chat, message: { id, from: 'gamma', type: 'message', body: { format: 'markdown', text }, attachments: [] },
  author_label: null, silent: false, origin_client: null, reply_to_client_msg_id: null, client_thread: null, ...extra })

beforeAll(async () => {
  tg = new FakeTelegram(); onsen = new FakeOnsen()
  onsen.creds.set(CRED, 'telegram-bridge-txmonster')
  onsen.members = [{ name: 'gamma', display_name: 'Gamma', kind: 'agent' }, { name: 'joey', display_name: 'Joey', kind: 'human' }]
  put(join(stateDir, '.env'), `TELEGRAM_BOT_TOKEN=${TOK}\n`)
  put(join(stateDir, 'access.json'), { dmPolicy: 'allowlist', allowFrom: [chat], groups: { [String(GROUP)]: { requireMention: true, allowFrom: [] } }, pending: {} })
  put(join(home, '.config', 'systemd', 'user', 'telegram-daemon.gamma.service'), `[Service]\nEnvironment=TELEGRAM_STATE_DIR=${stateDir}\n`)
  put(join(home, '.config', 'systemd', 'user', 'telegram-daemon.gamma.service.d', 'lanes.conf'), '[Service]\nEnvironment=LANES_AGENT=gamma\n')
  put(join(home, '.config', 'crab-labs-plugins', 'env'), 'ONSEN_BRIDGE=*\n')
  put(join(root, 'cred'), CRED)
  put(join(root, 'fake-whisper.sh'), '#!/bin/sh\ntest -s "$1" && echo "你好，看一下"\n'); chmodSync(join(root, 'fake-whisper.sh'), 0o755)
  tg.addBot(TOK, 'gamma_bot')
  b = new Bridge(configFromEnv({
    HOME: home, TELEGRAM_BRIDGE_MACHINE: 'txmonster', ONSEN_BASE: onsen.base, TELEGRAM_API_ROOT: tg.root, TELEGRAM_BRIDGE_STATE_DIR: join(root, 'state'),
    CRAB_LABS_PLUGINS_ENV: join(home, '.config', 'crab-labs-plugins', 'env'), TELEGRAM_BRIDGE_CREDENTIAL_FILE: join(root, 'cred'), TELEGRAM_BRIDGE_PLATFORM: 'linux',
    TELEGRAM_BRIDGE_SETTINGS_S: '0.2', TELEGRAM_BRIDGE_POLL_TIMEOUT_S: '1', TELEGRAM_BRIDGE_FEED_WAIT_S: '1', TELEGRAM_BRIDGE_VOICE: '1',
    CHANNEL_BOT_TRANSCRIBE_CMD: join(root, 'fake-whisper.sh'),
  }), { log: (l, m) => logs.push(`${l} ${m}`) })
  await b.start()
  let on = true
  const loop = (async () => { while (on) { try { await b.tick() } catch (e) { logs.push(`error ${e}`) } await Bun.sleep(30) } })()
  stop = async () => { on = false; await loop; await b.stop() }
  await until(() => tg.bots.get(TOK)!.getUpdatesCalls > 0 && onsen.requests.some(r => r.path.endsWith('/bridge/feed')), 5000, 'polling and the feed')
})
afterAll(async () => { await stop?.(); tg?.stop(); onsen?.stop(); rmSync(root, { recursive: true, force: true }) })

describe('stage two', () => {
  test('a 403 from Onsen (an account that is an agent; unknown_identity before 0.35.1): nothing answered, the update done', async () => {
    const BOTLIKE = 6060
    put(join(stateDir, 'access.json'), { dmPolicy: 'allowlist', allowFrom: [chat, String(BOTLIKE)], groups: { [String(GROUP)]: { requireMention: true, allowFrom: [] } }, pending: {} })
    onsen.notPeople.add(String(BOTLIKE)); onsen.identities.set(String(BOTLIKE), 'some-agent')
    tg.push(TOK, { message: { message_id: 600, from: { id: BOTLIKE, is_bot: false, first_name: 'X' }, chat: { id: BOTLIKE, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'hi' } })
    tg.push(TOK, { message: { message_id: 601, from: { id: 6161, is_bot: false, first_name: 'Y' }, chat: { id: 6161, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'hi' } })
    await until(() => tg.unconfirmed(TOK) === 0, 5000, 'done')
    expect(tg.sentTo(TOK, String(BOTLIKE)).length).toBe(0)
    expect(tg.callsOf(TOK, 'setMessageReaction').some(p => p.message_id === 600)).toBe(false)
    expect(logs.some(l => l.includes('Onsen refused message tg:600') && l.includes('403 not_allowed'))).toBe(true)
  }, T)

  test('the command menu: the connector\'s commands with /start and /help, /clear first and /model second, both scopes', async () => {
    expect(menuOf([{ name: 'status', description: 'x' }, { name: '/model', description: 'Model' }, { name: 'Bad-Name', description: 'no' }, { name: 'clear', description: 'Clear' }]).map(c => c.command))
      .toEqual(['clear', 'model', 'start', 'help', 'status'])
    onsen.push({ type: 'commands', member: 'gamma', conversation_id: 'cv', chat, commands: [{ name: 'status', description: '狀態' }, { name: 'model', description: '換模型' }, { name: 'clear', description: '重新開始' }] })
    await until(() => tg.callsOf(TOK, 'setMyCommands').length === 2, 3000, 'setMyCommands')
    const [def, priv] = tg.callsOf(TOK, 'setMyCommands')
    expect(def.commands.map((c: any) => c.command)).toEqual(['clear', 'model', 'start', 'help', 'status'])
    expect(def.scope).toBeUndefined(); expect(priv.scope).toEqual({ type: 'all_private_chats' })
  }, T)

  test('a thread: a topic opened and reported; messages in it; closed → ✅; a message typed in it carries the thread and its name', async () => {
    onsen.push({ type: 'thread', member: 'gamma', conversation_id: 'cv', chat, thread: 'th_7', name: '🔧 修 WO-196', state: 'open', client_thread: null })
    await until(() => onsen.threads.length === 1, 3000, 'PUT /bridge/threads')
    const created = tg.callsOf(TOK, 'createForumTopic')[0]
    expect(created).toEqual({ chat_id: chat, name: '修 WO-196' })                                 // emoji dropped (lanes-topics.ts plainTopicName)
    const ct = onsen.threads[0].client_thread
    expect(onsen.threads[0]).toEqual({ member: 'gamma', chat, thread: 'th_7', client_thread: ct })
    onsen.push(msgItem('t1', 'in the topic', { client_thread: ct }))
    await until(() => onsen.reports.some(r => r.id === 't1'), 3000, 't1')
    expect(tg.sent.find(s => String(s.message_id) === onsen.reports.find(r => r.id === 't1')!.body.client_msg_ids[0])!.params.message_thread_id).toBe(Number(ct))
    onsen.push({ type: 'thread', member: 'gamma', conversation_id: 'cv', chat, thread: 'th_7', name: '修 WO-196', state: 'closed', client_thread: ct })
    await until(() => tg.callsOf(TOK, 'editForumTopic').some(p => p.icon_custom_emoji_id === '5237699328843200968'), 3000, '✅')
    expect(tg.callsOf(TOK, 'editForumTopic').some(p => p.name)).toBe(false)                     // the same name: not renamed
    // the person types in the topic: client_thread and topic_name go with it
    const m = { message_id: 7777, from: { id: JOEY, is_bot: false, first_name: 'Joey' }, chat: { id: JOEY, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'in there',
      message_thread_id: Number(ct), is_topic_message: true, reply_to_message: { message_id: Number(ct), forum_topic_created: { name: '修 WO-196' } } }
    tg.push(TOK, { message: m })
    await until(() => onsen.messages.some(x => x.client_msg_id === '7777'), 3000, 'written')
    expect(onsen.messages.find(x => x.client_msg_id === '7777')).toMatchObject({ client_thread: ct, topic_name: '修 WO-196', reply_to_client_msg_id: null })
  }, T)

  test('the restart line: its button counts down to lift_until; pressed in time it is lifted; late it is not; lifted elsewhere: the message says so', async () => {
    onsen.push({ type: 'restart_line', member: 'gamma', conversation_id: 'cv', chat, id: 'L1', lifted: false, lift_until: new Date(Date.now() + 3000).toISOString() })
    await until(() => tg.sentTo(TOK, chat).some(s => s.text === LINE_TEXT), 3000, 'line message')
    const lm = tg.sentTo(TOK, chat).find(s => s.text === LINE_TEXT)!
    expect(lm.params.reply_markup.inline_keyboard[0][0]).toEqual({ text: '讓它看得到之前的（3）', callback_data: 'olift:L1' })
    expect(lm.params.disable_notification).toBe(true)
    await until(() => tg.callsOf(TOK, 'editMessageReplyMarkup').some(p => p.message_id === lm.message_id && p.reply_markup.inline_keyboard[0]?.[0]?.text === '讓它看得到之前的（2）'), 2500, 'countdown 2')
    tg.push(TOK, { callback_query: { id: 'lq1', from: { id: JOEY }, data: 'olift:L1', message: { message_id: lm.message_id, chat: { id: JOEY, type: 'private' } } } })
    await until(() => onsen.lifts.some(l => l.id === 'L1'), 3000, 'lift')
    expect(onsen.lifts.find(l => l.id === 'L1')!.body).toEqual({ client_user_id: chat })
    await until(() => tg.callsOf(TOK, 'editMessageText').some(p => p.message_id === lm.message_id && p.text === LIFTED_TEXT), 3000, 'lifted text')
    // a second line, pressed after its window
    onsen.push({ type: 'restart_line', member: 'gamma', conversation_id: 'cv', chat, id: 'L2', lifted: false, lift_until: new Date(Date.now() + 1000).toISOString() })
    await until(() => tg.callsOf(TOK, 'sendMessage').filter(p => p.text === LINE_TEXT).length === 2, 3000, 'line 2')
    await Bun.sleep(2600)
    tg.push(TOK, { callback_query: { id: 'lq2', from: { id: JOEY }, data: 'olift:L2', message: { message_id: 1, chat: { id: JOEY, type: 'private' } } } })
    await until(() => tg.callsOf(TOK, 'answerCallbackQuery').some(p => p.callback_query_id === 'lq2' && p.text === '已經過了，線留著'), 3000, 'late')
    expect(onsen.lifts.some(l => l.id === 'L2')).toBe(false)
    // a third, lifted on Onsen's page: the message says so
    onsen.push({ type: 'restart_line', member: 'gamma', conversation_id: 'cv', chat, id: 'L3', lifted: false, lift_until: null })
    await until(() => tg.sentTo(TOK, chat).filter(s => s.text === LINE_TEXT).length === 3, 3000, 'line 3')
    const l3 = tg.sentTo(TOK, chat).filter(s => s.text === LINE_TEXT)[2]!
    expect(l3.params.reply_markup.inline_keyboard[0][0].text).toBe('讓它看得到之前的')
    onsen.push({ type: 'restart_line', member: 'gamma', conversation_id: 'cv', chat, id: 'L3', lifted: true, lift_until: null })
    await until(() => tg.callsOf(TOK, 'editMessageText').some(p => p.message_id === l3.message_id && p.text === LIFTED_TEXT), 3000, 'lifted elsewhere')
  }, T)

  test('his reactions: a person\'s reaction → POST /bridge/reactions; a stranger\'s is dropped', async () => {
    const mid = tg.text(TOK, JOEY, 'react to me')
    await until(() => onsen.messages.some(x => x.client_msg_id === String(mid)), 3000, 'written')
    tg.push(TOK, { message_reaction: { chat: { id: JOEY, type: 'private' }, message_id: mid, user: { id: JOEY, is_bot: false }, date: Math.floor(Date.now() / 1000),
      old_reaction: [], new_reaction: [{ type: 'emoji', emoji: '❤' }, { type: 'custom_emoji', custom_emoji_id: '555' }] } })
    await until(() => onsen.reactions.length === 1, 3000, 'reaction written')
    expect(onsen.reactions[0]).toMatchObject({ member: 'gamma', chat, client_msg_id: String(mid), client_user_id: chat, emojis: ['❤', 'custom:555'] })
    tg.push(TOK, { message_reaction: { chat: { id: 99, type: 'private' }, message_id: 1, user: { id: 99, is_bot: false }, date: 1, old_reaction: [], new_reaction: [{ type: 'emoji', emoji: '👎' }] } })
    await until(() => tg.unconfirmed(TOK) === 0, 4000, 'confirmed')
    expect(onsen.reactions.length).toBe(1)
    expect(tg.callsOf(TOK, 'getUpdates').at(-1).allowed_updates).toContain('message_reaction')
  }, T)

  test('groups: a mention goes in with the group as its chat (a stranger as a guest); no mention, dropped; nothing answered in the group; out to the group, an echo names who', async () => {
    const g = { id: GROUP, type: 'supergroup', title: 'Lab' }
    const before = onsen.messages.length
    tg.push(TOK, { message: { message_id: 501, from: { id: JOEY, is_bot: false, first_name: 'Joey' }, chat: g, date: Math.floor(Date.now() / 1000), text: 'no mention here' } })
    tg.push(TOK, { message: { message_id: 502, from: { id: JOEY, is_bot: false, first_name: 'Joey' }, chat: g, date: Math.floor(Date.now() / 1000), text: '@gamma_bot look', entities: [{ type: 'mention', offset: 0, length: 10 }] } })
    tg.push(TOK, { message: { message_id: 503, from: { id: GUEST, is_bot: false, first_name: 'Guest' }, chat: g, date: Math.floor(Date.now() / 1000), text: '@gamma_bot hi', entities: [{ type: 'mention', offset: 0, length: 10 }] } })
    await until(() => tg.unconfirmed(TOK) === 0, 5000, 'all done')
    const inGroup = onsen.messages.slice(before)
    expect(inGroup.map(x => [x.client_msg_id, x.chat])).toEqual([['502', String(GROUP)], ['503', String(GROUP)]])
    expect(onsen.identities.get(String(GUEST))).toBe(`tg-${GUEST}`)                            // Onsen made the stranger a guest
    expect(tg.sentTo(TOK, String(GROUP)).length).toBe(0)
    onsen.push({ ...msgItem('g1', 'to the group'), chat: String(GROUP) })
    onsen.push({ ...msgItem('g2', '網頁上說的'), chat: String(GROUP), origin_client: 'onsen', message: { id: 'g2', from: 'joey', type: 'message', body: { format: 'markdown', text: '網頁上說的' }, attachments: [] } })
    await until(() => onsen.reports.some(r => r.id === 'g2'), 3000, 'group drawn')
    const out = tg.sentTo(TOK, String(GROUP))
    expect(out.map(s => s.markdown)).toEqual(['to the group', '〔Joey 在 Onsen 傳的〕\n\n網頁上說的'])
    // no pinned status in a group
    onsen.push({ type: 'observation', member: 'gamma', conversation_id: 'cv', chat: String(GROUP), status: { presence: 'online', sessions: [] } })
    await Bun.sleep(400)
    expect(tg.bots.get(TOK)!.pinned.has(String(GROUP))).toBe(false)
    expect(onsen.bad).toEqual([])
    for (const l of logs) expect(l.includes(TOK.split(':')[1]!)).toBe(false)
  }, T)

  test('client_meta: a reply to a file, a forward, a voice note, an album → exactly the tag attributes the daemon writes', async () => {
    const now = Math.floor(Date.now() / 1000), from = { id: JOEY, is_bot: false, first_name: 'Joey', username: 'joey' }, dm = { id: JOEY, type: 'private' }
    tg.files.set('f/DOC7', new Uint8Array([1, 2, 3])); tg.files.set('f/VO1', new Uint8Array([4, 5, 6])); tg.files.set('f/P1', new Uint8Array([7, 8, 9]))
    tg.push(TOK, { message: { message_id: 801, from, chat: dm, date: now, text: 'see this', reply_to_message: { message_id: 700, from: { id: 555, is_bot: false, first_name: 'Ann', username: 'ann' },
      chat: dm, date: now - 60, caption: 'the pdf', document: { file_id: 'DOC7', file_unique_id: 'd7', file_name: 'a.pdf', mime_type: 'application/pdf', file_size: 3 } } } })
    tg.push(TOK, { message: { message_id: 802, from, chat: dm, date: now, text: 'fwd', forward_origin: { type: 'channel', chat: { id: -100555, type: 'channel', title: 'News', username: 'newsch' }, message_id: 42, date: now - 3600 } } })
    tg.push(TOK, { message: { message_id: 803, from, chat: dm, date: now, voice: { file_id: 'VO1', file_unique_id: 'v1', duration: 2, mime_type: 'audio/ogg', file_size: 3 } } })
    tg.push(TOK, { message: { message_id: 804, from, chat: dm, date: now, media_group_id: 'AL1', caption: 'two', photo: [{ file_id: 'P1', file_unique_id: 'p1', file_size: 3 }] } })
    tg.push(TOK, { message: { message_id: 805, from, chat: dm, date: now, media_group_id: 'AL1', photo: [{ file_id: 'P2GONE', file_unique_id: 'p2', file_size: 3 }] } })
    tg.push(TOK, { message: { message_id: 806, from, chat: dm, date: now, text: 'plain' } })
    // Chiron 15:40Z: a voice note with a caption keeps the caption as its text; the transcript only in client_meta
    tg.files.set('f/VO2', new Uint8Array([4, 5, 7]))
    tg.push(TOK, { message: { message_id: 807, from, chat: dm, date: now, caption: '聽這段', voice: { file_id: 'VO2', file_unique_id: 'v2', duration: 2, mime_type: 'audio/ogg', file_size: 3 } } })
    await until(() => ['801', '802', '803', '804', '805', '806', '807'].every(id => onsen.messages.some(x => x.client_msg_id === id)), 8000, 'all six written')
    const w = (id: string) => onsen.messages.find(x => x.client_msg_id === id)
    expect(w('801').client_meta).toEqual({ reply_to_user_id: '555', attachment_origin: 'reply' })
    expect(w('801')).toMatchObject({ kind: 'text', text: 'see this', reply_to_client_msg_id: '700', reply_to_user: 'ann', reply_to_text: 'the pdf',
      attachments: [{ kind: 'document', name: 'a.pdf', mime: 'application/pdf', bytes: 3, client_ref: 'DOC7' }] })
    expect(w('801').attachment_file_ids.length).toBe(1)                                         // the replied-to file, stored in Onsen
    expect(w('802').client_meta).toEqual({ forward_origin: 'channel', forward_from_id: '-100555', forward_from_username: 'newsch', forward_channel_message_id: '42' })
    expect(w('802').forward_from).toBe('News')                                                   // the tag's value: the channel's title (Chiron 15:40Z)
    expect(w('803').client_meta).toEqual({ voice_transcript: '你好，看一下' })
    expect(w('803')).toMatchObject({ kind: 'voice', text: '你好，看一下' })
    expect(w('807')).toMatchObject({ kind: 'voice', text: '聽這段' })
    expect(w('807').client_meta).toEqual({ voice_transcript: '你好，看一下' })
    expect(w('804').client_meta).toEqual({ media_group_count: '2' })
    expect(w('805').client_meta).toEqual({ media_group_count: '2', image_error: 'download failed' })
    expect('client_meta' in w('806')).toBe(false)                                                // nothing beyond the named fields: none sent
    for (const id of ['801', '802', '803', '804', '805']) expect(new TextEncoder().encode(JSON.stringify(w(id).client_meta)).length).toBeLessThanOrEqual(4096)
    expect(onsen.bad).toEqual([])
  }, T)

  test('an Onsen that does not take client_meta yet (400 naming it): the message goes again without it, and none is sent for 5 min', async () => {
    onsen.refuseClientMeta = true
    const now = Math.floor(Date.now() / 1000), from = { id: JOEY, is_bot: false, first_name: 'Joey' }, dm = { id: JOEY, type: 'private' }
    const fwd = (id: number) => ({ message: { message_id: id, from, chat: dm, date: now, text: 'f', forward_origin: { type: 'user', sender_user: { id: 777, is_bot: false, first_name: 'O', username: 'orig' }, date: now } } })
    tg.push(TOK, fwd(901))
    await until(() => onsen.messages.some(x => x.client_msg_id === '901'), 4000, '901 written')
    expect('client_meta' in onsen.messages.find(x => x.client_msg_id === '901')).toBe(false)
    expect(b.clientMeta.offUntil).toBeGreaterThan(Date.now() + 200_000)
    tg.push(TOK, fwd(902))
    await until(() => onsen.messages.some(x => x.client_msg_id === '902'), 4000, '902 written')
    expect(logs.filter(l => l.includes('does not take client_meta')).length).toBe(1)
    await until(() => tg.callsOf(TOK, 'setMessageReaction').some(p => p.message_id === 902), 3000, '👀 on 902')
    onsen.refuseClientMeta = false; b.clientMeta.offUntil = 0
    tg.push(TOK, fwd(903))
    await until(() => onsen.messages.some(x => x.client_msg_id === '903'), 4000, '903 written')
    expect(onsen.messages.find(x => x.client_msg_id === '903').client_meta).toEqual({ forward_origin: 'user', forward_from_id: '777', forward_from_username: 'orig' })
    expect(onsen.messages.find(x => x.client_msg_id === '903').forward_from).toBe('orig')                 // displayName() as the daemon's tag (its @username first)
  }, T)
})
