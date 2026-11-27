// WO-201 (Chiron resend audit 2026-11-27, design.md rule 3; inventory L5, L6, L7, L18; Joey TG chiron:2864 「所以該做好的是你的無意義過度重送機制？／都給我想清楚」):
// an item is offered to the main again only when a fact says the last offer did not reach a turn that completed. A compaction, a resume, a new session,
// a process ending are not reasons by themselves. Chiron mesh-13184: how the turn ended decides — a final Stop: done; a compaction: the turn goes on; no
// normal end and no genuine output after the binding: once more, a second such end closes it; no normal end with output already there (the process gone,
// another session, a non-account StopFailure): held with the cut's instructions. WO-209 lets a process cut lead the next delivery.
// Session changes and non-account StopFailure cuts can lead after MAIN_STUCK_MS. Measured before (11-23 10:15Z → 11-27): 171 copies of items already answered were answered again
// (session_start 112, gen_end 23, stop_failure:rate_limit 44 — the last is the wall's, WO-200, not this ticket's).
// Played through the main's own hook events (what main-hook.py posts) against real processes standing in for the main (`sleep`, killed with SIGKILL) and
// real transcript files: "genuine output after the binding" is liveness.ts's predicate, read from the file the hook names.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { CUT_REOFFERS, MAIN_FAIL_MAX, MAIN_STUCK_MS, INTERRUPTED_LINE } from './lanes-main.ts'
import { genuineAssistantAfterFile, GENUINE_AFTER_MARGIN_MS } from './liveness.ts'
const L = await import('./lanes.ts?wo201-test') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-wo201-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
const offers: Array<{ sid: string; notif: any }> = [], open = new Set<string>(), sent: string[] = []
const deps: any = { role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  notifySession: async (sid: string, notif: any) => { if (!open.has(sid)) return false; offers.push({ sid, notif }); return true },
  streamOpen: (sid: string) => open.has(sid), sendBot: async (_c: string, text: string) => { sent.push(text); return 100 + sent.length }, joeyChatId: () => '1' }
L.lanesInit(deps)
const processCutLine = '〔這一則你做到一半被打斷了（對話結束）：先看已經做了什麼，接著做沒做完的；已經送出去的回覆和已經做完的動作不要重做。〕'
const WALL = 3_600_000                                         // LANES_WALL_PROBE_MS here: the wall's base, which a failed turn's backoff derives from
L.__setWallProbe(WALL)
const procs: any[] = []
afterAll(() => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } L.__setWallProbe(300_000) })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const journal = (): any[] => readFileSync(join(dir, 'lanes', 'state.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
const linesOf = (rec: string, id: string) => journal().filter(l => l.rec === rec && l.id === id)
const M = () => L.__main(), E = () => L.__events()
const row = (id: string) => M().items(r => r.id === id)[0]
const state = (id: string) => row(id)?.state
const offeredTimes = (id: string) => linesOf('msg', id).filter(l => l.state === 'offered').length
/** the router's notify lines of one rule (the ledger records every push to Joey with its tier_rule, before it is sent) */
const notifies = (rule: string): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.kind === 'notify' && x.refs?.tier_rule === rule) } catch { return [] } }
let np = 0
const P = () => `p201-${++np}`

type Gen = { pid: number; sid: string; proc: any; mcp: string; tr: string }
/** a process that stands in for the main: its SessionStart names its transcript (as Claude Code's hook input does) and its MCP stream is open */
async function startMain(): Promise<Gen> {
  const proc = Bun.spawn(['sleep', '600']); procs.push(proc)
  const sid = randomUUID(), tr = join(dir, `${sid}.jsonl`)
  writeFileSync(join(dir, 'main-expected'), sid)
  writeFileSync(tr, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'session start' } }) + '\n')
  const g = { pid: proc.pid, sid, proc, mcp: `mcp-${proc.pid}`, tr }
  open.add(g.mcp); L.__noteMcpPid(g.mcp, g.pid)
  const r = await L.__mainEvent({ event: 'SessionStart', pid: g.pid, session_id: sid, source: 'startup', transcript_path: tr })
  expect(r.accepted).toBe(true)
  await M().pump()
  return g
}
const hook = (g: Gen, event: string, o: object = {}) => L.__mainEvent({ event, pid: g.pid, session_id: g.sid, ...o })
async function kill(g: Gen): Promise<void> { g.proc.kill('SIGKILL'); await g.proc.exited; open.delete(g.mcp); await M().tick() }
let nm = 0
const rec = (g: Gen, r: object) => appendFileSync(g.tr, JSON.stringify(r) + '\n')
const at = (ms = Date.now() + 5) => new Date(ms).toISOString()
/** the model answers in the session: a genuine assistant record of a new response (its own message id), after the binding */
const answers = (g: Gen) => { const n = ++nm; rec(g, { type: 'assistant', timestamp: at(), requestId: `req_${n}`, message: { id: `msg_${n}`, model: 'claude-test', role: 'assistant', content: [{ type: 'text', text: '收到，我來處理' }] } }) }
/** what Claude Code writes when the API call failed: an assistant record with isApiErrorMessage (a quota error also carries model <synthetic>, stop_sequence) */
const apiError = (g: Gen, quota = true) => { const n = ++nm
  rec(g, { type: 'assistant', timestamp: at(), isApiErrorMessage: true, ...(quota ? {} : { requestId: `req_${n}` }),
    message: { id: `msg_err_${n}`, model: quota ? '<synthetic>' : 'claude-test', role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: quota ? "You've hit your limit" : 'API Error: 529 overloaded' }] } }) }
