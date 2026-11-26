// WO-197 (Chiron 19:21Z: switched off then on, /healthz connector.bot_api_refused {"deleteWebhook": 1}, no log line): the long poll, waiting to try
// again (Telegram's 409 while the bridge still polls the bot), must not start again (getMe / deleteWebhook / getUpdates) once the agent is named: the
// machine config is read fresh before each start, and what the winding-down poll itself would send is not sent and not counted as a refusal. A real
// daemon (server.ts, lanes off) against the Bot API stand-in answering every getUpdates with 409.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, sleep, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
let root = '', machine = '', api: BotApiMock, d: TgDaemon
const health = () => fetch(`http://127.0.0.1:${d.port}/healthz`).then(r => r.json()) as Promise<any>
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'connector-poll-start-'))
  machine = join(root, 'machine.env')
  writeFileSync(machine, 'ONSEN_BRIDGE=someone\n')
  api = startBotApiMock({}, { pollHoldMs: 200 })
  d = await startTgDaemon(api, join(root, 'd'), JOEY, { GENESIS_LANES: '0', CRAB_LABS_PLUGINS_ENV: machine, ONSEN_BRIDGE_TICK_MS: '200' })
}, 30000)
afterAll(async () => { await d?.stop(); api?.stop() })

test('named while the poll waits out a 409: the next try does not start it (no getMe, deleteWebhook or getUpdates sent); bot_api_refused stays {}', async () => {
  api.fail.code = 409; api.fail.desc = 'Conflict: terminated by other getUpdates request'
  api.fail.fn = m => m === 'getUpdates'
  expect(await until(() => d.log().includes('409 Conflict'), 15000)).toBe(true)   // the poll waits 10 s before its next try
  await sleep(300)
  const t0 = Date.now()
  writeFileSync(machine, 'ONSEN_BRIDGE=adam\n')                               // within the 30 s the daemon keeps its copy of the machine config
  await sleep(14000)                                                          // past the poll's next try
  expect(api.calls.filter(c => c.at > t0 && ['getMe', 'deleteWebhook'].includes(c.method))).toEqual([])
  expect(api.polls.filter(p => p.start > t0)).toEqual([])
  expect((await health()).connector.bot_api_refused).toEqual({})
  expect(await until(async () => (await health()).connector.on === true, 30000)).toBe(true)
}, 60000)
