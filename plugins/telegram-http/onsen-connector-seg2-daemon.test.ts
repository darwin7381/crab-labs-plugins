// WO-197 segment 2 (Chiron; CONTRACT §7d 「連接器這一頭」, rulings mesh 12869 / 12878, Onsen 0.35.8): the connector does the rest through Onsen. Real
// daemons (server.ts, lanes on, control mode on a tmux pane running `cat`) against the Bot API stand-in and the Onsen stand-in (its bridge simulated);
// the hand-over of a person's item (POST /onsen/person) and of a press (POST /onsen/action) is the test's (the agent-inbox daemon's place).
//   commands   the list setMyCommands gives Telegram is PUT /v1/members/<agent>/commands (no /start, /help: the bridge's own); /status from Onsen is
//              answered by today's handler as one Onsen message in the command's turn; /model is one Action (menu model_picker, the answer its body,
//              no second message), a press runs what the Telegram tap runs; a page message "/status" is a command too; an unknown slash goes on
//   /clear     one message: 「不要讓它看到之前的」 an Action whose body is the reply (no Action: the reply alone, as before); it expires in 5 s with its expiry_note (Onsen 0.36.0; no cancel from the daemon); pressed inside:
//              the line drawn by conversation_id (never client / chat) at the /clear's time
//   threads    a person's message in a thread: the tag's topic / topic_name as the person's message carried them, the router's topic Onsen's thread;
//              reply(topic=<the tag's>) is written with that thread; a thread Onsen refuses is dropped and the reply written
//   owner      a system warning goes `to` the owner (ONSEN_OWNER); with none set and none mapped: one error, /healthz connector.owner null, no Action
// In every test the Bot API stand-in sees nothing and bot_api_refused stays {}.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startOnsenStandin, type OnsenStandin } from './test-fixtures/onsen-standin.ts'
import { startTgDaemon, freePort, until, sleep, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const CRED = { k: 'mesh_SEG2connectorSECRETsecretSECRETsec01', n: 'mesh_SEG2noownerSECRETsecretSECRETsecr01' }
let root = '', sock = '', pane = '', apiK: BotApiMock, apiN: BotApiMock, onsen: OnsenStandin, k: TgDaemon, n: TgDaemon
const tmuxEnv = (): Record<string, string> => { const e = { ...process.env, TMUX_TMPDIR: sock } as Record<string, string>; delete e.TMUX; return e }
const tm = (...a: string[]) => spawnSync('tmux', a, { env: tmuxEnv(), encoding: 'utf8' })
const health = (d: TgDaemon) => fetch(`http://127.0.0.1:${d.port}/healthz`).then(r => r.json()) as Promise<any>
const hand = async (d: TgDaemon, payload: Record<string, unknown>, seq: number) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/onsen/person`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'person_message', seq, dedupe: `pm:${payload.message_id}`, payload }) })
  return { status: r.status, json: await r.json() as any }
}
const control = async (d: TgDaemon, c: unknown) => (await fetch(`http://127.0.0.1:${d.port}/onsen/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(c) })).status
const cmd = (n: number, text: string, extra: Record<string, unknown> = {}) => ({ message_id: String(6000 + n), conversation_id: onsen.conv(String(JOEY)), from: 'joey',
  via: 'telegram', text, kind: 'command', sent_at: new Date().toISOString(), attachments: [], reply_to: null,
  client: { name: 'telegram', chat: String(JOEY), msg_id: String(n), user: 'joey', user_id: String(JOEY) }, ...extra })
const said = (who = 'k') => onsen.connector.filter(x => x.who === who && x.kind === 'message').map(x => x.body)
const made = (who: string, pred: (a: any) => boolean) => [...onsen.actions.values()].filter(a => a.requested_by === who && pred(a))
const acall = (id: string, op: string) => onsen.acalls.filter(c => c.method === 'POST' && c.path === `/v1/actions/${id}/${op}`)
/** what the router queued for the main (no main is registered: each waits in the journal with its notification and its event) */
const journal = (d: TgDaemon): any[] => {
  const f = join(d.stateDir, 'lanes', 'state.jsonl')
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : []
}
const queuedTag = (d: TgDaemon, id: string) => journal(d).find(l => l.rec === 'msg' && l.notif?.params?.meta?.message_id === id)
const factsOf = (id: string) => onsen.seen.filter(s => s.who === 'k' && s.path === '/deliveries/batch').flatMap(s => s.body?.items ?? []).filter((f: any) => f.client_msg_id === id)

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'onsen-connector-seg2-'))
  sock = mkdtempSync(join(tmpdir(), 'ocs2-'))
  pane = `seg2-${process.pid}`
  const r = tm('new-session', '-d', '-s', pane, '-x', '120', '-y', '30', 'cat')
  if (r.status !== 0) throw new Error(`tmux: ${r.stderr}`)
  onsen = startOnsenStandin({ [CRED.k]: 'k', [CRED.n]: 'n' }, await freePort())
  onsen.st.version.k = '0.35.8'; onsen.st.version.n = '0.35.8'
  onsen.st.bridge.k = { on: true, delayMs: 50, next: 3000 }
  writeFileSync(join(root, 'cred-k'), CRED.k + '\n'); writeFileSync(join(root, 'cred-n'), CRED.n + '\n')
  apiK = startBotApiMock({}, { pollHoldMs: 200 }); apiN = startBotApiMock({}, { pollHoldMs: 200 })
  const env = { ONSEN_BASE: `http://127.0.0.1:${onsen.port}/api/onsen`, ONSEN_PEER_LOOKUP: '0', ONSEN_CLAUDE_BIN: '/nonexistent/claude', TELEGRAM_BOT_TOKEN: '',
    ONSEN_BRIDGE: 'adam' }
  ;[k, n] = await Promise.all([
    startTgDaemon(apiK, join(root, 'k'), JOEY, { ...env, ONSEN_OWNER: 'joey', ONSEN_CREDENTIAL_FILE: join(root, 'cred-k'), CHANNEL_BOT_TMUX_SESSION: pane, TMUX_TMPDIR: sock,
      SYSTEM_ALERT_FORWARD: '1' }, h => h?.ok === true),
    // no ONSEN_OWNER, and access.json's person (1828) maps to no Onsen member (TG_MEMBERS): no owner
    startTgDaemon(apiN, join(root, 'n'), JOEY, { ...env, GENESIS_LANES: '0', ONSEN_CREDENTIAL_FILE: join(root, 'cred-n') }, h => h?.ok === true),
  ])
}, 60000)
afterAll(async () => { await Promise.all([k?.stop(), n?.stop()]); apiK?.stop(); apiN?.stop(); onsen?.stop(); tm('kill-server'); try { rmSync(sock, { recursive: true }) } catch {} })