let nj = 0
async function joey(text: string): Promise<string> {
  const id = ++nj + 2010, meta = { chat_id: '1', message_id: String(id), user: 'joey_lab' }
  const d = await L.routeEvent({ id: `tg-1-${id}`, source: 'telegram', from: 'joey', text, meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: text, meta } } } as any)
  expect(d.target).toBe('main')
  await M().pump()
  return M().items(r => r.event === `tg-1-${id}`)[0].id
}
/** nothing a test leaves is owed to the next one's main */
function settleAll(): void {
  for (const r of M().items(r => r.state !== 'done' && r.kind !== 'digest')) L.__journal().write('msg', r.id, 'done', { reason: 'test_settled' })
  for (const e of E().rows(r => r.state === 'open')) E().set(e.id, () => true, { state: 'met', by: 'test' })
}

test('WO-201 (a): an item answered (genuine output after it was bound), then a compaction SessionStart inside its turn: not offered again; the turn goes on under its prompt and the item is done at its Stop; after process loss the next gen takes the interrupted item', async () => {
  const g = await startMain()
  const id = await joey('a: 幫我看一下週報的數字')
  expect(state(id)).toBe('offered')
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  expect(row(id)).toMatchObject({ state: 'bound', prompt_id: p }); expect(row(id).bound_at).toBeTruthy()
  answers(g)
  await hook(g, 'PreToolUse', { prompt_id: p, tool_name: 'Bash' }); await hook(g, 'PostToolUse', { prompt_id: p, tool_name: 'Bash' })
  await hook(g, 'PreCompact', {})
  const k = offers.length
  expect((await hook(g, 'SessionStart', { source: 'compact', transcript_path: g.tr })).accepted).toBe(true)
  expect(state(id)).toBe('bound')                                                         // 1.59.0: queued (session_start) and offered again at once
  expect(linesOf('msg', id).some(l => l.reason === 'session_start')).toBe(false)
  expect(M().currentGen()).toMatchObject({ state: 'in_turn', prompt_id: p, source: 'compact' })
  await M().pump(); await M().tick()
  expect(offers.length).toBe(k)
  await hook(g, 'PostToolUse', { prompt_id: p, tool_name: 'Read' })                       // the turn goes on after the compaction, same prompt (82 of 82 measured)
  await hook(g, 'Stop', { prompt_id: p, phase: 'final' })
  expect(row(id)).toMatchObject({ state: 'done', received: 'stop' })
  expect(offeredTimes(id)).toBe(1)
  await kill(g)
  expect(state(id)).toBe('done')
  // A later process loss ends the compacted turn and the next gen takes the interrupted item.
  const g2 = await startMain()
  const id2 = await joey('a2: 那上週的呢？')
  const p2 = P()
  await hook(g2, 'UserPromptSubmit', { prompt_id: p2, dids: [id2] })
  answers(g2)
  await hook(g2, 'SessionStart', { source: 'compact', transcript_path: g2.tr })
  expect(state(id2)).toBe('bound')
  await kill(g2)
  expect(row(id2)).toMatchObject({ state: 'queued', reason: 'interrupted', cut_by: 'gen_end' }); expect(typeof row(id2).cut_at).toBe('string')
  const g3 = await startMain()
  expect(offeredTimes(id2)).toBe(2)
  expect(String(offers.at(-1)!.notif.params.content)).toContain(processCutLine)
  await kill(g3)
  settleAll()
})

test('WO-201 (b): an item answered, then /clear (a new session in the same process) and then a process restart: a session cut rides the next delivery and shares the second-cut cap', async () => {
  const g = await startMain()
  const id = await joey('b: 把 api-gw 的 timeout 調成 30 秒')
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  answers(g)
  await hook(g, 'PreToolUse', { prompt_id: p, tool_name: 'Bash' })
  // /clear: the old session ends (reason clear) and the same process starts a new one, its turn never got a Stop
  await hook(g, 'SessionEnd', { reason: 'clear' })
  const sid2 = randomUUID(), tr2 = join(dir, `${sid2}.jsonl`)
  writeFileSync(tr2, JSON.stringify({ type: 'user', timestamp: at(Date.now()), message: { role: 'user', content: '/clear' } }) + '\n')
  expect((await L.__mainEvent({ event: 'SessionStart', pid: g.pid, session_id: sid2, source: 'clear', transcript_path: tr2 })).accepted).toBe(true)
  expect(row(id)).toMatchObject({ state: 'queued', reason: 'interrupted', cut_by: 'session_start', cuts: 1 })
  expect(linesOf('msg', id).some(l => l.state === 'queued' && l.reason === 'session_start')).toBe(false)
  expect(offeredTimes(id)).toBe(1)
  const g2: Gen = { ...g, sid: sid2, tr: tr2 }
  // in the new session: a second item; its offer carries the held one with the interrupted line; answered; then the process restarts (the gen ends)
  const id2 = await joey('b2: 改好了嗎？')
  expect(state(id2)).toBe('offered')
  const n = offers.at(-1)!.notif
  expect(String(n.params.meta.did).split(',')).toEqual(expect.arrayContaining([id2, id]))
  expect(String(n.params.content)).toContain(`${INTERRUPTED_LINE}\n`)
  const p2 = P()
  await hook(g2, 'UserPromptSubmit', { prompt_id: p2, dids: String(n.params.meta.did).split(',') })
  answers(g2)
  await kill(g2)
  expect(row(id2)).toMatchObject({ state: 'queued', reason: 'interrupted', cut_by: 'gen_end' })
  expect(row(id)).toMatchObject({ state: 'done', reason: 'cut_twice', cut_by: 'gen_end', cuts: 2 })
  const g3 = await startMain()
  expect(offeredTimes(id)).toBe(2); expect(offeredTimes(id2)).toBe(2)
  const ids = String(offers.at(-1)!.notif.params.meta.did).split(',')
  expect(ids).toContain(id2); expect(ids).not.toContain(id)
  await kill(g3)
  settleAll()
})

