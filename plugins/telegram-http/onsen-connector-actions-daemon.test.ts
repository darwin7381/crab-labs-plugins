// WO-197 (Chiron mesh 12852, 「不靠第二張名單對齊」): an agent named in ONSEN_BRIDGE has its Actions on, whatever ONSEN_ACTIONS says (a connector asks
// people only through Actions: it has no Telegram). Real daemons (server.ts, lanes off, control mode on a tmux pane on its own socket dir) against the
// Bot API stand-in and the Onsen stand-in; ONSEN_ACTIONS=0 on both (unset is on already, so 0 is what makes the test mean something):
//   named   ONSEN_BRIDGE in the plist (a connector from the start, no token): a permission prompt is one Action, a menu on its pane is one Action
//   switch  the machine config: not named at first (polling: ONSEN_ACTIONS=0 holds, no Action, Telegram as before); named at runtime (the 5 s check):
//           from then a permission prompt is one Action and a menu one Action; no Bot API call after the hand-over
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startOnsenStandin, type OnsenStandin } from './test-fixtures/onsen-standin.ts'
import { startTgDaemon, freePort, until, sleep, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const CRED = { n: 'mesh_CONNACTIONSnamedSECRETsecretSECRET01', s: 'mesh_CONNACTIONSswitchSECRETsecretSECRE01' }
// a TUI that draws a menu from a file (the menu relay reads the pane)
const FAKE_TUI = `import { readFileSync, existsSync } from 'fs'
const [menuFile] = process.argv.slice(2)
let id = ''
setInterval(() => {
  const m = existsSync(menuFile) ? JSON.parse(readFileSync(menuFile, 'utf8')) : null
  if ((m?.id ?? '') === id) return
  id = m?.id ?? ''
  process.stdout.write('\\x1b[2J\\x1b[H')
  if (!m) { process.stdout.write(' idle\\n'); return }
  process.stdout.write(' ' + m.title + '\\n\\n')
  m.options.forEach((o: string, i: number) => process.stdout.write((i === 0 ? ' ❯ ' : '   ') + (i + 1) + '. ' + o + '\\n'))
  process.stdout.write('\\n Enter to confirm · Esc to cancel\\n')
}, 100)
process.stdin.resume()
`
let root = '', sock = '', machine = '', apiN: BotApiMock, apiS: BotApiMock, onsen: OnsenStandin, named: TgDaemon, sw: TgDaemon
const panes = { n: '', s: '' }
const menus = { n: '', s: '' }
const tmuxEnv = (): Record<string, string> => { const e = { ...process.env, TMUX_TMPDIR: sock } as Record<string, string>; delete e.TMUX; return e }
const tm = (...a: string[]) => spawnSync('tmux', a, { env: tmuxEnv(), encoding: 'utf8' })
const health = (d: TgDaemon) => fetch(`http://127.0.0.1:${d.port}/healthz`).then(r => r.json()) as Promise<any>
const made = (who: string, pred: (a: any) => boolean) => [...onsen.actions.values()].filter(a => a.requested_by === who && pred(a))
const ask = async (d: TgDaemon, request_id: string, description: string) =>
  (await d.client()).notification({ method: 'notifications/claude/channel/permission_request', params: { request_id, tool_name: 'Bash', description, input_preview: JSON.stringify({ command: description }) } })

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'onsen-connector-actions-'))
  sock = mkdtempSync(join(tmpdir(), 'oca-'))
  writeFileSync(join(root, 'fake-tui.ts'), FAKE_TUI)
  for (const k of ['n', 's'] as const) {
    panes[k] = `connact-${k}-${process.pid}`
    menus[k] = join(root, `menu-${k}.json`)
    const r = tm('new-session', '-d', '-s', panes[k], '-x', '120', '-y', '24', process.execPath, join(root, 'fake-tui.ts'), menus[k])
    if (r.status !== 0) throw new Error(`tmux: ${r.stderr}`)
  }
  onsen = startOnsenStandin({ [CRED.n]: 'n', [CRED.s]: 's' }, await freePort())
  onsen.st.version.n = '0.35.3'; onsen.st.version.s = '0.35.3'
  writeFileSync(join(root, 'cred-n'), CRED.n + '\n'); writeFileSync(join(root, 'cred-s'), CRED.s + '\n')
  machine = join(root, 'machine.env')
  writeFileSync(machine, 'ONSEN_BRIDGE=someone\n')
  apiN = startBotApiMock({}, { pollHoldMs: 200 }); apiS = startBotApiMock({}, { pollHoldMs: 200 })
  const env = { GENESIS_LANES: '0', ONSEN_BASE: `http://127.0.0.1:${onsen.port}/api/onsen`, ONSEN_PEER_LOOKUP: '0', ONSEN_CLAUDE_BIN: '/nonexistent/claude',
    TMUX_TMPDIR: sock, STARTUP_PICKER_POLL_MS: '400', ONSEN_ACTIONS: '0' }
  ;[named, sw] = await Promise.all([
    startTgDaemon(apiN, join(root, 'n'), JOEY, { ...env, TELEGRAM_BOT_TOKEN: '', ONSEN_BRIDGE: 'adam', ONSEN_CREDENTIAL_FILE: join(root, 'cred-n'), CHANNEL_BOT_TMUX_SESSION: panes.n },
      h => h?.ok === true),
    startTgDaemon(apiS, join(root, 's'), JOEY, { ...env, CRAB_LABS_PLUGINS_ENV: machine, ONSEN_BRIDGE_TICK_MS: '200', ONSEN_CREDENTIAL_FILE: join(root, 'cred-s'),
      CHANNEL_BOT_TMUX_SESSION: panes.s }),
  ])
}, 60000)
afterAll(async () => { await Promise.all([named?.stop(), sw?.stop()]); apiN?.stop(); apiS?.stop(); onsen?.stop(); tm('kill-server'); try { rmSync(sock, { recursive: true }) } catch {} })

