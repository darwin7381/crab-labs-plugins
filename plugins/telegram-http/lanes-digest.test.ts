// Universe 002b: the digest never wakes an idle main (it rides along with the main's next natural turn), it is
// structured per lane thread, and the main has a ledger lookup. Pure functions + the lanes.ts glue on a temp dir;
// no network, no daemon, no lane process (LANES_CLAUDE_BIN=/bin/false like lanes-notify.test.ts; no routed event
// here targets a lane).
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  lanesInit, routeEvent, callLaneTool, callMainTool, ledgerQueryTool, identityCard, mainToolDefs, isMainTool, LANE_TOOLS, __lanesState, __digest,
} from './lanes.ts'
import {
  cleanReport, DIGEST_MAX_ROUTINE, LEDGER_QUERY_MAX, LEDGER_QUERY_TEXT_MAX, parseSince, queryLedger, renderDigest, type LedgerRec,
} from './lanes-digest.ts'

const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-digest-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'),
  claude_pid: 1, registered_at: new Date().toISOString() }))
lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  authOk: () => false, registryNames: () => ['eve', 'cain'] } as any)

// ------------------------------------------------------------------ fixtures (the shapes the 002 Stage A ledger had)
const T0 = Date.parse('2026-11-13T02:00:00Z')
let tick = 0
const L = (o: Partial<LedgerRec> & { kind: string; text: string }): LedgerRec =>
  ({ ts: new Date(T0 + (tick++) * 60_000).toISOString(), lane: 'adam.reflex.3', thread: 'adam#t-cc94ed', event: 'ev', notify_main: true, refs: null, detail: null, ...o })
const jl = (recs: LedgerRec[]) => recs.map(r => JSON.stringify(r))
const silentFyi = (n: string) => L({ lane: `adam.reflex.${n}`, thread: `adam#t-0${n}`, kind: 'notify', refs: { tier: 'silent', escalated: false },
  text: `[silent] [api-health-check run:88] mock-api 目前 degraded，p95 2400ms（門檻 2000ms），尚未重啟` })
const escalation = () => L({ lane: 'adam.reflex.5', thread: 'adam#t-04f200', kind: 'escalation',
  text: '【A-1103 升級｜mock-backup｜P1】upload 連續 403，需要主線轉 Joey 決定由平台組修 bucket policy' })
const escalatedPush = () => L({ lane: 'adam.reflex.5', thread: 'adam#t-04f200', kind: 'notify', refs: { tier: 'push', escalated: true },
  text: '[push] A-1103 mock-backup P1 回報（已升級主線，請主線轉 Joey 決定）' })
function reset(lines: string[]): void {
  writeFileSync(join(dir, 'ledger.jsonl'), lines.length ? lines.join('\n') + '\n' : '')
  rmSync(join(dir, 'digest.json'), { force: true })
  rmSync(join(dir, 'routing.jsonl'), { force: true })
}

// ------------------------------------------------------------------ 1. wake entries: the only things that wake an idle main
// ------------------------------------------------------------------ 2. digest NOT delivered to an idle main
// ------------------------------------------------------------------ 3. piggyback: exactly once on the next inbound
// ------------------------------------------------------------------ 4. an escalation still wakes the main and carries the pending digest
// ------------------------------------------------------------------ 5. structured digest
const report = { happened: 'Eve（mesh-50008）要 mock-api 10 月可用率放進月報，限「明天 10 點前」', did: '回覆 Eve：「10 月 mock-api 可用率我還沒有數字，不承諾明天 10 點前」',
  promised: '對 Eve：算出來後附算法與來源回覆；沒有時限', needs_main: '決定誰算、用哪個來源、期限' }
const reportRec = (rep: any, o: Partial<LedgerRec> = {}) => L({ kind: 'receipt', text: 'run -: done — x', refs: { report: rep }, ...o })

