// Onsen step 3 (WO-143): delivery facts (delivered / seen / turn_end of Joey's messages) and the main's status, recorded through the spool. Facts only:
// nothing here sends to Telegram or changes a delivery. A stand-in Onsen (a fake fetch), a real lanes instance in a temp dir (no model, no network), a
// transcript written by the test (lanes off).
import { test, expect, describe, afterAll } from 'bun:test'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { spawnSync } from 'child_process'
import { idemDelivery, idemStatus, type DeliveryFact, type StatusFact } from './onsen-client.ts'
import { DeliveryFacts, HANDLED_HERE, StatusFacts, statusOf, LanesTap, TurnWatch, Registry, Streams, channelTags, compareRegistry, pickMain, regEntry, sameStart, osProcStart, SharedCli, runCli, pidAlive, REG_SETTLE_MS, type JoeyOf,
  type RegEntry, type StatusInputs, type StatusSource } from './onsen-status.ts'

const AGENT = 'adam'
const JOEY = '1828'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('delivery facts', () => {
  test('WO-197: a message the daemon handled itself: delivered (took) and turn_end by daemon with how it ended; never queued, no ✍, no turn, nothing bound', () => {
    const out: DeliveryFact[] = [], seen: string[] = []
    let changed = 0
    const F = new DeliveryFacts({ agent: AGENT, sink: f => out.push(f), onSeen: (_c, id) => seen.push(id), changed: () => { changed++ } })
    F.took(JOEY, 30, '2026-11-26T15:00:00.000Z')
    expect(F.queued('in_session')).toBe(0); expect(F.queued('seen')).toBe(0)
    F.handledHere(JOEY, 30, 'done', 'command', '2026-11-26T15:00:01.000Z')
    F.took(JOEY, 31); F.handledHere(JOEY, 31, 'failed', 'permission')
    F.handledHere(JOEY, 31, 'done', 'permission')                                 // once per (message, state): the first stands
    expect(out.map(f => `${f.client_msg_id}:${f.state}${f.by ? `:${f.by}` : ''}`)).toEqual(['30:delivered', `30:turn_end:${HANDLED_HERE}`, '31:delivered', `31:turn_end:${HANDLED_HERE}`])
    expect(out[0]).toMatchObject({ at: '2026-11-26T15:00:00.000Z', idem_key: `tg:${AGENT}:${JOEY}:dlv:30:delivered` })
    expect(out[0].by).toBeUndefined()
    expect(out[1]).toMatchObject({ at: '2026-11-26T15:00:01.000Z', outcome: 'done', detail: { handled_here: 'command' }, idem_key: `tg:${AGENT}:${JOEY}:dlv:30:turn_end` })
    expect(out[3]).toMatchObject({ outcome: 'failed', detail: { handled_here: 'permission' } })
    expect(out.some(f => f.turn_id != null || f.bound != null)).toBe(false)
    expect(HANDLED_HERE).not.toBe('main')
    expect(seen).toEqual([]); expect(changed).toBe(0)
    expect(F.counts()).toEqual({ pending: 0, unread_by_member: 0 })
    // not the daemon's own after all (a slash text it does not know): took, then delivered by the path of every message: counted from there, one fact
    F.took(JOEY, 32); F.delivered(JOEY, 32)
    expect(out.filter(f => f.client_msg_id === '32').map(f => f.state)).toEqual(['delivered'])
    expect(F.queued('in_session')).toBe(1)
  })

  test('one per (message, state); an album: every item; turn_end waits for the status record to show the turn over (WO-177: no timer), a continued turn cancels it, a new prompt flushes it', async () => {
    const out: DeliveryFact[] = []
    const F = new DeliveryFacts({ agent: AGENT, sink: f => out.push(f) })
    F.album(JOEY, ['10', '11', '12'])
    for (const id of [10, 11, 12]) F.delivered(JOEY, id)
    F.inSession(JOEY, 10, 'main')                                                 // WO-165: handed to the session, not in a turn yet
    expect(out.filter(f => f.state === 'in_session').map(f => f.client_msg_id)).toEqual(['10', '11', '12'])
    expect(out.some(f => f.state === 'seen')).toBe(false)
    expect(F.queued('in_session')).toBe(0); expect(F.queued('seen')).toBe(3)
    F.seen(JOEY, 10, 'main')
    expect(out.filter(f => f.state === 'seen').map(f => f.client_msg_id)).toEqual(['10', '11', '12'])
    expect(F.queued('in_session')).toBe(0); expect(F.queued('seen')).toBe(0)
    F.seen(JOEY, 10, 'lane-x'); F.inSession(JOEY, 10, 'lane-x')                   // a second recipient: the first wins (not spooled again)
    expect(out.filter(f => f.state === 'seen').length).toBe(3)
    expect(out.filter(f => f.state === 'in_session').length).toBe(3)
    expect(out.find(f => f.state === 'in_session')).toMatchObject({ by: 'main', idem_key: `tg:${AGENT}:${JOEY}:dlv:10:in_session` })
    F.turnEndLater(JOEY, 10, 'main', '2026-11-25T10:00:00.000Z')
    F.statusRecord('busy')                                                       // the record still shows the turn running: nothing yet
    F.cancelTurnEnd(JOEY, 10, 'main')                                            // the turn went on (another Stop hook held it)
    F.statusRecord('idle')
    expect(out.some(f => f.state === 'turn_end')).toBe(false)
    F.turnEndLater(JOEY, 10, 'main', '2026-11-25T10:05:00.000Z', { reason: 'asked_restart' })
    F.statusRecord('idle')
    const te = out.filter(f => f.state === 'turn_end')
    expect(te.map(f => f.client_msg_id)).toEqual(['10', '11', '12'])
    expect(te[0]).toMatchObject({ at: '2026-11-25T10:05:00.000Z', by: 'main', detail: { reason: 'asked_restart' }, idem_key: `tg:${AGENT}:${JOEY}:dlv:10:turn_end` })
    F.delivered(JOEY, 20); F.seen(JOEY, 20, 'main')
    F.turnEndLater(JOEY, 20, 'main', '2026-11-25T11:00:00.000Z')
    expect(F.pendingLater()).toBe(1)
    F.flushLater('main')
    expect(out.at(-1)).toMatchObject({ client_msg_id: '20', state: 'turn_end', at: '2026-11-25T11:00:00.000Z' })
    expect(F.pendingLater()).toBe(0)
  })
})

