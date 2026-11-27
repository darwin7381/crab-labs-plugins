// telegram-bridge.test.ts (board WO-196 part B, stage one). Everything runs against fakes.ts: a fake Telegram Bot API and a fake Onsen that checks
// every request against CONTRACT §7b / §7d; a home folder of launchd plists and .telegram-state dirs made here. No real bot token, no real Onsen.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pinLine, statusView } from './agent.ts'
import { carried, discover, plistEnv, readSettings, readToken, unitEnv } from './agents.ts'
import { FakeOnsen, FakeTelegram, until } from './fakes.ts'
import { sorryText, START_TEXT, transcribe } from './inbound.ts'
import { chmodSync } from 'node:fs'
import { Drawer } from './outbound.ts'
import { Bridge, configFromEnv, endpointRecord, takenOf } from './telegram-bridge.ts'
import { gate, isMentioned, mayAct, readAccess } from './tg-access.ts'
import { chunk, labelParts } from './tg-format.ts'
import { SinceTracker } from '../onsen-visible.ts'

const root = mkdtempSync(join(tmpdir(), 'tgb-'))
const home = join(root, 'home')
const JOEY = 1828173984
const TOK = { alpha: '7000000001:AAalphaSECRETalphaSECRETalpha', beta: '7000000002:BBbetaSECRETbetaSECRETbeta00', codex: '7000000003:CCcodexSECRETcodexSECRETcodex' }
const CRED = { mac: 'mesh_bridgemac_' + 'x'.repeat(20), mbp: 'mesh_bridgembp_' + 'y'.repeat(20) }
const settingsFile = join(home, '.config', 'crab-labs-plugins', 'env')
let tg: FakeTelegram, onsen: FakeOnsen
const logs: string[] = []

function put(path: string, body: unknown) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body, null, 2)) }
const ws = (n: string) => join(home, 'cc-workspaces', n)
const sd = (n: string) => join(ws(n), '.telegram-state')
function plist(label: string, env: Record<string, string>): string {
  return `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join('')}</dict></dict></plist>`
}
function settings(lines: string) { put(settingsFile, lines + '\n') }

beforeAll(() => {
  tg = new FakeTelegram(); onsen = new FakeOnsen()
  onsen.creds.set(CRED.mac, 'telegram-bridge-macmini'); onsen.creds.set(CRED.mbp, 'telegram-bridge-mbp')
  onsen.members = ['alpha', 'beta', 'codex', 'joey'].map(n => ({ name: n, display_name: n === 'alpha' ? 'Alpha 號' : n, kind: n === 'joey' ? 'human' : 'agent' }))
  for (const n of ['alpha', 'beta']) {
    put(join(sd(n), '.env'), `OTHER=1\nTELEGRAM_BOT_TOKEN=${TOK[n as 'alpha' | 'beta']}\n`)
    put(join(sd(n), 'access.json'), { dmPolicy: 'pairing', allowFrom: [String(JOEY)], groups: { '-100777': { requireMention: true, allowFrom: [] } }, pending: {} })
    put(join(home, 'Library', 'LaunchAgents', `com.btai.telegram-daemon.${n}.plist`), plist(`com.btai.telegram-daemon.${n}`, { TELEGRAM_STATE_DIR: sd(n), LANES_AGENT: n, AGENT_WORKSPACE_DIR: ws(n), TELEGRAM_HTTP_PORT: '17001' }))
  }
  // codex has no daemon: its bot is a lab bot's state dir, mapped by ONSEN_BRIDGE_STATE_DIRS (Epeius, 11-26)
  put(join(root, 'lab-state', '.env'), `TELEGRAM_BOT_TOKEN=${TOK.codex}\n`)
  put(join(root, 'lab-state', 'access.json'), { dmPolicy: 'allowlist', allowFrom: [String(JOEY)], groups: {}, pending: {} })
  // an agent-inbox daemon and a moved agent's manifest: neither is a bot here
  put(join(home, 'Library', 'LaunchAgents', 'com.btai.agent-inbox.alpha.plist'), plist('x', { TELEGRAM_STATE_DIR: join(ws('alpha'), '.agent-inbox-state'), CHANNEL_INBOX_ONLY: '1', LANES_AGENT: 'alpha' }))
  // as the Mac mini's really are (11-26 canary): an agent-inbox plist with TELEGRAM_STATE_DIR and no CHANNEL_INBOX_ONLY; its dir has no bot token
  put(join(home, 'Library', 'LaunchAgents', 'com.btai.agent-inbox.beta.plist'), plist('com.btai.agent-inbox.beta', { TELEGRAM_STATE_DIR: join(ws('beta'), '.agent-inbox-state'), LANES_AGENT: 'beta', AGENT_WORKSPACE_DIR: ws('beta') }))
  put(join(ws('beta'), '.agent-inbox-state', 'access.json'), { dmPolicy: 'allowlist', allowFrom: [], groups: {}, pending: {} })
  // a roamer's daemon: its own bot, lent to sessions; not a member's
  put(join(home, '.claude', 'channels', 'roamer-x', '.env'), 'TELEGRAM_BOT_TOKEN=7000000021:RRroamSECRETroamSECRETroam00\n')
  put(join(home, 'Library', 'LaunchAgents', 'com.btai.telegram-daemon.roamer-x.plist'), plist('com.btai.telegram-daemon.roamer-x', { TELEGRAM_STATE_DIR: join(home, '.claude', 'channels', 'roamer-x') }))
  put(join(ws('moved'), '.cc-agent.json'), { name: 'claude-moved', enabled: false, channels: { telegram: { state_dir: sd('moved') } } })
  tg.addBot(TOK.alpha, 'alpha_bot'); tg.addBot(TOK.beta, 'beta_bot'); tg.addBot(TOK.codex, 'lab_test_bot')
  put(join(home, '.config', 'mesh', 'telegram-bridge-macmini.credential'), CRED.mac + '\n')
  put(join(home, '.config', 'mesh', 'telegram-bridge-mbp.credential'), CRED.mbp + '\n')
})
afterAll(() => { tg?.stop(); onsen?.stop(); rmSync(root, { recursive: true, force: true }) })

