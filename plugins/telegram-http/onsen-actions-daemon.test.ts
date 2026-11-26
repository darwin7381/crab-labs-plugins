// WO-176 (daemon side) end to end: a real Telegram daemon (server.ts, lanes off) and real agent-inbox daemons against the Bot API stand-in and a stand-in
// Onsen (fleet-core onsen_actions.py's contract: /v1/actions create, resolve, applied, cancel, GET; the inbox pull), in temp dirs (their HOME too).
// Nothing reaches core.kbro.ai; no tmux.
//   permission prompt    Telegram exactly as before (one copy per person, See more / Allow / Deny); an Action (permission, allow / deny, the people it
//                        went to). A tap: Claude Code answered, the Action resolved by the presser then applied, only the tapped copy edited (as before).
//                        A press in Onsen (POST /onsen/action): Claude Code answered, applied, every copy edited ending 「從 Onsen 按的」. Onsen first and
//                        Telegram pressed: applied with what Telegram pressed. The session closed: cancelled. Onsen down or slow: nothing waits for it.
//   inbox                an action_control item is handed to the Telegram daemon, never to a session; not taken: tried 3 times, then acked and the
//                        Action cancelled ("daemon could not apply"); the next message is delivered either way
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, freePort, sleep, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828173984, TESTER = 6736970916
const CRED = 'mesh_ACTIONSsecretSECRETsecretSECRET012345', CRED2 = 'mesh_ACTIONStwoSECRETsecretSECRET01234567'
const CALLER: Record<string, string> = { [CRED]: 'adam', [CRED2]: 'bea' }

