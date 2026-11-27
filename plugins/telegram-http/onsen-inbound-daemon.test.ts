// WO-194 end to end, as 1.59.0 runs it: real Telegram daemons (server.ts; connectors) and real agent-inbox daemons against one stand-in Onsen 0.34.2
// (test-fixtures/onsen-standin.ts: the inbox, person_message / person_edit; nothing reaches core.kbro.ai or Telegram), in temp dirs (their HOME too).
// What the bridge wrote into Onsen comes to the agent's inbox; its agent-inbox daemon (ONSEN_PULL) takes each item and hands it to the Telegram daemon
// (POST /onsen/person), which delivers it; the item is acked once it is delivered.
//   on     lanes off: a person's Telegram message (the bridge's write) and a page message (via web) reach the session, each once; a page message's reply_to
//   lanes  lanes on: a page message goes to the router's rules (not straight to the main)
//   A.2    a person_message its Telegram daemon does not take stays in its place, not acked; a peer's call behind it is handed on
// 1.59.0: no daemon writes a Telegram message into Onsen any more (the bridge does; a roamer records nothing), so the 1.58.x cases of that half are gone:
// 1 / 2 (written into Onsen, 👀 after it, the tag compared with the switch off), 4 (an edit while the message waits to be written), 5 (Onsen refusing
// the writes: the held notice), 7 (the speed of that path), A.1 (a message not back from the inbox delivered from the facts its arrival kept), and the
// page message's echo 〔你在 Onsen 傳的〕 (the bridge draws it from the feed).
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, freePort, sleep, type TgDaemon } from './test-fixtures/tg-daemon.ts'
import { startOnsenStandin, type OnsenStandin } from './test-fixtures/onsen-standin.ts'

const JOEY = 1828
const CRED = { on: 'mesh_INBOUNDonSECRETsecretSECRETsecret01', off: 'mesh_INBOUNDoffSECRETsecretSECRETsecret1', lanes: 'mesh_INBOUNDlanesSECRETsecretSECRETsec1' }
type Got = { at: number; content: string; meta: Record<string, string> }
let onsen: OnsenStandin, root = '', apiOn: BotApiMock, apiLanes: BotApiMock, on: TgDaemon, lanes: TgDaemon
const got: Record<string, Got[]> = { on: [] }
const procs: Array<{ kill(): void }> = []

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
  procs.push(proc)
  const health = () => fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.json()).catch(() => null) as Promise<any>
  if (!await until(async () => (await health())?.ok === true, 20000)) throw new Error(`inbox daemon ${name} did not start`)
  return () => { try { return readFileSync(join(stateDir, 'server.log'), 'utf8') } catch { return '' } }
}
async function listen(d: TgDaemon, into: Got[]): Promise<void> {
  const c = await d.client()
  c.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') into.push({ at: Date.now(), content: String((n.params as any).content), meta: (n.params as any).meta }) }
}

beforeAll(async () => {
  onsen = startOnsenStandin({ [CRED.on]: 'on', [CRED.off]: 'off', [CRED.lanes]: 'lanes' }, await freePort())
  for (const w of ['on', 'off', 'lanes']) onsen.st.version[w] = '0.34.2'
  root = mkdtempSync(join(tmpdir(), 'onsen-inbound-daemon-'))
  mkdirSync(join(root, 'cred'), { recursive: true })
  for (const [k, v] of Object.entries(CRED)) writeFileSync(join(root, 'cred', k), v + '\n')
  writeFileSync(join(root, 'mesh-credentials.json'), JSON.stringify({ identities: {}, hashes: {} }))
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ adam: { url: 'http://127.0.0.1:9/inject' } }))
  apiOn = startBotApiMock({}, { pollHoldMs: 200 }); apiLanes = startBotApiMock({}, { pollHoldMs: 200 })
  const env = { ONSEN_BASE: `http://127.0.0.1:${onsen.port}/api/onsen`, ONSEN_PEER_LOOKUP: '0', ONSEN_CLAUDE_BIN: '/nonexistent/claude' }
  ;[on, lanes] = await Promise.all([
    startTgDaemon(apiOn, join(root, 'on'), JOEY, { ...env, GENESIS_LANES: '0', ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'on'), ONSEN_INBOUND: 'someone, adam' }),
    startTgDaemon(apiLanes, join(root, 'lanes'), JOEY, { ...env, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'lanes'), ONSEN_INBOUND: '*' }),
  ])
  await bootInbox('on', CRED.on, on.port)
  await bootInbox('lanes', CRED.lanes, lanes.port)
  await listen(on, got.on)
}, 120000)
afterAll(async () => {
  for (const p of procs) { try { p.kill() } catch {} }
  await Promise.all([on?.stop(), lanes?.stop()]); apiOn?.stop(); apiLanes?.stop(); onsen?.stop()
})

