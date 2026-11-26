// WO-194 end to end (the ticket's acceptance 1–5 and 7, lanes off; 3's routing and 6 with lanes on): real Telegram daemons (server.ts) and a real
// agent-inbox daemon against Bot API stand-ins and one stand-in Onsen 0.34.2 (test-fixtures/onsen-standin.ts: WO-193's deliver, inbox, person_edit;
// nothing reaches core.kbro.ai or Telegram), in temp dirs (their HOME too).
//   off   no switch: the path before (recorded through the spool, delivered here)
//   on    ONSEN_INBOUND=adam: written into Onsen (deliver), 👀 after; the agent-inbox daemon (ONSEN_PULL) takes the person_message and hands it to the
//         Telegram daemon (POST /onsen/person), which delivers it
// Each inbound goes to both (the same update to each Bot API stand-in); the <channel> tag each session gets is compared: identical (image paths
// compared without their directory and time prefix).
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, dm, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, freePort, sleep, type TgDaemon } from './test-fixtures/tg-daemon.ts'
import { startOnsenStandin, type OnsenStandin } from './test-fixtures/onsen-standin.ts'
import { heldText } from './onsen-inbound.ts'

const JOEY = 1828
/** A.1's 20 s, shortened for `on` (its agent-inbox answers within ~1 s here) */
const BACK = 4000
const CRED = { on: 'mesh_INBOUNDonSECRETsecretSECRETsecret01', off: 'mesh_INBOUNDoffSECRETsecretSECRETsecret1', lanes: 'mesh_INBOUNDlanesSECRETsecretSECRETsec1' }
type Got = { at: number; content: string; meta: Record<string, string> }
let onsen: OnsenStandin, root = '', apiOn: BotApiMock, apiOff: BotApiMock, apiLanes: BotApiMock, on: TgDaemon, off: TgDaemon, lanes: TgDaemon
const got: Record<string, Got[]> = { on: [], off: [] }
const procs: Array<{ kill(): void }> = []
const inboxProc: Record<string, { kill(): void; exited: Promise<number> }> = {}
let inboxLog = () => ''

async function bootInbox(name: string, cred: string, tgPort: number, extra: Record<string, string> = {}): Promise<() => string> {
  const home = join(root, name, 'ihome'), ws = join(root, name, 'iws'), stateDir = join(ws, '.agent-inbox-state')
  for (const d of [home, ws, stateDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(stateDir, 'mesh-credential'), cred + '\n')
  const port = await freePort()
  const proc = Bun.spawn(['bun', join(import.meta.dir, 'server.ts')], {
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? '', HOME: home, CHANNEL_INBOX_ONLY: '1', TELEGRAM_HTTP_PORT: String(port), TELEGRAM_STATE_DIR: stateDir, AGENT_WORKSPACE_DIR: ws,
      MCP_READY_DELAY_MS: '200', CRAB_LABS_PLUGINS_ENV: join(root, 'no-machine-config'), HUB_SYNC: '0', USAGE_WALL_READ: '0', TYPESAFE_KEY_FILE: '/nonexistent/typesafe.env',
      MESH_CREDENTIALS_TABLE: join(root, 'mesh-credentials.json'), ONSEN_BASE: `http://127.0.0.1:${onsen.port}/api/onsen`, ONSEN_PULL_WAIT_S: '1', ONSEN_PULL_BACKOFF_MS: '150',
      ONSEN_HOST: 'lab-host', MCP_TOKEN_DIR: join(root, name, 'tok'), AGENT_INBOX_REGISTRY: join(root, 'registry.json'), AGENT_INBOX_SELF: 'adam', ONSEN_PULL: 'adam',
      LANES_TG_PORT: String(tgPort), ...extra },
    stdout: 'ignore', stderr: 'ignore',
  })
  procs.push(proc); inboxProc[name] = proc
  const health = () => fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.json()).catch(() => null) as Promise<any>
  if (!await until(async () => (await health())?.ok === true, 20000)) throw new Error(`inbox daemon ${name} did not start`)
  return () => { try { return readFileSync(join(stateDir, 'server.log'), 'utf8') } catch { return '' } }
}
async function listen(d: TgDaemon, into: Got[]): Promise<void> {
  const c = await d.client()
  c.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') into.push({ at: Date.now(), content: String((n.params as any).content), meta: (n.params as any).meta }) }
}
function ack(d: TgDaemon): void {
  const f = join(d.stateDir, 'access.json')
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ackReaction: '👀' }))
}