// ------------------------------------------------------------------ the stand-in Onsen
type ACall = { caller: string; method: string; path: string; body: any; idem: string | null; at: number }
const calls: ACall[] = []
const actions = new Map<string, any>()
const mode = { actions: 'ok' as 'ok' | 'down' | 'slow' }
type MItem = { recipient: string; seq: number; sender: string; kind: string; payload: any; dedupe: string | null; acked: boolean }
const inbox = { items: [] as MItem[], last: new Map<string, number>() }
let nextAction = 100
const err = (status: number, code: string, message: string) => Response.json({ error: { code, message, retryable: false } }, { status })
function put(recipient: string, sender: string, kind: string, payload: any, dedupe: string | null): number {
  const seq = (inbox.last.get(recipient) ?? 0) + 1
  inbox.last.set(recipient, seq)
  inbox.items.push({ recipient, seq, sender, kind, payload, dedupe, acked: false })
  return seq
}
let onsenPort = 0, onsenSrv: ReturnType<typeof Bun.serve> | null = null
function startOnsen(): void {
  onsenSrv = Bun.serve({ port: onsenPort, hostname: '127.0.0.1', idleTimeout: 30, async fetch(req) {
    const u = new URL(req.url), path = u.pathname.replace(/^\/api\/onsen/, '')
    const caller = CALLER[String(req.headers.get('authorization') ?? '').replace(/^Bearer /, '')]
    if (!caller) return Response.json({ detail: 'auth' }, { status: 401 })
    const body: any = req.method === 'POST' ? await req.json().catch(() => ({})) : undefined
    if (path.startsWith('/v1/actions')) {
      calls.push({ caller, method: req.method, path, body, idem: req.headers.get('idempotency-key'), at: Date.now() })
      if (mode.actions === 'down') return err(503, 'service_unavailable', 'down')
      if (mode.actions === 'slow') await sleep(8000)
      if (path === '/v1/actions' && req.method === 'POST') {
        const id = String(++nextAction), now = new Date().toISOString()
        const a = { id, version: 1, requested_by: caller, state: body.state ?? 'open', resolved_by: body.resolved_by ?? null, selected_option_id: body.selected_option_id ?? null,
          applied_at: body.state === 'resolved' ? now : null, ...body }
        actions.set(id, a)
        return Response.json({ data: a }, { status: 201 })
      }
      const m = /^\/v1\/actions\/(\d+)(?:\/(\w+))?$/.exec(path)
      const a = m ? actions.get(m[1]!) : null
      if (!a) return err(404, 'not_found', `沒有 ${m?.[1]} 這個動作`)
      if (req.method === 'GET') return Response.json({ data: a })
      const op = m![2]
      if (op === 'resolve') {
        if (a.state !== 'open') return err(409, 'version_conflict', `動作 ${a.id} 已經${a.state}`)
        if (body.expected_version !== a.version) return err(409, 'version_conflict', '版本對不上')
        if (!a.assignees.includes(body.resolved_by)) return err(400, 'invalid_request', 'resolved_by')
        Object.assign(a, { state: 'resolved', selected_option_id: body.option_id, resolved_by: body.resolved_by, version: a.version + 1 })
        return Response.json({ data: a })
      }
      if (op === 'applied') {
        if (a.state !== 'resolved') return err(409, 'version_conflict', `動作 ${a.id} 是 ${a.state}`)
        const other = body.option_id != null && body.option_id !== a.selected_option_id
        if (a.applied_at) return other ? err(409, 'version_conflict', '已經套用') : Response.json({ data: a })
        if (other && !a.assignees.includes(body.resolved_by)) return err(400, 'invalid_request', 'resolved_by')
        Object.assign(a, { applied_at: body.at ?? new Date().toISOString(), version: a.version + 1, ...(other ? { selected_option_id: body.option_id, resolved_by: body.resolved_by } : {}) })
        return Response.json({ data: a })
      }
      if (op === 'cancel') {
        if (!(a.state === 'open' || (a.state === 'resolved' && !a.applied_at))) return err(409, 'version_conflict', `動作 ${a.id} 已經${a.state}`)
        if (body.expected_version !== a.version) return err(409, 'version_conflict', '版本對不上')
        Object.assign(a, { state: 'cancelled', cancel_reason: body.reason ?? null, version: a.version + 1 })
        return Response.json({ data: a })
      }
      return err(404, 'not_found', 'no route')
    }
    if (path === '/inbox' && req.method === 'GET') {
      const after = Number(u.searchParams.get('after') ?? 0), wait = Math.min(1, Number(u.searchParams.get('wait') ?? 0))
      const last = inbox.last.get(caller) ?? 0
      if (after > last) return Response.json({ agent: caller, items: [], reset: true, continue_after: last, last_seq: last })
      const end = Date.now() + wait * 1000
      let rows: MItem[] = []
      while (true) {
        rows = inbox.items.filter(i => i.recipient === caller && i.seq > after)
        if (rows.length || Date.now() >= end) break
        await sleep(25)
      }
      return Response.json({ agent: caller, last_seq: last, acked_seq: 0, items: rows.map(i => ({ seq: i.seq, sender: i.sender, relay: null, kind: i.kind, payload: i.payload,
        dedupe: i.dedupe, unverified: false, at: new Date().toISOString(), given: 1 })) })
    }
    if (path === '/inbox/ack' && req.method === 'POST') {
      for (const i of inbox.items) if (i.recipient === caller && i.seq <= body.upto) i.acked = true
      return Response.json({ acked: true })
    }
    return Response.json({ detail: 'no route' }, { status: 404 })
  } })
}
/** Onsen's resolve of an Action by a person in Onsen: the record moves (v+1); the control item goes in the requester's inbox */
function pressInOnsen(id: string, option: string, by = 'joey', recipient?: string): { action_id: string; option_id: string; version: number } {
  const a = actions.get(id)!
  Object.assign(a, { state: 'resolved', selected_option_id: option, resolved_by: by, version: a.version + 1 })
  const c = { action_id: id, option_id: option, version: a.version }
  if (recipient) put(recipient, 'onsen', 'action_control', { version: a.version, action_id: id, option_id: option }, `action:${id}:v${a.version}`)
  return c
}
const of = (id: string, op?: string) => calls.filter(c => c.path === `/v1/actions/${id}${op ? `/${op}` : ''}` && c.method === 'POST')
const created = (summary: string) => calls.find(c => c.path === '/v1/actions' && c.body?.summary === summary)
const idOf = (summary: string): string => [...actions.values()].find(a => a.summary === summary)!.id