test(`WO-201 (c): an item bound and the process dies with no genuine output after it: offered to the next gen once (cuts 1); it dies the same way again: closed (done, cut_twice), Joey told which, never offered a third time (CUT_REOFFERS ${CUT_REOFFERS})`, async () => {
  expect(CUT_REOFFERS).toBe(1)
  const g = await startMain()
  const id = await joey('c: 查 mock-api 的錯誤率')
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  rec(g, { type: 'user', timestamp: at(), message: { role: 'user', content: 'c: 查 mock-api 的錯誤率' } })   // the delivery itself is a user record: not output
  await kill(g)                                                                            // SIGKILL 0.5 s after the prompt: no SessionEnd; kill -0 ends the gen
  expect(row(id)).toMatchObject({ state: 'queued', reason: 'gen_end', cuts: 1 })
  const g2 = await startMain()
  expect(state(id)).toBe('offered')                                                        // the next gen, once
  const p2 = P()
  await hook(g2, 'UserPromptSubmit', { prompt_id: p2, dids: [id] })
  const k = sent.length
  await kill(g2)                                                                           // dies again before the model said anything
  expect(row(id)).toMatchObject({ state: 'done', reason: 'cut_twice', cuts: 2, cut_by: 'gen_end' })
  await sleep(20)
  const told = sent.slice(k).filter(s => s.includes('主線兩次在讀進下面的訊息之後') && s.includes('c: 查 mock-api 的錯誤率'))
  expect(told.length).toBe(1); expect(told[0]).toContain('還沒有任何輸出就結束了（行程不在了）'); expect(told[0]).toContain('還要處理的話請再說一次')
  const g3 = await startMain()
  await M().tick()
  expect(offeredTimes(id)).toBe(2)
  // an item offered and never bound (it never reached a turn) goes to the next gen as before, whatever happened to it: it cannot be a second copy
  const id2 = await joey('c2: 還在嗎？')
  expect(state(id2)).toBe('offered')
  await kill(g3)
  expect(row(id2)).toMatchObject({ state: 'queued', reason: 'gen_end' }); expect(row(id2).cuts).toBeUndefined()
  const g4 = await startMain()
  expect(state(id2)).toBe('offered')
  await kill(g4)
  settleAll()
})

test('WO-201 (d): a compaction in the middle of a turn, before the model said anything: nothing is queued again, M2 keeps the turn (in_turn, same prompt), nothing is offered into it; a message that comes meanwhile is pulled at the next tool boundary; both done at the Stop', async () => {
  const g = await startMain()
  const id = await joey('d: 讀完這 20 頁日誌再總結')
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  await hook(g, 'PreToolUse', { prompt_id: p, tool_name: 'Read' }); await hook(g, 'PostToolUse', { prompt_id: p, tool_name: 'Read' })
  await hook(g, 'PreCompact', {})
  const k = offers.length
  await hook(g, 'SessionStart', { source: 'compact', transcript_path: g.tr })
  expect(state(id)).toBe('bound')
  expect(journal().filter(l => l.rec === 'msg' && l.reason === 'session_start').length).toBe(0)
  expect(M().mainPhase()).toBe('in_turn'); expect(M().currentGen()!.prompt_id).toBe(p)
  const id2 = await joey('d2: 順便看一下錯誤率')                                           // comes while the compacted turn goes on
  expect(state(id2)).toBe('queued')
  await M().tick()
  expect(offers.length).toBe(k)                                                            // nothing offered into a running turn
  const r = await hook(g, 'PostToolUse', { prompt_id: p, tool_name: 'Read' })
  expect(r.additionalContext).toContain('d2: 順便看一下錯誤率')
  expect(row(id2)).toMatchObject({ state: 'bound', prompt_id: p, via_pull: true })
  await hook(g, 'Stop', { prompt_id: p, phase: 'final' })
  expect(state(id)).toBe('done'); expect(state(id2)).toBe('done')
  expect(offeredTimes(id)).toBe(1); expect(offeredTimes(id2)).toBe(0)
  await kill(g)
  settleAll()
})

