// Universe 002k (C3): ledger_query(kind=commitment) also lists what was told to peers in the window. Pure lookup, no daemon.
import { test, expect } from 'bun:test'
import { queryLedger } from './lanes-digest.ts'
const NOW = Date.parse('2026-11-13T12:00:00Z')
const at = (h: number) => new Date(NOW - h * 3600_000).toISOString()
const raw = [
  { ts: at(30), lane: 'adam.reflex.1', thread: 'adam#t-old', kind: 'action', text: 'reply_agent → eve（hop 2）：昨天的事已處理。', notify_main: false },
  { ts: at(5), lane: 'adam.reflex.2', thread: 'adam#t-a', kind: 'commitment', text: '答應 eve：週五前給規格（時限：週五前）', notify_main: false, refs: { who: 'eve' } },
  { ts: at(4), lane: 'adam.reflex.3', thread: 'adam#t-b', kind: 'action', text: 'reply_agent → cain（hop 1）：Joey 說下週一可以開始。', notify_main: false },
  { ts: at(3), lane: 'main', thread: null, kind: 'action', text: 'send_to_agent → eve：/v2/orders/bulk Joey 答應了，週五前做好。', notify_main: false },
  { ts: at(2), lane: 'adam.reflex.4', thread: 'adam#t-c', kind: 'action', text: '重啟 mock-api（5xx）', notify_main: false },
  { ts: at(1), lane: 'adam.reflex.5', thread: 'adam#t-d', kind: 'notify', text: '[silent] eve 的事我處理了', notify_main: true },
].map(r => JSON.stringify(r)).join('\n')

test('C3: kind=commitment lists the commitments and, below them, what was told to peers in the window', () => {
  const out = queryLedger(raw, { kind: 'commitment', since: '-24h' }, NOW)
  expect(out).toContain('符合 1 筆'); expect(out).toContain('答應 eve：週五前給規格')
  expect(out).toContain('窗口內對 peer 說過的話：2 筆')
  expect(out).toContain('Joey 說下週一可以開始'); expect(out).toContain('send_to_agent → eve')            // the relay nobody recorded as a commitment
  expect(out).not.toContain('昨天的事已處理')                                                              // outside the window
  expect(out).not.toContain('重啟 mock-api')                                                              // an action that is not something told to a peer
  expect(out.indexOf('答應 eve')).toBeLessThan(out.indexOf('窗口內對 peer 說過的話'))
})

test('C3: without a window it is the whole ledger; text narrows both lists', () => {
  const all = queryLedger(raw, { kind: 'commitment' }, NOW)
  expect(all).toContain('窗口內對 peer 說過的話：3 筆'); expect(all).toContain('昨天的事已處理')
  const eve = queryLedger(raw, { kind: 'commitment', text: 'eve', since: '-24h' }, NOW)
  expect(eve).toContain('窗口內對 peer 說過的話：1 筆'); expect(eve).toContain('send_to_agent → eve'); expect(eve).not.toContain('cain')
})

test('C3: no commitment at all, but peers were told something: the old note stays and the told list follows', () => {
  const noCm = raw.split('\n').filter(l => !l.includes('"commitment"')).join('\n')
  const out = queryLedger(noCm, { kind: 'commitment', since: '-24h' }, NOW)
  expect(out).toContain('沒有符合的 kind=commitment'); expect(out).toContain('窗口內對 peer 說過的話：2 筆'); expect(out).toContain('send_to_agent → eve')   // the old note stays, the told list follows
  expect(out).not.toContain('不是帳本的種類')
  // nothing told and nothing promised: the old fallback (never an empty answer), and an empty told list that says so
  const none = queryLedger(JSON.stringify({ ts: at(1), lane: 'x', thread: null, kind: 'notify', text: 'hello', notify_main: true }), { kind: 'commitment' }, NOW)
  expect(none).toContain('沒有符合的 kind=commitment'); expect(none).toContain('窗口內對 peer 說過的話：0 筆'); expect(none).toContain('（這個範圍內沒有）')
})

test('C3: other kinds are untouched', () => {
  const out = queryLedger(raw, { kind: 'action', since: '-24h' }, NOW)
  expect(out).not.toContain('窗口內對 peer 說過的話'); expect(out).toContain('重啟 mock-api')
})
