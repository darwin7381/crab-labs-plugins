import { afterEach, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fakeItems } from './test-fixtures/onsen-items.ts'
import { startBotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { freePort } from './test-fixtures/tg-daemon.ts'

const clean: Array<() => Promise<void> | void> = []
afterEach(async () => { while (clean.length) await clean.pop()!() })
async function waitFor(ok: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms
  while (!await ok() && Date.now() < end) await Bun.sleep(15)
  expect(await ok()).toBe(true)
}
async function daemon(env: Record<string, string> = {}, initialMode = 200, setup?: (root: string) => Record<string, string>) {
  const f = fakeItems(), root = mkdtempSync(join(tmpdir(), 'take-daemon-')), state = join(root, 'tg'), lanes = join(root, '.lanes')
  clean.push(() => { f.stop(); rmSync(root, { recursive: true, force: true }) })
  f.mode(initialMode)
  for (const dir of [state, lanes, join(root, 'home')]) mkdirSync(dir)
  writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['1'], groups: {}, pending: {}, ackReaction: '' }))
  copyFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), join(lanes, 'router.json'))
  const port = await freePort()
  const settings = setup?.(root)
  const childEnv: Record<string, string | undefined> = {
    PATH: process.env.PATH, TMPDIR: root, HOME: join(root, 'home'), TELEGRAM_HTTP_PORT: String(port), TELEGRAM_STATE_DIR: state,
    AGENT_WORKSPACE_DIR: root, GENESIS_LANES: '1', LANES_AGENT: 'adam', ONSEN_HOST: 'Mac-Mini', ONSEN_TAKE: '*',
    ONSEN_OBSERVATION: 'adam', ONSEN_BASE: f.base, ONSEN_REGISTRY_CLI: '0', JEV_SCREEN: '', CRAB_LABS_PLUGINS_ENV: join(root, 'no-config'),
    USAGE_WALL_READ: '0', HUB_SYNC: '0', TYPESAFE_KEY_FILE: join(root, 'no-key'), LANES_CLAUDE_BIN: join(import.meta.dir, 'test-fixtures/no-claude.sh'),
    ...env, ...settings,
  }
  if (!childEnv.ONSEN_TAKE) delete childEnv.ONSEN_TAKE
  const spawn = () => Bun.spawn([process.execPath, '--no-env-file', '--preload', join(import.meta.dir, 'test-fixtures', 'item-daemon.ts'), join(import.meta.dir, 'server.ts')], {
    cwd: import.meta.dir, stdout: 'ignore', stderr: 'pipe', env: childEnv,
  })
  let proc = spawn()
  clean.push(async () => { if (proc.exitCode === null) proc.kill(); await proc.exited })
  const base = 'http://127.0.0.1:' + port
  const log = () => existsSync(join(state, 'server.log')) ? readFileSync(join(state, 'server.log'), 'utf8') : ''
  const ready = () => waitFor(async () => {
    if (proc.exitCode !== null) throw new Error('fixture daemon exited ' + proc.exitCode + ': ' + (await new Response(proc.stderr).text()).slice(-1500))
    return (await fetch(base + '/healthz').catch(() => null))?.ok ?? false
  })
  await ready()
  const restart = async () => { proc.kill('SIGKILL'); await proc.exited; proc = spawn(); await ready() }
  const journal = () => {
    const file = join(state, 'lanes', 'state.jsonl')
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  }
  return { f, root, lanes, state, proc, base, journal, log, restart }
}

for (const [name, cfg, reason] of [
  ['unset', { ONSEN_TAKE: '' }, ''], ['observation off', { ONSEN_OBSERVATION: '' }, 'ONSEN_OBSERVATION'],
  ['lanes off', { GENESIS_LANES: '0' }, 'LANES_ON'], ['recording off', { ONSEN_RECORD: '0' }, 'recording'],
  ['inbox-only', { CHANNEL_INBOX_ONLY: '1' }, 'INBOX_ONLY'],
] as const) test('real daemon startup: ' + name, async () => {
  const d = await daemon(cfg)
  await Bun.sleep(100)
  expect(d.f.calls.filter(c => c.path.endsWith('/items'))).toHaveLength(0)
  const log = d.log().split('\n').filter(s => s.includes('onsen take:'))
  expect(log).toHaveLength(reason ? 1 : 0)
  if (reason) expect(log[0]).toContain(reason)
})