test('structured digest: a thread that promised something shows all four parts with the lane\'s concrete facts', () => {
  const d = renderDigest([reportRec(report, { lane: 'adam.reflex.6', thread: 'adam#t-b30f47' })])!
  const lines = d.text.split('\n')
  const i = lines.findIndex(l => l.startsWith('▸ adam.reflex.6｜adam#t-b30f47｜11-13 '))
  expect(i).toBeGreaterThan(0)
  // 002k (B15): a heavy block is at most three lines
  expect(lines[i]).toContain(`｜發生：${report.happened}`)
  expect(lines[i + 1]).toBe(`  做了：${report.did}｜承諾：${report.promised}`)
  expect(lines[i + 2]).toBe(`  需主線：${report.needs_main}`)
  expect(lines[i + 3]).toContain('（只列這次新增的')
  expect(d.text).toContain('mesh-50008')
  expect(d.text).toContain('不承諾明天 10 點前')                                      // the exact text sent to the peer survives
})

test('structured digest: routine / FYI threads are ONE line each, with their facts; the header counts threads and entries', () => {
  const rep = { happened: 'api-health-check run:88：mock-api p95 2400ms 持續 6 分鐘（門檻 2000ms）', did: '10:56:07 依 runbook 滾動重啟 api-1、api-2；10:56:09 p95 190ms、error_rate 0.1%', promised: '無', needs_main: '無' }
  const tickets = { happened: 'daily-ticket-digest run:12：昨天新進工單 31 張（T-31394 至 T-31424）', did: 'bin/svc GET tickets 翻頁計數', promised: '無', needs_main: '無' }
  const d = renderDigest([
    reportRec(rep, { lane: 'adam.reflex.3', thread: 'adam#t-cc94ed' }), { ...silentFyi('3'), thread: 'adam#t-cc94ed' },   // the lane's own notice + its report: still one thread
    reportRec(tickets, { lane: 'adam.reflex.4', thread: 'adam#t-241400' }),
  ])!
  const body = d.text.split('\n').filter(l => l.startsWith('•') || l.startsWith('▸'))
  expect(body.length).toBe(2)                                                        // one line per thread, no 4-part block
  expect(body.every(l => l.startsWith('•'))).toBe(true)
  expect(body[0]).toContain('run:88')
  expect(body[0]).toContain('10:56:07')
  expect(body[1]).toContain('T-31394 至 T-31424')
  expect(body[1]).toContain('31 張')
  expect(d.text.split('\n')[0]).toContain('2 條線有動靜')
  expect(d.threads).toBe(2)
})

test('structured digest: lane thread with an escalation is a block first (never dropped), carries the escalation as 需主線, never "routine"', () => {
  const routine = reportRec({ happened: '備份檢查 run:46：失敗→成功', did: '無', promised: '無', needs_main: '無' }, { lane: 'adam.reflex.7', thread: 'adam#t-b4154b' })
  const d = renderDigest([routine, escalation(), escalatedPush()])!
  const lines = d.text.split('\n')
  const iEsc = lines.findIndex(l => l.startsWith('▸ adam.reflex.5'))
  const iRoutine = lines.findIndex(l => l.startsWith('• adam.reflex.7'))
  expect(iEsc).toBeGreaterThan(0)
  expect(iRoutine).toBeGreaterThan(iEsc)
  expect(lines[iEsc + 2]).toContain('需主線：【A-1103 升級｜mock-backup｜P1】upload 連續 403')
  expect(lines[iEsc + 1]).not.toContain('承諾')                                         // 002k (B15): a "none" part is left out
  expect(lines[iEsc + 1]).toContain('已通知 Joey（已響鈴），不要重複通知他')              // what the lane did, from its push
  expect(lines[iEsc + 2]).toContain('這件事交給你了')                                  // 002d: the handoff names its owner (on the 需主線 line: three lines in all)
})

