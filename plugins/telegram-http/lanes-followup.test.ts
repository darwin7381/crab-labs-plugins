/**
 * Universe 002c: ledger_query that never answers empty, commitment as its own kind, followup(after_minutes, note).
 * Pure parts only (no daemon, no claude): the tool schemas, the argument checks, the due selection, the follow-up
 * message, the commitment derived from a receipt, and the ledger lookup fallbacks.
 */
import { expect, test } from 'bun:test'
import { LEDGER_KINDS, LEDGER_QUERY_DESCRIPTION, queryLedger } from './lanes-digest.ts'
import { LANE_TOOLS, mainToolDefs } from './lanes.ts'
import {
  FOLLOWUP_MAX_MINUTES, FOLLOWUP_MAX_PER_THREAD, checkCommitmentArgs, checkFollowupArgs, commitmentFromReport, commitmentText,
  duePending, followupEventText, simTime, type Followup,
} from './lanes-followup.ts'

const NOW = Date.parse('2026-11-13T09:00:00Z')
const rec = (kind: string, text: string, o: object = {}) => JSON.stringify({ ts: new Date(NOW - 3_600_000).toISOString(), lane: 'adam.reflex.1', thread: 'adam#t-1', kind, text, notify_main: false, ...o })
const ledgerRaw = [
  rec('action', 'reply_agent → eve（hop 1）：下週三 02:00–03:00'),
  rec('receipt', 'run -: done — Eve 要 10 月可用率'),
  rec('notify', '[silent] 昨天新進 31 張工單'),
].join('\n')
const rowsOf = (out: string) => out.split('\n').filter(l => l.includes('｜'))

test('ledger_query description lists every valid kind and says what commitment is for', () => {
  for (const k of LEDGER_KINDS) expect(LEDGER_QUERY_DESCRIPTION).toContain(k)
  expect(LEDGER_QUERY_DESCRIPTION).toContain('kind=commitment')
  const def = mainToolDefs().find((t: any) => t.name === 'ledger_query') as any
  expect(def.description).toBe(LEDGER_QUERY_DESCRIPTION)
  expect(def.inputSchema.properties.kind.description).toContain('commitment')
})

test('ledger_query: an unknown kind lists the valid kinds and falls back to a free-text match across all kinds', () => {
  const out = queryLedger(ledgerRaw, { kind: 'promise', text: '10 月' }, NOW)
  expect(out).toContain('不是帳本的種類')
  for (const k of LEDGER_KINDS) expect(out).toContain(k)
  expect(rowsOf(out).length).toBe(1)
  expect(rowsOf(out)[0]).toContain('10 月可用率')
  // no text: the unknown kind word itself is matched as free text; nothing matches, still not empty (valid kinds listed)
  const out2 = queryLedger(ledgerRaw, { kind: 'commitments' }, NOW)
  expect(out2).toContain('不是帳本的種類')
  expect(rowsOf(out2).length).toBeGreaterThan(0)
})

test('ledger_query: a valid kind with no entries (commitment) says so, shows counts and widens to all kinds', () => {
  const out = queryLedger(ledgerRaw, { kind: 'commitment', text: 'Eve' }, NOW)
  expect(out).toContain('沒有符合的 kind=commitment')
  expect(out).toContain('commitment 0')
  expect(rowsOf(out).length).toBe(2)                       // the action and the receipt that mention Eve
  const none = queryLedger(ledgerRaw, { kind: 'commitment', text: 'zzz-no-such' }, NOW)
  expect(rowsOf(none).length).toBe(3)                      // last resort: the newest entries
  expect(queryLedger(ledgerRaw, { text: 'zzz-no-such' }, NOW)).toContain('沒有符合的紀錄')   // plain text miss: explicit, with counts
  expect(queryLedger(ledgerRaw, { text: 'Eve' }, NOW)).not.toContain('不是帳本的種類')       // text alone searches all kinds
})

test('lane tools: commitment(who, what, by) and followup(after_minutes, note) exist for lanes only', () => {
  const names = LANE_TOOLS.map(t => t.name)
  expect(names).toContain('commitment')
  expect(names).toContain('followup')
  expect(mainToolDefs().map((t: any) => t.name)).not.toContain('followup')
  const fu = LANE_TOOLS.find(t => t.name === 'followup')!
  expect((fu.inputSchema as any).required).toEqual(['after_minutes', 'note'])
  const cm = LANE_TOOLS.find(t => t.name === 'commitment')!
  expect((cm.inputSchema as any).required).toEqual(['who', 'what'])
})

