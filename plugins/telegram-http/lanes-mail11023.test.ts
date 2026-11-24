// telegram-http 1.38.2 (Chiron mail #11023; WO-128 point 3): two fixes, each replayed from the evidence.
// 1. A lane hands a scheduled run to the main and then files its receipt with run_id: the run is the main's to complete. Before (chiron.reflex.3, run 6916,
//    11-24 01:01Z): handoff_main ho-88afbc, then receipt(run_id 6916, outcome failed, 4 steps / 2 not done) → 「complete run 6916: HTTP 200」; the main's own
//    `btcc-receipt complete 6916 --outcome ok` at 01:12Z was refused by its hook (「排程 run 6916 已經回執過了（receipt 送的）…」). Now the lane's receipt (the
//    tool, or btcc-receipt through the guard hook) records the lane's part and leaves the run to the main; the main's hand-over item and its Stop check say it
//    owes `btcc-receipt complete <run>`; a lane that closes the run itself completes it as before.
// 2. The hand-over due sweep pushed the hand-over text to Joey 300 s after the hand-over while the main had already taken the item and replied to Joey
//    (ho-f69139: TG 2073 then 2074; ho-1d6dd1: TG 2103 then 2104). Now a hand-over whose item is offered to the live main or bound to its turn, or that the
//    main has replied to Joey about since it was handed over, is not pushed; when the item leaves the main's hands unreplied, the old due time stands.
// The lane process is a stand-in that records its env and ends when the test says so; the guard hook runs as a real process against the daemon's
// /lane-receipt; the scheduler is a stand-in that records completions; the main is a stand-in process driven through its hook events.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer } from 'http'
import { randomUUID } from 'crypto'
import { decisionEvent } from './mail-events.ts'
process.env.LANES_FLOOD_CONTROL = '0'
process.env.LANES_DEFER_DECISIONS = '0'                                    // 1.38.x: decide_later wakes the main (a later version may defer it)
const schedCalls: any[] = []
const schedSrv = createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { schedCalls.push({ path: req.url, ...JSON.parse(b || '{}') }); res.end(JSON.stringify({ text: `${JSON.parse(b || '{}').action} run ${JSON.parse(b || '{}').run_id}: HTTP 200` })) }) })
await new Promise<void>(r => schedSrv.listen(0, '127.0.0.1', () => r()))
process.env.LANES_INBOX_PORT = String((schedSrv.address() as any).port)
const L = await import('./lanes.ts?mail11023') as typeof import('./lanes.ts')
delete process.env.LANES_INBOX_PORT

