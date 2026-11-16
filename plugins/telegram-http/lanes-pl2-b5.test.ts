// Universe 002m (L6B5, RV6 B08 #12 F F F: 9 / 11 / 12 lines): a digest has at most 8 content lines (design/main-role 「每次摘要有行數上限」, B08's 8).
// Content = every line but the header, the bracketed notes 〔…〕 and the footnote （…）, as the B08 judge counts them. No process, no network.
import { test, expect } from 'bun:test'
import { renderDigest, digestContentLines, DIGEST_MAX_LINES, MUST_KNOW_MARK, type LedgerRec } from './lanes-digest.ts'
const T0 = Date.parse('2026-11-13T03:00:00Z')
let tick = 0
const R = (o: Partial<LedgerRec> & { kind: string; text: string }): LedgerRec =>
  ({ ts: new Date(T0 + (tick++) * 1000).toISOString(), lane: 'adam.reflex.1', thread: 'adam#t-x', event: 'ev', notify_main: true, refs: null, detail: null, ...o })
const routine = (n: number, cls: string) => R({ lane: `adam.reflex.${n}`, thread: `adam#t-r${n}`, kind: 'receipt', text: 'run -: done',
  refs: { report: { happened: `例行 ${n}：正常`, did: '查 health', promised: '無', needs_main: '無' }, class: cls } })
const heavy = (n: number) => R({ lane: `adam.reflex.${n}`, thread: `adam#t-h${n}`, kind: 'receipt', text: 'run -: done',
  refs: { report: { happened: `Eve 要第 ${n} 份報表`, did: `回覆 Eve：第 ${n} 份下週給`, promised: `對 Eve：第 ${n} 份下週三前給`, needs_main: `第 ${n} 份要主線排時間` }, class: 'peer' } })
const esc = (n: number) => R({ lane: `adam.reflex.${n}`, thread: `adam#t-e${n}`, kind: 'escalation', text: `〔ho-${n}〕備份 ${n} 失敗 403，請主線決定` })
const must = (n: number) => R({ lane: `adam.reflex.${n}`, thread: `adam#t-m${n}`, kind: 'notify', refs: { tier: 'ledger', tier_rule: 'critical-mark', must_know: true, class: 'alert-critical' }, text: `【主線必須知道】[ledger] 嚴重警報 ${n}：全部回 5xx` })

test('L6B5: the cap is 8 content lines; the env can lower or raise it, never below 3', () => {
  expect(DIGEST_MAX_LINES).toBe(8)
  const t = '〔車道摘要｜…〕\n▸ a\n  做了：x\n〔以下只是讓你知道：…〕\n• b\n另有 2 條線沒列出。\n（只列這次新增的。…）'
  expect(digestContentLines(t)).toEqual(['▸ a', '  做了：x', '• b', '另有 2 條線沒列出。'])
})

test('L6B5: B08\'s mix (3 heavy blocks of 3 lines + 5 routine classes = 14 lines under 002l\'s caps) comes in 8 content lines, and says what it left out', () => {
  const d = renderDigest([heavy(1), heavy(2), heavy(3), routine(10, 'a'), routine(11, 'b'), routine(12, 'c'), routine(13, 'd'), routine(14, 'e')])!
  const c = digestContentLines(d.text)
  expect(c.length).toBe(8)
  expect(c.filter(l => l.startsWith('▸')).length).toBe(3)                               // the three heavy blocks, a line each
  expect(c.filter(l => l.startsWith('•')).length).toBe(5)
  // one routine class more: the cap of 5 leaves one out, and the line that says so takes the place of a fifth
  const d2 = renderDigest([heavy(1), heavy(2), heavy(3), ...['a', 'b', 'c', 'd', 'e', 'f'].map((k, i) => routine(10 + i, k))])!
  const c2 = digestContentLines(d2.text)
  expect(c2.length).toBe(8)
  expect(c2.filter(l => l.startsWith('•')).length).toBe(4)
  expect(c2[c2.length - 1]).toBe('另有 2 條線沒列出。')
  expect(c.filter(l => l.startsWith('▸')).every(l => l.includes('需主線：'))).toBe(true)   // a one-line block keeps what the main must do
})

test('L6B5: with room, blocks open to their full lines; what was handed to the main opens first', () => {
  const d = renderDigest([esc(1), heavy(2), routine(10, 'a')])!
  const c = digestContentLines(d.text)
  expect(c.length).toBeLessThanOrEqual(8)
  expect(c).toContain('  需主線：〔ho-1〕備份 1 失敗 403，請主線決定（這件事交給你了：車道沒有通知過 Joey，處理完由你回報他一次。）')
  expect(c.some(l => l.startsWith('  做了：回覆 Eve：第 2 份'))).toBe(true)
})

test('L6B5: escalations and critical marks are never dropped: past 8 they are named on one line; the total stays 8', () => {
  const d = renderDigest([...[1, 2, 3, 4, 5, 6].map(esc), ...[7, 8, 9].map(must), heavy(20), routine(30, 'a')])!
  const c = digestContentLines(d.text)
  expect(c.length).toBe(8)
  for (const n of [1, 2, 3, 4, 5, 6]) expect(d.text).toContain(`adam#t-e${n}`)
  for (const n of [7, 8, 9]) expect(d.text).toContain(`${MUST_KNOW_MARK}adam.reflex.${n}｜adam#t-m${n}`)
  expect(c.filter(l => /^另有 2 件不能略過的事放不下，這裡只列名字.*adam#t-m9。另有 2 條線沒列出。$/.test(l)).length).toBe(1)
  expect(c.filter(l => l.startsWith('▸')).length).toBe(7)
})

test('L6B5: the open Joey proposals and the holds are lines too', () => {
  const reopen = [1, 2].map(n => R({ lane: 'adam.reflex.60', kind: 'memory_proposal', refs: { proposal_id: `mp-${n}`, joey: true }, text: `記下：Joey 說的第 ${n} 件事` }))
  const d = renderDigest([heavy(1), heavy(2), heavy(3), routine(10, 'a'), routine(11, 'b'), routine(12, 'c')], reopen, ['• cain：暫停到 12:00'])!
  const c = digestContentLines(d.text)
  expect(c.length).toBe(8)
  expect(d.text).toContain('mp-1'); expect(d.text).toContain('mp-2'); expect(d.text).toContain('• cain：暫停到 12:00')
})
