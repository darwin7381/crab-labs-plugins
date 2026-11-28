import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { fakeItems } from './test-fixtures/onsen-items.ts'
import { startBotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { freePort, until } from './test-fixtures/tg-daemon.ts'

const clean: Array<() => Promise<void> | void> = []
afterEach(async () => {
  const errors = []
  while (clean.length) {
    try { await clean.pop()!() } catch (e) { errors.push(e) }
  }
  if (errors.length) throw new AggregateError(errors, 'daemon fixture cleanup failed')
})
async function stopDaemonGroup(child: Bun.Subprocess) {
  // Each daemon is its own POSIX process group, including its lane processes and their hooks.
  const signal = (sig: NodeJS.Signals | 0) => {
    try { process.kill(-child.pid, sig); return true } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return false
      if (sig === 0 && code === 'EPERM') return true // the group still exists; poll until it disappears
      throw e
    }
  }
  const exited = child.exited
  signal('SIGTERM')
  const empty = () => !signal(0)
  if (!await until(empty, 1000)) {
    signal('SIGKILL')
    if (!await until(empty, 3000)) throw new Error('fixture process group still alive: ' + child.pid)
  }
  await exited
}
async function waitFor(ok: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms
  while (!await ok() && Date.now() < end) await Bun.sleep(15)
  expect(await ok()).toBe(true)
}
async function daemon(env: Record<string, string> = {}, initialMode = 200, setup?: (root: string) => Record<string, string>) {
  const f = fakeItems(), root = mkdtempSync(join(tmpdir(), 'take-daemon-')), state = join(root, 'tg'), lanes = join(root, '.lanes')
  clean.push(async () => { try { await f.stop() } finally { rmSync(root, { recursive: true, force: true }) } })
  f.mode(initialMode)
  for (const dir of [state, lanes, join(root, 'home')]) mkdirSync(dir)
  writeFileSync(join(root, 'no-config'), '')
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
  const journal = () => {
    const file = join(state, 'lanes', 'state.jsonl')
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  }
  const spawn = () => {
    const child = Bun.spawn([process.execPath, '--no-env-file', '--preload', join(import.meta.dir, 'test-fixtures', 'item-daemon.ts'), join(import.meta.dir, 'server.ts')], {
      cwd: import.meta.dir, stdout: 'ignore', stderr: 'pipe', env: childEnv, detached: true,
    })
    clean.push(async () => {
      try {
        if (child.exitCode === null && existsSync(join(root, 'fixture-lane'))) {
          writeFileSync(join(root, 'release-lane'), '')
          await until(() => {
            const runs = new Map(journal().filter(r => r.rec === 'run').map(r => [r.id, r.state]))
            return ![...runs.values()].some(s => s === 'running' || s === 'leased')
          }, 1000)
        }
      } finally { await stopDaemonGroup(child) }
    })
    return child
  }
  let proc = spawn()
  const base = 'http://127.0.0.1:' + port
  const log = () => existsSync(join(state, 'server.log')) ? readFileSync(join(state, 'server.log'), 'utf8') : ''
  const ready = () => waitFor(async () => {
    if (proc.exitCode !== null) throw new Error('fixture daemon exited ' + proc.exitCode + ': ' + (await new Response(proc.stderr).text()).slice(-1500))
    const health = await fetch(base + '/healthz').then(r => r.ok ? r.json() : null).catch(() => null)
    return health?.pid === proc.pid
  })
  await ready()
  const restart = async () => { proc.kill('SIGKILL'); await proc.exited; proc = spawn(); await ready() }
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

test('C4 routes only the member’s own resumes to M1 across all session targets', async () => {
  const d = await daemon()
  await waitFor(() => d.f.calls.some(c => c.query.has('wait')))
  const add = (id: string, from: string, session_id: string | null) =>
    d.f.add(id, 'resume', { from, session_id, payload: { text: id }, created_at: new Date(d.f.now()).toISOString() })
  add('foreign-resume', 'eve', 'main')
  add('worker-target', 'adam', 'adam.worker.7')
  add('unknown-target', 'adam', null)
  add('main-target', 'adam', 'main')
  const native = () => new Set(d.journal().filter(r => r.rec === 'msg' && r.kind === 'carry' && r.notif?.params.meta.user === 'lanes')
    .map(r => r.onsen_items?.[0]?.onsen_item_id))
  await waitFor(() => native().has('main-target'))
  expect([...native()].sort()).toEqual(['main-target', 'unknown-target', 'worker-target'])
  expect(d.f.calls.some(c => c.path === '/v1/items/main-target')).toBe(false)
  expect(d.f.calls.some(c => c.path.endsWith('/take'))).toBe(false)
})

test('member-authored Items read their body only from payload.text', async () => {
  const d = await daemon()
  await waitFor(() => d.f.calls.some(c => c.query.has('wait')))
  d.f.add('flat-resume', 'resume', { from: 'adam', payload: { format: 'markdown', text: '正本內文', body: { text: '巢狀副本' } } })
  d.f.add('nested-self', 'self', { from: 'adam', payload: { body: { text: '巢狀副本' } } })
  const delivery = (id: string) => d.journal().find(r => r.rec === 'msg' && r.onsen_items?.[0]?.onsen_item_id === id && r.notif)
  await waitFor(() => !!delivery('flat-resume') && !!delivery('nested-self'))
  expect(delivery('flat-resume').notif.params.content).toBe('正本內文')
  expect(delivery('nested-self').notif.params.content).not.toContain('巢狀副本')
})

test('C4 main hooks create a waiting resume; an independent turn after fixture restart cancels it without a take', async () => {
  const session_id = randomUUID()
  const d = await daemon({}, 200, root => {
    writeFileSync(join(root, '.lanes', 'main-expected'), session_id)
    return {}
  })
  const hook = async (event: string, prompt_id: string, extra = {}) => {
    const res = await fetch(d.base + '/lanes/main-event', { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: 'Bearer test-loopback' },
      body: JSON.stringify({ event, prompt_id, pid: process.pid, session_id, ...extra }) })
    expect(res.status).toBe(200)
  }
  await waitFor(() => d.f.calls.some(c => c.query.has('wait')))
  await hook('SessionStart', '', { source: 'startup' })
  await hook('UserPromptSubmit', 'typing', { dids: [] })
  await hook('StopFailure', 'typing', { error: 'rate_limit' })
  await waitFor(() => d.f.rows.size === 1)
  const row = [...d.f.rows.values()][0]!
  await waitFor(() => d.journal().some(l => l.rec === 'msg' && l.onsen_items?.[0]?.onsen_item_id === row.id))
  expect(row).toMatchObject({ state: 'waiting', kind: 'resume', not_before: null, session_id: 'main' })
  expect(d.journal().find(l => l.onsen_items)?.notif.params.content).toBe(row.payload.text)
  const probes = () => d.f.calls.filter(c => c.query.has('connector') && c.query.get('limit') === '1').length
  const first = probes()
  await d.restart()
  await waitFor(() => probes() > first && d.log().includes('onsen take: started'))
  await hook('PreToolUse', 'typing', { tool_name: 'Read' })
  await waitFor(() => row.reason === 'superseded')
  expect(row.state).toBe('cancelled')
  expect(d.f.calls.filter(c => c.body.kind === 'resume')).toHaveLength(1)
  expect(d.f.calls.filter(c => c.path.endsWith('/take'))).toHaveLength(0)
  expect(d.f.history).toHaveLength(0)
}, 15_000)