beforeAll(async () => {
  onsen = startOnsenStandin({ [CRED.on]: 'on', [CRED.off]: 'off', [CRED.lanes]: 'lanes' }, await freePort())
  for (const w of ['on', 'off', 'lanes']) onsen.st.version[w] = '0.34.2'
  root = mkdtempSync(join(tmpdir(), 'onsen-inbound-daemon-'))
  mkdirSync(join(root, 'cred'), { recursive: true })
  for (const [k, v] of Object.entries(CRED)) writeFileSync(join(root, 'cred', k), v + '\n')
  writeFileSync(join(root, 'mesh-credentials.json'), JSON.stringify({ identities: {}, hashes: {} }))
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ adam: { url: 'http://127.0.0.1:9/inject' } }))
  const tx = join(root, 'transcribe.sh')
  writeFileSync(tx, '#!/bin/sh\necho "語音的逐字稿：明天開會"\n'); chmodSync(tx, 0o755)
  apiOn = startBotApiMock({}, { pollHoldMs: 200 }); apiOff = startBotApiMock({}, { pollHoldMs: 200 }); apiLanes = startBotApiMock({}, { pollHoldMs: 200 })
  const env = { ONSEN_BASE: `http://127.0.0.1:${onsen.port}/api/onsen`, ONSEN_PEER_LOOKUP: '0', ONSEN_CLAUDE_BIN: '/nonexistent/claude',
    CHANNEL_BOT_VOICE_TRANSCRIBE: '1', CHANNEL_BOT_TRANSCRIBE_CMD: tx, ONSEN_INBOUND_RETRY_MS: '100,100,100', ONSEN_INBOUND_HELD_MS: '1500', ONSEN_INBOUND_LATER_MS: '300' }
  ;[on, off, lanes] = await Promise.all([
    startTgDaemon(apiOn, join(root, 'on'), JOEY, { ...env, GENESIS_LANES: '0', ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'on'), ONSEN_INBOUND: 'someone, adam', ONSEN_INBOUND_BACK_MS: String(BACK) }),
    startTgDaemon(apiOff, join(root, 'off'), JOEY, { ...env, GENESIS_LANES: '0', ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'off') }),
    startTgDaemon(apiLanes, join(root, 'lanes'), JOEY, { ...env, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'lanes'), ONSEN_INBOUND: '*' }),
  ])
  for (const d of [on, off, lanes]) ack(d)
  inboxLog = await bootInbox('on', CRED.on, on.port)
  await bootInbox('lanes', CRED.lanes, lanes.port)
  await listen(on, got.on); await listen(off, got.off)
  // the files behind the Telegram ids the inbounds below carry (getFile → /file/bot<token>/<path>), on both stand-ins
  for (const api of [apiOn, apiOff]) {
    for (const i of [1, 2, 3]) api.files.set(`ph${i}`, { path: `photos/p${i}.jpg`, bytes: new Uint8Array([0xff, 0xd8, i]) })
    api.files.set('ph-root', { path: 'photos/root.jpg', bytes: new Uint8Array([0xff, 0xd8, 9]) })
    api.files.set('voice1', { path: 'voice/v1.oga', bytes: new Uint8Array([1, 2, 3]) })
    api.files.set('pdf1', { path: 'documents/r.pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) })
  }
}, 120000)
afterAll(async () => {
  for (const p of procs) { try { p.kill() } catch {} }
  await Promise.all([on?.stop(), off?.stop(), lanes?.stop()]); apiOn?.stop(); apiOff?.stop(); apiLanes?.stop(); onsen?.stop()
})

