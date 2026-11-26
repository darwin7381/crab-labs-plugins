// WO-197 (Chiron lab round 3A on 1.58.27, the switch off): a prompt answered on the screen took 8–14 s to be cancelled in Onsen (its Telegram buttons
// still there meanwhile): the menu relay's 8 s poll, and two looks without the menu are needed. A pane with an open Onsen Action of this daemon (a
// prompt, a menu) is looked at every 2 s as well, so the cancel comes within ~4 s; the two-looks rule stays. A real daemon (server.ts, lanes off,
// control mode, the poll at its default 8 s) against the Bot API stand-in and the Onsen stand-in; the pane runs a fake TUI.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startOnsenStandin, type OnsenStandin } from './test-fixtures/onsen-standin.ts'
import { startTgDaemon, freePort, until, sleep, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const CRED = 'mesh_SCREENFASTpollingSECRETsecretSECRET01'
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
let root = '', sock = '', api: BotApiMock, onsen: OnsenStandin, d: TgDaemon, pane = '', menu = '', out = ''
const tmuxEnv = (): Record<string, string> => { const e = { ...process.env, TMUX_TMPDIR: sock } as Record<string, string>; delete e.TMUX; return e }
const tm = (...a: string[]) => spawnSync('tmux', a, { env: tmuxEnv(), encoding: 'utf8' })
const chosen = (): any[] => existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const cancelOf = (id: string) => onsen.acalls.find(c => c.method === 'POST' && c.path === `/v1/actions/${id}/cancel`)
const made = (pred: (a: any) => boolean) => [...onsen.actions.values()].filter(a => a.requested_by === 'p' && pred(a))

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'onsen-screen-fast-'))
  sock = mkdtempSync(join(tmpdir(), 'osf-'))
  writeFileSync(join(root, 'fake-tui.ts'), FAKE_TUI)
  pane = `scrfast-${process.pid}`; menu = join(root, 'menu.json'); out = join(root, 'chosen.jsonl')
  const r = tm('new-session', '-d', '-s', pane, '-x', '120', '-y', '24', process.execPath, join(root, 'fake-tui.ts'), menu, out)
  if (r.status !== 0) throw new Error(`tmux: ${r.stderr}`)
  onsen = startOnsenStandin({ [CRED]: 'p' }, await freePort())
  onsen.st.version.p = '0.35.3'
  writeFileSync(join(root, 'cred'), CRED + '\n')
  api = startBotApiMock({}, { pollHoldMs: 200 })
  d = await startTgDaemon(api, join(root, 'p'), JOEY, { GENESIS_LANES: '0', ONSEN_BASE: `http://127.0.0.1:${onsen.port}/api/onsen`, ONSEN_PEER_LOOKUP: '0',
    ONSEN_CLAUDE_BIN: '/nonexistent/claude', TMUX_TMPDIR: sock, ONSEN_CREDENTIAL_FILE: join(root, 'cred'), CHANNEL_BOT_TMUX_SESSION: pane })
}, 60000)
afterAll(async () => { await d?.stop(); api?.stop(); onsen?.stop(); tm('kill-server'); try { rmSync(sock, { recursive: true }) } catch {} })

test('a prompt answered on the screen (the poll at its default 8 s): its Action is cancelled within ~5 s of the answer, its Telegram copy closed', async () => {
  expect(d.log()).toContain('startup-picker interceptor ON (poll=8s; 2s for a pane with an open Onsen Action)')
  writeFileSync(menu, JSON.stringify({ id: 'p1', title: 'Bash command', options: ['Yes', "Yes, and don't ask again for ls commands in /tmp/x", 'No'] }))
  await (await d.client()).notification({ method: 'notifications/claude/channel/permission_request', params: { request_id: 'fastp', tool_name: 'Bash',
    description: 'ls /tmp/x', input_preview: JSON.stringify({ command: 'ls /tmp/x' }) } })
  expect(await until(() => made(a => a.summary === 'Bash：ls /tmp/x').length === 1, 8000)).toBe(true)
  const a = made(x => x.summary === 'Bash：ls /tmp/x')[0]!
  await sleep(3000)                                                                // past the prompt's 2 s grace; the pane seen with the dialog
  expect(cancelOf(a.id)).toBeUndefined()
  const t0 = Date.now()
  tm('send-keys', '-t', pane, 'Enter')
  expect(await until(() => chosen().some(x => x.id === 'p1'), 5000)).toBe(true)
  expect(await until(() => !!cancelOf(a.id), 12000)).toBe(true)
  const dt = cancelOf(a.id)!.at - t0
  expect(dt).toBeLessThanOrEqual(5500)
  expect(onsen.actions.get(a.id).state).toBe('cancelled')
  expect(await until(() => api.of('editMessageText').some(e => String(e.body.text).includes('— 不用按了：畫面上已經沒有這個詢問')), 3000)).toBe(true)
}, 40000)

test('a menu asked about in Onsen and answered on the screen (Esc): cancelled within ~5 s of the answer', async () => {
  writeFileSync(menu, JSON.stringify({ id: 'm1', title: 'Select effort', options: ['Low', 'Medium', 'High'] }))
  expect(await until(() => made(a => a.source === 'menu').length === 1, 12000)).toBe(true)   // the 8 s poll finds it first
  const a = made(x => x.source === 'menu')[0]!
  await sleep(1000)
  const t0 = Date.now()
  tm('send-keys', '-t', pane, 'Escape')
  expect(await until(() => chosen().some(x => x.id === 'm1' && x.esc), 5000)).toBe(true)
  expect(await until(() => !!cancelOf(a.id), 12000)).toBe(true)
  expect(cancelOf(a.id)!.at - t0).toBeLessThanOrEqual(5500)
}, 40000)
