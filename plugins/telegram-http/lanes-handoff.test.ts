// Universe 002d: one owner per event.
//   ask_joey      the lane needs JOEY: it tells him itself, once (push); the main is not woken, it reads it in its digest
//   handoff_main  the lane needs the MAIN: the main is woken and reports; Joey hears nothing from the lane or the router
//   fallback      a handoff the main does not get (not connected / not delivered in time) is told to Joey, once
// and the activity list: ledger_query() with no filter = one line per handled event.
// No network, no daemon, no lane process.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { lanesInit, callLaneTool, takePendingDigest, ackDigest, handoffTick, identityCard, LANE_TOOLS, __lanesState, __setMainConnected } from './lanes.ts'
import { isWakeEntry, queryLedger, NOT_TOLD, type LedgerRec } from './lanes-digest.ts'

const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-handoff-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'),
  claude_pid: 1, registered_at: new Date().toISOString() }))
const sent: Array<{ text: string; silent: boolean }> = []
let nextId = 1000
lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'],
  sendBot: async (_chat: string, text: string, opts: { silent?: boolean }) => { sent.push({ text, silent: !!opts.silent }); return nextId++ },
  joeyChatId: () => '1' } as any)

const ledgerRows = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
function reset(mainConnected = true): void {
  writeFileSync(join(dir, 'ledger.jsonl'), '')
  rmSync(join(dir, 'digest.json'), { force: true })
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
  for (const w of ['notify_joey(text)', 'ask_joey(text)', 'handoff_main(text)', '同一件事只選一個']) expect(card).toContain(w)
  expect(card).not.toContain('escalate')
  const crit = identityCard({ ...lane, critical: true }, { summary: undefined } as any)
  expect(crit).toContain('這是嚴重警報')
  expect(crit).toContain('不要為了「嚴重」而 handoff_main')
})

test('ask_joey: ONE push to Joey even for a routine class, the main is not woken, a second ask or a handoff of the same event is refused', async () => {
  reset()
  const tok = run('scheduled')
  const out = await callLaneTool(tok, 'ask_joey', { text: '備份連續失敗兩次（403），要你決定：請平台組修 bucket policy。' })
  expect(out).toContain('sent to Joey')
  expect(sent.length).toBe(1)
  expect(sent[0].silent).toBe(false)                                                  // escalated column: push
  expect(sent[0].text).toContain('要你決定')
  const rows = ledgerRows()
  expect(rows.length).toBe(1)
  expect(rows[0]).toMatchObject({ kind: 'notify', notify_main: true, refs: { ask: true, escalated: true, tier: 'push' } })
  expect(isWakeEntry(rows[0] as LedgerRec)).toBe(false)
  expect(takePendingDigest(true, 'wake')).toBeNull()                                  // nothing wakes the main
  expect(await callLaneTool(tok, 'ask_joey', { text: '再問一次' })).toContain('refused')
  expect(await callLaneTool(tok, 'handoff_main', { text: '也交給主線' })).toContain('refused')
  expect(sent.length).toBe(1)
  expect(Object.keys(__lanesState().handoffs).length).toBe(0)
  const dg = takePendingDigest(false, 'piggyback')!                                   // the main reads it with its next natural turn
  expect(dg.text).toContain('已請 Joey 決定（已響鈴），不要重複通知他')
  expect(dg.wake).toBe(false)
})

test('notify_joey: the tier is the plain column of the event class (routine = silent, critical alert = push); neither wakes the main', async () => {
  reset()
  await callLaneTool(run('scheduled'), 'notify_joey', { text: '例行：mock-api 已重啟並恢復' })
  await callLaneTool(run('alert-critical', true), 'notify_joey', { text: 'P1：備份 upload 403，權限問題' })
  expect(sent.map(s => s.silent)).toEqual([true, false])
  expect(ledgerRows().some(r => isWakeEntry(r as LedgerRec))).toBe(false)
  expect(takePendingDigest(true, 'wake')).toBeNull()
})

test('handoff_main: Joey hears nothing from the lane; the main is woken with it and told it is the owner; delivered once the main has the digest', async () => {
  reset()
  const tok = run('peer')
  const out = await callLaneTool(tok, 'handoff_main', { text: 'Eve（mesh-50008）要 10 月可用率，明天 10:00 前；我不能代表 adam 答應。' })
  expect(out).toContain('handed to the main')
  expect(sent.length).toBe(0)
  const rows = ledgerRows()
  expect(rows[0]).toMatchObject({ kind: 'escalation', notify_main: true })
  expect(isWakeEntry(rows[0] as LedgerRec)).toBe(true)
  const h = Object.values(__lanesState().handoffs)[0]
  expect(h.state).toBe('pending')
  expect(rows[0].refs.handoff).toBe(h.id)
  expect(await callLaneTool(tok, 'ask_joey', { text: '也問 Joey' })).toContain('refused')     // one owner per event
  const dg = takePendingDigest(true, 'wake')!
  expect(dg.wake).toBe(true)
  expect(dg.text).toContain('10 月可用率')
  expect(dg.text).toContain('這件事交給你了：車道沒有通知過 Joey，處理完由你回報他一次')
  await ackDigest({ digest: dg })
  expect(Object.values(__lanesState().handoffs)[0].state).toBe('delivered')
  __lanesState().handoffs[h.id].created -= 3_600_000                                   // long after: a delivered handoff never falls back
  handoffTick()
  expect(sent.length).toBe(0)
})