const now = () => Math.floor(Date.now() / 1000)
const from = { id: JOEY, is_bot: false, first_name: 'J', username: 'joey' }
const chat = { id: JOEY, type: 'private', first_name: 'J' }
/** the same update to both daemons */
function both(u: Record<string, any>): void { apiOn.push(structuredClone(u)); apiOff.push(structuredClone(u)) }
const norm = (g: Got) => ({ content: g.content, meta: Object.fromEntries(Object.entries(g.meta).map(([k, v]) => [k, /^image_path/.test(k) ? String(v).replace(/^.*\/inbox\/\d+-/, 'INBOX/') : v])) })
const byId = (who: 'on' | 'off', id: string) => got[who].filter(g => g.meta.message_id === id)
/** both sessions got message `id` exactly once; their tags are identical */
async function same(id: string, ms = 10000): Promise<Got> {
  expect(await until(() => byId('on', id).length >= 1 && byId('off', id).length >= 1, ms)).toBe(true)
  await sleep(300)
  expect(byId('on', id).length).toBe(1); expect(byId('off', id).length).toBe(1)
  expect(norm(byId('on', id)[0]!)).toEqual(norm(byId('off', id)[0]!))
  return byId('on', id)[0]!
}
const writesOf = (who: string, id: number) => onsen.writes(who).filter(m => m.item.direction === 'in' && String(m.item.client_msg_id) === String(id))
const logLine = (s: string, re: RegExp): number => s.split('\n').findIndex(l => re.test(l))

test('1 a sentence: written to Onsen (deliver) → person_message taken → handed on → in session; 👀 after A; the <channel> tag byte-identical to the switch off', async () => {
  both({ message: { message_id: 101, date: now(), chat, from, text: '第一句：走 Onsen' } })
  const g = await same('101')
  expect(g.content).toBe('第一句：走 Onsen')
  expect(Object.keys(g.meta)).toEqual(['chat_id', 'message_id', 'user', 'user_id', 'ts'])
  expect(JSON.stringify(byId('on', '101')[0]!.meta)).toBe(JSON.stringify(byId('off', '101')[0]!.meta))   // byte for byte, key order too
  const w = writesOf('on', 101)
  expect(w.length).toBe(1)
  expect(w[0]!.path).toBe('/messages')                                           // A: synchronous, not the spool's batch
  expect(w[0]!.item).toMatchObject({ idem_key: 'tg:adam:1828:in:101', direction: 'in', deliver: true, body: '第一句：走 Onsen', kind: 'text', client_msg_id: '101' })
  expect(writesOf('off', 101).map(m => [m.path, 'deliver' in m.item])).toEqual([['/messages/batch', false]])   // off: the spool's record, no deliver
  // the order: Onsen has it → the inbox took it → handed on → the session; 👀 only once Onsen has it
  const L = on.log()
  const a = logLine(L, /onsen inbound: 1828:101 written to Onsen/), b = logLine(L, /person_message \d+ \(tg:101\) received from the inbox/), c = logLine(L, /tg:101 handed to the session/)
  expect(a >= 0 && b > a && c > b).toBe(true)
  expect(inboxLog()).toMatch(/item \d+ \(person_message\) pm:\d+: handed to the Telegram daemon \(:\d+\): delivered/)
  expect(g.at).toBeGreaterThanOrEqual(w[0]!.at)
  const eyes = apiOn.of('setMessageReaction').filter(c => c.body.message_id === 101)
  expect(eyes.map(c => c.body.reaction?.[0]?.emoji)).toEqual(['👀'])
  expect(eyes[0]!.at).toBeGreaterThanOrEqual(w[0]!.at)
  expect(onsen.inbox.filter(i => i.who === 'on' && i.kind === 'person_message').every(i => i.acked)).toBe(true)
}, 30000)