describe('status', () => {
  test('1.45.1 the one rule: the registry status is the state (shell idle, waiting, busy or stuck past the threshold); offline says why; the rest is detail', () => {
    const now = Date.parse('2026-11-25T10:00:00.000Z')
    const turn = { turn_started_at: 't0', tool: { name: 'Bash', started_at: 't1' }, subagents: 1 }
    const I = (o: Partial<StatusInputs>): StatusInputs => ({ main: { status: 'busy' }, last_activity_at: '2026-11-25T09:59:00.000Z', queued_joey: 0, ...o })
    const at = (v: any) => statusOf(v, { now, stuckS: 600 })
    for (const reason of ['no_registration', 'pid_gone', 'pid_reused', 'not_connected'] as const)
      expect(at(I({ main: null, offline: reason, turn }))).toEqual({ state: 'offline', detail: { reason, queued_joey: 0 }, last_activity_at: '2026-11-25T09:59:00.000Z' })
    expect(at(I({ main: null, last_activity_at: null })).detail).toEqual({ reason: 'no_registration', queued_joey: 0 })
    expect(at(I({ main: { status: 'idle' }, queued_joey: 2 }))).toEqual({ state: 'idle', detail: { queued_joey: 2 }, last_activity_at: '2026-11-25T09:59:00.000Z' })
    expect(at(I({ main: { status: 'shell' } })).detail).toEqual({ background_shell: true, queued_joey: 0 })
    expect(at(I({ main: { status: 'waiting', waiting_for: 'permission prompt' }, turn })))
      .toEqual({ state: 'waiting', detail: { waitingFor: 'permission prompt', turn_started_at: 't0', tool: { name: 'Bash', since: 't1' }, subagents: 1, queued_joey: 0 }, last_activity_at: '2026-11-25T09:59:00.000Z' })
    expect(at(I({ turn, queued_joey: 3 }))).toEqual({ state: 'busy', detail: { turn_started_at: 't0', tool: { name: 'Bash', since: 't1' }, subagents: 1, queued_joey: 3 }, last_activity_at: '2026-11-25T09:59:00.000Z' })
    expect(at(I({})).detail).toEqual({ queued_joey: 0 })                                            // no turn known (no hook, no transcript): no turn fields
    // stuck: busy and nothing written for longer than the threshold (600 s here): 10 min exactly is not past it
    expect(at(I({ last_activity_at: '2026-11-25T09:50:00.000Z' })).state).toBe('busy')
    expect(at(I({ last_activity_at: '2026-11-25T09:49:59.000Z', turn }))).toEqual({ state: 'stuck', detail: { threshold_s: 600, turn_started_at: 't0', tool: { name: 'Bash', since: 't1' }, subagents: 1, queued_joey: 0 }, last_activity_at: '2026-11-25T09:49:59.000Z' })
    expect(at(I({ last_activity_at: null })).state).toBe('busy')                                    // nothing known: not stuck
    expect(at(I({ main: { status: 'waiting' }, last_activity_at: '2026-11-25T08:00:00.000Z' })).state).toBe('waiting')   // waiting is never stuck
    expect(at(I({ main: { status: 'idle' }, last_activity_at: '2026-11-25T08:00:00.000Z' })).state).toBe('idle')
    // detail: the usage wall, a compaction; a status this rule does not know: busy, named
    expect(at(I({ main: { status: 'idle' }, walled: { until: '2026-11-25T12:00:00Z', kind: 'rate_limit' }, compacting: true })).detail)
      .toEqual({ queued_joey: 0, walled: { until: '2026-11-25T12:00:00Z', kind: 'rate_limit' }, compacting: true })
    expect(at(I({ main: { status: 'thinking' } })).detail).toEqual({ registry_status: 'thinking', queued_joey: 0 })
    process.env.ONSEN_STUCK_S = '30'
    try { expect(statusOf(I({ last_activity_at: new Date(Date.now() - 31_000).toISOString() })).state).toBe('stuck') } finally { delete process.env.ONSEN_STUCK_S }
    expect(statusOf(I({ last_activity_at: new Date(Date.now() - 31_000).toISOString() })).state).toBe('busy')   // the default: 600 s
  })

  test('WO-162: a state change and every detail change at once (each tool starting and ending); the same detail: nothing', async () => {
    const out: StatusFact[] = []
    const S = new StatusFacts({ agent: AGENT, sink: f => out.push(f), throttleMs: 120, heartbeatMs: 0 })
    const b = (tool: string | null) => ({ state: 'busy' as const, detail: { turn_started_at: 't', tool: tool ? { name: tool, started_at: 't' } : null, subagents: 0, queued_joey: 0 } })
    S.update({ state: 'idle' })
    S.update({ state: 'idle' })
    S.update(b(null))
    S.update(b('Read')); S.update(b(null)); S.update(b('Bash'))                  // a tool starting and ending, then another: each at once
    expect(out.map(f => (f.detail as any)?.tool?.name ?? f.state)).toEqual(['idle', 'busy', 'Read', 'busy', 'Bash'])
    S.update(b('Bash'))                                                           // nothing new
    await sleep(150)
    expect(out.length).toBe(5)
    S.update({ state: 'waiting', detail: { waitingFor: 'permission prompt', queued_joey: 0 } })
    S.update({ state: 'idle', detail: { dialog_open: true, queued_joey: 0 } })
    S.update({ state: 'idle', detail: { queued_joey: 0 } })                       // dialog_open going away: at once
    S.update({ state: 'idle', detail: { queued_joey: 1 } })                       // a count: at once too
    expect(out.slice(5).map(f => JSON.stringify(f.detail))).toEqual(['{"waitingFor":"permission prompt","queued_joey":0}', '{"dialog_open":true,"queued_joey":0}',
      '{"queued_joey":0}', '{"queued_joey":1}'])
    expect(new Set(out.map(f => f.idem_key)).size).toBe(out.length)
    for (const f of out) expect(f.idem_key).toBe(`tg:${AGENT}:st:${Date.parse(f.at)}:${f.state}`)
    expect(S.current()?.state).toBe('idle')
    S.stop()
  })

  test('1.45.1 last_activity_at: a top-level field of every item (null when unknown); WO-162: its change alone is throttled (the latest), a state change carries the latest', async () => {
    const out: StatusFact[] = []
    const S = new StatusFacts({ agent: AGENT, sink: f => out.push(f), throttleMs: 100, heartbeatMs: 0 })
    S.update({ state: 'offline', detail: { reason: 'no_registration', queued_joey: 0 }, last_activity_at: null })
    expect(out[0]).toMatchObject({ state: 'offline', last_activity_at: null })
    S.update({ state: 'busy', detail: { queued_joey: 0 }, last_activity_at: 'a1' })
    S.update({ state: 'busy', detail: { queued_joey: 0 }, last_activity_at: 'a2' })
    S.update({ state: 'busy', detail: { queued_joey: 0 }, last_activity_at: 'a3' })
    expect(out.map(f => f.last_activity_at)).toEqual([null, 'a1'])
    await sleep(150)
    expect(out.map(f => f.last_activity_at)).toEqual([null, 'a1', 'a3'])
    S.update({ state: 'busy', detail: { queued_joey: 0 }, last_activity_at: 'a3' })
    S.update({ state: 'stuck', detail: { threshold_s: 600, queued_joey: 0 }, last_activity_at: 'a3' })
    expect(out.map(f => `${f.state}:${f.last_activity_at}`)).toEqual(['offline:null', 'busy:a1', 'busy:a3', 'stuck:a3'])
    S.stop()
  })
})

