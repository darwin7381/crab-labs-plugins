// WO-197 segment 1, against a real daemon (server.ts), the Bot API stand-in and the Onsen stand-in (its bridge simulated): an agent named in
// ONSEN_BRIDGE starts without a bot token, never polls, makes no Bot API call at all (the stand-in sees none), and says, reacts and edits only in
// Onsen (POST /v1/messages with conversation_id; the bridge's report gives `sent (id: …)`, none in 3 s gives the held sentence). 1.59.0: the list is
// no switch for the daemon any more (the 1.58.x test 7, taken off the list → polls again, named while polling → the poll stops, is gone with it).
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startOnsenStandin, type OnsenStandin } from './test-fixtures/onsen-standin.ts'
import { startTgDaemon, freePort, until, sleep, type TgDaemon } from './test-fixtures/tg-daemon.ts'
import { HELD } from './onsen-connector.ts'

const JOEY = 1828
const CRED = { c: 'mesh_CONNECTORsecretSECRETsecretSECRET01', s: 'mesh_CONNECTORswitchSECRETsecretSECRET1' }
let root = '', api: BotApiMock, onsen: OnsenStandin, d: TgDaemon
const health = (x: TgDaemon) => fetch(`http://127.0.0.1:${x.port}/healthz`).then(r => r.json()) as Promise<any>

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'onsen-connector-daemon-'))
  onsen = startOnsenStandin({ [CRED.c]: 'c', [CRED.s]: 's' }, await freePort())
  for (const w of ['c', 's']) onsen.st.version[w] = '0.35.3'
  writeFileSync(join(root, 'cred-c'), CRED.c + '\n'); writeFileSync(join(root, 'cred-s'), CRED.s + '\n')
  api = startBotApiMock({}, { pollHoldMs: 200 })
  const env = { ONSEN_BASE: `http://127.0.0.1:${onsen.port}/api/onsen`, ONSEN_PEER_LOOKUP: '0', ONSEN_CLAUDE_BIN: '/nonexistent/claude', ONSEN_BRIDGE_RETRY_MS: '50,50' }
  // named in the plist, no token: a connector from the start (1.59.0: a connector named or not)
  d = await startTgDaemon(api, join(root, 'c'), JOEY, { ...env, GENESIS_LANES: '0', TELEGRAM_BOT_TOKEN: '', ONSEN_BRIDGE: 'lab-relay, adam', ONSEN_OWNER: 'joey', ONSEN_CREDENTIAL_FILE: join(root, 'cred-c'),
    TELEGRAM_ALBUM_CAP_MS: '3000' })
}, 60000)
afterAll(async () => { await d?.stop(); api?.stop(); onsen?.stop() })

test('1. named, no token: it starts; /healthz has the agent and connector on; not polling; the Bot API stand-in sees no call at all', async () => {
  const h = await health(d)
  expect(h.agent).toBe('adam')
  expect(h.bot_username).toBe(null)
  expect(h.polling).toBe(false)
  expect(h.connector.on).toBe(true)
  expect(h.connector.token).toBe(false)
  await sleep(500)
  expect(api.calls).toEqual([])
  expect(api.polls).toEqual([])
})

test('2. reply: one Onsen message with conversation_id (no client / chat / delivery), reply_to as Onsen\'s id; the bridge\'s numbers answer as before', async () => {
  const heard = onsen.heard('c', String(JOEY), 950, '你好')
  onsen.st.bridge.c = { on: true, delayMs: 100, next: 960 }
  const r = await d.call('reply', { chat_id: String(JOEY), text: '收到', reply_to: '950' })
  expect(r).toEqual({ text: 'sent (id: 960)', isError: false })
  const w = onsen.connector.filter(x => x.who === 'c' && x.kind === 'message').at(-1)!.body
  expect(w.conversation_id).toBe(onsen.conv(String(JOEY)))
  expect(w.reply_to_message_id).toBe(String(heard))
  expect(w.body).toBe('收到')
  expect(w.sender).toBe('main')
  for (const k of ['client', 'chat', 'delivery', 'client_msg_id', 'agent']) expect(k in w).toBe(false)
  // a long reply is one Onsen message; the bridge's two numbers come back
  const long = 'x'.repeat(4500)
  expect((await d.call('reply', { chat_id: String(JOEY), text: long, format: 'text' })).text).toBe('sent 2 parts (ids: 961, 962)')
  expect(onsen.connector.filter(x => x.who === 'c' && x.kind === 'message').at(-1)!.body.body).toBe(long)
  expect(api.calls).toEqual([]); expect(api.polls).toEqual([])
})