test('2 a reply with a quote, a forward, an album of three, a voice note, a PDF: every attribute identical to the switch off; pictures readable', async () => {
  const d = now()
  // a reply (to a photo message: its file comes along, attachment_origin=reply) with a quoted passage
  both({ message: { message_id: 201, date: d, chat, from, text: '這張圖的第二段', quote: { text: '第二段：預算', position: 0 },
    reply_to_message: { message_id: 150, date: d - 60, chat, from: { id: 999, is_bot: true, first_name: 'lab', username: 'lab_test_bot' }, caption: '附件：預算表',
      photo: [{ file_id: 'ph-root', file_unique_id: 'uroot', width: 90, height: 90, file_size: 3 }] } } })
  const r = await same('201')
  expect(r.meta).toMatchObject({ reply_to_message_id: '150', reply_to_user: 'lab_test_bot', reply_to_user_id: '999', reply_to_text: '附件：預算表', reply_quote: '第二段：預算', attachment_origin: 'reply' })
  expect(readFileSync(r.meta.image_path!)).toEqual(Buffer.from([0xff, 0xd8, 9]))
  // a forward
  both({ message: { message_id: 202, date: d, chat, from, text: '轉給你看', forward_origin: { type: 'user', date: d - 3600, sender_user: { id: 4242, is_bot: false, first_name: 'Ann', username: 'ann_x' } } } })
  const f = await same('202')
  expect(f.meta).toMatchObject({ forward_origin: 'user', forward_from: 'ann_x', forward_from_id: '4242', forward_from_username: 'ann_x' })
  // an album of three photos: one message, three pictures
  for (const i of [1, 2, 3]) both({ message: { message_id: 210 + i, date: d, chat, from, media_group_id: 'alb1', ...(i === 1 ? { caption: '三張' } : {}),
    photo: [{ file_id: `ph${i}`, file_unique_id: `u${i}`, width: 90, height: 90, file_size: 3 }] } })
  const al = await same('211')
  expect(al.meta.media_group_count).toBe('3')
  expect(al.content).toBe('三張')
  for (const [k, i] of [['image_path', 1], ['image_path_2', 2], ['image_path_3', 3]] as const) expect(readFileSync(al.meta[k]!)).toEqual(Buffer.from([0xff, 0xd8, i]))
  expect(got.on.filter(g => ['212', '213'].includes(g.meta.message_id)).length).toBe(0)
  // a voice note (transcribed here; its transcript is its text in Onsen)
  both({ message: { message_id: 220, date: d, chat, from, voice: { file_id: 'voice1', file_unique_id: 'uv1', duration: 3, mime_type: 'audio/ogg', file_size: 3 } } })
  const v = await same('220')
  expect(v.content).toBe('(voice message)')
  expect(v.meta.voice_transcript).toBe('語音的逐字稿：明天開會')
  expect(writesOf('on', 220)[0]!.item).toMatchObject({ body: '語音的逐字稿：明天開會', kind: 'voice', deliver: true })
  // a PDF
  both({ message: { message_id: 230, date: d, chat, from, document: { file_id: 'pdf1', file_unique_id: 'upd', file_name: 'report<v2>.pdf', mime_type: 'application/pdf', file_size: 4 } } })
  const p = await same('230')
  expect(p.content).toBe('(document: report＜v2＞.pdf)')
  expect(p.meta).toMatchObject({ attachment_kind: 'document', attachment_file_id: 'pdf1', attachment_size: '4', attachment_mime: 'application/pdf', attachment_name: 'report＜v2＞.pdf' })
  // what Onsen got for the person_message besides today's record (WO-193 meta)
  expect(writesOf('on', 201)[0]!.item.meta).toMatchObject({ reply_quote: '第二段：預算', reply_to_text: '附件：預算表', reply_to_user: 'lab_test_bot' })
}, 60000)

