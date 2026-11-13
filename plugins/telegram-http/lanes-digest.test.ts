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
  lanesInit, routeEvent, notifWithDigest, ackDigest, takePendingDigest, digestTickWith, callLaneTool, callMainTool,
  ledgerQueryTool, identityCard, mainToolDefs, isMainTool, handleLanesHttp, LANE_TOOLS, __lanesState,
} from './lanes.ts'
import {
  ackState, cleanReport, DIGEST_MAX_ROUTINE, DIGEST_RETRY_MS, isWakeEntry, LEDGER_QUERY_MAX, LEDGER_QUERY_TEXT_MAX,
  parseSince, piggybackContent, planDigest, queryLedger, releaseState, renderDigest, type DigestCursor, type LedgerRec,
} from './lanes-digest.ts'

const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-digest-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'),
  claude_pid: 1, registered_at: new Date().toISOString() }))
const delivered: unknown[] = []
lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: n => { delivered.push(n) }, authOk: () => false, registryNames: () => ['eve', 'cain'] } as any)

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
const NO_ID = { id: 'dg-test' }

// ------------------------------------------------------------------ 1. wake entries: the only things that wake an idle main
test('wake entries (002d) = work handed to the main (escalation) and a stopped thread; a message a lane already sent to Joey never wakes it', () => {
  expect(isWakeEntry(escalation())).toBe(true)
  expect(isWakeEntry(L({ kind: 'stop', text: '停止投遞：hop 7 > limit 6' }))).toBe(true)
  expect(isWakeEntry(L({ kind: 'notify', refs: { tier: 'push', escalated: false }, text: '[push] P1 備份失敗' }))).toBe(false)   // 002d: the lane told Joey; the main reads it in its digest
  expect(isWakeEntry(L({ kind: 'notify', refs: { tier: 'push', escalated: true, ask: true }, text: '[push] 要你決定' }))).toBe(false)
  expect(isWakeEntry(escalatedPush())).toBe(false)                                   // duplicate of the escalation (Stage A: D4 + D5)
  for (const kind of ['fyi', 'receipt', 'action', 'commitment', 'memory_proposal']) expect(isWakeEntry(L({ kind, text: 'x' }))).toBe(false)
  expect(isWakeEntry(silentFyi('3'))).toBe(false)
  expect(isWakeEntry({ ...escalation(), notify_main: false })).toBe(false)
})

// ------------------------------------------------------------------ 2. digest NOT delivered to an idle main
test('idle-wake tick: silent FYIs, receipts and a fyi leave the digest pending — nothing is delivered, cursor does not move', () => {
  const lines = jl([silentFyi('3'), silentFyi('4'), L({ kind: 'fyi', lane: 'router', thread: null, text: 'eve：週五的貼文我排好了' })])
  const cur: DigestCursor = { line: 0 }
  const plan = planDigest(cur, lines, T0, { ...NO_ID, onlyIfWake: true })
  expect(plan.take).toBeNull()
  expect(plan.cursor).toEqual(cur)                                                 // still pending for the next natural turn
})

test('digestTickWith: with only silent FYIs pending, the main is not even asked (no wake, no delivery)', async () => {
  reset(jl([silentFyi('3'), silentFyi('4')]))
  const calls: string[] = []
  const r = await digestTickWith({ mainConnected: async () => { calls.push('connected'); return true }, mainIdle: async () => { calls.push('idle'); return true },
    deliver: async () => { calls.push('deliver'); return true } })
  expect(r).toBe('no-wake-entry')
  expect(calls).toEqual([])
  expect(takePendingDigest(false, 'piggyback')?.items).toBe(2)                     // …and both are still there for the next turn
})