test('3. reply with two files: stored in Onsen first, attachment_file_ids on the one message', async () => {
  const a = join(root, 'a.png'), b = join(root, 'b.pdf')
  writeFileSync(a, new Uint8Array([0x89, 0x50, 0x4e, 0x47])); writeFileSync(b, new Uint8Array([0x25, 0x50, 0x44, 0x46]))
  const r = await d.call('reply', { chat_id: String(JOEY), text: '兩個檔', files: [a, b] })
  expect(r.isError).toBe(false)
  expect(r.text).toMatch(/^sent 3 parts \(ids: \d+, \d+, \d+\)$/)
  const w = onsen.connector.filter(x => x.who === 'c' && x.kind === 'message').at(-1)!.body
  expect(w.attachment_file_ids.length).toBe(2)
  expect(w.attachments.map((x: any) => x.name)).toEqual(['a.png', 'b.pdf'])
  expect(api.calls).toEqual([])
})

test('4. the bridge not reporting in 3 s (here 3 s): the held sentence, not an error; written once', async () => {
  onsen.st.bridge.c = { on: false, delayMs: 50, next: 980 }
  const n = onsen.connector.length
  const r = await d.call('reply', { chat_id: String(JOEY), text: '橋接關著' })
  expect(r).toEqual({ text: HELD, isError: false })
  expect(onsen.connector.length).toBe(n + 1)
  onsen.bridgeOn('c')                                     // the bridge comes back: it draws what waited
  const id = onsen.connector.at(-1)!.id
  expect(await until(() => onsen.msgs.find(m => m.id === id)?.delivery?.state === 'sent', 3000)).toBe(true)
})

test('5. react and edit_message: the Telegram number turned into the Onsen message; Telegram\'s reaction set checked in the tool', async () => {
  onsen.st.bridge.c = { on: true, delayMs: 50, next: 990 }
  expect(await d.call('react', { chat_id: String(JOEY), message_id: '950', emoji: '👍' })).toEqual({ text: 'reacted', isError: false })
  const heard = onsen.msgs.find(m => m.who === 'c' && m.aliases.includes('950'))!.id
  expect(onsen.connector.at(-1)).toMatchObject({ kind: 'reaction', id: heard, body: { emojis: ['👍'] } })
  const bad = await d.call('react', { chat_id: String(JOEY), message_id: '950', emoji: '✅' })
  expect(bad.isError).toBe(true)
  expect(bad.text).toMatch(/REACTION_INVALID/)
  const said = await d.call('reply', { chat_id: String(JOEY), text: '舊的字' })
  const tg = said.text.match(/id: (\d+)/)![1]!
  expect((await d.call('edit_message', { chat_id: String(JOEY), message_id: tg, text: '新的字' })).text).toBe(`edited (id: ${tg})`)
  const mine = onsen.msgs.find(m => m.who === 'c' && m.aliases.includes(tg))!.id
  expect(onsen.connector.at(-1)).toMatchObject({ kind: 'edit', id: mine, body: { text: '新的字' } })
  expect(api.calls).toEqual([]); expect(api.polls).toEqual([])
})

