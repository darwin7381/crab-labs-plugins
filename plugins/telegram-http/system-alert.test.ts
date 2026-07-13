// Unit test for the 429/usage-limit alert fix (Joey 2026-07-10).
// Run: bun test system-alert.test.ts
import { test, expect } from 'bun:test'
import { extractSystemAlert, handleOtlpLogs, startSystemAlertWatcher, newestJsonl, resolveWatchFile } from './system-alert'
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Real record shape captured from a live claude usage-limit event.
const usageLimitLine = JSON.stringify({
  parentUuid: 'x', isSidechain: false, type: 'assistant', uuid: 'u1',
  timestamp: '2026-07-10T14:00:00.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your weekly limit · resets Jun 9 at 6am (Asia/Taipei)" }] },
  error: 'usage_limit', isApiErrorMessage: true, apiErrorStatus: 429,
})

test('jsonl layer surfaces claude human usage-limit message verbatim', () => {
  expect(extractSystemAlert(usageLimitLine)).toBe(
    "You've hit your weekly limit · resets Jun 9 at 6am (Asia/Taipei)",
  )
})

test('jsonl layer still catches login + refusal (regression)', () => {
  const login = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: 401 Please run /login' }] } })
  expect(extractSystemAlert(login)).toContain('Please run /login')
  const refusal = JSON.stringify({ type: 'assistant', message: { stop_reason: 'refusal', content: [{ type: 'text', text: 'no' }] } })
  expect(extractSystemAlert(refusal)).toContain('Refusal')
})

test('OTLP layer SUPPRESSES the raw 429 rate-limit string', () => {
  const sent: string[] = []
  startSystemAlertWatcher({ notify: (m) => sent.push(m), log: () => {} })
  const payload = { resourceLogs: [{ scopeLogs: [{ logRecords: [{
    attributes: [
      { key: 'event.name', value: { stringValue: 'api_error' } },
      { key: 'status_code', value: { stringValue: '429' } },
      { key: 'error', value: { stringValue: "This request would exceed your account's rate limit. Please try again later." } },
      { key: 'model', value: { stringValue: 'claude-opus-4-8' } },
    ],
  }] }] }] }
  const found = handleOtlpLogs(payload)
  expect(found).toBe(0)                    // 429 not counted as forwarded
  expect(sent.join('\n')).not.toContain('rate limit')  // ugly string never sent
})

test('OTLP layer still forwards non-429 api_error (regression)', () => {
  const sent: string[] = []
  startSystemAlertWatcher({ notify: (m) => sent.push(m), log: () => {} })
  const payload = { resourceLogs: [{ scopeLogs: [{ logRecords: [{
    attributes: [
      { key: 'event.name', value: { stringValue: 'api_error' } },
      { key: 'status_code', value: { stringValue: '500' } },
      { key: 'error', value: { stringValue: 'Internal server error' } },
    ],
  }] }] }] }
  expect(handleOtlpLogs(payload)).toBe(1)
  expect(sent.join('\n')).toContain('HTTP 500')
})

// issue #6 (Codex stop-gate follow-up): the roamer fallback must tail its EXACT
// target session, not merely the newest jsonl in the dir. A cwd can hold several
// sessions; an idle target loses the newest-mtime race to a sibling, so
// newest-in-dir would tail the wrong session and miss the target's alerts.
test('roamer resolveFile pins the exact target session over a newer sibling (issue #6)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sysalert-'))
  const target = join(dir, 'aaaaaaaa.jsonl')   // the /roam target
  const sibling = join(dir, 'bbbbbbbb.jsonl')   // another session in the same cwd
  writeFileSync(target, 'target\n')
  writeFileSync(sibling, 'sibling\n')
  const now = Date.now()
  utimesSync(target, new Date(now - 10_000), new Date(now - 10_000)) // target is OLDER
  utimesSync(sibling, new Date(now), new Date(now))                  // sibling is NEWER

  // newest-in-dir (the old heuristic) would pick the sibling — the wrong session
  expect(newestJsonl(dir)?.path).toBe(sibling)
  // …but resolveFile pins the exact target, even though it's older
  expect(resolveWatchFile(() => target, dir)?.path).toBe(target)
  // channel-bot mode (no resolveFile) keeps taking the newest — unchanged
  expect(resolveWatchFile(undefined, dir)?.path).toBe(sibling)
  // between /roam targets → nothing to tail
  expect(resolveWatchFile(() => null, dir)).toBeNull()
  // a target whose jsonl doesn't exist yet (0-turn session) is skipped, not thrown
  expect(resolveWatchFile(() => join(dir, 'nope.jsonl'), dir)).toBeNull()
})