// ------------------------------------------------------------------ 1.45.1: the state from Claude Code's session registry (a stand-in dir and transcripts)
describe('the registry: which session is the main, offline and why, files vs the CLI, last_activity_at, the watch', () => {
  const WS = mkdtempSync(join(tmpdir(), 'onsen-ws-'))
  const START = 'Tue Nov 24 18:16:31 2026'
  const reg = (pid: number, o: Record<string, unknown> = {}) => ({ pid, sessionId: randomUUID(), cwd: WS, startedAt: 1_795_544_217_000, procStart: START, version: '2.1.322',
    kind: 'interactive', entrypoint: 'cli', tmux: 'claude-x:@1.%1', name: 'x', status: 'idle', updatedAt: 1, statusUpdatedAt: 1, ...o })
  function setup(o: { tmux?: string; sessionId?: () => string | null; cli?: () => Promise<string | null>; alive?: (p: number) => boolean; start?: (p: number) => string | null; now?: () => number } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'onsen-reg-')), tx = mkdtempSync(join(tmpdir(), 'onsen-tx-'))
    const up = new Set<number>(), logs: string[] = []
    let changed = 0
    const R = new Registry({ dir, workspace: WS, transcripts: () => tx, connected: p => up.has(p), tmux: o.tmux, sessionId: o.sessionId, cli: o.cli, log: m => logs.push(m),
      changed: () => { changed++ }, alive: o.alive ?? (() => true), procStart: o.start ?? (() => START), retryMs: 20, ...(o.now ? { now: o.now } : {}) })
    const put = (e: Record<string, unknown>) => writeFileSync(join(dir, `${e.pid}.json`), JSON.stringify(e))
    const st = (sh: any = { queuedJoey: 0, wall: null }) => statusOf(R.inputs(sh))
    return { R, dir, tx, up, logs, put, st, changes: () => changed }
  }

  test('the main: an interactive session of this workspace (not a lane\'s -p run, not another folder); the tmux session when set; the lanes\' session id first; else the newest', () => {
    const a = regEntry(reg(11, { startedAt: 1 }))!, b = regEntry(reg(12, { startedAt: 2, tmux: 'other:@1.%1' }))!, lane = regEntry(reg(13, { kind: 'sdk-cli', startedAt: 9 }))!
    const away = regEntry(reg(14, { cwd: '/elsewhere', startedAt: 9 }))!
    expect(pickMain([a, b, lane, away], { workspace: WS })?.pid).toBe(12)
    expect(pickMain([a, b, lane, away], { workspace: WS, tmux: 'claude-x' })?.pid).toBe(11)
    expect(pickMain([a, b], { workspace: WS, sessionId: a.sessionId })?.pid).toBe(11)
    expect(pickMain([a, b], { workspace: WS, sessionId: 'unknown' })?.pid).toBe(12)            // a session id the registry does not have: the newest
    expect(pickMain([a, b], { workspace: WS, alive: p => p !== 12 })?.pid).toBe(11)              // the newest live one
    expect(pickMain([lane, away], { workspace: WS })).toBe(null)
    expect(regEntry({ pid: 5, sessionId: 's' })).toBe(null)
  })

  test('offline: no_registration, not_connected, pid_gone; then the registry\'s own status (pid_reused: the next test)', () => {
    let alive = true, t = 1_000_000
    const { put, up, st, dir } = setup({ alive: () => alive, now: () => t })
    expect(st()).toMatchObject({ state: 'offline', detail: { reason: 'no_registration' } })
    put(reg(21, { status: 'busy' }))
    expect(st().detail).toMatchObject({ reason: 'not_connected' })
    up.add(21)
    expect(st().state).toBe('busy')
    alive = false
    expect(st().state).toBe('busy')                                        // dead, file still there: a normal close may delete it within DEAD_GRACE_MS
    t += 3_001
    expect(st().detail).toMatchObject({ reason: 'pid_gone' })              // the file stayed: killed / crashed
    alive = true
    expect(st().state).toBe('busy')
    up.delete(21)
    expect(st().detail).toMatchObject({ reason: 'not_connected' })
    // 1.47.0: a normal close: the process ends, then Claude Code deletes its file within the grace → no_registration, not pid_gone
    up.add(21); expect(st().state).toBe('busy')
    alive = false; t += 500
    expect(st().state).toBe('busy')
    rmSync(join(dir, '21.json')); t += 500
    expect(st()).toMatchObject({ state: 'offline', detail: { reason: 'no_registration' } })
  })

  test('1.47.2: a non-interactive file of this workspace (a lane\'s -p run) in an odd shape does not send the read to the CLI', () => {
    const { R, put, up, st, logs } = setup()
    put(reg(41, { status: 'busy' })); up.add(41)
    writeFileSync(join(R.o.dir, '42.json'), JSON.stringify({ pid: 42, sessionId: 's42', cwd: WS, kind: 'sdk-cli', status: 'running' }))
    expect(st().state).toBe('busy')
    expect(R.files().bad).toEqual([])
    expect(logs.some(l => /not in the known shape/.test(l))).toBe(false)
    writeFileSync(join(R.o.dir, '43.json'), JSON.stringify({ pid: 43, sessionId: 's43', cwd: WS, kind: 'interactive', status: 'idle' }))   // no procStart
    const o43 = (Date.now() - 10_000) / 1000; utimesSync(join(R.o.dir, '43.json'), o43, o43)              // 1.48.1: past the young-file grace
    expect(R.files().bad).toEqual(['43.json'])
  })

  test('1.47.3: a lane run registers as interactive with entrypoint sdk-cli: never the main, and its odd shape never sends the read to the CLI', () => {
    const { R, put, up, st } = setup({ tmux: 'claude-x' })
    put(reg(51, { status: 'idle', entrypoint: 'cli', startedAt: 1 })); up.add(51)
    put(reg(52, { status: 'busy', entrypoint: 'sdk-cli', startedAt: 9, tmux: undefined }))      // newer, no tmux: passed the tmux filter before
    expect(st().state).toBe('idle')
    expect(R.main()?.pid).toBe(51)
    writeFileSync(join(R.o.dir, '53.json'), JSON.stringify({ pid: 53, sessionId: 's53', cwd: WS, kind: 'interactive', entrypoint: 'sdk-cli', status: 'starting' }))
    expect(R.files().bad).toEqual([])
  })

  test('1.48.1: a registry file that was just written is not judged by its shape yet', () => {
    const { R } = setup()
    const f = join(R.o.dir, '61.json')
    writeFileSync(f, JSON.stringify({ pid: 61, sessionId: 's61', cwd: WS, kind: 'interactive', entrypoint: 'cli', status: 'idle' }))   // no procStart yet
    expect(R.files().bad).toEqual([])
    const old = (Date.now() - 10_000) / 1000
    utimesSync(f, old, old)
    expect(R.files().bad).toEqual(['61.json'])
  })

  test('pid_reused: the OS start time is read at most every 30 s; the same second in another wording is the same start', () => {
    let t = 1_000_000, osStart: string | null = START, reads = 0
    const dir = mkdtempSync(join(tmpdir(), 'onsen-reg-'))
    const R = new Registry({ dir, workspace: WS, transcripts: () => null, connected: () => true, alive: () => true, procStart: () => { reads++; return osStart }, now: () => t })
    writeFileSync(join(dir, '31.json'), JSON.stringify(reg(31)))
    expect(statusOf(R.inputs({ queuedJoey: 0, wall: null })).state).toBe('idle')
    osStart = 'Wed Nov 25 01:02:03 2026'
    expect(statusOf(R.inputs({ queuedJoey: 0, wall: null })).state).toBe('idle')
    t += 30_001
    expect(statusOf(R.inputs({ queuedJoey: 0, wall: null }))).toMatchObject({ state: 'offline', detail: { reason: 'pid_reused' } })
    expect(reads).toBe(2)
    expect(sameStart('Tue Nov 24 18:16:31 2026', 'Tue Nov 24 18:16:31 2026')).toBe(true)
    expect(sameStart('Tue Nov  4 08:06:31 2026', 'Tue Nov 4 08:06:32 2026')).toBe(true)
    expect(sameStart('Tue Nov 24 18:16:31 2026', 'Tue Nov 24 18:16:51 2026')).toBe(false)
    expect(sameStart('Tue Nov 24 18:16:31 2026', '1795544191')).toBe(true)                      // a wording neither side can read: not taken as reused
    // WO-187: Linux's procStart is /proc stat field 22 (ticks since boot); a tick count never goes to Date.parse ("3154 UTC" = the year 3154)
    expect(sameStart('Thu Nov 26 07:46:12 2026', '3154')).toBe(true)                              // a tick count and a date: cannot be compared
    expect(sameStart('3154', '3154')).toBe(true)
    expect(sameStart('3154', '9999')).toBe(false)                                                  // another process on that pid
    for (const v of ['1600', '21100', '99999', '275760']) expect(sameStart(v, v)).toBe(true)
  })

  test('WO-187 pid_reused on Linux: the registry\'s tick count against the OS tick count, the same: not reused; another: pid_reused', () => {
    let t = 1_000_000, osStart: string | null = '3154'
    const dir = mkdtempSync(join(tmpdir(), 'onsen-reg-'))
    const R = new Registry({ dir, workspace: WS, transcripts: () => null, connected: () => true, alive: () => true, procStart: () => osStart, now: () => t })
    writeFileSync(join(dir, '32.json'), JSON.stringify(reg(32, { procStart: '3154' })))
    expect(statusOf(R.inputs({ queuedJoey: 0, wall: null })).state).toBe('idle')
    osStart = '9999'
    t += 30_001
    expect(statusOf(R.inputs({ queuedJoey: 0, wall: null }))).toMatchObject({ state: 'offline', detail: { reason: 'pid_reused' } })
  })

  test.skipIf(process.platform !== 'linux')('WO-187 osProcStart on Linux: this process\'s /proc stat field 22, digits only', () => {
    expect(osProcStart(process.pid)).toMatch(/^\d+$/)
  })

  test('the registry\'s status: idle, shell (idle, background_shell), waiting (waitingFor), busy; a file read while written keeps its last reading', () => {
    const { put, up, st, dir } = setup()
    up.add(41)
    put(reg(41, { status: 'shell' }))
    expect(st()).toMatchObject({ state: 'idle', detail: { background_shell: true } })
    put(reg(41, { status: 'waiting', waitingFor: 'permission prompt', updatedAt: 2 }))
    expect(st()).toMatchObject({ state: 'waiting', detail: { waitingFor: 'permission prompt' } })
    writeFileSync(join(dir, '41.json'), '{"pid": 41, "sess')                                      // half written
    expect(st().state).toBe('waiting')
    put(reg(41, { status: 'busy', updatedAt: 3 }))
    expect(st().state).toBe('busy')
    rmSync(join(dir, '41.json'))                                                                // the session ended (Claude Code removes its file)
    expect(st().detail).toMatchObject({ reason: 'no_registration' })
  })

  test('last_activity_at: the newest write to <session>.jsonl and <session>/subagents/*.jsonl; stuck when busy and older than ONSEN_STUCK_S', () => {
    const { put, up, tx, R } = setup()
    const e = reg(51, { status: 'busy' })
    put(e); up.add(51)
    const main = join(tx, `${e.sessionId}.jsonl`)
    writeFileSync(main, '{}\n')
    const old = (s: number) => new Date(Date.now() - s * 1000)
    utimesSync(main, old(900), old(900))
    const v1 = statusOf(R.inputs({ queuedJoey: 0, wall: null }), { stuckS: 600 })
    expect(v1).toMatchObject({ state: 'stuck', detail: { threshold_s: 600 } })
    expect(Math.abs(Date.parse(v1.last_activity_at!) - old(900).getTime())).toBeLessThan(1500)
    mkdirSync(join(tx, e.sessionId, 'subagents'), { recursive: true })
    const sub = join(tx, e.sessionId, 'subagents', 'agent-a1.jsonl')
    writeFileSync(sub, '{}\n'); utimesSync(sub, old(60), old(60))                               // a subagent wrote a minute ago: the main is alive
    const v2 = statusOf(R.inputs({ queuedJoey: 0, wall: null }), { stuckS: 600 })
    expect(v2.state).toBe('busy')
    expect(Math.abs(Date.parse(v2.last_activity_at!) - old(60).getTime())).toBeLessThan(1500)
    expect(R.lastActivity(null)).toBe(v2.last_activity_at!)                                   // no session known: the workspace's newest transcript
  })

  test('the CLI: agreeing (a file\'s shell is the CLI\'s busy) keeps the files; a difference read twice switches to the CLI and is logged; agreeing again switches back', async () => {
    let cliOut: string | null = '[]'
    const { R, put, up, logs, st } = setup({ cli: async () => cliOut })
    const e = reg(61, { status: 'shell' })
    put(e); up.add(61)
    const asCli = (x: any, status = x.status === 'shell' ? 'busy' : x.status) => ({ pid: x.pid, cwd: x.cwd, kind: x.kind, startedAt: x.startedAt, sessionId: x.sessionId, name: x.name, status })
    cliOut = JSON.stringify([asCli(e), asCli(reg(62, { cwd: join(WS, 'sub') }))])                // --cwd lists sessions under the folder: only this folder counts
    expect(await R.crossCheck()).toMatchObject({ agree: true, why: null })
    expect(R.mode().via).toBe('files')
    cliOut = JSON.stringify([asCli(e, 'waiting')])
    expect(await R.crossCheck()).toMatchObject({ agree: false, why: expect.stringContaining('status shell in the file, waiting from the cli') })
    expect(R.mode().via).toBe('cli')
    expect(logs.some(l => l.includes('disagree'))).toBe(true)
    expect(st().state).toBe('waiting')                                                          // the CLI's reading is the one in force
    cliOut = JSON.stringify([asCli(e)])
    expect(await R.crossCheck()).toMatchObject({ agree: true })
    expect(R.mode().via).toBe('files')
    expect(logs.some(l => l.includes('agree with'))).toBe(true)
    cliOut = null                                                                               // the CLI does not answer: nothing to compare, the files stay
    await R.crossCheck()
    expect(R.mode().via).toBe('files')
    expect(compareRegistry([regEntry(reg(71))!], [], WS, () => false)).toBe(null)                  // a dead pid's file left behind is not a session
    expect(compareRegistry([regEntry(reg(71))!], [], WS, () => true)).toContain('sessions differ')
  })

  test('1.48.3: a file of this workspace in another shape is read as far as it goes, logged once, and never runs the CLI by itself', async () => {
    let cliCalls = 0
    const e = reg(81, { status: 'busy' })
    const { put, up, logs, st, R } = setup({ cli: async () => { cliCalls++; return JSON.stringify([{ pid: 81, cwd: WS, kind: 'interactive', sessionId: e.sessionId, status: 'busy' }]) } })
    up.add(81)
    put({ ...e, procStart: undefined, status: 'starting' })                                        // no procStart, a status statusOf does not know
    const o81 = (Date.now() - 10_000) / 1000; utimesSync(join(R.o.dir, '81.json'), o81, o81)              // past the young-file grace
    for (let i = 0; i < 20; i++) st()                                                            // the 2 s tick, many times
    await sleep(20)
    expect(R.mode().via).toBe('files')
    expect(st()).toMatchObject({ state: 'busy', detail: { registry_status: 'starting' } })
    expect(logs.filter(l => l.includes('not in the known shape')).length).toBe(1)
    expect(cliCalls).toBe(0)
    const { status: _s, ...noStatus } = e
    put({ ...noStatus, state: 'working' })                                                       // without the fields regEntry needs: not a session
    utimesSync(join(R.o.dir, '81.json'), o81, o81)
    expect(st().detail).toMatchObject({ reason: 'no_registration' })
    expect(cliCalls).toBe(0)
  })

  test('1.48.3: the comparison leaves out a file in another shape younger than REG_SETTLE_MS (a fleet restarting at once)', async () => {
    const e = reg(82, { status: 'idle' })
    const asCli = (x: any) => JSON.stringify([{ pid: x.pid, cwd: WS, kind: 'interactive', sessionId: x.sessionId, status: x.status }])
    const { put, R } = setup({ cli: async () => asCli(e) })
    put({ pid: 82, sessionId: e.sessionId, cwd: WS, kind: 'interactive', entrypoint: 'cli' })     // still being filled in: no status yet
    const o = (Date.now() - 10_000) / 1000; utimesSync(join(R.o.dir, '82.json'), o, o)               // past REG_YOUNG_MS, within REG_SETTLE_MS
    expect(await R.crossCheck()).toMatchObject({ agree: true })
    expect(R.mode().via).toBe('files')
    const old = (Date.now() - REG_SETTLE_MS - 1_000) / 1000; utimesSync(join(R.o.dir, '82.json'), old, old)
    expect(await R.crossCheck()).toMatchObject({ agree: false, why: expect.stringContaining('sessions differ') })
  })

  test('1.48.3: one CLI read in flight per daemon: concurrent comparisons and polls share it', async () => {
    let calls = 0, release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const e = reg(83, { status: 'idle' })
    const { put, R } = setup({ cli: async () => { calls++; await gate; return JSON.stringify([{ pid: 83, cwd: WS, kind: 'interactive', sessionId: e.sessionId, status: 'idle' }]) } })
    put(e)
    const all = [R.crossCheck(), R.crossCheck(), R.crossCheck()]
    await sleep(10)
    expect(calls).toBe(1)
    release()
    for (const c of await Promise.all(all)) expect(c).toMatchObject({ agree: true })
    expect(calls).toBe(1)
  })

  test('1.48.3 runCli: a run still going at its timeout is killed (SIGKILL) and answers null; a normal run answers its stdout', async () => {
    const bin = join(mkdtempSync(join(tmpdir(), 'onsen-bin-')), 'slow.sh'), pidf = `${bin}.pid`
    writeFileSync(bin, `#!/bin/sh\ntrap '' TERM\necho $$ > ${pidf}\nsleep 30\n`, { mode: 0o755 })              // ignores SIGTERM
    const t0 = performance.now()
    expect(await runCli(bin, [], 400)).toBe(null)
    expect(performance.now() - t0).toBeLessThan(2_000)
    await sleep(100)
    const pid = Number(readFileSync(pidf, 'utf8'))
    expect(pidAlive(pid)).toBe(false)
    expect(await runCli('/bin/echo', ['[1]'], 2_000)).toBe('[1]\n')
    expect(await runCli('/bin/sh', ['-c', 'exit 3'], 2_000)).toBe(null)
  })

  test('1.48.3 SharedCli: readers that come together share one run; a failed run is shared too; a newer answer can be asked for; a dead holder\'s lock is taken over', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onsen-shared-'))
    let runs = 0, out: string | null = '[]'
    const run = async () => { runs++; await sleep(150); return out }
    const S = Array.from({ length: 8 }, () => new SharedCli({ dir, run, stepMs: 20 }))           // eight daemons
    const t = Date.now()
    expect(await Promise.all(S.map(s => s.read(t - 5_000)))).toEqual(Array(8).fill('[]'))
    expect(runs).toBe(1)
    expect(await S[3].read(t - 5_000)).toBe('[]')                                                // the cached answer: no run
    expect(runs).toBe(1)
    out = null
    const n = Date.now()
    expect(await Promise.all(S.map(s => s.read(n)))).toEqual(Array(8).fill(null))                // asked newer than the cache: one new run, failed, shared
    expect(runs).toBe(2)
    writeFileSync(join(dir, 'agents-cli.lock'), JSON.stringify({ pid: 999_999, at: Date.now() }))  // a holder that died just now: its run may still go
    expect(await new SharedCli({ dir, run, stepMs: 20, waitMs: 200 }).read(Date.now())).toBe(null)   // 1.48.4: not taken over before deadHolderMs
    expect(runs).toBe(2)
    writeFileSync(join(dir, 'agents-cli.lock'), JSON.stringify({ pid: 999_999, at: Date.now() - 30_000 }))  // died 30 s ago: past its run's deadline
    out = '[2]'
    expect(await S[0].read(Date.now())).toBe('[2]')
    expect(runs).toBe(3)
    writeFileSync(join(dir, 'agents-cli.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }))  // a live holder that never finishes
    const W = new SharedCli({ dir, run, stepMs: 20, waitMs: 200 })
    expect(await W.read(Date.now())).toBe(null)                                                  // waits waitMs, then gives up without running
    expect(runs).toBe(3)
  })

  test('1.48.4 SharedCli: a holder that died mid-run: its run is killed (only that process), then the lock is taken over; a holder never frees a successor\'s lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onsen-shared-crash-')), bin = join(dir, 'fake-claude')
    writeFileSync(bin, `#!/usr/bin/perl\n$SIG{TERM} = 'IGNORE'; sleep 60;\n`, { mode: 0o755 })                // its command line keeps "agents --json"
    const orphan = Bun.spawn([bin, 'agents', '--json'])                                              // the dead holder's run, still going
    await sleep(100)
    writeFileSync(join(dir, 'agents-cli.lock'), JSON.stringify({ pid: 999_999, token: 'T', at: Date.now() - 30_000 }))
    writeFileSync(join(dir, 'agents-cli.run'), JSON.stringify({ token: 'T', pid: orphan.pid, at: Date.now() - 30_000 }))
    // the OS's view (Bun notes a child's exit a moment later): running = listed and not a zombie
    const running = (pid: number) => { const st = String(spawnSync('ps', ['-o', 'stat=', '-p', String(pid)]).stdout ?? '').trim(); return st !== '' && !st.startsWith('Z') }
    let runs = 0, concurrentWithOrphan = true
    const S = new SharedCli({ dir, stepMs: 20, run: async () => { runs++; concurrentWithOrphan = running(orphan.pid); return '[]' } })
    try {
      expect(running(orphan.pid)).toBe(true)
      expect(await S.read(Date.now())).toBe('[]')
      expect(runs).toBe(1)
      expect(concurrentWithOrphan).toBe(false)                                                       // the old run was gone before the new one started
      await orphan.exited
      expect(orphan.signalCode).toBe('SIGKILL')
    } finally { orphan.kill('SIGKILL') }
    // pids are reused: a recorded pid that is not a `claude agents --json` run is never killed
    const bystander = Bun.spawn(['sleep', '60'])
    try {
      writeFileSync(join(dir, 'agents-cli.lock'), JSON.stringify({ pid: 999_999, token: 'U', at: Date.now() - 30_000 }))
      writeFileSync(join(dir, 'agents-cli.run'), JSON.stringify({ token: 'U', pid: bystander.pid, at: Date.now() - 30_000 }))
      expect(await S.read(Date.now())).toBe('[]')
      expect(runs).toBe(2)
      expect(bystander.exitCode === null && bystander.signalCode === null).toBe(true)
    } finally { bystander.kill('SIGKILL') }
    // a holder whose lock was taken over meanwhile leaves the successor's lock alone
    const S2 = new SharedCli({ dir, run: async () => { writeFileSync(join(dir, 'agents-cli.lock'), JSON.stringify({ pid: process.pid, token: 'SUCCESSOR', at: Date.now() })); return '[3]' } })
    expect(await S2.read(Date.now())).toBe('[3]')
    expect(JSON.parse(readFileSync(join(dir, 'agents-cli.lock'), 'utf8')).token).toBe('SUCCESSOR')
  })

  test('1.48.4 withDeadline: the run ends at its own deadline even when the daemon that started it is SIGKILLed (measured)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onsen-deadline-')), slow = join(dir, 'slow.sh'), pidf = join(dir, 'run.pid'), script = join(dir, 'holder.ts')
    writeFileSync(slow, `#!/bin/sh\ntrap '' TERM\nexec sleep 60\n`, { mode: 0o755 })                      // ignores SIGTERM
    writeFileSync(script, `import { runCli, withDeadline } from ${JSON.stringify(join(import.meta.dir, 'onsen-status.ts'))}\n` +
      `import { writeFileSync } from 'fs'\n` +
      `void runCli(...withDeadline(${JSON.stringify(slow)}, [], 1), 60_000, { onSpawn: p => writeFileSync(${JSON.stringify(pidf)}, String(p)) })\n` +
      `setInterval(() => {}, 1000)\n`)
    const holder = Bun.spawn(['bun', script])
    let run = 0
    try {
    const t0 = performance.now()
    while (!existsSync(pidf) && performance.now() - t0 < 5_000) await sleep(20)
    run = Number(readFileSync(pidf, 'utf8'))
    holder.kill('SIGKILL'); await holder.exited                                                       // the daemon dies mid-run
    expect(pidAlive(run)).toBe(true)
    while (pidAlive(run) && performance.now() - t0 < 6_000) await sleep(50)
    console.log(`withDeadline: run ended ${((performance.now() - t0) / 1000).toFixed(1)} s after it started (deadline 1 s), its daemon killed`)
    expect(pidAlive(run)).toBe(false)
    } finally { holder.kill('SIGKILL'); if (run) { try { process.kill(run, 'SIGKILL') } catch {} } }
  })

  test('1.48.3 SharedCli across processes: 20 daemons starting at once run the CLI once, never two at a time (measured)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onsen-shared-mp-')), bin = join(dir, 'fake-claude.sh'), log = join(dir, 'runs.log')
    writeFileSync(bin, `#!/bin/sh\necho "start $(date +%s%N 2>/dev/null || date +%s)" >> ${log}\nsleep 0.5\necho "end" >> ${log}\necho '[]'\n`, { mode: 0o755 })
    const script = join(dir, 'reader.ts')
    writeFileSync(script, `import { SharedCli, runCli } from ${JSON.stringify(join(import.meta.dir, 'onsen-status.ts'))}\n` +
      `const s = new SharedCli({ dir: ${JSON.stringify(dir)}, run: () => runCli(${JSON.stringify(bin)}, [], 5_000) })\n` +
      `const v = await s.read(Date.now() - 5_000); console.log(v === null ? 'null' : v.trim())\n`)
    const ps = Array.from({ length: 20 }, () => Bun.spawn(['bun', script], { stdout: 'pipe', stderr: 'pipe' }))
    const outs = await Promise.all(ps.map(async p => { await p.exited; return (await new Response(p.stdout).text()).trim() }))
    expect(outs).toEqual(Array(20).fill('[]'))
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    let open = 0, most = 0
    for (const l of lines) { open += l.startsWith('start') ? 1 : -1; most = Math.max(most, open) }
    console.log(`SharedCli 20 processes: ${lines.filter(l => l.startsWith('start')).length} run(s), at most ${most} at a time`)
    expect(most).toBe(1)
    expect(lines.filter(l => l.startsWith('start')).length).toBeLessThanOrEqual(2)
  }, 30_000)

  test('the watch: a registry file written or replaced calls changed within ~100 ms (measured)', async () => {
    const { R, put, changes, dir } = setup()
    R.start()
    try {
      await sleep(150)
      const lat: number[] = []
      for (let i = 0; i < 5; i++) {
        const before = changes(), t0 = performance.now()
        if (i % 2) put(reg(90 + i, { status: 'busy' }))
        else { writeFileSync(join(dir, 'tmp.x'), JSON.stringify(reg(90 + i))); renameSync(join(dir, 'tmp.x'), join(dir, `${90 + i}.json`)) }
        while (changes() === before && performance.now() - t0 < 2000) await sleep(2)
        lat.push(performance.now() - t0)
        await sleep(50)
      }
      console.log(`registry watch latency (ms): ${lat.map(x => x.toFixed(1)).join(', ')}`)
      expect(Math.max(...lat)).toBeLessThan(500)
    } finally { R.stop() }
  })

  test('Streams: a pid is connected while a stream of it is open and 15 s after; a stream whose process was not found counts for any pid', () => {
    let t = 0
    const open = new Map<string, boolean>([['s1', true]])
    const S = new Streams({ open: () => open.entries(), now: () => t })
    S.note('s1', 101)
    expect(S.connected(101)).toBe(true); expect(S.connected(102)).toBe(false)
    open.set('s1', false); t += 14_000
    expect(S.connected(101)).toBe(true)
    t += 2_000
    expect(S.connected(101)).toBe(false)
    open.set('s2', true)                                                                        // not looked up (or not found)
    expect(S.connected(102)).toBe(true)
  })
})