test('settled 59 in the daemon: only the background turn that receives a carrier withdraws the resume', async () => {
  const session_id = randomUUID()
  const d = await daemon({ ONSEN_PEER_LOOKUP: '0' }, 200, root => {
    writeFileSync(join(root, '.lanes', 'main-expected'), session_id)
    const sessions = join(root, 'home', '.claude', 'sessions')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: session_id,
      cwd: root, startedAt: Date.now(), procStart: '', kind: 'interactive', name: 'adam', status: 'idle', statusUpdatedAt: Date.now() }))
    return { ONSEN_SESSIONS_DIR: sessions }
  })
  const hook = async (event: string, prompt_id: string, extra = {}) => {
    const r = await fetch(d.base + '/lanes/main-event', { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: 'Bearer test-loopback' },
      body: JSON.stringify({ event, prompt_id, pid: process.pid, session_id, ...extra }) })
    expect(r.status).toBe(200)
    return r.json()
  }
  await waitFor(() => d.f.calls.some(c => c.query.has('wait')))
  await hook('SessionStart', '', { source: 'startup' })
  await hook('UserPromptSubmit', 'broken', { dids: [] })
  await hook('StopFailure', 'broken', { error: 'overloaded' })
  await waitFor(() => d.f.rows.size === 1)
  const resume = [...d.f.rows.values()][0]!
  await hook('UserPromptSubmit', 'untold', { source: 'task-notification', dids: [] })
  await hook('Stop', 'untold', { phase: 'final' })
  await d.restart()
  await waitFor(() => d.log().includes('onsen take: started') && d.f.calls.filter(c => c.query.get('limit') === '1').length >= 2)
  expect(resume.state).toBe('waiting')
  await hook('UserPromptSubmit', 'told', { source: 'task-notification', dids: [] })
  const session = new Client({ name: 'resume-main', version: '1' }, { capabilities: {} })
  clean.push(() => session.close())
  await session.connect(new StreamableHTTPClientTransport(new URL(d.base + '/mcp')))
  const carrier = d.f.add('deliver-with-line')
  await waitFor(() => d.journal().some(l => l.rec === 'msg' && l.onsen_items?.[0]?.onsen_item_id === carrier.id))
  const reply = await hook('PostToolUse', 'told', { tool_name: 'Read' })
  expect(reply.additionalContext).toContain(resume.payload.text)
  expect(resume.state).toBe('waiting')
  await hook('Stop', 'told', { phase: 'final' })
  await waitFor(() => resume.state === 'cancelled')
  expect(resume.reason).toBe('withdrawn')
  expect(d.f.calls.filter(c => c.body.outcome === 'withdrawn')).toHaveLength(1)
  expect(d.f.calls.some(c => c.path.endsWith('/take') && c.body.item_ids?.includes(resume.id))).toBe(false)
}, 15000)

