import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMain, type MainEnv, type Notif } from './lanes-main.ts'
import { Journal } from './lanes-state.ts'
import { REG_SETTLE_MS, Registry } from './onsen-status.ts'

const sid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const pid = 321
const cleanup: Array<() => void> = []
afterEach(() => { for (const f of cleanup.splice(0)) f() })

function daemon() {
  const dir = mkdtempSync(join(tmpdir(), 'wo205-'))
  const journal = new Journal(join(dir, 'journal'))
  const offers: Notif[] = [], notices: string[] = [], logs: string[] = [], alerts: Array<Record<string, unknown>> = []
  const os = { alive: true, start: '3154' as string | null }
  const registry = new Registry({ dir, workspace: dir, tmux: 'adam', transcripts: () => dir, sessionId: () => sid,
    connected: () => true, alive: () => os.alive, procStart: () => os.start, changed: () => main.registryChanged() })
  const env: MainEnv = { journal, registry, agent: 'adam', log: (_level, text) => logs.push(text),
    offer: async n => { offers.push(n); return true }, streamOpen: () => true, expectedSession: () => [sid],
    pidAlive: () => os.alive, tellJoey: (text, rule) => notices.push(`${rule} ${text}`), registryAlert: a => { alerts.push(a) },
    info: () => null, done() {}, undone() {}, refused() {}, genChanged() {}, context: () => '' }
  const main = createMain(env)
  main.initMain()
  const put = (fields: object = {}) => writeFileSync(join(dir, `${pid}.json`), JSON.stringify({
    pid, sessionId: sid, kind: 'interactive', entrypoint: 'cli', cwd: dir, tmux: 'adam:@1.%1', status: 'idle', procStart: '3154', ...fields }))
  cleanup.push(() => { registry.stop(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, registry, main, env, journal, os, put, offers, notices, logs, alerts }
}

test.each(['registry change', 'tick'])('WO-205 (a) the %s adopts a TUI whose SessionStart was missed and offers its waiting item', async trigger => {
  const d = daemon()
  const id = d.main.enqueue('peer', { method: 'notifications/claude/channel', params: { content: 'hello' } })
  await Bun.sleep(0)
  d.put()
  if (trigger === 'tick') await d.main.tick()
  else {
    // A change of the active registry source fires the same changed callback as a file watch.
    // The CLI omits the identity fields. The matching file still has to vouch for this pid.
    d.registry.o.cli = async () => JSON.stringify([{ pid, sessionId: sid, kind: 'interactive', cwd: d.dir, status: 'busy' }])
    d.registry.o.retryMs = 0
    await d.registry.crossCheck()
  }
  expect(d.main.currentGen()).toMatchObject({ pid, session_id: sid, state: 'idle', source: 'adopt', transcript_path: join(d.dir, sid + '.jsonl') })
  expect(d.logs.filter(s => s.includes('main adopted from the session registry'))).toHaveLength(1)
  expect(d.journal.get('msg', id)?.state).toBe('offered')
  await d.main.tick()
  expect(d.offers).toHaveLength(1)
})

test('WO-205 (b) disagreement lasts a full settling interval, pages the maintainer once (BTCC, not Joey), clears and rearms after a live gen', async () => {
  const d = daemon(), stranger = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  const since = Date.now()
  d.put({ sessionId: stranger })
  await d.main.tick(since)
  await d.main.tick(since + REG_SETTLE_MS - 1)
  expect(d.main.currentGen()).toBeNull()
  expect(d.alerts).toBeEmpty()
  await d.main.tick(since + REG_SETTLE_MS)
  await d.main.tick(since + REG_SETTLE_MS * 2)
  // Chiron mesh-13475: no Joey line for this; one page alert to the connector's maintainer
  expect(d.notices).toBeEmpty()
  expect(d.alerts).toEqual([{ state: 'open', session: stranger, pid, why: 'not expected (main-expected)' }])
  expect(d.logs.filter(s => s.includes('not expected'))).toHaveLength(1)
  expect(d.main.currentGen()).toBeNull()
  await d.main.mainEvent({ event: 'SessionStart', pid: 456, session_id: sid })
  expect(d.alerts.at(-1)).toEqual({ state: 'clear' })                 // a gen registered: the alert's recovery
  await d.main.mainEvent({ event: 'SessionEnd', pid: 456, session_id: sid })
  await d.main.tick(since + REG_SETTLE_MS * 3)
  await d.main.tick(since + REG_SETTLE_MS * 4)
  expect(d.alerts.map(a => a.state)).toEqual(['open', 'clear', 'open'])
  await d.main.mainEvent({ event: 'SessionStart', pid: 457, session_id: sid })
  await d.main.mainEvent({ event: 'SessionStart', pid: 457, session_id: sid })
  expect(d.alerts.map(a => a.state)).toEqual(['open', 'clear', 'open', 'clear'])   // one clear per open, not one per SessionStart
  expect(d.notices).toBeEmpty()
})

test('WO-205 (b2) after a daemon start a first registered gen sends one clear (an alert opened before the restart is closed)', async () => {
  const d = daemon()
  await d.main.mainEvent({ event: 'SessionStart', pid: 458, session_id: sid })
  await d.main.mainEvent({ event: 'SessionStart', pid: 458, session_id: sid, source: 'compact' })
  expect(d.alerts).toEqual([{ state: 'clear' }])
})

test('WO-205 (c) adoption requires a live pid and a fresh positive procStart match', async () => {
  const d = daemon()
  d.put()
  // Status cached a match. A reused pid must already be refused on the next tick.
  d.registry.inputs({ queuedJoey: 0, wall: null })
  d.os.alive = false
  await d.main.tick()
  expect(d.main.currentGen()).toBeNull()
  d.os.alive = true
  for (const start of ['9999', null, 'Tue Nov 24 18:16:31 2026']) {
    d.os.start = start
    await d.main.tick()
    expect(d.main.currentGen()).toBeNull()
  }
  d.os.start = '9999'
  await d.main.tick(Date.now() + REG_SETTLE_MS)
  expect(d.alerts[0]).toMatchObject({ state: 'open', why: 'procStart mismatch' })
  expect(d.notices).toBeEmpty()
})

test('WO-205 (e) a lane, a different workspace and a different tmux session cannot be adopted', async () => {
  const d = daemon()
  for (const fields of [{ entrypoint: 'sdk-cli' }, { cwd: d.dir + '/elsewhere' }, { tmux: 'other:@1.%1' }]) {
    d.put(fields)
    await d.main.tick()
    expect(d.main.currentGen()).toBeNull()
  }
  expect(d.notices).toBeEmpty()
})

test('WO-209 (10) the earlier gen was cut bare; one registry adoption gives its continuation to the already-running TUI', async () => {
  const d = daemon(), oldSid = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  d.env.expectedSession = () => [oldSid, sid]
  await d.main.mainEvent({ event: 'SessionStart', session_id: oldSid, pid: 456 })
  await d.main.mainEvent({ event: 'UserPromptSubmit', session_id: oldSid, pid: 456, prompt_id: 'cut' })
  const sub = join(d.dir, oldSid, 'subagents')
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(sub, 'agent-one.jsonl'), '{}\n')
  await d.main.mainEvent({ event: 'SessionEnd', session_id: oldSid, pid: 456 })
  d.put()
  const journal = new Journal(d.journal.path)
  journal.load()
  const restarted = createMain({ ...d.env, journal })
  restarted.initMain()
  await restarted.tick()
  restarted.registryChanged()
  await restarted.tick()
  expect(restarted.currentGen()).toMatchObject({ pid, session_id: sid, source: 'adopt', state: 'idle', resumes: 1 })
  expect(d.offers).toHaveLength(1)
  expect((d.offers[0].params as any).content).toContain('當時有 1 個背景工作在跑，重開後已經不在。')
  expect(journal.rows('msg')).toBeEmpty()
})

test('WO-205 (f) the agent-inbox daemon relays M2\'s registry alert to BTCC with its own credential (POST /lanes/registry-alert)', async () => {
  const { createServer } = await import('node:http')
  const L = await import('./lanes.ts?wo205-relay') as typeof import('./lanes.ts')
  const dir = mkdtempSync(join(tmpdir(), 'wo205-relay-'))
  process.env.LANES_DIR = join(dir, '.lanes')
  const sent: Array<Record<string, unknown>> = []
  L.lanesInit({ role: 'inbox', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => true,
    registryAlert: async (a: Record<string, unknown>) => { sent.push(a); return 'HTTP 200' } } as any)
  const srv = createServer(async (req, res) => { if (!(await L.handleLanesHttp(new URL(req.url ?? '/', 'http://127.0.0.1'), req, res))) res.writeHead(404).end() })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  cleanup.push(() => { srv.close(); rmSync(dir, { recursive: true, force: true }); delete process.env.LANES_DIR })
  const post = async (b: object) => (await fetch(`http://127.0.0.1:${(srv.address() as any).port}/lanes/registry-alert`, { method: 'POST', body: JSON.stringify(b),
    headers: { 'Content-Type': 'application/json' } })).json()
  expect(await post({ state: 'open', session: sid, pid, why: 'not expected (main-expected)', agent: 'someone-else' })).toEqual({ text: 'HTTP 200', ok: true })
  expect(await post({ state: 'clear', session: sid })).toEqual({ text: 'HTTP 200', ok: true })
  // only the fields BTCC takes: the agent comes from the credential there, never from the relayed body
  expect(sent).toEqual([{ state: 'open', session: sid, pid, why: 'not expected (main-expected)' }, { state: 'clear' }])
})
