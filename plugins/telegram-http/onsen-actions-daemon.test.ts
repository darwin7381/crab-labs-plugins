// Roamer permission Actions through the connector.
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, freePort, sleep, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828173984
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
beforeAll(async () => {
  onsenPort = await freePort()
  startOnsen()
  root = mkdtempSync(join(tmpdir(), 'onsen-actions-daemon-'))
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ adam: { url: 'http://127.0.0.1:9/inject' } }))
  api = startBotApiMock({}, { pollHoldMs: 300 })
  tg = await startTgDaemon(api, join(root, 'tg'), JOEY, { ROAMER_MODE: '1', GENESIS_LANES: '0', ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, ONSEN_RECORD: '0',
    ONSEN_OWNER: 'joey', FIXTURE_MEMBER_TOKEN: CRED, AGENT_INBOX_REGISTRY: join(root, 'registry.json') })
  tok = 'test-loopback'
}, 60000)
afterAll(async () => {
  for (const s of sessions) { try { await s.client.close() } catch {} }
  await tg?.stop(); api?.stop(); onsenSrv?.stop(true)
})

test('a roamer writes the permission Action for its owner through Onsen', async () => {
  const s = await session(tg.port, tok)
  await ask(s, 'abcde')
  expect(await until(() => !!created('Bash：git push origin main'))).toBe(true)
  expect(api.calls).toEqual([])
  const c = created('Bash：git push origin main')!
  expect(c.caller).toBe('adam')
  expect(c.idem).toMatch(/^perm:adam:abcde:\d+$/)
  expect(c.body).toEqual({ source: 'permission', menu_kind: 'permission', session_id: 'main', assignees: ['joey'], summary: 'Bash：git push origin main',
    body: { format: 'markdown', text: '**Bash**\n\ngit push origin main\n\n```\n{\n  "command": "git push origin main"\n}\n```' },
    options: [{ id: 'allow', label: '允許' }, { id: 'deny', label: '拒絕' }] })
  // the Actions client's own counts are on /healthz (onsen.actions: OnsenActions.health(), wired in 1.58.7)
  const health = () => fetch(`http://127.0.0.1:${tg.port}/healthz`).then(r => r.json()) as Promise<any>
  expect(await until(async () => (await health()).onsen.actions.created >= 1)).toBe(true)
  const h = await health()
  expect(h.onsen.actions).toMatchObject({ on: true, failed: 0 })
  expect(typeof h.onsen.actions.followed).toBe('number')
}, 30000)

test('the Telegram daemon restarts with a prompt open: its Action is cancelled after the restart grace (nobody took it over; nobody can answer it there any more)', async () => {
  const s = await session(tg.port, tok)
  await ask(s, 'kmnpq', 'Bash', 'kubectl apply')
  expect(await until(() => !!created('Bash：kubectl apply'))).toBe(true)
  const id = idOf('Bash：kubectl apply')
  await sleep(300)
  const openRaw = readFileSync(join(tg.stateDir, 'onsen', 'open-permission-actions.json'), 'utf8')
  const open = JSON.parse(openRaw)
  expect(open[id]).toEqual({ v: 1 })
  expect(open[idOf('Bash：git push origin main')]).toMatchObject({ v: 1 })   // the first test's prompt, never answered, is open too
  expect(Object.keys(open).every(k => actions.get(k)?.state === 'open')).toBe(true)
  await tg.stop()
  tg = await startTgDaemon(api, join(root, 'tg'), JOEY, { ROAMER_MODE: '1', GENESIS_LANES: '0', ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, ONSEN_RECORD: '0',
    ONSEN_OWNER: 'joey', FIXTURE_MEMBER_TOKEN: CRED, AGENT_INBOX_REGISTRY: join(root, 'registry.json'), ONSEN_PERM_RESTART_GRACE_MS: '3000' })
  const up = Date.now()
  // within the grace: still open (a duty officer asking about the prompt still on the screen would take it over); kept in the file
  await sleep(1000)
  expect(of(id, 'cancel')).toHaveLength(0)
  expect(JSON.parse(readFileSync(join(tg.stateDir, 'onsen', 'open-permission-actions.json'), 'utf8'))[id]).toMatchObject({ v: 1 })
  expect(await until(() => of(id, 'cancel').length === 1, 15000)).toBe(true)
  expect(Date.now() - up).toBeGreaterThanOrEqual(2500)
  expect(of(id, 'cancel')[0]!.body).toMatchObject({ expected_version: 1, reason: expect.stringContaining('常駐程式重開了') })
  expect(await until(() => Object.keys(open).every(k => actions.get(k)?.state === 'cancelled'), 10000)).toBe(true)
  expect(JSON.parse(readFileSync(join(tg.stateDir, 'onsen', 'open-permission-actions.json'), 'utf8'))).toEqual({})
  expect(api.calls).toEqual([])
}, 60000)