test('daemon probes only once on an old server and keeps observation on the legacy shape', async () => {
  const d = await daemon({}, 400)
  await waitFor(() => d.f.calls.some(c => c.path.endsWith('/observation')))
  expect(d.f.calls.filter(c => c.path.endsWith('/items'))).toHaveLength(1)
  expect(d.f.calls.find(c => c.path.endsWith('/observation'))!.body.connector).toBeUndefined()
  expect(d.log().split('\n').filter(l => l.includes('mode probe did not return 200'))).toHaveLength(1)
})

test('real daemon routes one unclaimed notification per album at count or 1.5 s and replaces a newer waiting edit', async () => {
  const d = await daemon()
  const add = (id: string, group: string, count?: number) => {
    const row = d.f.add(id)
    Object.assign(row.payload, { media_group_id: group, kind: 'document', attachments: [{ kind: 'document', name: id + '.pdf', client_ref: id, mime: 'application/pdf' }] })
    row.payload.client.meta = { ...(count ? { media_group_count: String(count) } : {}) }
    return row
  }
  const records = (group: string) => d.journal().filter(l => l.rec === 'msg' && l.notif?.params?.meta?.media_group_id === group)
  add('a', 'album', 3); add('b', 'album', 3)
  await Bun.sleep(120); expect(records('album')).toHaveLength(0)
  add('c', 'album', 3)
  await waitFor(() => records('album').length > 0)
  expect(records('album')).toHaveLength(1); expect(records('album')[0].onsen_items.map((r: any) => r.onsen_item_id)).toEqual(['a', 'b', 'c'])
  add('x', 'window'); await Bun.sleep(300); add('y', 'window')
  await Bun.sleep(1050); expect(records('window')).toHaveLength(0)
  await waitFor(() => records('window').length > 0)
  expect(records('window')[0].onsen_items).toHaveLength(2)
  const msg = d.f.add('editable')
  await waitFor(() => d.journal().some(l => l.onsen_items?.[0]?.onsen_item_id === msg.id))
  msg.payload.text = 'new content'; d.f.change(msg, 'edited')
  await waitFor(() => d.journal().some(l => l.edited_in_queue && l.notif.params.content === 'new content'))
  expect(d.f.calls.filter(c => c.path.endsWith('/take'))).toHaveLength(0)
}, 10000)

test('daemon handles a control at dispatch and immediately completes a re-served done id', async () => {
  const d = await daemon({ C1_COMMAND_FAILURE: '1' })
  const cmd = d.f.add('help', 'control', { message_id: 'm-help', payload: { message_id: 'm-help', conversation_id: 'conv', from: 'joey',
    text: '/help', kind: 'command', client: { chat: '1', msg_id: '45', user: 'joey', user_id: '1' } } })
  await waitFor(() => cmd.state === 'completed')
  const replies = () => d.f.calls.filter(c => c.path === '/v1/messages').length
  const n = replies(); expect(n).toBe(1)
  cmd.state = 'waiting'; cmd.claim = null; d.f.change(cmd, 'restored')
  await waitFor(() => d.f.history.filter(l => l.item_id === cmd.id && l.body.outcome === 'completed').length === 2)
  expect(replies()).toBe(n)
  const failed = command(d, 'failed-command', '/lanes', '49')
  await waitFor(() => failed.reason === 'not_applied')
  expect(d.f.history.filter(l => l.item_id === failed.id)).toHaveLength(1)
  const action = d.f.add('gone-menu', 'control', { action_id: 'a1', payload: { action_id: 'a1', option_id: '1', version: 1 } })
  await waitFor(() => action.reason === 'not_applied')
  expect(d.journal().filter(l => l.onsen_items)).toHaveLength(0)
})

test('take uses the existing 30 s menu-owner heartbeat and removes only its own file on exit', async () => {
  const d = await daemon({ CHANNEL_BOT_TMUX_SESSION: 'wo213-test-pane' })
  const file = join(d.root, 'home', '.claude/lanes/menu-owner/wo213-test-pane.json')
  await waitFor(() => existsSync(file) && d.f.calls.some(c => c.query.has('wait')))
  const first = JSON.parse(readFileSync(file, 'utf8'))
  expect(first.pid).toBe(d.proc.pid)
  await waitFor(() => JSON.parse(readFileSync(file, 'utf8')).at !== first.at, 33000)
  expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(first.pid)
  expect(existsSync(join(d.lanes, 'onsen-take.json'))).toBe(false)
  d.proc.kill('SIGTERM'); await d.proc.exited
  expect(existsSync(file)).toBe(false)
}, 40000)

function scriptedLane(root: string) {
  const bin = join(root, 'fixture-lane')
  const entry = join(import.meta.dir, 'test-fixtures', 'item-lane.ts')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" --no-env-file "${entry}" "$@"\n`)
  chmodSync(bin, 0o700)
  return { LANES_CLAUDE_BIN: bin }
}

