import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Journal } from './lanes-state.ts'
import { itemRef } from './onsen-items.ts'
import { startOnsenStandin } from './test-fixtures/onsen-standin.ts'
import { fakeItems } from './test-fixtures/onsen-items.ts'
import { dm, startBotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
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
async function daemon(env: Record<string, string> = {}, initialMode = 200, setup?: (root: string, f: ReturnType<typeof fakeItems>) => Record<string, string> | Promise<Record<string, string>>, actionPort?: number) {
  const f = fakeItems(env.LANES_AGENT || 'adam', actionPort), root = mkdtempSync(join(tmpdir(), 'take-daemon-')), state = join(root, 'tg'), lanes = join(root, '.lanes')
  clean.push(async () => { try { await f.stop() } finally { rmSync(root, { recursive: true, force: true }) } })
  f.mode(initialMode)
  for (const dir of [state, lanes, join(root, 'home')]) mkdirSync(dir)
  writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['1'], groups: {}, pending: {}, ackReaction: '' }))
  copyFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), join(lanes, 'router.json'))
  const port = await freePort()
  const settings = await setup?.(root, f)
  const childEnv: Record<string, string | undefined> = {
    PATH: process.env.PATH, GIT_ALLOW_PROTOCOL: 'file', TMPDIR: root, HOME: join(root, 'home'), TELEGRAM_HTTP_PORT: String(port), TELEGRAM_STATE_DIR: state,
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

async function activePerson(id: string) {
  const sid = randomUUID(), pid = process.pid, turn = 'person-prompt'
  let registryFile = '', transcript = '', entry: Record<string, unknown> = {}
  const d = await daemon({ MCP_READY_DELAY_MS: '50' }, 200, root => {
    const sessions = join(root, 'home/.claude/sessions')
    const projects = join(root, 'home/.claude/projects', root.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(sessions, { recursive: true }); mkdirSync(projects, { recursive: true })
    writeFileSync(join(root, '.lanes/main-expected'), sid)
    transcript = join(projects, sid + '.jsonl')
    writeFileSync(transcript, '')
    registryFile = join(sessions, pid + '.json')
    entry = { pid, sessionId: sid, cwd: root, kind: 'interactive', entrypoint: 'cli', status: 'idle', statusUpdatedAt: Date.now() }
    writeFileSync(registryFile, JSON.stringify(entry))
    return {}
  })
  const headers = { Authorization: 'Bearer test-loopback', 'Content-Type': 'application/json' }
  const hook = async (event: string, more = {}) => {
    const resp = await fetch(d.base + '/lanes/main-event', { method: 'POST', headers,
      body: JSON.stringify({ event, pid, session_id: sid, prompt_id: turn, transcript_path: transcript, ...more }) })
    expect(resp.status).toBe(200)
    return resp.json()
  }
  expect((await hook('SessionStart', { source: 'startup' })).accepted).toBe(true)
  const offers: any[] = []
  const client = new Client({ name: 'main-test', version: '1' }, { capabilities: {} })
  client.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') offers.push(n.params) }
  await client.connect(new StreamableHTTPClientTransport(new URL(d.base + '/mcp'), { requestInit: { headers } }))
  clean.push(() => client.close())
  const row = d.f.add(id)
  expect(await until(() => offers.some(n => n.content.includes(row.id)), 6000), d.log().slice(-2500)).toBe(true)
  expect(row.state).toBe('claimed')
  const offer = offers.find(n => n.content.includes(row.id))
  await hook('UserPromptSubmit', { dids: [offer.meta.did] })
  await waitFor(() => row.claim?.session_id === sid)
  expect(row.session_id).toBe('main')
  const stop = async () => {
    await hook('Stop', { phase: 'final' })
    await Bun.sleep(3100)
    writeFileSync(registryFile, JSON.stringify({ ...entry, statusUpdatedAt: Date.now() }))
  }
  return { d, row, client, offers, stop, hook, registryFile, entry }
}

test('real daemon completes an idle main person item with its reply after the final Stop', async () => {
  const { d, row, client, offers, stop } = await activePerson('main-happy')
  const reply = await client.callTool({ name: 'reply', arguments: { chat_id: '1', text: 'received and done' } })
  expect(reply.isError, JSON.stringify(reply.content)).toBeFalsy()
  const replyId = /onsen:(\d+)/.exec(JSON.stringify(reply.content))?.[1]
  expect(replyId, JSON.stringify(reply.content)).toBeTruthy()
  expect(row.state).toBe('claimed')
  await stop()
  expect(await until(() => row.state === 'completed', 8000), d.log().slice(-2500)).toBe(true)
  expect(d.f.history.filter(h => h.item_id === row.id).map(h => h.body.outcome)).toEqual(['in_session', 'completed'])
  expect(row.response_message_ids).toEqual([replyId])
  expect(offers.filter(n => n.content.includes(row.id))).toHaveLength(1)
}, 25000)

for (const edge of ['offline', 'new UUID']) test('a main reply completes when its registry reports ' + edge + ' immediately after Stop', async () => {
  const { d, row, client, offers, hook, registryFile, entry } = await activePerson('leaving-main')
  const reply = await client.callTool({ name: 'reply', arguments: { chat_id: '1', text: 'finished' } })
  const id = /onsen:(\d+)/.exec(JSON.stringify(reply.content))?.[1]
  expect(id).toBeTruthy()
  await hook('Stop', { phase: 'final' })
  if (edge === 'offline') unlinkSync(registryFile)
  else writeFileSync(registryFile, JSON.stringify({ ...entry, sessionId: randomUUID(), status: 'busy', statusUpdatedAt: Date.now() }))
  await waitFor(() => row.state === 'completed')
  expect(row.response_message_ids).toEqual([id])
  expect(d.f.history.filter(h => h.item_id === row.id).map(h => h.body.outcome)).toEqual(['in_session', 'completed'])
  expect(offers).toHaveLength(1)
}, 15000)

test('after 45 s without renewal the main completes its original claim with one delivery and no re-take', async () => {
  const { d, row, offers, stop } = await activePerson('lease-expiry')
  await waitFor(() => d.f.calls.some(c => c.path.endsWith('/observation') && c.body.held_item_ids?.includes(row.id)))
  const originalClaimId = row.claim!.id
  const itemPath = '/v1/items/' + row.id
  const lastRenewal = d.f.calls.length
  // Server time advances with no observation in the interval.
  const untilExpiry = Date.parse(row.claim!.expires_at) - d.f.now()
  d.f.advance(untilExpiry - 1)
  expect(row.state).toBe('claimed')
  d.f.advance(1)
  expect(row).toMatchObject({ state: 'waiting', reason: 'cut', claim: null })
  expect(row.events!.at(-1)?.kind).toBe('lease_expired')
  expect(d.f.calls.slice(lastRenewal).some(c => c.path.endsWith('/observation'))).toBe(false)
  await waitFor(() => d.f.calls.slice(lastRenewal).some(c => c.path === itemPath))
  await stop()
  await waitFor(() => d.f.calls.slice(lastRenewal).some(c =>
    c.path.endsWith('/observation') && Array.isArray(c.body.held_item_ids) && !c.body.held_item_ids.includes(row.id)), 18_000)

  const afterExpiry = d.f.calls.slice(lastRenewal)
  expect(offers.filter(n => n.content.includes(row.id))).toHaveLength(1)
  expect(afterExpiry.filter(c => c.path.endsWith('/take') && c.body.item_ids.includes(row.id))).toHaveLength(0)
  const reports = afterExpiry.filter(c => c.path === itemPath + '/report').map(c => c.body)
  expect(reports).toEqual([expect.objectContaining({ outcome: 'completed', claim_id: originalClaimId })])
  expect(d.f.history.filter(h => h.item_id === row.id).map(h => h.body.outcome)).toEqual(['in_session', 'completed'])
  expect(row.state).toBe('completed')
}, 35_000)

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

test('a pulled person_edit without a date uses the retained original arrival', async () => {
  const d = await daemon({ ONSEN_TAKE: '', GENESIS_LANES: '0', MCP_READY_DELAY_MS: '50' }, 409)
  const headers = { Authorization: 'Bearer test-loopback', 'Content-Type': 'application/json' }
  const remote = new Client({ name: 'pull-edit-test', version: '1' }, { capabilities: {} })
  const delivered: any[] = []
  remote.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') delivered.push(n.params) }
  await remote.connect(new StreamableHTTPClientTransport(new URL(d.base + '/mcp'), { requestInit: { headers } }))
  clean.push(() => remote.close())
  const from = { name: 'telegram', chat: '1', msg_id: '4400', user_id: '1', user: 'joey' }
  const post = async (kind: string, payload: unknown) => {
    const res = await fetch(d.base + '/onsen/person', { method: 'POST', headers, body: JSON.stringify({ kind, payload }) })
    expect(res.status).toBe(200)
  }
  await post('person_message', { message_id: 'message-id', conversation_id: 'conv', client: from, from: 'joey', via: 'telegram',
    kind: 'text', text: 'original text', sent_at: '2020-01-12T03:17:00Z' })
  await waitFor(() => delivered.some(n => n.content === 'original text'))
  await post('person_edit', { message_id: 'message-id', client: from, text: 'edited text', edited_at: '2020-01-14T08:23:00Z' })
  await waitFor(() => delivered.some(n => n.meta.edited === 'true'))
  expect(delivered.find(n => n.meta.edited === 'true').content).toBe('〔@joey 改了他 01-12 03:17Z 那一則（tg:4400）〕\nedited text')
}, 15_000)

test('the inbox daemon follows take_member and serves the take relays with its local switch unset', async () => {
  const d = await daemon({ CHANNEL_INBOX_ONLY: '1', AGENT_INBOX_SELF: 'adam', ONSEN_PULL: 'adam', ONSEN_TAKE: '' })
  await waitFor(() => d.log().includes('member is on take'))
  for (const endpoint of ['inbound-log', 'scheduler-taken']) {
    const reply = await fetch(d.base + '/lanes/' + endpoint, { method: 'POST', headers: { Authorization: 'Bearer test-loopback' }, body: '{}' })
    expect(reply.status).toBe(200)
  }
  expect(d.f.calls.some(c => c.path.endsWith('/items'))).toBe(false)
  expect(d.log()).not.toContain('GET /inbox: HTTP 409')
})

test('daemon probes only once on an old server and keeps observation on the legacy shape', async () => {
  const d = await daemon({}, 400)
  await waitFor(() => d.f.calls.some(c => c.path.endsWith('/observation')))
  expect(d.f.calls.filter(c => c.path.endsWith('/items'))).toHaveLength(1)
  expect(d.f.calls.find(c => c.path.endsWith('/observation'))!.body.connector).toBeUndefined()
  expect(d.log().split('\n').filter(l => l.includes('mode probe: HTTP 400'))).toHaveLength(1)
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
  const a = add('a', 'album', 3); add('b', 'album', 3)
  await Bun.sleep(120); expect(records('album')).toHaveLength(0)
  add('c', 'album', 3)
  await waitFor(() => records('album').length > 0)
  expect(records('album')).toHaveLength(1); expect(records('album')[0].onsen_items.map((r: any) => r.onsen_item_id)).toEqual(['a', 'b', 'c'])
  const original = records('album')[0].notif
  a.reason = 'not_taken'; d.f.change(a, 'not_taken')
  await waitFor(() => d.journal().some(l => l.onsen_items?.some((i: any) => i.onsen_item_id === a.id && i.onsen_version === a.version)))
  expect(records('album')).toHaveLength(1)
  expect(records('album')[0].notif).toEqual(original)
  expect(d.journal().some(l => l.edited_in_queue)).toBe(false)
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

test('a deferred mail hand-back is reattached as a batched unclaimed M1 item', async () => {
  const d = await daemon({}, 200, (root, f) => {
    const row = f.add('mail-deferred', 'mail', { reason: 'reassigned', note: 'Decision for main', from: 'eve' })
    const journal = new Journal(join(root, 'tg', 'lanes', 'state.jsonl'))
    journal.write('event', 'original', 'open', { onsen_items: [itemRef(row)],
      obligations: [{ id: 'ho-mail', kind: 'main', state: 'open', handoff: 'ho-mail', defer: true }] })
    return {}
  })
  await waitFor(() => d.journal().some(r => r.rec === 'msg' && r.event === 'original'))
  const local = d.journal().find(r => r.rec === 'msg' && r.event === 'original')
  expect(local.reason).toBe('batched')
  expect(local.notif.params.content).toContain('Decision for main')
  expect(d.f.rows.get('mail-deferred')?.state).toBe('waiting')
})

test('stopped and over-budget threads and a missing lane hand their queued items back', async () => {
  const ids = ['stopped', 'budget', 'gone', 'owned-gone']
  const d = await daemon({}, 200, async (root, f) => {
    const journal = new Journal(join(root, 'tg', 'lanes', 'state.jsonl'))
    const lanes: Record<string, any> = {}, threads: Record<string, any> = {}
    for (const id of ids) {
      const row = f.add(id, 'call', { from: 'eve' }), lane = 'adam.worker.' + row.number
      if (id === 'owned-gone') {
        const taken = await fetch(f.base + '/v1/members/adam/items/take', { method: 'POST',
          headers: { Authorization: 'Bearer test-member', 'Idempotency-Key': id },
          body: JSON.stringify({ connector: 'mac-mini/adam', item_ids: [id], wait: 0, limit: 1 }) })
        expect(taken.status).toBe(200)
        const dir = join(root, 'tg', 'onsen')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'claims.json'), JSON.stringify({ claims: { [id]: { claim_id: row.claim!.id, taken_at: row.claim!.taken_at } } }))
      }
      if (!id.endsWith('gone')) {
        lanes[lane] = { id: lane, kind: 'worker', status: 'idle', thread: id, session_id: randomUUID(), runs: 0 }
        threads[id] = { id, lane, fresh: id === 'budget' ? 1000 : 0, stopped: id === 'stopped' ? 'closed' : null }
      }
      journal.write('run', 'run-' + id, 'queued', { lane, event: id, attempt: 1, ev: { id, source: 'mesh', from: 'eve', text: id,
        onsen_items: [itemRef(row)], notif: { method: 'notifications/claude/channel', params: {} } } })
    }
    writeFileSync(join(root, '.lanes', 'state.json'), JSON.stringify({ lanes, threads }))
    return { LANES_THREAD_BUDGET: '500' }
  })
  for (const id of ids) {
    await waitFor(() => d.f.history.some(h => h.item_id === id && h.body.outcome === 'reassigned'), 12000)
    expect(d.f.rows.get(id)?.note).toBeTruthy()
    expect(d.f.calls.filter(c => c.path.endsWith('/take') && c.body.item_ids.includes(id))).toHaveLength(1)
  }
}, 18000)

test('a person item with no chat or a disallowed chat completes with no reply', async () => {
  const d = await daemon()
  const noChat = d.f.add('no-chat', 'message', { payload: {} })
  const denied = d.f.add('denied')
  denied.payload.client.chat = '12345'
  for (const row of [noChat, denied]) {
    await waitFor(() => row.state === 'completed')
    expect(d.f.history.filter(h => h.item_id === row.id).map(h => h.body.response_message_ids)).toEqual([[]])
  }
  expect(d.log()).toContain('no Telegram chat')
  expect(d.log()).toContain('not allowlisted')
})

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

import capturedPage from './test-fixtures/onsen-0.40.0/list-completed.json'
const capturedPerson = capturedPage.items.find(it => it.kind === 'message')!
const worker = 'adam.worker.1'
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
  const person = (id: string, tg: string, source = {}) => d.f.add(id, 'message', { ...source, message_id: id, payload: {
    message_id: id, from: 'joey', conversation_id: 'conv', kind: 'text', thread: 555, text: id,
    client: { name: 'telegram', chat: '1', msg_id: tg, user_id: '1', user: 'Joey', thread: '555' },
  } })
  const first = person(capturedPerson.id, '550', { ...capturedPerson, state: 'waiting' })
  await waitFor(() => d.f.history.some(h => h.item_id === first.id && h.body.session_id === worker))
  expect(first.session_id).toBe('main')
  expect(d.f.calls.filter(c => c.path === '/v1/items/' + first.id)).toHaveLength(0)
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
  const takes = d.f.calls.filter(c => c.path.endsWith('/take') && !c.body.item_ids.includes(capturedPerson.id))
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
  expect(d.f.calls.filter(c => c.path === '/v1/items/' + two.id)).toHaveLength(0)
  expect(records().some(r => r.rec === 'msg' && (r.kind === 'handoff' || r.kind === 'carry'))).toBe(false)
}, 18000)

