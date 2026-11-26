// WO-197 (Chiron 16:1xZ, mesh-12795; lab 15:4xZ): a polling daemon named in ONSEN_BRIDGE mid-run hands its bot over to the bridge and must end with no
// connection to Telegram at all. Before the fix two idle keep-alive connections to Telegram stayed open in the Bun process after grammy's bot.stop
// (its last getUpdates saves the offset). A real daemon (server.ts) against the Bot API stand-in, which here never closes an idle connection
// (idleTimeout 0, as Telegram keeps them); the daemon's own TCP connections to it are counted with lsof. Normal polling keeps reusing its connection.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { startBotApiMock, dm, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startOnsenStandin, type OnsenStandin } from './test-fixtures/onsen-standin.ts'
import { startTgDaemon, freePort, until, sleep, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const CRED = 'mesh_HANDOVERsocketsSECRETsecretSECRET01'
const HAS_LSOF = spawnSync('lsof', ['-v'], { encoding: 'utf8' }).error == null
let api: BotApiMock, onsen: OnsenStandin, d: TgDaemon, root = '', machine = ''
const health = () => fetch(`http://127.0.0.1:${d.port}/healthz`).then(r => r.json()) as Promise<any>
const apiPort = () => Number(new URL(api.url).port)
/** the daemon's process: the one listening on its HTTP port */
const daemonPid = (): string => spawnSync('lsof', ['-nP', '-t', `-iTCP:${d.port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.trim().split('\n')[0]!
/** the daemon's established TCP connections to the Bot API stand-in */
const sockets = (): number => spawnSync('lsof', ['-nP', '-a', '-p', daemonPid(), `-iTCP:${apiPort()}`, '-sTCP:ESTABLISHED'], { encoding: 'utf8' }).stdout
  .split('\n').filter(l => l.includes(`->127.0.0.1:${apiPort()}`)).length

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'handover-sockets-'))
  api = startBotApiMock({}, { pollHoldMs: 400, idleTimeout: 0 })
  onsen = startOnsenStandin({ [CRED]: 'adam' }, await freePort())
  onsen.st.version.adam = '0.35.3'
  writeFileSync(join(root, 'cred'), CRED + '\n')
  machine = join(root, 'machine.env')
  writeFileSync(machine, 'ONSEN_BRIDGE=someone\n')
  d = await startTgDaemon(api, root, JOEY, { GENESIS_LANES: '0', CRAB_LABS_PLUGINS_ENV: machine, ONSEN_BRIDGE_TICK_MS: '200', ONSEN_PEER_LOOKUP: '0',
    ONSEN_BASE: `http://127.0.0.1:${onsen.port}/api/onsen`, ONSEN_CREDENTIAL_FILE: join(root, 'cred') })
}, 40000)
afterAll(async () => { await d?.stop(); api?.stop(); onsen?.stop() })

test.skipIf(!HAS_LSOF)('polling keeps one connection for its getUpdates; several calls at once open more; named mid-run: after the hand-over, no connection to Telegram is left', async () => {
  // normal polling: the long poll goes on over the connection it has (not a new one per getUpdates)
  const from = api.polls.length
  await sleep(3000)
  const polled = api.polls.slice(from).filter(p => p.port != null)
  expect(polled.length).toBeGreaterThanOrEqual(5)
  expect(new Set(polled.map(p => p.port)).size).toBeLessThanOrEqual(2)
  // calls at once while the poll is held: each its own connection, kept alive afterwards
  const c = await d.client()
  await Promise.all([1, 2, 3].map(i => d.call('reply', { chat_id: String(JOEY), text: `同時 ${i}` })))
  api.push(dm(JOEY, 9001, '一句'))
  expect(await until(() => api.of('sendChatAction').length > 0, 8000)).toBe(true)
  await sleep(300)
  const before = sockets()
  expect(before).toBeGreaterThanOrEqual(2)
  // named: the poll stops (its last getUpdates saves the offset), then nothing is left open to Telegram
  writeFileSync(machine, 'ONSEN_BRIDGE=adam\n')
  expect(await until(async () => (await health()).polling === false && (await health()).connector?.on === true, 35000)).toBe(true)
  expect(await until(() => sockets() === 0, 5000)).toBe(true)
  await sleep(1500)
  expect(sockets()).toBe(0)
  expect((await health()).connector.bot_api_refused).toEqual({})
  void c
  console.log(`WO-197 hand-over: ${before} connection(s) to the Bot API stand-in before, ${sockets()} after; ${new Set(polled.map(p => p.port)).size} connection(s) for ${polled.length} getUpdates`)
}, 90000)