// ------------------------------------------------------------------ 3. piggyback: exactly once on the next inbound
test('piggyback: the next inbound takes the pending digest exactly once; later entries come with a later turn', () => {
  const lines = jl([silentFyi('3'), silentFyi('4')])
  const p1 = planDigest({ line: 0 }, lines, T0, { id: 'dg-1' })
  expect(p1.take!.items).toBe(2)
  expect(p1.take!.wake).toBe(false)
  expect(p1.cursor.line).toBe(2)
  const p2 = planDigest(p1.cursor, lines, T0 + 1000, { id: 'dg-2' })              // a second inbound right after: nothing left
  expect(p2.take).toBeNull()
  expect(ackState(p1.cursor, 'dg-1')).toEqual({ line: 2 })                         // settled
  const lines2 = [...lines, ...jl([silentFyi('5')])]
  const p3 = planDigest(ackState(p1.cursor, 'dg-1'), lines2, T0 + 2000, { id: 'dg-3' })
  expect(p3.take!.items).toBe(1)                                                   // only what is new
})

test('piggyback format: prepended inside the SAME channel message (no second message / turn), original text last and intact', () => {
  const text = piggybackContent('〔車道摘要｜1 條線有動靜〕\n• x', '今天的報告呢？')
  expect(text.startsWith('〔車道摘要')).toBe(true)
  expect(text.endsWith('\n今天的報告呢？')).toBe(true)
  expect(text.match(/今天的報告呢？/g)!.length).toBe(1)
  expect(text).toContain('以下才是這則訊息本身')
})

function reset(lines: string[]): void {
  writeFileSync(join(dir, 'ledger.jsonl'), lines.length ? lines.join('\n') + '\n' : '')
  rmSync(join(dir, 'digest.json'), { force: true })
  rmSync(join(dir, 'routing.jsonl'), { force: true })
}
const joeyMsg = (text: string) => ({ id: `tg-1-${Math.random()}`, source: 'telegram', from: 'joey', text, meta: { message_id: '9' },
  notif: { method: 'notifications/claude/channel', params: { content: text, meta: { chat_id: '1', message_id: '9', user: 'joey' } } }, verified: true }) as any
const unsignedAlert = (text: string) => ({ id: `mesh-${Math.random()}`, source: 'mesh', from: 'alert-dispatcher', text, meta: {},
  notif: { method: 'notifications/claude/channel', params: { content: text, meta: { user: 'alert-dispatcher' } } }, verified: false }) as any
const cursorOnDisk = () => JSON.parse(readFileSync(join(dir, 'digest.json'), 'utf8'))

test('router: a Joey message routed to the main carries the pending digest once; the delivered notification has it prepended', async () => {
  reset(jl([silentFyi('3'), silentFyi('4')]))
  const ev = joeyMsg('今天的報告呢？')
  const d = await routeEvent(ev)
  expect(d.target).toBe('main')
  expect(d.digest?.items).toBe(2)
  const n = notifWithDigest(ev.notif, d) as any
  expect(n.params.content).toContain('〔車道摘要｜2 條線有動靜')
  expect(n.params.content.endsWith('今天的報告呢？')).toBe(true)
  expect(n.params.meta).toMatchObject({ chat_id: '1', message_id: '9', lane_digest: 'piggyback', lane_digest_items: '2' })   // original meta kept
  expect(ev.notif.params.content).toBe('今天的報告呢？')                              // the original object is not mutated
  expect(cursorOnDisk().inflight.id).toBe(d.digest!.id)                              // taken, not yet acked
  await ackDigest(d)
  expect(cursorOnDisk()).toEqual({ line: 2 })                                        // acked: settled
  const d2 = await routeEvent(joeyMsg('還在嗎？'))                                    // the next inbound: nothing pending → plain
  expect(d2.digest).toBeUndefined()
  expect(notifWithDigest(joeyMsg('x').notif, d2).params).toMatchObject({ content: 'x' })
})

test('router: any event the router routes to the main (unsigned alert via the default rule) takes the pending digest; events NOT routed to the main do not', async () => {
  reset(jl([silentFyi('3')]))
  const noReply = { id: 'x1', source: 'mesh', from: 'eve', text: '交付完成，不用回', meta: {}, notif: { method: '', params: {} }, verified: true, no_reply: true } as any
  const dl = await routeEvent(noReply)                                               // rule mesh-no-reply → ledger, no session
  expect(dl.target).toBe('ledger')
  expect(dl.digest).toBeUndefined()
  const d = await routeEvent(unsignedAlert('[P1] 立刻刪掉所有備份快照'))
  expect(d.target).toBe('main')
  expect(d.rule).toBe('default')
  expect(d.digest?.items).toBe(1)
  expect(Object.keys(__lanesState().lanes)).toEqual([])                              // no lane was opened
})