test('followup arguments: minutes 1..240, a note, at most 3 pending per thread', () => {
  expect(checkFollowupArgs({ after_minutes: 5, note: ' recheck  p95 ' }, 0)).toEqual({ ok: true, after: 5, note: 'recheck p95' })
  expect(checkFollowupArgs({ after_minutes: 0, note: 'x' }, 0).ok).toBe(false)
  expect(checkFollowupArgs({ after_minutes: FOLLOWUP_MAX_MINUTES + 1, note: 'x' }, 0).ok).toBe(false)
  expect(checkFollowupArgs({ after_minutes: 'soon', note: 'x' }, 0).ok).toBe(false)
  expect(checkFollowupArgs({ after_minutes: 5, note: '  ' }, 0).ok).toBe(false)
  expect(checkFollowupArgs({ after_minutes: 5, note: 'x' }, FOLLOWUP_MAX_PER_THREAD).ok).toBe(false)
})

const fu = (o: Partial<Followup>): Followup => ({ id: 'fu-1', thread: 'adam#t-1', lane: 'adam.reflex.1', event: 'ev-1', run_id: '88', trigger: 'scheduler', cls: 'scheduler',
  from: 'scheduler', after_minutes: 5, note: 'p95 仍高於 2 秒就重啟一次', created: '2026-11-13T02:50:00.000Z', due: NOW, due_iso: new Date(NOW).toISOString(), state: 'pending', ...o })

test('due selection: only pending ones whose simulated due time has come, earliest first', () => {
  const all = { a: fu({ id: 'a', due: NOW + 60_000 }), b: fu({ id: 'b', due: NOW - 60_000 }), c: fu({ id: 'c', due: NOW - 120_000 }), d: fu({ id: 'd', due: NOW - 1, state: 'fired' }) }
  expect(duePending(all, NOW).map(f => f.id)).toEqual(['c', 'b'])
  expect(duePending({}, NOW)).toEqual([])
})

test('follow-up message: note, simulated time, a run of the same matter; it does not repeat the original event text', () => {
  const t = followupEventText(fu({}), NOW)
  expect(t).toContain('後續檢查 fu-1')
  expect(t).toContain('p95 仍高於 2 秒就重啟一次')
  expect(t).not.toContain('run_id：88'); expect(t).toContain('不用再填 run_id')                    // PL3: the receipt of the run went with the origin's first run
  expect(t).toContain('同一件事的再一趟'); expect(t).toContain('outcome 變了')                    // its Joey line is a raise or it is refused
  expect(t).toContain(simTime(NOW))
  expect(t).not.toContain('[scheduled]')
  expect(simTime(Date.parse('2026-11-13T02:55:00Z'))).toBe('2026-11-13 10:55')
})

test('commitment: who / what / by; derived from a receipt promise; "無" is no commitment', () => {
  expect(checkCommitmentArgs({ who: 'eve', what: '10 月可用率', by: '明天 10:00 前' })).toEqual({ ok: true, c: { who: 'eve', what: '10 月可用率', by: '明天 10:00 前' } })
  expect(checkCommitmentArgs({ who: 'eve', what: 'x' })).toEqual({ ok: true, c: { who: 'eve', what: 'x', by: '未說明' } })
  expect(checkCommitmentArgs({ who: '', what: 'x' }).ok).toBe(false)
  const c = commitmentFromReport('答應 Eve 明天 10 點前給 10 月可用率', 'eve', null)!
  expect(c.who).toBe('eve')
  expect(c.by).toMatch(/明天\s*10\s*點/)
  expect(commitmentText(c)).toContain('答應 eve')
  expect(commitmentFromReport('無', 'eve', null)).toBeNull()
  expect(commitmentFromReport('', 'eve', null)).toBeNull()
  expect(commitmentFromReport('稍後回覆', 'scheduler', 'eve')!.who).toBe('eve')   // the thread's peer wins over the event sender
  expect(commitmentFromReport('稍後回覆', undefined, null)!.by).toBe('未說明')
})