test('1. the command list: PUT /v1/members/adam/commands at start, the list setMyCommands gives Telegram without /start and /help, in the fleet order', async () => {
  expect(await until(() => onsen.commands.some(c => c.who === 'k'), 10000)).toBe(true)
  const got = onsen.commands.find(c => c.who === 'k')!
  expect(got.name).toBe('adam')
  const names = got.body.commands.map((c: any) => c.name)
  expect(names.slice(0, 2)).toEqual(['clear', 'model'])
  expect(names).toContain('status')
  expect(names.includes('start') || names.includes('help')).toBe(false)
  const h = await health(k)
  expect(h.connector).toMatchObject({ on: true, owner: 'joey', commands_reported: names.length })
  expect(apiK.calls).toEqual([])
})

test('2. /status from Onsen (kind command): today\'s handler answers it with one Onsen message in the command\'s turn; nothing reaches a session; its receipt goes to the end', async () => {
  const r = await hand(k, cmd(2001, '/status'), 1)
  expect(r).toMatchObject({ status: 200, json: { delivered: true, handled_here: true } })
  expect(await until(() => said().some(b => String(b.body).startsWith('Paired as @joey.')), 8000)).toBe(true)
  const b = said().find(x => String(x.body).startsWith('Paired as @joey.'))!
  expect(b).toMatchObject({ conversation_id: onsen.conv(String(JOEY)), sender: 'system:control', turn_id: `daemon:${JOEY}:2001` })
  expect(b.body).toContain('📊 channel-bot status')
  await sleep(500)
  expect(queuedTag(k, '2001')).toBeUndefined()
  expect(await until(() => factsOf('2001').some((f: any) => f.state === 'turn_end'), 8000)).toBe(true)
  expect(factsOf('2001').find((f: any) => f.state === 'turn_end')).toMatchObject({ by: 'daemon', outcome: 'done', turn_id: `daemon:${JOEY}:2001` })
  expect(apiK.calls).toEqual([]); expect((await health(k)).connector.bot_api_refused).toEqual({})
})

