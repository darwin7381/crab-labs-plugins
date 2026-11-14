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
import { spawnSync } from 'child_process'
import { lanesInit, callLaneTool, takePendingDigest, ackDigest, handoffTick, identityCard, routeEvent, LANE_TOOLS, __lanesState, __setMainConnected,
  mainConnected, cutOffTurn, resumeNotice, intake, mainTranscript, __setMainPid, __setHandoffDownGrace } from './lanes.ts'
import { isWakeEntry, queryLedger, stamp, parseSince, NOT_TOLD, type LedgerRec } from './lanes-digest.ts'

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

// ------------------------------------------------------------------ 002f
test('002f: every time the main is shown is local (UTC+8) and the list says so; a time given back without a zone is read as local', () => {
  expect(stamp('2026-11-13T04:50:12.000Z')).toBe('11-13 12:50')          // the 12:50 failure is shown as 12:50, not 04:50
  expect(stamp('2026-11-12T18:05:00Z')).toBe('11-13 02:05')              // the date follows the local day
  const out = queryLedger(DAY.join('\n'), {}, T0 + 600 * 60_000).split('\n')
  expect(out[0]).toContain('時間為 UTC+8')
  expect(out[1].startsWith('• 11-13 10:00｜')).toBe(true)                 // T0 = 02:00Z = 10:00 local
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
  expect(rows.filter(isWakeEntry).length).toBe(1)                         // the main is woken with the stop, once
  expect(rows.find(r => r.kind === 'stop').text).toContain('不要帶 reply_to')
  const wake = takePendingDigest(true, 'wake')!
  ackDigest(wake.id)
  const d2 = await routeEvent(msg(8, '還在嗎？'))                          // the peer keeps talking on the cut thread
  const d3 = await routeEvent(msg(9, '哈囉？'))
  expect(d2.target).toBe('ledger'); expect(d3.target).toBe('ledger')
  expect(d2.note).toContain('already stopped')
  rows = ledgerRows()
  expect(rows.filter(r => r.kind === 'stop').length).toBe(1)              // no second stop
  expect(rows.filter(r => r.kind === 'fyi' && r.thread === 'adam#t-loop').length).toBe(2)   // both are on the record
  expect(rows.slice(-2).some(isWakeEntry)).toBe(false)                    // and neither wakes the main
  expect(takePendingDigest(true, 'wake')).toBeNull()                      // nothing to wake it for
  const ride = takePendingDigest(false, 'piggyback')!                     // they ride along with its next natural message
  expect(ride.text).toContain('已關閉的對話線又收到 eve 的訊息')
  expect(Object.values(st.lanes).filter((l: any) => l.thread === 'adam#t-loop' && l.status === 'running').length).toBe(0)   // no lane was started
})

// ------------------------------------------------------------------ 002g: is the main there, and what happens when it is not
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

test('002g: a main whose process is gone is not "connected", whatever its MCP session says', () => {
  reset()
  expect(mainConnected()).toBe(true)
  __setMainPid(spawnSync('true').pid!)                          // a pid that has just exited
  expect(mainConnected()).toBe(false)
  __setMainPid(1); __setMainConnected('mcp-main')
  expect(mainConnected()).toBe(true)
})

test('002g: a main that just went away gets a grace period; when it is not back in time Joey is told, once', async () => {
  reset()
  __setHandoffDownGrace(120)
  __setMainConnected(null, 0)                                   // its process died this instant
  const out = await callLaneTool(run('peer'), 'handoff_main', { text: '主線剛離線時交過來的事' })
  expect(out).not.toContain('Joey was told directly')
  await sleep(20)
  expect(sent.length).toBe(0)                                   // a restart takes seconds: not a reason to ring Joey
  handoffTick(); await sleep(20)
  expect(sent.length).toBe(0)
  await sleep(140)
  handoffTick(); await sleep(20)
  expect(sent.length).toBe(1)
  expect(sent[0].text).toContain('不在線')
  expect(sent[0].text).toContain('主線剛離線時交過來的事')
  handoffTick(); await sleep(20)
  expect(sent.length).toBe(1)
  __setHandoffDownGrace(60_000)
})

test('002g: a main that is back inside the grace period gets the handoff; Joey is not told', async () => {
  reset()
  __setHandoffDownGrace(150)
  __setMainConnected(null, 0)
  await callLaneTool(run('peer'), 'handoff_main', { text: '主線重啟中交過來的事' })
  __setMainConnected('mcp-main')                                // back after a restart
  await sleep(200)
  handoffTick(); await sleep(20)
  expect(sent.length).toBe(0)
  expect(Object.values(__lanesState().handoffs)[0].state).toBe('pending')   // it waits for the main's next digest, like any handoff
  expect(takePendingDigest(true, 'wake')).not.toBeNull()
  __setHandoffDownGrace(60_000)
})