function mkBridge(machine: 'macmini' | 'mbp', stateDir: string, extra: Record<string, string> = {}): Bridge {
  const env: NodeJS.ProcessEnv = {
    HOME: home, TELEGRAM_BRIDGE_MACHINE: machine, ONSEN_BASE: onsen.base, TELEGRAM_API_ROOT: tg.root, TELEGRAM_BRIDGE_STATE_DIR: stateDir,
    CRAB_LABS_PLUGINS_ENV: settingsFile, TELEGRAM_BRIDGE_PLATFORM: 'darwin', TELEGRAM_BRIDGE_SETTINGS_S: '0.2', TELEGRAM_BRIDGE_POLL_TIMEOUT_S: '1',
    TELEGRAM_BRIDGE_FEED_WAIT_S: '1', TELEGRAM_BRIDGE_VOICE: '0', TELEGRAM_BRIDGE_SORRY_S: '1.5', TELEGRAM_BRIDGE_RETRY_S: '0.2,0.3,0.4',
    TELEGRAM_BRIDGE_ONSEN_TIMEOUT_MS: '2000', TELEGRAM_BRIDGE_CONFLICT_RETRY_S: '0.5', TELEGRAM_BRIDGE_HANDOVER_S: '0.5', ...extra,
  }
  return new Bridge(configFromEnv(env), { log: (l, m) => logs.push(`${l} ${m}`) })
}
/** start a bridge's rounds (tick every 30 ms) and feed loop; returns its stop */
async function run(b: Bridge): Promise<() => Promise<void>> {
  await b.start()
  let on = true
  const loop = (async () => { while (on) { try { await b.tick() } catch (e) { logs.push(`error tick ${e}`) } await Bun.sleep(30) } })()
  return async () => { on = false; await loop; await b.stop() }
}

describe('which agents', () => {
  test('ONSEN_BRIDGE and ONSEN_BRIDGE_STATE_DIRS: env first, then the settings file; `*`, off, bad names', () => {
    settings('ONSEN_BRIDGE=alpha, beta,Bad\nONSEN_BRIDGE_STATE_DIRS=codex=/lab/state,x=rel/dir')
    let s = readSettings({ CRAB_LABS_PLUGINS_ENV: settingsFile })
    expect(s.list).toEqual(new Set(['alpha', 'beta']))
    expect([...s.dirs]).toEqual([['codex', '/lab/state']])
    expect(s.errors.length).toBe(2)
    s = readSettings({ CRAB_LABS_PLUGINS_ENV: settingsFile, ONSEN_BRIDGE: '*' })
    expect(s.list).toBe('*')
    settings('ONSEN_BRIDGE=off')
    expect(readSettings({ CRAB_LABS_PLUGINS_ENV: settingsFile }).list).toEqual(new Set())
    expect(readSettings({ CRAB_LABS_PLUGINS_ENV: join(root, 'none') }).list).toEqual(new Set())
  })
  test('discovery: the installed daemons (not agent-inbox, not a moved manifest); the map first; only the listed', () => {
    const d = discover(home, 'darwin')
    expect([...d.found.keys()].sort()).toEqual(['alpha', 'beta'])
    expect(d.found.get('alpha')!.stateDir).toBe(sd('alpha'))
    const s = { list: new Set(['alpha', 'codex']), dirs: new Map([['codex', join(root, 'lab-state')], ['beta', '/elsewhere']]), errors: [] }
    const c = carried(s, d)
    expect([...c.keys()]).toEqual(['alpha', 'codex'])                 // beta mapped but not listed: not carried
    expect(c.get('codex')!.source).toBe('ONSEN_BRIDGE_STATE_DIRS')
    expect([...carried({ ...s, list: '*' }, d).keys()]).toEqual(['alpha', 'beta', 'codex'])
    expect(carried({ ...s, list: '*' }, d).get('beta')!.stateDir).toBe('/elsewhere')   // the map wins over discovery
  })
  test('systemd units and drop-ins; two units for one member: neither', () => {
    const h = join(root, 'linuxhome'), u = join(h, '.config', 'systemd', 'user')
    put(join(u, 'telegram-daemon.a.service'), '[Service]\nEnvironment=TELEGRAM_STATE_DIR=%h/a/.telegram-state\nEnvironment="TELEGRAM_HTTP_PORT=1" X=2\n')
    put(join(u, 'telegram-daemon.a.service.d', 'lanes.conf'), '[Service]\nEnvironment=LANES_AGENT=aaa\n')
    const bx = join(root, 'x', 'claude-bee', '.telegram-state'), by = join(root, 'y', 'claude-bee', '.telegram-state')
    put(join(h, 'a', '.telegram-state', '.env'), 'TELEGRAM_BOT_TOKEN=7000000011:AAaaaaSECRETaaaaSECRETaaaa00\n')
    put(join(bx, '.env'), 'TELEGRAM_BOT_TOKEN=7000000012:BBbbbbSECRETbbbbSECRETbbbb00\n')
    put(join(by, '.env'), 'TELEGRAM_BOT_TOKEN=7000000013:CCccccSECRETccccSECRETcccc00\n')
    put(join(u, 'telegram-daemon.b.service'), `[Service]\nEnvironment=TELEGRAM_STATE_DIR=${bx}\n`)
    put(join(u, 'telegram-daemon.c.service'), `[Service]\nEnvironment=TELEGRAM_STATE_DIR=${by}\n`)
    put(join(u, 'telegram-daemon.d.service'), '[Service]\nEnvironment=TELEGRAM_STATE_DIR=/nowhere/claude-dee/.telegram-state\n')   // no token: not a bot here
    put(join(u, 'agent-inbox.a.service'), '[Service]\nEnvironment=CHANNEL_INBOX_ONLY=1 TELEGRAM_STATE_DIR=/z/.s\n')
    const d = discover(h, 'linux')
    expect([...d.found.keys()]).toEqual(['aaa'])
    expect(d.found.get('aaa')!.stateDir).toBe(join(h, 'a', '.telegram-state'))
    expect(d.dupes).toEqual(['bee'])
    expect(unitEnv('Environment="A=b c" D=e', '/h')).toEqual({ A: 'b c', D: 'e' })
    expect(plistEnv(plist('l', { K: 'a&amp;b' })).K).toBe('a&b')
  })
  test('the token: TELEGRAM_BOT_TOKEN of .env, nothing else', () => {
    expect(readToken(sd('alpha'))?.token).toBe(TOK.alpha)
    expect(readToken(join(root, 'nowhere'))).toBeNull()
    put(join(root, 'badenv', '.env'), 'TELEGRAM_BOT_TOKEN=not-a-token\n')
    expect(readToken(join(root, 'badenv'))).toBeNull()
  })
})