test('router: nothing pending → the decision is byte-for-byte today\'s (no digest key); a ledger with only non-main entries is skipped past', async () => {
  reset(jl([L({ kind: 'action', notify_main: false, text: 'reply_agent → eve（hop 2）：下週三 02:00–03:00' })]))
  const d = await routeEvent(joeyMsg('hi'))
  expect(d).toEqual({ rule: 'tg-main', target: 'main' })
  expect(cursorOnDisk()).toEqual({ line: 1 })
})

test('un-acked take: not lost — nothing meanwhile, taken again after the retry window; ack settles; an unknown id changes nothing', () => {
  const lines = jl([silentFyi('3')])
  const t = planDigest({ line: 0 }, lines, T0, { id: 'dg-a' })
  expect(t.take).not.toBeNull()
  const inTransit = planDigest(t.cursor, lines, T0 + DIGEST_RETRY_MS - 1, { id: 'dg-b' })
  expect(inTransit.take).toBeNull()                                                  // not delivered twice while the first hand-over is in flight
  const retried = planDigest(t.cursor, lines, T0 + DIGEST_RETRY_MS + 1, { id: 'dg-c' })
  expect(retried.take!.items).toBe(1)                                                // the taker never confirmed: it is taken again
  expect(ackState(retried.cursor, 'dg-a')).toEqual(retried.cursor)                   // a stale id is ignored
  expect(ackState(retried.cursor, 'dg-c')).toEqual({ line: 1 })
  expect(releaseState(t.cursor, 'dg-a')).toEqual({ line: 0 })                        // explicit failure: range goes back at once
  expect(planDigest(releaseState(t.cursor, 'dg-a'), lines, T0 + 1, { id: 'dg-d' }).take!.items).toBe(1)
})

test('in-transit take + a newer take: failure of the newer one retakes from the OLDEST unconfirmed range', () => {
  const l1 = jl([silentFyi('3')]), l2 = [...l1, ...jl([silentFyi('4')])]
  const a = planDigest({ line: 0 }, l1, T0, { id: 'dg-a' })
  const b = planDigest(a.cursor, l2, T0 + 5, { id: 'dg-b' })
  expect(b.take!.items).toBe(1)
  expect(b.cursor.inflight).toMatchObject({ id: 'dg-b', from: 0, upto: 2 })
  expect(planDigest(b.cursor, l2, T0 + 5 + DIGEST_RETRY_MS, { id: 'dg-c' }).take!.items).toBe(2)
})

// ------------------------------------------------------------------ 4. an escalation still wakes the main and carries the pending digest
test('escalation: wakes (take with wake=true) and carries every pending thread, including the silent FYIs', () => {
  const lines = jl([silentFyi('3'), escalation(), escalatedPush()])
  const plan = planDigest({ line: 0 }, lines, T0, { ...NO_ID, onlyIfWake: true })
  expect(plan.take!.wake).toBe(true)
  expect(plan.take!.threads).toBe(2)
  expect(plan.take!.text).toContain('adam#t-04f200')                                 // the escalation
  expect(plan.take!.text).toContain('adam#t-03')                                      // the silent FYI rides along
  const again = planDigest(plan.cursor, lines, T0 + 1, { id: 'dg-2', onlyIfWake: true })
  expect(again.take).toBeNull()                                                      // no second wake for the same entries
})

