// WO-197 segment 1, against a real daemon (server.ts), the Bot API stand-in and the Onsen stand-in (its bridge simulated): an agent named in
// ONSEN_BRIDGE starts without a bot token, never polls, makes no Bot API call at all (the stand-in sees none), and says, reacts and edits only in
// Onsen (POST /v1/messages with conversation_id; the bridge's report gives `sent (id: …)`, none in 3 s gives the held sentence). A daemon taken off
// the list polls Telegram again; named while polling: its poll stops.
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
let root = '', api: BotApiMock, apiSw: BotApiMock, onsen: OnsenStandin, d: TgDaemon, sw: TgDaemon, machine = ''
const health = (x: TgDaemon) => fetch(`http://127.0.0.1:${x.port}/healthz`).then(r => r.json()) as Promise<any>

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'onsen-connector-daemon-'))
  onsen = startOnsenStandin({ [CRED.c]: 'c', [CRED.s]: 's' }, await freePort())
  for (const w of ['c', 's']) onsen.st.version[w] = '0.35.3'
  writeFileSync(join(root, 'cred-c'), CRED.c + '\n'); writeFileSync(join(root, 'cred-s'), CRED.s + '\n')
  api = startBotApiMock({}, { pollHoldMs: 200 }); apiSw = startBotApiMock({}, { pollHoldMs: 200 })
  machine = join(root, 'machine.env')
  writeFileSync(machine, 'ONSEN_BRIDGE=someone\n')
  const env = { ONSEN_BASE: `http://127.0.0.1:${onsen.port}/api/onsen`, ONSEN_PEER_LOOKUP: '0', ONSEN_CLAUDE_BIN: '/nonexistent/claude', ONSEN_BRIDGE_RETRY_MS: '50,50' }
  ;[d, sw] = await Promise.all([
    // named in the plist, no token: a connector from the start
    startTgDaemon(api, join(root, 'c'), JOEY, { ...env, GENESIS_LANES: '0', TELEGRAM_BOT_TOKEN: '', ONSEN_BRIDGE: 'lab-relay, adam', ONSEN_CREDENTIAL_FILE: join(root, 'cred-c') },
      h => h?.ok === true),
    // the machine config's line, read again: not named at first (polls), then named, then taken off
    startTgDaemon(apiSw, join(root, 's'), JOEY, { ...env, GENESIS_LANES: '0', CRAB_LABS_PLUGINS_ENV: machine, ONSEN_BRIDGE_TICK_MS: '200', ONSEN_CREDENTIAL_FILE: join(root, 'cred-s') }),
  ])
}, 60000)
afterAll(async () => { await Promise.all([d?.stop(), sw?.stop()]); api?.stop(); apiSw?.stop(); onsen?.stop() })

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

test('7. the machine config: not named → polls; named → the poll stops (offset saved once) and no call after; taken off → polls again', async () => {
  expect((await health(sw)).polling).toBe(true)
  writeFileSync(machine, 'ONSEN_BRIDGE=adam\n')
  expect(await until(async () => (await health(sw)).polling === false && (await health(sw)).connector.on === true, 35000)).toBe(true)
  await sleep(600)
  const calls = apiSw.calls.length, polls = apiSw.polls.length
  expect(await sw.call('react', { chat_id: String(JOEY), message_id: '1', emoji: '👍' }).then(r => r.isError)).toBe(true)   // nothing in Onsen for it
  await sleep(1500)
  expect(apiSw.calls.length).toBe(calls)
  expect(apiSw.polls.length).toBe(polls)
  writeFileSync(machine, 'ONSEN_BRIDGE=0\n')
  expect(await until(async () => (await health(sw)).polling === true, 35000)).toBe(true)
}, 90000)