// ------------------------------------------------------------------ the daemons
let root = '', api: BotApiMock, tg: TgDaemon, tok = ''
type Session = { client: Client; transport: StreamableHTTPClientTransport; perms: any[]; channel: any[] }
const sessions: Session[] = []
async function session(port: number, token: string): Promise<Session> {
  const s: Session = { client: new Client({ name: 'wo176', version: '0' }, { capabilities: {} }), transport: null as any, perms: [], channel: [] }
  s.client.fallbackNotificationHandler = async n => {
    if (n.method === 'notifications/claude/channel/permission') s.perms.push(n.params)
    if (n.method === 'notifications/claude/channel') s.channel.push(n.params)
  }
  s.transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  await s.client.connect(s.transport)
  await sleep(500)
  sessions.push(s)
  return s
}
const ask = (s: Session, request_id: string, tool = 'Bash', description = 'git push origin main') =>
  s.client.notification({ method: 'notifications/claude/channel/permission_request', params: { request_id, tool_name: tool, description, input_preview: JSON.stringify({ command: description }) } })
const permSends = (tool: string) => api.of('sendMessage').filter(c => c.body.text === `🔐 Permission: ${tool}`)
/** the message id the Bot API stand-in gave a send (it counts every send from 5001, in the order they are recorded) */
const SENDS = new Set(['sendMessage', 'sendRichMessage', 'sendPhoto', 'sendDocument'])
const msgIdOf = (call: unknown): number => 5000 + api.calls.filter(c => SENDS.has(c.method)).indexOf(call as any) + 1
let cbId = 0
const tap = (from: number, data: string, message_id: number, text: string) => api.push({ callback_query: { id: `cb${++cbId}`, chat_instance: 'x', data,
  from: { id: from, is_bot: false, first_name: 'J' }, message: { message_id, date: Math.floor(Date.now() / 1000), chat: { id: from, type: 'private' }, text } } })