test('structured digest: old-style lanes (no four fields) fall back — receipt summary / notify text / actions / commitments / memory proposals', () => {
  const oldReceipt = L({ lane: 'adam.reflex.4', thread: 'adam#t-241400', kind: 'receipt', notify_main: false, text: 'run 12: done — daily-ticket-digest: 2026-11-12 新進工單 31 張' })
  const sent = L({ lane: 'adam.reflex.4', thread: 'adam#t-241400', kind: 'action', notify_main: false, text: 'reply_agent → eve（hop 2）：下週三 02:00–03:00 維護' })
  const mem = L({ lane: 'adam.reflex.4', thread: 'adam#t-241400', kind: 'memory_proposal', text: '記下：mock-api 每週三 02:00–03:00 維護' })
  const d = renderDigest([oldReceipt, sent, mem])!
  expect(d.text).toContain('發生：run 12: done — daily-ticket-digest: 2026-11-12 新進工單 31 張')   // old `summary` still reaches the main
  expect(d.text).toContain('做了：reply_agent → eve（hop 2）：下週三 02:00–03:00 維護')            // deterministic: what the lane sent
  expect(d.text).toContain('需主線：記憶提案：記下：mock-api 每週三 02:00–03:00 維護')
  const onlyNotice = renderDigest([silentFyi('3')])!
  expect(onlyNotice.text).toContain('• adam.reflex.3｜adam#t-03｜例行：[api-health-check run:88] mock-api 目前 degraded')
  const commit = renderDigest([L({ kind: 'commitment', text: '主線已答應 Eve：週五前給報告' }), silentFyi('3')])!
  expect(commit.text).toContain('承諾：主線已答應 Eve：週五前給報告')
})

test('structured digest: an escalating old-style lane keeps its reply to the peer under 做了 (not as 發生); a fork result stands in as 發生', () => {
  const sentToEve = L({ lane: 'adam.reflex.6', thread: 'adam#t-b30f47', kind: 'action', notify_main: false, text: 'reply_agent → eve（hop 2）：10 月可用率我還沒有數字，不承諾明天 10 點前' })
  const esc = L({ lane: 'adam.reflex.6', thread: 'adam#t-b30f47', kind: 'escalation', text: 'Eve 要 10 月可用率放進月報，限明天 10 點前；請主線決定誰算' })
  const d = renderDigest([esc, sentToEve])!
  expect(d.text).toContain('｜發生：升級主線（見「需主線」）')
  expect(d.text).toContain('  做了：reply_agent → eve（hop 2）：10 月可用率我還沒有數字，不承諾明天 10 點前')
  expect(d.text).toContain('  需主線：Eve 要 10 月可用率放進月報')
  const fork = renderDigest([L({ lane: 'adam.fork.1', thread: 'adam#t-f1', kind: 'action', text: '分身線結果：已查完 mock-api 10 月可用率 99.93%' })])!
  expect(fork.text).toContain('例行：分身線結果：已查完 mock-api 10 月可用率 99.93%')
})

test('structured digest: capped and compact — at most DIGEST_MAX_ROUTINE routine lines, the rest counted; every line is short', () => {
  const recs = Array.from({ length: 14 }, (_, i) => silentFyi(String(i + 10)))          // no class on them: none is merged with another (B15)
  const d = renderDigest(recs)!
  expect(d.text.split('\n').filter(l => l.startsWith('•')).length).toBe(DIGEST_MAX_ROUTINE)
  expect(d.text).toContain(`另有 ${14 - DIGEST_MAX_ROUTINE} 條線沒列出`)
  expect(Math.max(...d.text.split('\n').map(l => l.length))).toBeLessThan(420)
})

test('lane receipt tool: four fields feed the digest (notify_main), a bare summary receipt stays ledger-only as before; run_id optional', async () => {
  reset([])
  const st = __lanesState()
  st.lanes['adam.reflex.9'] = { id: 'adam.reflex.9', kind: 'reflex', n: 9, session_id: 's', thread: 'adam#t-r9', status: 'running', created: '', last: '', transcript: '/x', runs: 0, tokens_in: 0, tokens_out: 0 } as any
  const tok = { runId: 'adam.reflex.9.r1', lane: 'adam.reflex.9', evId: 'ev-9', closers: [], critical: false, trigger: 'peer', cls: 'peer', escalated: false, pushed: false } as any
  const out = await callLaneTool(tok, 'receipt', { outcome: 'done', ...report })
  expect(out).toContain('receipt recorded')
  await callLaneTool(tok, 'receipt', { outcome: 'nothing-to-do', summary: 'hourly-backup-check: 無變化' })
  const rows = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  expect(rows[0]).toMatchObject({ kind: 'receipt', notify_main: true, refs: { report } })
  expect(rows[0].text).toBe(`run -: done — ${report.happened}`)
  expect(rows[1]).toMatchObject({ kind: 'commitment', notify_main: false, refs: { who: '未指明', what: report.promised, from: 'receipt.promised' } })   // 002c: the receipt's promise gets its own kind
  expect(rows[2]).toMatchObject({ kind: 'receipt', notify_main: false, refs: null, text: 'run -: nothing-to-do — hourly-backup-check: 無變化' })
  const t = __digest()!
  expect(t.text).toContain(`發生：${report.happened}`)                                // lane report → digest, end to end
  expect(t.fields.items).toBe(1)
  expect(cleanReport({ happened: '  a\n b ', did: 1 })).toEqual({ happened: 'a b', did: '', promised: '', needs_main: '' })
  expect(cleanReport({ summary: 'x' })).toBeNull()
  const rcpt = LANE_TOOLS.find(x => x.name === 'receipt')!
  expect(Object.keys((rcpt.inputSchema as any).properties)).toEqual(['run_id', 'outcome', 'summary', 'happened', 'did', 'promised', 'needs_main'])
  expect((rcpt.inputSchema as any).required).toEqual(['outcome'])
})