test('3 a page message (via web): the same path; delivered as before (via="onsen", form-<id>), echoed 〔你在 Onsen 傳的〕; by the router with lanes on', async () => {
  const seq = onsen.say('on', String(JOEY), '從網頁傳的一句')
  const pm = onsen.inbox.find(i => i.who === 'on' && i.seq === seq)!
  const ref = pm.payload.client.msg_id
  expect(await until(() => got.on.some(g => g.meta.message_id === ref))).toBe(true)
  const g = got.on.find(g => g.meta.message_id === ref)!
  expect(g.content).toBe('從網頁傳的一句')
  expect(Object.keys(g.meta)).toEqual(['chat_id', 'message_id', 'user', 'user_id', 'ts', 'via'])
  expect(g.meta).toMatchObject({ chat_id: String(JOEY), user: String(JOEY), user_id: String(JOEY), via: 'onsen' })
  expect(await until(() => apiOn.of('sendMessage').some(c => c.body.text === '〔你在 Onsen 傳的〕\n從網頁傳的一句' && c.body.disable_notification === true))).toBe(true)
  // lanes on: the router's rules decide (not the page path's rule=onsen straight to the main), as for a Telegram message
  const lseq = onsen.say('lanes', String(JOEY), '網頁那句，給分流器')
  const lref = onsen.inbox.find(i => i.who === 'lanes' && i.seq === lseq)!.payload.client.msg_id
  expect(await until(() => new RegExp(`lanes: route tg-${JOEY}-${lref} `).test(lanes.log()), 15000)).toBe(true)
  const line = lanes.log().split('\n').find(l => l.includes(`lanes: route tg-${JOEY}-${lref} `))!
  expect(line).not.toContain('rule=onsen')
  apiLanes.push(dm(JOEY, 301, 'Telegram 那句，也給分流器'))
  expect(await until(() => /lanes: route tg-1828-301 /.test(lanes.log()), 15000)).toBe(true)
  // 6: with lanes on the Telegram message reaches the router only after it came back from Onsen (the lanes' rules then: tool boundary or turn end)
  const L = lanes.log()
  expect(logLine(L, /onsen inbound: 1828:301 written to Onsen/)).toBeLessThan(logLine(L, /lanes: route tg-1828-301 /))
  expect(logLine(L, /person_message \d+ \(tg:301\) received/)).toBeLessThan(logLine(L, /lanes: route tg-1828-301 /))
}, 45000)

test('4 an edit: of a message not yet written into Onsen, the edited text is what goes in (once); of one delivered, one edit notice, identical to the switch off', async () => {
  onsen.st.aDelayMs = 1500                                                      // Onsen slow: the message waits to be written
  both({ message: { message_id: 401, date: now(), chat, from, text: '原本的字' } })
  await sleep(400)
  both({ edited_message: { message_id: 401, date: now(), edit_date: now(), chat, from, text: '改過的字' } })
  expect(await until(() => byId('on', '401').length === 1, 10000)).toBe(true)
  onsen.st.aDelayMs = 0
  await sleep(1500)
  expect(byId('on', '401').map(g => g.content)).toEqual(['改過的字'])           // the edited text went in, once, nothing after it
  // Onsen: written once (the old text when A was already on its way), and the edit recorded on it; its person_edit is not delivered again
  expect(writesOf('on', 401).length).toBe(1)
  expect(await until(() => onsen.seen.some(x => x.who === 'on' && x.path === '/events' && x.body?.target_client_msg_id === '401' && x.body?.body === '改過的字'), 8000)).toBe(true)
  // point 8 (Chiron 11:35Z): the edit event went into the same queue behind the message, so it reached Onsen after the message was written (Onsen
  // ends with the new text), and its person_edit (it comes because the event came after the message) is not delivered again
  const ev = onsen.seen.find(x => x.who === 'on' && x.path === '/events' && x.body?.target_client_msg_id === '401')!
  expect(ev.at).toBeGreaterThanOrEqual(writesOf('on', 401)[0]!.at)
  expect(on.log()).toMatch(/the edit of 1828:401 made while it waited to be written is in Onsen now, after the message/)
  expect(await until(() => onsen.inbox.some(i => i.who === 'on' && i.kind === 'person_edit' && i.payload.text === '改過的字'), 5000)).toBe(true)
  expect(await until(() => /person_edit of tg:401: made before the message was in Onsen/.test(on.log()), 5000)).toBe(true)
  await sleep(500)
  expect(byId('on', '401').length).toBe(1)
  // delivered, then edited: the edit comes back from Onsen (person_edit) and reaches the session once, as the switch off delivers it
  const d = now()
  both({ message: { message_id: 402, date: d, chat, from, text: '第一版' } })
  await same('402')
  const n = (who: 'on' | 'off') => got[who].filter(g => g.meta.message_id === '402').length
  both({ edited_message: { message_id: 402, date: d, edit_date: d + 5, chat, from, text: '第二版' } })
  expect(await until(() => n('on') === 2 && n('off') === 2, 10000)).toBe(true)
  await sleep(500)
  expect(n('on')).toBe(2)
  const [eo, ef] = [got.on.filter(g => g.meta.message_id === '402')[1]!, got.off.filter(g => g.meta.message_id === '402')[1]!]
  expect(norm(eo)).toEqual(norm(ef))
  expect(eo.content).toContain('第二版')
  expect(onsen.inbox.some(i => i.who === 'on' && i.kind === 'person_edit' && i.payload.text === '第二版')).toBe(true)
}, 45000)