const control = (body: unknown, token = tok) => fetch(`http://127.0.0.1:${tg.port}/onsen/action`, { method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
type Inbox = { port: number; proc: { kill(): void; exited: Promise<number> }; log: () => string; health: () => Promise<any> }
const inboxes: Inbox[] = []
async function bootInbox(name: string, cred: string, env: Record<string, string>): Promise<Inbox> {
  const home = join(root, name, 'ihome'), ws = join(root, name, 'iws'), stateDir = join(ws, '.agent-inbox-state')
  for (const d of [home, ws, stateDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(stateDir, 'mesh-credential'), cred + '\n')
  const port = await freePort()
  const proc = Bun.spawn(['bun', join(import.meta.dir, 'server.ts')], {
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? '', HOME: home, CHANNEL_INBOX_ONLY: '1', TELEGRAM_HTTP_PORT: String(port), TELEGRAM_STATE_DIR: stateDir, AGENT_WORKSPACE_DIR: ws,
      MCP_READY_DELAY_MS: '200', CRAB_LABS_PLUGINS_ENV: join(root, 'no-machine-config'), HUB_SYNC: '0', USAGE_WALL_READ: '0', TYPESAFE_KEY_FILE: '/nonexistent/typesafe.env',
      MESH_CREDENTIALS_TABLE: join(root, 'mesh-credentials.json'), ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, ONSEN_PULL_WAIT_S: '1', ONSEN_PULL_BACKOFF_MS: '150',
      ONSEN_HOST: 'lab-host', MCP_TOKEN_DIR: join(root, 'tg', 'tok'), AGENT_INBOX_REGISTRY: join(root, 'registry.json'), ...env },
    stdout: 'ignore', stderr: 'ignore',
  })
  const health = () => fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.json()).catch(() => null) as Promise<any>
  if (!await until(async () => (await health())?.ok === true, 20000)) throw new Error(`inbox daemon ${name} did not start`)
  const d = { port, proc, health, log: () => { try { return readFileSync(join(stateDir, 'server.log'), 'utf8') } catch { return '' } } }
  inboxes.push(d)
  return d
}

beforeAll(async () => {
  onsenPort = await freePort()
  startOnsen()
  root = mkdtempSync(join(tmpdir(), 'onsen-actions-daemon-'))
  writeFileSync(join(root, 'mesh-credentials.json'), JSON.stringify({ identities: {}, hashes: {} }))
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ adam: { url: 'http://127.0.0.1:9/inject' } }))
  writeFileSync(join(root, 'cred'), CRED + '\n')
  api = startBotApiMock({}, { pollHoldMs: 300 })
  tg = await startTgDaemon(api, join(root, 'tg'), JOEY, { GENESIS_LANES: '0', ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, ONSEN_RECORD: '0',
    ONSEN_CREDENTIAL_FILE: join(root, 'cred'), AGENT_INBOX_REGISTRY: join(root, 'registry.json') })
  // two people get ops traffic: Joey and his test account (two copies of each prompt)
  const af = join(tg.stateDir, 'access.json')
  writeFileSync(af, JSON.stringify({ ...JSON.parse(readFileSync(af, 'utf8')), allowFrom: [String(JOEY), String(TESTER)] }))
  tok = readFileSync(join(root, 'tg', 'tok', String(tg.port)), 'utf8').trim()
}, 60000)
afterAll(async () => {
  for (const s of sessions) { try { await s.client.close() } catch {} }
  for (const d of inboxes) { try { d.proc.kill() } catch {} }
  await tg?.stop(); api?.stop(); onsenSrv?.stop(true)
})

test('a permission prompt: Telegram as before (a copy per person, the same three buttons), and an Action (permission, allow / deny, the people it went to)', async () => {
  const s = await session(tg.port, tok)
  await ask(s, 'abcde')
  expect(await until(() => permSends('Bash').length === 2 && !!created('Bash：git push origin main'))).toBe(true)
  for (const c of permSends('Bash')) {
    expect(c.body.reply_markup).toEqual({ inline_keyboard: [[{ text: 'See more', callback_data: 'perm:more:abcde' }, { text: '✅ Allow', callback_data: 'perm:allow:abcde' },
      { text: '❌ Deny', callback_data: 'perm:deny:abcde' }]] })
  }
  expect(permSends('Bash').map(c => String(c.body.chat_id)).sort()).toEqual([String(JOEY), String(TESTER)].sort())
  const c = created('Bash：git push origin main')!
  expect(c.caller).toBe('adam')
  expect(c.idem).toMatch(/^perm:adam:abcde:\d+$/)
  expect(c.body).toEqual({ source: 'permission', menu_kind: 'permission', session_id: 'main', assignees: ['joey', 'joey-test'], summary: 'Bash：git push origin main',
    body: { format: 'markdown', text: '**Bash**\n\ngit push origin main\n\n```\n{\n  "command": "git push origin main"\n}\n```' },
    options: [{ id: 'allow', label: '允許' }, { id: 'deny', label: '拒絕' }] })
}, 30000)

