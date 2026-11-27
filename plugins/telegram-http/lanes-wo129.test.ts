// telegram-http 1.39.0 (board WO-129, Chiron's ticket): the run a schedule gave a lane has one receipt path and it always carries steps; steps not done
// are visible to Joey and to the scheduler. What happened: atlas.reflex.23, run 6910 (11-24 00:07Z, the daily report): the lane's
// `btcc-receipt complete 6910` went guard → POST /lane-receipt (no steps) and completed the run ok at 00:09:05Z (「run 6910: ok — 日報已發營運群(msg 2012)…
// （btcc-receipt）」); at 00:09:11Z it handed step 3 to the main, and at 00:09:13Z its receipt said 「failed — 步驟 5 步，沒做：第 3 步「TaskList逐案核一手」」:
// one run, two results, the scheduler's the wrong one. The scheduler's message tells every agent to run btcc-receipt complete (scheduler-worker/worker.py
// 191-196) and the lane card pointed lanes to it. Now (LANES_RECEIPT_STEPS on): a scheduled run's receipt without steps is refused; a lane's
// btcc-receipt complete (and a direct call of the completion API the guard sees) completes nothing and points to the receipt tool; the run's notify_joey
// ends with the steps line when steps were not done. The tests follow the ticket's acceptance list (1-9). The scheduler is a stand-in that records
// completions; the guard hook runs as a real process against the daemon's /lane-receipt; the main is a stand-in process driven through its hook events.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer } from 'http'
import { randomUUID } from 'crypto'
process.env.LANES_FLOOD_CONTROL = '0'
const schedCalls: any[] = []
const schedSrv = createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { const j = JSON.parse(b || '{}'); schedCalls.push({ path: req.url, ...j }); res.end(JSON.stringify({ text: `${j.action} run ${j.run_id}: HTTP 200` })) }) })
await new Promise<void>(r => schedSrv.listen(0, '127.0.0.1', () => r()))
process.env.LANES_INBOX_PORT = String((schedSrv.address() as any).port)
const L = await import('./lanes.ts?wo129') as typeof import('./lanes.ts')
const B = await import('./lanes-boundary.ts')
delete process.env.LANES_INBOX_PORT