const worker = 'adam.worker.1'
test('C5 bench: the main reply tool writes one timed promise for the test account and a report at minute five produces no waiter notice', async () => {
  const jev = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ answers: { promises: { type: 'noul', noul: 0.99 } } }) })
  clean.push(async () => { await jev.stop(true) })
  const chat = '6736970916', said = '10 分鐘後回報'
  const d = await daemon({ TYPESAFE_API_KEY: 'test', TYPESAFE_BASE_URL: 'http://127.0.0.1:' + jev.port }, 200, root => {
    writeFileSync(join(root, 'tg', 'access.json'), JSON.stringify({ allowFrom: [chat], groups: {}, pending: {} }))
    return {}
  })
  await waitFor(() => d.log().includes('onsen take: started'))
  const client = new Client({ name: 'c5-test-main', version: '1' }, { capabilities: {} })
  clean.push(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(d.base + '/mcp')))
  const at = Date.now()
  const r = await client.callTool({ name: 'reply', arguments: { chat_id: chat, text: said } })
  expect(r.isError).not.toBe(true)
  expect(d.f.calls.filter(c => c.path === '/v1/messages' && c.body.body === said)).toHaveLength(1)
  await waitFor(() => [...d.f.rows.values()].some(r => r.kind === 'self'))
  const promises = [...d.f.rows.values()].filter(r => r.kind === 'self')
  expect(promises).toHaveLength(1)
  const row = promises[0]!
  expect(row).toMatchObject({ from: 'adam', waiter: 'joey-test', session_id: 'main', deadline: null, state: 'waiting' })
  const due = Date.parse(row.not_before!)
  expect(due).toBeGreaterThanOrEqual(at + 600_000)
  expect(due).toBeLessThanOrEqual(Date.now() + 600_000)
  d.f.advance(due - d.f.now() - 300_000)
  const report = await client.callTool({ name: 'reply', arguments: { chat_id: chat, text: '已經完成，這是結果。' } })
  expect(report.isError).not.toBe(true)
  d.f.advance(300_001); d.f.advance(60_000)
  const notices = [...d.f.rows.values()].filter(r => r.about_item_id === row.id)
  expect(notices).toHaveLength(0)
})

test('C5 routes self text only from payload.text', async () => {
  const d = await daemon({})
  const fields = { from: 'adam', session_id: 'main' }
  d.f.add('top-level', 'self', { ...fields, payload: { text: 'visible item text', body: { text: 'nested decoy' } } })
  d.f.add('nested-only', 'self', { ...fields, payload: { body: { text: 'nested decoy' } } })
  const deliveries = () => d.journal().filter(r => r.rec === 'msg' && r.onsen_items?.some((i: any) => ['top-level', 'nested-only'].includes(i.onsen_item_id)))
  await waitFor(() => new Set(deliveries().flatMap(r => r.onsen_items.map((i: any) => i.onsen_item_id))).size === 2)
  const contents = JSON.stringify(deliveries().map(r => r.notif))
  expect(contents).toContain('visible item text')
  expect(contents).not.toContain('nested decoy')
})