test('pressed in Telegram: Claude Code is answered; the Action is resolved by the presser, then applied; only the tapped copy is edited, as before', async () => {
  const s = await session(tg.port, tok)
  await ask(s, 'bcdef', 'Edit', 'edit README.md')
  expect(await until(() => !!created('Edit：edit README.md') && permSends('Edit').length === 2)).toBe(true)
  const id = idOf('Edit：edit README.md')
  const e0 = api.of('editMessageText').length
  tap(TESTER, 'perm:allow:bcdef', 7001, '🔐 Permission: Edit')
  expect(await until(() => s.perms.length === 1)).toBe(true)
  expect(s.perms[0]).toEqual({ request_id: 'bcdef', behavior: 'allow' })
  expect(await until(() => of(id, 'applied').length === 1)).toBe(true)
  expect(of(id, 'resolve')[0]!.body).toEqual({ option_id: 'allow', expected_version: 1, resolved_by: 'joey-test' })
  expect(of(id, 'applied')[0]!.body).toEqual({ at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) })
  expect(actions.get(id)).toMatchObject({ state: 'resolved', selected_option_id: 'allow', resolved_by: 'joey-test' })
  expect(await until(() => api.of('editMessageText').length === e0 + 1)).toBe(true)
  await sleep(300)
  const edits = api.of('editMessageText').slice(e0)
  expect(edits).toHaveLength(1)
  expect(edits[0]!.body).toMatchObject({ message_id: 7001, text: '🔐 Permission: Edit\n\n✅ Allowed' })
  // a typed answer (`no xxxxx`) too
  await ask(s, 'cdefg', 'Write', 'write a.txt')
  expect(await until(() => !!created('Write：write a.txt'))).toBe(true)
  const id2 = idOf('Write：write a.txt')
  api.push({ message: { message_id: 3001, date: Math.floor(Date.now() / 1000), chat: { id: JOEY, type: 'private', first_name: 'J' }, from: { id: JOEY, is_bot: false, first_name: 'J' }, text: 'no cdefg' } })
  expect(await until(() => s.perms.length === 2)).toBe(true)
  expect(s.perms[1]).toEqual({ request_id: 'cdefg', behavior: 'deny' })
  expect(await until(() => of(id2, 'applied').length === 1)).toBe(true)
  expect(of(id2, 'resolve')[0]!.body).toMatchObject({ option_id: 'deny', resolved_by: 'joey' })
}, 30000)

test('pressed in Onsen: Claude Code is answered, the Action applied, every copy edited ending 「從 Onsen 按的」; the same control again presses nothing', async () => {
  const s = await session(tg.port, tok)
  await ask(s, 'defgh', 'Bash', 'rm -rf build')
  expect(await until(() => !!created('Bash：rm -rf build') && permSends('Bash').length === 4)).toBe(true)
  const id = idOf('Bash：rm -rf build')
  const e0 = api.of('editMessageText').length
  const c = pressInOnsen(id, 'deny')
  expect((await control(c)).status).toBe(202)
  expect(await until(() => s.perms.length === 1)).toBe(true)
  expect(s.perms[0]).toEqual({ request_id: 'defgh', behavior: 'deny' })
  expect(await until(() => of(id, 'applied').length === 1)).toBe(true)
  expect(of(id, 'applied')[0]!.body).toEqual({ at: expect.any(String) })
  expect(await until(() => api.of('editMessageText').length === e0 + 2)).toBe(true)
  const edits = api.of('editMessageText').slice(e0)
  expect(edits.map(e => String(e.body.chat_id)).sort()).toEqual([String(JOEY), String(TESTER)].sort())
  for (const e of edits) {
    expect(e.body.text).toBe('🔐 Permission: Bash\n\n❌ Denied\n從 Onsen 按的')
    expect(e.body.reply_markup).toEqual({ inline_keyboard: [] })
  }
  expect(of(id, 'resolve')).toHaveLength(0)                            // Onsen resolved it; the daemon only reports applied
  // the same control again (a redelivery): applied (no change), nothing pressed or edited twice
  expect((await control(c)).status).toBe(202)
  expect(await until(() => of(id, 'applied').length === 2)).toBe(true)
  await sleep(300)
  expect(s.perms).toHaveLength(1)
  expect(api.of('editMessageText').length).toBe(e0 + 2)
  // a tap after that: Claude Code is not answered twice
  tap(JOEY, 'perm:allow:defgh', 7002, '🔐 Permission: Bash')
  await sleep(800)
  expect(s.perms).toHaveLength(1)
}, 30000)