const ws = mkdtempSync(join(tmpdir(), 'lanes-wo129-ws-'))
const dir = join(ws, '.lanes'); mkdirSync(dir)
const tmp = mkdtempSync(join(tmpdir(), 'lanes-wo129-'))
mkdirSync(join(tmp, 'tr'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
const ARGV = join(tmp, 'argv.jsonl'), bin = join(tmp, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, sys, time
lid = os.environ.get('LANE_ID', 'x')
keys = ['LANE_KIND', 'LANE_ID', 'LANES_DIR', 'LANES_WORKSPACE', 'LANES_MEMORY_DIR', 'LANE_RUN_TOKEN', 'LANES_BLOCK_FACTS', 'LANES_RECEIPT_STEPS']
with open('${ARGV}', 'a') as f: f.write(json.dumps({'lane': lid, 'argv': sys.argv[1:], 'env': {k: os.environ[k] for k in keys if k in os.environ}}) + '\\n')
go = os.path.join('${tmp}', 'go-' + lid)
t0 = time.time()
while time.time() - t0 < 60 and not os.path.exists(go): time.sleep(0.02)
try: os.remove(go)
except OSError: pass
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
L.__setMeshSend(async () => ({ text: 'sent to eve', msgId: 88001, delivered: true }))
const sent: Array<{ text: string; silent: boolean }> = []
const open = new Set<string>()
L.lanesInit({ role: 'tg', agent: 'atlas', workspaceDir: ws, transcriptDir: join(tmp, 'tr'), httpPort: 0, log: () => {}, authOk: () => true, registryNames: () => ['eve', 'scheduler'],
  notifySession: async (sid: string) => open.has(sid), streamOpen: (sid: string) => open.has(sid), toolsChanged: () => {},
  sendBot: async (_c: string, text: string, o: any) => { sent.push({ text, silent: !!o?.silent }); return 2000 + sent.length }, joeyChatId: () => '1' } as any)
const laneSrv = createServer(async (req, res) => { if (!(await L.handleLanesHttp(new URL(req.url ?? '/', 'http://127.0.0.1'), req, res))) res.writeHead(404).end() })
await new Promise<void>(r => laneSrv.listen(0, '127.0.0.1', () => r()))
const procs: any[] = []
afterAll(() => { for (const f of Object.keys(L.__lanesState().lanes)) try { writeFileSync(join(tmp, `go-${f}`), 'ok') } catch {}
  for (const p of procs) try { p.kill('SIGKILL') } catch {}
  schedSrv.close(); laneSrv.close(); L.__setClaudeBin(restore); L.__setMeshSend(null)
  for (const k of ['LANES_FLOOD_CONTROL', 'LANES_RECEIPT_STEPS']) delete process.env[k]
  rmSync(ws, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }) })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const jsonl = (p: string): any[] => { try { return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const ledger = () => jsonl(join(dir, 'ledger.jsonl'))
const runsOf = () => jsonl(ARGV)
const E = () => L.__events(), M = () => L.__main()
const ob = (id: string, kind: string) => (E().get(id)?.obligations ?? []).find((o: any) => o.kind === kind)
const completions = (run: string) => schedCalls.filter(c => c.path === '/lanes/scheduler' && c.action === 'complete' && String(c.run_id) === run)
let n = 0
const mk = (from: string, text: string, extra: object = {}) => ({ id: `mesh-wo129-${++n}`, source: 'mesh', from, verified: true, text, meta: {}, notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } }, ...extra } as any)
const sched = (run: number, what: string, high = false) => { const e = mk('scheduler', `[scheduled][${what}][run:${run}][P3][maintenance]${high ? '[high-frequency]' : ''} ${what} 時間到\n\n[回執契約] 開工先跑：~/.claude/tools/btcc-receipt ack ${run}\n完成後必跑：~/.claude/tools/btcc-receipt complete ${run} --outcome ok --note '<一句結果摘要>'`); e.meta = { run_id: String(run), ...(high ? { frequency: 'high' } : {}) }; return e }
type Run = { id: string; lane: string; tok: any; env: Record<string, string>; prompt: string }
async function start(ev: any): Promise<Run> {
  const before = runsOf().length
  const d = await L.routeEvent(ev)
  expect(d).toMatchObject({ target: 'lane' })
  expect(await until(() => !!L.__runTok(d.lane!) && L.__runTok(d.lane!)!.evId === ev.id && runsOf().length > before)).toBe(true)
  const r = runsOf().filter(x => x.lane === d.lane).at(-1)
  return { id: ev.id, lane: d.lane!, tok: L.__runTok(d.lane!)!, env: r.env, prompt: r.argv[r.argv.indexOf('-p') + 1] }
}
async function end(r: Run): Promise<any> {
  writeFileSync(join(tmp, `go-${r.lane}`), 'ok')
  expect(await until(() => L.__runTok(r.lane)?.evId !== r.id)).toBe(true)
  await sleep(40)
  return jsonl(join(dir, 'lanes.jsonl')).filter(x => x.kind === 'exit' && x.event === r.id).at(-1)
}
const call = (r: Run, name: string, a: object) => L.callLaneTool(r.tok, name, a)
/** the lane's guard hook, run as the lane's claude runs it (the lane's env, the daemon's port) */
async function guard(r: Run, command: string): Promise<string | null> {
  const p = Bun.spawn(['python3', join(import.meta.dir, 'lanes-hooks', 'lane-guard-hook.py')], { stdin: 'pipe', stdout: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...r.env, LANES_HTTP_PORT: String((laneSrv.address() as any).port) } })
  p.stdin.write(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: ws })); p.stdin.end()
  const raw = await new Response(p.stdout).text(); await p.exited
  return raw.trim() ? JSON.parse(raw).hookSpecificOutput.permissionDecisionReason : null
}
async function mainUp(): Promise<{ pid: number; hook: (event: string, o?: object) => Promise<any>; kill: () => Promise<void> }> {
  const p = Bun.spawn(['sleep', '600']); procs.push(p)
  const sid = randomUUID(); writeFileSync(join(dir, 'main-expected'), sid); open.add(`mcp-${p.pid}`); L.__noteMcpPid(`mcp-${p.pid}`, p.pid)
  const hook = (event: string, o: object = {}) => L.__mainEvent({ event, pid: p.pid, session_id: sid, ...o } as any)
  await hook('SessionStart', { source: 'startup' })
  return { pid: p.pid, hook, kill: async () => { await hook('SessionEnd'); p.kill('SIGKILL') } }
}
function settleEv(...ids: string[]): void {
  for (const id of ids) { if (!E().get(id)) continue; E().set(id, o => o.kind === 'main' && o.state === 'open', { state: 'met', by: 'test' }); E().set(id, o => ['joey', 'peer', 'receipt'].includes(o.kind) && (o.state === 'handed' || o.state === 'open'), { state: 'met', by: 'test' }) }
}
// atlas run 6910, its five steps as the lane listed them (ledger 00:09:13Z: 步驟 5 步，沒做：第 3 步「TaskList逐案核一手」)
const STEPS_6910 = [{ step: 'ack 6910', done: true }, { step: '讀 REANCHOR 三條線', done: true }, { step: 'TaskList逐案核一手', done: false, note: '未做，已交主線' },
  { step: '查 BVI 信與年費', done: true }, { step: '日報發營運群', done: true, note: 'msg 2012' }]
