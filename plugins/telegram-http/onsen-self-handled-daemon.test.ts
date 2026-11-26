// WO-197 (Chiron, WO-197 15:45Z: Joey's /clear to nestor, prometheus, hephaestus, Onsen 43345 / 43357 / 43369, stayed at accepted_at, delivered_at null,
// handling not_started): a person's Telegram message the daemon handles itself is never handed to a session; its receipt now goes to the end through
// deliveries/batch, keyed as every message's (the Telegram chat and message id): delivered when the daemon took it, turn_end (outcome done; by
// `daemon`, not a session) when its handler finished. A real daemon (server.ts, lanes off, control mode on a tmux pane on its own socket dir), the Bot
// API stand-in and the Onsen stand-in (test-fixtures/onsen-standin.ts); recording on.
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { startBotApiMock, dm, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startOnsenStandin, type OnsenStandin } from './test-fixtures/onsen-standin.ts'
import { startTgDaemon, until, sleep, freePort, type TgDaemon } from './test-fixtures/tg-daemon.ts'
import { HANDLED_HERE } from './onsen-status.ts'

const JOEY = 1828
const CRED = 'mesh_SELFHANDLEDsecretSECRETsecretSECRET1'
const TMUX = `selfh-d-${process.pid}`
let api: BotApiMock, onsen: OnsenStandin, d: TgDaemon, root = '', sock = ''
const tmuxEnv = (): Record<string, string> => { const e = { ...process.env, TMUX_TMPDIR: sock } as Record<string, string>; delete e.TMUX; return e }
const tm = (...a: string[]) => spawnSync('tmux', a, { env: tmuxEnv(), encoding: 'utf8' })

beforeAll(async () => {
  api = startBotApiMock({}, { pollHoldMs: 300 })
  root = mkdtempSync(join(tmpdir(), 'self-handled-daemon-'))
  sock = mkdtempSync(join(tmpdir(), 'self-handled-tmux-'))
  const made = tm('new-session', '-d', '-s', TMUX, '-x', '100', '-y', '20', 'cat')
  if (made.status !== 0) throw new Error(`tmux: ${made.stderr}`)
  onsen = startOnsenStandin({ [CRED]: 'adam' }, await freePort())
  writeFileSync(join(root, 'cred'), CRED + '\n')
  d = await startTgDaemon(api, root, JOEY, { GENESIS_LANES: '0', CHANNEL_BOT_TMUX_SESSION: TMUX, TMUX_TMPDIR: sock,
    ONSEN_BASE: `http://127.0.0.1:${onsen.port}/api/onsen`, ONSEN_CREDENTIAL_FILE: join(root, 'cred'), ONSEN_PEER_LOOKUP: '0' })
}, 40000)
afterAll(async () => { await d?.stop(); api?.stop(); onsen?.stop(); tm('kill-server') })

/** every delivery fact the stand-in received for Telegram message n (in the order it got them) */
const factsOf = (n: number) => onsen.seen.filter(s => s.path === '/deliveries/batch').flatMap(s => s.body?.items ?? [])
  .filter((f: any) => f.chat === String(JOEY) && f.client_msg_id === String(n))
const recordIdx = (n: number) => onsen.seen.findIndex(s => s.path === '/messages/batch' && (s.body?.items ?? []).some((i: any) => i.direction === 'in' && i.client_msg_id === String(n)))
const factIdx = (n: number, state: string) => onsen.seen.findIndex(s => s.path === '/deliveries/batch' && (s.body?.items ?? []).some((f: any) => f.client_msg_id === String(n) && f.state === state))

function expectHandledHere(n: number, how: string): void {
  const fs = factsOf(n)
  expect(fs.map((f: any) => `${f.state}${f.by ? `:${f.by}` : ''}`)).toEqual(['delivered', `turn_end:${HANDLED_HERE}`])
  const [del, end] = fs
  expect(end).toMatchObject({ agent: 'adam', client: 'telegram', outcome: 'done', detail: { handled_here: how } })
  expect(end.turn_id).toBeUndefined()
  expect(end.bound).toBeUndefined()
  expect(Date.parse(del.at)).toBeLessThanOrEqual(Date.parse(end.at))
  // the message's own record first, then its facts (Onsen finds what a fact is about)
  expect(recordIdx(n)).toBeGreaterThanOrEqual(0)
  expect(recordIdx(n)).toBeLessThanOrEqual(factIdx(n, 'delivered'))
}

test('/clear (the control plane): the stand-in gets delivered and turn_end (done, by daemon) for that Telegram message id; nothing reaches a session', async () => {
  api.push(dm(JOEY, 7100, '/clear', { command: true }))
  expect(await until(() => api.of('sendMessage').some(c => String(c.body.text).includes('已送 `/clear`')), 15000)).toBe(true)
  expect(await until(() => factsOf(7100).some((f: any) => f.state === 'turn_end'), 10000)).toBe(true)
  await sleep(300)
  expectHandledHere(7100, 'command')
}, 30000)

test('/status (bot.command, answered by the daemon): delivered and turn_end done', async () => {
  api.push(dm(JOEY, 7101, '/status', { command: true }))
  expect(await until(() => api.of('sendMessage').some(c => String(c.body.text).startsWith('Paired as')), 15000)).toBe(true)
  expect(await until(() => factsOf(7101).some((f: any) => f.state === 'turn_end'), 10000)).toBe(true)
  await sleep(300)
  expectHandledHere(7101, 'command')
}, 30000)

test('a permission reply (yes <id>): the session gets the answer; the message itself: delivered and turn_end done', async () => {
  const c = await d.client()
  const answers: any[] = []
  c.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel/permission') answers.push(n.params) }
  await c.notification({ method: 'notifications/claude/channel/permission_request', params: { request_id: 'abcde', tool_name: 'Bash', description: 'run ls', input_preview: '{"command":"ls"}' } })
  await sleep(500)
  api.push(dm(JOEY, 7102, 'yes abcde'))
  expect(await until(() => answers.some(a => a.request_id === 'abcde' && a.behavior === 'allow'), 10000)).toBe(true)
  expect(await until(() => factsOf(7102).some((f: any) => f.state === 'turn_end'), 10000)).toBe(true)
  await sleep(300)
  expectHandledHere(7102, 'permission')
}, 30000)

test('not the daemon\'s own (a plain text; a slash text the control plane does not know): delivered, and no turn_end from the daemon', async () => {
  api.push(dm(JOEY, 7103, '一般的一句'))
  api.push(dm(JOEY, 7104, '/nosuchthing 參數', { command: true }))
  expect(await until(() => factsOf(7103).some((f: any) => f.state === 'delivered') && factsOf(7104).some((f: any) => f.state === 'delivered'), 10000)).toBe(true)
  await sleep(1500)
  for (const n of [7103, 7104]) {
    expect(factsOf(n).filter((f: any) => f.state === 'delivered').length).toBe(1)
    expect(factsOf(n).some((f: any) => f.by === HANDLED_HERE)).toBe(false)
  }
}, 30000)