test('handoff fallback: the main is not connected → Joey is told directly at once, exactly once', async () => {
  reset(false)
  const out = await callLaneTool(run('peer'), 'handoff_main', { text: '需要主線決定要不要答應 Eve。' })
  expect(out).toContain('Joey was told directly')
  await new Promise(r => setTimeout(r, 20))
  expect(sent.length).toBe(1)
  expect(sent[0].silent).toBe(false)
  expect(sent[0].text).toContain('需要主線決定要不要答應 Eve')
  expect(Object.values(__lanesState().handoffs)[0].state).toBe('fallback')
  handoffTick()
  await new Promise(r => setTimeout(r, 20))
  expect(sent.length).toBe(1)
})

test('handoff fallback: connected but not delivered in time → Joey is told once; a handoff still inside the window is left alone', async () => {
  reset()
  await callLaneTool(run('peer'), 'handoff_main', { text: '第一件：等很久了' })
  await callLaneTool(run('peer'), 'handoff_main', { text: '第二件：剛交' })
  const hs = Object.values(__lanesState().handoffs)
  hs[0].created -= 6 * 60_000
  handoffTick()
  await new Promise(r => setTimeout(r, 20))
  expect(sent.length).toBe(1)
  expect(sent[0].text).toContain('第一件')
  expect(hs[0].state).toBe('fallback')
  expect(hs[1].state).toBe('pending')
  handoffTick()
  await new Promise(r => setTimeout(r, 20))
  expect(sent.length).toBe(1)
})

// ------------------------------------------------------------------ the activity list
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

test('activity list: ledger_query() with no filter = one line per handled event, every one of them, with who was told', () => {
  const out = queryLedger(DAY.join('\n'), {}, T0 + 600 * 60_000)
  const lines = out.split('\n')
  expect(lines[0]).toContain('活動清單：6 件事')
  const body = lines.slice(1, -1)
  expect(body.length).toBe(6)
  expect(body[0]).toContain('31 張')
  expect(body[0]).toContain('已通知 Joey（靜默）')
  expect(body[1]).toContain('每週三 02:00–03:00')
  expect(body[1]).toContain(NOT_TOLD)                                                  // answered a peer, Joey was not messaged
  expect(body[2]).toContain('P-201')                                                   // the two router notices do not hide each other
  expect(body[3]).toContain('下週一我請假')
  expect(body[4]).toContain('已請 Joey 決定（已響鈴）')
  expect(body[5]).toContain('交給主線：Eve 要 10 月可用率')
  expect(lines[lines.length - 1]).toContain('帳本各種類現有筆數')
  expect(queryLedger(DAY.join('\n'), { since: new Date(T0 + 25 * 60_000).toISOString() }, T0 + 600 * 60_000).split('\n')[0]).toContain('活動清單：2 件事')
})

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
  await callLaneTool(tok, 'notify_joey', { text: 'A-1103 已恢復：14:50 備份成功' })
  expect(sent.length).toBe(1)
  expect(sent[0].silent).toBe(true)
  const row = ledgerRows()[0]
  expect(row.refs.tier).toBe('silent')
  expect(row.refs.tier_rule).toContain('followup-quiet')
  const tok2 = { ...run('alert-critical', true), followup: true }
  await callLaneTool(tok2, 'ask_joey', { text: '後續檢查：備份仍然失敗，要你決定是否改用備援 bucket' })
  expect(sent[1].silent).toBe(false)
  const first = run('alert-critical', true)                                             // the first run of the alert itself still rings
  await callLaneTool(first, 'notify_joey', { text: 'P1：備份 upload 403' })
  expect(sent[2].silent).toBe(false)
})

test('002e: the header Joey reads names the lane and carries no internal thread id', async () => {
  reset()
  await callLaneTool(run('scheduled'), 'notify_joey', { text: '例行回報' })
  expect(sent[0].text.split('\n')[0]).toMatch(/^〔adam·反射線#\d+〕$/)
  expect(sent[0].text).not.toContain('adam#t-')
})

test('002e: a wake digest puts the handed-over work first and marks the rest as "Joey already knows, do not retell"', async () => {
  reset()
  await callLaneTool(run('scheduled'), 'ask_joey', { text: '備份連續失敗，要你決定' })
  await callLaneTool(run('peer'), 'handoff_main', { text: 'Eve 要 10 月可用率，請主線決定並回她' })
  const dg = takePendingDigest(true, 'wake')!
  const lines = dg.text.split('\n')
  const iHand = lines.findIndex(l => l.includes('這件事交給你了'))
  const iSep = lines.findIndex(l => l.includes('以下只是讓你知道'))
  const iAsk = lines.findIndex(l => l.includes('已請 Joey 決定'))
  expect(iHand).toBeGreaterThan(0)
  expect(iSep).toBeGreaterThan(iHand)
  expect(iAsk).toBeGreaterThan(iSep)
})

test('002e: what the main itself told another agent is a line of the activity list (next to the handoff it answers, or on its own)', () => {
  const day = [
    rec(40, { lane: 'adam.reflex.4', thread: 'adam#t-a4', kind: 'escalation', notify_main: true, text: 'Eve 要 10 月可用率；需要主線決定', refs: { handoff: 'ho-1' } }),
    rec(41, { lane: 'main', thread: 'adam#t-a4', event: 'main-send-50010', kind: 'action', text: 'send_to_agent → eve：整月數字給不出來，只有 10-22 之後的取樣 99.13%' }),
    rec(50, { lane: 'main', thread: null, event: 'main-send-50011', kind: 'action', text: 'send_to_agent → cain：請不要再發測試訊息' }),
  ]
  const lines = queryLedger(day.join('\n'), {}, T0 + 600 * 60_000).split('\n')
  expect(lines[0]).toContain('活動清單：2 件事')
  expect(lines[1]).toContain('交給主線：Eve 要 10 月可用率')
  expect(lines[1]).toContain('主線做了：send_to_agent → eve：整月數字給不出來')
  expect(lines[2]).toContain('send_to_agent → cain')
})