test('a busy lane slot leaves the next alert waiting; its run receives the claim and hands back the note to M1', async () => {
  const d = await daemon({ LANES_MAX: '1' }, 200, scriptedLane)
  const add = (id: string) => d.f.add(id, 'alert', { from: 'alert-dispatcher', payload: { text: '[P2] ' + id, line: 'call' } })
  const one = add('first'), records = () => d.journal()
  await waitFor(() => d.f.history.some(h => h.item_id === one.id && h.body.outcome === 'in_session'))
  const two = add('second explicit handover')
  await waitFor(() => records().some(r => r.ev?.onsen_items?.some((i: any) => i.onsen_item_id === two.id)))
  expect(two.state).toBe('waiting')
  expect(d.f.calls.filter(c => c.path.endsWith('/take')).map(c => c.body.item_ids)).toEqual([['first']])
  await waitFor(() => d.f.calls.some(c => c.path.endsWith('/observation') && c.body.held_item_ids?.includes(one.id)))
  writeFileSync(join(d.root, 'release-lane'), '')
  await waitFor(() => d.f.history.some(h => h.item_id === two.id && h.body.outcome === 'in_session'))
  expect(d.f.history.find(h => h.item_id === two.id)!.body.session_id).toMatch(/^adam\.reflex\./)
  await waitFor(() => two.state !== 'claimed')
  expect(d.f.history.filter(h => h.item_id === one.id).map(h => h.body.outcome)).toEqual(['in_session', 'completed'])
  const hand = d.f.history.find(h => h.item_id === two.id && h.body.outcome === 'reassigned')
  expect(hand?.body.note).toBeTruthy()
  await waitFor(() => records().some(r => r.rec === 'msg' && r.onsen_items?.some((i: any) => i.onsen_item_id === two.id)))
  const main = records().find(r => r.rec === 'msg' && r.onsen_items?.some((i: any) => i.onsen_item_id === two.id))
  expect(main.notif.params.content).toContain(hand!.body.note)
  expect(records().some(r => r.rec === 'msg' && (r.kind === 'handoff' || r.kind === 'carry'))).toBe(false)
}, 18000)

test('roamer stays on its local mock bot and never probes items', async () => {
  const bot = startBotApiMock()
  clean.push(() => bot.stop())
  const d = await daemon({ ROAMER_MODE: '1', TELEGRAM_BOT_TOKEN: bot.token, TELEGRAM_API_ROOT: bot.url })
  await waitFor(() => d.log().includes('staying on pull: ROAMER'))
  expect(d.f.calls.filter(c => c.path.endsWith('/items'))).toHaveLength(0)
})

function command(d: Awaited<ReturnType<typeof daemon>>, id: string, text: string, tgId: string) {
  return d.f.add(id, 'control', { message_id: 'm-' + id, payload: { message_id: 'm-' + id, from: 'joey', conversation_id: 'conv',
    kind: 'command', text, client: { chat: '1', msg_id: tgId, user: 'joey', user_id: '1' } } })
}

test('closing a queued mail lane releases the same waiting version to the next peek without a claim or handoff', async () => {
  const d = await daemon({ LANES_MAX: '1' }, 200, scriptedLane)
  const busy = d.f.add('busy', 'alert', { from: 'alert-dispatcher', payload: { text: '[P2] occupy slot', line: 'call' } })
  await waitFor(() => d.f.history.some(h => h.item_id === busy.id && h.body.outcome === 'in_session'))
  const mail = d.f.add('waiting-mail', 'mail', { from: 'eve', payload: { text: 'read the mail', line: 'mail', no_reply: true } })
  const version = mail.version
  const routes = () => d.journal().filter(r => r.rec === 'run' && r.state === 'queued' && r.ev?.onsen_items?.[0]?.onsen_item_id === mail.id)
  await waitFor(() => routes().length > 0)
  const old = routes()[0]
  const before = d.f.calls.length
  command(d, 'close-mail', '/lanes close ' + old.lane, '82')
  await waitFor(() => routes().some(r => r.lane !== old.lane))
  const next = routes().find(r => r.lane !== old.lane)
  expect(d.f.calls.slice(before).some(c => c.query.has('wait') && !c.query.has('changed_after'))).toBe(true)
  expect([mail.state, mail.version]).toEqual(['waiting', version])
  expect(d.f.history.filter(h => h.item_id === mail.id)).toHaveLength(0)
  expect(d.f.calls.filter(c => c.path.endsWith('/take') && c.body.item_ids.includes(mail.id))).toHaveLength(0)
  expect(next.ev.id).not.toBe(old.ev.id)
  expect(d.journal().some(r => r.rec === 'msg' && r.onsen_items?.some((i: any) => i.onsen_item_id === mail.id))).toBe(false)
  writeFileSync(join(d.root, 'release-lane'), '')
  await waitFor(() => mail.state === 'completed')
  const reports = d.f.history.filter(h => h.item_id === mail.id)
  expect(reports.map(h => h.body.outcome)).toEqual(['in_session', 'completed'])
  expect(reports[0]!.body.session_id).toBe(next.lane)
}, 14000)