test('5 Onsen refuses writes (500): after 15 s (here 1.5 s) the person gets the one system message; after recovery it is delivered once', async () => {
  onsen.st.a500.on = true
  both({ message: { message_id: 501, date: now(), chat, from, text: 'Onsen 掛了的時候' } })
  const told = () => apiOn.of('sendMessage').filter(c => c.body.text === heldText('adam'))
  expect(await until(() => told().length === 1, 8000)).toBe(true)
  expect(told()[0]!.body.reply_parameters).toMatchObject({ message_id: 501 })
  expect(byId('on', '501').length).toBe(0)
  expect(apiOn.of('setMessageReaction').some(c => c.body.message_id === 501)).toBe(false)   // not received yet: no 👀
  await sleep(1000)
  expect(told().length).toBe(1)                                                 // once
  onsen.st.a500.on = false
  await same('501', 10000)
  await sleep(800)
  expect(byId('on', '501').length).toBe(1)
  expect(writesOf('on', 501).length).toBe(1)
  expect(apiOn.of('setMessageReaction').filter(c => c.body.message_id === 501).length).toBe(1)
  const h = await fetch(`http://127.0.0.1:${on.port}/healthz`).then(r => r.json()) as any
  expect(h.onsen.inbound).toMatchObject({ on: true, write: { held: 1, late: 1, waiting: 0 } })
}, 30000)

test('7 speed: Telegram arrival → in session, the median of 10, off vs on (stand-in Onsen answering at once)', async () => {
  const lat: Record<'on' | 'off', number[]> = { on: [], off: [] }
  for (let i = 0; i < 10; i++) {
    const id = 700 + i, t0 = Date.now()
    both({ message: { message_id: id, date: now(), chat, from, text: `bench ${i}` } })
    expect(await until(() => byId('on', String(id)).length === 1 && byId('off', String(id)).length === 1, 10000)).toBe(true)
    lat.on.push(byId('on', String(id))[0]!.at - t0); lat.off.push(byId('off', String(id))[0]!.at - t0)
    await sleep(100)
  }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!
  console.log(`WO-194 bench (Telegram arrival → in session, ms, median of 10): off ${med(lat.off)} (${lat.off.join(', ')}); on ${med(lat.on)} (${lat.on.join(', ')})`)
  expect(med(lat.on)).toBeLessThan(2000)
}, 60000)