test(`WO-201 (e): a StopFailure that is not an account kind: the item waits its backoff (the wall's base, LANES_WALL_PROBE_MS), not the next pump; after MAIN_FAIL_MAX (${MAIN_FAIL_MAX}) failed turns it is parked and the stuck path tells Joey once (疑似卡死); the next good turn lets it go once; failing again it is closed and Joey is told which`, async () => {
  const g = await startMain()
  const id = await joey('e: 重算十一月的月報')
  for (let i = 1; i < MAIN_FAIL_MAX; i++) {
    expect(state(id)).toBe('offered')
    const p = P()
    await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
    const t = Date.now()
    await hook(g, 'StopFailure', { prompt_id: p, error: 'server_error', reason: 'API Error: 529 overloaded' })
    expect(row(id)).toMatchObject({ state: 'queued', reason: 'stop_failure:server_error', fails: i })
    expect(row(id).fail_retry_at).toBeGreaterThanOrEqual(t + WALL); expect(row(id).fail_retry_at).toBeLessThanOrEqual(Date.now() + WALL)
    expect(M().mainPhase()).toBe('idle')                                                   // not a wall: the gen is idle (others go as usual)
    await M().pump(); await M().tick()
    expect(state(id)).toBe('queued')                                                       // 1.59.0: offered again at the next pump (5 s), no gap, no cap
    L.__journal().write('msg', id, 'queued', { fail_retry_at: Date.now() - 1 })            // its retry time comes
    await M().tick()
  }
  expect(state(id)).toBe('offered')
  const k = sent.length
  const p3 = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p3, dids: [id] })
  await hook(g, 'StopFailure', { prompt_id: p3, error: 'server_error', reason: 'API Error: 529 overloaded' })
  expect(row(id)).toMatchObject({ state: 'queued', reason: 'stop_failure_cap', fails: MAIN_FAIL_MAX }); expect(row(id).fail_retry_at).toBeUndefined()
  await sleep(20)
  const stuck = sent.slice(k).filter(s => s.includes('主線疑似卡死') && s.includes('e: 重算十一月的月報'))
  expect(stuck.length).toBe(1); expect(stuck[0]).toContain(`${MAIN_FAIL_MAX} 次回合都以錯誤結束（server_error）`)
  const n = offeredTimes(id)
  await M().pump(); await M().tick(); await M().tick()
  expect(offeredTimes(id)).toBe(n); expect(state(id)).toBe('queued')                      // parked: no time lets it go
  // another message, a good turn (a final Stop): the parked item goes once more
  const id2 = await joey('e2: 在嗎？')
  expect(state(id2)).toBe('offered')
  const p4 = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p4, dids: [id2] })                        // the gen's next hook event ends the stuck episode (main-unstuck), as before
  await hook(g, 'Stop', { prompt_id: p4, phase: 'final' })
  expect(state(id2)).toBe('done')
  expect(row(id)).toMatchObject({ reason: 'stop_failure_released', fail_released: true })
  await M().pump(); await sleep(10)                                                        // the Stop's own pump may be the one that offers it
  expect(state(id)).toBe('offered')
  const j = sent.length
  const p5 = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p5, dids: [id] })
  await hook(g, 'StopFailure', { prompt_id: p5, error: 'unknown', reason: 'API Error' })
  expect(row(id)).toMatchObject({ state: 'done', reason: 'stop_failure_gave_up', fails: MAIN_FAIL_MAX + 1 })
  await sleep(20)
  const gave = sent.slice(j).filter(s => s.includes('不會再自動交給主線') && s.includes('e: 重算十一月的月報'))
  expect(gave.length).toBe(1)
  await M().pump(); await M().tick()
  expect(offeredTimes(id)).toBe(MAIN_FAIL_MAX + 1)
  // the account wall itself is unchanged: a rate_limit StopFailure walls the gen and its item waits for the wall's probe, no fails counted
  const id3 = await joey('e3: 額度')
  const p6 = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p6, dids: [id3] })
  await hook(g, 'StopFailure', { prompt_id: p6, error: 'rate_limit', reason: "You've hit your limit" })
  expect(row(id3)).toMatchObject({ state: 'queued', reason: 'stop_failure:rate_limit' }); expect(row(id3).fails).toBeUndefined()
  expect(M().mainPhase()).toBe('walled')
  await kill(g)
  settleAll()
})

test('WO-201 (e2): a good turn of the main lets an item a failed turn left waiting go at once, before its backoff', async () => {
  const g = await startMain()
  const id = await joey('e2a: 把報表寄出去')
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  await hook(g, 'StopFailure', { prompt_id: p, error: 'server_error', reason: 'API Error: 529 overloaded' })
  expect(row(id).fail_retry_at).toBeGreaterThan(Date.now() + WALL - 5_000)
  const id2 = await joey('e2b: 今天幾號？')
  expect(state(id2)).toBe('offered'); expect(state(id)).toBe('queued')                      // others go as usual; the failed one waits
  const p2 = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p2, dids: [id2] })
  await hook(g, 'Stop', { prompt_id: p2, phase: 'final' })                                 // the model answers again
  expect(row(id).fail_retry_at).toBeUndefined()
  await M().pump(); await sleep(10)
  expect(state(id)).toBe('offered')
  const p3 = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p3, dids: [id] }); await hook(g, 'Stop', { prompt_id: p3, phase: 'final' })
  expect(state(id)).toBe('done')
  await kill(g)
  settleAll()
})

