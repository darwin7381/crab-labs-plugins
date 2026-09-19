import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newestGenuineAssistantAtIn } from './liveness'

function dirWith(lines: object[]): string {
  const d = mkdtempSync(join(tmpdir(), 'liveness-'))
  writeFileSync(join(d, 'session.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return d
}
const T1 = '2026-09-19T01:00:00.000Z', T2 = '2026-09-19T01:05:00.000Z', T3 = '2026-09-19T01:10:00.000Z'

test('genuine assistant record counts', () => {
  const d = dirWith([{ type: 'assistant', timestamp: T1, message: { model: 'claude-fable-5-1', stop_reason: 'end_turn' } }])
  expect(newestGenuineAssistantAtIn(d)).toBe(Date.parse(T1))
})

test('api-error record (isApiErrorMessage) is NOT consumption', () => {
  const d = dirWith([
    { type: 'assistant', timestamp: T1, message: { model: 'claude-fable-5-1' } },
    { type: 'assistant', timestamp: T2, isApiErrorMessage: true, message: { model: '<synthetic>', stop_reason: 'stop_sequence' } },
  ])
  expect(newestGenuineAssistantAtIn(d)).toBe(Date.parse(T1))
})

test('--continue "No response requested." synthetic (chiron 3779 shape) is NOT consumption', () => {
  const d = dirWith([
    { type: 'assistant', timestamp: T1, message: { model: 'claude-fable-5-1' } },
    { type: 'user', timestamp: T2, isMeta: true, message: { role: 'user', content: 'Continue from where you left off.' } },
    { type: 'assistant', timestamp: T2, isApiErrorMessage: false, message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'No response requested.' }] } },
  ])
  expect(newestGenuineAssistantAtIn(d)).toBe(Date.parse(T1))
})

test('a real turn after the synthetic one counts again', () => {
  const d = dirWith([
    { type: 'assistant', timestamp: T2, message: { model: '<synthetic>' } },
    { type: 'assistant', timestamp: T3, message: { model: 'claude-fable-5-1', stop_reason: 'end_turn' } },
  ])
  expect(newestGenuineAssistantAtIn(d)).toBe(Date.parse(T3))
})

test('stop_reason is never the signal (stop_sequence on a genuine record still counts)', () => {
  const d = dirWith([{ type: 'assistant', timestamp: T1, message: { model: 'claude-opus-5', stop_reason: 'stop_sequence' } }])
  expect(newestGenuineAssistantAtIn(d)).toBe(Date.parse(T1))
})