test('roamer stays on its local mock bot and never probes items', async () => {
  const bot = startBotApiMock()
  clean.push(() => bot.stop())
  const d = await daemon({ ROAMER_MODE: '1', TELEGRAM_BOT_TOKEN: bot.token, TELEGRAM_API_ROOT: bot.url })
  await waitFor(() => d.log().includes('staying on pull: ROAMER'))
  expect(d.f.calls.filter(c => c.path.endsWith('/items'))).toHaveLength(0)
})

const member = 'space-roamers'
const roamerEnv = { GENESIS_LANES: '0', ROAMER_MODE: '1', ROAMER_BOT_NAME: 'space_roamers', LANES_AGENT: member, ONSEN_OBSERVATION: member }
const roamerState = (root: string) => ({ ROAMER_STATE_FILE: join(root, 'roamer-state.json') })

test('a switched roamer starts with no bot token, registers commands and observes as its own member', async () => {
  const d = await daemon(roamerEnv, 200, roamerState)
  const h = await fetch(d.base + '/healthz').then(r => r.json())
  expect(h.connector.on).toBe(true)
  expect(h.polling).toBe(false)
  await waitFor(() => d.f.calls.some(c => c.body?.connector === 'mac-mini/' + member && c.path.endsWith('/observation')))
  expect(d.f.calls.find(c => c.body?.connector && c.path.endsWith('/observation'))!.body.presence).toBe('offline')
  const names = d.f.calls.find(c => c.path === '/v1/members/' + member + '/commands')!.body.commands.map((c: any) => c.name)
  expect(names).toEqual(expect.arrayContaining(['roam', 'roam_status', 'resume_list', 'resume', 'resume_previous', 'restart', 'kill_stuck',
    'clear', 'agents', 'mcp', 'init', 'compact', 'model', 'effort', 'codexgate', 'sigint']))
  d.f.mode(503)
  await d.restart()
  const offline = await fetch(d.base + '/healthz').then(r => r.json())
  expect(offline.connector.on).toBe(true)
  expect(offline.polling).toBe(false)
})