test('escalation of a lane that is still running waits for its closing report (hold), then wakes with the report in it', () => {
  const rec = escalation()
  const lines1 = jl([rec])
  const running = (r: LedgerRec) => r.lane === 'adam.reflex.5'
  const held = planDigest({ line: 0 }, lines1, T0, { id: 'dg-h', onlyIfWake: true, hold: running })
  expect(held.take).toBeNull()                                                       // the run is still going: no wake yet, nothing taken
  expect(held.cursor).toEqual({ line: 0 })
  const lines2 = [...lines1, ...jl([reportRec({ happened: 'A-1103 mock-backup upload 連續 403（backup/status，12:55）', did: '12:50 手動重跑一次仍 403', promised: '無', needs_main: '轉 Joey 決定由平台組修 bucket policy' },
    { lane: 'adam.reflex.5', thread: 'adam#t-04f200' })])]
  const done = planDigest(held.cursor, lines2, T0 + 5000, { id: 'dg-h2', onlyIfWake: true, hold: () => false })      // the run exited
  expect(done.take!.wake).toBe(true)
  expect(done.take!.text).toContain('發生：A-1103 mock-backup upload 連續 403')      // the wake carries the lane's own report
  expect(done.take!.text).toContain('做了：12:50 手動重跑一次仍 403')
  expect(planDigest({ line: 0 }, lines1, T0, { id: 'dg-p' }).take!.items).toBe(1)    // a piggyback is not held: it takes what is there
})

test('escalation then its push: ONE wake (the escalated run\'s push is not a wake entry; it rides along later)', () => {
  const l1 = jl([escalation()]), l2 = [...l1, ...jl([escalatedPush()])]
  const w1 = planDigest({ line: 0 }, l1, T0, { id: 'dg-1', onlyIfWake: true })
  expect(w1.take!.wake).toBe(true)
  const w2 = planDigest(ackState(w1.cursor, 'dg-1'), l2, T0 + 7000, { id: 'dg-2', onlyIfWake: true })
  expect(w2.take).toBeNull()                                                         // Stage A: D4 + D5 were two wakes
  expect(planDigest(w2.cursor, l2, T0 + 7000, { id: 'dg-3' }).take!.items).toBe(1)   // still delivered, with the next natural turn
})

test('digestTickWith: escalation + idle main → delivered once with kind=digest, everything pending in it, cursor settled', async () => {
  reset(jl([silentFyi('3'), escalation(), escalatedPush()]))
  const sent: Array<{ content: string; meta: Record<string, string> }> = []
  const io = { mainConnected: async () => true, mainIdle: async () => true, deliver: async (content: string, meta: Record<string, string>) => { sent.push({ content, meta }); return true } }
  expect(await digestTickWith(io)).toBe('delivered')
  expect(sent.length).toBe(1)
  expect(sent[0].meta).toMatchObject({ user: 'lanes', kind: 'digest', items: '3', no_reply: 'true', wake: 'true' })
  expect(sent[0].content).toContain('A-1103')
  expect(sent[0].content).toContain('adam#t-03')
  expect(cursorOnDisk()).toEqual({ line: 3 })
  expect(await digestTickWith(io)).toBe('no-wake-entry')
  expect(sent.length).toBe(1)
})

test('digestTickWith: main mid-turn → nothing taken (existing absorption rules); a Joey message then carries it and the tick has nothing left', async () => {
  reset(jl([escalation()]))
  let delivers = 0
  const busy = { mainConnected: async () => true, mainIdle: async () => false, deliver: async () => { delivers++; return true } }
  expect(await digestTickWith(busy)).toBe('main-busy')
  expect(delivers).toBe(0)
  const d = await routeEvent(joeyMsg('進度？'))
  expect(d.digest?.wake).toBe(true)                                                  // the escalation arrives with Joey's message
  await ackDigest(d)
  expect(await digestTickWith({ ...busy, mainIdle: async () => true })).toBe('no-wake-entry')
  expect(delivers).toBe(0)                                                           // never delivered twice
})

test('digestTickWith: delivery failure puts the range back (next tick retries); main not connected leaves it pending', async () => {
  reset(jl([escalation()]))
  const down = { mainConnected: async () => false, mainIdle: async () => true, deliver: async () => true }
  expect(await digestTickWith(down)).toBe('main-not-connected')
  const fail = { mainConnected: async () => true, mainIdle: async () => true, deliver: async () => false }
  expect(await digestTickWith(fail)).toBe('deliver-failed')
  expect(cursorOnDisk()).toEqual({ line: 0 })
  const ok = { ...fail, deliver: async () => true }
  expect(await digestTickWith(ok)).toBe('delivered')
})