test('3. bare /model: one Action (source menu, menu_kind model_picker, the answer its body, its buttons the options, the owner asked, expires_at 10 min ahead), no second message; a press runs the tap\'s /model <value>', async () => {
  const before = said().length
  expect((await hand(k, cmd(2002, '/model'), 2)).json.handled_here).toBe(true)
  expect(await until(() => made('k', a => a.menu_kind === 'model_picker').length === 1, 8000)).toBe(true)
  const a = made('k', x => x.menu_kind === 'model_picker')[0]!
  expect(a).toMatchObject({ source: 'menu', session_id: 'main', assignees: ['joey'], state: 'open' })
  expect(a.body.text).toContain('點一個模型切換')
  expect(a.summary).toBe(a.body.text.split('\n')[0])
  expect(a.options.length).toBeGreaterThanOrEqual(2)
  expect(a.options[0]).toEqual({ id: '1', label: expect.any(String) })
  // Chiron mesh 12916 point 3: a command's choice expires 10 minutes after it is opened (the create body the stand-in got)
  const sent = onsen.acalls.find(c => c.who === 'k' && c.method === 'POST' && c.path === '/v1/actions' && c.body?.menu_kind === 'model_picker')!
  const ahead = Date.parse(sent.body.expires_at) - sent.at
  expect(ahead).toBeGreaterThan(595_000); expect(ahead).toBeLessThanOrEqual(600_000)
  expect(sent.body.expiry_note).toBe('沒選：沒有更動')                     // Onsen 0.36.0: what Onsen writes into its note when it expires
  await sleep(500)
  expect(said().length).toBe(before)                                       // CONTRACT §7d: no second message
  expect(await control(k, onsen.press(a.id, '2'))).toBe(202)
  expect(await until(() => acall(a.id, 'applied').length === 1, 20000)).toBe(true)
  expect(said().length).toBeGreaterThan(before)                            // what /model <value> answers (as the tap's) is an Onsen message
  expect(k.log()).toContain(`connector: action ${a.id} (a command's choice): option 2 pressed in Onsen, done as a tap on it`)
  expect(apiK.calls).toEqual([]); expect((await health(k)).connector.bot_api_refused).toEqual({})
}, 40000)