describe('access.json (ported from server.ts)', () => {
  test('DM allowlist, pairing (code written, 2 replies, then silent), group mention, mayAct', () => {
    const dir = join(root, 'acc')
    put(join(dir, 'access.json'), { dmPolicy: 'pairing', allowFrom: ['1'], groups: { '-5': { requireMention: true, allowFrom: [] } }, pending: {} })
    expect(gate(dir, { from: { id: 1 }, chat: { id: 1, type: 'private' } }, 'bot').action).toBe('deliver')
    const p1 = gate(dir, { from: { id: 2 }, chat: { id: 2, type: 'private' } }, 'bot') as any
    expect(p1.action).toBe('pair'); expect(p1.code).toMatch(/^[0-9a-f]{6}$/); expect(p1.isResend).toBe(false)
    expect(Object.keys(readAccess(dir)!.pending)).toEqual([p1.code])
    expect((gate(dir, { from: { id: 2 }, chat: { id: 2, type: 'private' } }, 'bot') as any).isResend).toBe(true)
    expect(gate(dir, { from: { id: 2 }, chat: { id: 2, type: 'private' } }, 'bot').action).toBe('drop')
    expect(gate(dir, { from: { id: 3 }, chat: { id: -5, type: 'supergroup' }, text: 'hi' }, 'bot').action).toBe('drop')
    expect(gate(dir, { from: { id: 3 }, chat: { id: -5, type: 'supergroup' }, text: 'hi @Bot', entities: [{ type: 'mention', offset: 3, length: 4 }] }, 'bot').action).toBe('deliver')
    expect(isMentioned({ reply_to_message: { from: { username: 'bot' } } }, 'bot')).toBe(true)
    expect(gate(dir, { from: { id: 3 }, chat: { id: -6, type: 'group' } }, 'bot').action).toBe('drop')
    const a = readAccess(dir)!
    expect(mayAct(a, { id: 1, type: 'private' }, '1')).toBe(true)
    expect(mayAct(a, { id: 2, type: 'private' }, '2')).toBe(false)
    expect(mayAct(a, { id: -5, type: 'group' }, '9')).toBe(true)
    put(join(dir, 'access.json'), '{not json')
    expect(gate(dir, { from: { id: 1 }, chat: { id: 1, type: 'private' } }, 'bot').action).toBe('drop')       // fail closed
    expect(readFileSync(join(dir, 'access.json'), 'utf8')).toBe('{not json')                                        // and left as it is
  })
})

describe('voice', () => {
  test('a voice note is transcribed locally (CHANNEL_BOT_TRANSCRIBE_CMD here) and its files are removed', async () => {
    const cmd = join(root, 'fake-whisper.sh')
    writeFileSync(cmd, '#!/bin/sh\ntest -s "$1" && echo "  你好 <世界>  "\n'); chmodSync(cmd, 0o755)
    const dir = join(root, 'voice-state')
    const t = await transcribe(new Uint8Array([1, 2, 3]), '42-7', { on: true, cmd, whisper: 'whisper', model: 'small', dir }, () => {})
    expect(t).toBe('你好 ＜世界＞')                                         // metaExcerpt, as the daemon's voice_transcript
    expect(existsSync(join(dir, 'voice', '42-7.oga'))).toBe(false)
    expect(await transcribe(new Uint8Array([1]), 'x', { on: true, cmd: join(root, 'nope'), whisper: 'w', model: 's', dir }, () => {})).toBeUndefined()
  })
})

describe('drawing helpers', () => {
  test('chunk and the label line, as server.ts', () => {
    expect(chunk('a'.repeat(10), 4, 'length')).toEqual(['aaaa', 'aaaa', 'aa'])
    expect(chunk('para one\n\npara two is longer', 12, 'newline')).toEqual(['para one', 'para two is', ' longer'])
    const p = labelParts('〔alpha·工作線#2〕', 'hi *there*', 4096, true)
    expect(p.rich).toEqual(['〔alpha·工作線#2〕\n\nhi *there*']); expect(p.plain).toEqual(['〔alpha·工作線#2〕\nhi *there*'])
    expect(labelParts('a_b', 'x', 4096, true).rich[0]).toBe('a\\_b\n\nx')
  })
  test('Onsen status → the pinned line, as the daemon draws it', () => {
    const now = Date.parse('2026-11-26T12:00:00Z'), since = new SinceTracker({ now: () => now })
    const main = (x: any) => ({ presence: 'online', lifecycle: 'ready', main_session_id: 'main', valid_until: '2026-11-26T12:01:00Z', sessions: [{ id: 'main', kind: 'main', activity_since: '2026-11-26T11:50:00Z', ...x }] })
    expect(pinLine(main({ activity: 'idle', blockers: [] }), since, now)).toBe('🟢 閒置（19:50 起）')
    expect(pinLine(main({ activity: 'running', doing: { kind: 'tool', tool: 'mcp__plugin_x__reply' }, blockers: [] }), since, now)).toBe('🟡 處理中（19:50 起）：reply')
    expect(pinLine(main({ activity: 'paused', blockers: [{ reason: 'permission', menu_kind: 'permission' }] }), since, now)).toBe('🟠 等你按（19:50 起）：權限詢問')
    expect(pinLine(main({ activity: 'idle', blockers: [{ reason: 'usage_limit', until: '2026-11-26T13:00:00Z' }] }), since, now)).toBe('🔴 撞上限，21:00 解除；每分鐘探測，通了自動放')
    expect(pinLine({ presence: 'offline', presence_reason: 'process_gone', sessions: [] }, since, now)).toMatch(/^⚫ 失連（\d\d:\d\d 起）：行程不在了$/)
    expect(statusView(main({ activity: 'stuck', turn: { started_at: '2026-11-26T11:40:00Z' } }), now)!.view.state).toBe('stuck')
  })
  test('a 409 names its member in any of its shapes', () => {
    expect(takenOf({ error: { code: 'endpoint_taken', message: '…', taken: [{ member: 'alpha', bridge: 'telegram-bridge-mbp' }] } }, ['alpha', 'beta'])).toEqual({ members: ['alpha'], holder: 'telegram-bridge-mbp' })   // Onsen 0.35.0
    expect(takenOf({ error: { code: 'endpoint_taken', member: 'alpha', by: 'telegram-bridge-mbp' } }, ['alpha', 'beta'])).toEqual({ members: ['alpha'], holder: 'telegram-bridge-mbp' })
    expect(takenOf({ error: { code: 'endpoint_taken', taken: [{ member: 'beta', by: 'x' }] } }, ['alpha', 'beta'])).toEqual({ members: ['beta'], holder: 'x' })
    expect(takenOf({ error: { code: 'endpoint_taken', message: 'beta 已經由 telegram-bridge-mbp 帶著' } }, ['alpha', 'beta']).members).toEqual(['beta'])
    expect(takenOf({ error: { code: 'endpoint_taken', message: 'taken' } }, ['alpha']).members).toEqual([])
  })
  test('an endpoint record: one line, the bot and its state; a conflict keeps its member (it claims nothing), an error has none', () => {
    const base = { member: 'alpha', username: 'alpha_bot', botId: '7', holder: null, lastError: null, telegramConflict: false, lastUpdateAt: null, stateDir: '/s', source: 'p', accepted: true, displayName: 'Alpha 號' }
    const ok = endpointRecord({ ...base, state: 'ok' }) as any
    expect(ok).toMatchObject({ id: 'alpha', member: 'alpha', state: 'ok', title: 'Alpha 號（@alpha_bot）', line: '@alpha_bot｜alpha｜收發中' })
    expect((endpointRecord({ ...base, state: 'conflict', holder: 'telegram-bridge-mbp' }) as any)).toMatchObject({ member: 'alpha', state: 'conflict', line: '@alpha_bot｜alpha｜另一支橋接帶著｜由 telegram-bridge-mbp 帶' })
    expect((endpointRecord({ ...base, state: 'error', lastError: 'Telegram 不認這個 token（getMe 401）' }) as any)).toMatchObject({ member: null, state: 'error' })
    expect(Drawer.coalesce([{ type: 'observation', member: 'a', chat: '1', seq: '1' }, { type: 'message', seq: '2' }, { type: 'observation', member: 'a', chat: '1', seq: '3' }]).map(x => x.seq)).toEqual(['2', '3'])
  })
})