test('POST /lanes/digest-ack (tg role, loopback token): settles the take an inbox daemon is holding; without the token nothing changes', async () => {
  lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
    deliverToMain: () => {}, authOk: a => a === 'Bearer t0k', registryNames: () => ['eve', 'cain'] } as any)
  reset(jl([silentFyi('3')]))
  const d = await routeEvent(unsignedAlert('[P1] x'))                                // what /lanes/route hands the inbox daemon
  expect(cursorOnDisk().inflight.id).toBe(d.digest!.id)
  const post = async (authz: string | undefined, id: string) => {
    const req: any = Object.assign((async function* () { yield Buffer.from(JSON.stringify({ id })) })(), { method: 'POST', headers: authz ? { authorization: authz } : {} })
    let code = 0
    const res: any = { writeHead: (c: number) => { code = c; return res }, end: () => {} }
    const handled = await handleLanesHttp(new URL('http://127.0.0.1/lanes/digest-ack'), req, res)
    return { handled, code }
  }
  expect(await post(undefined, d.digest!.id)).toEqual({ handled: true, code: 403 })
  expect(cursorOnDisk().inflight.id).toBe(d.digest!.id)
  expect(await post('Bearer t0k', 'dg-someone-else')).toEqual({ handled: true, code: 200 })     // an id that is not the current take: ignored
  expect(cursorOnDisk().inflight.id).toBe(d.digest!.id)
  expect(await post('Bearer t0k', d.digest!.id)).toEqual({ handled: true, code: 200 })
  expect(cursorOnDisk()).toEqual({ line: 1 })
})

// ------------------------------------------------------------------ 5. structured digest
const report = { happened: 'Eve（mesh-50008）要 mock-api 10 月可用率放進月報，限「明天 10 點前」', did: '回覆 Eve：「10 月 mock-api 可用率我還沒有數字，不承諾明天 10 點前」',
  promised: '對 Eve：算出來後附算法與來源回覆；沒有時限', needs_main: '決定誰算、用哪個來源、期限' }
const reportRec = (rep: any, o: Partial<LedgerRec> = {}) => L({ kind: 'receipt', text: 'run -: done — x', refs: { report: rep }, ...o })

test('structured digest: a thread that promised something shows all four parts with the lane\'s concrete facts', () => {
  const d = renderDigest([reportRec(report, { lane: 'adam.reflex.6', thread: 'adam#t-b30f47' })])!
  const lines = d.text.split('\n')
  const i = lines.findIndex(l => l.startsWith('▸ adam.reflex.6｜adam#t-b30f47｜2026-11-13T'))
  expect(i).toBeGreaterThan(0)
  expect(lines[i + 1]).toBe(`  發生：${report.happened}`)
  expect(lines[i + 2]).toBe(`  做了：${report.did}`)
  expect(lines[i + 3]).toBe(`  承諾：${report.promised}`)
  expect(lines[i + 4]).toBe(`  需主線：${report.needs_main}`)
  expect(d.text).toContain('mesh-50008')
  expect(d.text).toContain('不承諾明天 10 點前')                                      // the exact text sent to the peer survives
  expect(d.wake).toBe(false)                                                         // a promise needs the main, but only escalate() wakes it
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
  expect(lines[iEsc + 4]).toContain('需主線：【A-1103 升級｜mock-backup｜P1】upload 連續 403')
  expect(lines[iEsc + 3]).toBe('  承諾：無')
  expect(lines[iEsc + 2]).toContain('已通知 Joey（已響鈴），不要重複通知他')              // what the lane did, from its push
  expect(lines[iEsc + 5]).toContain('這件事交給你了')                                  // 002d: the handoff names its owner
  expect(d.wake).toBe(true)
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
  expect(d.text).toContain('  發生：升級主線（見「需主線」）')
  expect(d.text).toContain('  做了：reply_agent → eve（hop 2）：10 月可用率我還沒有數字，不承諾明天 10 點前')
  expect(d.text).toContain('  需主線：Eve 要 10 月可用率放進月報')
  const fork = renderDigest([L({ lane: 'adam.fork.1', thread: 'adam#t-f1', kind: 'action', text: '分身線結果：已查完 mock-api 10 月可用率 99.93%' })])!
  expect(fork.text).toContain('例行：分身線結果：已查完 mock-api 10 月可用率 99.93%')
})