const REPORT = { happened: '08:07 日報 run 6910', did: '日報已發營運群(msg 2012)；BVI 無新信、案暫停；BVI 年費付款證據仍缺(11/30 期)；7天內無域名到期', promised: '無' }

// ------------------------------------------------------------------ 1, 2, 6, 7: the steps
test('WO-129 #1: a scheduled run\'s receipt without steps is refused, telling it to list every step in order; with steps it is accepted and completes the run', async () => {
  const r = await start(sched(7001, 'backup-check'))
  const out = await call(r, 'receipt', { outcome: 'done', run_id: '7001', ...REPORT, needs_main: '無' })
  expect(out).toBe(B.missingStepsRefusal('7001'))
  expect(out).toContain('把指示裡的每一步照順序列一項')
  expect(completions('7001')).toEqual([])
  expect(ledger().some(x => x.event === r.id && x.kind === 'receipt')).toBe(false)                   // refused = nothing recorded
  expect(await call(r, 'receipt', { outcome: 'done', run_id: '7001', ...REPORT, needs_main: '無', steps: [{ step: '查備份', done: true }, { step: '回執', done: true }] }))
    .toBe('receipt recorded; scheduler: complete run 7001: HTTP 200')
  expect(completions('7001')).toMatchObject([{ outcome: 'ok' }])   // 1.41.1 (Metis #11280): the receipt's `done` reaches the scheduler as its `ok`
  expect(await end(r)).toMatchObject({ steps_marked: 2, steps_not_done: 0, receipt_refused: { missing_steps: 1, not_done_success: 0, cli_blocked: 0 } })
}, 30000)

test('WO-129 #2: a run that is not scheduled (a peer\'s call) files its receipt without steps', async () => {
  const r = await start(mk('eve', 'api-gw 還好嗎？', { line: 'call' }))
  await call(r, 'reply_agent', { line: 'call', to: 'eve', reply_to: '1', text: 'api-gw 正常' })
  await call(r, 'notify_joey', { outcome: 'normal', text: 'Eve 問 api-gw，已回正常' })
  expect(await call(r, 'receipt', { outcome: 'done', happened: 'Eve 問 api-gw', did: '查了，回她正常', promised: '無', needs_main: '無' })).toStartWith('receipt recorded')
  expect(await end(r)).toMatchObject({ receipt_refused: { missing_steps: 0, not_done_success: 0, cli_blocked: 0 } })
}, 30000)

test('WO-129 #6: a step whose condition was not met is marked done (done=true, note says so): accepted, not counted as not done, no line', async () => {
  const r = await start(sched(7006, 'cert-renew'))
  await call(r, 'notify_joey', { outcome: 'normal', text: '憑證 40 天後到期，不用續' })
  const out = await call(r, 'receipt', { outcome: 'done', run_id: '7006', ...REPORT, needs_main: '無',
    steps: [{ step: '查憑證到期日', done: true, note: '40 天後' }, { step: '少於 14 天就續約', done: true, note: '條件沒成立（40 天）' }] })
  expect(out).toContain('receipt recorded; scheduler: complete run 7006: HTTP 200')
  expect(sent.at(-1)!.text).not.toContain('〔系統〕')
  expect(await end(r)).toMatchObject({ steps_marked: 2, steps_not_done: 0 })
}, 30000)

test('WO-129 #7: a high-frequency nothing-to-do run: one step is enough, accepted on the first receipt (no refusal, so no extra model turn)', async () => {
  const r = await start(sched(7007, 'queue-watch', true))
  expect(await call(r, 'receipt', { outcome: 'nothing-to-do', run_id: '7007', happened: '佇列 0', did: '無', promised: '無', needs_main: '無',
    steps: [{ step: '看佇列長度', done: true, note: '0，條件沒成立' }] })).toBe('receipt recorded; scheduler: complete run 7007: HTTP 200')
  expect(completions('7007')).toMatchObject([{ outcome: 'nothing-to-do' }])
  expect(await end(r)).toMatchObject({ steps_marked: 1, receipt_refused: { missing_steps: 0, not_done_success: 0, cli_blocked: 0 } })
}, 30000)