test('C5 active connector schedules its own keepwarm with the legacy local switch off, including across restart', async () => {
  const at = Date.now() - 120_000, sid = randomUUID(), ts = (ms: number) => new Date(at + ms).toISOString()
  const d = await daemon({}, 200, root => {
    writeFileSync(join(root, '.lanes', 'main-expected'), sid)
    writeFileSync(join(root, sid + '.jsonl'), [
      { type: 'user', timestamp: ts(0), message: { content: '做這件事' } },
      { type: 'api-request', timestamp: ts(1000), querySource: 'repl_main_thread' },
      { type: 'assistant', timestamp: ts(2000), message: { model: 'fixture', usage: { cache_read_input_tokens: 1000 } } },
      { type: 'system', subtype: 'turn_duration', timestamp: ts(3000) },
    ].map(entry => JSON.stringify(entry)).join('\n'))
    return { KEEPWARM_PROJECTS_DIR: root }
  })
  await waitFor(() => [...d.f.rows.values()].some(r => r.kind === 'keepwarm'))
  const [row] = d.f.rows.values()
  expect(row).toMatchObject({ kind: 'keepwarm', from: 'adam', session_id: 'main', not_before: ts(1000 + 50 * 60_000), deadline: null })
  await d.restart()
  await waitFor(() => d.f.calls.filter(c => c.query.get('kind') === 'keepwarm').length >= 2)
  expect(d.f.calls.filter(c => c.body.kind === 'keepwarm')).toHaveLength(1)
  expect(row!.state).toBe('waiting')
})

test('C5 converts a saved followup and delivers its self Item once to the original worker', async () => {
  const thread = 'adam#check', event = 'prior-run', id = 'fu-old', due = Date.now() + 3500
  const d = await daemon({}, 200, root => {
    const last = new Date().toISOString()
    writeFileSync(join(root, '.lanes', 'state.json'), JSON.stringify({
      lanes: { [worker]: { id: worker, kind: 'worker', n: 1, session_id: randomUUID(), thread, status: 'idle',
        created: last, last, transcript: join(root, 'worker.jsonl'), runs: 0, tokens_in: 0, tokens_out: 0 } },
      threads: { [thread]: { id: thread, lane: worker, peer: 'eve', hops: 0, tokens: 0, created: last, last } },
      followups: { [id]: { id, thread, lane: worker, event, from: 'eve', cls: 'peer', trigger: 'peer', run_id: null,
        after_minutes: 10, note: '重查狀態', created: last, due, due_iso: new Date(due).toISOString(), state: 'pending', chain: 1 } },
    }))
    return scriptedLane(root)
  })
  await waitFor(() => [...d.f.rows.values()].some(r => r.kind === 'self'))
  const rows = [...d.f.rows.values()].filter(r => r.kind === 'self')
  expect(rows).toHaveLength(1)
  const row = rows[0]!
  expect(d.f.calls.find(c => c.key === id)!.body).not.toHaveProperty('waiter')
  expect(row.refs).toEqual([])
  await d.restart()
  expect(row).toMatchObject({ session_id: worker, waiter: 'adam', not_before: new Date(due).toISOString(), deadline: null, state: 'waiting' })
  d.f.advance(due - d.f.now() + 1)
  await waitFor(() => d.f.history.some(h => h.item_id === row.id && h.body.outcome === 'in_session'))
  expect(d.journal().filter(r => r.rec === 'run' && r.state === 'queued' && r.ev?.followup === id)).toHaveLength(1)
  writeFileSync(join(d.root, 'release-lane'), '')
  await waitFor(() => row.state === 'completed')
  expect(d.f.history.filter(h => h.item_id === row.id).map(h => h.body.outcome)).toEqual(['in_session', 'completed'])
}, 15000)