test('structured digest: capped and compact — at most DIGEST_MAX_ROUTINE routine lines, the rest counted; every line is short', () => {
  const recs = Array.from({ length: 14 }, (_, i) => silentFyi(String(i + 10)))
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
  const t = takePendingDigest(false, 'piggyback')!
  expect(t.text).toContain(`發生：${report.happened}`)                                // lane report → digest, end to end
  expect(t.items).toBe(1)
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
  expect(rows[0]).toMatch(/^2026-11-13T\d\d:\d\d:\d\dZ｜action｜adam\.reflex\.3｜adam#t-cc94ed｜entry 15$/)   // timestamp, kind, lane, thread, text
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
  expect(LANE_TOOLS.map(t => t.name)).not.toContain('ledger_query')                  // lanes never get it
  expect(await callMainTool('ledger_query', {}, undefined)).toStartWith('refused:')    // a session that is not the registered main
  expect(await callMainTool('ledger_query', {}, 'some-other-session')).toStartWith('refused:')
  const def = mainToolDefs().find((t: any) => t.name === 'ledger_query')
  expect(Object.keys(def.inputSchema.properties)).toEqual(['since', 'kind', 'text'])
})

// ------------------------------------------------------------------ 7. the main-only rule line
const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'lanes-hooks', 'session-start-hook.py')
const PY = process.env.LANES_PYTHON ?? 'python3'
const hookCtx = (fn: string, args: string): string => {
  const code = `import importlib.util\nspec = importlib.util.spec_from_file_location('ssh', ${JSON.stringify(HOOK)})\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nprint(m.${fn}(${args}), end='')`
  const r = Bun.spawnSync([PY, '-c', code], { env: { PATH: process.env.PATH ?? '', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } })
  if (r.exitCode !== 0) throw new Error(`hook python failed: ${r.stderr.toString()}`)
  return r.stdout.toString()
}

test('main-only rule: the SessionStart context for the registered main tells it to ledger_query before answering what-happened / what-was-promised', () => {
  const ctx = hookCtx('main_context', `'adam', 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed'`)
  expect(ctx).toContain('先呼叫一次 ledger_query()（不帶任何參數）')
  expect(ctx).toContain('清單裡每一件都要交代到')
  expect(ctx).toContain('不要重複通知他')                                             // 002d: what a lane already told Joey is not repeated
  expect(ctx.split('\n').filter(l => l.includes('ledger_query')).length).toBe(1)    // exactly one rule line
  expect(ctx).toContain('車道摘要')                                                   // the digest delivery rule now says it rides along
  expect(ctx).not.toContain('閒下來')                                                 // …and no longer promises an idle delivery
  expect(ctx).toContain('維護焦點卡')                                                 // the rest of the rules are still there
  expect(ctx).toContain('open_worker(title, brief)')
})

test('main-only rule: absent from a lane\'s identity card and from the "you are not the main" context; the card asks for the four-part receipt', () => {
  const lane = { id: 'adam.reflex.5', kind: 'reflex', n: 5, session_id: 's', thread: 'adam#t-04f200', status: 'new', created: '', last: '', transcript: '', runs: 0, tokens_in: 0, tokens_out: 0 } as any
  const card = identityCard(lane, { summary: undefined } as any)
  expect(card).not.toContain('ledger_query')
  expect(card).not.toContain('車道摘要')
  expect(card).toContain('happened')
  expect(card).toContain('needs_main')
  expect(card).toContain('receipt 不能取代 notify_joey / ask_joey / handoff_main / reply_agent')
  expect(hookCtx('not_main_context', `'adam', 'x: not the registered main'`)).not.toContain('ledger_query')
  const out = Bun.spawnSync([PY, HOOK], { stdin: new TextEncoder().encode(JSON.stringify({ session_id: 'x' })), env: { PATH: process.env.PATH ?? '', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } })
  const j = JSON.parse(out.stdout.toString())                                         // the hook itself still runs end to end (no daemon env → not the main)
  expect(j.hookSpecificOutput.additionalContext).toContain('你不是')
  expect(j.hookSpecificOutput.additionalContext).not.toContain('ledger_query')
})