test('6. chat_id onsen:<conversation id> (a person with no app account): written there, answered with the Onsen id', async () => {
  const r = await d.call('reply', { chat_id: 'onsen:4242', text: '只在 Onsen' })
  expect(r.isError).toBe(false)
  expect(r.text).toMatch(/^sent \(id: onsen:\d+\)$/)
  expect(onsen.connector.at(-1)!.body.conversation_id).toBe('4242')
})

type Got = { content: string; meta: Record<string, string> }
const got: Got[] = []
const person = async (payload: Record<string, unknown>, seq: number) => (await fetch(`http://127.0.0.1:${d.port}/onsen/person`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'person_message', seq, dedupe: `pm:${payload.message_id}`, payload }) })).status
const fileOf = (key: string, bytes: number[]) => { onsen.files.set(`c:${key}`, { id: String(8000 + onsen.files.size), bytes: new Uint8Array(bytes), at: Date.now() }); return onsen.files.get(`c:${key}`)!.id }

test('8. a person\'s Telegram message comes as a person_message (the bridge wrote it): delivered with its tag; its photo taken from Onsen, not Telegram; no 👀', async () => {
  const c = await d.client()
  c.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') got.push({ content: String((n.params as any).content), meta: (n.params as any).meta }) }
  writeFileSync(join(d.stateDir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [String(JOEY)], groups: {}, pending: {}, ackReaction: '👀' }))
  const fid = fileOf('photo1', [0xff, 0xd8, 0xff, 1])
  const base = `http://127.0.0.1:${onsen.port}/api/onsen/v1/files/`
  expect(await person({ message_id: '6001', conversation_id: onsen.conv(String(JOEY)), from: 'joey', via: 'telegram', text: '看這張', kind: 'photo', sent_at: new Date().toISOString(),
    attachments: [{ kind: 'photo', name: 'p.jpg', mime: 'image/jpeg', bytes: 4, url: base + fid, client_ref: 'AgPhoto1' }],
    client: { name: 'telegram', chat: String(JOEY), msg_id: '1001', user: 'joey', user_id: String(JOEY) }, reply_to: null }, 1)).toBe(200)
  expect(await until(() => got.some(g => g.meta.message_id === '1001'), 8000)).toBe(true)
  const g = got.find(x => x.meta.message_id === '1001')!
  expect(g.meta.chat_id).toBe(String(JOEY))
  expect(g.meta.image_path).toBeTruthy()
  expect(onsen.seen.some(s => s.method === 'GET' && s.path === `/v1/files/${fid}`)).toBe(true)
  // a PDF: download_attachment by its Telegram file id takes it from Onsen; one Onsen never had: 「檔案不在 Onsen」
  const pid = fileOf('pdf1', [0x25, 0x50, 0x44, 0x46])
  expect(await person({ message_id: '6002', conversation_id: onsen.conv(String(JOEY)), from: 'joey', via: 'telegram', text: '', kind: 'document', sent_at: new Date().toISOString(),
    attachments: [{ kind: 'document', name: 'r.pdf', mime: 'application/pdf', bytes: 4, url: base + pid, client_ref: 'BQDoc1' }],
    client: { name: 'telegram', chat: String(JOEY), msg_id: '1002', user: 'joey', user_id: String(JOEY) }, reply_to: null }, 2)).toBe(200)
  expect(await until(() => got.some(g => g.meta.message_id === '1002'), 8000)).toBe(true)
  expect(got.find(x => x.meta.message_id === '1002')!.meta.attachment_file_id).toBe('BQDoc1')
  const dl = await d.call('download_attachment', { file_id: 'BQDoc1' })
  expect(dl.isError).toBe(false)
  expect([...new Uint8Array(await Bun.file(dl.text).arrayBuffer())]).toEqual([0x25, 0x50, 0x44, 0x46])
  const none = await d.call('download_attachment', { file_id: 'BQnever' })
  expect(none.isError).toBe(true)
  expect(none.text).toMatch(/檔案不在 Onsen/)
  expect(api.calls).toEqual([]); expect(api.polls).toEqual([]); expect(api.downloads).toEqual([])
})