async function laneHook(root: string, n: number, event: string) {
  const file = join(root, 'hook-' + n)
  writeFileSync(file, event)
  await waitFor(() => existsSync(file + '.out'))
  return readFileSync(file + '.out', 'utf8').trim()
}
async function runningWorker() {
  const d = await daemon({}, 200, root => {
    const thread = 'adam#worker', last = new Date().toISOString()
    writeFileSync(join(root, '.lanes', 'state.json'), JSON.stringify({
      lanes: { [worker]: { id: worker, kind: 'worker', n: 1, session_id: randomUUID(),
        thread, status: 'idle', created: last, last, transcript: join(root, 'worker.jsonl'), runs: 0, tokens_in: 0, tokens_out: 0, topic: 555 } },
      threads: { [thread]: { id: thread, lane: worker, peer: null, hops: 0, tokens: 0, created: last, last } }, topics: { '555': worker },
    }))
    return scriptedLane(root)
  })
  const person = (id: string, tg: string) => d.f.add(id, 'message', { message_id: id, payload: {
    message_id: id, from: 'joey', conversation_id: 'conv', kind: 'text', thread: 555, text: id,
    client: { name: 'telegram', chat: '1', msg_id: tg, user_id: '1', user: 'Joey', thread: '555' },
  } })
  person('start-worker', '550')
  await waitFor(() => d.f.history.some(h => h.item_id === 'start-worker' && h.body.session_id === worker))
  const row = person('message-during-run', '551')
  const input = join(d.lanes, 'run', 'steer', worker + '.in.jsonl')
  await waitFor(() => existsSync(input) && readFileSync(input, 'utf8').includes(row.id))
  const hook = (n: number, event: string) => laneHook(d.root, n, event)
  const reports = () => d.f.history.filter(h => h.item_id === row.id)
  const takes = () => d.f.calls.filter(c => c.path.endsWith('/take') && c.body.item_ids.includes(row.id))
  return { d, person, row, input, hook, reports, takes }
}

for (const event of ['PostToolUse', 'Stop']) test('the running worker takes a person at its ' + event + ' steer hook', async () => {
  const { d, row, input, hook, reports, takes } = await runningWorker()
  const stub = JSON.parse(readFileSync(input, 'utf8').trim())
  expect(stub).toEqual({ id: 'item-' + row.id + '-v1', run: worker + '.r1', take: true })
  const refused = await fetch(d.base + '/lane-steer', { method: 'POST', body: JSON.stringify({ ids: [stub.id] }) })
  expect(refused.status).toBe(403)
  expect(row.state).toBe('waiting')
  expect(takes()).toHaveLength(0)
  const out = JSON.parse(await hook(1, event))
  expect(event === 'Stop' ? out.reason : out.hookSpecificOutput.additionalContext).toContain(row.id)
  await waitFor(() => reports().some(h => h.body.outcome === 'in_session'))
  expect(reports()[0]!.body.session_id).toBe(worker)
  expect(takes().map(c => c.body.item_ids)).toEqual([[row.id]])
  expect(await hook(2, 'PostToolUse')).toBe('')
  const folded = d.journal().find(r => r.rec === 'run' && r.steered?.some((ev: any) => ev.id === stub.id))
  expect(folded.id).toBe(d.journal().find(r => r.rec === 'run' && r.run === stub.run).id)
  writeFileSync(join(d.root, 'release-lane'), '')
  await waitFor(() => row.state !== 'claimed')
  expect(reports().map(h => h.body.outcome)).toEqual(['in_session', 'completed'])
  expect(d.journal().filter(r => r.rec === 'run' && r.state === 'leased' && r.lane === worker)).toHaveLength(1)
}, 13000)

test('a late lane hook take renders nothing, retries the same key and returns the claim', async () => {
  const { d, row, hook, reports, takes } = await runningWorker()
  d.f.delayTake(4200)
  const start = Date.now()
  expect(await hook(1, 'PostToolUse')).toBe('')
  expect(Date.now() - start).toBeLessThan(3750)
  await waitFor(() => reports().some(h => h.body.outcome === 'not_taken'))
  expect(takes().length).toBeGreaterThanOrEqual(2)
  expect(new Set(takes().map(c => c.key)).size).toBe(1)
  expect(reports().map(h => h.body.outcome)).toEqual(['not_taken'])
  d.f.delayTake(0)
  expect(await hook(2, 'PostToolUse')).toContain(row.id)
  await waitFor(() => reports().some(h => h.body.session_id === worker))
  writeFileSync(join(d.root, 'release-lane'), '')
  await waitFor(() => row.state === 'completed')
}, 14000)