// ------------------------------------------------------------------ lanes on: a real lanes instance; the tap reads its journal and the main's hook events
describe('lanes on: M1, M2 and the lane runs, read through the tap', async () => {
  const L = await import('./lanes.ts?onsen-step3') as typeof import('./lanes.ts')
  const dir = mkdtempSync(join(tmpdir(), 'lanes-onsen3-'))
  process.env.LANES_DIR = dir
  copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
  const open = new Set<string>()
  const deps: any = { role: 'tg', agent: AGENT, workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
    notifySession: async (sid: string) => open.has(sid), streamOpen: (sid: string) => open.has(sid), sendBot: async () => 100, joeyChatId: () => JOEY }
  L.lanesInit(deps)
  const facts: DeliveryFact[] = []
  const F = new DeliveryFacts({ agent: AGENT, sink: f => facts.push(f) })
  const joeyOf: JoeyOf = m => m && m.user_id === JOEY && m.chat_id && /^\d+$/.test(String(m.message_id ?? '')) ? { chat: String(m.chat_id), id: String(m.message_id) } : null
  let changes = 0
  const tap = new LanesTap({ facts: F, joey: joeyOf, gen: () => L.mainGenRow(), changed: () => { changes++ } })
  L.observeLanes({ journal: (r, l) => tap.journal(r, l), mainEvent: b => tap.mainEvent(b) })
  const procs: any[] = []
  afterAll(() => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } })
  const M = () => L.__main()
  async function startMain() {
    const proc = Bun.spawn(['sleep', '600']); procs.push(proc)
    const sid = randomUUID()
    writeFileSync(join(dir, 'main-expected'), sid)
    const g = { pid: proc.pid, sid, mcp: `mcp-${proc.pid}` }
    open.add(g.mcp); L.__noteMcpPid(g.mcp, g.pid)
    expect((await L.__mainEvent({ event: 'SessionStart', pid: g.pid, session_id: sid, source: 'startup' })).accepted).toBe(true)
    return g
  }
  const hook = (g: { pid: number; sid: string }, event: string, o: object = {}) => L.__mainEvent({ event, pid: g.pid, session_id: g.sid, ...o })
  async function joey(id: number, user = JOEY) {
    const meta = { chat_id: JOEY, message_id: String(id), user: 'joey_lab', user_id: user }
    await L.routeEvent({ id: `tg-${JOEY}-${id}`, source: 'telegram', from: 'joey', text: `訊息 ${id}`, meta, verified: true,
      notif: { method: 'notifications/claude/channel', params: { content: `訊息 ${id}`, meta } } } as any)
    await M().pump()
  }
  const of = (id: number) => facts.filter(f => f.client_msg_id === String(id)).map(f => `${f.state}:${f.by ?? ''}`)
  // 1.45.1: the state is the registry's (a stand-in here: busy unless said); the tap gives the detail
  const view = (status = 'busy') => statusOf({ main: { status }, last_activity_at: null, queued_joey: L.mainQueuedJoey(), walled: tap.walled(), compacting: tap.compacting(), turn: tap.turnDetail() })

  test('no main: no turn; a queued Joey message counts; offered is not seen; bound (the turn took it in) is seen by main; the tool as detail; Stop: turn_end when the record shows the turn over', async () => {
    expect(L.mainGenRow()).toBe(null); expect(tap.turnDetail()).toBe(null)
    await joey(901)
    expect(L.mainQueuedJoey()).toBe(1)
    expect(of(901)).toEqual([])                                                  // delivered is server.ts's (handleInbound); queued is not seen
    const g = await startMain()
    await M().pump()
    expect(M().items(r => r.event === `tg-${JOEY}-901`)[0].state).toBe('offered')
    expect(of(901)).toEqual(['in_session:main'])                                 // WO-165: offered = written into the main's stream; not seen
    expect(tap.turnDetail()).toBe(null)
    expect(view('idle')).toEqual({ state: 'idle', detail: { queued_joey: 1 }, last_activity_at: null })
    const p = 'p-1'
    await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [M().items(r => r.event === `tg-${JOEY}-901`)[0].id] })
    expect(of(901)).toEqual(['in_session:main', 'seen:main'])
    expect(L.mainQueuedJoey()).toBe(0)
    await hook(g, 'PreToolUse', { prompt_id: p, tool_name: 'Bash', tool_timeout_ms: 1000 })
    let v = view()
    expect(v.state).toBe('busy')
    expect(v.detail).toMatchObject({ tool: { name: 'Bash' }, subagents: 0, queued_joey: 0 })
    expect(typeof (v.detail as any).turn_started_at).toBe('string')
    expect(typeof (v.detail as any).tool.since).toBe('string')
    await hook(g, 'PreToolUse', { prompt_id: p, tool_name: 'Agent' })
    expect((view().detail as any)).toMatchObject({ tool: { name: 'Agent' }, subagents: 1 })
    // a second Joey message while the main is busy: queued (it is pulled at the next tool boundary)
    await joey(902)
    expect((view().detail as any).queued_joey).toBe(1)
    expect(of(902)).toEqual([])                                                  // queued in M1: not in the session
    await hook(g, 'PostToolUse', { prompt_id: p, tool_name: 'Agent', tool_input: {}, tool_response: 'ok' })
    expect(of(902)).toEqual(['in_session:main', 'seen:main'])                   // pulled into the running turn: both at that moment
    const f902 = facts.filter(f => f.client_msg_id === '902')
    expect(f902[0]!.at).toBe(f902[1]!.at)
    v = view()
    expect(v.detail).toMatchObject({ tool: null, subagents: 0, queued_joey: 0 })
    // Stop: check, then final (another Stop hook holds it: the turn goes on under the same prompt)
    await hook(g, 'Stop', { prompt_id: p, phase: 'check' })
    await hook(g, 'Stop', { prompt_id: p, phase: 'final' })
    expect(tap.turnDetail()).toBe(null)
    expect(F.pendingLater()).toBe(2)
    F.statusRecord('busy')                                                        // WO-177: the record shows the turn going on: nothing is sent
    await hook(g, 'PreToolUse', { prompt_id: p, tool_name: 'mcp__plugin_telegram-http_telegram-http__reply' })   // continueTurn: bound again
    expect(F.pendingLater()).toBe(0)
    F.statusRecord('idle')
    expect(of(901)).toEqual(['in_session:main', 'seen:main'])                    // no turn_end: that Stop was not the end
    expect(tap.turnDetail()).not.toBe(null)
    expect((view().detail as any).turn_started_at).toBe((v.detail as any).turn_started_at)   // the same turn
    await hook(g, 'PostToolUse', { prompt_id: p, tool_name: 'mcp__plugin_telegram-http_telegram-http__reply', tool_input: { text: 'ok' }, tool_response: 'sent' })
    await hook(g, 'Stop', { prompt_id: p, phase: 'final' })
    expect(of(901)).toEqual(['in_session:main', 'seen:main'])
    F.statusRecord('idle')                                                        // the record shows the turn over: sent now
    expect(of(901)).toEqual(['in_session:main', 'seen:main', 'turn_end:main'])
    expect(of(902)).toEqual(['in_session:main', 'seen:main', 'turn_end:main'])
    expect(changes).toBeGreaterThan(0)
  })