test('9. a person with no app account (client null): the tag\'s chat_id is onsen:<conversation>, its number form-<id>; the reply goes back there', async () => {
  expect(await person({ message_id: '6003', conversation_id: '4243', from: 'guest-1', via: 'web', text: '我只用網頁', kind: 'text', sent_at: new Date().toISOString(),
    attachments: [], client: null, reply_to: null }, 3)).toBe(200)
  expect(await until(() => got.some(g => g.meta.chat_id === 'onsen:4243'), 8000)).toBe(true)
  expect(got.find(g => g.meta.chat_id === 'onsen:4243')!.meta.message_id).toBe('form-6003')
  expect((await d.call('reply', { chat_id: 'onsen:4243', text: '收到' })).isError).toBe(false)
  expect(onsen.connector.at(-1)!.body.conversation_id).toBe('4243')
})

test('10. a permission prompt: only the Action (no Telegram message); the Bot API stand-in still saw nothing', async () => {
  const c = await d.client()
  await c.notification({ method: 'notifications/claude/channel/permission_request', params: { request_id: 'abcde', tool_name: 'Bash', description: 'run ls', input_preview: '{"command":"ls"}' } })
  expect(await until(() => onsen.seen.some(s => s.method === 'POST' && s.path === '/v1/actions' && s.body?.source === 'permission'), 8000)).toBe(true)
  await sleep(500)
  expect(api.calls).toEqual([]); expect(api.polls).toEqual([])
  expect((await health(d)).connector.bot_api_refused).toEqual({})
})

test('11. client.meta (the bridge\'s client_meta): every key an attribute of the tag as is; over what the tag derived (Chiron 16:1xZ, rule A), a new key last; never chat_id; none: nothing added', async () => {
  const base = { conversation_id: onsen.conv(String(JOEY)), from: 'joey', via: 'telegram', kind: 'text', attachments: [], reply_to: null }
  expect(await person({ ...base, message_id: '6011', text: '帶 meta', sent_at: new Date().toISOString(),
    client: { name: 'telegram', chat: String(JOEY), msg_id: '1011', user: 'joey', user_id: String(JOEY), meta: { a: '1', b: 'x y', chat_id: 'not-this', user: 'joey_tg' } } }, 11)).toBe(200)
  expect(await person({ ...base, message_id: '6012', text: '沒有 meta', sent_at: new Date().toISOString(),
    client: { name: 'telegram', chat: String(JOEY), msg_id: '1012', user: 'joey', user_id: String(JOEY) } }, 12)).toBe(200)
  expect(await until(() => got.some(g => g.meta.message_id === '1011') && got.some(g => g.meta.message_id === '1012'), 8000)).toBe(true)
  const withMeta = got.find(g => g.meta.message_id === '1011')!.meta, without = got.find(g => g.meta.message_id === '1012')!.meta
  expect(withMeta.a).toBe('1')
  expect(withMeta.b).toBe('x y')
  expect(withMeta.chat_id).toBe(String(JOEY))
  expect(withMeta.user).toBe('joey_tg')                       // derived from Onsen's client.user: the bridge's value wins (a87d381 kept the tag's)
  expect(without.user).toBe('joey')
  expect(Object.keys(withMeta).slice(-2)).toEqual(['a', 'b'])
  expect(Object.keys(withMeta).filter(k => !(k in without)).sort()).toEqual(['a', 'b'])
})

