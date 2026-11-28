// A connector and a roamer with live tmux panes and loopback Onsen Actions.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startOnsenStandin, type OnsenStandin } from './test-fixtures/onsen-standin.ts'
import { actionRow, startTgDaemon, freePort, until, sleep, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const CRED = { c: 'mesh_SCREENMENUconnectorSECRETsecretSEC01', p: 'mesh_SCREENMENUpollingSECRETsecretSECR01' }
const FAKE_TUI = `import { readFileSync, existsSync, appendFileSync, unlinkSync } from 'fs'
const [menuFile, outFile] = process.argv.slice(2)
let menu: any = null, cur = 0
const draw = () => {
  process.stdout.write('\\x1b[2J\\x1b[H')
  if (!menu) { process.stdout.write(' idle\\n'); return }
  process.stdout.write(' ' + menu.title + '\\n\\n')
  menu.options.forEach((o: string, i: number) => process.stdout.write((i === cur ? ' ❯ ' : '   ') + (i + 1) + '. ' + o + '\\n'))
  process.stdout.write('\\n Enter to confirm · Esc to cancel\\n')
}
const close = (rec: any) => { appendFileSync(outFile, JSON.stringify({ id: menu.id, ...rec }) + '\\n'); try { unlinkSync(menuFile) } catch {} menu = null; draw() }
setInterval(() => {
  const has = existsSync(menuFile)
  if (has) { const m = JSON.parse(readFileSync(menuFile, 'utf8')); if (!menu || m.id !== menu.id) { menu = m; cur = 0; draw() } }
  else if (menu) { menu = null; draw() }
}, 100)
process.stdin.setRawMode(true); process.stdin.resume()
process.stdin.on('data', (b: Buffer) => {
  const s = b.toString('latin1')
  if (!menu) return
  if (s.includes('\\x1b[B') || s.includes('\\x1bOB')) { cur = Math.min(cur + 1, menu.options.length - 1); draw(); return }
  if (s.includes('\\r') || s.includes('\\n')) { close({ idx: cur, label: menu.options[cur] }); return }
  if (s === '\\x1b') close({ esc: true })
})
draw()
`
type Pane = { name: string; menu: string; out: string }
let root = '', sock = '', apiC: BotApiMock, apiP: BotApiMock, onsen: OnsenStandin, conn: TgDaemon, roamer: TgDaemon
const panes: Record<'c' | 'p', Pane> = {} as any
const tmuxEnv = (): Record<string, string> => { const e = { ...process.env, TMUX_TMPDIR: sock } as Record<string, string>; delete e.TMUX; return e }
const tm = (...a: string[]) => spawnSync('tmux', a, { env: tmuxEnv(), encoding: 'utf8' })
const health = (d: TgDaemon) => fetch(`http://127.0.0.1:${d.port}/healthz`).then(r => r.json()) as Promise<any>
const draw = (p: Pane, id: string, title: string, options: string[]) => writeFileSync(p.menu, JSON.stringify({ id, title, options }))
const chosen = (p: Pane): any[] => existsSync(p.out) ? readFileSync(p.out, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const screen = (p: Pane) => tm('capture-pane', '-t', p.name, '-p').stdout
/** the Action calls the stand-in got from `who` (about one Action, one op) */
const calls = (who: string, id?: string, op?: string) => onsen.acalls.filter(c => c.who === who && c.method === 'POST'
  && (id == null ? c.path === '/v1/actions' : c.path === `/v1/actions/${id}${op ? `/${op}` : ''}`))
const made = (who: string, pred: (a: any) => boolean) => [...onsen.actions.values()].filter(a => a.requested_by === who && pred(a))
const control = async (d: TgDaemon, c: ReturnType<OnsenStandin['press']>) => {
  const row = actionRow(d, c)
  return until(() => row.state === 'completed', 10000)
}
const perms: Record<'c' | 'p', any[]> = { c: [], p: [] }
const ask = async (d: TgDaemon, request_id: string, tool = 'Bash', description = 'run ls') =>
  (await d.client()).notification({ method: 'notifications/claude/channel/permission_request', params: { request_id, tool_name: tool, description, input_preview: JSON.stringify({ command: description }) } })
const PERM = ['Yes', "Yes, and don't ask again for ls commands in /tmp/x", 'No']

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'onsen-screen-menu-daemon-'))
  sock = mkdtempSync(join(tmpdir(), 'op-'))
  writeFileSync(join(root, 'fake-tui.ts'), FAKE_TUI)
  for (const k of ['c', 'p'] as const) {
    panes[k] = { name: `scrmenu-${k}-${process.pid}`, menu: join(root, `menu-${k}.json`), out: join(root, `chosen-${k}.jsonl`) }
    const r = tm('new-session', '-d', '-s', panes[k].name, '-x', '120', '-y', '24', process.execPath, join(root, 'fake-tui.ts'), panes[k].menu, panes[k].out)
    if (r.status !== 0) throw new Error(`tmux: ${r.stderr}`)
  }
  onsen = startOnsenStandin({ [CRED.c]: 'c', [CRED.p]: 'p' }, await freePort())
  onsen.st.version.c = '0.35.3'; onsen.st.version.p = '0.35.3'
  apiC = startBotApiMock({}, { pollHoldMs: 200 }); apiP = startBotApiMock({}, { pollHoldMs: 200 })
  const env = { GENESIS_LANES: '0', ONSEN_BASE: `http://127.0.0.1:${onsen.port}/api/onsen`, ONSEN_PEER_LOOKUP: '0', ONSEN_CLAUDE_BIN: '/nonexistent/claude',
    TMUX_TMPDIR: sock, STARTUP_PICKER_POLL_MS: '400' }
  ;[conn, roamer] = await Promise.all([
    startTgDaemon(apiC, join(root, 'c'), JOEY, { ...env, TELEGRAM_BOT_TOKEN: '', ONSEN_BRIDGE: 'adam', ONSEN_OWNER: 'joey', FIXTURE_MEMBER_TOKEN: CRED.c, GENESIS_LANES: '1', CHANNEL_BOT_TMUX_SESSION: panes.c.name },
      h => h?.ok === true),
    startTgDaemon(apiP, join(root, 'p'), JOEY, { ...env, ROAMER_MODE: '1', ROAMER_BOT_NAME: 'p_bot', ONSEN_OWNER: 'joey', FIXTURE_MEMBER_TOKEN: CRED.p, CHANNEL_BOT_TMUX_SESSION: panes.p.name }),
  ])
  for (const k of ['c', 'p'] as const) {
    const c = await (k === 'c' ? conn : roamer).client()
    c.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel/permission') perms[k].push(n.params) }
  }
}, 60000)
afterAll(async () => { await Promise.all([conn?.stop(), roamer?.stop()]); apiC?.stop(); apiP?.stop(); onsen?.stop(); tm('kill-server'); try { rmSync(sock, { recursive: true }) } catch {} })

