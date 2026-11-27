// Onsen step 2 (WO-142) end to end: a real Telegram daemon (server.ts, lanes off, control mode on a tmux pane) against the Bot API stand-in and a stand-in
// Onsen (a local HTTP server; nothing reaches core.kbro.ai). tmux runs on its own socket dir: the machine's tmux server is never touched.
//   - Joey edits a message the session has not seen yet (parked: no session): the parked copy takes the new text, delivered once
//   - Joey edits a message the session already has: a new inbound 〔… 改了他 HH:MMZ 那一則（tg:N）〕 + the new text; edit_delivered in Onsen
// 1.59.0: the daemon is a connector: Joey's messages and edits come as the bridge hands them over (person_message, person_edit:
// test-fixtures/tg-daemon.ts). The 1.58.x /clear case (its Telegram reply with the 5 s button 「不要讓它看到之前的」, the oline: / olift: presses) is gone:
// a connector's /clear offers that choice as an Action (onsen-connector-seg2-daemon.test.ts 4, 4b).
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startBotApiMock, dm, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, freePort, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const CRED = 'mesh_STEP2DAEMONsecretSECRETsecret0123456'
const TMUX = `onsen2-d-${process.pid}`
let api: BotApiMock, d: TgDaemon, root: string, sock: string, onsenPort: number
let up: ReturnType<typeof Bun.serve> | null = null
type Got = { method: string; path: string; body: any; at: number; paneHadClear?: boolean }
const got: Got[] = []
const lines: any[] = []
let next = 1
const tmuxEnv = (): Record<string, string> => { const e = { ...process.env, TMUX_TMPDIR: sock } as Record<string, string>; delete e.TMUX; return e }
const tm = (...a: string[]) => spawnSync('tmux', a, { env: tmuxEnv(), encoding: 'utf8' })
const pane = () => tm('capture-pane', '-p', '-t', TMUX).stdout ?? ''

function startOnsen(): void {
  up = Bun.serve({ port: onsenPort, hostname: '127.0.0.1', async fetch(req) {
    const u = new URL(req.url), path = u.pathname.replace(/^\/api\/onsen/, '')
    const body = req.method === 'POST' ? await req.json() : undefined
    const g: Got = { method: req.method, path: path + u.search, body, at: Date.now() }
    got.push(g)
    if (req.headers.get('authorization') !== `Bearer ${CRED}`) return Response.json({ error: 'auth' }, { status: 401 })
    if (path === '/messages/batch') return Response.json({ results: body.items.map(() => ({ id: next++, duplicate: false })) })
    if (path === '/events') return Response.json({ id: next++, duplicate: false, message_id: 1 })
    if (path === '/restart-lines' && req.method === 'POST') {
      g.paneHadClear = pane().includes('/clear')
      await Bun.sleep(600)                                     // a slow Onsen: /clear must still wait for the line
      const l = { ...body, id: next++, answered: Date.now(), paneHadClearAtAnswer: pane().includes('/clear') }
      lines.push(l)
      return Response.json({ id: l.id, at: l.at, duplicate: false })
    }
    if (path === '/restart-lines/lift') {
      const l = lines.find(x => x.id === body.line_id)
      if (!l) return Response.json({ detail: 'none' }, { status: 404 })
      l.lifted_at = body.at; l.lifted_by = body.by
      return Response.json({ id: l.id, at: l.at, chat: l.chat, by: null, lifted_at: l.lifted_at, lifted_by: l.lifted_by, duplicate: false, active: [] })
    }
    return Response.json({ error: 'no route' }, { status: 404 })
  } })
}
const evs = () => got.filter(g => g.path === '/events').map(g => g.body)

beforeAll(async () => {
  api = startBotApiMock({}, { pollHoldMs: 300 })
  root = mkdtempSync(join(tmpdir(), 'onsen2-daemon-'))
  sock = mkdtempSync(join(tmpdir(), 'onsen2-tmux-'))
  const made = tm('new-session', '-d', '-s', TMUX, '-x', '100', '-y', '20', 'cat')
  if (made.status !== 0) throw new Error(`tmux: ${made.stderr}`)
  onsenPort = await freePort()
  mkdirSync(join(root, 'cred'), { recursive: true })
  writeFileSync(join(root, 'cred', 'mesh-credential'), CRED + '\n')
  startOnsen()
  d = await startTgDaemon(api, root, JOEY, { GENESIS_LANES: '0', CHANNEL_BOT_TMUX_SESSION: TMUX, TMUX_TMPDIR: sock,
    ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'mesh-credential') })
}, 40000)
afterAll(async () => { await d?.stop(); api?.stop(); up?.stop(true); tm('kill-server') })