test('one hook takes the available messages together, uses the pending edit and drops a cancelled row', async () => {
  const { d, person, row, input, hook, takes } = await runningWorker()
  const cancelled = person('cancel-before-hook', '552'), other = person('another-message', '553')
  await waitFor(() => readFileSync(input, 'utf8').includes(other.id))
  row.payload.text = 'edited at the tool boundary'
  d.f.change(row, 'edited')
  cancelled.state = 'cancelled'; d.f.change(cancelled, 'cancelled')
  await waitFor(() => readFileSync(join(d.lanes, 'state.json'), 'utf8').includes(row.payload.text))
  const text = JSON.parse(await hook(1, 'PostToolUse')).hookSpecificOutput.additionalContext
  expect(text).toContain(row.payload.text)
  expect(text).toContain(other.id)
  expect(text).not.toContain(cancelled.id)
  expect(takes().map(c => c.body.item_ids)).toEqual([[row.id, cancelled.id, other.id]])
  expect(d.f.calls.filter(c => c.path === '/v1/items/' + cancelled.id)).toHaveLength(1)
  await waitFor(() => [row, other].every(r => d.f.history.some(h => h.item_id === r.id && h.body.session_id === worker)))
  expect(JSON.parse(readFileSync(join(d.lanes, 'state.json'), 'utf8')).steering?.[worker]).toBeUndefined()
  expect(d.f.history.filter(h => h.item_id === cancelled.id)).toHaveLength(0)
  writeFileSync(join(d.root, 'release-lane'), '')
})

test('closing a worker before its hook releases the pending person to M1 without a report', async () => {
  const { d, row, hook, reports, takes } = await runningWorker()
  const version = row.version
  const closed = command(d, 'close-steering', '/lanes close ' + worker, '554')
  await waitFor(() => closed.state === 'completed')
  await waitFor(() => d.journal().some(r => r.rec === 'msg' && r.onsen_items?.[0]?.onsen_item_id === row.id))
  expect(await hook(1, 'PostToolUse')).not.toContain(row.id)
  expect([row.state, row.version]).toEqual(['waiting', version])
  expect(takes()).toHaveLength(0)
  expect(reports()).toHaveLength(0)
  writeFileSync(join(d.root, 'release-lane'), '')
})

test('a worker closing while its hook take is in flight reassigns only the granted row', async () => {
  const { d, row, hook, reports, takes } = await runningWorker()
  d.f.delayTake(1300)
  const result = hook(1, 'PostToolUse')
  await waitFor(() => row.state === 'claimed')
  d.f.delayTake(0)
  const close = command(d, 'close-at-hook', '/lanes close ' + worker, '555')
  await waitFor(() => close.state === 'completed')
  expect(await result).toBe('')
  await waitFor(() => d.journal().some(r => r.rec === 'msg' && r.onsen_items?.[0]?.onsen_item_id === row.id))
  expect(takes()).toHaveLength(1)
  expect(reports().map(h => h.body.outcome)).toEqual(['reassigned'])
  expect(reports()[0]!.body.note).toContain(worker)
  writeFileSync(join(d.root, 'release-lane'), '')
})

test('a running worker receives all the waiting album IDs in one hook take', async () => {
  const { d, person, row, hook, takes } = await runningWorker()
  const album = ['left', 'right'].map((id, n) => {
    const r = person(id, String(560 + n))
    Object.assign(r.payload, { media_group_id: 'worker-album', kind: 'document',
      attachments: [{ kind: 'document', name: id + '.pdf', client_ref: id, mime: 'application/pdf' }] })
    r.payload.client.meta = { media_group_count: '2' }
    return r
  })
  const pending = () => JSON.parse(readFileSync(join(d.lanes, 'state.json'), 'utf8')).steering?.[worker] ?? []
  await waitFor(() => pending().some((s: any) => s.ev.onsen_items?.length === 2))
  expect(album.every(r => r.state === 'waiting')).toBe(true)
  expect(takes()).toHaveLength(0)
  const content = JSON.parse(await hook(1, 'PostToolUse')).hookSpecificOutput.additionalContext
  for (const r of album) expect(content).toContain(r.id)
  expect(takes().map(c => c.body.item_ids)).toEqual([[row.id, ...album.map(r => r.id)]])
  await waitFor(() => album.every(r => d.f.history.some(h => h.item_id === r.id && h.body.session_id === worker)))
  writeFileSync(join(d.root, 'release-lane'), '')
  await waitFor(() => album.every(r => r.state === 'completed'))
})