test('1a connector: a menu on the pane (/model) is one Onsen Action with its options; no Bot API call; a press in Onsen presses the keys on the pane, then applied', async () => {
  draw(panes.c, 'm1', 'Select model', ['Default (recommended)', 'Opus', 'Haiku'])
  expect(await until(() => made('c', a => a.source === 'menu').length === 1, 10000)).toBe(true)
  const a = made('c', x => x.source === 'menu')[0]!
  expect(a.options).toEqual([{ id: '1', label: 'Default (recommended)' }, { id: '2', label: 'Opus' }, { id: '3', label: 'Haiku' }])
  expect(a).toMatchObject({ session_id: 'main', assignees: ['joey'], state: 'open' })
  expect(a.summary).toContain(panes.c.name)
  await sleep(1500)
  expect(made('c', x => x.source === 'menu')).toHaveLength(1)                  // one per menu, not one per look
  expect(apiC.calls).toEqual([]); expect(apiC.polls).toEqual([])
  expect((await health(conn)).connector.bot_api_refused).toEqual({})
  expect(conn.log()).not.toContain('sendTextWithMaybeKeyboard failed')
  expect(await control(conn, onsen.press(a.id, '2'))).toBe(true)
  expect(await until(() => chosen(panes.c).some(x => x.id === 'm1'), 10000)).toBe(true)
  expect(chosen(panes.c).find(x => x.id === 'm1')).toEqual({ id: 'm1', idx: 1, label: 'Opus' })   // Down once, Enter: as a Telegram tap on 「2. Opus」
  expect(calls('c', a.id, 'applied')).toHaveLength(0)
  await sleep(1500)                                                                // the menu left the screen: an applied Action is not cancelled
  expect(calls('c', a.id, 'cancel')).toHaveLength(0)
  expect(onsen.actions.get(a.id)).toMatchObject({ state: 'resolved', selected_option_id: '2' })
  expect(apiC.calls).toEqual([])
  expect((await health(conn)).connector.bot_api_refused).toEqual({})
}, 40000)

test('1b connector: a permission dialog is the permission prompt\'s own Action (drawn before the request came, within the grace): exactly one Action, no menu Action, no Telegram', async () => {
  const before = onsen.actions.size
  draw(panes.c, 'p1', 'Bash command', PERM)
  await sleep(500)
  await ask(conn, 'qwert', 'Bash', 'ls /tmp/x')
  expect(await until(() => made('c', a => a.source === 'permission' && a.summary === 'Bash：ls /tmp/x').length === 1, 8000)).toBe(true)
  await sleep(3500)                                                                // past the grace and several looks
  const mine = [...onsen.actions.values()].slice(before)
  expect(mine.map(a => a.source)).toEqual(['permission'])
  expect(conn.log()).toMatch(/is the permission prompt.*its own Action carries it/)
  expect(apiC.calls).toEqual([])
  expect((await health(conn)).connector.bot_api_refused).toEqual({})
}, 30000)