// ------------------------------------------------------------------ 6. ledger_query
const lq = (i: number, o: Partial<LedgerRec> = {}) => L({ ts: new Date(T0 + i * 60_000).toISOString(), kind: 'action', notify_main: false, text: `entry ${i}`, ...o })
const NOW = T0 + 600 * 60_000
const rowsOf = (out: string) => out.split('\n').slice(1).filter(l => !l.startsWith('（'))   // 002d: the last line is a footer (what else exists)

test('ledger_query: filters — since (ISO and relative), kind, text (substring and regex, case-insensitive)', () => {
  const raw = jl([
    lq(0, { kind: 'receipt', text: 'run 41: nothing-to-do — hourly-backup-check last_run failed upload HTTP 403' }),
    lq(100, { kind: 'action', lane: 'adam.reflex.2', thread: 'adam#t-af248d', text: 'reply_agent → eve（hop 2）：下週三 02:00–03:00（UTC+8）' }),
    lq(200, { kind: 'escalation', text: '【A-1103 升級｜mock-backup｜P1】upload 連續 403' }),
    lq(300, { kind: 'fyi', lane: 'router', thread: null, text: 'eve：週五的貼文我排好了（P-201，週五 09:00 發布）' }),
    lq(400, { kind: 'notify', text: '[push] A-1103 mock-backup P1 回報' }),
  ]).join('\n')
  const q = (a: object) => queryLedger(raw, a, NOW)
  expect(rowsOf(q({})).length).toBe(3)                                               // 002d: no filter = the activity list, one line per thread / threadless event
  expect(q({}).split('\n')[0]).toContain('活動清單：3 件事')
  expect(rowsOf(q({ kind: 'action' })).length).toBe(1)
  expect(rowsOf(q({ kind: 'escalation' })).length).toBe(1)
  expect(rowsOf(q({ kind: 'FYI' }))[0]).toContain('P-201')                           // kind is case-insensitive too
  expect(rowsOf(q({ text: 'a-1103' })).length).toBe(2)                               // case-insensitive substring, across kinds
  expect(rowsOf(q({ text: 'a-1103', kind: 'notify' })).length).toBe(1)
  expect(rowsOf(q({ text: 'P-2\\d\\d' }))[0]).toContain('P-201')                       // regex
  expect(rowsOf(q({ text: 'UTC+8' }))[0]).toContain('下週三')                         // regex metacharacters still match as the literal substring (as a regex "UTC+8" would not)
  expect(rowsOf(q({ text: '[unclosed' })).length).toBe(0)                            // invalid regex, no such substring: empty, not a crash
  expect(rowsOf(q({ text: 'adam#t-af248d' })).length).toBe(1)                        // thread is searchable
  expect(rowsOf(q({ since: '-4h' })).length).toBe(1)                                 // NOW - 240 min = minute 360: only the entry at 400
  expect(rowsOf(q({ since: new Date(T0 + 150 * 60_000).toISOString() })).length).toBe(2)   // activity list: the thread with entries 200+400, the notice at 300
  expect(rowsOf(q({ since: '-11h', kind: 'receipt' })).length).toBe(1)               // NOW - 660 min is before minute 0
  expect(q({ since: '-9h', kind: 'receipt' })).toContain('沒有符合的 kind=receipt')    // NOW - 540 min is after the receipt: 002c says so and widens to all kinds (never empty)
  expect(q({ since: '-1m' })).toContain('這個範圍內沒有紀錄')
})