test('closing between take and lane start reports one reassignment with no in_session', async () => {
  const d = await daemon({}, 200, scriptedLane)
  d.f.delayTake(1400)
  const mail = d.f.add('taken-mail', 'mail', { from: 'eve', payload: { text: 'mail', line: 'mail', no_reply: true } })
  await waitFor(() => mail.state === 'claimed')
  const route = d.journal().find(r => r.rec === 'run' && r.ev?.onsen_items?.[0]?.onsen_item_id === mail.id)
  d.f.delayTake(0)
  command(d, 'close-taken', '/lanes close ' + route.lane, '83')
  await waitFor(() => d.journal().some(r => r.rec === 'msg' && r.onsen_items?.[0]?.onsen_item_id === mail.id))
  const reports = d.f.history.filter(h => h.item_id === mail.id)
  expect(reports.map(h => h.body.outcome)).toEqual(['reassigned'])
  expect(reports[0]!.body.note).toContain(route.lane)
})

test('closing after in_session lets a lane that finishes its work report completed', async () => {
  const d = await daemon({}, 200, scriptedLane)
  const mail = d.f.add('bound-mail', 'mail', { from: 'eve', payload: { text: 'mail', line: 'mail', no_reply: true } })
  const reports = () => d.f.history.filter(h => h.item_id === mail.id)
  await waitFor(() => reports().some(h => h.body.outcome === 'in_session'))
  const close = command(d, 'close-bound', '/lanes close ' + reports()[0]!.body.session_id, '84')
  await waitFor(() => close.state === 'completed')
  writeFileSync(join(d.root, 'release-lane'), '')
  await waitFor(() => mail.state !== 'claimed')
  expect(reports().map(h => h.body.outcome)).toEqual(['in_session', 'completed'])
})

test('SIGKILL and restart restores the held id on the first observation and drains the terminal report before peeking', async () => {
  const d = await daemon()
  d.f.holdReports(true)
  const row = command(d, 'cmd-crash', '/help', '80')
  const obs = () => d.f.calls.filter(c => c.path.endsWith('/observation'))
  await waitFor(() => obs().some(c => c.body.held_item_ids?.includes(row.id)))
  await waitFor(() => d.f.calls.some(c => c.path.endsWith('/report')))
  const before = d.f.calls.length
  await d.restart()
  await waitFor(() => d.f.calls.slice(before).some(c => c.path.endsWith('/observation')))
  const first = d.f.calls.slice(before).find(c => c.path.endsWith('/observation'))!
  expect(first.body.connector).toBe('mac-mini/adam'); expect(first.body.held_item_ids).toEqual([row.id])
  expect(d.f.calls.slice(before).some(c => c.query.has('wait') || c.path.endsWith('/take'))).toBe(false)
  d.f.holdReports(false)
  await waitFor(() => row.state === 'completed', 8000)
  await waitFor(() => obs().at(-1)?.body.held_item_ids?.length === 0)
  expect(d.f.history.filter(h => h.item_id === row.id)).toHaveLength(1)
  expect(d.f.calls.filter(c => c.path === '/v1/messages')).toHaveLength(1)
}, 18000)

test('a real peer hold leaves no M1 or lane reference; release starts a full peek', async () => {
  const d = await daemon({}, 200, root => {
    const path = join(root, 'peers.json')
    writeFileSync(path, JSON.stringify({ eve: {} }))
    return { AGENT_INBOX_REGISTRY: path }
  })
  const hold = command(d, 'hold', '/lanes hold eve', '90')
  await waitFor(() => hold.state === 'completed')
  const row = d.f.add('held-peer', 'call', { from: 'eve', payload: { text: 'original peer request', line: 'call' } })
  await waitFor(() => d.log().includes('peer-hold'))
  expect(row.state).toBe('waiting')
  expect(d.journal().some(r => (r.rec === 'msg' || r.rec === 'run') && (r.onsen_items || r.ev?.onsen_items))).toBe(false)
  const since = d.f.calls.length
  const release = command(d, 'release', '/lanes release eve', '91')
  await waitFor(() => release.state === 'completed')
  await waitFor(() => d.f.history.some(h => h.item_id === row.id && h.body.outcome === 'in_session'), 9000)
  expect(d.f.calls.slice(since).some(c => c.query.has('wait') && !c.query.has('changed_after'))).toBe(true)
}, 12000)