describe('the bridge, end to end against the fakes', () => {
  const T = 20_000
  let stopMac: (() => Promise<void>) | null = null
  let mac: Bridge
  const macDir = join(root, 'state-mac')

  test('start: registers, sends the endpoints, polls only what Onsen took; a DM goes in with every §7d field, then 👀, then is confirmed', async () => {
    settings('ONSEN_BRIDGE=alpha,codex\nONSEN_BRIDGE_STATE_DIRS=codex=' + join(root, 'lab-state'))
    mac = mkBridge('macmini', macDir)
    stopMac = await run(mac)
    await until(() => tg.bots.get(TOK.alpha)!.getUpdatesCalls > 0 && tg.bots.get(TOK.codex)!.getUpdatesCalls > 0, 5000, 'both bots polled')
    expect(tg.bots.get(TOK.beta)!.getUpdatesCalls).toBe(0)                                   // not listed: never polled
    expect(onsen.extensions.get('telegram-bridge-macmini')).toMatchObject({ kind: 'bridge', client: 'telegram', machine: 'macmini' })
    const recs = onsen.lists.get('telegram-bridge-macmini')!
    expect(recs.map((r: any) => [r.id, r.member, r.state])).toEqual([['alpha', 'alpha', 'ok'], ['codex', 'codex', 'ok']])
    expect(recs[0].line).toBe('@alpha_bot｜alpha｜收發中')
    expect(recs[1].attributes.found_by).toBe('ONSEN_BRIDGE_STATE_DIRS')

    const mid = tg.text(TOK.alpha, JOEY, 'hello [link](x)', { entities: [] })
    await until(() => onsen.messages.some(m => m.client_msg_id === String(mid)), 5000, 'written')
    const w = onsen.messages.find(m => m.client_msg_id === String(mid))
    expect(w).toMatchObject({ member: 'alpha', client_user_id: String(JOEY), chat: String(JOEY), text: 'hello [link](x)', kind: 'text', attachments: [], attachment_file_ids: [],
      reply_to_client_msg_id: null, client_thread: null, idem_key: `tg:alpha:${JOEY}:${mid}`, client_user: { username: 'joey', display_name: 'Joey' } })
    await until(() => tg.callsOf(TOK.alpha, 'setMessageReaction').some(p => p.message_id === mid && p.reaction[0].emoji === '👀'), 3000, '👀')
    await until(() => tg.unconfirmed(TOK.alpha) === 0, 4000, 'confirmed')
    expect(onsen.bad).toEqual([])
  }, T)

  test('/start answered here; /status written as a command; a stranger gets a pairing code and nothing is written', async () => {
    const before = onsen.messages.length
    tg.text(TOK.alpha, JOEY, '/start')
    await until(() => tg.sentTo(TOK.alpha, String(JOEY)).some(s => s.text === START_TEXT), 3000, '/start answer')
    const sid = tg.text(TOK.alpha, JOEY, '/status')
    await until(() => onsen.messages.some(m => m.client_msg_id === String(sid)), 3000, '/status written')
    expect(onsen.messages.find(m => m.client_msg_id === String(sid)).kind).toBe('command')
    tg.text(TOK.alpha, 555, 'hi', { from: { id: 555, is_bot: false, first_name: 'S' }, chat: { id: 555, type: 'private' } })
    await until(() => tg.sentTo(TOK.alpha, '555').some(s => /Pairing required/.test(s.text ?? '')), 3000, 'pairing code')
    expect(Object.values(readAccess(sd('alpha'))!.pending).map(p => p.senderId)).toEqual(['555'])
    expect(onsen.messages.length).toBe(before + 1)
    // /telegram:access paired them: the confirmation, and the marker goes (server.ts checkApprovals)
    put(join(sd('alpha'), 'approved', '555'), '555')
    await until(() => tg.sentTo(TOK.alpha, '555').some(s => s.text === 'Paired! Say hi to Claude.'), 8000, 'paired confirmation')
    await until(() => !existsSync(join(sd('alpha'), 'approved', '555')), 2000, 'marker removed')
  }, T)

  test('a second bridge listing the same member: 409 endpoint_taken, its record says conflict (claiming nothing), its bot is never polled, nothing doubles on Telegram', async () => {
    const callsBefore = tg.bots.get(TOK.alpha)!.getUpdatesCalls
    const sentBefore = tg.sent.length
    const mbp = mkBridge('mbp', join(root, 'state-mbp'), { ONSEN_BRIDGE: 'alpha' })
    const stopMbp = await run(mbp)
    await until(() => (onsen.lists.get('telegram-bridge-mbp') ?? []).length === 1, 4000, 'mbp list')
    const r = onsen.lists.get('telegram-bridge-mbp')![0]
    expect(r).toMatchObject({ id: 'alpha', member: 'alpha', state: 'conflict' })
    expect(onsen.holders.get('alpha')).toBe('telegram-bridge-macmini')
    expect(r.line).toBe('@alpha_bot｜alpha｜另一支橋接帶著｜由 telegram-bridge-macmini 帶')
    await Bun.sleep(1200)                                                                       // past its conflict retry (0.5 s): asked again, refused again
    expect(mbp.stats.endpoint_conflicts).toBeGreaterThanOrEqual(2)
    expect(mbp.pollers.size).toBe(0)
    expect(tg.bots.get(TOK.alpha)!.conflicts).toBe(0)                                         // Telegram never saw two pollers
    const mid = tg.text(TOK.alpha, JOEY, 'only once')
    await until(() => onsen.messages.some(m => m.client_msg_id === String(mid)), 3000, 'written by mac')
    expect(onsen.messages.filter(m => m.client_msg_id === String(mid)).length).toBe(1)
    expect(tg.bots.get(TOK.alpha)!.getUpdatesCalls).toBeGreaterThan(callsBefore)
    expect(onsen.requests.filter(q => q.who === 'telegram-bridge-mbp' && q.path.includes('/bridge/messages')).length).toBe(0)
    expect(tg.sent.length).toBe(sentBefore)                                                   // no message to Telegram from either
    await stopMbp()
    // a 409 that names nobody: the bridge asks one member at a time and still finds it
    onsen.namesMember = false
    const mbp2 = mkBridge('mbp', join(root, 'state-mbp2'), { ONSEN_BRIDGE: 'alpha' })
    const stop2 = await run(mbp2)
    await until(() => mbp2.agents.get('alpha')?.state === 'conflict', 4000, 'probe found the conflict')
    expect(mbp2.pollers.size).toBe(0)
    await stop2()
    onsen.namesMember = true
  }, T)

  test('Onsen down: no 👀, nothing confirmed; one sentence after 15 s (1.5 s here); written once, in order, when it is back', async () => {
    const t = TOK.alpha
    const reactsBefore = tg.callsOf(t, 'setMessageReaction').length
    onsen.mode = '503'
    const m1 = tg.text(t, JOEY, 'first while down')
    const m2 = tg.text(t, JOEY, 'second while down')
    await until(() => tg.sentTo(t, String(JOEY)).filter(s => s.text === sorryText('Alpha 號')).length === 2, 5000, 'two sentences')
    const sorries = tg.sentTo(t, String(JOEY)).filter(s => s.text === sorryText('Alpha 號'))
    expect(sorries.map(s => s.params.reply_parameters.message_id)).toEqual([m1, m2])
    expect(tg.callsOf(t, 'setMessageReaction').length).toBe(reactsBefore)                   // no 👀 while Onsen has not got it
    expect(tg.unconfirmed(t)).toBeGreaterThanOrEqual(2)                                       // Telegram keeps them
    expect(onsen.messages.some(m => m.client_msg_id === String(m1))).toBe(false)
    await Bun.sleep(1500)
    expect(tg.sentTo(t, String(JOEY)).filter(s => s.text === sorryText('Alpha 號')).length).toBe(2)   // once each
    onsen.mode = 'up'
    await until(() => onsen.messages.some(m => m.client_msg_id === String(m2)), 8000, 'written after')
    const order = onsen.messages.filter(m => [String(m1), String(m2)].includes(m.client_msg_id)).map(m => m.client_msg_id)
    expect(order).toEqual([String(m1), String(m2)])                                           // once each, in order
    await until(() => tg.callsOf(t, 'setMessageReaction').filter(p => p.message_id === m1 || p.message_id === m2).length === 2, 3000, '👀 after')
    await until(() => tg.unconfirmed(t) === 0, 4000, 'confirmed after')
    expect(Object.keys(mac.state.data.sorry).length).toBe(2)
  }, T)

  test('files: a photo in → POST /files → attachment_file_ids; a message out with a file → its own sendPhoto', async () => {
    tg.files.set('f/PH1', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    const msg = { message_id: 4242, from: { id: JOEY, is_bot: false, first_name: 'Joey' }, chat: { id: JOEY, type: 'private' }, date: Math.floor(Date.now() / 1000),
      photo: [{ file_id: 'small', file_unique_id: 's', file_size: 1 }, { file_id: 'PH1', file_unique_id: 'p', file_size: 7 }], caption: 'look' }
    tg.push(TOK.alpha, { message: msg })
    await until(() => onsen.messages.some(m => m.client_msg_id === '4242'), 4000, 'photo written')
    const w = onsen.messages.find(m => m.client_msg_id === '4242')
    expect(w).toMatchObject({ kind: 'photo', text: 'look', attachments: [{ kind: 'photo', name: null, mime: 'image/jpeg', bytes: 7, client_ref: 'PH1' }] })
    expect(w.attachment_file_ids.length).toBe(1)
    const f = onsen.files.get(w.attachment_file_ids[0])!
    expect([...f.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    expect(f.key).toBe(`tg:alpha:${JOEY}:4242`)
    // out
    onsen.files.set('77', { bytes: new Uint8Array([1, 2, 3, 4]), name: 'chart.png', mime: 'image/png', key: null })
    onsen.files.set('78', { bytes: new Uint8Array([5, 6]), name: 'notes.md', mime: 'text/markdown', key: null })
    onsen.push({ type: 'message', member: 'alpha', conversation_id: 'cv_alpha', chat: String(JOEY), message: { id: 'm-files', from: 'alpha', type: 'message', body: { format: 'markdown', text: 'here' },
      attachments: [{ kind: 'photo', name: 'chart.png', mime: 'image/png', bytes: 4, url: '/api/onsen/v1/files/77' }, { kind: 'document', name: 'notes.md', mime: 'text/markdown', bytes: 2, url: `${onsen.base}/v1/files/78` }] },
      author_label: null, silent: false, origin_client: null, reply_to_client_msg_id: '4242', client_thread: null })
    await until(() => onsen.reports.some(r => r.id === 'm-files'), 4000, 'delivery of the file message')
    const sent = tg.sentTo(TOK.alpha, String(JOEY)).slice(-3)
    expect(sent.map(s => s.method)).toEqual(['sendRichMessage', 'sendPhoto', 'sendDocument'])
    expect(sent[1].file).toEqual({ name: 'chart.png', size: 4 })
    expect(sent[0].params.reply_parameters.message_id).toBe(4242)
    expect(sent[1].params.reply_parameters).toBeUndefined()                                   // reply_to on the first part only (replyToMode first)
    expect(onsen.reports.find(r => r.id === 'm-files')!.body).toMatchObject({ client: 'telegram', state: 'sent', client_msg_ids: sent.map(s => String(s.message_id)), error: null })
  }, T)

  test('the feed, drawn per type: message (label, silent, rich → plain, parts), echo, edit, reaction, receipts, action and its button, resolved, observation', async () => {
    const chat = String(JOEY), t = TOK.alpha
    const n0 = tg.sentTo(t, chat).length
    onsen.push({ type: 'message', member: 'alpha', conversation_id: 'cv', chat, message: { id: 'm1', from: 'alpha', type: 'message', body: { format: 'markdown', text: '**hi**' }, attachments: [] },
      author_label: '〔alpha·工作線#2〕', silent: true, origin_client: null, reply_to_client_msg_id: null, client_thread: null })
    await until(() => onsen.reports.some(r => r.id === 'm1'), 4000, 'm1')
    const s1 = tg.sentTo(t, chat)[n0]!
    expect(s1).toMatchObject({ method: 'sendRichMessage', markdown: '〔alpha·工作線#2〕\n\n**hi**' })
    expect(s1.params.disable_notification).toBe(true)
    // rich refused: plain; a long text in parts (textChunkLimit 4096)
    tg.refuseRich = true
    onsen.push({ type: 'message', member: 'alpha', conversation_id: 'cv', chat, message: { id: 'm2', from: 'alpha', type: 'message', body: { format: 'markdown', text: ('word '.repeat(900) + '\n\n').repeat(2) }, attachments: [] },
      author_label: null, silent: false, origin_client: null, reply_to_client_msg_id: null, client_thread: null })
    await until(() => onsen.reports.some(r => r.id === 'm2'), 4000, 'm2')
    tg.refuseRich = false
    const r2 = onsen.reports.find(r => r.id === 'm2')!.body
    expect(r2.client_msg_ids.length).toBe(chunk(('word '.repeat(900) + '\n\n').repeat(2), 4096, 'newline').length)
    expect(r2.client_msg_ids.length).toBe(3)
    expect(tg.sent.filter(s => r2.client_msg_ids.includes(String(s.message_id))).every(s => s.method === 'sendMessage' && !s.params.disable_notification)).toBe(true)
    // the person's own message from Onsen's page: a silent echo
    onsen.push({ type: 'message', member: 'alpha', conversation_id: 'cv', chat, message: { id: 'm3', from: 'joey', type: 'message', body: { format: 'markdown', text: '網頁上說的' }, attachments: [] },
      author_label: null, silent: false, origin_client: 'onsen', reply_to_client_msg_id: null, client_thread: null })
    await until(() => onsen.reports.some(r => r.id === 'm3'), 4000, 'm3')
    const e3 = tg.sent.find(s => String(s.message_id) === onsen.reports.find(r => r.id === 'm3')!.body.client_msg_ids[0])!
    expect(e3.markdown).toBe('〔你在 Onsen 傳的〕\n\n網頁上說的'); expect(e3.params.disable_notification).toBe(true)
    // an edit of m1, the member's reaction, receipts
    const m1id = Number(onsen.reports.find(r => r.id === 'm1')!.body.client_msg_ids[0])
    onsen.push({ type: 'message_edit', member: 'alpha', conversation_id: 'cv', chat, message_id: 'm1', client_msg_ids: [String(m1id)], text: '**hello**' })
    await until(() => tg.callsOf(t, 'editMessageText').some(p => p.message_id === m1id), 3000, 'edit')
    expect(tg.callsOf(t, 'editMessageText').find(p => p.message_id === m1id).rich_message.markdown).toBe('〔alpha·工作線#2〕\n\n**hello**')
    const jm = tg.text(t, JOEY, 'please')
    await until(() => onsen.messages.some(m => m.client_msg_id === String(jm)), 3000, 'jm written')
    onsen.push({ type: 'receipt', member: 'alpha', conversation_id: 'cv', chat, message_id: 'x', client_msg_id: String(jm), state: 'in_session' })
    await until(() => tg.callsOf(t, 'setMessageReaction').some(p => p.message_id === jm && p.reaction[0]?.emoji === '✍'), 4000, '✍')
    expect(tg.callsOf(t, 'sendChatAction').some(p => p.chat_id === chat && p.action === 'typing')).toBe(true)
    onsen.push({ type: 'reaction', member: 'alpha', conversation_id: 'cv', chat, message_id: 'x', client_msg_id: String(jm), emojis: ['👍'] })
    await until(() => tg.callsOf(t, 'setMessageReaction').some(p => p.message_id === jm && p.reaction[0]?.emoji === '👍'), 3000, '👍')
    // an old receipt is dropped
    const nr = tg.callsOf(t, 'setMessageReaction').length
    onsen.push({ type: 'receipt', member: 'alpha', conversation_id: 'cv', chat, message_id: 'y', client_msg_id: '1', state: 'in_session', at: new Date(Date.now() - 20 * 60_000).toISOString() })
    await Bun.sleep(400)
    expect(tg.callsOf(t, 'setMessageReaction').length).toBe(nr)
    // an Action: its buttons; a press → resolve; resolved → the buttons give way to the outcome
    onsen.push({ type: 'action', member: 'alpha', conversation_id: 'cv', chat, assignee_client_user_ids: [chat], action: { id: 'act9', kind: 'choice', source: 'permission', state: 'open',
      summary: '🔐 Bash: rm -rf build', body: null, options: [{ id: 'allow', label: '✅ Allow' }, { id: 'deny', label: '❌ Deny' }], version: 1 } })
    await until(() => tg.sentTo(t, chat).some(s => s.params.reply_markup?.inline_keyboard), 3000, 'action drawn')
    const am = tg.sentTo(t, chat).find(s => s.params.reply_markup?.inline_keyboard)!
    const kb = am.params.reply_markup.inline_keyboard
    expect(kb[0].map((b: any) => b.text)).toEqual(['✅ Allow', '❌ Deny'])
    tg.push(t, { callback_query: { id: 'cq1', from: { id: JOEY }, data: kb[0][0].callback_data, message: { message_id: am.message_id, chat: { id: JOEY, type: 'private' } } } })
    await until(() => onsen.resolves.some(r => r.id === 'act9'), 3000, 'resolve')
    expect(onsen.resolves.find(r => r.id === 'act9')!.body).toMatchObject({ client_user_id: chat, option: 'allow' })
    await until(() => tg.callsOf(t, 'answerCallbackQuery').some(p => p.callback_query_id === 'cq1' && p.text === '已送出：✅ Allow'), 3000, 'toast')
    tg.push(t, { callback_query: { id: 'cq2', from: { id: 555 }, data: kb[0][1].callback_data, message: { message_id: am.message_id, chat: { id: JOEY, type: 'private' } } } })
    await until(() => tg.callsOf(t, 'answerCallbackQuery').some(p => p.callback_query_id === 'cq2' && p.text === 'Not authorized.'), 3000, 'stranger refused')
    expect(onsen.actionDeliveries.find(d => d.id === 'act9')!.body).toEqual({ client_user_id: chat, client_msg_ids: [String(am.message_id)] })
    onsen.push({ type: 'action_resolved', member: 'alpha', conversation_id: 'cv', chat, action_id: 'act9', outcome: 'resolved', option_id: 'allow', option_label: '✅ Allow', by: 'joey', client_msg_ids: [String(am.message_id)] })
    await until(() => tg.callsOf(t, 'editMessageText').some(p => p.message_id === am.message_id), 3000, 'resolved drawn')
    const ed = tg.callsOf(t, 'editMessageText').find(p => p.message_id === am.message_id)
    expect(ed.rich_message.markdown).toBe('🔐 Bash: rm -rf build\n\n→ ✅ Allow（joey）'); expect(ed.reply_markup.inline_keyboard).toEqual([])
    // the pinned status: sent and pinned silently, then edited
    onsen.push({ type: 'observation', member: 'alpha', conversation_id: 'cv', chat, status: { presence: 'online', lifecycle: 'ready', main_session_id: 'main', sessions: [{ id: 'main', kind: 'main', activity: 'idle', blockers: [], activity_since: new Date().toISOString() }] } })
    await until(() => tg.bots.get(t)!.pinned.has(chat), 3000, 'pinned')
    const pinMsg = tg.sentTo(t, chat).find(s => s.message_id === tg.bots.get(t)!.pinned.get(chat))!
    expect(pinMsg.text).toMatch(/^🟢 閒置（\d\d:\d\d 起）/)
    expect(pinMsg.params.disable_notification).toBe(true)
    expect(pinMsg.params.reply_markup.inline_keyboard[0][0].callback_data).toBe('opin:off')
    expect(onsen.bad).toEqual([])
  }, T)

  test('the pinned status: only in a DM of a person on allowFrom; chat not found → not tried again until the person writes (WO-196, Chiron 11-27 05:36Z)', async () => {
    const t = TOK.alpha
    const acc = (allow: string[]) => put(join(sd('alpha'), 'access.json'), { dmPolicy: 'pairing', allowFrom: allow, groups: { '-100777': { requireMention: true, allowFrom: [] } }, pending: {} })
    const obs = (chat: string, activity = 'idle') => onsen.push({ type: 'observation', member: 'alpha', conversation_id: 'cv', chat, status: { presence: 'online', lifecycle: 'ready', main_session_id: 'main',
      sessions: [{ id: 'main', kind: 'main', activity, blockers: [], activity_since: new Date().toISOString() }] } })
    const to = (m: string, chat: string) => tg.callsOf(t, m).filter(p => String(p.chat_id) === chat).length
    obs('777')                                        // not on allowFrom: nothing sent there
    await Bun.sleep(800)
    expect(to('sendMessage', '777')).toBe(0)
    acc([String(JOEY), '888'])
    tg.fail.set('sendMessage', { code: 400, description: 'Bad Request: chat not found', times: 1 })
    obs('888')
    await until(() => to('sendMessage', '888') === 1, 3000, 'tried once')
    tg.fail.clear()
    obs('888', 'busy')                                // marked: not tried again
    await Bun.sleep(800)
    expect(to('sendMessage', '888')).toBe(1)
    tg.push(t, { message: { message_id: 8801, from: { id: 888, is_bot: false, first_name: 'P' }, chat: { id: 888, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'hi' } })
    await until(() => tg.bots.get(t)!.pinned.has('888'), 5000, 'pinned once the person wrote')
    await Bun.sleep(300)
    acc([String(JOEY)])                               // taken off the list: the status in that chat is no longer edited
    const e0 = to('editMessageText', '888') + to('sendMessage', '888')
    obs('888', 'busy'); await Bun.sleep(400); obs('888', 'idle')
    await Bun.sleep(800)
    expect(to('editMessageText', '888') + to('sendMessage', '888')).toBe(e0)
    expect(onsen.bad).toEqual([])
  }, T)

  test('blocked (WO-199): one silent ⚠️ line under the person\'s message, its reaction untouched; deleted once it is taken in again', async () => {
    const t = TOK.alpha, chat = String(JOEY)
    const lines = () => tg.callsOf(t, 'sendMessage').filter(p => String(p.chat_id) === chat && String(p.text ?? '').startsWith('⚠️'))
    const r0 = tg.callsOf(t, 'setMessageReaction').length
    onsen.push({ type: 'receipt', member: 'alpha', conversation_id: 'cv', chat, message_id: 'b1', client_msg_id: '7001', state: 'blocked',
      blocked_by: 'usage_limit', retry_after: '2026-12-03T15:00:00Z' })
    await until(() => lines().length === 1, 3000, 'the ⚠️ line')
    const l = lines()[0]
    expect(l.text).toBe('⚠️ 被額度上限擋下，通了自動重送（重置 12/3 23:00）')
    expect(l.disable_notification).toBe(true)
    expect(l.reply_parameters?.message_id).toBe(7001)
    expect(tg.callsOf(t, 'setMessageReaction').length).toBe(r0)
    onsen.push({ type: 'receipt', member: 'alpha', conversation_id: 'cv', chat, message_id: 'b1', client_msg_id: '7001', state: 'blocked',
      blocked_by: 'usage_limit', retry_after: null })
    await Bun.sleep(400)
    expect(lines().length).toBe(1)                    // one line per message
    const sent = tg.sentTo(t, chat).find(x => String(x.text ?? '').startsWith('⚠️'))!
    onsen.push({ type: 'receipt', member: 'alpha', conversation_id: 'cv', chat, message_id: 'b1', client_msg_id: '7001', state: 'in_session' })
    await until(() => tg.callsOf(t, 'deleteMessage').some(p => Number(p.message_id) === sent.message_id), 3000, 'the line deleted')
    onsen.push({ type: 'receipt', member: 'alpha', conversation_id: 'cv', chat, message_id: 'b2', client_msg_id: '7002', state: 'blocked', blocked_by: 'usage_limit' })
    await until(() => lines().length === 2, 3000, 'a second message: its own line')
    expect(lines()[1].text).toBe('⚠️ 被額度上限擋下，通了自動重送')
    const second = tg.sentTo(t, chat).filter(x => String(x.text ?? '').startsWith('⚠️'))[1]!
    tg.fail.set('deleteMessage', { code: 500, description: 'Internal Server Error', times: 1 })
    onsen.push({ type: 'receipt', member: 'alpha', conversation_id: 'cv', chat, message_id: 'b2', client_msg_id: '7002', state: 'turn_end' })
    await until(() => logs.some(x => x.includes(`line ${second.message_id} in chat ${chat} not deleted yet`)), 3000, 'a failed delete is kept')
    onsen.push({ type: 'receipt', member: 'alpha', conversation_id: 'cv', chat, message_id: 'b9', client_msg_id: '7009', state: 'delivered' })
    await until(() => tg.callsOf(t, 'deleteMessage').filter(p => Number(p.message_id) === second.message_id).length === 2, 3000,
      'tried again on the next receipt in that chat')
    onsen.push({ type: 'receipt', member: 'alpha', conversation_id: 'cv', chat, message_id: 'b3', client_msg_id: '7003', state: 'paused' })
    await until(() => logs.some(x => x.includes('receipt state paused on tg:7003')), 3000, 'an unknown state: one log line, nothing drawn')
    expect(onsen.bad).toEqual([])
  }, T)

  test('a send that fails is tried again (10 s / 30 s / 2 min; 0.2/0.3/0.4 s here; a 429 waits its retry_after), then reported failed', async () => {
    const chat = String(JOEY)
    tg.fail.set('sendRichMessage', { code: 500, description: 'Internal Server Error', times: 2 })
    tg.fail.set('sendMessage', { code: 500, description: 'Internal Server Error', times: 2 })
    onsen.push({ type: 'message', member: 'alpha', conversation_id: 'cv', chat, message: { id: 'r1', from: 'alpha', type: 'message', body: { format: 'markdown', text: 'retry me' }, attachments: [] },
      author_label: null, silent: false, origin_client: null, reply_to_client_msg_id: null, client_thread: null })
    await until(() => onsen.reports.some(r => r.id === 'r1'), 5000, 'r1 report')
    expect(onsen.reports.filter(r => r.id === 'r1').map(r => r.body.state)).toEqual(['sent'])
    expect(tg.sentTo(TOK.alpha, chat).filter(s => s.markdown === 'retry me' || s.text === 'retry me').length).toBe(1)
    tg.fail.set('sendRichMessage', { code: 502, description: 'Bad Gateway', times: 10 })
    tg.fail.set('sendMessage', { code: 502, description: 'Bad Gateway', times: 10 })
    onsen.push({ type: 'message', member: 'alpha', conversation_id: 'cv', chat, message: { id: 'r2', from: 'alpha', type: 'message', body: { format: 'markdown', text: 'never' }, attachments: [] },
      author_label: null, silent: false, origin_client: null, reply_to_client_msg_id: null, client_thread: null })
    await until(() => onsen.reports.some(r => r.id === 'r2'), 6000, 'r2 report')
    expect(onsen.reports.find(r => r.id === 'r2')!.body).toMatchObject({ state: 'failed', client_msg_ids: [] })
    expect(onsen.reports.find(r => r.id === 'r2')!.body.error).toMatch(/502/)
    tg.fail.clear()
    tg.fail.set('sendRichMessage', { code: 429, description: 'Too Many Requests: retry after 1', retry_after: 1, times: 1 })
    const t0 = Date.now()
    onsen.push({ type: 'message', member: 'alpha', conversation_id: 'cv', chat, message: { id: 'r3', from: 'alpha', type: 'message', body: { format: 'markdown', text: 'flood' }, attachments: [] },
      author_label: null, silent: false, origin_client: null, reply_to_client_msg_id: null, client_thread: null })
    await until(() => onsen.reports.some(r => r.id === 'r3'), 5000, 'r3 report')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
    expect(onsen.reports.find(r => r.id === 'r3')!.body.state).toBe('sent')
    tg.fail.clear()
  }, T)

  test('the cursor: stopped for a while, started again: every message drawn once, in order, the old ones silent', async () => {
    await stopMac!()
    stopMac = null
    const chat = String(JOEY), old = new Date(Date.now() - 20 * 60_000).toISOString()
    const n0 = tg.sentTo(TOK.alpha, chat).length
    const mk = (id: string, text: string, at?: string) => onsen.push({ type: 'message', member: 'alpha', conversation_id: 'cv', chat, ...(at ? { at } : {}),
      message: { id, from: 'alpha', type: 'message', body: { format: 'markdown', text }, attachments: [] }, author_label: null, silent: false, origin_client: null, reply_to_client_msg_id: null, client_thread: null })
    mk('c1', 'one (20 min ago)', old); mk('c2', 'two'); mk('c3', 'three')
    onsen.push({ type: 'receipt', member: 'alpha', conversation_id: 'cv', chat, message_id: 'z', client_msg_id: '5', state: 'delivered', at: old })
    mac = mkBridge('macmini', macDir)
    stopMac = await run(mac)
    await until(() => ['c1', 'c2', 'c3'].every(id => onsen.reports.some(r => r.id === id)), 6000, 'caught up')
    const got = tg.sentTo(TOK.alpha, chat).slice(n0).filter(s => /one|two|three/.test(s.markdown ?? ''))
    expect(got.map(s => s.markdown)).toEqual(['one (20 min ago)', 'two', 'three'])
    expect(got.map(s => !!s.params.disable_notification)).toEqual([true, false, false])
    await Bun.sleep(1500)                                                                       // another feed round: nothing again
    expect(tg.sentTo(TOK.alpha, chat).slice(n0).filter(s => /one|two|three/.test(s.markdown ?? '')).length).toBe(3)
    // a batch half drawn before a stop is not drawn again: the done seqs are kept with the cursor
    mac.state.data.feed.drawn.push('99999')
    expect(JSON.parse(readFileSync(join(macDir, 'state.json'), 'utf8')).feed.after).toBeTruthy()
  }, T)

  test('ONSEN_BRIDGE read again: a bot added is polled; one taken off stops and its record goes', async () => {
    settings('ONSEN_BRIDGE=alpha,beta,codex\nONSEN_BRIDGE_STATE_DIRS=codex=' + join(root, 'lab-state'))
    await until(() => tg.bots.get(TOK.beta)!.getUpdatesCalls > 0, 4000, 'beta polled')
    await until(() => (onsen.lists.get('telegram-bridge-macmini') ?? []).some((r: any) => r.id === 'beta' && r.member === 'beta'), 3000, 'beta record')
    settings('ONSEN_BRIDGE=alpha,beta')
    await until(() => !mac.pollers.has('codex'), 4000, 'codex stopped')
    await until(() => !(onsen.lists.get('telegram-bridge-macmini') ?? []).some((r: any) => r.id === 'codex'), 3000, 'codex record gone')
    const calls = tg.bots.get(TOK.codex)!.getUpdatesCalls
    await Bun.sleep(1500)
    expect(tg.bots.get(TOK.codex)!.getUpdatesCalls).toBe(calls)
    expect(onsen.holders.has('codex')).toBe(false)
  }, T)

  test('an edit in Telegram → /bridge/messages/edit; an edit of a message Onsen never had is dropped', async () => {
    const t = TOK.alpha
    const mid = tg.text(t, JOEY, 'typo')
    await until(() => onsen.messages.some(m => m.client_msg_id === String(mid)), 3000, 'written')
    tg.push(t, { edited_message: { message_id: mid, from: { id: JOEY, is_bot: false }, chat: { id: JOEY, type: 'private' }, date: 1, edit_date: Math.floor(Date.now() / 1000), text: 'fixed' } })
    await until(() => onsen.edits.some(e => e.client_msg_id === String(mid)), 3000, 'edit written')
    expect(onsen.edits.find(e => e.client_msg_id === String(mid))).toMatchObject({ member: 'alpha', chat: String(JOEY), text: 'fixed' })
    tg.push(t, { edited_message: { message_id: 1, from: { id: JOEY, is_bot: false }, chat: { id: JOEY, type: 'private' }, date: 1, edit_date: 2, text: 'x' } })
    await until(() => tg.unconfirmed(t) === 0, 4000, 'confirmed (the unknown edit did not hold the bot)')
  }, T)

  test('no token in any log line, and none in Onsen', async () => {
    await stopMac!()
    stopMac = null
    const all = logs.join('\n')
    for (const tok of Object.values(TOK)) { expect(all.includes(tok)).toBe(false); expect(all.includes(tok.split(':')[1]!)).toBe(false) }
    expect(all.includes(CRED.mac)).toBe(false)
    const onsenText = JSON.stringify([onsen.messages, [...onsen.lists.values()], onsen.reports])
    for (const tok of Object.values(TOK)) expect(onsenText.includes(tok.split(':')[1]!)).toBe(false)
    expect(existsSync(join(macDir, 'state.json'))).toBe(true)
    expect(readFileSync(join(macDir, 'state.json'), 'utf8').includes('SECRET')).toBe(false)
  }, T)
})

describe('voice transcription follows the daemon (Chiron 12794)', () => {
  test('off unless CHANNEL_BOT_VOICE_TRANSCRIBE=1 or TELEGRAM_BRIDGE_VOICE=1, as the daemon', () => {
    const base = { HOME: home, TELEGRAM_BRIDGE_MACHINE: 'macmini' }
    expect(configFromEnv(base as any).voice!.on).toBe(false)
    expect(configFromEnv({ ...base, CHANNEL_BOT_VOICE_TRANSCRIBE: '1' } as any).voice!.on).toBe(true)
    expect(configFromEnv({ ...base, TELEGRAM_BRIDGE_VOICE: '1' } as any).voice!.on).toBe(true)
    expect(configFromEnv({ ...base, CHANNEL_BOT_VOICE_TRANSCRIBE: '1', TELEGRAM_BRIDGE_VOICE: '0' } as any).voice!.on).toBe(false)
  })
})
