import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  const offers: Notif[] = [], notices: string[] = [], logs: string[] = []
  const os = { alive: true, start: '3154' as string | null }
  const registry = new Registry({ dir, workspace: dir, tmux: 'adam', transcripts: () => dir, sessionId: () => sid,
    connected: () => true, alive: () => os.alive, procStart: () => os.start, changed: () => main.registryChanged() })
  const env: MainEnv = { journal, registry, agent: 'adam', log: (_level, text) => logs.push(text),
    offer: async n => { offers.push(n); return true }, streamOpen: () => true, expectedSession: () => [sid],
    pidAlive: () => os.alive, tellJoey: (text, rule) => notices.push(`${rule} ${text}`),
    info: () => null, done() {}, undone() {}, refused() {}, genChanged() {}, context: () => '' }
  const main = createMain(env)
  main.initMain()
  const put = (fields: object = {}) => writeFileSync(join(dir, `${pid}.json`), JSON.stringify({
    pid, sessionId: sid, kind: 'interactive', entrypoint: 'cli', cwd: dir, tmux: 'adam:@1.%1', status: 'idle', procStart: '3154', ...fields }))
  cleanup.push(() => { registry.stop(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, registry, main, env, journal, os, put, offers, notices, logs }
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

test('WO-205 (b) disagreement lasts a full settling interval, is told once, and rearms after a live gen', async () => {
  const d = daemon(), stranger = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  const since = Date.now()
  d.put({ sessionId: stranger })
  await d.main.tick(since)
  await d.main.tick(since + REG_SETTLE_MS - 1)
  expect(d.main.currentGen()).toBeNull()
  expect(d.notices).toBeEmpty()
  await d.main.tick(since + REG_SETTLE_MS)
  await d.main.tick(since + REG_SETTLE_MS * 2)
  expect(d.notices).toHaveLength(1)
  for (const field of ['main-registry-disagreement', 'adam', stranger, String(pid), 'not expected']) expect(d.notices[0]).toContain(field)
  expect(d.logs.filter(s => s.includes('not expected'))).toHaveLength(1)
  expect(d.main.currentGen()).toBeNull()
  await d.main.mainEvent({ event: 'SessionStart', pid: 456, session_id: sid })
  await d.main.mainEvent({ event: 'SessionEnd', pid: 456, session_id: sid })
  await d.main.tick(since + REG_SETTLE_MS * 3)
  await d.main.tick(since + REG_SETTLE_MS * 4)
  expect(d.notices).toHaveLength(2)
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
  expect(d.notices[0]).toContain('procStart mismatch')
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