test('See more, then a press in Onsen: the expanded copy keeps its text', async () => {
  const s = await session(tg.port, tok)
  await ask(s, 'efghi', 'Read', 'read secrets.txt')
  expect(await until(() => !!created('Read：read secrets.txt') && permSends('Read').length === 2)).toBe(true)
  const id = idOf('Read：read secrets.txt')
  const joeyCopy = permSends('Read').find(c => String(c.body.chat_id) === String(JOEY))!, joeyMsg = msgIdOf(joeyCopy)
  const testerMsg = msgIdOf(permSends('Read').find(c => String(c.body.chat_id) === String(TESTER)))
  await sleep(300)                                                     // the copies' ids are kept once the sends answered
  const e1 = api.of('editMessageText').length
  tap(JOEY, 'perm:more:efghi', joeyMsg, '🔐 Permission: Read')
  expect(await until(() => api.of('editMessageText').length === e1 + 1)).toBe(true)
  const expanded = api.of('editMessageText')[e1]!.body.text as string
  expect(expanded.startsWith('🔐 Permission: Read\n\ntool_name: Read\ndescription: read secrets.txt\ninput_preview:\n{')).toBe(true)   // See more as before
  const c = pressInOnsen(id, 'allow')
  const e0 = api.of('editMessageText').length
  expect((await control(c)).status).toBe(202)
  expect(await until(() => api.of('editMessageText').length === e0 + 2)).toBe(true)
  const byMsg = new Map(api.of('editMessageText').slice(e0).map(e => [Number(e.body.message_id), e.body.text]))
  expect(byMsg.get(joeyMsg)).toBe(`${expanded}\n\n✅ Allowed\n從 Onsen 按的`)
  expect(byMsg.get(testerMsg)).toBe('🔐 Permission: Read\n\n✅ Allowed\n從 Onsen 按的')
}, 30000)

test('Onsen answered first, then Telegram was pressed: Onsen hears what Telegram pressed; the control that comes after presses nothing', async () => {
  const s = await session(tg.port, tok)
  await ask(s, 'fghij', 'Bash', 'git status')
  expect(await until(() => !!created('Bash：git status'))).toBe(true)
  const id = idOf('Bash：git status')
  const c = pressInOnsen(id, 'deny')                                   // resolved in Onsen, its control not here yet
  tap(JOEY, 'perm:allow:fghij', 7003, '🔐 Permission: Bash')
  expect(await until(() => s.perms.length === 1)).toBe(true)
  expect(s.perms[0]).toEqual({ request_id: 'fghij', behavior: 'allow' })
  expect(await until(() => of(id, 'applied').length === 1)).toBe(true)
  expect(of(id, 'resolve')).toHaveLength(1)                            // 409
  expect(of(id, 'applied')[0]!.body).toMatchObject({ option_id: 'allow', resolved_by: 'joey' })
  expect(actions.get(id)).toMatchObject({ selected_option_id: 'allow', resolved_by: 'joey' })
  expect(actions.get(id).applied_at).toBeTruthy()
  expect((await control(c)).status).toBe(202)
  expect(await until(() => of(id, 'applied').length === 2)).toBe(true)
  expect(of(id, 'applied')[1]!.body).toMatchObject({ option_id: 'allow', resolved_by: 'joey' })
  await sleep(300)
  expect(s.perms).toHaveLength(1)
}, 30000)

test('the session closed with the prompt open: the Action is cancelled; a control that comes after presses nothing', async () => {
  const s = await session(tg.port, tok)
  await ask(s, 'ghijk', 'Bash', 'make deploy')
  expect(await until(() => !!created('Bash：make deploy'))).toBe(true)
  const id = idOf('Bash：make deploy')
  await sleep(200)
  await s.transport.terminateSession()
  await s.client.close()
  expect(await until(() => of(id, 'cancel').length === 1)).toBe(true)
  expect(of(id, 'cancel')[0]!.body).toEqual({ expected_version: 1, reason: '對話關了' })
  expect(actions.get(id).state).toBe('cancelled')
  const e0 = api.of('editMessageText').length
  expect((await control({ action_id: id, option_id: 'allow', version: 2 })).status).toBe(202)
  await sleep(600)
  expect(s.perms).toHaveLength(0)
  expect(api.of('editMessageText').length).toBe(e0)
  expect(of(id, 'cancel')).toHaveLength(1)                             // over already: no second call
}, 30000)