test('WO-201 (f): while the main cannot act (walled; offline) handoff-due and card-due are not pushed; back and still unhandled, they come at due_at + the time it could not act (the clock pauses, it does not restart); critical-due still rings while walled', async () => {
  const g = await startMain()
  open.delete(g.mcp)                                                                       // nothing is offered to it in this test: the hand-overs stay unhandled
  const t0 = Date.now(), k = sent.length
  E().open('ev-201f-ho', { class: 'peer', owner: 'main', from: 'eve', text: 'f-ho', obligations: [{ kind: 'main', level: 'handed', owner: 'main', handoff: 'ho-201f1', what: 'f: Eve 要主線決定 api-gw timeout', due_at: t0 + 300_000 }] })
  E().open('ev-201f-card', { class: 'peer', owner: 'main', from: 'eve', text: 'f-card', obligations: [{ kind: 'main', level: 'handed', owner: 'main', handoff: 'ho-201f2', what: 'f: 信箱的卡 要不要退款', defer: true, card: true, woke: 'due', woke_at: new Date(t0).toISOString(), due_at: t0 + 300_000 }] })
  E().open('ev-201f-crit', { class: 'critical', owner: 'router', from: 'alert-dispatcher', text: 'f: [P1][critical] mock-backup 全部失敗', obligations: [{ kind: 'joey', level: 'line', ring: true, due_at: t0 + 45_000 }] })
  const gid = String(g.pid)
  const ho = () => sent.slice(k).filter(s => s.includes('ho-201f1')), card = () => sent.slice(k).filter(s => s.includes('ho-201f2'))
  // walled from t0 + 1 s to t0 + 600 s (synchronous from here to the recovery: the 1-second sweep of the daemon cannot run in between)
  L.__journal().write('main', gid, 'walled', { kind: 'rate_limit', error: 'rate_limit', wall_since: new Date(t0).toISOString(), probes: 0, retry_at: t0 + WALL })
  expect(M().mainPhase()).toBe('walled')
  L.dueTick(t0 + 1_000)
  L.dueTick(t0 + 400_000)                                                                  // past both due times, and the critical one's
  L.__journal().write('main', gid, 'idle', { kind: null, wall_since: null, probes: null, retry_at: null, error: null })   // the wall is down at t0 + 600 s
  L.dueTick(t0 + 600_000)
  await sleep(30)
  expect(ho()).toEqual([]); expect(card()).toEqual([])                                     // 1.59.0: both pushed at t0 + 300 s with 「（主線現在不能用模型）」
  expect(sent.slice(k).filter(s => s.includes('嚴重警報已收到') && s.includes('mock-backup')).length).toBe(1)   // critical-due unchanged
  expect(L.__mainDown().spans.some(([a, b]) => a === t0 + 1_000 && b === t0 + 600_000)).toBe(true)
  // the clock paused for the 599 s the main could not act: due at t0 + 300 s + 599 s = t0 + 899 s (a restart at recovery would say t0 + 900 s)
  L.dueTick(t0 + 899_000 - 1_000); await sleep(20)
  expect(ho()).toEqual([]); expect(card()).toEqual([])
  L.dueTick(t0 + 899_000 + 1); await sleep(30)
  expect(ho().length).toBe(1); expect(card().length).toBe(1)
  expect(ho()[0]).toContain('這件事原本交給主線處理（ho-201f1）'); expect(card()[0]).toContain('這件事放在主線的信箱等決定（ho-201f2')
  for (const s of [...ho(), ...card()]) { expect(s).not.toContain('主線現在不能用模型'); expect(s).not.toContain('主線現在不在線') }
  L.dueTick(t0 + 999_000); await sleep(20)
  expect(ho().length).toBe(1); expect(card().length).toBe(1)                              // once each
  // offline: the main's process is gone; a hand-over due meanwhile is not pushed; a main back, it is (its due time past; the outage was real time, a few
  // ms, so the paused clock adds next to nothing). Its times are after the walled span above (synthetic times, t0 + 1000 s on)
  await kill(g)
  expect(M().mainPhase()).toBe('gone')
  const t1 = t0 + 1_000_000, j = sent.length
  E().open('ev-201f-ho2', { class: 'peer', owner: 'main', from: 'eve', text: 'f-ho2', obligations: [{ kind: 'main', level: 'handed', owner: 'main', handoff: 'ho-201f3', what: 'f: 主線不在時交的', due_at: t1 + 300_000 }] })
  const ho2 = () => sent.slice(j).filter(s => s.includes('ho-201f3'))
  L.dueTick(t1 + 300_001); L.dueTick(t1 + 400_000); await sleep(20)
  expect(ho2()).toEqual([])                                                                // 1.59.0: pushed with 「（主線現在不在線）」
  const g2 = await startMain(); open.delete(g2.mcp)
  L.dueTick(Date.now()); L.dueTick(t1 + 400_000 + 5_000); await sleep(30)                // the span the sweep saw closes; the due time has passed
  expect(ho2().length).toBe(1); expect(ho2()[0]).not.toContain('主線現在不在線')
  await kill(g2)
  settleAll()
})

