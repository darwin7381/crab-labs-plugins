// WO-157 (Chiron 13:46Z, points 3 and 5): statusOf is the lanes' one state source, so its holes are fixed in statusOf.
//   3  the registry's status goes stale (the 28 replay rows: 25 busy, 2 waiting, long after the turn ended): the main's hook edges correct it when they
//      are newer than the file's statusUpdatedAt; a file written after them wins
//   5  detail.lanes: the agent's lane runs in progress ride in the status
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { statusOf, regEntry, LanesTap, DeliveryFacts, Registry } from './onsen-status.ts'

const T0 = Date.parse('2026-11-25T08:49:00.000Z')
const base = { last_activity_at: new Date(T0).toISOString(), queued_joey: 0 }
const now = T0 + 130_000

test('a stale busy (or waiting) file after a final Stop the file never caught: idle, the stale value in the detail', () => {
  // chiron 08:52:05Z: the file said busy (written 08:49:00), the main's final Stop came 08:50:10, nothing began since; it took the next item in 0.1 s
  const v = statusOf({ ...base, main: { status: 'busy', status_at: T0 }, edges: { started_at: T0 + 68_600, ended_at: T0 + 70_400 } }, { now })
  expect(v).toMatchObject({ state: 'idle', detail: { registry_stale: 'busy' } })
  const w = statusOf({ ...base, main: { status: 'waiting', waiting_for: 'dialog open', status_at: T0 }, edges: { started_at: null, ended_at: T0 + 5_000 } }, { now })
  expect(w).toMatchObject({ state: 'idle', detail: { registry_stale: 'waiting' } })
})

test('Chiron 12112 (A): the busy file after the turn while background sub-agents run: idle {registry_stale, background_agents: count, or true}', () => {
  const ended = { started_at: T0 + 68_600, ended_at: T0 + 70_400 }
  expect(statusOf({ ...base, main: { status: 'busy', status_at: T0, background_agents: 2 }, edges: ended }, { now })).toMatchObject({ state: 'idle', detail: { registry_stale: 'busy', background_agents: 2 } })
  expect(statusOf({ ...base, main: { status: 'busy', status_at: T0, background_agents: 0 }, edges: ended }, { now }).detail?.background_agents).toBe(true)
  expect(statusOf({ ...base, main: { status: 'busy', status_at: T0, background_agents: null }, edges: ended }, { now }).detail?.background_agents).toBe(true)
  expect(statusOf({ ...base, main: { status: 'waiting', status_at: T0 }, edges: ended }, { now }).detail).not.toHaveProperty('background_agents')
})

test('Registry.backgroundAgents: background sub-agent transcripts written in the last 10 min (a foreground one by its meta, an old one: not counted)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wo157-bg-')), sid = '11111111-2222-3333-4444-555555555555', sub = join(dir, sid, 'subagents')
  mkdirSync(sub, { recursive: true }); writeFileSync(join(dir, `${sid}.jsonl`), '{}\n')
  for (const [n, shape, ageMin] of [['a1', 'background', 1], ['a2', 'background', 3], ['a3', 'foreground', 1], ['a4', 'background', 30], ['a5', null, 2]] as const) {
    writeFileSync(join(sub, `agent-${n}.jsonl`), '{}\n')
    if (shape) writeFileSync(join(sub, `agent-${n}.meta.json`), JSON.stringify({ requestShape: shape }))
    const t = (Date.now() - ageMin * 60_000) / 1000; utimesSync(join(sub, `agent-${n}.jsonl`), t, t)
  }
  const reg = new Registry({ dir: join(dir, 'sessions'), workspace: dir, transcripts: () => dir, connected: () => true, changed: () => {}, log: () => {} } as any)
  expect(reg.backgroundAgents(sid)).toBe(3)                              // a1, a2, a5 (no meta)
  expect(reg.backgroundAgents('99999999-0000-0000-0000-000000000000')).toBeNull()
})

test('a stale idle file while the hooks show a turn that began after it and has not ended: busy', () => {
  const v = statusOf({ ...base, main: { status: 'idle', status_at: T0 }, edges: { started_at: T0 + 10_000, ended_at: T0 - 5_000 } }, { now: T0 + 20_000 })
  expect(v).toMatchObject({ state: 'busy', detail: { registry_stale: 'idle' } })
})

