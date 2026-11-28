import { test, expect, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { startBotApiMock } from '../test-fixtures/tg-bot-api-mock.ts'
import { until } from '../test-fixtures/tg-daemon.ts'
import { Bridge, configFromEnv } from './telegram-bridge.ts'
import * as agents from './agents.ts'
import { bridgeOwnsBot, carried, discover } from './agents.ts'

test('wildcard discovery follows each roamer daemon; an explicit state-dir map preserves its ownership check', async () => {
  const home = mkdtempSync(join(tmpdir(), 'roamer-units-')), dir = join(home, '.config/systemd/user')
  mkdirSync(dir, { recursive: true })
  let spaceSwitched = true, timeSwitched = false
  const serve = (member: string, switched: () => boolean) => Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () =>
    Response.json({ agent: member, connector: { roamer: true, on: switched() }, polling: !switched() }) })
  const a = serve('space-roamers', () => spaceSwitched), b = serve('time-travelers', () => timeSwitched)
  try {
    for (const [unit, bot, port] of [['roamer-x', 'space_roamers', a.port], ['ordinary', 'time_travelers', b.port]]) {
      writeFileSync(join(dir, unit + '.service'), `[Service]\nEnvironment=ROAMER_MODE=1 ROAMER_BOT_NAME=${bot} TELEGRAM_STATE_DIR=%h/${bot} TELEGRAM_HTTP_PORT=${port}\n`)
    }
    const found = discover(home, 'linux')
    const want = carried({ list: '*', dirs: new Map([['space-roamers', join(home, 'space_roamers')]]), errors: [] }, found)
    expect([...want.keys()]).toEqual(['space-roamers', 'time-travelers'])
    const x = want.get('space-roamers')!, y = want.get('time-travelers')!
    expect(await bridgeOwnsBot(x, false)).toBe(true)
    expect(await bridgeOwnsBot(y, true)).toBe(false)
    const overrides = carried({ list: '*', dirs: new Map([[y.member, join(home, 'other-dir')], ['other-name', y.stateDir]]), errors: [] }, found)
    expect(await bridgeOwnsBot(overrides.get(y.member)!, false)).toBe(false)
    expect(overrides.has('other-name')).toBe(false)
    const bot = startBotApiMock({}, { pollHoldMs: 100 })
    const token = spyOn(agents, 'readToken').mockReturnValue({ token: bot.token, mtime: 1 })
    const bridge = new Bridge(configFromEnv({ HOME: home, TELEGRAM_BRIDGE_MACHINE: 'lab', TELEGRAM_BRIDGE_PLATFORM: 'linux',
      ONSEN_BRIDGE: '*', CRAB_LABS_PLUGINS_ENV: join(home, 'no-config'), ONSEN_BASE: 'http://127.0.0.1:1', TELEGRAM_API_ROOT: bot.url }), { log: () => {} })
    const identity = spyOn(bridge.onsen, 'token').mockReturnValue('test-bridge')
    try {
      bridge.state.data.accepted = ['space-roamers']
      await bridge.reconcile()
      expect([...bridge.agents.keys()]).toEqual(['space-roamers'])
      expect([...bridge.pollers.keys()]).toEqual(['space-roamers'])
      expect(await until(() => bot.polls.length > 0)).toBe(true)
      expect(token.mock.calls.every(([dir]) => dir === x.stateDir)).toBe(true)
      spaceSwitched = false
      await bridge.reconcile()
      expect(bridge.pollers.size).toBe(0)
      expect(bridge.state.data.accepted).toEqual([])
    } finally { await bridge.stop(); identity.mockRestore(); token.mockRestore(); bot.stop() }
    timeSwitched = true
    expect(await bridgeOwnsBot(y, false)).toBe(true)
    await b.stop(true)
    expect(await bridgeOwnsBot(y, false)).toBe(false)
    expect(await bridgeOwnsBot(y, true)).toBe(true)
  } finally { await a.stop(true); await b.stop(true); rmSync(home, { recursive: true, force: true }) }
})