test('a person\'s Telegram message as the bridge wrote it: the agent-inbox daemon takes its person_message, hands it on, the session gets it once; acked after', async () => {
  const seq = onsen.put('on', 'person_message', { message_id: '43001', conversation_id: '1', from: 'joey', via: 'telegram', text: '從 Telegram 來的一句', kind: 'text',
    sent_at: new Date().toISOString(), attachments: [], client: { name: 'telegram', chat: String(JOEY), msg_id: '901', user: 'joey', user_id: String(JOEY) }, reply_to: null }, 'pm:43001')
  expect(await until(() => got.on.some(g => g.meta.message_id === '901'), 15000)).toBe(true)
  const g = got.on.find(g => g.meta.message_id === '901')!
  expect(g.content).toBe('從 Telegram 來的一句')
  expect(g.meta).toMatchObject({ chat_id: String(JOEY), message_id: '901', user: 'joey', user_id: String(JOEY) })
  expect(await until(() => onsen.inbox.find(i => i.who === 'on' && i.seq === seq)!.acked, 5000)).toBe(true)
  // handed again (the inbox's retry, a restart): a duplicate, not delivered twice
  expect((await fetch(`http://127.0.0.1:${on.port}/onsen/person`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'person_message', seq, dedupe: 'pm:43001', payload: onsen.inbox.find(i => i.who === 'on' && i.seq === seq)!.payload }) }).then(r => r.json()))).toMatchObject({ duplicate: true })
  await sleep(500)
  expect(got.on.filter(g => g.meta.message_id === '901').length).toBe(1)
  expect(on.log()).toMatch(/onsen inbound: person_message 43001 \(tg:901\) received from the inbox/)
  expect(apiOn.calls).toEqual([]); expect(apiOn.polls).toEqual([])
}, 30000)

test('a page message (via web): the same path; delivered (via="onsen", form-<id>) once; by the router with lanes on', async () => {
  const seq = onsen.say('on', String(JOEY), '從網頁傳的一句')
  const pm = onsen.inbox.find(i => i.who === 'on' && i.seq === seq)!
  const ref = pm.payload.client.msg_id
  expect(await until(() => got.on.some(g => g.meta.message_id === ref))).toBe(true)
  const g = got.on.find(g => g.meta.message_id === ref)!
  expect(g.content).toBe('從網頁傳的一句')
  expect(Object.keys(g.meta)).toEqual(['chat_id', 'message_id', 'user', 'user_id', 'ts', 'via'])
  expect(g.meta).toMatchObject({ chat_id: String(JOEY), user: String(JOEY), user_id: String(JOEY), via: 'onsen' })
  await sleep(500)
  expect(got.on.filter(g => g.meta.message_id === ref).length).toBe(1)
  expect(await until(() => onsen.inbox.find(i => i.who === 'on' && i.seq === seq)!.acked, 5000)).toBe(true)
  expect(apiOn.calls).toEqual([])                                           // the echo is the bridge's (from the feed)
  // lanes on: the router's rules decide (not the page path's rule=onsen straight to the main), as for a Telegram message
  const lseq = onsen.say('lanes', String(JOEY), '網頁那句，給分流器')
  const lref = onsen.inbox.find(i => i.who === 'lanes' && i.seq === lseq)!.payload.client.msg_id
  expect(await until(() => new RegExp(`lanes: route tg-${JOEY}-${lref} `).test(lanes.log()), 15000)).toBe(true)
  const line = lanes.log().split('\n').find(l => l.includes(`lanes: route tg-${JOEY}-${lref} `))!
  expect(line).not.toContain('rule=onsen')
}, 45000)

test('3b a page message replying to a message (Chiron, mesh 12695): reply_to_message_id (its Telegram id, else onsen:<id>), reply_to_user, reply_to_text (≤ 500), last, as a Telegram reply', async () => {
  const meta = async (text: string, reply_to: any) => {
    const seq = onsen.say('on', String(JOEY), text, [], reply_to)
    const ref = onsen.inbox.find(i => i.who === 'on' && i.seq === seq)!.payload.client.msg_id
    expect(await until(() => got.on.some(g => g.meta.message_id === ref))).toBe(true)
    return got.on.find(g => g.meta.message_id === ref)!.meta
  }
  // a reply to the agent's own Telegram message: its Telegram id, the agent (a connector has no bot of its own to name; the bridge's is the bot), the text
  const a = await meta('回那一則', { message_id: '43029', client_msg_id: '8812', from: 'agent:adam', text: 'lab-relay 的回覆\n第二行' })
  expect(Object.keys(a)).toEqual(['chat_id', 'message_id', 'user', 'user_id', 'ts', 'via', 'reply_to_message_id', 'reply_to_user', 'reply_to_text'])
  expect(a).toMatchObject({ via: 'onsen', reply_to_message_id: '8812', reply_to_user: 'agent:adam', reply_to_text: 'lab-relay 的回覆 第二行' })
  // a message only Onsen has (no Telegram id): onsen:<id>; another member: the name Onsen gives; the text cut at 500
  const b = await meta('回網頁那一則', { message_id: '43091', client_msg_id: null, from: 'joey', text: '字'.repeat(600) })
  expect(b).toMatchObject({ reply_to_message_id: 'onsen:43091', reply_to_user: 'joey' })
  expect(b.reply_to_text!.length).toBe(500)
  expect(b.reply_to_text!.endsWith('…')).toBe(true)
  // without reply_to: none of them (the page message test: the six attributes only)
  const c = await meta('沒有回覆誰', null)
  expect(Object.keys(c).filter(k => k.startsWith('reply_to'))).toEqual([])
}, 30000)

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