test('4. /clear: typed on the pane; ONE message: 「不要讓它看到之前的」 an Action whose body is the reply, no reply message beside it; expiring in 5 s with its expiry_note, no cancel from the daemon (expiry is Onsen\'s); pressed inside: the line by conversation_id at the /clear\'s time', async () => {
  const t0 = new Date().toISOString()
  const replies = () => said().filter(b => String(b.body).includes('已送 `/clear`'))
  expect((await hand(k, cmd(2003, '/clear', { sent_at: t0 }), 3)).json.handled_here).toBe(true)
  expect(await until(() => made('k', x => x.options?.[0]?.id === 'line').length === 1, 8000)).toBe(true)
  const a = made('k', x => x.options?.[0]?.id === 'line')[0]!
  expect(a).toMatchObject({ source: 'menu', menu_kind: 'other', options: [{ id: 'line', label: '不要讓它看到之前的' }], assignees: ['joey'] })
  // Chiron's rule 18:48Z point 2 (lab round 5 on 1.58.29): the reply sentence is the Action's body; no Onsen message for it
  expect(a.body).toEqual({ format: 'markdown', text: expect.stringContaining('已送 `/clear`') })
  expect(a.body.text.endsWith('。它還查得到之前的對話。')).toBe(true)
  await sleep(1000)
  expect(replies()).toHaveLength(0)
  const left = Date.parse(a.expires_at) - Date.now()
  expect(left).toBeGreaterThan(2500); expect(left).toBeLessThanOrEqual(5100)
  // Onsen 0.36.0 (Chiron mesh 12916 point 1): the create carries expires_at 5 s ahead and expiry_note; at 5 s (and after) no cancel comes from the daemon
  const sent = onsen.acalls.find(c => c.who === 'k' && c.method === 'POST' && c.path === '/v1/actions' && c.body?.options?.[0]?.id === 'line')!
  expect(sent.body.expiry_note).toBe('沒按：新的一段看得到之前的對話')
  const ahead = Date.parse(sent.body.expires_at) - sent.at
  expect(ahead).toBeGreaterThan(3000); expect(ahead).toBeLessThanOrEqual(5000)
  await sleep(Math.max(0, Date.parse(a.expires_at) + 2000 - Date.now()))
  expect(acall(a.id, 'cancel')).toHaveLength(0)
  expect(onsen.actions.get(a.id)!.state).toBe('open')                     // the stand-in has no expiry sweep: nobody but Onsen ends it
  expect(onsen.lines.filter(l => l.who === 'k')).toHaveLength(0)
  // a press whose control comes after the window (+1 s): as today, no line; cancelled with what stands
  expect(await control(k, onsen.press(a.id, 'line'))).toBe(202)
  expect(await until(() => acall(a.id, 'cancel').length === 1, 5000)).toBe(true)
  expect(acall(a.id, 'cancel')[0]!.body).toMatchObject({ note: '沒按：新的一段看得到之前的對話' })
  expect(onsen.lines.filter(l => l.who === 'k')).toHaveLength(0)
  // the second /clear, pressed inside its 5 s
  const t1 = new Date(Date.now() - 300).toISOString()
  await hand(k, cmd(2004, '/clear', { sent_at: t1 }), 4)
  expect(await until(() => made('k', x => x.options?.[0]?.id === 'line' && x.id !== a.id).length === 1, 8000)).toBe(true)
  const b = made('k', x => x.options?.[0]?.id === 'line' && x.id !== a.id)[0]!
  expect(await control(k, onsen.press(b.id, 'line'))).toBe(202)
  expect(await until(() => onsen.lines.some(l => l.who === 'k'), 5000)).toBe(true)
  const line = onsen.lines.find(l => l.who === 'k')!.body
  expect(line).toMatchObject({ conversation_id: onsen.conv(String(JOEY)), client_msg_id: '2004', at: t1, by: `tg:${JOEY}` })
  for (const x of ['agent', 'client', 'chat']) expect(x in line).toBe(false)
  expect(await until(() => acall(b.id, 'applied').length === 1, 5000)).toBe(true)
  await sleep(5500)
  expect(acall(b.id, 'cancel')).toHaveLength(0)
  expect(b.body.text).toContain('已送 `/clear`')
  expect(replies()).toHaveLength(0)                                          // neither /clear wrote the reply as a message
  expect(tm('capture-pane', '-t', pane, '-p').stdout).toContain('/clear')
  expect(apiK.calls).toEqual([]); expect((await health(k)).connector.bot_api_refused).toEqual({})
}, 40000)

test('4b. /clear with no Action (Onsen refused it): the reply is one Onsen message in the /clear\'s turn, as before; the person always gets the sentence', async () => {
  // a connector's Actions are on whatever ONSEN_ACTIONS says (connectorNow): the no-Action path a connector meets is Onsen refusing (or no owner)
  onsen.st.actionRefuse = { k: 400 }
  try {
    expect((await hand(k, cmd(2041, '/clear'), 41)).json.handled_here).toBe(true)
    expect(await until(() => said().some(b => String(b.body).includes('已送 `/clear`') && b.turn_id === `daemon:${JOEY}:2041`), 10000)).toBe(true)
    expect(said().find(b => b.turn_id === `daemon:${JOEY}:2041`)!.body).toContain('它還查得到之前的對話。')
    expect(onsen.acalls.some(c => c.who === 'k' && c.method === 'POST' && c.path === '/v1/actions' && String(c.body?.body?.text ?? '').includes('已送 `/clear`'))).toBe(true)
    expect(k.log()).toContain('no Action for 「不要讓它看到之前的」 (Onsen did not make it (failed)); the reply sent as a message, the default stands')
    expect(said().filter(b => String(b.body).includes('已送 `/clear`'))).toHaveLength(1)
  } finally { onsen.st.actionRefuse = {} }
  expect(apiK.calls).toEqual([]); expect((await health(k)).connector.bot_api_refused).toEqual({})
}, 30000)