test('2a connector: that prompt answered on the screen (Enter, as the duty officer presses it): its Action is cancelled once, with the reason; nothing pressed from here', async () => {
  const a = made('c', x => x.summary === 'Bash：ls /tmp/x')[0]!
  tm('send-keys', '-t', panes.c.name, 'Enter')
  expect(await until(() => chosen(panes.c).some(x => x.id === 'p1'), 5000)).toBe(true)
  expect(await until(() => calls('c', a.id, 'cancel').length === 1, 8000)).toBe(true)
  expect(calls('c', a.id, 'cancel')[0]!.body).toEqual({ expected_version: 1, reason: expect.stringContaining('畫面上已經沒有這個詢問'), note: expect.stringContaining('畫面上已經沒有這個詢問') })
  expect(onsen.actions.get(a.id).state).toBe('cancelled')
  await sleep(2000)
  expect(calls('c', a.id, 'cancel')).toHaveLength(1)                              // once
  expect(calls('c', a.id, 'resolve')).toHaveLength(0)
  expect(perms.c).toHaveLength(0)                                                  // Claude Code was not answered through the channel
  expect(conn.log()).toContain('permission qwert (Bash): not on the main\'s screen any more')
  expect(apiC.calls).toEqual([])
}, 30000)

test('2b connector: a prompt pressed in Onsen first: Claude Code answered, applied; its dialog leaving the screen after does not cancel it', async () => {
  await ask(conn, 'asdfg', 'Bash', 'rm build.log')
  draw(panes.c, 'p2', 'Bash command', ['Yes', "Yes, and don't ask again for rm commands", 'No'])
  expect(await until(() => made('c', a => a.summary === 'Bash：rm build.log').length === 1, 8000)).toBe(true)
  const a = made('c', x => x.summary === 'Bash：rm build.log')[0]!
  await sleep(1000)
  expect(await control(conn, onsen.press(a.id, 'allow'))).toBe(true)
  expect(await until(() => perms.c.some(p => p.request_id === 'asdfg'), 8000)).toBe(true)
  expect(perms.c.find(p => p.request_id === 'asdfg')).toEqual({ request_id: 'asdfg', behavior: 'allow' })
  expect(calls('c', a.id, 'applied')).toHaveLength(0)
  rmSync(panes.c.menu)                                                             // Claude Code took the answer: the dialog goes
  expect(await until(() => !screen(panes.c).includes('rm commands'), 5000)).toBe(true)
  await sleep(2500)
  expect(calls('c', a.id, 'cancel')).toHaveLength(0)
  expect(onsen.actions.get(a.id)).toMatchObject({ state: 'resolved', selected_option_id: 'allow' })
  expect(made('c', x => x.source === 'menu' && x.created_at >= a.created_at)).toHaveLength(0)
}, 30000)

test('2c connector: a menu asked about in Onsen that left the screen (Esc on the TUI): its Action is cancelled once', async () => {
  draw(panes.c, 'm2', 'Select effort', ['Low', 'Medium', 'High'])
  expect(await until(() => made('c', a => a.source === 'menu' && a.options?.[2]?.label === 'High').length === 1, 10000)).toBe(true)
  const a = made('c', x => x.source === 'menu' && x.options?.[2]?.label === 'High')[0]!
  tm('send-keys', '-t', panes.c.name, 'Escape')
  expect(await until(() => chosen(panes.c).some(x => x.id === 'm2' && x.esc), 5000)).toBe(true)
  expect(await until(() => calls('c', a.id, 'cancel').length === 1, 8000)).toBe(true)
  expect(calls('c', a.id, 'cancel')[0]!.body.reason).toContain('選單已經不在畫面上了')
  await sleep(1500)
  expect(calls('c', a.id, 'cancel')).toHaveLength(1)
  expect(apiC.calls).toEqual([])
  expect((await health(conn)).connector.bot_api_refused).toEqual({})
}, 30000)

test('2d roamer: a prompt answered on the screen closes its own Action', async () => {
  await ask(roamer, 'zxcvb', 'Bash', 'make test')
  expect(await until(() => made('p', a => a.summary === 'Bash：make test').length === 1)).toBe(true)
  const a = made('p', x => x.summary === 'Bash：make test')[0]!
  draw(panes.p, 'p3', 'Bash command', ['Yes', "Yes, and don't ask again for make commands", 'No'])
  await sleep(3000)
  tm('send-keys', '-t', panes.p.name, 'Enter')
  expect(await until(() => calls('p', a.id, 'cancel').length === 1)).toBe(true)
  expect(made('p', x => x.source === 'menu')).toHaveLength(0)
  expect(apiP.calls).toEqual([])
}, 30000)

test('2e roamer: an Onsen menu choice reaches the pane', async () => {
  draw(panes.p, 'm3', 'Resume', ['Resume from summary', 'Resume full session', "Don't ask me again"])
  expect(await until(() => made('p', a => a.source === 'menu').length === 1, 10000)).toBe(true)
  const a = made('p', x => x.source === 'menu')[0]!
  expect(await control(roamer, onsen.press(a.id, '3'))).toBe(true)
  expect(chosen(panes.p).find(x => x.id === 'm3')).toMatchObject({ idx: 2 })
  expect(calls('p', a.id, 'cancel')).toHaveLength(0)
  expect(apiP.calls).toEqual([])
}, 30000)
