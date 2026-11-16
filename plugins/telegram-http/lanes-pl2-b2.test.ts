// Universe 002m (L6B2, RV6 B06 #1 r2/r3: #1027 5 lines, #1025 4 lines, both success reports with `failed_step=null`): the scheduled run's one-line gate does
// not read field names as failure words. Card 「沒有變化就只留一行」 (002k B11). No process, no network.
import { test, expect } from 'bun:test'
import { failureSaid, scheduledNotifyGate } from './lanes.ts'
const tok = () => ({ runId: 'adam.reflex.7.r1', lane: 'adam.reflex.7', evId: 'ev', closers: [], critical: false, trigger: 'scheduled', cls: 'routine', escalated: false, pushed: false }) as any
const SUCCESS = ['備份檢查（run 31）完成：', 'status=ok, last_run=2026-11-13T03:00, failed_step=null', 'mock-api error_rate 0.1%、p95 190ms', 'errors: 0，無異常', '下一次 11-14 03:00'].join('\n')

test('L6B2: field names and empty failure fields are not failure words; negated failure words are not either', () => {
  for (const t of ['failed_step=null', 'error_rate 0.1%', 'errors: 0', 'http.errors=0', 'error: none', 'failures=[]', '無異常，未重啟', '沒有失敗', 'no errors', '0 failures', 'error_rate=3.2%'])
    expect([t, failureSaid(t)]).toEqual([t, false])
})

test('L6B2: what does say it failed still does: a failure word, a failure field with a value, a count above 0', () => {
  for (const t of ['備份失敗：403', '上傳異常', 'state=failed', 'outcome: failed', 'failed_step=upload', 'errors=3', 'error="403 Forbidden"', 'the backup failed at upload', 'HTTP 500 error'])
    expect([t, failureSaid(t)]).toEqual([t, true])
})

test('L6B2: a 5-line success report with failed_step=null is sent back once for one line; the full report again goes out', () => {
  const k = tok()
  expect(() => scheduledNotifyGate(k, SUCCESS)).toThrow(/notify_joey not sent: this is a scheduled run and nothing in your message says it failed or changed, but it is 5 lines long/)
  expect(() => scheduledNotifyGate(k, SUCCESS)).not.toThrow()                       // sent back once only
})

test('L6B2: a failure report of the same shape goes out at once', () => {
  expect(() => scheduledNotifyGate(tok(), SUCCESS.replace('failed_step=null', 'failed_step=upload'))).not.toThrow()
  expect(() => scheduledNotifyGate(tok(), SUCCESS + '\n上傳失敗：403')).not.toThrow()
})