test('WO-162, lanes on: 1.55.1\'s rule (the offered item is the turn\'s once the status says it began) on the first busy row; each hook\'s tool change written at once', async () => {
    const gr = L.mainGenRow()!                                                           // the main of the test above, idle after its Stop
    const g = { pid: Number(gr.pid), sid: String(gr.session_id) }
    const rows: StatusFact[] = []
    const S = new StatusFacts({ agent: AGENT, sink: f => rows.push(f), heartbeatMs: 0 })
    let reg = 'idle'
    // server.ts compute, lanes on (1.55.1): statusOf, then a turn that began does not count the item offered to the main
    const compute = () => {
      const v = statusOf({ main: { status: reg }, last_activity_at: null, queued_joey: L.mainQueuedJoey(), walled: tap.walled(), compacting: tap.compacting(), turn: tap.turnDetail() })
      if (v.detail && Number(v.detail.queued_joey) > 0 && v.state !== 'idle' && v.state !== 'offline') v.detail.queued_joey = L.mainQueuedJoey({ offered: false })
      return v
    }
    await joey(980)
    const id = M().items(r => r.event === `tg-${JOEY}-980`)[0].id
    expect(M().items(r => r.id === id)[0].state).toBe('offered')
    S.update(compute())
    expect(rows.at(-1)).toMatchObject({ state: 'idle', detail: { queued_joey: 1 } })     // an idle main's untaken offer still counts
    reg = 'busy'                                                                         // Claude Code's registry says busy (before or after the hook)
    S.update(compute())
    expect(rows.at(-1)).toMatchObject({ state: 'busy', detail: { queued_joey: 0 } })     // the turn's first row: the item it is taking in is not queued
    const p = 'p-wo162'
    await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] }); S.update(compute())
    // tools from the hooks: each start and end its own row at once (until 1.55.1 a detail change within 5 s of the last row waited)
    const n = rows.length
    for (const tool of ['mcp__plugin_telegram-http_telegram-http__react', 'Read', 'Bash']) {
      await hook(g, 'PreToolUse', { prompt_id: p, tool_name: tool }); S.update(compute())
      await hook(g, 'PostToolUse', { prompt_id: p, tool_name: tool, tool_input: {}, tool_response: 'ok' }); S.update(compute())
    }
    expect(rows.slice(n).map(r => (r.detail as any).tool?.name ?? null)).toEqual(['mcp__plugin_telegram-http_telegram-http__react', null, 'Read', null, 'Bash', null])
    await joey(981)                                                                      // mid-turn: queued
    S.update(compute())
    expect(rows.at(-1)!.detail).toMatchObject({ queued_joey: 1 })
    await hook(g, 'PreToolUse', { prompt_id: p, tool_name: 'Bash' })
    await hook(g, 'PostToolUse', { prompt_id: p, tool_name: 'Bash', tool_input: {}, tool_response: 'ok' })   // pulled at the tool boundary
    S.update(compute())
    expect(rows.at(-1)!.detail).toMatchObject({ tool: null, queued_joey: 0 })
    await hook(g, 'Stop', { prompt_id: p, phase: 'final' })
    S.stop()
  })

  test('PreCompact: compacting (detail) until the main\'s next hook event; a StopFailure that walls the main: walled (detail); a stranger\'s message: no facts', async () => {
    const g = L.mainGenRow()!
    const gg = { pid: Number(g.pid), sid: String(g.session_id) }
    await hook(gg, 'PreCompact', {})
    expect(tap.compacting()).toBe(true)
    expect(view().detail).toMatchObject({ compacting: true })
    await hook(gg, 'UserPromptSubmit', { prompt_id: 'p-2' })
    expect(tap.compacting()).toBe(false)
    expect(tap.turnDetail()).not.toBe(null)
    await hook(gg, 'StopFailure', { prompt_id: 'p-2', error: 'rate_limit', reason: 'limit' })
    expect(tap.walled()).toEqual({ walled: true, until: null, kind: 'rate_limit' })
    expect(view('idle')).toEqual({ state: 'idle', detail: { queued_joey: 0, walled: { until: null, kind: 'rate_limit' } }, last_activity_at: null })
    await joey(950, '4242')                                                      // not on the allowlist
    expect(of(950)).toEqual([])
  })

  test('a lane run: running = seen by the lane (its event, a steered message); its exit = turn_end by the lane; a run that never ran ends no turn', () => {
    const J = L.__journal()
    const ev = (id: number) => ({ id: `tg-${JOEY}-${id}`, source: 'telegram', from: 'joey', text: 't', meta: { chat_id: JOEY, message_id: String(id), user_id: JOEY }, notif: { method: '', params: {} } })
    J.write('run', 'r1', 'queued', { event: ev(960).id, lane: 'worker-a', ev: ev(960), extra: null, steered: null })
    J.write('run', 'r1', 'leased', { event: ev(960).id, lane: 'worker-a', run: 'worker-a.r1' })
    expect(of(960)).toEqual([])
    J.write('run', 'r1', 'running', { event: ev(960).id, lane: 'worker-a', pid: 1 })
    expect(of(960)).toEqual(['in_session:worker-a', 'seen:worker-a'])              // WO-165: a run starts with it in its prompt: both at once
    J.write('run', 'r1', 'running', { event: ev(960).id, lane: 'worker-a', steered: [ev(961)] })
    expect(of(961)).toEqual(['in_session:worker-a', 'seen:worker-a'])
    J.write('run', 'r1', 'exited', { event: ev(960).id, lane: 'worker-a', reason: 'normal' })
    expect(of(960)).toEqual(['in_session:worker-a', 'seen:worker-a', 'turn_end:worker-a'])
    expect(of(961)).toEqual(['in_session:worker-a', 'seen:worker-a', 'turn_end:worker-a'])
    expect(facts.find(f => f.client_msg_id === '960' && f.state === 'turn_end')).toMatchObject({ detail: { reason: 'normal' }, turn_id: 'worker-a.r1', outcome: 'done',
      bound: ['960', '961'] })   // WO-172: the run is the lane's turn; the fact's own fields (Onsen 0.16.0)
    expect(facts.find(f => f.client_msg_id === '960' && f.state === 'seen')).toMatchObject({ turn_id: 'worker-a.r1' })
    J.write('run', 'r2', 'queued', { event: ev(970).id, lane: 'worker-b', ev: ev(970) })
    J.write('run', 'r2', 'exited', { event: ev(970).id, lane: 'worker-b', reason: 'merged' })
    expect(of(970)).toEqual([])
  })
})

