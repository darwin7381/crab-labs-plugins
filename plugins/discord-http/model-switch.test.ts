// /model false-✅ regression (research btcc 9070, 2026-11-12) — KEEP IN SYNC with telegram-http/model-switch.test.ts.
// 80x24 tmux captures from research's sandbox on Claude Code 2.1.281.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setLineAfterEcho, transcriptConfirmsSwitch } from './channel-bot-control'

const frame = (n: string) => readFileSync(join(import.meta.dir, 'test-fixtures', 'model-switch', n), 'utf8')
const full = '/model claude-haiku-4-5-20251001'

test('screen: a redraw that brings back an OLD Set line is not our confirmation', () => {
  expect((frame('stale-reveal.txt').match(/Set (model|effort)[^\n]*/g) ?? []).length).toBe(1) // the old count rule fired here
  expect(setLineAfterEcho(frame('stale-reveal.txt'), full)).toBeNull()
})

test('screen: picker open, command not executed yet', () => {
  expect(setLineAfterEcho(frame('picker-open.txt'), full)).toBeNull()
})

test('screen: the Set line under our own echo confirms', () => {
  expect(setLineAfterEcho(frame('switched.txt'), full)).toBe('Set model to Haiku 4.5 and saved as your default for new sessions')
})

const at = (iso: string) => Date.parse(iso)
const cmdRec = (ts: string, cmd: string, args: string) => ({
  type: 'user', timestamp: ts,
  message: { role: 'user', content: `<command-name>${cmd}</command-name>\n            <command-message>${cmd.slice(1)}</command-message>\n            <command-args>${args}</command-args>` },
})
const outRec = (ts: string, out: string) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: `<local-command-stdout>${out}</local-command-stdout>` } })

test('transcript: the executed command plus its Set output confirms', () => {
  const recs = [cmdRec('2026-11-12T05:02:13.049Z', '/model', 'claude-fable-5-2'), outRec('2026-11-12T05:02:13.049Z', 'Set model to `Fable 5.2` and saved as your default for new sessions')]
  expect(transcriptConfirmsSwitch(recs, '/model', 'claude-fable-5-2', at('2026-11-12T05:02:12.000Z')))
    .toBe('Set model to Fable 5.2 and saved as your default for new sessions')
})

test('transcript: an identical OLDER switch does not count', () => {
  const recs = [cmdRec('2026-11-12T04:00:00.000Z', '/model', 'claude-fable-5-2'), outRec('2026-11-12T04:00:00.000Z', 'Set model to `Fable 5.2`')]
  expect(transcriptConfirmsSwitch(recs, '/model', 'claude-fable-5-2', at('2026-11-12T05:00:00.000Z'))).toBeNull()
})

test('transcript: typed but not executed yet (picker open) → no confirmation', () => {
  expect(transcriptConfirmsSwitch([], '/model', 'claude-fable-5-2', 0)).toBeNull()
  const queued = [{ type: 'user', timestamp: '2026-11-12T05:02:13.049Z', message: { role: 'user', content: '/model claude-fable-5-2' } }]
  expect(transcriptConfirmsSwitch(queued, '/model', 'claude-fable-5-2', 0)).toBeNull()
})

test('transcript: ran but did not switch → no confirmation', () => {
  const recs = [cmdRec('2026-11-12T05:02:13.049Z', '/model', 'claude-fable-5-2'), outRec('2026-11-12T05:02:13.049Z', 'Kept model as Opus 5.5')]
  expect(transcriptConfirmsSwitch(recs, '/model', 'claude-fable-5-2', 0)).toBeNull()
})

test('transcript: a different value does not confirm this one', () => {
  const recs = [cmdRec('2026-11-12T05:02:13.049Z', '/model', 'opus'), outRec('2026-11-12T05:02:13.049Z', 'Set model to Opus 5.5')]
  expect(transcriptConfirmsSwitch(recs, '/model', 'claude-fable-5-2', 0)).toBeNull()
})

test('transcript: /effort works the same way', () => {
  const recs = [cmdRec('2026-11-12T05:02:13.049Z', '/effort', 'high'), outRec('2026-11-12T05:02:13.049Z', 'Set effort level to high')]
  expect(transcriptConfirmsSwitch(recs, '/effort', 'high', 0)).toBe('Set effort level to high')
})
