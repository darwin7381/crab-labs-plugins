// Roaming Telegram prompt behaviour, with Onsen and Telegram served on loopback.
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
type ACall = { caller: string; method: string; path: string; body: any; idem: string | null; at: number; refused?: boolean }
// the fields Onsen 0.24.3 takes on each write (onsen_actions.py; body_json refuses any other with 400 「不收的欄位」)
const FIELDS: Record<string, string[]> = { create: ['kind', 'source', 'requested_by', 'session_id', 'assignees', 'summary', 'body', 'options', 'expires_at', 'refs',
  'menu_kind', 'state', 'selected_option_id', 'resolved_by', 'note', 'action_id', 'opened_at', 'resolved_at'], resolve: ['option_id', 'expected_version', 'note', 'resolved_by', 'session_id', 'at'],
  applied: ['at', 'option_id', 'resolved_by'], cancel: ['expected_version', 'reason', 'note'] }   // Onsen 0.35.8: note
const calls: ACall[] = []
const actions = new Map<string, any>()
const mode = { actions: 'ok' as 'ok' | 'down' | 'slow' }
let nextAction = 100
const err = (status: number, code: string, message: string) => Response.json({ error: { code, message, retryable: false } }, { status })
let onsenPort = 0, onsenSrv: ReturnType<typeof Bun.serve> | null = null
function startOnsen(): void {
  onsenSrv = Bun.serve({ port: onsenPort, hostname: '127.0.0.1', idleTimeout: 30, async fetch(req) {
    const u = new URL(req.url), path = u.pathname.replace(/^\/api\/onsen/, '')
    const caller = CALLER[String(req.headers.get('authorization') ?? '').replace(/^Bearer /, '')]
    if (!caller) return Response.json({ detail: 'auth' }, { status: 401 })
    const body: any = req.method === 'POST' ? await req.json().catch(() => ({})) : undefined
    if (path.startsWith('/v1/actions')) {
      const call: ACall = { caller, method: req.method, path, body, idem: req.headers.get('idempotency-key'), at: Date.now() }
      calls.push(call)
      if (mode.actions === 'down') return err(503, 'service_unavailable', 'down')
      const which = path === '/v1/actions' ? 'create' : path.match(/\/(resolve|applied|cancel)$/)?.[1]
      const bad = req.method === 'POST' && which ? Object.keys(body ?? {}).filter(k => !FIELDS[which]!.includes(k)) : []
      if (bad.length) { call.refused = true; return err(400, 'invalid_request', `不收的欄位：${bad.join('、')}；收：${FIELDS[which!]!.join('、')}`) }
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
        if (!a.assignees.includes(body.resolved_by) && body.resolved_by !== 'duty-officer') return err(400, 'invalid_request', 'resolved_by')   // 0.24.3: the officer as it is
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
    return Response.json({ detail: 'no route' }, { status: 404 })
  } })
}
const of = (id: string, op?: string) => calls.filter(c => c.path === `/v1/actions/${id}${op ? `/${op}` : ''}` && c.method === 'POST' && !c.refused)
const created = (summary: string) => calls.find(c => c.path === '/v1/actions' && c.body?.summary === summary && !c.refused)
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
beforeAll(async () => {
  onsenPort = await freePort()
  startOnsen()
  root = mkdtempSync(join(tmpdir(), 'onsen-actions-daemon-'))
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ adam: { url: 'http://127.0.0.1:9/inject' } }))
  api = startBotApiMock({}, { pollHoldMs: 300 })
  tg = await startTgDaemon(api, join(root, 'tg'), JOEY, { ROAMER_MODE: '1', GENESIS_LANES: '0', ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, ONSEN_RECORD: '0',
    FIXTURE_MEMBER_TOKEN: CRED, AGENT_INBOX_REGISTRY: join(root, 'registry.json') })
  // two people get ops traffic: Joey and his test account (two copies of each prompt)
  const af = join(tg.stateDir, 'access.json')
  writeFileSync(af, JSON.stringify({ ...JSON.parse(readFileSync(af, 'utf8')), allowFrom: [String(JOEY), String(TESTER)] }))
  tok = 'test-loopback'
}, 60000)
afterAll(async () => {
  for (const s of sessions) { try { await s.client.close() } catch {} }
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
  // the Actions client's own counts are on /healthz (onsen.actions: OnsenActions.health(), wired in 1.58.7)
  const h = await fetch(`http://127.0.0.1:${tg.port}/healthz`).then(r => r.json()) as any
  expect(h.onsen.actions).toMatchObject({ on: true, failed: 0 })
  expect(h.onsen.actions.created).toBeGreaterThanOrEqual(1)
  expect(typeof h.onsen.actions.followed).toBe('number')
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
  expect(await until(() => of(id, 'resolve').length === 1)).toBe(true)
  // r3 (Onsen 0.24.3): the resolve carries when it was pressed (`at`), and nothing Onsen refuses
  expect(of(id, 'resolve')[0]!.body).toEqual({ option_id: 'allow', expected_version: 1, resolved_by: 'joey-test', at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) })
  expect(calls.some(c => c.refused)).toBe(false)
  expect(of(id, 'applied')).toHaveLength(0)
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
  expect(await until(() => of(id2, 'resolve').length === 1)).toBe(true)
  expect(of(id2, 'resolve')[0]!.body).toMatchObject({ option_id: 'deny', resolved_by: 'joey' })
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

test('the Telegram daemon restarts with a prompt open: its Action is cancelled after the restart grace (nobody took it over; nobody can answer it there any more)', async () => {
  const s = await session(tg.port, tok)
  await ask(s, 'kmnpq', 'Bash', 'kubectl apply')
  expect(await until(() => !!created('Bash：kubectl apply'))).toBe(true)
  const id = idOf('Bash：kubectl apply')
  await sleep(300)
  const openRaw = readFileSync(join(tg.stateDir, 'onsen', 'open-permission-actions.json'), 'utf8')
  const open = JSON.parse(openRaw)
  expect(open[id]).toMatchObject({ v: 1, copies: [expect.objectContaining({ text: '🔐 Permission: Bash' }), expect.objectContaining({ text: '🔐 Permission: Bash' })] })   // r4: its copies too
  expect(open[idOf('Bash：git push origin main')]).toMatchObject({ v: 1 })   // the first test's prompt, never answered, is open too
  expect(Object.keys(open).every(k => actions.get(k)?.state === 'open')).toBe(true)
  await tg.stop()
  tg = await startTgDaemon(api, join(root, 'tg'), JOEY, { ROAMER_MODE: '1', GENESIS_LANES: '0', ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, ONSEN_RECORD: '0',
    FIXTURE_MEMBER_TOKEN: CRED, AGENT_INBOX_REGISTRY: join(root, 'registry.json'), ONSEN_PERM_RESTART_GRACE_MS: '3000' })
  const up = Date.now()
  // within the grace: still open (a duty officer asking about the prompt still on the screen would take it over); kept in the file
  await sleep(1000)
  expect(of(id, 'cancel')).toHaveLength(0)
  expect(JSON.parse(readFileSync(join(tg.stateDir, 'onsen', 'open-permission-actions.json'), 'utf8'))[id]).toMatchObject({ v: 1 })
  const e0 = api.of('editMessageText').length
  expect(await until(() => of(id, 'cancel').length === 1, 15000)).toBe(true)
  expect(Date.now() - up).toBeGreaterThanOrEqual(2500)
  expect(of(id, 'cancel')[0]!.body).toMatchObject({ expected_version: 1, reason: expect.stringContaining('常駐程式重開了') })
  expect(await until(() => Object.keys(open).every(k => actions.get(k)?.state === 'cancelled'), 10000)).toBe(true)
  expect(JSON.parse(readFileSync(join(tg.stateDir, 'onsen', 'open-permission-actions.json'), 'utf8'))).toEqual({})
  // r4: the copies of every prompt it cancelled close (they came from the old process; kept in the file)
  const msgs = new Set(Object.values(JSON.parse(openRaw)).flatMap((x: any) => x.copies.map((c: any) => c.msg)))   // a fresh parse (the matchers above touched `open`)
  expect(msgs.size).toBe(4)
  expect(await until(() => api.of('editMessageText').slice(e0).filter(e => msgs.has(Number(e.body.message_id)) && String(e.body.text).includes('不用按了：常駐程式重開了')).length === msgs.size)).toBe(true)
}, 60000)