test('5. a page message "/status" (via web, kind text) is a command too; "/nosuch x" goes on to the session as a message', async () => {
  const web = { ...cmd(2005, '/status'), via: 'web', kind: 'text', client: { name: 'telegram', chat: String(JOEY), msg_id: 'form-6105', user: 'joey', user_id: String(JOEY) } }
  expect((await hand(k, web, 5)).json.handled_here).toBe(true)
  expect(await until(() => said().filter(b => String(b.body).startsWith('Paired as')).length >= 2, 8000)).toBe(true)
  const r = await hand(k, cmd(2006, '/nosuch x'), 6)
  expect(r.json.handled_here).toBeUndefined()
  expect(await until(() => !!queuedTag(k, '2006'), 8000)).toBe(true)
  expect(queuedTag(k, '2006').notif.params.content).toBe('/nosuch x')
})

test('6. a person\'s message in a thread: the tag\'s topic / topic_name as the message carried them, the router\'s topic Onsen\'s thread; reply(topic=<the tag\'s>) lands in that thread; a thread Onsen refuses is dropped', async () => {
  const cid = onsen.conv(String(JOEY))
  onsen.threads.push({ who: 'k', cid, thread: '301', name: '整理月報', state: 'open', client_thread: '7001', history: [] })
  const m = { ...cmd(2007, '月報的進度？'), kind: 'text', thread: '301', topic_name: '整理月報',
    client: { name: 'telegram', chat: String(JOEY), msg_id: '2007', user: 'joey', user_id: String(JOEY), thread: '7001' } }
  expect((await hand(k, m, 7)).status).toBe(200)
  expect(await until(() => !!queuedTag(k, '2007'), 8000)).toBe(true)
  const q = queuedTag(k, '2007')
  expect(q.notif.params.meta).toMatchObject({ topic: '7001', topic_name: '整理月報' })
  const ev = journal(k).find(l => l.rec === 'event' && l.id === `tg-${JOEY}-2007`)
  expect(ev?.tg?.topic).toBe('301')                                           // the router's (and the lanes') topic: Onsen's thread
  expect(k.log()).toContain(`lanes: route tg-${JOEY}-2007`)
  const r1 = await k.call('reply', { chat_id: String(JOEY), text: '在做了', topic: '7001' })
  expect(r1.isError).toBe(false)
  expect(said().at(-1)).toMatchObject({ body: '在做了', thread: '301', sender: 'main' })
  const r2 = await k.call('reply', { chat_id: String(JOEY), text: '舊話題', topic: '7999' })
  expect(r2.isError).toBe(false)
  expect(said().at(-1)!.body).toBe('舊話題')
  expect('thread' in said().at(-1)!).toBe(false)
  expect(k.log()).toContain('connector: Onsen refused thread 7999')
  expect(apiK.calls).toEqual([]); expect((await health(k)).connector.bot_api_refused).toEqual({})
}, 30000)

test('7. a system warning (the TUI\'s API error, OTLP) goes to the owner: one Onsen message `to` joey, sender system:alert; nothing to Telegram', async () => {
  const otlp = { resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: Object.entries({ 'event.name': 'api_error', status_code: '500', query_source: 'repl_main_thread',
    error: 'Internal server error seg2' }).map(([key, v]) => ({ key, value: { stringValue: v } })) }] }] }] }
  expect((await fetch(`http://127.0.0.1:${k.port}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(otlp) })).status).toBe(200)
  expect(await until(() => said().some(b => String(b.body).includes('Internal server error seg2')), 8000)).toBe(true)
  const b = said().find(x => String(x.body).includes('Internal server error seg2'))!
  expect(b).toMatchObject({ to: 'joey', sender: 'system:alert' })
  expect('conversation_id' in b).toBe(false)
  expect(b.body).toContain('⚠️ 系統警告')
  expect(apiK.calls).toEqual([]); expect((await health(k)).connector.bot_api_refused).toEqual({})
})

test('8. no owner (no ONSEN_OWNER, access.json maps to no member): one error line, /healthz connector.owner null; a permission prompt asks nobody (no Action, no Telegram)', async () => {
  const c = await n.client()
  await c.notification({ method: 'notifications/claude/channel/permission_request', params: { request_id: 'nooww', tool_name: 'Bash', description: 'run ls', input_preview: '{"command":"ls"}' } })
  await sleep(1500)
  expect(made('n', () => true)).toHaveLength(0)
  expect((await health(n)).connector.owner).toBeNull()
  expect(n.log().split('\n').filter(l => l.includes('has no owner: ONSEN_OWNER is not set')).length).toBe(1)
  expect(apiN.calls).toEqual([]); expect((await health(n)).connector.bot_api_refused).toEqual({})
})