for (const [name, mode, named] of [['not selected', 200, false], ['409', 409, true], ['404', 404, true]] as const)
  test('roamer keeps its local bot when ' + name, async () => {
    const bot = startBotApiMock({}, { pollHoldMs: 100 })
    clean.push(() => bot.stop())
    const d = await daemon({ ...roamerEnv, TELEGRAM_BOT_TOKEN: bot.token, TELEGRAM_API_ROOT: bot.url, ...(named ? {} : { ONSEN_TAKE: '' }) }, mode, roamerState)
    await waitFor(async () => (await fetch(d.base + '/healthz').then(r => r.json())).polling)
    expect((await fetch(d.base + '/healthz').then(r => r.json())).connector.on).toBe(false)
    expect(d.f.calls.filter(c => c.path.endsWith('/items'))).toHaveLength(named ? 1 : 0)
    expect(d.f.calls.some(c => c.path.endsWith('/commands') || c.path.endsWith('/observation'))).toBe(false)
  })

test('handover confirms the whole local batch when another update is handled during stop', async () => {
  const bot = startBotApiMock({}, { pollHoldMs: 100 })
  clean.push(() => bot.stop())
  const offsets: number[] = []
  let sending = false, release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    const body = await req.text()
    if (/\/send(Rich)?Message$/.test(path) && !sending) { sending = true; await held }
    if (path.endsWith('/getUpdates')) {
      const poll = JSON.parse(body)
      if (poll.limit === 1) { offsets.push(poll.offset); release() }
    }
    return fetch(bot.url + path, { method: req.method, headers: { 'Content-Type': 'application/json' }, body })
  } })
  clean.push(() => { release(); return proxy.stop(true) })
  for (const id of [41, 42]) bot.push({ update_id: id, ...dm(1, id, '/help', { command: true }) })
  const d = await daemon({ ...roamerEnv, C6_FAST_PROBE: '1', TELEGRAM_BOT_TOKEN: bot.token, TELEGRAM_API_ROOT: 'http://127.0.0.1:' + proxy.port }, 409, roamerState)
  await waitFor(() => sending)
  d.f.mode(200)
  await waitFor(async () => (await fetch(d.base + '/healthz').then(r => r.json())).connector.on)
  expect(offsets).toEqual([42, 43])
  expect(d.log().match(/inbound u=4[12] /g)).toHaveLength(2)
}, 10000)