// ------------------------------------------------------------------ 3, 4: one receipt path, one result
test('WO-129 #3: a lane\'s btcc-receipt complete is refused by the guard with the pointer to the receipt tool (nothing reaches the scheduler); btcc-receipt ack is unaffected; a direct completion call too; the main\'s own complete is unaffected', async () => {
  const m = await mainUp()
  const r = await start(sched(7003, 'harness-journal'))
  expect(r.env.LANES_RECEIPT_STEPS).toBe('1')
  expect(await guard(r, '~/.claude/tools/btcc-receipt ack 7003')).toBeNull()                         // ack: the guard lets it run, as before
  const deny = await guard(r, "~/.claude/tools/btcc-receipt complete 7003 --outcome ok --note '寫好了'")
  expect(deny).toBe(B.receiptCliPointer('7003'))
  expect(deny).toContain('receipt(run_id=7003, outcome, steps)')
  const api = await guard(r, 'curl -s -X POST -H "Authorization: Bearer $T" https://btcc.example/api/scheduler/runs/7003/complete -d \'{"outcome":"ok"}\'')
  expect(api).toBe(B.receiptCliPointer('7003', 'api'))
  expect(completions('7003')).toEqual([])
  expect(ob(r.id, 'receipt')).toMatchObject({ state: 'open', run_id: '7003' })
  const lj = jsonl(join(dir, 'lanes.jsonl')).filter(x => x.kind === 'receipt_cli_refused' && x.event === r.id)
  expect(lj.map(x => x.via)).toEqual(['cli', 'api'])
  // the lane hands the run to the main; the main's own btcc-receipt complete goes through and meets it (as 1.38.2)
  expect(await call(r, 'handoff_main', { text: '日誌要主線寫，交給你；做完 complete 7003' })).toContain('handed to the main')
  expect(await call(r, 'receipt', { outcome: 'failed', run_id: '7003', ...REPORT, needs_main: '寫日誌、complete 7003', steps: [{ step: '寫日誌', done: false, note: '車道不能寫，交主線' }] })).toContain('left for the main')
  const x = await end(r)
  expect(x.receipt_refused).toEqual({ missing_steps: 0, not_done_success: 0, cli_blocked: 2 })
  const pr = 'p-7003'
  await m.hook('UserPromptSubmit', { prompt_id: pr, dids: M().items(q => q.state !== 'done' && q.event === r.id).map(q => q.id) })
  const RC = { prompt_id: pr, tool_name: 'Bash', tool_input: { command: "~/.claude/tools/btcc-receipt complete 7003 --outcome ok --note '主線寫好了'" } }
  expect((await m.hook('PreToolUse', RC)).deny).toBeUndefined()
  await m.hook('PostToolUse', { ...RC, tool_response: 'completed run 7003', tool_error: false })
  await sleep(20)
  expect(ob(r.id, 'receipt')).toMatchObject({ state: 'met', by: 'main (btcc-receipt)' })
  await m.hook('Stop', { prompt_id: pr, phase: 'final' })
  await m.kill()
  settleEv(r.id)
}, 30000)