test('a control for an Action this daemon has no prompt or menu for: cancelled (at the control\'s version), nothing pressed; a bad body or no token: refused', async () => {
  actions.set('900', { id: '900', version: 2, requested_by: 'adam', state: 'resolved', assignees: ['joey'], selected_option_id: 'allow', applied_at: null, options: [] })
  expect((await control({ action_id: '900', option_id: 'allow', version: 2 })).status).toBe(202)
  expect(await until(() => of('900', 'cancel').length === 1)).toBe(true)
  expect(of('900', 'cancel')[0]!.body).toMatchObject({ expected_version: 2, reason: expect.stringContaining('不在') })
  expect(actions.get('900').state).toBe('cancelled')
  expect((await control({ action_id: 'x', option_id: 'allow', version: 2 })).status).toBe(400)
  expect((await control({ action_id: '901', option_id: 'allow' })).status).toBe(400)
  const noTok = await fetch(`http://127.0.0.1:${tg.port}/onsen/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  expect([400, 503]).toContain(noTok.status)                          // report-first gate (MCP_REQUIRE_TOKEN unset): through, then the body is refused
}, 30000)

test('Onsen down (503) or slow (8 s): the prompt reaches Telegram and the tap reaches Claude Code at once', async () => {
  const s = await session(tg.port, tok)
  for (const m of ['down', 'slow'] as const) {
    mode.actions = m
    const rid = m === 'down' ? 'hijkm' : 'ijkmn', tool = m === 'down' ? 'Glob' : 'Grep'
    const t0 = Date.now()
    await ask(s, rid, tool, `look ${m}`)
    expect(await until(() => permSends(tool).length === 2, 3000)).toBe(true)
    expect(Date.now() - t0).toBeLessThan(2500)
    const n = s.perms.length
    const t1 = Date.now()
    tap(JOEY, `perm:allow:${rid}`, 7100 + n, `🔐 Permission: ${tool}`)
    expect(await until(() => s.perms.length === n + 1, 3000)).toBe(true)
    expect(Date.now() - t1).toBeLessThan(2500)
    // down: the create is tried three times (1 s, 4 s apart), then logged; the tap's calls wait behind it and are dropped with it
    if (m === 'down') expect(await until(() => /onsen action: create perm:adam:hijkm:\d+: HTTP 503/.test(tg.log()), 15000)).toBe(true)
  }
  mode.actions = 'ok'
}, 40000)

test('the inbox daemon: an action_control item goes to the Telegram daemon (pressed there), never to a session; the next message is delivered', async () => {
  const s = await session(tg.port, tok)
  await ask(s, 'jkmnp', 'Bash', 'npm publish')
  expect(await until(() => !!created('Bash：npm publish'))).toBe(true)
  const id = idOf('Bash：npm publish')
  const ib = await bootInbox('adam', CRED, { AGENT_INBOX_SELF: 'adam', ONSEN_PULL: 'adam', LANES_TG_PORT: String(tg.port) })
  const is = await session(ib.port, readFileSync(join(root, 'tg', 'tok', String(ib.port)), 'utf8').trim())
  pressInOnsen(id, 'allow', 'joey', 'adam')
  put('adam', 'eve', 'peer_call', { text: 'WO176 after the control', no_reply: true }, 'msg-after-1')
  expect(await until(() => s.perms.length === 1, 15000)).toBe(true)
  expect(s.perms[0]).toEqual({ request_id: 'jkmnp', behavior: 'allow' })
  expect(await until(() => of(id, 'applied').length === 1)).toBe(true)
  expect(await until(() => is.channel.some(p => String(p.content).includes('WO176 after the control')), 15000)).toBe(true)
  expect(is.channel.some(p => /action_control|"action_id"/.test(JSON.stringify(p)))).toBe(false)   // the session never saw the control
  expect(await until(() => inbox.items.filter(i => i.recipient === 'adam').every(i => i.acked), 10000)).toBe(true)
  expect(ib.log()).toMatch(/action_control\) action \d+ allow v2: handed to the Telegram daemon/)
}, 60000)

test('the Telegram daemon does not take it: three tries, then acked, the Action cancelled ("daemon could not apply"), and the next message is delivered', async () => {
  const dead = await freePort()
  actions.set('950', { id: '950', version: 1, requested_by: 'bea', state: 'open', assignees: ['joey'], selected_option_id: null, applied_at: null, options: [{ id: 'allow', label: '允許' }] })
  const ib = await bootInbox('bea', CRED2, { AGENT_INBOX_SELF: 'bea', ONSEN_PULL: 'bea', LANES_TG_PORT: String(dead), ONSEN_ACTION_FORWARD_GAPS_MS: '200,400' })
  const is = await session(ib.port, readFileSync(join(root, 'tg', 'tok', String(ib.port)), 'utf8').trim())
  pressInOnsen('950', 'allow', 'joey', 'bea')
  put('bea', 'eve', 'peer_call', { text: 'WO176 behind a stuck control', no_reply: true }, 'msg-after-2')
  expect(await until(() => of('950', 'cancel').length === 1, 15000)).toBe(true)
  expect(of('950', 'cancel')[0]).toMatchObject({ caller: 'bea', body: { expected_version: 2, reason: 'daemon could not apply' } })
  expect(await until(() => is.channel.some(p => String(p.content).includes('WO176 behind a stuck control')), 15000)).toBe(true)
  expect(await until(() => inbox.items.filter(i => i.recipient === 'bea').every(i => i.acked), 10000)).toBe(true)
  expect((ib.log().match(/the Telegram daemon did not take it \(try \d of 3/g) ?? []).length).toBe(3)
  expect(ib.log()).toContain('not handed over')
}, 60000)

test('the Telegram daemon restarts with a prompt open: its Action is cancelled at the next start (nobody can answer it there any more)', async () => {
  const s = await session(tg.port, tok)
  await ask(s, 'kmnpq', 'Bash', 'kubectl apply')
  expect(await until(() => !!created('Bash：kubectl apply'))).toBe(true)
  const id = idOf('Bash：kubectl apply')
  await sleep(300)
  const open = JSON.parse(readFileSync(join(tg.stateDir, 'onsen', 'open-permission-actions.json'), 'utf8'))
  expect(open[id]).toBe(1)
  expect(open[idOf('Bash：git push origin main')]).toBe(1)             // the first test's prompt, never answered, is open too
  expect(Object.keys(open).every(k => actions.get(k)?.state === 'open')).toBe(true)
  await tg.stop()
  tg = await startTgDaemon(api, join(root, 'tg'), JOEY, { GENESIS_LANES: '0', ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, ONSEN_RECORD: '0',
    ONSEN_CREDENTIAL_FILE: join(root, 'cred'), AGENT_INBOX_REGISTRY: join(root, 'registry.json') })
  expect(await until(() => of(id, 'cancel').length === 1, 15000)).toBe(true)
  expect(of(id, 'cancel')[0]!.body).toMatchObject({ expected_version: 1, reason: expect.stringContaining('常駐程式重開了') })
  expect(await until(() => Object.keys(open).every(k => actions.get(k)?.state === 'cancelled'), 10000)).toBe(true)
  expect(JSON.parse(readFileSync(join(tg.stateDir, 'onsen', 'open-permission-actions.json'), 'utf8'))).toEqual({})
}, 60000)
