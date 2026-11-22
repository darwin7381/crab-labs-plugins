// Universe 002d: one owner per event.
//   ask_joey      the lane needs JOEY: it tells him itself, once (push); the main is not woken, it reads it in its digest
//   handoff_main  the lane needs the MAIN: the main is woken and reports; Joey hears nothing from the lane or the router
//   fallback      a handoff the main does not get (not connected / not delivered in time) is told to Joey, once
// and ledger_query's filtered answers (the activity list is the M3 event view: lanes-digest-m3.test.ts).
// No network, no daemon, no lane process.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { lanesInit, callLaneTool, identityCard, laneContext, routeEvent, LANE_TOOLS, __lanesState, __setMainConnected, __main, __digest, __events } from './lanes.ts'
import { queryLedger, stamp, parseSince, type LedgerRec } from './lanes-digest.ts'

const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-handoff-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'),
  claude_pid: 1, registered_at: new Date().toISOString() }))
const sent: Array<{ text: string; silent: boolean }> = []
let nextId = 1000
lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  authOk: () => false, registryNames: () => ['eve', 'cain'],
  sendBot: async (_chat: string, text: string, opts: { silent?: boolean }) => { sent.push({ text, silent: !!opts.silent }); return nextId++ },
  joeyChatId: () => '1' } as any)

const ledgerRows = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
function reset(mainConnected = true): void {
  writeFileSync(join(dir, 'ledger.jsonl'), '')
  const st = __lanesState()
  st.handoffs = {}; st.dedupe = {}; st.pushes = {}
  sent.length = 0
  __setMainConnected(mainConnected ? 'mcp-main' : null)
}
let n = 0
function run(cls: string, critical = false): any {
  n += 1
  const id = `adam.reflex.${n}`
  __lanesState().lanes[id] = { id, kind: 'reflex', n, session_id: 's', thread: `adam#t-h${n}`, status: 'running', created: '', last: '', transcript: '/x', runs: 0, tokens_in: 0, tokens_out: 0, critical } as any
  return { runId: `${id}.r1`, lane: id, evId: `ev-h${n}`, closers: [], critical, trigger: cls, cls, escalated: false, pushed: false }
}

test('lane tools: ask_joey and handoff_main replace escalate; a lane cannot write an escalation into the ledger by hand', () => {
  const names = LANE_TOOLS.map(t => t.name)
  expect(names).toContain('ask_joey')
  expect(names).toContain('handoff_main')
  expect(names).not.toContain('escalate')
  const lw = LANE_TOOLS.find(t => t.name === 'ledger_write')!
  expect((lw.inputSchema as any).properties.kind.enum).toEqual(['action', 'commitment', 'memory_proposal', 'receipt'])
})

test('identity card: three ways out, one per event; a critical alert must reach Joey and is not a reason to hand off', () => {
  const lane = { id: 'adam.reflex.5', kind: 'reflex', n: 5, session_id: 's', thread: 'adam#t-04f200', status: 'new', created: '', last: '', transcript: '', runs: 0, tokens_in: 0, tokens_out: 0 } as any
  const card = identityCard(lane, { summary: undefined } as any)
  for (const w of ['notify_joey(text, outcome)', 'ask_joey(text)', 'handoff_main(text)', '同一件事只選一個']) expect(card).toContain(w)
  expect(card).not.toContain('escalate')
  // 002k (B19): the card is the same for every lane of a kind; the critical flag is in the lane context at the head of the event prompt
  expect(card).toContain('不要為了「嚴重」而 handoff_main')
  expect(identityCard({ ...lane, critical: true })).toBe(card)
  const crit = laneContext({ ...lane, critical: true }, { summary: undefined, ev: {} } as any)
  expect(crit).toContain('分流器標記：嚴重警報')
  expect(laneContext(lane, { summary: undefined, ev: {} } as any)).not.toContain('分流器標記：嚴重警報')
})

// ------------------------------------------------------------------ a day of ledger entries (filtered queries)
const T0 = Date.parse('2026-11-13T02:00:00Z')
const rec = (i: number, o: Partial<LedgerRec>): string =>
  JSON.stringify({ ts: new Date(T0 + i * 60_000).toISOString(), lane: 'adam.reflex.1', thread: 'adam#t-a1', event: `ev-${i}`, kind: 'action', text: '', notify_main: false, refs: null, detail: null, ...o })