test('a failed offset confirmation keeps the bridge out through restart until the exact offset succeeds', async () => {
  const bot = startBotApiMock({}, { pollHoldMs: 100 })
  clean.push(() => bot.stop())
  const offsets: number[] = []
  let reject = true
  bot.fail.fn = (method, body) => {
    if (method !== 'getUpdates' || Number(body.limit) !== 1) return false
    offsets.push(Number(body.offset))
    return reject
  }
  const d = await daemon({ ...roamerEnv, C6_FAST_PROBE: '1', TELEGRAM_BOT_TOKEN: bot.token, TELEGRAM_API_ROOT: bot.url }, 409, roamerState)
  const health = () => fetch(d.base + '/healthz').then(r => r.json())
  const claimFile = join(d.state, 'onsen/claims.json')
  const claims = () => JSON.parse(readFileSync(claimFile, 'utf8'))
  bot.push({ update_id: 41, message: { message_id: 1, chat: { id: 1, type: 'private' }, from: { id: 1, first_name: 'Joey' }, date: 1, text: '/help' } })
  await waitFor(() => d.log().includes('inbound u=41'))
  d.f.mode(200)
  await waitFor(() => offsets.length > 0)
  expect((await health()).connector.on).toBe(false)
  expect(claims().pollOffset).toBe(42)
  expect(claims().connector).toBeUndefined()
  const before = offsets.length
  await d.restart()
  await waitFor(() => offsets.length > before)
  expect((await health()).connector.on).toBe(false)
  expect(d.f.calls.some(c => c.path.endsWith('/commands') || c.path.endsWith('/observation'))).toBe(false)
  reject = false
  await waitFor(async () => (await health()).connector.on, 12000)
  expect((await health()).polling).toBe(false)
  expect(claims().connector).toBe('mac-mini/' + member)
  expect(claims().pollOffset).toBeUndefined()
  expect(new Set(offsets)).toEqual(new Set([42]))
  expect(d.log().match(/inbound u=41 /g)).toHaveLength(1)
}, 22000)