test('002g: was the last turn cut off? read from the end of the transcript', () => {
  const p = join(dir, 'cut.jsonl')
  const rec = (o: object) => JSON.stringify(o) + '\n'
  const A = (stop: string, kinds: string[], model = 'claude-haiku-5-5') =>
    rec({ type: 'assistant', timestamp: '2026-11-13T02:02:52.000Z', message: { model, stop_reason: stop, content: kinds.map(k => ({ type: k })) } })
  const resumed = A('stop_sequence', ['text'], '<synthetic>')    // "No response requested." written by the new process
  // killed while a tool call was out: its result, a Telegram message waiting in the queue, then the new process
  writeFileSync(p, A('tool_use', ['tool_use']) + rec({ type: 'user', timestamp: '2026-11-13T02:02:52.500Z', message: { content: [{ type: 'tool_result' }] } })
    + rec({ type: 'queue-operation', operation: 'enqueue', content: '<channel source="plugin:telegram-http:telegram-http">' }) + resumed)
  expect(cutOffTurn(p)).toEqual({ cut: true, at: '2026-11-13T02:02:52.500Z' })
  // killed while idle, after a turn that ended by itself
  writeFileSync(p, A('end_turn', ['text']) + rec({ type: 'system', subtype: 'stop_hook_summary' }) + rec({ type: 'system', subtype: 'turn_duration' }) + resumed)
  expect(cutOffTurn(p).cut).toBe(false)
  writeFileSync(p, A('end_turn', ['text']) + resumed)
  expect(cutOffTurn(p).cut).toBe(false)
  writeFileSync(p, A('tool_use', ['thinking']) + A('tool_use', ['tool_use']) + resumed)
  expect(cutOffTurn(p).cut).toBe(true)
  writeFileSync(p, rec({ type: 'user', timestamp: 't', message: { content: 'a prompt nobody answered' } }) + resumed)
  expect(cutOffTurn(p)).toEqual({ cut: true, at: 't' })
  expect(cutOffTurn(join(dir, 'nope.jsonl')).cut).toBe(false)
  const n = resumeNotice('2026-11-13T02:03:02.000Z')
  expect(n).toContain('11-13 10:03'); expect(n).toContain('UTC+8'); expect(n).toContain('接著把它做完')
})

// ------------------------------------------------------------------ 002h/002i: what became of a delivery to the main
test('002i: the transcript says what became of a delivery: taken in, waiting in the client, or never arrived', () => {
  const p = mainTranscript()!
  const rec = (o: object) => JSON.stringify(o) + '\n'
  const tg = (id: number, text: string) => `<channel source="plugin:telegram-http:telegram-http" chat_id="990000001" message_id="${id}" user="joey_lab" ts="2026-11-13T02:03:02.000Z">\n${text}\n</channel>`
  const n = (meta: Record<string, string>) => ({ method: 'notifications/claude/channel', params: { content: 'x', meta } }) as any
  const T0 = Date.parse('2026-11-13T02:00:00.000Z'), at = (s: number) => new Date(T0 + s * 1000).toISOString()
  writeFileSync(p,
    rec({ type: 'queue-operation', operation: 'enqueue', timestamp: at(1), content: tg(1003, '開發工作') }) + rec({ type: 'queue-operation', operation: 'dequeue', timestamp: at(1) })
    + rec({ type: 'user', timestamp: at(1), message: { content: tg(1003, '開發工作') } })                                                    // became a prompt
    + rec({ type: 'queue-operation', operation: 'enqueue', timestamp: at(60), content: tg(1006, '還收得到嗎') })
    + rec({ type: 'queue-operation', operation: 'remove', timestamp: at(63), content: tg(1006, '還收得到嗎'), reason: 'absorbed_mid_turn' })   // arrived mid-turn, absorbed
    + rec({ type: 'assistant', timestamp: at(64), message: { model: 'claude-haiku-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use' }] } })
    + rec({ type: 'queue-operation', operation: 'enqueue', timestamp: at(90), content: tg(1008, '查 health') })                               // queued; then the process was killed
    + rec({ type: 'assistant', timestamp: at(92), message: { model: 'claude-haiku-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use' }] } })
    + rec({ type: 'queue-operation', operation: 'enqueue', timestamp: at(93), content: '<channel source="plugin:agent-inbox:agent-inbox" user="eve" btcc_msg_id="50031">hi</channel>' }))
  expect(intake(n({ message_id: '1003' }), T0)).toMatchObject({ taken: true, queued: false })
  expect(intake(n({ message_id: '1006' }), T0 + 60_000)).toMatchObject({ taken: true, queued: false })
  expect(intake(n({ message_id: '1008' }), T0 + 90_000)).toMatchObject({ taken: false, queued: true })     // in the client's queue, not read
  expect(intake(n({ btcc_msg_id: '50031' }), T0 + 93_000)).toMatchObject({ taken: false, queued: true })   // the same for a mesh message
  // the same message given again to a NEW process at +100 s: the old enqueue is not evidence for this delivery
  expect(intake(n({ message_id: '1008' }), T0 + 100_000)).toMatchObject({ taken: false, queued: false })   // no trace: it never arrived
  writeFileSync(p, readFileSync(p, 'utf8') + rec({ type: 'queue-operation', operation: 'enqueue', timestamp: at(125), content: tg(1008, '查 health') })
    + rec({ type: 'queue-operation', operation: 'dequeue', timestamp: at(125) }) + rec({ type: 'user', timestamp: at(125), message: { content: tg(1008, '查 health') } }))
  expect(intake(n({ message_id: '1008' }), T0 + 124_000)).toMatchObject({ taken: true, queued: false })    // the second copy was read
  expect(intake(n({ message_id: '999' }), T0)).toMatchObject({ taken: false, queued: false })
  expect(intake(n({}), T0)).toBeNull()                                                               // nothing to recognise it by
  writeFileSync(p, '')
})