const DAY = [
  // a routine scheduler run a lane finished on its own: silent notice + closing report
  rec(0, { kind: 'notify', notify_main: true, text: '[silent] 昨天新進工單 31 張', refs: { tier: 'silent', escalated: false } }),
  rec(1, { kind: 'receipt', notify_main: true, text: 'run 12: done', refs: { report: { happened: '每日工單摘要 run:12', did: '數了昨天的工單：31 張，已回報 Joey', promised: '無', needs_main: '無' } } }),
  // a peer question answered by a lane without telling Joey
  rec(10, { lane: 'adam.reflex.2', thread: 'adam#t-a2', kind: 'action', text: 'reply_agent → eve（hop 2）：維護時段是每週三 02:00–03:00（UTC+8）' }),
  rec(11, { lane: 'adam.reflex.2', thread: 'adam#t-a2', kind: 'receipt', notify_main: true, text: 'run -: done', refs: { report: { happened: 'Eve 問 mock-api 下週維護時段', did: '回她：每週三 02:00–03:00（UTC+8）', promised: '無', needs_main: '無' } } }),
  // two no_reply notices recorded by the router: no thread, two different events
  rec(20, { lane: 'router', thread: null, event: 'ev-n1', kind: 'fyi', text: 'eve：週五的貼文我排好了（P-201，週五 09:00 發布）' }),
  rec(21, { lane: 'router', thread: null, event: 'ev-n2', kind: 'fyi', text: 'eve：下週一我請假' }),
  // a critical alert the lane asked Joey about
  rec(30, { lane: 'adam.reflex.3', thread: 'adam#t-a3', kind: 'notify', notify_main: true, text: '[push] 備份連續 2 次 upload 403，請決定由誰修 bucket policy', refs: { tier: 'push', escalated: true, ask: true } }),
  // a request the lane handed to the main
  rec(40, { lane: 'adam.reflex.4', thread: 'adam#t-a4', kind: 'escalation', notify_main: true, text: 'Eve 要 10 月可用率，明天 10:00 前；需要主線決定要不要答應', refs: { handoff: 'ho-1' } }),
]

test('a filtered ledger_query always ends by saying what else exists and how to get the whole day', () => {
  const out = queryLedger(DAY.join('\n'), { kind: 'escalation' }, T0 + 600 * 60_000)
  const last = out.split('\n').pop()!
  expect(out).toContain('符合 1 筆')
  expect(last).toContain('fyi 2')
  expect(last).toContain('ledger_query() 不帶參數')
})

// ------------------------------------------------------------------ 002e
test('002e: what a follow-up run reports never rings again (all-clear = silent); if Joey must decide, ask_joey still rings', async () => {
  reset()
  const tok = { ...run('alert-critical', true), followup: true }
  await callLaneTool(tok, 'notify_joey', { outcome: 'normal', text: 'A-1103 已恢復：14:50 備份成功' })
  expect(sent.length).toBe(1)
  expect(sent[0].silent).toBe(true)
  const row = ledgerRows()[0]
  expect(row.refs.tier).toBe('silent')
  expect(row.refs.tier_rule).toContain('followup-quiet')
  const tok2 = { ...run('alert-critical', true), followup: true }
  await callLaneTool(tok2, 'ask_joey', { text: '後續檢查：備份仍然失敗，要你決定是否改用備援 bucket' })
  expect(sent[1].silent).toBe(false)
  const first = run('alert-critical', true)                                             // the first run of the alert itself still rings
  await callLaneTool(first, 'notify_joey', { outcome: 'normal', text: 'P1：備份 upload 403' })
  expect(sent[2].silent).toBe(false)
})