test('two peek pages of steering reach one boundary in takes of at most 100 IDs', async () => {
  const { d, person, row, input, hook } = await runningWorker()
  const messages = [row, ...Array.from({ length: 100 }, (_, n) => person('burst-' + n, String(1000 + n)))]
  await waitFor(() => readFileSync(input, 'utf8').trim().split('\n').length === messages.length, 8000)
  expect(messages.every(r => r.state === 'waiting')).toBe(true)
  const text = JSON.parse(await hook(1, 'PostToolUse')).hookSpecificOutput.additionalContext
  expect(text).toContain('「burst-99」')
  expect(text).toContain('「' + row.id + '」')
  const takes = d.f.calls.filter(c => c.path.endsWith('/take') && !c.body.item_ids.includes('start-worker'))
  expect(takes.map(c => c.body.item_ids.length).sort((a, b) => b - a)).toEqual([100, 1])
  expect(new Set(takes.flatMap(c => c.body.item_ids))).toEqual(new Set(messages.map(r => r.id)))
  writeFileSync(join(d.root, 'release-lane'), '')
}, 15000)

test('a worker that ends before a boundary takes its pending message once at the next run start', async () => {
  const { d, row, takes, reports } = await runningWorker()
  expect(takes()).toHaveLength(0)
  writeFileSync(join(d.root, 'release-lane'), '')
  await waitFor(() => row.state === 'completed')
  expect(takes()).toHaveLength(1)
  expect(reports().map(h => h.body.outcome)).toEqual(['in_session', 'completed'])
  const run = d.journal().find(r => r.rec === 'run' && r.state === 'running' && r.event === 'item-' + row.id + '-v1')
  expect(run.run).toBeTruthy()
  expect(reports()[0]!.body.session_id).toBe(worker)
  expect(d.journal().filter(r => r.rec === 'run' && r.state === 'leased' && r.lane === worker)).toHaveLength(2)
}, 10000)

test('a daemon restart folds the steer receipt into the interrupted run and reports its cut once', async () => {
  const { d, row, hook, reports } = await runningWorker()
  expect(await hook(1, 'PostToolUse')).toContain(row.id)
  const claim = row.claim!.id
  d.f.mode(409)  // the interrupted claims can finish; no fresh delivery on this boot
  await d.restart()
  await waitFor(() => reports().some(h => h.body.outcome === 'cut'), 8000)
  expect(reports().filter(h => h.body.claim_id === claim).map(h => h.body.outcome)).toEqual(['in_session', 'cut'])
  expect(reports()[0]!.body.session_id).toBe(worker)
  expect(d.journal().some(r => r.rec === 'run' && r.steered?.some((e: any) => e.onsen_items[0].onsen_item_id === row.id))).toBe(true)
  expect(d.journal().some(r => r.rec === 'run' && r.state === 'queued' && r.ev?.onsen_items?.[0]?.onsen_item_id === row.id)).toBe(false)
  writeFileSync(join(d.root, 'release-lane'), '')
}, 12000)

test('a second alert of the running incident is taken and merged at its steer hook', async () => {
  const d = await daemon({}, 200, scriptedLane)
  const alert = (id: string, check: string) => d.f.add(id, 'alert', { from: 'alert-dispatcher',
    refs: [{ kind: 'incident', value: 'node-1' }, { kind: 'alert', value: id }],
    payload: { text: '【警報 warning】alert ' + id + '：netdata / node-1 / ' + check + ' = 1 checks', line: 'call' } })
  const first = alert('9021', 'first_check')
  await waitFor(() => d.f.history.some(h => h.item_id === first.id && h.body.outcome === 'in_session'))
  const lane = d.f.history.find(h => h.item_id === first.id)!.body.session_id!
  const second = alert('9022', 'another_check'), input = join(d.lanes, 'run', 'steer', lane + '.in.jsonl')
  await waitFor(() => existsSync(input) && readFileSync(input, 'utf8').includes(second.id))
  expect(second.state).toBe('waiting')
  const text = JSON.parse(await laneHook(d.root, 1, 'PostToolUse')).hookSpecificOutput.additionalContext
  expect(text).toContain('系統併入')
  expect(text).toContain('another_check')
  await waitFor(() => d.f.history.some(h => h.item_id === second.id && h.body.session_id === lane))
  writeFileSync(join(d.root, 'release-lane'), '')
  await waitFor(() => second.state === 'completed')
  expect(d.f.history.filter(h => h.item_id === second.id).map(h => h.body.outcome)).toEqual(['in_session', 'completed'])
})

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