// ------------------------------------------------------------------ lanes off: the transcript
describe('lanes off: the main\'s turns from its transcript', () => {
  const tag = (id: number, user = JOEY) => `<channel source="plugin:telegram-http:telegram-http" chat_id="${JOEY}" message_id="${id}" user="joey" user_id="${user}" ts="2026-11-25T10:00:00.000Z">`
  const rec = (o: object) => JSON.stringify(o) + '\n'
  const joeyOf: JoeyOf = m => m && m.user_id === JOEY ? { chat: String(m.chat_id), id: String(m.message_id) } : null

  test('channelTags reads every tag\'s attributes', () => {
    expect(channelTags(`${tag(5)}\nhi</channel>\n${tag(6, '9')}x`).map(a => [a.message_id, a.user_id])).toEqual([['5', JOEY], ['6', '9']])
  })

  test('a message taken in as a prompt, a tool, an agent, a message pulled mid-turn, turn_duration: busy detail, then turn_end for both; a local command starts no turn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onsen3-tx-'))
    const f = join(dir, `${randomUUID()}.jsonl`)
    writeFileSync(f, rec({ type: 'system', subtype: 'turn_duration', timestamp: '2026-11-25T09:00:00.000Z' }))
    const out: DeliveryFact[] = []
    const F = new DeliveryFacts({ agent: AGENT, sink: x => out.push(x) })
    let changed = 0
    const W = new TurnWatch({ dir: () => dir, facts: F, joey: joeyOf, changed: () => { changed++ } })
    W.tick()
    expect(W.busy()).toBe(null)
    F.delivered(JOEY, 11); F.inSession(JOEY, 11, 'main'); F.delivered(JOEY, 12); F.inSession(JOEY, 12, 'main')
    expect(F.queued('seen')).toBe(2)
    expect(out.filter(x => x.state === 'seen')).toEqual([])                  // WO-165: written into the stream is not seen
    const now = new Date().toISOString()
    appendFileSync(f, rec({ type: 'user', isMeta: true, message: { role: 'user', content: `<command-name>/model</command-name>` }, timestamp: now }))
    W.tick()
    expect(W.busy()).toBe(null)
    appendFileSync(f, rec({ type: 'queue-operation', operation: 'enqueue', content: tag(11), timestamp: now }))
    appendFileSync(f, rec({ type: 'user', isMeta: true, isSidechain: false, message: { role: 'user', content: `${tag(11)}\n看一下</channel>` }, timestamp: now }))
    appendFileSync(f, rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }, timestamp: now }))
    W.tick()
    expect(W.busy()).toEqual({ turn_started_at: now, tool: { name: 'Bash', started_at: now, timeout_s: null }, subagents: 0 })
    expect(F.queued('seen')).toBe(1)
    expect(out.filter(x => x.state === 'seen').map(x => [x.client_msg_id, x.by, x.at])).toEqual([['11', 'main', now]])   // the prompt's own time
    appendFileSync(f, rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, timestamp: now }))
    appendFileSync(f, rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Agent', input: { prompt: 'x' } }, { type: 'tool_use', id: 't3', name: 'Agent', input: { run_in_background: true } }] }, timestamp: now }))
    appendFileSync(f, rec({ type: 'attachment', attachment: { type: 'queued_command', prompt: `${tag(12)}\n還有這個</channel>` }, timestamp: now }))
    appendFileSync(f, rec({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', id: 's1', name: 'Read', input: {} }] }, timestamp: now }))
    W.tick()
    expect(W.busy()).toMatchObject({ subagents: 1 })
    expect(F.queued('seen')).toBe(0)
    expect(out.filter(x => x.state === 'seen').map(x => x.client_msg_id)).toEqual(['11', '12'])
    expect(out.some(x => x.state === 'turn_end')).toBe(false)
    const end = new Date(Date.now() + 1000).toISOString()
    appendFileSync(f, rec({ type: 'system', subtype: 'turn_duration', durationMs: 900, timestamp: end }))
    W.tick()
    expect(W.busy()).toBe(null)
    expect(out.filter(x => x.state === 'turn_end').map(x => [x.client_msg_id, x.by, x.at])).toEqual([['11', 'main', end], ['12', 'main', end]])
    expect(changed).toBeGreaterThan(0)
  })

  test('a new session file: read from its tail; a turn that ended long before is not written again; a half line waits for its end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onsen3-tx2-'))
    const f = join(dir, `${randomUUID()}.jsonl`)
    const old = '2026-01-01T00:00:00.000Z'
    writeFileSync(f, 'x'.repeat(300) + '\n' + rec({ type: 'user', message: { content: `${tag(30)}\nold</channel>` }, timestamp: old }) + rec({ type: 'system', subtype: 'turn_duration', timestamp: old }))
    const out: DeliveryFact[] = []
    const W = new TurnWatch({ dir: () => dir, facts: new DeliveryFacts({ agent: AGENT, sink: x => out.push(x) }), joey: joeyOf, changed: () => {}, tailBytes: 250 })
    W.tick()
    expect(out).toEqual([])
    const now = new Date().toISOString()
    const line = rec({ type: 'user', message: { content: `${tag(31)}\nnew</channel>` }, timestamp: now })
    appendFileSync(f, line.slice(0, 20))
    W.tick()
    expect(W.busy()).toBe(null)
    appendFileSync(f, line.slice(20))
    W.tick()
    expect(W.busy()?.turn_started_at).toBe(now)
    appendFileSync(f, rec({ type: 'system', subtype: 'turn_duration', timestamp: now }))
    W.tick()
    expect(out.map(x => `${x.client_msg_id}:${x.state}`)).toEqual(['31:seen', '31:turn_end'])   // 30 (long before): neither seen nor turn_end again
  })
})

test('1.47.0: an open tool that declared a long timeout raises the stuck threshold (a 15-min Bash is busy, not stuck)', async () => {
  const { statusOf } = await import('./onsen-status.ts')
  const now = Date.parse('2026-11-25T03:00:00Z')
  const base = { main: { status: 'busy' } as any, queued_joey: 0, last_activity_at: new Date(now - 900_000).toISOString() } as any
  const turn = (timeout_s: number | null) => ({ turn_started_at: null, tool: { name: 'Bash', started_at: new Date(now - 900_000).toISOString(), timeout_s }, subagents: 0 })
  expect(statusOf({ ...base, turn: turn(null) }, { now, stuckS: 600 }).state).toBe('stuck')
  expect(statusOf({ ...base, turn: turn(1200) }, { now, stuckS: 600 }).state).toBe('busy')        // 1200 s × 1.25 = 1500 s > 900 s silent
  const s = statusOf({ ...base, turn: turn(600) }, { now, stuckS: 600 })                           // 750 s < 900 s silent
  expect(s.state).toBe('stuck'); expect(s.detail?.threshold_s).toBe(750)
})