test('12. attachment_name as the path before has it: a voice note, a video note and a sticker carry none (Onsen\'s file_7.oga is Telegram\'s own name); a PDF, an audio file keep theirs', async () => {
  const base = { conversation_id: onsen.conv(String(JOEY)), from: 'joey', via: 'telegram', reply_to: null, sent_at: new Date().toISOString() }
  const cl = (n: string) => ({ name: 'telegram', chat: String(JOEY), msg_id: n, user: 'joey', user_id: String(JOEY) })
  const url = `http://127.0.0.1:${onsen.port}/api/onsen/v1/files/`
  const sent: Array<[string, Record<string, unknown>]> = [
    ['1021', { kind: 'voice', text: '', attachments: [{ kind: 'voice', name: 'file_7.oga', mime: 'audio/ogg', bytes: 4, url: url + 'v', client_ref: 'AwVoice1' }] }],
    ['1022', { kind: 'video', text: '', attachments: [{ kind: 'video', name: 'file_9.mp4', mime: 'video/mp4', bytes: 4, url: url + 'n', client_ref: 'DQNote1' }] }],
    ['1023', { kind: 'sticker', text: '', attachments: [{ kind: 'photo', name: '👍', mime: 'image/webp', bytes: 4, url: url + 's', client_ref: 'CAStick1' }] }],
    ['1024', { kind: 'document', text: '', attachments: [{ kind: 'document', name: 'r.pdf', mime: 'application/pdf', bytes: 4, url: url + 'p', client_ref: 'BQDoc2' }] }],
    ['1025', { kind: 'voice', text: '', attachments: [{ kind: 'voice', name: 'song.mp3', mime: 'audio/mpeg', bytes: 4, url: url + 'a', client_ref: 'CQAudio1' }] }],
  ]
  for (const [i, [n, p]] of sent.entries()) expect(await person({ ...base, ...p, message_id: String(6021 + i), client: cl(n) }, 21 + i)).toBe(200)
  expect(await until(() => sent.every(([n]) => got.some(g => g.meta.message_id === n)), 8000)).toBe(true)
  const tag = (n: string) => got.find(g => g.meta.message_id === n)!
  const voice = tag('1021').meta
  expect(voice.attachment_kind).toBe('voice')
  expect(voice.attachment_file_id).toBe('AwVoice1')
  expect(voice.attachment_mime).toBe('audio/ogg')
  expect('attachment_name' in voice).toBe(false)
  expect(tag('1021').content).toBe('(voice message)')
  expect('attachment_name' in tag('1022').meta).toBe(false)
  const st = tag('1023')
  expect(st.meta.attachment_kind).toBe('sticker')
  expect(st.meta.attachment_file_id).toBe('CAStick1')
  expect('attachment_name' in st.meta || 'attachment_mime' in st.meta || 'image_path' in st.meta).toBe(false)
  expect(st.content).toBe('(sticker 👍)')
  expect(tag('1024').meta.attachment_name).toBe('r.pdf')
  expect(tag('1024').content).toBe('(document: r.pdf)')
  expect(tag('1025').meta.attachment_name).toBe('song.mp3')
  expect(api.calls).toEqual([]); expect(api.downloads).toEqual([])
})

test('13. rule A (Chiron 16:1xZ): client_meta.reply_to_user "awesometon5" over Onsen\'s reply_to.from "joey-test"; the routing and identity attributes (chat_id, message_id, ts, topic, user_id, source) never taken from it', async () => {
  expect(await person({ conversation_id: onsen.conv(String(JOEY)), from: 'joey', via: 'telegram', kind: 'text', attachments: [], message_id: '6031', text: '回你那則',
    sent_at: new Date().toISOString(), reply_to: { message_id: '6011', client_msg_id: '1011', from: 'joey-test', text: '帶 meta' },
    client: { name: 'telegram', chat: String(JOEY), msg_id: '1031', user: 'joey', user_id: String(JOEY),
      meta: { reply_to_user: 'awesometon5', reply_to_user_id: '6736970916', chat_id: '999', message_id: '1', ts: '2000-01-01T00:00:00.000Z', topic: '77', user_id: '4242', source: 'x' } } }, 31)).toBe(200)
  expect(await until(() => got.some(g => g.meta.message_id === '1031'), 8000)).toBe(true)
  const m = got.find(g => g.meta.message_id === '1031')!.meta
  expect(m.reply_to_user).toBe('awesometon5')
  expect(m.reply_to_user_id).toBe('6736970916')
  expect(m.reply_to_message_id).toBe('1011')
  expect(m.chat_id).toBe(String(JOEY))
  expect(m.user_id).toBe(String(JOEY))
  expect(m.ts).not.toBe('2000-01-01T00:00:00.000Z')
  expect('topic' in m || 'source' in m).toBe(false)
  // a reply to it goes where the message is, whatever client_meta said
  expect((await d.call('reply', { chat_id: m.chat_id, text: '收到', reply_to: m.message_id })).isError).toBe(false)
  expect(onsen.connector.at(-1)!.body.conversation_id).toBe(onsen.conv(String(JOEY)))
})