test('the file wins when it was written after the hook evidence, or there is no evidence, or no statusUpdatedAt', () => {
  expect(statusOf({ ...base, main: { status: 'busy', status_at: T0 + 80_000 }, edges: { started_at: T0, ended_at: T0 + 70_000 } }, { now }).state).toBe('busy')
  expect(statusOf({ ...base, main: { status: 'busy', status_at: T0 }, edges: { started_at: T0 + 90_000, ended_at: T0 + 70_000 } }, { now }).state).toBe('busy')   // a turn began after the Stop
  expect(statusOf({ ...base, main: { status: 'busy', status_at: T0 }, edges: null }, { now }).state).toBe('busy')
  expect(statusOf({ ...base, main: { status: 'busy' }, edges: { started_at: null, ended_at: T0 + 70_000 } }, { now }).state).toBe('busy')
  expect(statusOf({ ...base, main: null, offline: 'no_registration', edges: { started_at: null, ended_at: T0 } }, { now }).state).toBe('offline')
})

test('a `dialog open` outside a turn is idle {dialog_open}; inside a turn, and a permission prompt, stay waiting', () => {
  // kot 07:14:07Z: the dialog was written 5 s after the final Stop; the main took the next item in 0.1 s
  const out = { started_at: T0, ended_at: T0 + 10_000 }
  expect(statusOf({ ...base, main: { status: 'waiting', waiting_for: 'dialog open', status_at: T0 + 15_000 }, edges: out }, { now })).toMatchObject({ state: 'idle', detail: { dialog_open: true } })
  expect(statusOf({ ...base, main: { status: 'waiting', waiting_for: 'dialog open', status_at: T0 + 15_000 }, edges: { started_at: T0 + 20_000, ended_at: T0 + 10_000 } }, { now }).state).toBe('waiting')
  expect(statusOf({ ...base, main: { status: 'waiting', waiting_for: 'permission prompt', status_at: T0 + 15_000 }, edges: out }, { now }).state).toBe('waiting')
  expect(statusOf({ ...base, main: { status: 'waiting', waiting_for: 'dialog open', status_at: T0 + 15_000 }, edges: null }, { now }).state).toBe('waiting')
})

test('regEntry keeps statusUpdatedAt; the lanes tap reports the turn edges from the main\'s hook events (a final Stop only)', () => {
  expect(regEntry({ pid: 5, sessionId: 's', cwd: '/w', kind: 'interactive', status: 'busy', statusUpdatedAt: 1795612749288 })?.statusAt).toBe(1795612749288)
  let t = 1000
  const gen = { id: '5', pid: 5, state: 'in_turn' } as any
  const tap = new LanesTap({ facts: new DeliveryFacts({ agent: 'a', sink: () => {} }), joey: () => null, gen: () => gen, changed: () => {}, now: () => t })
  tap.mainEvent({ event: 'UserPromptSubmit', pid: 5 })
  expect(tap.turnEdges()).toEqual({ started_at: 1000, ended_at: null })
  t = 2000; tap.mainEvent({ event: 'Stop', pid: 5, phase: 'check' })
  expect(tap.turnEdges().ended_at).toBeNull()                          // a check Stop may still be held by a gate
  t = 3000; tap.mainEvent({ event: 'Stop', pid: 5, phase: 'final' })
  expect(tap.turnEdges()).toEqual({ started_at: 1000, ended_at: 3000 })
  t = 4000; tap.mainEvent({ event: 'PreToolUse', pid: 5, tool_name: 'Bash' })
  expect(tap.turnEdges()).toEqual({ started_at: 4000, ended_at: 3000 })
})

test('detail.lanes: the lane runs ride in every state\'s detail; none: no key', () => {
  const lanes = [{ id: 'a.reflex.2', run: 'a.reflex.2.r1', kind: 'reflex', since: '2026-11-25T13:50:00.000Z' }]
  for (const main of [{ status: 'idle' }, { status: 'busy' }, { status: 'waiting' }, null]) expect(statusOf({ ...base, main, lanes } as any, { now: T0 + 1000 }).detail?.lanes).toEqual(lanes)
  expect(statusOf({ ...base, main: { status: 'idle' } }, { now }).detail).not.toHaveProperty('lanes')
})
