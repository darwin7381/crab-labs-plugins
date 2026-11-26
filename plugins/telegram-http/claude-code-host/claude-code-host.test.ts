// claude-code-host.test.ts (board WO-183). A fake Onsen (Bun.serve) that checks every request against CONTRACT §7b's shapes, fake daemons
// answering /healthz, a home folder of manifests made here, and a clock the test moves. The session listings are faked through the finder's
// runner; the one subprocess test points tmux at a socket that does not exist (no server is touched) and claude at a fake script.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isReadOnlyListing, type FoundSession, type RunResult, type Runner } from '../session-finder.ts'
import {
  buildRecord, buildRecords, CLIENT_ZH, configFromEnv, daemonPorts, Host, manifestMember, memberOf, registration, telegramSessions, tpe,
  type Config,
} from './claude-code-host.ts'

const root = mkdtempSync(join(tmpdir(), 'cch-'))
const home = join(root, 'home')
const CRED = 'mesh_cchtest_' + 'x'.repeat(20)
const NOW = Date.parse('2026-11-26T09:30:00Z')

function put(path: string, body: unknown) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body))
}
const ws = (n: string) => join(home, 'cc-workspaces', n)

beforeAll(() => {
  put(join(ws('claude-alpha'), '.cc-agent.json'), { name: 'claude-alpha', claude_command: 'X=1 claude $(bun lanes-launch.ts --workspace /w --agent alpha) --y', channels: { telegram: { http_port: 17001 } } })
  put(join(ws('claude-beta'), '.cc-agent.json'), { name: 'claude-beta', claude_command: 'claude --channels plugin:telegram-http', channels: { telegram: { http_port: 17002 } } })
  put(join(ws('claude-beta'), '.lanes', 'main-settings.json'), { env: { LANES_AGENT: 'beta' }, hooks: {} })
  put(join(ws('claude-gamma'), '.cc-agent.json'), { name: 'claude-gamma', mesh_id: 'gamma-x', claude_command: '--agent other' })
  put(join(ws('claude-test'), '.cc-agent.json'), { name: 'claude-test', claude_command: 'claude' })
  put(join(ws('claude-test'), '..', '.lanes', 'main-settings.json'), { env: { LANES_AGENT: 'never-reached' } })
  put(join(ws('claude-relay'), '.lanes', 'main-settings.json'), { env: { LANES_AGENT: 'lab-relay' } })
  put(join(ws('claude-bad'), '.lanes', 'main-settings.json'), { env: { LANES_AGENT: 'Bad Name' } })
  put(join(home, '.claude', 'workspace-telegram', '.cc-agent.json'), { name: 'channel-bot', workspace_dir: join(home, '.claude', 'workspace-telegram'), claude_command: 'claude', channels: { telegram: { http_port: 17010 } } })
  put(join(home, '.claude', 'workspace-telegram', '.lanes', 'main-settings.json'), { env: { LANES_AGENT: 'sonn' } })
  mkdirSync(join(ws('claude-alpha'), 'repos', 'x', 'y'), { recursive: true })
  put(join(home, 'Library', 'LaunchAgents', 'com.x.telegram-daemon.steropes.plist'), '<plist><dict><key>TELEGRAM_HTTP_PORT</key>\n\t<string>17003</string><key>TELEGRAM_BOT_TOKEN</key><string>secret</string></dict></plist>')
  put(join(home, 'Library', 'LaunchAgents', 'com.x.other.plist'), '<plist><dict><key>PORT</key><string>9999</string></dict></plist>')
  put(join(home, '.config', 'systemd', 'user', 'telegram-daemon.a.service'), '[Service]\nEnvironment=TELEGRAM_HTTP_PORT=17004\nExecStart=bun server.ts\n')
  put(join(home, '.config', 'systemd', 'user', 'telegram-daemon.a.service.d', 'port.conf'), '[Service]\nEnvironment=TELEGRAM_HTTP_PORT=17005\n')
  put(join(home, '.config', 'systemd', 'user', 'other.service'), '[Service]\nEnvironment=PORT=1\n')
  put(join(home, '.claude', 'channels', 'roamer-daemons.json'), { 'telegram-a': { protocol: 'telegram', port: 17006 }, 'discord-b': { protocol: 'discord', port: 17007 } })
  put(join(home, '.config', 'mesh', 'claude-code-host-testbox.credential'), CRED + '\n')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('member', () => {
  test('the nearest manifest or lanes settings at or above the cwd', () => {
    expect(memberOf(ws('claude-alpha'))).toBe('alpha')                               // lanes-launch --agent in claude_command
    expect(memberOf(join(ws('claude-alpha'), 'repos', 'x', 'y'))).toBe('alpha')      // a lane or a sub-folder: its owner's
    expect(memberOf(ws('claude-beta'))).toBe('beta')                                 // no --agent: the workspace's LANES_AGENT
    expect(memberOf(ws('claude-gamma'))).toBe('gamma-x')                             // an explicit mesh_id wins
    expect(memberOf(ws('claude-test'))).toBeNull()                                   // a manifest naming nobody: null (the search stops there)
    expect(memberOf(ws('claude-relay'))).toBe('lab-relay')                           // no manifest, only the lanes settings
    expect(memberOf(ws('claude-bad'))).toBeNull()                                    // not a member name
    expect(memberOf(join(home, '.claude', 'workspace-telegram'))).toBe('sonn')       // channel-bot is sonn
    expect(memberOf(join(root, 'scratch'))).toBeNull()
    expect(memberOf('/')).toBeNull()
    expect(memberOf(null)).toBeNull()
    expect(manifestMember({ claude_command: 'a --agent=delta b' }, '/nowhere')).toBe('delta')
  })
  test('one cache per scan answers a folder once', () => {
    const cache = new Map<string, string | null>()
    expect(memberOf(join(ws('claude-alpha'), 'repos', 'x'), cache)).toBe('alpha')
    expect(cache.get(join(ws('claude-alpha'), 'repos'))).toBe('alpha')
    expect(memberOf(join(ws('claude-alpha'), 'repos'), cache)).toBe('alpha')
  })
})

describe('daemons', () => {
  test('ports: manifests, launchd plists (macOS) or systemd units (Linux), the Telegram roamers, extra', () => {
    expect(daemonPorts(home, 'darwin', [17008])).toEqual([17001, 17002, 17003, 17006, 17008, 17010])
    expect(daemonPorts(home, 'linux')).toEqual([17001, 17002, 17004, 17005, 17006, 17010])
    expect(daemonPorts(join(root, 'empty-home'), 'linux')).toEqual([])
  })
  test('a session is Telegram\'s: a daemon\'s main (not gone, SSE open), or a live Telegram roamer\'s claim', () => {
    const h = [
      { port: 1, main_session: 's-1', main_phase: 'idle', sessions_with_open_sse: 1 },
      { port: 2, main_session: 's-2', main_phase: 'gone', sessions_with_open_sse: 1 },
      { port: 3, main_session: 's-3', main_phase: 'in_turn', sessions_with_open_sse: 0 },
      { port: 4, main_session: null, main_phase: null, sessions_with_open_sse: 1 },
    ]
    const reg = {
      a: { session_id: 'r-1', claude_pid: 10, daemon_pid: 11, protocol: 'telegram' },
      b: { session_id: 'r-2', claude_pid: 10, daemon_pid: 99, protocol: 'telegram' },
      c: { session_id: 'r-3', claude_pid: 10, daemon_pid: 11, protocol: 'discord' },
      d: { session_id: 'r-4', claude_pid: 10, daemon_pid: 11 },
    }
    expect([...telegramSessions(h, reg, p => p === 10 || p === 11)].sort()).toEqual(['r-1', 'r-4', 's-1'])
    expect([...telegramSessions([], null, () => true)]).toEqual([])
  })
})

describe('records', () => {
  const s: FoundSession = { sessionId: '5eed8fa2-7d14-4a4e-b123-80b98a5ed6d6', pid: 38918, cwd: '/Users/x/cc-workspaces/claude-epeius', kind: 'interactive',
    startedAt: Date.parse('2026-11-26T09:20:30Z'), status: 'busy', name: 'n', tmux: 'claude-epeius' }
  test('Chiron\'s section 二: title, line, member, state, the six attributes', () => {
    const r = buildRecord(s, 'epeius', 'Epeius', 'telegram', NOW)
    expect(r).toEqual({
      id: s.sessionId, title: 'Epeius', member: 'epeius', state: 'busy',
      line: 'Epeius｜claude-epeius｜claude-epeius｜接 Telegram｜busy｜起於 11-26 17:20 台北',
      attributes: { session_id: s.sessionId, cwd: s.cwd, tmux: 'claude-epeius', pid: 38918, started_at: '2026-11-26T09:20:30.000Z', client: 'telegram' },
    })
    expect(Object.keys(r.attributes)).toEqual(['session_id', 'cwd', 'tmux', 'pid', 'started_at', 'client'])
  })
  test('no member: 未登記 and the folder; no tmux: 無 tmux; a member Onsen has no name for: its mesh id', () => {
    const r = buildRecord({ ...s, tmux: null, cwd: '/private/tmp/scratch-1' }, null, null, 'none', NOW)
    expect(r.title).toBe('scratch-1')
    expect(r.member).toBeNull()
    expect(r.line).toBe('未登記｜無 tmux｜scratch-1｜沒有接｜busy｜起於 11-26 17:20 台北')
    expect(r.attributes.tmux).toBeNull()
    expect(r.attributes.client).toBe('none')
    expect(buildRecord(s, 'epeius', null, 'onsen', NOW).line).toBe('epeius｜claude-epeius｜claude-epeius｜接 Onsen｜busy｜起於 11-26 17:20 台北')
    expect(CLIENT_ZH).toEqual({ telegram: '接 Telegram', onsen: '接 Onsen', none: '沒有接' })
  })
  test('missing facts are said, line breaks never sent, the limits Onsen checks kept', () => {
    const r = buildRecord({ sessionId: 'x', tmux: null }, null, null, 'none', NOW)
    expect(r.line).toBe('未登記｜無 tmux｜不明｜沒有接｜狀態不明｜起於 不明')
    expect(r.state).toBeNull()
    expect(r.attributes).toEqual({ session_id: 'x', cwd: null, tmux: null, pid: null, started_at: null, client: 'none' })
    const odd = buildRecord({ ...s, status: 'wait\ning' + 'x'.repeat(60) }, 'epeius', 'Ep\neius', 'none', NOW)
    expect(odd.state!.length).toBe(40)
    expect(/[\n\r]/.test(odd.line + odd.title + odd.state)).toBe(false)
  })
  test('times: MM-DD HH:MM 台北, the year in front only when it is another year', () => {
    expect(tpe(Date.parse('2026-11-26T16:05:00Z'), NOW)).toBe('11-27 00:05 台北')
    expect(tpe(Date.parse('2025-12-31T15:59:00Z'), NOW)).toBe('2025-12-31 23:59 台北')
  })
  test('the list: in start order, an id once, client from the Telegram set, names from Onsen', () => {
    const a = { ...s, sessionId: 'b', startedAt: 2, cwd: ws('claude-alpha') }
    const b = { ...s, sessionId: 'a', startedAt: 2, cwd: ws('claude-beta') }
    const c = { ...s, sessionId: 'c', startedAt: 1, cwd: join(root, 'scratch') }
    const out = buildRecords([a, b, c, { ...a }], new Set(['b']), new Map([['alpha', 'Alpha 名']]), NOW)
    expect(out.map(r => [r.id, r.member, r.title, r.attributes.client])).toEqual([
      ['c', null, 'scratch', 'none'], ['a', 'beta', 'beta', 'none'], ['b', 'alpha', 'Alpha 名', 'telegram']])
  })
})

// ---- a fake Onsen that checks CONTRACT §7b's request shapes, and fake daemons -----------------------------------------------------

type Seen = { method: string; path: string; auth: string | null; body: any }
function fakeOnsen() {
  const seen: Seen[] = []
  const state = { registered: false, mode: 'ok' as 'ok' | '503' | '404' | 'members403', lists: 0 }
  const bad = (m: string) => Response.json({ error: { code: 'invalid_request', message: m, retryable: false } }, { status: 400 })
  const exact = (o: any, keys: string[]) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join() === [...keys].sort().join()
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      const body = req.method === 'PUT' ? await req.json() : null
      seen.push({ method: req.method, path: u.pathname + u.search, auth: req.headers.get('authorization'), body })
      if (req.headers.get('authorization') !== `Bearer ${CRED}`) return Response.json({ error: { code: 'not_authenticated' } }, { status: 401 })
      const p = u.pathname.replace('/api/onsen/v1', '')
      if (req.method === 'GET' && p === '/members') {
        if (state.mode === 'members403') return Response.json({ error: { code: 'not_authorized' } }, { status: 403 })
        const first = !u.searchParams.get('cursor')
        return Response.json({ api_version: '1', items: first ? [{ name: 'alpha', display_name: 'Alpha 名' }] : [{ name: 'beta', display_name: 'Beta 名' }],
          next_cursor: first ? 'c2' : null })
      }
      if (req.method === 'GET' && p === '/me') return Response.json({ api_version: '1', data: { name: 'claude-code-host-testbox', kind: 'system' } })
      if (req.method === 'PUT' && p === '/extensions/claude-code-host-testbox') {
        if (!exact(body, ['kind', 'title', 'version', 'machine', 'collections'])) return bad('register keys')
        if (body.kind !== 'host' || !Array.isArray(body.collections) || !exact(body.collections[0], ['name', 'title', 'ttl_seconds'])) return bad('register shape')
        const first = !state.registered
        state.registered = true
        return Response.json({ api_version: '1', data: { name: 'claude-code-host-testbox' } }, { status: first ? 201 : 200 })
      }
      if (req.method === 'PUT' && p === '/extensions/claude-code-host-testbox/collections/sessions') {
        if (state.mode === '503') return Response.json({ error: { code: 'service_unavailable', retryable: true } }, { status: 503 })
        if (state.mode === '404' || !state.registered) { state.registered = false; return Response.json({ error: { code: 'not_found' } }, { status: 404 }) }
        if (!exact(body, ['reported_at', 'records']) || Number.isNaN(Date.parse(body.reported_at))) return bad('list keys')
        for (const r of body.records) {
          if (!exact(r, ['id', 'title', 'line', 'member', 'state', 'attributes'])) return bad('record keys')
          if (/[\n\r]/.test(r.line + r.title) || r.line.length > 500 || r.title.length > 200 || (r.state !== null && r.state.length > 40)) return bad('record limits')
          if (Object.values(r.attributes).some(v => v !== null && typeof v === 'object')) return bad('attributes')
        }
        state.lists++
        return Response.json({ api_version: '1', data: { name: 'claude-code-host-testbox' } })
      }
      return Response.json({ error: { code: 'not_found' } }, { status: 404 })
    },
  })
  return { server, seen, state, base: `http://127.0.0.1:${server.port}/api/onsen/v1` }
}