for (const [reason, outcome, code] of [
  ['cap_turns', 'cut', 0], ['cap_usd', 'cut', 0], ['died', 'cut', 1], ['timeout', 'cut', 0], ['budget', 'cut', 0],
  ['wall:rate_limit', 'usage_limit', 429], ['wall:authentication_failed', 'usage_limit', 401],
  ['wall:server_error', 'error', 503], ['wall:api_error', 'error', 400],
] as const) test('lane exit ' + reason + ' spools ' + outcome, async () => {
  const d = await daemon({}, 200, root => {
    const bin = join(root, 'lane-outcome')
    let script = 'exit 1'
    if (reason.startsWith('wall:') || reason.startsWith('cap_')) {
      const terminal_reason = reason.startsWith('wall:') ? 'api_error' : reason === 'cap_usd' ? 'max_budget_usd' : 'max_turns'
      writeFileSync(join(root, 'result.json'), JSON.stringify({ type: 'result', is_error: true, terminal_reason, api_error_status: code }) + '\n')
      script = 'cat ./result.json'
    }
    if (reason === 'timeout') script = 'exec sleep 2'
    if (reason === 'budget') script = 'echo \'{"type":"assistant","message":{"id":"test","content":[],"usage":{"input_tokens":1000}}}\'\nexec sleep 2'
    writeFileSync(bin, '#!/bin/sh\n' + script + '\n')
    chmodSync(bin, 0o700)
    return { LANES_CLAUDE_BIN: bin, LANES_THREAD_BUDGET: '500', LANES_MAX_RUN_MS: reason === 'timeout' ? '100' : '5000' }
  })
  const row = d.f.add('run', 'alert', { from: 'alert-dispatcher', payload: { text: '[P2] outcome test', line: 'call' } })
  await waitFor(() => d.f.history.some(h => h.item_id === row.id && h.body.outcome === outcome))
  expect(d.f.history.filter(h => h.item_id === row.id).slice(0,2).map(h => h.body.outcome)).toEqual(['in_session', outcome])
  expect(d.journal().some(r => r.rec === 'run' && r.state === 'exited' && r.reason === reason)).toBe(true)
})

for (const code of [404, 409, 0]) test('daemon stays on pull after probe ' + (code || 'network error'), async () => {
  const cfg: Record<string, string> = {}
  if (!code) cfg.ONSEN_BASE = 'http://127.0.0.1:' + await freePort()
  const d = await daemon(cfg, code || 200)
  await waitFor(() => d.log().includes('mode probe did not return 200'))
  expect(d.log().split('\n').filter(s => s.includes('mode probe did not return 200'))).toHaveLength(1)
  expect(d.f.calls.filter(c => c.query.has('wait') || c.path.endsWith('/take'))).toHaveLength(0)
  expect(d.f.calls.filter(c => c.path.endsWith('/items'))).toHaveLength(code ? 1 : 0)
})

test('the mail lane takes its two coalesced events together and completes both', async () => {
  const d = await daemon({ LANES_MAX: '1' }, 200, scriptedLane)
  const first = d.f.add('occupy', 'alert', { from: 'alert-dispatcher', payload: { text: '[P2] occupy slot', line: 'call' } })
  await waitFor(() => d.f.history.some(l => l.item_id === first.id && l.body.outcome === 'in_session'))
  const rows = ['alpha','beta'].map(id => d.f.add(id, 'mail', { from: 'eve', payload: { text: id, line: 'mail', no_reply: true } }))
  await waitFor(() => rows.every(r => d.journal().some(j => j.rec === 'run' && j.ev?.onsen_items?.some((i: any) => i.onsen_item_id === r.id))))
  expect(rows.every(r => r.state === 'waiting')).toBe(true)
  writeFileSync(join(d.root, 'release-lane'), '')
  await waitFor(() => rows.every(r => r.state === 'completed'), 10000)
  const takes = d.f.calls.filter(c => c.path.endsWith('/take') && c.body.item_ids.includes('alpha'))
  expect(takes.map(c => c.body.item_ids)).toEqual([['alpha','beta']])
  for (const r of rows) expect(d.f.history.filter(h => h.item_id === r.id).map(h => h.body.outcome)).toEqual(['in_session','completed'])
}, 15000)