test('WO-201 (g): an API-error assistant record after the binding (isApiErrorMessage true: a quota error with model <synthetic> and stop_sequence, or a 529 with a real model) does NOT count as received: the process dies, the item is offered to the next gen', async () => {
  const g = await startMain()
  const id = await joey('g: 幫我把這段翻成英文')
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  apiError(g, true); apiError(g, false)
  rec(g, { type: 'assistant', timestamp: at(), message: { id: 'msg_syn', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] } })   // the resume's <synthetic> line
  await kill(g)
  expect(row(id)).toMatchObject({ state: 'queued', reason: 'gen_end', cuts: 1 })
  const g2 = await startMain()
  expect(state(id)).toBe('offered')
  const p2 = P()
  await hook(g2, 'UserPromptSubmit', { prompt_id: p2, dids: [id] })
  answers(g2)
  await hook(g2, 'Stop', { prompt_id: p2, phase: 'final' })
  expect(state(id)).toBe('done')
  await kill(g2)
  settleAll()
})

test('WO-201 (h): the process ends after the model answered, with no Stop: an already queued message leads the next delivery and carries the process-cut line, one prompt binds both', async () => {
  const g = await startMain()
  const id = await joey('h: 把 11 月的帳對完，對完跟我說')
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  answers(g)                                                                               // 「收到，我來處理」: the work started
  await hook(g, 'PreToolUse', { prompt_id: p, tool_name: 'Bash' })
  await kill(g)                                                                            // the process dies mid-work
  expect(row(id)).toMatchObject({ state: 'queued', reason: 'interrupted', cut_by: 'gen_end' })
  const k = sent.length
  const j = await joey('h2: 對到哪了？')
  const g2 = await startMain()
  const n = offers.at(-1)!.notif
  expect(String(n.params.meta.did).split(',').slice(0, 2)).toEqual([j, id])                // the new message leads, the cut one rides it
  const c = String(n.params.content)
  expect(c.indexOf(processCutLine)).toBeGreaterThan(c.indexOf('h2: 對到哪了？'))
  expect(c.indexOf(processCutLine)).toBeLessThan(c.indexOf('h: 把 11 月的帳對完'))       // the line in front of the cut item
  const p2 = P()
  await hook(g2, 'UserPromptSubmit', { prompt_id: p2, dids: String(n.params.meta.did).split(',') })
  expect(state(id)).toBe('bound'); expect(state(j)).toBe('bound')
  await hook(g2, 'Stop', { prompt_id: p2, phase: 'final' })
  expect(state(id)).toBe('done'); expect(state(j)).toBe('done')
  expect(offeredTimes(id)).toBe(2)
  await sleep(20)
  expect(sent.slice(k).some(s => s.includes('疑似卡死'))).toBe(false)
  await kill(g2)
  settleAll()
})

test('WO-201 (h2): a non-account StopFailure after the model answered: an interrupted turn too (no backoff, no fails: it rides the next delivery with the line); an item pulled into the same turn after that answer, with nothing said after it, takes the backoff', async () => {
  const g = await startMain()
  const id = await joey('h2a: 幫我重跑備份並回報')
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  answers(g)
  await sleep(20)                                                                          // the next item is bound after that answer
  const late = await joey('h2b: 順便看磁碟')
  expect(state(late)).toBe('queued')
  await hook(g, 'PreToolUse', { prompt_id: p, tool_name: 'Bash' })
  expect((await hook(g, 'PostToolUse', { prompt_id: p, tool_name: 'Bash' })).additionalContext).toContain('h2b: 順便看磁碟')   // pulled
  await hook(g, 'StopFailure', { prompt_id: p, error: 'server_error', reason: 'API Error: 529 overloaded' })
  expect(row(id)).toMatchObject({ state: 'queued', reason: 'interrupted', cut_by: 'stop_failure:server_error' })
  expect(row(id).fails).toBeUndefined(); expect(row(id).fail_retry_at).toBeUndefined()
  expect(row(late)).toMatchObject({ state: 'queued', reason: 'stop_failure:server_error', fails: 1 }); expect(row(late).fail_retry_at).toBeGreaterThan(Date.now() + WALL - 5_000)
  expect(M().mainPhase()).toBe('idle')
  await M().pump(); await M().tick()
  expect(offeredTimes(id)).toBe(1); expect(offeredTimes(late)).toBe(0)
  const j = await joey('h2c: 好了嗎？')
  const n = offers.at(-1)!.notif
  expect(String(n.params.meta.did).split(',')).toEqual(expect.arrayContaining([j, id])); expect(String(n.params.meta.did).split(',')).not.toContain(late)
  { const c = String(n.params.content); expect(c).toContain(`${INTERRUPTED_LINE}\n<channel`); expect(c.indexOf(INTERRUPTED_LINE)).toBeLessThan(c.indexOf('h2a: 幫我重跑備份並回報')) }   // a rider: the line, then its tag
  const p2 = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p2, dids: String(n.params.meta.did).split(',') })
  await hook(g, 'Stop', { prompt_id: p2, phase: 'final' })                                 // a good turn: the backed-off one goes now (releaseFailed)
  expect(state(id)).toBe('done'); expect(row(late).fail_retry_at).toBeUndefined()
  await M().pump(); await sleep(10)
  expect(state(late)).toBe('offered')
  await kill(g)
  settleAll()
})

