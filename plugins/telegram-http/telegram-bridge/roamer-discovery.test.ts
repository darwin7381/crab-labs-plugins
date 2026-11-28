import { test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { bridgeOwnsBot, carried, discover } from './agents.ts'

test('wildcard discovery follows each roamer daemon; an explicit state-dir map preserves its ownership check', async () => {
  const home = mkdtempSync(join(tmpdir(), 'roamer-units-')), dir = join(home, '.config/systemd/user')
  mkdirSync(dir, { recursive: true })
  let local = false
  const serve = (member: string, switched: () => boolean) => Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () =>
    Response.json({ agent: member, connector: { roamer: true, on: switched() }, polling: !switched() }) })
  const a = serve('space-roamers', () => true), b = serve('time-travelers', () => local)
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
    local = true
    expect(await bridgeOwnsBot(y, false)).toBe(true)
    await b.stop(true)
    expect(await bridgeOwnsBot(y, false)).toBe(false)
    expect(await bridgeOwnsBot(y, true)).toBe(true)
  } finally { await a.stop(true); await b.stop(true); rmSync(home, { recursive: true, force: true }) }
})