function fakeDaemon(health: Record<string, unknown>) {
  return Bun.serve({ port: 0, fetch: req => new URL(req.url).pathname === '/healthz' ? Response.json(health) : new Response('no', { status: 404 }) })
}

function cfgFor(base: string, extraPorts: number[], over: Partial<Config> = {}): Config {
  return {
    machine: 'testbox', name: 'claude-code-host-testbox', base, credentialFile: join(home, '.config', 'mesh', 'claude-code-host-testbox.credential'),
    home: join(root, 'host-home'), platform: 'linux', scanMs: 5000, reportMs: 15000, membersMs: 300000, registerMs: 300000, healthTimeoutMs: 1000,
    requestTimeoutMs: 2000, extraPorts, finder: {}, version: '9.9.9', ...over,
  }
}

describe('the loop, against a fake Onsen', () => {
  const sessions: FoundSession[] = [
    { sessionId: 's-1', pid: 11, cwd: ws('claude-alpha'), kind: 'interactive', startedAt: NOW - 60000, status: 'idle', tmux: 'claude-alpha' },
    { sessionId: 's-2', pid: 12, cwd: join(root, 'scratch'), kind: 'interactive', startedAt: NOW - 30000, status: 'busy', tmux: null },
  ]
  test('register, the list at once, nothing while unchanged, the keep-alive at 15 s, a change at once; read-only', async () => {
    const on = fakeOnsen()
    const d1 = fakeDaemon({ main_session: 's-1', main_phase: 'idle', sessions_with_open_sse: 1 })
    const d2 = fakeDaemon({ main_session: 's-2', main_phase: 'gone', sessions_with_open_sse: 1 })
    let now = NOW
    let current = [...sessions]
    const logs: string[] = []
    const host = new Host(cfgFor(on.base, [d1.port!, d2.port!]), { now: () => now, log: (l, m) => logs.push(`${l} ${m}`), list: async () => current })
    try {
      await host.tick()
      const lists = () => on.seen.filter(x => x.path.endsWith('/collections/sessions'))
      expect(on.seen[0].method + ' ' + on.seen[0].path).toBe('PUT /api/onsen/v1/extensions/claude-code-host-testbox')
      expect(on.seen[0].body).toEqual(registration(host.cfg))
      expect(on.seen[0].body.collections).toEqual([{ name: 'sessions', title: expect.any(String), ttl_seconds: 45 }])
      expect(on.seen.filter(x => x.path.startsWith('/api/onsen/v1/members')).length).toBe(2)   // two pages of members
      expect(lists().length).toBe(1)
      const recs = lists()[0].body.records
      expect(recs.map((r: any) => [r.id, r.member, r.title, r.attributes.client, r.attributes.tmux])).toEqual([
        ['s-1', 'alpha', 'Alpha 名', 'telegram', 'claude-alpha'], ['s-2', null, 'scratch', 'none', null]])
      expect(recs[0].line).toBe('Alpha 名｜claude-alpha｜claude-alpha｜接 Telegram｜idle｜起於 11-26 17:29 台北')
      expect(Date.parse(lists()[0].body.reported_at)).toBe(NOW)
      expect(on.seen.every(x => x.auth === `Bearer ${CRED}`)).toBe(true)
      now += 5000; await host.tick()
      now += 5000; await host.tick()
      expect(lists().length).toBe(1)                                          // unchanged, inside 15 s
      now += 6000; await host.tick()
      expect(lists().length).toBe(2)                                          // the keep-alive
      current = [...sessions, { ...sessions[1], sessionId: 's-3', startedAt: NOW }]
      now += 5000; await host.tick()
      expect(lists().length).toBe(3)                                          // a change: at once
      expect(lists()[2].body.records.map((r: any) => r.id)).toEqual(['s-1', 's-2', 's-3'])
      current = [sessions[0]]
      now += 5000; await host.tick()
      expect(lists()[3].body.records.map((r: any) => r.id)).toEqual(['s-1'])  // one closed: gone from the next list
      expect(on.seen.filter(x => x.path === '/api/onsen/v1/extensions/claude-code-host-testbox').length).toBe(1)
      expect(logs.join('\n')).not.toContain(CRED)
    } finally { on.server.stop(true); d1.stop(true); d2.stop(true) }
  })

  test('Onsen refusing or away: that list is dropped, the next carries the list as it is then; a 404 registers again', async () => {
    const on = fakeOnsen()
    let now = NOW
    let current = [...sessions]
    const logs: string[] = []
    const host = new Host(cfgFor(on.base, []), { now: () => now, log: (l, m) => logs.push(`${l} ${m}`), list: async () => current })
    try {
      await host.tick()
      on.state.mode = '503'
      current = [sessions[0]]
      now += 5000; await host.tick()
      expect(host.stats.dropped).toBe(1)
      now += 1000; await host.tick()                                         // inside the backoff: nothing tried
      expect(host.stats.sent).toBe(2)
      on.state.mode = 'ok'
      current = [sessions[1]]
      now += 5000; await host.tick()
      const lists = on.seen.filter(x => x.path.endsWith('/collections/sessions') && x.method === 'PUT')
      expect(lists.at(-1)!.body.records.map((r: any) => r.id)).toEqual(['s-2'])   // the list as it is now, not the dropped one
      expect(host.stats.taken).toBe(2)
      on.state.mode = '404'
      current = [...sessions]
      now += 5000; await host.tick()
      expect(host.needRegister).toBe(true)
      on.state.mode = 'ok'
      now += 5000; await host.tick()
      expect(on.seen.filter(x => x.path === '/api/onsen/v1/extensions/claude-code-host-testbox').length).toBe(2)
      expect(host.lastSent).toContain('s-2')
      on.server.stop(true)                                                   // Onsen gone
      current = [sessions[0]]
      now += 60000
      await host.tick()                                                      // does not throw
      expect(logs.some(l => l.includes('not reached'))).toBe(true)
    } finally { on.server.stop(true) }
  })

  test('claude agents failing: no list (Onsen keeps the last until it expires), the heartbeat still goes', async () => {
    const on = fakeOnsen()
    let now = NOW
    let current: FoundSession[] | null = [...sessions]
    const host = new Host(cfgFor(on.base, []), { now: () => now, log: () => {}, list: async () => current })
    try {
      await host.tick()
      current = null
      now += 20000; await host.tick()
      expect(on.seen.filter(x => x.path.endsWith('/collections/sessions')).length).toBe(1)
      expect(on.seen.filter(x => x.path === '/api/onsen/v1/extensions/claude-code-host-testbox').length).toBe(2)
      expect(host.stats.listFailed).toBe(1)
    } finally { on.server.stop(true) }
  })

  test('names: Onsen refusing /members leaves the mesh ids; no credential: nothing is sent', async () => {
    const on = fakeOnsen()
    on.state.mode = 'members403'
    const host = new Host(cfgFor(on.base, []), { now: () => NOW, log: () => {}, list: async () => [sessions[0]] })
    const nocred = new Host(cfgFor(on.base, [], { credentialFile: join(root, 'missing.credential') }), { now: () => NOW, log: () => {}, list: async () => [sessions[0]] })
    try {
      await host.tick()
      const list = on.seen.find(x => x.path.endsWith('/collections/sessions'))!
      expect(list.body.records[0].title).toBe('alpha')
      expect(list.body.records[0].line.startsWith('alpha｜')).toBe(true)
      const before = on.seen.length
      await nocred.tick()
      expect(on.seen.length).toBe(before)
    } finally { on.server.stop(true) }
  })

  test('read-only: every command the host runs is a listing', async () => {
    const on = fakeOnsen()
    const calls: string[][] = []
    const run: Runner = async argv => {
      calls.push(argv)
      const r = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '' })
      if (argv[1] === 'agents') return r(JSON.stringify([{ pid: 11, cwd: ws('claude-alpha'), kind: 'interactive', startedAt: 1, sessionId: 's-1', status: 'idle' }]))
      if (argv[0] === 'tmux') return r('claude-alpha\t10\n')
      return r('11 10\n10 1\n')
    }
    const hh = join(root, 'roamer-home')
    put(join(hh, '.claude', 'channels', 'roamer-registry.json'), { a: { session_id: 's-1', claude_pid: 11, daemon_pid: 10, protocol: 'telegram' } })
    const host = new Host(cfgFor(on.base, [], { finder: { run }, home: hh }), { now: () => NOW, log: () => {} })
    try {
      await host.tick()
      expect(calls.length).toBeGreaterThanOrEqual(3)
      expect(calls.every(isReadOnlyListing)).toBe(true)
      const list = on.seen.find(x => x.path.endsWith('/collections/sessions'))!
      expect(list.body.records[0].attributes).toMatchObject({ tmux: 'claude-alpha', client: 'telegram' })   // the roamer's claim, pids from ps
    } finally { on.server.stop(true) }
  })
})