test('the agent-inbox daemon (A.2): a person_message its Telegram daemon does not take stays in its place, not acked, tried again every 30 s (here 0.6 s); a peer\'s call behind it is handed on', async () => {
  const dead = await freePort()
  const ilog = await bootInbox('dead', CRED.off, dead, { ONSEN_PERSON_FORWARD_GAPS_MS: '100', ONSEN_PERSON_RETRY_MS: '600' })
  const seq = onsen.say('off', String(JOEY), '交不出去的一句')
  const call = onsen.put('off', 'call', { text: '同事的一則（排在後面）', msg_id: 99001 }, 'msg:99001')
  expect(call).toBe(seq + 1)
  expect(await until(() => new RegExp(`item ${call} \\(call\\) from joey`).test(ilog()), 15000)).toBe(true)   // not stuck behind the person_message
  expect(ilog()).toMatch(new RegExp(`item ${seq} \\(person_message\\) not taken: kept in its place \\(not acked\\), tried again every 1 s`))
  expect(await until(() => (ilog().match(new RegExp(`item ${seq} \\(person_message\\) not taken by the Telegram daemon`, 'g')) ?? []).length >= 4, 15000)).toBe(true)
  expect(onsen.inbox.find(i => i.who === 'off' && i.seq === seq)!.acked).toBe(false)   // never acked undelivered (Onsen's ack is `upto`: the call waits for it)
  expect(onsen.inbox.find(i => i.who === 'off' && i.seq === call)!.acked).toBe(false)
  expect(ilog()).not.toMatch(/\(person_message\) from joey/)                     // never the peer path (deliverInbound)
}, 30000)

test('A.1 (Chiron\'s lab check): the agent-inbox daemon stopped, a sentence reaches the session ~20 s (here 4 s) later from the facts kept, then an edit; started again: no second delivery', async () => {
  inboxProc.on!.kill(); await inboxProc.on!.exited
  const t0 = Date.now()
  both({ message: { message_id: 801, date: now(), chat, from, text: '收件程式停了的時候' } })
  await sleep(2500)
  expect(byId('on', '801').length).toBe(0)                                     // written into Onsen, not back: waits
  const g = await same('801', 15000)                                           // the tag of the switch off
  expect(g.at - t0).toBeGreaterThanOrEqual(BACK - 500)
  expect(on.log()).toMatch(/onsen inbound: 1828:801 not back from the inbox 4 s after it was written into Onsen \(message \d+\): delivered here from the facts it kept/)
  expect(writesOf('on', 801).length).toBe(1)
  // an edit of it while the inbox is still down: its person_edit does not come back either; delivered here 4 s after, as the switch off delivers it
  const d = now()
  both({ edited_message: { message_id: 801, date: d, edit_date: d + 5, chat, from, text: '收件程式停了的時候（改）' } })
  expect(await until(() => got.on.filter(x => x.meta.message_id === '801').length === 2 && got.off.filter(x => x.meta.message_id === '801').length === 2, 15000)).toBe(true)
  const [eo, ef] = [got.on.filter(x => x.meta.message_id === '801')[1]!, got.off.filter(x => x.meta.message_id === '801')[1]!]
  expect(norm(eo)).toEqual(norm(ef))
  expect(on.log()).toMatch(/edit of tg:801 not back from the inbox 4 s after it was made: delivered here/)
  // the agent-inbox daemon again: it takes the person_message and the person_edit, the Telegram daemon recognises both, both acked, nothing twice
  const pm = onsen.inbox.find(i => i.who === 'on' && i.kind === 'person_message' && i.payload.client?.msg_id === '801')!
  expect(pm.acked).toBe(false)
  await bootInbox('on', CRED.on, on.port)
  expect(await until(() => pm.acked && onsen.inbox.filter(i => i.who === 'on' && i.kind === 'person_edit' && String(i.payload.client?.msg_id) === '801').every(i => i.acked), 20000)).toBe(true)
  await sleep(800)
  expect(got.on.filter(x => x.meta.message_id === '801').length).toBe(2)
  expect(on.log()).toMatch(new RegExp(`person_message ${pm.payload.message_id} \\(tg:801\\) came back from the inbox after it was delivered here \\(not back in time, A\\.1\\): not delivered again`))
  if (onsen.inbox.some(i => i.who === 'on' && i.kind === 'person_edit' && String(i.payload.client?.msg_id) === '801')) expect(on.log()).toMatch(/person_edit of tg:801: delivered here already \(not back in time, A\.1\): not delivered again/)
  const h = await fetch(`http://127.0.0.1:${on.port}/healthz`).then(r => r.json()) as any
  expect(h.onsen.inbound.back).toMatchObject({ here: 1 })
}, 60000)