test('14. an album whose count is known (client_meta.media_group_count 3) and only 2 items come: not flushed at the 1.5 s window, flushed at the cap with the 2; rule A: media_group_count is the bridge\'s 3, the files stay positional', async () => {
  const base = `http://127.0.0.1:${onsen.port}/api/onsen/v1/files/`
  const one = (i: number, meta?: Record<string, string>) => ({ conversation_id: onsen.conv(String(JOEY)), from: 'joey', via: 'telegram', text: '', kind: 'photo',
    sent_at: new Date().toISOString(), reply_to: null, media_group_id: 'mg-14', message_id: String(6040 + i),
    attachments: [{ kind: 'photo', name: null, mime: 'image/jpeg', bytes: 4, url: base + fileOf(`alb${i}`, [0xff, 0xd8, 0xff, i]), client_ref: `AgAlb${i}` }],
    client: { name: 'telegram', chat: String(JOEY), msg_id: String(1040 + i), user: 'joey', user_id: String(JOEY), ...(meta ? { meta } : {}) } })
  const t0 = Date.now()
  expect(await person(one(1, { media_group_count: '3' }), 41)).toBe(200)
  expect(await person(one(2, { media_group_count: '3' }), 42)).toBe(200)
  await sleep(2000)
  expect(got.filter(g => g.meta.media_group_id === 'mg-14')).toHaveLength(0)          // the window (1.5 s) is not what ends a known album
  expect(await until(() => got.some(g => g.meta.media_group_id === 'mg-14'), 8000)).toBe(true)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(2900)                                    // the cap (3 s here; 10 s by default) from the first item
  await sleep(500)
  const albums = got.filter(g => g.meta.media_group_id === 'mg-14')
  expect(albums.length).toBe(1)
  expect(albums[0]!.meta.media_group_count).toBe('3')
  expect(albums[0]!.meta.image_path).toBeTruthy()
  expect(albums[0]!.meta.image_path_2).toBeTruthy()
  expect('image_path_3' in albums[0]!.meta).toBe(false)
  expect(albums[0]!.content).toBe('(album: 2 photos)')
  expect(d.log()).toContain(`album ${JOEY}:mg-14: 2 of 3 item(s) in 3 s after the first; delivered with what came`)
})

test('15. WO-197 (Chiron 18:46Z): a forward whose origin Onsen gives in the daemon\'s one-line form (tg:<id> @user Name) is tagged with the name the tag shows', async () => {
  expect(await person({ conversation_id: onsen.conv(String(JOEY)), from: 'joey', via: 'telegram', kind: 'text', attachments: [], message_id: '6051', text: '轉給你',
    sent_at: new Date().toISOString(), reply_to: null, forward_from: 'tg:6736970916 @awesometon5 awesometon5', forward_date: '2026-11-26T16:31:53Z',
    client: { name: 'telegram', chat: String(JOEY), msg_id: '1051', user: 'joey', user_id: String(JOEY) } }, 51)).toBe(200)
  expect(await until(() => got.some(g => g.meta.message_id === '1051'), 8000)).toBe(true)
  const m = got.find(g => g.meta.message_id === '1051')!.meta
  expect(m.forward_from).toBe('awesometon5')
  expect(m.forward_date).toBe('2026-11-26T16:31:53.000Z')
})
