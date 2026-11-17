// Universe 002f: what happens when a lane run dies.
//   - the daemon saw it die: the event is dispatched again after a short backoff (it used to wait for the 2-minute lease)
//   - three failures: the main gets the event at once
//   - a lane whose conversation is already on disk is resumed; the same session id is never started twice
//   - a queue item that was running when the daemon stopped is dispatched again at boot
//   - a lane the main closed is not run again
// The "lane process" here is a two-line shell script that exits 1 (set with __setClaudeBin): no model, no network.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { lanesInit, routeEvent, sessionArgs, sweepQueue, callLaneTool, __lanesState, __setMainConnected, __setRetryBackoff, __setClaudeBin, __setLaneMaxRun, __setCriticalDeadline } from './lanes.ts'

const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-retry-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'),
  claude_pid: 1, registered_at: new Date().toISOString() }))
const sent: Array<{ text: string; silent: boolean }> = []
const dying = join(dir, 'dying-lane.sh')
writeFileSync(dying, '#!/bin/sh\nsleep 0.2\nexit 1\n'); chmodSync(dying, 0o755)

// a queue item left "running" by a previous daemon process: must be dispatched again at boot, not after its old lease
mkdirSync(join(dir, 'queue'), { recursive: true })
const left = { id: 'adam.reflex.70', kind: 'reflex', n: 70, session_id: 'left-over', thread: 'adam#t-left', status: 'running', created: '', last: '',
  transcript: join(dir, 'left-over.jsonl'), runs: 0, tokens_in: 0, tokens_out: 0 }
writeFileSync(join(dir, 'state.json'), JSON.stringify({ counters: {}, lanes: { [left.id]: left }, threads: { 'adam#t-left': { id: 'adam#t-left', lane: left.id, peer: null, hops: 0, tokens: 0, created: '', last: '' } } }))
writeFileSync(join(dir, 'queue', 'mesh-left.json'), JSON.stringify({ ev: { id: 'mesh-left', source: 'mesh', from: 'scheduler', text: 'left over', meta: {}, notif: { method: '', params: {} } },
  lane: left.id, state: 'leased', lease_until: Date.now() + 120_000, attempts: 1, priority: 5, enqueued: new Date().toISOString(), pid: 999999, run: 'adam.reflex.70.r1' }))

const restoreBin = __setClaudeBin(dying)
__setRetryBackoff(20)
afterAll(() => { __setClaudeBin(restoreBin); __setRetryBackoff(5000) })

lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'],
  sendBot: async (_c: string, text: string, o: { silent?: boolean }) => { sent.push({ text, silent: !!o?.silent }); return 2000 + sent.length }, joeyChatId: () => '1' } as any)
__setMainConnected('mcp-main')

const rows = (name: string): any[] => { try { return readFileSync(join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 4000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) }
  return f()
}

test('002f: a queue item that was running when the daemon stopped is dispatched again at boot', async () => {
  sweepQueue()                                                              // lanesInit schedules this itself 2 s after boot
  const ok = await until(() => rows('lanes.jsonl').some(r => r.kind === 'spawn' && r.event === 'mesh-left'))
  expect(ok).toBe(true)
  const sp = rows('lanes.jsonl').find(r => r.kind === 'spawn' && r.event === 'mesh-left')
  expect(sp.attempt).toBe(2)                                                // the interrupted run counted as attempt 1
  await until(() => rows('ledger.jsonl').some(r => r.event === 'mesh-left' && r.kind === 'escalation'))
})

test('002f: a lane run that dies is run again at once; after three failures the main gets the event', async () => {
  const t0 = Date.now()
  const d = await routeEvent({ id: 'mesh-r1', source: 'mesh', from: 'scheduler', verified: true,
    text: '[scheduled][hourly-backup-check][run:47][normal][ops] 查備份', meta: {},
    notif: { method: 'notifications/claude/channel', params: { content: 'x', meta: {} } } } as any)
  expect(d.target).toBe('lane')
  const gaveUp = await until(() => rows('ledger.jsonl').some(r => r.event === 'mesh-r1' && r.kind === 'escalation'))
  expect(gaveUp).toBe(true)
  expect(Date.now() - t0).toBeLessThan(3000)                                // was: 3 × 120 s
  const lj = rows('lanes.jsonl').filter(r => r.event === 'mesh-r1')
  expect(lj.filter(r => r.kind === 'spawn').map(r => r.attempt)).toEqual([1, 2, 3])
  expect(lj.filter(r => r.kind === 'exit').length).toBe(3)
  const esc = rows('ledger.jsonl').filter(r => r.event === 'mesh-r1' && r.kind === 'escalation')
  expect(esc.length).toBe(1)                                                // handed to the main once
  expect(esc[0].text).toContain('連續 3 次')
  await sleep(150)
  expect(rows('lanes.jsonl').filter(r => r.event === 'mesh-r1' && r.kind === 'spawn').length).toBe(3)   // and not run a fourth time
})