test('ledger_query: newest last, capped at 30 entries, each text cut to 600 chars, header says how many matched', () => {
  const raw = jl(Array.from({ length: 45 }, (_, i) => lq(i, { text: i === 44 ? 'x'.repeat(2000) : `entry ${i}` }))).join('\n')
  const out = queryLedger(raw, { kind: 'action' }, NOW)
  const rows = rowsOf(out)
  expect(rows.length).toBe(LEDGER_QUERY_MAX)
  expect(out.split('\n')[0]).toContain('符合 45 筆，只顯示最新 30 筆')
  expect(rows[0]).toContain('entry 15')                                              // oldest of the newest 30
  expect(rows[rows.length - 1].endsWith('…')).toBe(true)                             // newest last, truncated
  expect(rows[rows.length - 1].split('｜').pop()!.length).toBe(LEDGER_QUERY_TEXT_MAX)
  expect(rows[0]).toMatch(/^11-13 \d\d:\d\d｜action｜adam\.reflex\.3｜adam#t-cc94ed｜entry 15$/)   // timestamp, kind, lane, thread, text
})

test('ledger_query: missing / empty / damaged ledger is safe; bad arguments are explained, not thrown', () => {
  expect(queryLedger(null, {}, NOW)).toContain('帳本還沒有任何紀錄')
  expect(queryLedger('', { text: 'x' }, NOW)).toContain('帳本還沒有任何紀錄')
  expect(queryLedger('not json\n{"also":"bad"\n', {}, NOW)).toContain('帳本還沒有任何紀錄')
  expect(rowsOf(queryLedger('garbage\n' + jl([lq(1)])[0] + '\n', {}, NOW)).length).toBe(1)   // a damaged line is skipped
  expect(queryLedger(jl([lq(1)]).join('\n'), { kind: 'nope' }, NOW)).toContain('不是帳本的種類')
  expect(queryLedger(jl([lq(1)]).join('\n'), { since: 'yesterday' }, NOW)).toContain('since 格式不對')
  expect(parseSince('-4h', 1_000_000_000)).toBe(1_000_000_000 - 4 * 3_600_000)
  expect(parseSince('30m', 1_000_000_000)).toBe(1_000_000_000 - 30 * 60_000)
  expect(parseSince('', 1)).toBeNull()
  expect(parseSince(undefined, 1)).toBeNull()
})

test('ledger_query tool reads the LIVE ledger at call time (a missing file = empty ledger) and is main-only', async () => {
  rmSync(join(dir, 'ledger.jsonl'), { force: true })
  expect(existsSync(join(dir, 'ledger.jsonl'))).toBe(false)
  expect(ledgerQueryTool({})).toContain('帳本還沒有任何紀錄')
  writeFileSync(join(dir, 'ledger.jsonl'), jl([lq(1, { text: 'first' })]).join('\n') + '\n')
  expect(rowsOf(ledgerQueryTool({ text: 'first' })).length).toBe(1)
  writeFileSync(join(dir, 'ledger.jsonl'), readFileSync(join(dir, 'ledger.jsonl'), 'utf8') + jl([lq(2, { text: 'appended later' })]).join('\n') + '\n')
  expect(rowsOf(ledgerQueryTool({ text: 'appended later' })).length).toBe(1)          // no cache: the append is visible
  expect(isMainTool('ledger_query')).toBe(true)
  expect(mainToolDefs().map((t: any) => t.name)).toContain('ledger_query')
  expect(LANE_TOOLS.find(t => t.name === 'ledger_query')!.description).toContain('read only')   // 002k (B20): lanes get a read-only lookup; the main's tool stays main-only (below)
  expect(await callMainTool('ledger_query', {}, undefined)).toStartWith('refused:')    // a session that is not the registered main
  expect(await callMainTool('ledger_query', {}, 'some-other-session')).toStartWith('refused:')
  const def = mainToolDefs().find((t: any) => t.name === 'ledger_query')
  expect(Object.keys(def.inputSchema.properties)).toEqual(['since', 'kind', 'text'])
})