test('named at start, ONSEN_ACTIONS=0: a permission prompt is one Action and a menu on its pane one Action; no Bot API call', async () => {
  expect((await health(named)).onsen.actions.on).toBe(true)
  await ask(named, 'nperm', 'ls /n')
  expect(await until(() => made('n', a => a.source === 'permission' && a.summary === 'Bash：ls /n').length === 1, 8000)).toBe(true)
  writeFileSync(menus.n, JSON.stringify({ id: 'mn', title: 'Select model', options: ['Default (recommended)', 'Opus', 'Haiku'] }))
  expect(await until(() => made('n', a => a.source === 'menu').length === 1, 10000)).toBe(true)
  await sleep(1500)
  expect(made('n', a => a.source === 'menu')).toHaveLength(1)
  expect(made('n', a => a.source === 'permission')).toHaveLength(1)
  expect(named.log()).not.toContain('ONSEN_ACTIONS off')
  expect(apiN.calls).toEqual([]); expect(apiN.polls).toEqual([])
  expect((await health(named)).connector.bot_api_refused).toEqual({})
}, 30000)

test('named at runtime (the machine config), ONSEN_ACTIONS=0: none before (Telegram as before); from the hand-over a permission prompt is one Action and a menu one Action', async () => {
  expect((await health(sw)).polling).toBe(true)
  expect((await health(sw)).onsen.actions.on).toBe(false)
  await ask(sw, 'sperm1', 'ls /before')
  expect(await until(() => apiS.of('sendMessage').some(c => c.body.text === '🔐 Permission: Bash'), 8000)).toBe(true)
  await sleep(500)
  expect(made('s', () => true)).toHaveLength(0)                                   // off the connector ONSEN_ACTIONS=0 holds
  writeFileSync(machine, 'ONSEN_BRIDGE=adam\n')
  expect(await until(async () => { const h = await health(sw); return h.polling === false && h.connector.on === true }, 35000)).toBe(true)
  expect((await health(sw)).onsen.actions.on).toBe(true)
  await sleep(600)
  const calls = apiS.calls.length
  await ask(sw, 'sperm2', 'ls /after')
  expect(await until(() => made('s', a => a.source === 'permission' && a.summary === 'Bash：ls /after').length === 1, 8000)).toBe(true)
  writeFileSync(menus.s, JSON.stringify({ id: 'ms', title: 'Select effort', options: ['Low', 'Medium', 'High'] }))
  expect(await until(() => made('s', a => a.source === 'menu').length === 1, 10000)).toBe(true)
  await sleep(1500)
  expect(made('s', a => a.source === 'menu')).toHaveLength(1)
  expect(made('s', a => a.source === 'permission')).toHaveLength(1)
  expect(apiS.calls.length).toBe(calls)
  expect((await health(sw)).connector.bot_api_refused).toEqual({})
}, 70000)