test.each(['session_start', 'stop_failure:server_error'])('WO-201 (i): an answered %s cut waits 600 seconds to go alone with the Esc line and no stuck episode', async why => {
  const g = await startMain()
  const id = await joey('i: 幫我把簡報改成英文')
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  answers(g)
  if (why === 'session_start') await hook(g, 'SessionStart', { source: 'resume', transcript_path: g.tr })
  else await hook(g, 'StopFailure', { prompt_id: p, error: 'server_error' })
  expect(row(id)).toMatchObject({ state: 'queued', reason: 'interrupted', cut_by: why })
  const k = offers.length, t = sent.length, ns = notifies('main-stuck').length, nu = notifies('main-unstuck').length
  await M().tick(Date.now() + MAIN_STUCK_MS - 60_000)
  expect(offers.length).toBe(k)                                                            // within MAIN_STUCK_MS: it waits for a delivery to ride
  await M().tick(Date.now() + MAIN_STUCK_MS + 1_000)
  expect(offers.length).toBe(k + 1)
  const n = offers.at(-1)!.notif
  expect(String(n.params.meta.did).split(',')[0]).toBe(id)
  expect(String(n.params.content)).toContain(`${INTERRUPTED_LINE}\ni: 幫我把簡報改成英文`)
  expect(row(id)).toMatchObject({ state: 'offered', reason: 'interrupted_untaken' })
  await sleep(20)
  expect(sent.slice(t).filter(s => s.includes('主線疑似卡死'))).toEqual([])                 // mesh-13191: not stuck, nobody told (the first 1.59.1 pushed main-stuck here)
  expect(notifies('main-stuck').length).toBe(ns)
  const p2 = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p2, dids: String(n.params.meta.did).split(',') })   // its next hook event: no stuck episode was open
  await hook(g, 'Stop', { prompt_id: p2, phase: 'final' })
  expect(state(id)).toBe('done'); expect(offeredTimes(id)).toBe(2)
  await M().tick(Date.now() + MAIN_STUCK_MS + 30_000); await M().tick(Date.now() + 2 * MAIN_STUCK_MS)
  expect(offeredTimes(id)).toBe(2)                                                         // once
  await sleep(20)
  expect(sent.slice(t).filter(s => s.includes('疑似卡死'))).toEqual([])                     // neither 主線疑似卡死 nor 疑似卡死解除
  expect(notifies('main-stuck').length).toBe(ns); expect(notifies('main-unstuck').length).toBe(nu)
  await kill(g)
  settleAll()
})

test('WO-201 (i2): the alone delivery of an item with no cut_by (a colleague\'s item of a turn that never got its Stop: WO-157c) stays the stuck path, unchanged: main-stuck pushed, the stuck episode open, its next hook event pushes main-unstuck', async () => {
  const g = await startMain()
  E().open('ev-201i2', { class: 'peer', owner: 'main', from: 'eve', text: 'i2', obligations: [{ kind: 'main', level: 'handed', owner: 'main', handoff: 'ho-201i2' }] })
  const id = M().enqueue('peer', { method: 'notifications/claude/channel', params: { content: 'i2: eve 要上週的備份報告', meta: { chat_id: 'eve', user: 'eve', btcc_msg_id: '92011' } } }, { via: 'tg', event: 'ev-201i2' })
  await M().pump(); await sleep(10)                                                        // enqueue's own pump may be the one that offers it
  expect(state(id)).toBe('offered')
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  answers(g)
  const p2 = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p2 })                                     // a new prompt, no Stop for p: cutTurn (cut_by cleared)
  expect(row(id)).toMatchObject({ state: 'queued', reason: 'interrupted' }); expect(row(id).cut_by).toBeUndefined()
  await hook(g, 'Stop', { prompt_id: p2, phase: 'final' })
  const t = sent.length, ns = notifies('main-stuck').length, nu = notifies('main-unstuck').length
  await M().tick(Date.now() + MAIN_STUCK_MS + 1_000)
  expect(row(id)).toMatchObject({ state: 'offered', reason: 'interrupted_untaken' })
  await sleep(20)
  expect(notifies('main-stuck').length).toBe(ns + 1)
  expect(sent.slice(t).filter(s => s.includes('主線疑似卡死：交給它的訊息')).length).toBe(1)
  const p3 = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p3, dids: [id] })                          // the episode was open: its next hook event ends it
  await sleep(20)
  expect(notifies('main-unstuck').length).toBe(nu + 1)
  expect(sent.slice(t).filter(s => s.includes('疑似卡死解除')).length).toBe(1)
  await hook(g, 'Stop', { prompt_id: p3, phase: 'final' })
  expect(state(id)).toBe('done')
  await kill(g)
  settleAll()
})