const ws = mkdtempSync(join(tmpdir(), 'lanes-11023-ws-'))
const dir = join(ws, '.lanes'); mkdirSync(dir)
const tmp = mkdtempSync(join(tmpdir(), 'lanes-11023-'))
mkdirSync(join(tmp, 'tr'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
const ARGV = join(tmp, 'argv.jsonl'), bin = join(tmp, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, sys, time
lid = os.environ.get('LANE_ID', 'x')
keys = ['LANE_KIND', 'LANE_ID', 'LANES_DIR', 'LANES_WORKSPACE', 'LANES_MEMORY_DIR', 'LANE_RUN_TOKEN', 'LANES_BLOCK_FACTS']
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
// the mailbox (decide_later): an id and a deadline, as BTCC answers through fleet-mail.ts
const box = new Map<number, any>()
let nextId = 11023
L.__setMailTool(async b => {
  const a = b.args ?? {}
  if (b.name === 'decide_later') { const id = ++nextId; box.set(id, { id, lane: b.lane, thread: a.thread, ref: a.ref, card: { ...a.card, deadline: '2026-11-24T03:00:00.000Z' }, title: a.title })
    return { text: `放進主線的信箱了（#${id}，期限 11-24 03:00Z）。`, isError: false, mail_id: id, deadline: '2026-11-24T03:00:00.000Z' } }
  if (b.name === 'mailbox_check') return { text: `#${a.id} 勾掉了。`, isError: false }
  return { text: 'ok', isError: false }
})
const sent: Array<{ text: string; silent: boolean }> = []
const open = new Set<string>()
L.lanesInit({ role: 'tg', agent: 'chiron', workspaceDir: ws, transcriptDir: join(tmp, 'tr'), httpPort: 0, log: () => {}, authOk: () => true, registryNames: () => ['eve', 'scheduler'],
  notifySession: async (sid: string) => open.has(sid), streamOpen: (sid: string) => open.has(sid), toolsChanged: () => {},
  sendBot: async (_c: string, text: string, o: any) => { sent.push({ text, silent: !!o?.silent }); return 2100 + sent.length }, joeyChatId: () => '1' } as any)
const laneSrv = createServer(async (req, res) => { if (!(await L.handleLanesHttp(new URL(req.url ?? '/', 'http://127.0.0.1'), req, res))) res.writeHead(404).end() })
await new Promise<void>(r => laneSrv.listen(0, '127.0.0.1', () => r()))
const procs: any[] = []
afterAll(() => { for (const f of Object.keys(L.__lanesState().lanes)) try { writeFileSync(join(tmp, `go-${f}`), 'ok') } catch {}
  for (const p of procs) try { p.kill('SIGKILL') } catch {}
  schedSrv.close(); laneSrv.close(); L.__setClaudeBin(restore); L.__setMailTool(null)
  for (const k of ['LANES_FLOOD_CONTROL', 'LANES_DEFER_DECISIONS']) delete process.env[k]
  rmSync(ws, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }) })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const jsonl = (p: string): any[] => { try { return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const ledger = () => jsonl(join(dir, 'ledger.jsonl'))
const runsOf = () => jsonl(ARGV)
const E = () => L.__events(), M = () => L.__main()
const ob = (id: string, kind: string) => (E().get(id)?.obligations ?? []).find((o: any) => o.kind === kind)
const completions = (run: string) => schedCalls.filter(c => c.path === '/lanes/scheduler' && c.action === 'complete' && String(c.run_id) === run)
const pushes = (from: number, what: string) => sent.slice(from).filter(s => s.text.includes('原本交給主線處理') && s.text.includes(what))
let n = 0
const mk = (from: string, text: string, extra: object = {}) => ({ id: `mesh-11023-${++n}`, source: 'mesh', from, verified: true, text, meta: {}, notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } }, ...extra } as any)
const sched = (run: number, what: string) => { const e = mk('scheduler', `[scheduled][${what}][run:${run}][P3][maintenance] ${what} 時間到：派子 agent 讀對話、append 日誌、移 marker，再 complete 回執`); e.meta = { run_id: String(run) }; return e }
type Run = { id: string; lane: string; tok: any; env: Record<string, string> }
async function start(ev: any): Promise<Run> {
  const before = runsOf().length
  const d = await L.routeEvent(ev)
  expect(d).toMatchObject({ target: 'lane' })
  expect(await until(() => !!L.__runTok(d.lane!) && L.__runTok(d.lane!)!.evId === ev.id && runsOf().length > before)).toBe(true)
  return { id: ev.id, lane: d.lane!, tok: L.__runTok(d.lane!)!, env: runsOf().filter(x => x.lane === d.lane).at(-1).env }
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
/** the main: a stand-in process registered as this agent's main, its Telegram stream open (an idle main is offered items) */
async function mainUp(): Promise<{ pid: number; hook: (event: string, o?: object) => Promise<any>; kill: () => Promise<void> }> {
  const p = Bun.spawn(['sleep', '600']); procs.push(p)
  const sid = randomUUID(); writeFileSync(join(dir, 'main-expected'), sid); open.add(`mcp-${p.pid}`); L.__noteMcpPid(`mcp-${p.pid}`, p.pid)
  const hook = (event: string, o: object = {}) => L.__mainEvent({ event, pid: p.pid, session_id: sid, ...o } as any)
  await hook('SessionStart', { source: 'startup' })
  return { pid: p.pid, hook, kill: async () => { await hook('SessionEnd'); p.kill('SIGKILL') } }
}
/** the main's turn takes the event's item (the item offered to it names it: did) */
async function takes(m: { hook: (e: string, o?: object) => Promise<any> }, ev: string, prompt: string): Promise<void> {
  await m.hook('UserPromptSubmit', { prompt_id: prompt, dids: M().items(r => r.state !== 'done' && r.event === ev).map(r => r.id) })
  expect(M().items(r => r.event === ev && r.kind !== 'digest').at(-1)).toMatchObject({ state: 'bound', prompt_id: prompt })
}
async function stopCheck(m: { hook: (e: string, o?: object) => Promise<any> }, prompt: string): Promise<any> {
  for (let i = 0; i < 10; i++) { const r = await m.hook('Stop', { prompt_id: prompt }); if (!String(r.block ?? '').startsWith('這一輪先不要結束。')) return r }
  throw new Error('still pulling')
}
const STEPS = [{ step: 'ack 6916', done: true }, { step: '派子 agent 增量寫 harness-journal 並更新 marker', done: false, note: '車道禁止，已交主線' },
  { step: '跑 routing_lint', done: true, note: '2 新句，已交主線判斷' }, { step: 'complete 6916', done: false, note: '日誌未寫，交主線' }]

// ------------------------------------------------------------------ 1: the receipt of a run handed to the main is the main's
test('#11023-1, replay of run 6916: handoff_main, then the lane\'s receipt(run_id, failed, 2 steps not done) records the lane\'s part and does NOT complete the run; the main\'s item and Stop check say it owes btcc-receipt complete 6916; its own completion goes through and meets it', async () => {
  const m = await mainUp()
  const r = await start(sched(6916, 'harness-journal'))
  expect(ob(r.id, 'receipt')).toMatchObject({ state: 'open', run_id: '6916' })
  expect(await call(r, 'handoff_main', { text: '排程 run 6916（harness-journal）我這條線做不了：規定我不寫 knowledge/、不開子 agent。要你接：派子 agent 增量讀對話、append 後把 marker 前移，再 complete 6916。' }))
    .toContain('handed to the main')
  expect(ob(r.id, 'receipt')).toMatchObject({ state: 'handed', run_id: '6916' })
  const item = M().items(x => x.event === r.id && x.kind === 'handoff').at(-1)!
  const content = String((item.notif.params as any).content)
  expect(content).toContain('（這件事交給你了：處理完由你回報 Joey 一次。）\n（排程 run 6916 的回執也交給你了：做完用 ~/.claude/tools/btcc-receipt complete 6916 回執；車道不會替這一輪回執。）')
  const out = await call(r, 'receipt', { outcome: 'failed', run_id: '6916', happened: 'harness-journal 排程到時。車道不能寫 knowledge/、不能開子 agent，日誌沒寫。',
    did: '已 ack 6916。讀了日誌頭尾。跑了 routing_lint。已用 handoff_main 交給主線，沒有 complete。', promised: '無', needs_main: '派子 agent 寫日誌、前移 marker、complete 6916', steps: STEPS })
  expect(out).toContain('receipt recorded; scheduler run 6916 is left for the main')
  expect(out).not.toContain('HTTP 200')
  expect(completions('6916')).toEqual([])                                                             // 1.38.1: 「complete run 6916: HTTP 200」
  const rec = ledger().filter(x => x.event === r.id && x.kind === 'receipt')
  expect(rec.length).toBe(1)
  expect(rec[0].text).toContain('run 6916: failed — harness-journal 排程到時')
  expect(rec[0].text).toContain('步驟 4 步，沒做：第 2 步「派子 agent 增量寫 harness-journal 並更新 marker」（車道禁止，已交主線）')
  expect(rec[0].text).toContain('排程 run 6916 沒有在這裡完成：這件事交給主線了，主線做完由它回執。')
  expect(rec[0].refs).toMatchObject({ left_for_main: '6916', steps: STEPS })
  expect(ob(r.id, 'receipt')).toMatchObject({ state: 'handed', run_id: '6916' })                        // still the main's
  expect(await end(r)).toMatchObject({ reason: 'normal', steps_marked: 4, steps_not_done: 2 })
  expect(M().items(x => x.event === r.id && x.kind !== 'digest').length).toBe(1)                        // the exit rule hands nothing more
  // the main takes it, does the work; its Stop check names the receipt; its completion is not refused (1.38.1: 「已經回執過了（receipt 送的）」)
  const pr = 'p-6916'
  await takes(m, r.id, pr)
  L.mainReplied(L.mainReplyTier({}), 2105)
  expect((await stopCheck(m, pr)).block).toContain('排程 run 6916 的回執（btcc-receipt complete 6916）')
  const RC = { prompt_id: pr, tool_name: 'Bash', tool_input: { command: "~/.claude/tools/btcc-receipt complete 6916 --outcome ok --note '主線做完（車道交回 ho-88afbc）'" } }
  expect((await m.hook('PreToolUse', RC)).deny).toBeUndefined()
  await m.hook('PostToolUse', { ...RC, tool_response: 'completed run 6916', tool_error: false })
  await sleep(20)
  expect(ob(r.id, 'receipt')).toMatchObject({ state: 'met', by: 'main (btcc-receipt)' })
  expect((await m.hook('PreToolUse', RC)).deny).toContain('已經回執過了')                                // once per run, as before
  await m.hook('Stop', { prompt_id: pr, phase: 'final' })
  expect(E().get(r.id)!.state).toBe('closed')
  await m.kill()
}, 30000)

test('#11023-1, the guard hook path: btcc-receipt complete N from a lane that handed the run over is not sent to the scheduler; the deny reason says the main completes it; the lane\'s part is on the ledger', async () => {
  process.env.LANES_RECEIPT_STEPS = '0'                                                                // 1.39.0 (WO-129): a lane's CLI completes nothing at all (lanes-wo129); 1.38.2's path
  try {
  const r = await start(sched(6917, 'harness-journal'))
  expect(await call(r, 'handoff_main', { text: '日誌要主線寫，交給你；做完 complete 6917' })).toContain('handed to the main')
  const deny = await guard(r, "btcc-receipt complete 6917 --outcome failed --note '日誌沒寫，交主線'")
  expect(deny).toContain('run 6917 left for the main: scheduler run 6917 is left for the main')
  expect(deny).toContain('Do not run btcc-receipt complete again')
  expect(completions('6917')).toEqual([])
  const rec = ledger().filter(x => x.event === r.id && x.kind === 'receipt').at(-1)
  expect(rec.text).toContain('run 6917: failed — 日誌沒寫，交主線（btcc-receipt）\n排程 run 6917 沒有在這裡完成')
  expect(rec.refs).toMatchObject({ left_for_main: '6917' })
  expect(ob(r.id, 'receipt')).toMatchObject({ state: 'handed' })
  await end(r)
  settleEv(r.id)                                                                                       // nothing left owed to the next test's main
  } finally { delete process.env.LANES_RECEIPT_STEPS }
}, 30000)

test('#11023-1: a lane that closes the run itself (nothing handed over) completes it as before, by the receipt tool or by btcc-receipt through the guard', async () => {
  const a = await start(sched(6918, 'backup-check'))
  await call(a, 'notify_joey', { outcome: 'normal', text: '備份正常' })
  expect(await call(a, 'receipt', { outcome: 'done', run_id: '6918', happened: '備份正常', did: '查了', promised: '無', needs_main: '無', steps: [{ step: '查備份', done: true }] })).toBe('receipt recorded; scheduler: complete run 6918: HTTP 200 The line you sent before: sent to Joey (message_id 2101)')   // 1.39.0: the line waited for the receipt
  expect(completions('6918')).toMatchObject([{ outcome: 'ok' }])   // 1.41.1 (Metis #11280): the receipt's `done` reaches the scheduler as its `ok`
  expect(ledger().filter(x => x.event === a.id && x.kind === 'receipt').at(-1).refs?.left_for_main).toBeUndefined()
  await end(a)
  process.env.LANES_RECEIPT_STEPS = '0'                                                                // 1.39.0 (WO-129): the CLI path is the switch-off path
  try {
    const b = await start(sched(6919, 'backup-check'))
    await call(b, 'notify_joey', { outcome: 'normal', text: '備份正常' })
    expect(await guard(b, 'btcc-receipt complete 6919 --outcome done')).toContain('run 6919 completed: complete run 6919: HTTP 200')
    expect(completions('6919').length).toBe(1)
    await end(b)
  } finally { delete process.env.LANES_RECEIPT_STEPS }
}, 30000)

test('#11023-1 with decide_later (1.38.x: it hands the matter to the main): the asking run\'s receipt leaves the run open; the decision\'s run completes it', async () => {
  const r = await start(sched(6920, 'config-review'))
  expect(await call(r, 'decide_later', { title: '要不要改 log_level', card: { decide: '要不要把 log_level 改成 warn', recommend: '改' } })).toContain('The main was woken with your card')
  expect(await call(r, 'receipt', { outcome: 'done', run_id: '6920', happened: '要主線決定', did: '放進信箱', promised: '無', needs_main: '決定', steps: [{ step: '要不要改 log_level', done: false, note: '放進信箱等主線決定' }] })).toContain('left for the main')
  expect(completions('6920')).toEqual([])
  await end(r)
  const mid = [...box.keys()].at(-1)!, it = box.get(mid)
  const runs = runsOf().length
  const d = await L.routeEvent(decisionEvent({ id: mid, title: it.title, decision: 'as_recommended', lane: it.lane, thread: it.thread, card: it.card, ref: it.ref }) as any)
  expect(d).toMatchObject({ rule: 'mail-decision', target: 'lane' })
  expect(await until(() => L.__runTok(d.lane!)?.evId === `mail-decision-${mid}` && runsOf().length > runs)).toBe(true)
  const dr: Run = { id: `mail-decision-${mid}`, lane: d.lane!, tok: L.__runTok(d.lane!)!, env: {} }
  expect(ob(dr.id, 'receipt')).toMatchObject({ state: 'open', run_id: '6920' })                      // the receipt moved to the decision's run
  await call(dr, 'notify_joey', { outcome: 'changed', text: 'log_level 改成 warn 了' })
  expect(await call(dr, 'receipt', { outcome: 'done', run_id: '6920', happened: '照主線的決定', did: '改了', promised: '無', needs_main: '無', steps: [{ step: '改 log_level 成 warn', done: true }] })).toStartWith('receipt recorded; scheduler: complete run 6920: HTTP 200')
  expect(completions('6920').length).toBe(1)
  await end(dr)
  settleEv(r.id, dr.id)
}, 40000)

// ------------------------------------------------------------------ 2: the hand-over due sweep and a main that is on it
test('#11023-2, replay of ho-f69139 (11-23 15:27:57Z): the main took the item at once, replied to Joey at +91 s, its turn ended at +5 min 12 s: no router push at 300 s (1.38.1: TG 2074); Joey has the main\'s reply only', async () => {
  const m = await mainUp()
  const k = sent.length
  const r = await start(mk('fleet-watchdog', '讀信箱（3 封未讀，最舊的等了 41 分鐘）：先用 mailbox_list', { meta: { no_reply: 'true' }, no_reply: true, wake: 'mail', line: 'mail' }))
  await call(r, 'mailbox_open', { id: 10857 })
  expect(await call(r, 'handoff_main', { text: '讀信三封，都不用回、都未勾，主線處理完自己勾。#10857 board WO-124（epeius 做完，等驗收）' })).toContain('handed to the main')
  const ho = ob(r.id, 'main')
  expect(await until(() => M().items(x => x.event === r.id && x.kind === 'handoff').at(-1)?.state === 'offered')).toBe(true)   // offered to the idle main (15:27:57.191Z)
  L.dueTick(ho.due_at + 1)
  expect(pushes(k, 'WO-124')).toEqual([])                                                             // offered to the live main: it is on it
  const pr = 'p-7793ba22'
  await takes(m, r.id, pr)                                                                             // bound 15:27:57.295Z
  await end(r)
  L.dueTick(ho.due_at + 1)
  expect(pushes(k, 'WO-124')).toEqual([])                                                             // bound to its turn, no reply yet
  L.mainReplied(L.mainReplyTier({}), 2073)                                                             // 15:29:28Z
  expect((E().get(r.id)!.main_sends as any[]).at(-1)).toMatchObject({ to: 'joey', ref: '2073' })
  L.dueTick(ho.due_at + 1); L.dueTick(ho.due_at + 2)                                                   // 15:32:58Z: the sweep
  expect(pushes(k, 'WO-124')).toEqual([])
  expect(ob(r.id, 'main')).toMatchObject({ state: 'open' }); expect(ob(r.id, 'main').told).toBeUndefined()
  await m.hook('Stop', { prompt_id: pr, phase: 'final' })                                              // 15:33:09Z: the turn ends
  expect(ob(r.id, 'main')).toMatchObject({ state: 'met' })
  L.dueTick(ho.due_at + 600_000)
  expect(pushes(k, 'WO-124')).toEqual([])
  expect(sent.slice(k).filter(s => s.text.includes('WO-124'))).toEqual([])                             // nothing from the router about it at all
  await m.kill()
}, 30000)

test('#11023-2, replay of ho-1d6dd1 (11-24 00:48:28Z): the main replied at +257 s; even when its turn then fails (the item goes back to the queue), the reply stands: no push', async () => {
  const m = await mainUp()
  const k = sent.length
  const r = await start(mk('fleet-watchdog', '讀信箱（2 封未讀，最舊的等了 48 分鐘）：先用 mailbox_list', { meta: { no_reply: 'true' }, no_reply: true, wake: 'mail', line: 'mail' }))
  await call(r, 'mailbox_open', { id: 11005 })
  expect(await call(r, 'handoff_main', { text: '讀信兩封，都是 board 工單通知（不用回）。#11005 WO-126（epeius 做完 in_review）' })).toContain('handed to the main')
  await end(r)
  const ho = ob(r.id, 'main'), pr = 'p-1df7a994'
  await takes(m, r.id, pr)
  L.mainReplied(L.mainReplyTier({}), 2103)                                                             // 00:52:45Z
  await m.hook('StopFailure', { prompt_id: pr, error: 'server_error' })                                // the turn does not end with Stop: the item is queued again
  expect(M().items(x => x.event === r.id && x.kind === 'handoff').at(-1)!.state).toBe('queued')
  L.dueTick(ho.due_at + 1); L.dueTick(ho.due_at + 2)                                                   // 00:53:29Z
  expect(pushes(k, 'WO-126')).toEqual([])                                                             // 1.38.1: TG 2104
  await m.kill()
  settleEv(r.id)
}, 30000)

test('#11023-2: the item leaves the main\'s hands unanswered (the main went away mid-turn): the hand-over\'s own due time stands: one push, as before; a hand-over nobody took is pushed once, as before', async () => {
  const m = await mainUp()
  const k = sent.length
  const r = await start(mk('eve', '能不能把 api-gw 的 timeout 改成 30 秒？', { line: 'call' }))
  expect(await call(r, 'handoff_main', { text: 'Eve 要改 api-gw timeout，要主線決定' })).toContain('handed to the main')
  await end(r)
  const ho = ob(r.id, 'main')
  await takes(m, r.id, 'p-gone')
  L.dueTick(ho.due_at + 1)
  expect(pushes(k, 'api-gw timeout')).toEqual([])                                                    // bound to the running turn
  await m.kill()                                                                                       // the main ends: its item is queued again for the next one
  L.dueTick(ho.due_at + 2); L.dueTick(ho.due_at + 3); await sleep(20)
  expect(pushes(k, 'api-gw timeout').length).toBe(1)
  expect(pushes(k, 'api-gw timeout')[0].text).toContain('（主線現在不在線）')
  // no main at all: pushed once at its due time
  const j = sent.length
  const q = await start(mk('eve', '幫我看一下 ticket 77', { line: 'call' }))
  await call(q, 'handoff_main', { text: 'eve 要看 ticket 77，要主線' })
  await end(q)
  L.dueTick(ob(q.id, 'main').due_at - 1)
  expect(pushes(j, 'ticket 77')).toEqual([])
  L.dueTick(ob(q.id, 'main').due_at + 1); L.dueTick(ob(q.id, 'main').due_at + 2); await sleep(20)
  expect(pushes(j, 'ticket 77').length).toBe(1)
  settleEv(r.id, q.id)
}, 30000)

function settleEv(...ids: string[]): void {
  for (const id of ids) { if (!E().get(id)) continue; E().set(id, o => o.kind === 'main' && o.state === 'open', { state: 'met', by: 'test' }); E().set(id, o => ['joey', 'peer', 'receipt'].includes(o.kind) && (o.state === 'handed' || o.state === 'open'), { state: 'met', by: 'test' }) }
}