test('a later successful probe drains the local poll before the bridge can carry the bot', async () => {
  const bot = startBotApiMock({}, { pollHoldMs: 100 })
  clean.push(() => bot.stop())
  const d = await daemon({ ...roamerEnv, C6_FAST_PROBE: '1', TELEGRAM_BOT_TOKEN: bot.token, TELEGRAM_API_ROOT: bot.url }, 409, roamerState)
  await waitFor(() => bot.polls.length > 0)
  d.f.mode(200)
  await waitFor(async () => (await fetch(d.base + '/healthz').then(r => r.json())).connector.on)
  const calls = bot.polls.length
  await Bun.sleep(350)
  expect(bot.polls).toHaveLength(calls)
  await waitFor(() => d.f.calls.some(c => c.body?.connector === 'mac-mini/' + member && c.path.endsWith('/observation')))
}, 9000)

for (const mode of ['pull', 'take']) test('a command choice that throws follows ' + mode + ' Action semantics', async () => {
  const actions = startOnsenStandin({ 'test-member': 'adam' })
  clean.push(() => actions.stop())
  const take = mode === 'take'
  const d = await daemon({ C6_CHOICE_FAILURE: '1', ONSEN_OWNER: 'joey', CHANNEL_BOT_TMUX_SESSION: 'lab',
    ONSEN_TAKE: take ? 'adam' : '' }, take ? 200 : 409, undefined, actions.port)
  const post = (path: string, body: unknown) => fetch(d.base + path, { method: 'POST',
    headers: { Authorization: 'Bearer test-loopback', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const cmd = command(d, 'model', '/model', '100')
  if (take) await waitFor(() => cmd.state === 'completed')
  else expect((await post('/onsen/person', { kind: 'person_message', payload: cmd.payload })).status).toBe(200)
  await waitFor(() => actions.actions.size === 1)
  const action = [...actions.actions.values()][0]!, payload = actions.press(action.id, '1')
  if (take) {
    const control = d.f.add('choice', 'control', { action_id: action.id, payload })
    await waitFor(() => control.reason === 'not_applied')
  } else expect((await post('/onsen/action', payload)).ok).toBe(true)
  const calls = () => actions.acalls.filter(c => c.path === '/v1/actions/' + action.id + (take ? '/cancel' : '/applied'))
  await waitFor(() => calls().length === 1)
  expect(d.log()).toContain('fixture choice failed')
  expect(actions.acalls.some(c => c.path.endsWith(take ? '/applied' : '/cancel'))).toBe(false)
}, 12000)

test('/roam without a target creates one menu Action; a returned choice is handled once through control', async () => {
  const actions = startOnsenStandin({ 'test-member': member })
  clean.push(() => actions.stop())
  const d = await daemon({ ...roamerEnv, ONSEN_OWNER: 'joey', C6_ROAMER_MENU: '1' }, 200, root => {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    // This takeover already has an MCP stream. There is no real tmux pane or Claude argv in the fixture.
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    writeFileSync(join(bin, 'tmux'), '#!/bin/sh\n[ "$1" = has-session ]\n', { mode: 0o700 })
    return { ...roamerState(root), PATH: bin + ':' + process.env.PATH }
  }, actions.port)
  const available = join(d.root, 'lab-target')
  const lab = await target(d)
  const entry = { pid: lab.child.pid, sessionId: lab.sid, cwd: lab.cwd, kind: 'interactive', status: 'idle', startedAt: 1 }
  writeFileSync(available, JSON.stringify(entry))
  const cmd = command(d, 'choose', '/roam@space_roamersbot', '99')
  await waitFor(() => cmd.state === 'completed')
  expect(actions.actions.size).toBe(1)
  const action = [...actions.actions.values()][0]!
  expect(action).toMatchObject({ source: 'menu', assignees: ['joey'], options: [{ id: '1', label: expect.any(String) }] })
  expect(d.f.calls.filter(c => c.path === '/v1/messages')).toHaveLength(0)
  const payload = actions.press(action.id, '1')
  const press = (id: string) => d.f.add(id, 'control', { action_id: action.id, payload })
  const first = press('press')
  await waitFor(() => first.state === 'completed')
  expect(JSON.parse(readFileSync(roamerState(d.root).ROAMER_STATE_FILE, 'utf8')).current_target.session_id).toBe(lab.sid)
  const replies = d.f.calls.filter(c => c.path === '/v1/messages').length
  expect(replies).toBeGreaterThan(0)
  expect(actions.acalls.filter(c => c.path.endsWith('/applied'))).toHaveLength(1)
  const repeat = press('repeat')
  await waitFor(() => repeat.reason === 'not_applied')
  expect(actions.acalls.filter(c => c.path.endsWith('/applied'))).toHaveLength(1)
  expect(d.f.calls.filter(c => c.path === '/v1/messages')).toHaveLength(replies)
  const next = command(d, 'stale', '/roam', '100')
  await waitFor(() => next.state === 'completed')
  const stale = [...actions.actions.values()].at(-1)!
  unlinkSync(available)
  const missed = d.f.add('stale-choice', 'control', { action_id: stale.id, payload: actions.press(stale.id, '1') })
  await waitFor(() => missed.reason === 'not_applied')
  expect(actions.acalls.filter(c => c.path === '/v1/actions/' + stale.id + '/applied')).toHaveLength(0)
  for (const [slash, kind] of [['/resume_list', 'resume_picker'], ['/model', 'model_picker'], ['/effort', 'other']]) {
    lab.select()
    lab.accept({ meta: { message_id: '99', onsen_claims: '' } })
    const before = actions.actions.size
    const c = command(d, slash.slice(1), slash, String(100 + before))
    await waitFor(() => c.state === 'completed')
    expect(actions.actions.size).toBe(before + 1)
    const picker = [...actions.actions.values()].at(-1)!
    expect(picker).toMatchObject({ source: 'menu', menu_kind: kind })
    writeFileSync(roamerState(d.root).ROAMER_STATE_FILE, JSON.stringify({ current_target: null }))
    const gone = d.f.add('gone-' + slash.slice(1), 'control', { action_id: picker.id, payload: actions.press(picker.id, '1') })
    await waitFor(() => gone.reason === 'not_applied')
    expect(actions.acalls.filter(c => c.path === '/v1/actions/' + picker.id + '/applied')).toHaveLength(0)
  }
}, 15000)

async function target(d: Awaited<ReturnType<typeof daemon>>) {
  const child = Bun.spawn(['sleep', '300']), tmux = randomUUID()
  let sid = tmux
  clean.push(async () => { child.kill(); await child.exited })
  const cwd = join(d.root, 'lab-project')
  const home = join(d.root, 'home', '.claude'), regs = join(home, 'sessions'), project = join(home, 'projects', cwd.replaceAll('/', '-'))
  for (const dir of [regs, project]) mkdirSync(dir, { recursive: true })
  const status = (value: string, sessionId = sid) => writeFileSync(join(regs, child.pid + '.json'), JSON.stringify({
    pid: child.pid, sessionId, cwd, kind: 'interactive', status: value, statusUpdatedAt: Date.now() }))
  status('idle')
  let transcript = join(project, sid + '.jsonl')
  writeFileSync(transcript, '')
  const write = (fields: object) => appendFileSync(transcript, JSON.stringify({ entrypoint: 'cli', timestamp: new Date().toISOString(), ...fields }) + '\n')
  const select = () => writeFileSync(roamerState(d.root).ROAMER_STATE_FILE, JSON.stringify({ current_target: { tmux, claude_pid: child.pid, cwd, session_id: sid } }))
  const got: any[] = []
  async function connect() {
    const client = new Client({ name: 'lab', version: '1' })
    client.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') got.push(n.params) }
    await client.connect(new StreamableHTTPClientTransport(new URL(d.base + '/mcp'), { requestInit: { headers: { 'x-test-claude-pid': String(child.pid) } } }))
    clean.push(() => client.close())
    return client
  }
  const client = await connect()
  function switchSession() {
    sid = randomUUID()
    transcript = join(project, sid + '.jsonl')
    writeFileSync(transcript, '')
    status('idle')
  }
  return { child, get sid() { return sid }, cwd, get transcript() { return transcript }, switchSession, select, status, client, connect, got, accept: (msg: any) => write({ type: 'user', message: { content:
    `<channel source="telegram" chat_id="1" message_id="${msg.meta.message_id}" onsen_claims="${msg.meta.onsen_claims}">hello</channel>` } }),
    stop: () => write({ type: 'system', subtype: 'turn_duration' }) }
}

test('roamer switches between two live streams in one cwd, binds on intake and completes only the receiving UUID', async () => {
  const d = await daemon({ ...roamerEnv, ONSEN_BRIDGE_WAIT_MS: '10' }, 200, roamerState)
  const one = d.f.add('first', 'message', { session_id: 'main' })
  const a = await target(d), b = await target(d)
  await Bun.sleep(350)
  expect(one.claim).toBeNull()
  expect(a.got).toHaveLength(0); expect(b.got).toHaveLength(0)
  a.select()
  await waitFor(() => a.got.length === 1)
  expect(one.claim!.session_id).toBeNull()
  b.accept(a.got[0]); b.stop()
  await Bun.sleep(350)
  expect(one.claim!.session_id).toBeNull()
  a.accept(a.got[0])
  await waitFor(() => one.claim?.session_id === a.sid)
  expect(one.session_id).toBe('main')
  b.select()
  const two = d.f.add('second', 'message', { session_id: null })
  await waitFor(() => b.got.length === 1)
  b.accept(b.got[0])
  await waitFor(() => two.claim?.session_id === b.sid)
  expect(two.session_id).toBe(b.sid)
  expect(a.got.map(n => n.content)).toEqual(['first'])
  expect(b.got.map(n => n.content)).toEqual(['second'])
  const reply = await a.client.callTool({ name: 'reply', arguments: { chat_id: '1', text: 'first received' } })
  expect(reply.isError).not.toBe(true)
  const beforeBusy = d.f.calls.length
  b.status('busy')
  await waitFor(() => d.f.calls.slice(beforeBusy).some(c => c.path.endsWith('/observation') && c.body.held_item_ids?.includes(two.id)
    && c.body.sessions?.some((s: { activity: string }) => s.activity === 'running')))
  b.status('idle') // Short turn with registry evidence and no transcript turn_duration.
  await waitFor(() => two.state === 'completed', 9000)
  expect(two.response_message_ids).toEqual([])
  expect(one.claim?.session_id).toBe(a.sid)
  a.stop()
  await waitFor(() => one.state === 'completed', 9000)
  expect(one.response_message_ids).toHaveLength(1)
  expect(one.session_id).toBe('main')
  const dying = d.f.add('kill target', 'mail')
  await waitFor(() => b.got.length === 2)
  b.accept(b.got[1])
  await waitFor(() => dying.claim?.session_id === b.sid)
  b.child.kill(); await b.child.exited
  await waitFor(() => dying.state === 'waiting' && dying.reason === 'cut')
  expect(d.f.history.filter(h => h.item_id === dying.id && h.body.outcome === 'cut')).toHaveLength(1)
  expect(a.got).toHaveLength(1)
}, 45000)

test('a final Stop and reply are completed when the roamer target exits inside the settle window', async () => {
  const d = await daemon(roamerEnv, 200, roamerState), a = await target(d)
  a.select()
  const row = d.f.add('answered-before-exit')
  await waitFor(() => a.got.length === 1)
  a.accept(a.got[0])
  await waitFor(() => row.claim?.session_id === a.sid)
  const reply = await a.client.callTool({ name: 'reply', arguments: { chat_id: '1', text: 'done' } })
  const id = /onsen:(\d+)/.exec(JSON.stringify(reply.content))?.[1]
  expect(id).toBeTruthy()
  // The final Stop can be in the next chunk when the process has already exited.
  appendFileSync(a.transcript, JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(5 << 20) } }) + '\n')
  a.stop()
  a.child.kill(); await a.child.exited
  await waitFor(() => row.state === 'completed')
  expect(row.response_message_ids).toEqual([id])
  expect(d.f.history.map(r => r.body.outcome)).toEqual(['in_session', 'completed'])
  expect(a.got).toHaveLength(1)
}, 12000)