test('WO-201 (j): the transcript has nothing after the binding yet (its last second not on disk when the gen ends: Chiron mesh-13196, m-mwyr8ssj-1), but M2 received a tool call of that prompt after the binding: an interrupted turn\'s (output_by hook:PreToolUse), held with one cut; an item pulled into that turn counts only a Stop (a tool call after the pull may be the response already streaming), and a subagent\'s tool call counts for nothing: both take the no-output path', async () => {
  const g = await startMain()
  const id = await joey('j: 幫我回 Eve 說好')
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  await hook(g, 'PreToolUse', { prompt_id: p, tool_name: 'mcp__plugin_telegram-http_telegram-http__react' })   // M2: tool_open react, 2.3 s after the binding in the lab
  expect(M().currentGen()).toMatchObject({ state: 'in_turn', prompt_id: p })
  await hook(g, 'PostToolUse', { prompt_id: p, tool_name: 'mcp__plugin_telegram-http_telegram-http__react' })
  const pulled = await joey('j2: 還有，順便問他週五有空嗎')                                  // comes while the turn runs: queued, pulled at the next boundary
  await hook(g, 'PreToolUse', { prompt_id: p, tool_name: 'Read' })
  expect((await hook(g, 'PostToolUse', { prompt_id: p, tool_name: 'Read' })).additionalContext).toContain('j2: 還有')
  expect(row(pulled)).toMatchObject({ state: 'bound', prompt_id: p, via_pull: true })
  await hook(g, 'PreToolUse', { prompt_id: p, tool_name: 'Bash' })                         // after the pull: maybe still the response that was streaming
  expect(readFileSync(g.tr, 'utf8').trim().split('\n').length).toBe(1)                     // nothing in the transcript after the binding
  await kill(g)                                                                            // 0.6 s later
  expect(row(id)).toMatchObject({ state: 'queued', reason: 'interrupted', cut_by: 'gen_end', output_by: 'hook:PreToolUse' })
  expect(row(id).cuts).toBe(1)
  expect(row(pulled)).toMatchObject({ state: 'queued', reason: 'gen_end', cuts: 1 })
  const g2 = await startMain()
  const lead = String(offers.at(-1)!.notif.params.meta.did).split(',')
  expect(lead[0]).toBe(pulled)                                                             // the pulled one, with nothing said after it, leads the next gen's offer
  expect(lead).toContain(id)                                                               // the held one rides the existing lead
  expect(row(id)).toMatchObject({ state: 'offered' }); expect(String(offers.at(-1)!.notif.params.content)).toContain(processCutLine)
  await kill(g2)
  settleAll()
  // a subagent's tool call after the binding is not the main's output
  const g3 = await startMain()
  const id3 = await joey('j3: 用子 agent 讀完 20 頁日誌')
  const p3 = P()
  await hook(g3, 'UserPromptSubmit', { prompt_id: p3, dids: [id3] })
  await hook(g3, 'PreToolUse', { prompt_id: p3, tool_name: 'Read', sub: true })
  await kill(g3)
  expect(row(id3)).toMatchObject({ state: 'queued', reason: 'gen_end', cuts: 1 })
  const g4 = await startMain()
  expect(state(id3)).toBe('offered')
  await kill(g4)
  settleAll()
})

test('WO-201 liveness.genuineAssistantAfterFile: a block of a response begun before the binding (same message.id, written after a tool_result: Claude Code runs a tool while its response streams) does not count; a new response does; API errors and <synthetic> do not; no file: null (cannot tell)', () => {
  const f = join(dir, 'unit.jsonl'), T = Date.parse('2026-11-27T05:00:00.000Z'), iso = (ms: number) => new Date(ms).toISOString()
  const w = (rs: object[]) => writeFileSync(f, rs.map(r => JSON.stringify(r)).join('\n') + '\n')
  const A = (ms: number, id: string, extra: object = {}) => ({ type: 'assistant', timestamp: iso(ms), requestId: `r-${id}`, message: { id, model: 'claude-x', content: [] }, ...extra })
  const U = (ms: number) => ({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: [{ type: 'tool_result' }] } })
  const bound = T + 10_000                                                                 // pulled at the PostToolUse of msg_1's first tool
  w([A(T, 'msg_1'), U(bound - 1), A(bound + 500, 'msg_1')])                               // msg_1's second tool_use block lands after the pull
  expect(genuineAssistantAfterFile(f, bound)).toBe(0)
  w([A(T, 'msg_1'), U(bound - 1), A(bound + 500, 'msg_1'), U(bound + 900), A(bound + 2_000, 'msg_2')])
  expect(genuineAssistantAfterFile(f, bound)).toBe(bound + 2_000)
  w([A(T, 'msg_1'), A(bound + 100, 'msg_e', { isApiErrorMessage: true }), A(bound + 200, 'msg_s', { message: { id: 'msg_s', model: '<synthetic>' } })])
  expect(genuineAssistantAfterFile(f, bound)).toBe(0)
  expect(genuineAssistantAfterFile(join(dir, 'missing.jsonl'), bound)).toBeNull()
  // a large file whose post-binding span is all inside the tail window still reads back far enough (15 minutes before the binding)
  const big: object[] = [A(bound - GENUINE_AFTER_MARGIN_MS - 1_000, 'msg_old')]
  for (let i = 0; i < 600; i++) big.push({ type: 'user', timestamp: iso(bound - 60_000 + i), message: { role: 'user', content: 'x'.repeat(200) } })
  big.push(A(bound + 1, 'msg_new'))
  w(big)
  expect(genuineAssistantAfterFile(f, bound)).toBe(bound + 1)
})