const received: Array<{ content: string; meta: Record<string, string> }> = []
async function session(): Promise<Client> {
  const c = new Client({ name: 'onsen2-test', version: '0' }, { capabilities: {} })
  c.fallbackNotificationHandler = async n => {
    if (n.method === 'notifications/claude/channel') { const p = n.params as any; received.push({ content: String(p?.content ?? ''), meta: p?.meta ?? {} }) }
  }
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${d.port}/mcp`)))
  return c
}
const pendingFiles = () => { try { return readdirSync(join(d.stateDir, 'inbox', 'pending')).filter(f => f.endsWith('.json')) } catch { return [] } }
const editOf = (id: number, date: number, text: string) => ({ edited_message: { message_id: id, date, edit_date: Math.floor(Date.now() / 1000),
  chat: { id: JOEY, type: 'private', first_name: 'J' }, from: { id: JOEY, is_bot: false, first_name: 'J', username: 'joey' }, text } })

test('an edit of a message no session has seen yet (parked): the parked copy takes the new text; the session gets it once, already corrected', async () => {
  const m = dm(JOEY, 4300, '還沒看到的原文')
  api.push(m)
  expect(await until(() => pendingFiles().some(f => readFileSync(join(d.stateDir, 'inbox', 'pending', f), 'utf8').includes('還沒看到的原文')), 10000)).toBe(true)
  api.push(editOf(4300, m.message.date, '改好的原文'))
  expect(await until(() => evs().some(e => e.kind === 'edit_delivered' && e.target_client_msg_id === '4300'), 10000)).toBe(true)
  expect(evs().find(e => e.kind === 'edit_delivered' && e.target_client_msg_id === '4300')).toMatchObject({ agent: 'adam', chat: String(JOEY), actor: 'system:daemon', data: { replaced_in_queue: true } })
  const parked = pendingFiles().map(f => readFileSync(join(d.stateDir, 'inbox', 'pending', f), 'utf8')).join('\n')
  expect(parked).toContain('改好的原文'); expect(parked).not.toContain('還沒看到的原文')
  await session()
  expect(await until(() => received.some(r => r.content === '改好的原文'), 15000)).toBe(true)
  await Bun.sleep(500)
  expect(received.filter(r => r.meta.message_id === '4300').map(r => r.content)).toEqual(['改好的原文'])
  expect(received.find(r => r.meta.message_id === '4300')!.meta).toMatchObject({ edited: 'true', chat_id: String(JOEY) })
}, 40000)

test('an edit of a message the session already has: a new inbound under one line naming the original time; edit_delivered (not replaced)', async () => {
  const m = dm(JOEY, 4400, '原本的字')
  api.push(m)
  expect(await until(() => received.some(r => r.content === '原本的字'), 15000)).toBe(true)
  await Bun.sleep(300)
  api.push(editOf(4400, m.message.date, '改過的字\n第二行'))
  expect(await until(() => received.some(r => r.meta.message_id === '4400' && r.meta.edited === 'true'), 15000)).toBe(true)
  const e = received.find(r => r.meta.message_id === '4400' && r.meta.edited === 'true')!
  // the person_edit carries the person's username (not Telegram's first name) and not the original's time (Onsen's payload has edited_at only)
  expect(e.content).toBe(`〔@joey 改了他 ??:??Z 那一則（tg:4400）〕\n改過的字\n第二行`)
  expect(e.meta).toMatchObject({ chat_id: String(JOEY), user: 'joey', user_id: String(JOEY) })
  expect(Date.parse(e.meta.ts)).toBeGreaterThanOrEqual(m.message.date * 1000)
  expect(await until(() => evs().some(x => x.kind === 'edit_delivered' && x.target_client_msg_id === '4400'), 10000)).toBe(true)
  expect(evs().find(x => x.kind === 'edit_delivered' && x.target_client_msg_id === '4400')!.data).toEqual({ replaced_in_queue: false })
  // the edit of a command the daemon answered itself (/clear) is never delivered
  api.push(dm(JOEY, 4100, '/clear', { command: true }))
  expect(await until(() => d.log().includes('onsen inbound: tg:4100 is a command; the connector handled it itself'), 15000)).toBe(true)
  const n = received.length
  api.push(editOf(4100, Math.floor(Date.now() / 1000) - 60, '/clear 改'))
  expect(await until(() => d.log().includes('onsen inbound: person_edit of tg:4100 handed on'), 10000)).toBe(true)
  await Bun.sleep(500)
  expect(received.length).toBe(n)
  expect(evs().some(x => x.kind === 'edit_delivered' && x.target_client_msg_id === '4100')).toBe(false)
  expect(d.log()).not.toContain(CRED)
}, 40000)