test('a session change inside the same target PID cuts the old claim and delivers to the new UUID', async () => {
  const d = await daemon(roamerEnv, 200, roamerState), a = await target(d)
  a.select()
  const first = d.f.add('before-clear')
  await waitFor(() => a.got.length === 1)
  a.accept(a.got[0])
  await waitFor(() => first.claim?.session_id === a.sid)
  first.not_before = new Date(Date.now() + 60_000).toISOString()
  const old = a.sid, oldTranscript = a.transcript
  a.status('idle', '')
  await Bun.sleep(350)
  expect(first.claim?.session_id).toBe(old)
  expect(JSON.parse(readFileSync(roamerState(d.root).ROAMER_STATE_FILE, 'utf8')).current_target.session_id).toBe(old)
  a.switchSession()
  const second = d.f.add('after-clear')
  await waitFor(() => a.got.length === 2)
  expect(JSON.parse(readFileSync(roamerState(d.root).ROAMER_STATE_FILE, 'utf8')).current_target).toEqual({
    tmux: old, claude_pid: a.child.pid, cwd: a.cwd, session_id: a.sid })
  expect(d.f.history.filter(h => h.item_id === first.id).map(h => h.body.outcome)).toEqual(['in_session', 'cut'])
  a.accept(a.got[1])
  await waitFor(() => second.claim?.session_id === a.sid)
  appendFileSync(oldTranscript, JSON.stringify({ type: 'system', subtype: 'turn_duration' }) + '\n')
  await Bun.sleep(300)
  expect(second.state).toBe('claimed')
  a.stop()
  await waitFor(() => second.state === 'completed', 9000)
  expect(second.session_id).toBe('main')
}, 16000)