test('002f: a lane the main closed is not run again', async () => {
  const d = await routeEvent({ id: 'mesh-r2', source: 'mesh', from: 'scheduler', verified: true,
    text: '[scheduled][daily-ticket-digest][run:12][normal][ops] 工單摘要', meta: {},
    notif: { method: 'notifications/claude/channel', params: { content: 'x', meta: {} } } } as any)
  __lanesState().lanes[d.lane!].status = 'closed'                           // closed while its first run is still going
  await until(() => rows('lanes.jsonl').some(r => r.event === 'mesh-r2' && r.kind === 'exit'))
  await sleep(200)
  expect(rows('lanes.jsonl').filter(r => r.event === 'mesh-r2' && r.kind === 'spawn').length).toBe(1)
  expect(rows('ledger.jsonl').some(r => r.event === 'mesh-r2' && r.kind === 'escalation')).toBe(false)
})

test('002f: a lane whose conversation is on disk is resumed, whatever the run counter says', () => {
  const t = join(dir, 'conv.jsonl')
  const base = { id: 'adam.reflex.80', kind: 'reflex', n: 80, session_id: 'sid-80', thread: 't', status: 'idle', created: '', last: '', runs: 0, tokens_in: 0, tokens_out: 0 }
  expect(sessionArgs({ ...base, transcript: t } as any)).toEqual({ resume: false, args: ['--session-id', 'sid-80'] })      // nothing on disk yet: a new session
  writeFileSync(t, '{}\n')
  expect(sessionArgs({ ...base, transcript: t } as any)).toEqual({ resume: true, args: ['--resume', 'sid-80'] })          // cut off before the exit handler ran: runs is still 0
  expect(sessionArgs({ ...base, transcript: join(dir, 'gone.jsonl'), runs: 2 } as any)).toEqual({ resume: true, args: ['--resume', 'sid-80'] })
  expect(sessionArgs({ ...base, kind: 'fork', fork_from: 'main-sid', transcript: t } as any)).toEqual({ resume: true, args: ['--resume', 'main-sid', '--fork-session'] })
  expect(sessionArgs({ ...base, kind: 'fork', fork_from: 'main-sid', transcript: t, runs: 1 } as any)).toEqual({ resume: true, args: ['--resume', 'sid-80'] })
})

test('002g: a lane run that hangs is stopped at the time limit, run again, and after three times the main gets the event', async () => {
  const hang = join(dir, 'hanging-lane.sh')
  writeFileSync(hang, '#!/bin/sh\nexec sleep 30\n'); chmodSync(hang, 0o755)
  const was = __setClaudeBin(hang)
  __setLaneMaxRun(120)
  try {
    const d = await routeEvent({ id: 'mesh-r3', source: 'mesh', from: 'scheduler', verified: true,
      text: '[scheduled][api-health-check][run:88][normal][ops] 查 health', meta: {},
      notif: { method: 'notifications/claude/channel', params: { content: 'x', meta: {} } } } as any)
    expect(d.target).toBe('lane')
    const gaveUp = await until(() => rows('ledger.jsonl').some(r => r.event === 'mesh-r3' && r.kind === 'escalation'), 5000)
    expect(gaveUp).toBe(true)
    const lj = rows('lanes.jsonl').filter(r => r.event === 'mesh-r3')
    expect(lj.filter(r => r.kind === 'timeout').length).toBe(3)
    expect(lj.filter(r => r.kind === 'exit').every(r => r.signal === 'SIGKILL')).toBe(true)
    expect(lj.filter(r => r.kind === 'spawn').map(r => r.attempt)).toEqual([1, 2, 3])
  } finally { __setClaudeBin(was); __setLaneMaxRun(900_000) }
})
