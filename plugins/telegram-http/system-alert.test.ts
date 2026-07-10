// Unit test for the 429/usage-limit alert fix (Joey 2026-07-10).
// Run: bun test system-alert.test.ts
import { test, expect } from 'bun:test'
import { extractSystemAlert, handleOtlpLogs, startSystemAlertWatcher } from './system-alert'

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