test('after a daemon restart a long turn still ends on its original target transcript', async () => {
  const d = await daemon(roamerEnv, 200, roamerState), a = await target(d), b = await target(d)
  a.select()
  const row = d.f.add('carry turn', 'message', { session_id: null })
  await waitFor(() => a.got.length === 1)
  a.accept(a.got[0])
  await waitFor(() => row.claim?.session_id === a.sid)
  b.select()
  appendFileSync(a.transcript, JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(2 << 20) } }) + '\n')
  await d.restart()
  a.stop()
  await waitFor(() => row.state === 'completed', 9000)
  expect(d.f.history.filter(h => h.item_id === row.id).map(h => h.body.outcome)).toEqual(['in_session', 'completed'])
  expect(row.session_id).toBe(a.sid)
  expect(b.got).toHaveLength(0)
}, 15000)

test('a missed item waits through fresh peeks and restart until its session changes state', async () => {
  const d = await daemon(roamerEnv, 200, roamerState), a = await target(d)
  a.select()
  // Server-stamped taken_at leaves one second of the normal 20 s acceptance window.
  d.f.advance(-19_000)
  const row = d.f.add('unseen')
  await waitFor(() => row.reason === 'not_taken')
  expect(a.got.filter(n => n.content === row.id)).toHaveLength(1)
  a.status('idle') // refreshing the same status timestamp is not a state change
  await Bun.sleep(1300)
  expect(row.failures).toBe(1)
  expect(a.got.filter(n => n.content === row.id)).toHaveLength(1)
  await d.restart()
  await a.connect()
  const other = d.f.add('still-receiving')
  await waitFor(() => a.got.some(n => n.content === other.id))
  expect(row.failures).toBe(1)
  expect(row.state).toBe('waiting')
  expect(a.got.filter(n => n.content === row.id)).toHaveLength(1)
  a.status('busy')
  await Bun.sleep(350)
  a.status('idle')
  await waitFor(() => a.got.filter(n => n.content === row.id).length === 2)
  a.accept(a.got.filter(n => n.content === row.id)[1])
  await waitFor(() => row.claim?.session_id === a.sid)
  expect(row.failures).toBe(1)
}, 16000)