test('002e: the header Joey reads names the lane and carries no internal thread id', async () => {
  reset()
  await callLaneTool(run('scheduled'), 'notify_joey', { outcome: 'normal', text: '例行回報' })
  expect(sent[0].text.split('\n')[0]).toMatch(/^〔adam·反射線#\d+〕$/)
  expect(sent[0].text).not.toContain('adam#t-')
})

// ------------------------------------------------------------------ 002f
test('002f: every time the main is shown is local (UTC+8) and the list says so; a time given back without a zone is read as local', () => {
  expect(stamp('2026-11-13T04:50:12.000Z')).toBe('11-13 12:50')          // the 12:50 failure is shown as 12:50, not 04:50
  expect(stamp('2026-11-12T18:05:00Z')).toBe('11-13 02:05')              // the date follows the local day
  const out = queryLedger(DAY.join('\n'), { kind: 'notify' }, T0 + 600 * 60_000).split('\n')
  expect(out[1].startsWith('11-13 10:00｜')).toBe(true)                   // T0 = 02:00Z = 10:00 local
  expect(queryLedger(DAY.join('\n'), { kind: 'notify' }, T0 + 600 * 60_000).split('\n')[0]).toContain('時間為 UTC+8')
  expect(parseSince('2026-11-13 12:00', 0)).toBe(Date.parse('2026-11-13T04:00:00Z'))
  expect(parseSince('2026-11-13T12:00:00+08:00', 0)).toBe(Date.parse('2026-11-13T04:00:00Z'))
  expect(parseSince('2026-11-13T04:00:00Z', 0)).toBe(Date.parse('2026-11-13T04:00:00Z'))
  expect(parseSince('2026-11-13', 0)).toBe(Date.parse('2026-11-12T16:00:00Z'))
  expect(parseSince('昨天', 0)).toBe('bad')
})

test('002f: a stopped thread stays stopped: the stop wakes the main once, later messages on it are recorded and wake nobody', async () => {
  reset()
  const st = __lanesState()
  st.lanes['adam.reflex.90'] = { id: 'adam.reflex.90', kind: 'reflex', n: 90, session_id: 's', thread: 'adam#t-loop', status: 'idle', created: '', last: '', transcript: '/x', runs: 1, tokens_in: 0, tokens_out: 0 } as any
  st.threads['adam#t-loop'] = { id: 'adam#t-loop', lane: 'adam.reflex.90', peer: 'eve', hops: 6, tokens: 0, created: '', last: '' } as any
  const msg = (hop: number, text: string) => ({ id: `mesh-loop-${hop}`, source: 'mesh', from: 'eve', text, meta: {}, thread: 'adam#t-loop', hop, verified: true,
    notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } }) as any
  const d1 = await routeEvent(msg(7, '那再確認一次？'))                    // over the hop limit: the thread is cut
  expect(d1.target).toBe('ledger')
  expect(st.threads['adam#t-loop'].stopped).toBeTruthy()
  let rows = ledgerRows()
  expect(rows.filter(r => r.kind === 'stop').length).toBe(1)
  expect(__events().get('mesh-loop-7')!.stop).toMatchObject({ why: 'hop', thread: 'adam#t-loop' })   // PL1: the stop is on the event's M3 record, once
  expect(rows.find(r => r.kind === 'stop').text).toContain('不要帶 reply_to')
  const handed = () => __main().items(r => r.kind === 'handoff' && String(r.event) === 'mesh-loop-7')
  expect(handed().length).toBe(1)                                         // M1: the stop is one item for the main
  const d2 = await routeEvent(msg(8, '還在嗎？'))                          // the peer keeps talking on the cut thread
  const d3 = await routeEvent(msg(9, '哈囉？'))
  expect(d2.target).toBe('ledger'); expect(d3.target).toBe('ledger')
  expect(d2.note).toContain('already stopped')
  rows = ledgerRows()
  expect(rows.filter(r => r.kind === 'stop').length).toBe(1)              // no second stop
  expect(rows.filter(r => r.kind === 'fyi' && r.thread === 'adam#t-loop').length).toBe(2)   // both are on the record
  expect(rows.slice(-2).some(r => r.kind === 'stop')).toBe(false)         // and neither is a stop
  expect(__main().items(r => r.kind === 'handoff' && /mesh-loop-[89]/.test(String(r.event))).length).toBe(0)   // nothing to wake it for
  expect(handed().length).toBe(1)
  const ride = __digest()!                                                // they ride along with whatever reaches the main next
  expect(ride.text).toContain('已關閉的對話線又收到 eve 的訊息')
  expect(Object.values(st.lanes).filter((l: any) => l.thread === 'adam#t-loop' && l.status === 'running').length).toBe(0)   // no lane was started
})