test('WO-129 #4 and #3 of the ticket, replay of atlas.reflex.23 run 6910: the CLI\'s ok is refused, the receipt with step 3 not done and outcome done is refused (regression), accepted after the hand-over; the scheduler never gets ok for 6910', async () => {
  const r = await start(sched(6910, 'daily-report'))
  // 00:09:05Z: the lane's btcc-receipt complete 6910 --outcome ok (1.38.3: completed through /lane-receipt, ok)
  expect(await guard(r, "~/.claude/tools/btcc-receipt complete 6910 --outcome ok --note '日報已發營運群(msg 2012)；BVI 無新信、案暫停；BVI 年費付款證據仍缺(11/30 期)；7天內無域名到期'"))
    .toBe(B.receiptCliPointer('6910'))
  // its receipt lists step 3 not done with a success outcome: refused (WO-125 C)
  const refused = await call(r, 'receipt', { outcome: 'done', run_id: '6910', ...REPORT, needs_main: '無', steps: STEPS_6910 })
  expect(refused).toBe(B.stepsRefusal('done', STEPS_6910 as any))
  // 00:09:11Z: the hand-over; 00:09:13Z: the receipt, accepted now (the run is the main's to complete, 1.38.2)
  expect(await call(r, 'handoff_main', { text: '日報 run 6910 已發營運群（msg 2012）。未做：TaskList 進行中任務逐案對一手來源核現況。請主線視需要補核。' })).toContain('handed to the main')
  expect(await call(r, 'receipt', { outcome: 'done', run_id: '6910', ...REPORT, needs_main: '第 3 步', steps: STEPS_6910 })).toContain('left for the main')
  expect(completions('6910').filter(c => c.outcome === 'ok' || c.outcome === 'done')).toEqual([])    // the scheduler's result is not ok
  expect(completions('6910')).toEqual([])
  const x = await end(r)
  expect(x).toMatchObject({ steps_marked: 5, steps_not_done: 1, receipt_refused: { missing_steps: 0, not_done_success: 1, cli_blocked: 1 } })
  settleEv(r.id)
  // the other way out: filed as failed (部分完成), the scheduler gets failed
  const r2 = await start(sched(6911, 'daily-report'))
  expect(await call(r2, 'receipt', { outcome: 'failed', run_id: '6911', ...REPORT, needs_main: '無', steps: STEPS_6910 })).toBe('receipt recorded; scheduler: complete run 6911: HTTP 200')
  expect(completions('6911')).toMatchObject([{ outcome: 'failed' }])
  await end(r2); settleEv(r2.id)
}, 30000)

// ------------------------------------------------------------------ 5: the steps line on notify_joey
test('WO-129 #5: steps not done: the run\'s notify_joey ends with 〔系統〕這一趟 5 步裡 1 步沒做：第 3 步「…」, whether it came before the receipt (held until it) or after; all done: nothing added', async () => {
  const k = sent.length
  const r = await start(sched(7005, 'daily-report'))
  const held = await call(r, 'notify_joey', { outcome: 'changed', text: '日報已發營運群（msg 2012）。BVI 年費付款證據仍缺。' })
  expect(held).toContain('held for your receipt')
  expect(sent.length).toBe(k)                                                                         // nothing went yet
  expect(ob(r.id, 'joey')).toMatchObject({ state: 'requested' })
  const out = await call(r, 'receipt', { outcome: 'failed', run_id: '7005', ...REPORT, needs_main: '無', steps: STEPS_6910 })
  expect(out).toContain('receipt recorded; scheduler: complete run 7005: HTTP 200')
  expect(out).toContain('The line you sent before: sent to Joey')
  expect(sent.length).toBe(k + 1)
  expect(sent.at(-1)!.text.endsWith('\n〔系統〕這一趟 5 步裡 1 步沒做：第 3 步「TaskList逐案核一手」')).toBe(true)
  expect(ob(r.id, 'joey')).toMatchObject({ state: 'met' })
  expect(ledger().filter(x => x.event === r.id && x.kind === 'notify').at(-1).refs.steps_line).toBe('〔系統〕這一趟 5 步裡 1 步沒做：第 3 步「TaskList逐案核一手」')
  await end(r)
  // the receipt first, then the line: appended at once
  const r2 = await start(sched(7015, 'daily-report'))
  await call(r2, 'receipt', { outcome: 'failed', run_id: '7015', ...REPORT, needs_main: '無', steps: STEPS_6910 })
  expect(await call(r2, 'notify_joey', { outcome: 'changed', text: '日報已發，第 3 步沒做' })).toContain('sent to Joey')
  expect(sent.at(-1)!.text.endsWith('〔系統〕這一趟 5 步裡 1 步沒做：第 3 步「TaskList逐案核一手」')).toBe(true)
  await end(r2)
  // all done: nothing added
  const r3 = await start(sched(7025, 'daily-report'))
  await call(r3, 'notify_joey', { outcome: 'changed', text: '日報已發' })
  await call(r3, 'receipt', { outcome: 'done', run_id: '7025', ...REPORT, needs_main: '無', steps: STEPS_6910.map(s => ({ ...s, done: true })) })
  expect(sent.at(-1)!.text).not.toContain('〔系統〕')
  await end(r3)
  // a held line whose run ends without a receipt goes at the run's end (no steps line: none filed)
  const r4 = await start(sched(7035, 'daily-report'))
  const k4 = sent.length
  expect(await call(r4, 'notify_joey', { outcome: 'changed', text: '日報發不出去' })).toContain('held for your receipt')
  await end(r4)
  expect(await until(() => sent.length === k4 + 1)).toBe(true)
  expect(sent.at(-1)!.text).toContain('日報發不出去'); expect(sent.at(-1)!.text).not.toContain('〔系統〕')
  expect(ob(r4.id, 'joey')).toMatchObject({ state: 'met' })
  settleEv(r4.id)
  // Telegram's limit: the line is at most this long (3 steps of 40 characters listed, then 「等 N 步」); a body within that many characters of the limit is
  // split into two messages by it (sendTextParts: 4096 characters per part, less the lane's label)
  const long = Array.from({ length: 99 }, (_, i) => ({ step: `第${i}步`.padEnd(60, '長'), done: false }))
  const max = B.stepsLine(long)
  expect([...max].length).toBe(171)                                                                   // 3 steps of 40 characters, numbers 1-3, 99 steps
  const label = '〔atlas·反射線#23〕', room = 4096 - ([...label].length + 2)                         // server.ts laneLineParts: one part holds `room` characters
  expect(room - 172).toBe(3908)                                                                       // a body of more than 3,908 characters becomes two parts with the longest line
  expect(max.endsWith(' 等 99 步')).toBe(true)
  expect(B.stepsLine([{ step: 'x', done: true }])).toBe('')
}, 40000)