test('a missed session can change state while a different busy target is selected', async () => {
  const d = await daemon(roamerEnv, 200, roamerState), a = await target(d), b = await target(d)
  a.select(); b.status('busy')
  d.f.advance(-19_000)
  const row = d.f.add('await-edge')
  await waitFor(() => row.reason === 'not_taken')
  d.f.advance(Date.now() - d.f.now()) // the next take gets a fresh acceptance window
  b.select()
  await Bun.sleep(400)
  a.status('busy')
  await Bun.sleep(400)
  a.status('idle')
  await Bun.sleep(400)
  expect(b.got).toHaveLength(0)
  a.select()
  await waitFor(() => a.got.length === 2)
  a.accept(a.got[1])
  await waitFor(() => row.claim?.session_id === a.sid)
  expect(row.failures).toBe(1)
}, 12000)

test('changing target during take releases that attempt before writing either stream', async () => {
  const d = await daemon(roamerEnv, 200, roamerState)
  const a = await target(d), b = await target(d)
  a.select()
  d.f.delayTake(500)
  const row = d.f.add('moves')
  await waitFor(() => !!row.claim)
  b.select()
  await waitFor(() => d.f.history.some(h => h.item_id === row.id && h.body.outcome === 'not_taken'))
  expect(a.got).toHaveLength(0)
  await waitFor(() => b.got.length === 1)
  expect(b.got[0].content).toBe('moves')
}, 12000)

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
  const refusal = 'mode probe: ' + (code ? 'HTTP ' + code : 'no response')
  await waitFor(() => d.log().includes(refusal))
  expect(d.log().split('\n').filter(s => s.includes(refusal))).toHaveLength(1)
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