describe('config and the program', () => {
  test('configFromEnv', () => {
    expect(() => configFromEnv({ HOME: home })).toThrow('CLAUDE_CODE_HOST_MACHINE')
    expect(() => configFromEnv({ HOME: home, CLAUDE_CODE_HOST_MACHINE: 'Mac Mini' })).toThrow()
    const c = configFromEnv({ HOME: home, CLAUDE_CODE_HOST_MACHINE: 'macmini', CLAUDE_CODE_HOST_TMUX_SOCKET: '/tmp/s', CLAUDE_CODE_HOST_DAEMON_PORTS: '1, 2,x' })
    expect(c.name).toBe('claude-code-host-macmini')
    expect(c.base).toBe('https://core.kbro.ai/api/onsen/v1')
    expect(c.credentialFile).toBe(join(home, '.config', 'mesh', 'claude-code-host-macmini.credential'))
    expect(c.finder).toEqual({ claudeBin: 'claude', tmuxArgs: ['-S', '/tmp/s'] })
    expect(c.extraPorts).toEqual([1, 2])
    expect([c.scanMs, c.reportMs]).toEqual([5000, 15000])
    expect(configFromEnv({ HOME: home, CLAUDE_CODE_HOST_MACHINE: 'mbp', ONSEN_BASE: 'http://x/api/onsen/' }).base).toBe('http://x/api/onsen/v1')
  })

  test('--once prints what it would send and writes nothing (a fake claude; tmux pointed at a socket that does not exist)', async () => {
    const on = fakeOnsen()
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\n[ "$1" = agents ] && echo '[{"pid":${process.pid},"cwd":"${ws('claude-alpha')}","kind":"interactive","startedAt":${NOW},"sessionId":"s-once","status":"idle"}]'\n`)
    chmodSync(join(bin, 'claude'), 0o755)
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_CODE_HOST_MACHINE: 'testbox', CLAUDE_BIN: join(bin, 'claude'),
      CLAUDE_CODE_HOST_TMUX_SOCKET: join(root, 'no-such-dir', 'sock'), ONSEN_BASE: on.base.replace(/\/v1$/, ''), CLAUDE_CODE_HOST_PLATFORM: 'linux' }
    try {
      const p = Bun.spawn([process.execPath, join(import.meta.dir, 'claude-code-host.ts'), '--once'], { env, stdout: 'pipe', stderr: 'pipe' })
      const out = await new Response(p.stdout).text()
      expect(await p.exited).toBe(0)
      const j = JSON.parse(out)
      expect(j.extension).toBe('claude-code-host-testbox')
      expect(j.list.records.map((r: any) => [r.id, r.member, r.title, r.attributes.tmux])).toEqual([['s-once', 'alpha', 'Alpha 名', null]])
      expect(on.seen.filter(x => x.method === 'PUT')).toEqual([])
      const w = Bun.spawn([process.execPath, join(import.meta.dir, 'claude-code-host.ts'), '--whoami'], { env, stdout: 'pipe', stderr: 'pipe' })
      expect((await new Response(w.stdout).text()).trim()).toBe('claude-code-host-testbox (system)')
      expect(await w.exited).toBe(0)
    } finally { on.server.stop(true) }
  })
})