// ------------------------------------------------------------------ 8, 5 (words), 9
test('WO-129 #5 (words), verbatim: the identity card\'s receipt line and the persona line', () => {
  const card = L.identityCard({ kind: 'reflex' }).split('\n')
  expect(card).toContain('  - receipt(run_id, outcome, steps)：例行排程的執行回執（outcome=nothing-to-do｜done｜failed）。steps 必填：指示裡的每一步照順序列一項（step＝那一步是什麼，done＝true｜false，note＝發生了什麼或為什麼沒做）。條件沒成立所以不用做的步驟算做了（done=true，note 寫條件沒成立）。指示只有一件事就列一項。')
  const persona = card.find(l => l.startsWith('- 人格檔裡「用 reply 回報 Joey」（或「在 Telegram 回報 Joey」）'))!
  expect(persona).toContain('排程回執用 receipt(run_id, outcome, steps)；人格檔或排程訊息裡寫的 btcc-receipt complete，對你來說就是 receipt 工具（開工的 btcc-receipt ack 照舊）。人格檔中標示「主線專用」的規則不適用於你。')
  expect(persona).not.toContain('也會經由分流器完成同一個回執')
})

test('WO-129 #8: LANES_RECEIPT_STEPS=0 is 1.38.3 with that switch off: no steps, the CLI completes through the router, the line is not held, the card\'s old lines, no receipt_refused', async () => {
  process.env.LANES_RECEIPT_STEPS = '0'
  try {
    const card = L.identityCard({ kind: 'reflex' }).split('\n')
    expect(card).toContain('  - receipt(run_id, outcome)：例行排程的執行回執（outcome=nothing-to-do｜done｜failed）。')
    expect(card.find(l => l.startsWith('- 人格檔裡'))).toContain('排程回執用 receipt(run_id, outcome)（~/.claude/tools/btcc-receipt complete 也會經由分流器完成同一個回執，一個 run 只會完成一次）。')
    const r = await start(sched(7008, 'backup-check'))
    expect(r.env.LANES_RECEIPT_STEPS).toBeUndefined()
    const k = sent.length
    expect(await call(r, 'notify_joey', { outcome: 'normal', text: '備份正常' })).toContain('sent to Joey')
    expect(sent.length).toBe(k + 1)
    expect(await guard(r, '~/.claude/tools/btcc-receipt complete 7008 --outcome done')).toContain('run 7008 completed: complete run 7008: HTTP 200')
    expect(await guard(r, 'curl -s -X POST https://btcc.example/api/scheduler/runs/7008/complete')).not.toBe(B.receiptCliPointer('7008', 'api'))
    const x = await end(r)
    expect('receipt_refused' in x).toBe(false); expect('steps_marked' in x).toBe(false)
    const r2 = await start(sched(7018, 'backup-check'))
    expect(await call(r2, 'receipt', { outcome: 'done', run_id: '7018', ...REPORT, needs_main: '無' })).toBe('receipt recorded; scheduler: complete run 7018: HTTP 200')
    await end(r2)
  } finally { delete process.env.LANES_RECEIPT_STEPS }
}, 30000)
