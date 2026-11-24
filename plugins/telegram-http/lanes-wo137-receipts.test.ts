// telegram-http 1.41.1: a scheduler receipt is met only when the scheduler completed the run (two mails to Sonn, each replayed from the evidence).
// Chiron mail #11236 (run 6985, 11-24): the main's Bash at 13:01:42Z was a heredoc rewriting knowledge/lane-boundary-20261124/ANCHOR.md whose text mentioned
//   「再由主線 `~/.claude/tools/btcc-receipt complete 6985 --outcome ok --note …`」; mainToolDone matched it against the whole command text and recorded the receipt
//   met at 13:05:42Z (ref: the heredoc's output 「anchor sum 4667…」); the main's real call at 13:15:54Z was refused (「排程 run 6985 已經回執過了」) and it POSTed
//   /complete by hand at 13:17:13Z. Now only a btcc-receipt the command really runs counts (its words, as the guard reads them), and only without a refusal in
//   its output.
// Metis mail #11280 (run 6804, 11-23 02:43:53Z): metis.reflex.1's receipt(run_id 6804, outcome done) reached BTCC with `done`; BTCC answered HTTP 422; the receipt
//   was recorded met (any answer was), so its btcc-receipt retry, the 03:43Z stall-nudge's lane and the main's own call at 14:45Z were all refused as repeats,
//   and BTCC kept the run stalled_no_complete. The same on angelia 6865, cadmus 6969 / 6994, elsa 6972, pheme 6989. Now the outcome goes in the scheduler's
//   words (done → ok), a refusal leaves the receipt owed, and at boot a receipt recorded met on a refusal is owed again (handed to the main).
// The scheduler is a stand-in that answers as BTCC does (ok | nothing-to-do | failed; 409 once completed) in server.ts schedulerCall's words; the main is a
// stand-in process driven through its hook events.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer } from 'http'
import { randomUUID } from 'crypto'
process.env.LANES_FLOOD_CONTROL = '0'
const B = await import('./lanes-boundary.ts')
// BTCC's scheduler, as the agent-inbox daemon's schedulerCall reports it (`complete run N: HTTP <status>[ <detail>]`)
const schedCalls: any[] = []
const completed = new Set<string>(), refuse = new Set<string>()
function btcc(run: string, outcome: string): string {
  if (completed.has(run)) return `complete run ${run}: HTTP 409 {"detail":"run is completed, not completable"}`
  if (!['ok', 'nothing-to-do', 'failed'].includes(outcome)) return `complete run ${run}: HTTP 422 {"detail":[{"loc":["body","outcome"],"msg":"value is not a valid enumeration member"}]}`
  if (refuse.has(run)) return `complete run ${run}: HTTP 422 {"detail":"test: refused"}`
  completed.add(run)
  return `complete run ${run}: HTTP 200`
}
const schedSrv = createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { const j = JSON.parse(b || '{}'); schedCalls.push({ path: req.url, ...j })
  res.end(JSON.stringify({ text: j.action === 'complete' ? btcc(String(j.run_id), String(j.outcome)) : `${j.action} run ${j.run_id}: HTTP 200` })) }) })
await new Promise<void>(r => schedSrv.listen(0, '127.0.0.1', () => r()))
process.env.LANES_INBOX_PORT = String((schedSrv.address() as any).port)
const L = await import('./lanes.ts?wo137-receipts') as typeof import('./lanes.ts')
delete process.env.LANES_INBOX_PORT

const ws = mkdtempSync(join(tmpdir(), 'lanes-wo137r-ws-'))
const dir = join(ws, '.lanes'); mkdirSync(dir)
const tmp = mkdtempSync(join(tmpdir(), 'lanes-wo137r-'))
mkdirSync(join(tmp, 'tr'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
const ARGV = join(tmp, 'argv.jsonl'), bin = join(tmp, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, sys, time
lid = os.environ.get('LANE_ID', 'x')
with open('${ARGV}', 'a') as f: f.write(json.dumps({'lane': lid, 'argv': sys.argv[1:]}) + '\\n')
go = os.path.join('${tmp}', 'go-' + lid)
t0 = time.time()
while time.time() - t0 < 60 and not os.path.exists(go): time.sleep(0.02)
try: os.remove(go)
except OSError: pass
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
const sent: Array<{ text: string; silent: boolean }> = []
const open = new Set<string>()
L.lanesInit({ role: 'tg', agent: 'metis', workspaceDir: ws, transcriptDir: join(tmp, 'tr'), httpPort: 0, log: () => {}, authOk: () => true, registryNames: () => ['eve', 'scheduler'],
  notifySession: async (sid: string) => open.has(sid), streamOpen: (sid: string) => open.has(sid), toolsChanged: () => {},
  sendBot: async (_c: string, text: string, o: any) => { sent.push({ text, silent: !!o?.silent }); return 6800 + sent.length }, joeyChatId: () => '1' } as any)
const procs: any[] = []
const boots: string[] = []
afterAll(() => { for (const f of Object.keys(L.__lanesState().lanes)) try { writeFileSync(join(tmp, `go-${f}`), 'ok') } catch {}
  for (const p of procs) try { p.kill('SIGKILL') } catch {}
  schedSrv.close(); L.__setClaudeBin(restore)
  for (const k of ['LANES_FLOOD_CONTROL', 'LANES_RECEIPT_RESTORE']) delete process.env[k]
  for (const d of boots) { Bun.spawnSync(['pkill', '-f', d]); rmSync(d, { recursive: true, force: true }) }
  rmSync(ws, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }) })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const jsonl = (p: string): any[] => { try { return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const runsOf = () => jsonl(ARGV)
const E = () => L.__events(), M = () => L.__main()
const ob = (id: string, kind: string) => (E().get(id)?.obligations ?? []).find((o: any) => o.kind === kind)
const completions = (run: string) => schedCalls.filter(c => c.path === '/lanes/scheduler' && c.action === 'complete' && String(c.run_id) === run)
let n = 0
const mk = (from: string, text: string) => ({ id: `mesh-wo137r-${++n}`, source: 'mesh', from, verified: true, text, meta: {}, notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any)
const sched = (run: number, what: string) => { const e = mk('scheduler', `[scheduled][${what}][run:${run}][P3][routine] ${what}：照例檢查，回報 Joey 一行`); e.meta = { run_id: String(run) }; return e }
type Run = { id: string; lane: string; tok: any }
async function start(ev: any): Promise<Run> {
  const before = runsOf().length
  const d = await L.routeEvent(ev)
  expect(d).toMatchObject({ target: 'lane' })
  expect(await until(() => !!L.__runTok(d.lane!) && L.__runTok(d.lane!)!.evId === ev.id && runsOf().length > before)).toBe(true)
  return { id: ev.id, lane: d.lane!, tok: L.__runTok(d.lane!)! }
}
async function end(r: Run): Promise<void> {
  writeFileSync(join(tmp, `go-${r.lane}`), 'ok')
  expect(await until(() => L.__runTok(r.lane)?.evId !== r.id)).toBe(true)
  await sleep(40)
}
const call = (r: Run, name: string, a: object) => L.callLaneTool(r.tok, name, a)
async function mainUp(): Promise<{ pid: number; hook: (event: string, o?: object) => Promise<any>; kill: () => Promise<void> }> {
  const p = Bun.spawn(['sleep', '600']); procs.push(p)
  const sid = randomUUID(); writeFileSync(join(dir, 'main-expected'), sid); open.add(`mcp-${p.pid}`); L.__noteMcpPid(`mcp-${p.pid}`, p.pid)
  const hook = (event: string, o: object = {}) => L.__mainEvent({ event, pid: p.pid, session_id: sid, ...o } as any)
  await hook('SessionStart', { source: 'startup' })
  return { pid: p.pid, hook, kill: async () => { await hook('SessionEnd'); p.kill('SIGKILL') } }
}
const STEPS = (run: number) => [{ step: '跨艦隊巡檢', done: true }, { step: '回報 Joey 一行', done: true }, { step: `complete ${run}`, done: true }]

// ------------------------------------------------------------------ the pure parts
test('1.41.1, the words of a receipt: outcome in the scheduler\'s words; the scheduler\'s answer (2xx, 409 completed: ok; 422, other 409, errors: not); the CLI\'s output; a mention of btcc-receipt is not a call', () => {
  expect(['done', 'DONE', 'normal', 'ok', '', 'nothing-to-do', 'nothing_to_do', 'failed', '部分完成', 'weird'].map(B.btccOutcome)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'nothing-to-do', 'nothing-to-do', 'failed', 'failed', 'weird'])
  expect(B.schedulerAnswerOk('complete run 6804: HTTP 422')).toEqual({ ok: false })                     // metis 6804's recorded answer
  expect(B.schedulerAnswerOk('complete run 6804: HTTP 200')).toEqual({ ok: true })
  expect(B.schedulerAnswerOk('complete run 6804: HTTP 409 {"detail":"run is completed, not completable"}')).toEqual({ ok: true, already: true })
  expect(B.schedulerAnswerOk('complete run 6804: HTTP 409 {"detail":"run is stalled_no_ack, not completable"}')).toEqual({ ok: false })
  expect(B.schedulerAnswerOk('complete run 6804: HTTP 409')).toEqual({ ok: false })
  expect(B.schedulerAnswerOk('complete run 6804 failed: TimeoutError: The operation timed out.')).toEqual({ ok: false })
  expect(B.schedulerAnswerOk('BTCC_API_BASE not set')).toEqual({ ok: false })
  expect(B.schedulerAnswerOk('{"state":"completed"}')).toEqual({ ok: true })                           // another daemon's or a stand-in's words: as before
  expect(B.receiptCliAnswer('{"ok":true,"state":"completed","outcome":"ok"}\n')).toMatchObject({ ok: true, text: '{"ok":true,"state":"completed","outcome":"ok"}' })
  expect(B.receiptCliAnswer('Exit code 1\nbtcc-receipt: HTTP 409 {"detail":"run is completed, not completable"}')).toMatchObject({ ok: true, already: true })
  expect(B.receiptCliAnswer('btcc-receipt: HTTP 422 {"detail":"bad"}')).toMatchObject({ ok: false })
  expect(B.receiptCliAnswer('btcc-receipt: URLError: <urlopen error timed out>')).toMatchObject({ ok: false })
  const HEREDOC = "cd /Users/btai/cc-workspaces/claude-chiron; python3 - <<'EOF'\nimport re\np='knowledge/lane-boundary-20261124/ANCHOR.md'\ns=open(p,encoding='utf-8').read()\n"
    + "s=s.replace('4.', '4. 再由主線 `~/.claude/tools/btcc-receipt complete 6985 --outcome ok --note …`')\nopen(p,'w',encoding='utf-8').write(s)\nprint('anchor sum', len(s))\nEOF\nsleep 240; date -u +%H:%M:%SZ"
  expect(B.receiptCliRuns(HEREDOC)).toEqual([])                                                        // chiron 13:01:42Z: a mention
  expect(B.receiptCliRuns("cd /Users/btai/cc-workspaces/claude-chiron; date -u +%H:%M:%SZ; ~/.claude/tools/btcc-receipt complete 6985 --outcome ok --note 'WO-132 B 判定已交'")).toEqual(['6985'])   // 13:15:54Z: a call
  for (const c of ['echo "btcc-receipt complete 1"', 'git commit -m "btcc-receipt complete 2"', "cat <<EOF > n.md\nbtcc-receipt complete 3\nEOF", './bin/btcc-receipt ack 4'])
    expect(B.receiptCliRuns(c)).toEqual([])
  for (const [c, r] of [['( a | cut -c1-200); ~/.claude/tools/btcc-receipt complete 6878', '6878'], ['bash -c "btcc-receipt complete 7"', '7'], ['if btcc-receipt complete 8; then echo ok; fi', '8'],
    ['timeout 30 btcc-receipt complete 9 --outcome=ok', '9'], ['X=1 env -i ./bin/btcc-receipt complete 10', '10'], ['python3 ~/.claude/tools/btcc-receipt complete 11', '11']] as const)
    expect(B.receiptCliRuns(c)).toEqual([r])
})

// ------------------------------------------------------------------ Metis #11280: the receipt's `done` and a scheduler that refuses
test('Metis #11280, replay of run 6804: the lane\'s receipt(outcome done) reaches the scheduler as ok and is met on its 200 (11-23: `done` → HTTP 422 recorded met)', async () => {
  const r = await start(sched(6804, 'fleet-sweep'))
  expect(await call(r, 'notify_joey', { outcome: 'normal', text: '跨艦隊巡檢：30 個清單有 open 任務，無異常' })).toContain('held for your receipt')   // WO-129: goes with the receipt
  const out = await call(r, 'receipt', { run_id: '6804', outcome: 'done', steps: STEPS(6804), happened: '跨艦隊巡檢', did: '拉 cc-workboard', promised: '無', needs_main: '無' })
  expect(out).toContain('scheduler: complete run 6804: HTTP 200')
  expect(completions('6804')).toMatchObject([{ outcome: 'ok' }])
  expect(btcc('6805', 'done')).toContain('HTTP 422')                                                   // the stand-in refuses `done` as BTCC did
  expect(ob(r.id, 'receipt')).toMatchObject({ state: 'met', by: 'receipt', ref: 'complete run 6804: HTTP 200' })
  await end(r)
})

test('Metis #11280: a scheduler that refuses the receipt (HTTP 422): the receipt stays owed and the lane is told; filing again calls the scheduler again (not refused as a repeat); the run ends owing it: handed to the main, whose btcc-receipt is let through; its 422 output leaves it owed, a 409 「run is completed」 meets it', async () => {
  refuse.add('6811')
  const m = await mainUp()
  const r = await start(sched(6811, 'heartbeat'))
  await call(r, 'notify_joey', { outcome: 'normal', text: '心跳正常' })
  const out = await call(r, 'receipt', { run_id: '6811', outcome: 'nothing-to-do', steps: STEPS(6811), happened: '心跳', did: '查', promised: '無', needs_main: '無' })
  expect(out).toContain('scheduler run 6811 is NOT completed'); expect(out).toContain('HTTP 422'); expect(out).toContain('The receipt is still owed')
  expect(ob(r.id, 'receipt')).toMatchObject({ state: 'open' }); expect(ob(r.id, 'receipt').failed).toContain('HTTP 422')
  expect(jsonl(join(dir, 'lanes.jsonl')).filter(x => x.kind === 'receipt_refused_by_scheduler' && x.run_id === '6811')).toMatchObject([{ outcome: 'nothing-to-do' }])
  const again = await call(r, 'receipt', { run_id: '6811', outcome: 'nothing-to-do', steps: STEPS(6811), happened: '心跳', did: '查', promised: '無', needs_main: '無' })
  expect(again).not.toContain('already completed'); expect(completions('6811').length).toBe(2)
  await end(r)
  expect(ob(r.id, 'receipt')).toMatchObject({ state: 'handed' })                                       // the exit rule: what the run still owes goes to the main
  refuse.delete('6811')
  const p = `p-${randomUUID().slice(0, 6)}`
  await m.hook('UserPromptSubmit', { prompt_id: p, dids: M().items(x => x.state !== 'done' && x.event === r.id).map(x => x.id) })
  const RC = { prompt_id: p, tool_name: 'Bash', tool_input: { command: '~/.claude/tools/btcc-receipt complete 6811 --outcome nothing-to-do' } }
  expect((await m.hook('PreToolUse', RC)).deny).toBeUndefined()
  await m.hook('PostToolUse', { ...RC, tool_response: 'btcc-receipt: HTTP 422 {"detail":"test"}', tool_error: false })
  await sleep(30)
  expect(ob(r.id, 'receipt')).toMatchObject({ state: 'handed' }); expect(ob(r.id, 'receipt').failed).toContain('HTTP 422')
  completed.add('6811')                                                                                 // someone completed it meanwhile
  expect((await m.hook('PreToolUse', RC)).deny).toBeUndefined()
  await m.hook('PostToolUse', { ...RC, tool_response: 'btcc-receipt: HTTP 409 {"detail":"run is completed, not completable"}', tool_error: false })
  await sleep(30)
  expect(ob(r.id, 'receipt')).toMatchObject({ state: 'met', by: 'main (btcc-receipt)' })
  L.mainReplied(L.mainReplyTier({}), 6890)
  await m.hook('Stop', { prompt_id: p, phase: 'final' })
  await m.kill()
}, 30000)

// ------------------------------------------------------------------ Chiron #11236: a mention is not a call
test('Chiron #11236, replay of run 6985: the receipt handed to the main; its heredoc that mentions 「btcc-receipt complete 6985」 meets nothing (11-24 13:05:42Z: met); its real call is let through and meets it on BTCC\'s answer; a mention is not refused by the gate either', async () => {
  const m = await mainUp()
  const r = await start(sched(6985, 'boundary-check'))
  expect(await call(r, 'handoff_main', { text: 'WO-132 B 判定要主線做：改 ANCHOR、判定後回執 6985' })).toContain('handed to the main')
  expect(ob(r.id, 'receipt')).toMatchObject({ state: 'handed' })
  await end(r)
  const p = `p-${randomUUID().slice(0, 6)}`
  await m.hook('UserPromptSubmit', { prompt_id: p, dids: M().items(x => x.state !== 'done' && x.event === r.id).map(x => x.id) })
  const HEREDOC = "cd /Users/btai/cc-workspaces/claude-chiron; python3 - <<'EOF'\nimport re\np='knowledge/lane-boundary-20261124/ANCHOR.md'\ns=open(p,encoding='utf-8').read()\n"
    + "s=s.replace('4.', '4. 判定後再由主線 `~/.claude/tools/btcc-receipt complete 6985 --outcome ok --note …`')\nopen(p,'w',encoding='utf-8').write(s)\nprint('anchor sum', len(s))\nEOF\nsleep 240; date -u +%H:%M:%SZ"
  const H = { prompt_id: p, tool_name: 'Bash', tool_input: { command: HEREDOC } }
  expect((await m.hook('PreToolUse', H)).deny).toBeUndefined()
  await m.hook('PostToolUse', { ...H, tool_response: 'anchor sum 4667\n13:05:42Z\n- Joey 對 `#prod`…', tool_error: false })
  await sleep(30)
  expect(ob(r.id, 'receipt')).toMatchObject({ state: 'handed' })                                       // not met by a mention
  const REAL = { prompt_id: p, tool_name: 'Bash', tool_input: { command: "cd /Users/btai/cc-workspaces/claude-chiron; date -u +%H:%M:%SZ; ~/.claude/tools/btcc-receipt complete 6985 --outcome ok --note 'WO-132 B 判定已交'" } }
  expect((await m.hook('PreToolUse', REAL)).deny).toBeUndefined()                                     // 11-24 13:15:54Z: refused 「已經回執過了」
  await m.hook('PostToolUse', { ...REAL, tool_response: '13:15:54Z\n{"ok":true,"state":"completed","outcome":"ok"}', tool_error: false })
  await sleep(30)
  expect(ob(r.id, 'receipt')).toMatchObject({ state: 'met', by: 'main (btcc-receipt)', ref: '{"ok":true,"state":"completed","outcome":"ok"}' })
  expect((await m.hook('PreToolUse', REAL)).deny).toContain('已經回執過了')                             // a second completion: refused, as before
  L.mainReplied(L.mainReplyTier({}), 6990)
  await m.hook('Stop', { prompt_id: p, phase: 'final' })
  // a run a lane holds: a command that only mentions it is not refused (the gate reads the same words)
  const q = await start(sched(6986, 'notes'))
  const p2 = `p-${randomUUID().slice(0, 6)}`
  await m.hook('UserPromptSubmit', { prompt_id: p2 })
  expect((await m.hook('PreToolUse', { prompt_id: p2, tool_name: 'Bash', tool_input: { command: 'echo "記得 btcc-receipt complete 6986" >> notes.md' } })).deny).toBeUndefined()
  expect((await m.hook('PreToolUse', { prompt_id: p2, tool_name: 'Bash', tool_input: { command: '~/.claude/tools/btcc-receipt complete 6986' } })).deny).toContain('在處理')
  await m.hook('Stop', { prompt_id: p2, phase: 'final' })
  await call(q, 'notify_joey', { outcome: 'normal', text: 'ok' }); await call(q, 'receipt', { run_id: '6986', outcome: 'done', steps: STEPS(6986), happened: 'x', did: 'x', promised: '無', needs_main: '無' }); await end(q)
  await m.kill()
}, 30000)

// ------------------------------------------------------------------ the boot pass: a receipt recorded met on a refusal is owed again
test('1.41.1 boot: a receipt a lane recorded met on a refusal (metis 6804 「complete run 6804: HTTP 422」) is owed again, handed to the main (no item, no wake, no push), its stall-nudge\'s 「already completed by …」 merged into it; met on a 200, or by the main\'s own btcc-receipt: untouched; the digest says so; the main\'s btcc-receipt goes through; LANES_RECEIPT_RESTORE=0: untouched', async () => {
  const boot = (restore: boolean) => {
    const d2 = mkdtempSync(join(tmpdir(), 'lanes-wo137r-boot-')); boots.push(d2)
    copyFileSync(process.env.LANES_TEST_ROUTER!, join(d2, 'router.json'))
    mkdirSync(join(d2, 'lanes'), { recursive: true })
    const ev = (id: string, run: string, ob: object, text: string) => JSON.stringify({ ts: '2026-11-23T02:43:53.793Z', rec: 'event', id, state: 'closed', class: 'scheduled', owner: 'metis.reflex.1', outcome: 'normal',
      thread: 'metis#t-0cbb4b', lane: 'metis.reflex.1', from: 'scheduler', text, obligations: [{ id: `joey-${id}`, kind: 'joey', level: 'line', state: 'met', by: 'notify_joey' }, { kind: 'receipt', level: 'run', run_id: run, ...ob }] })
    writeFileSync(join(d2, 'lanes', 'state.jsonl'), [
      ev('mesh-1795401818723-58ec', '6804', { id: 'receipt-mwsnvxio-4', state: 'met', by: 'receipt', ref: 'complete run 6804: HTTP 422', met_at: '2026-11-23T02:43:53.793Z' }, '[scheduled][fleet-sweep][run:6804] 跨艦隊巡檢'),
      ev('mesh-1795405424787-fcfd', '6804', { id: 'receipt-nudge', state: 'met', by: 'already completed by mesh-1795401818723-58ec' }, '[scheduled][fleet-sweep][run:6804] stall-nudge'),
      ev('mesh-ok-6900', '6900', { id: 'receipt-ok', state: 'met', by: 'receipt', ref: 'complete run 6900: HTTP 200' }, '[scheduled][x][run:6900]'),
      ev('mesh-main-6985', '6985', { id: 'receipt-main', state: 'met', by: 'main (btcc-receipt)', ref: 'anchor sum 4667' }, '[scheduled][y][run:6985]'),
    ].join('\n') + '\n')
    if (!restore) process.env.LANES_RECEIPT_RESTORE = '0'
    process.env.LANES_DIR = d2
    return { d2, init: async () => {
      const R = await import(`./lanes.ts?wo137-boot-${restore ? 'on' : 'off'}`) as typeof import('./lanes.ts')
      R.lanesInit({ role: 'tg', agent: 'metis', workspaceDir: d2, transcriptDir: d2, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => [] } as any)
      process.env.LANES_DIR = dir; delete process.env.LANES_RECEIPT_RESTORE
      return R
    } }
  }
  const on = boot(true), R = await on.init()
  const rob = (id: string) => (R.__events().get(id)!.obligations as any[]).find(o => o.kind === 'receipt')
  expect(rob('mesh-1795401818723-58ec')).toMatchObject({ state: 'handed', failed: 'complete run 6804: HTTP 422' })
  expect(rob('mesh-1795401818723-58ec').restored).toBeTruthy()
  expect(R.__events().get('mesh-1795401818723-58ec')!.state).toBe('open')
  expect(rob('mesh-1795405424787-fcfd')).toMatchObject({ state: 'merged', into: 'mesh-1795401818723-58ec' })
  expect(rob('mesh-ok-6900')).toMatchObject({ state: 'met', ref: 'complete run 6900: HTTP 200' })
  expect(rob('mesh-main-6985')).toMatchObject({ state: 'met', by: 'main (btcc-receipt)' })
  expect(jsonl(join(on.d2, 'lanes.jsonl')).filter(x => x.kind === 'receipt_restored')).toMatchObject([{ run_id: '6804', event: 'mesh-1795401818723-58ec', answer: 'complete run 6804: HTTP 422', merged: ['mesh-1795405424787-fcfd'] }])
  expect(jsonl(join(on.d2, 'ledger.jsonl')).find(x => x.refs?.restored)!.text).toContain('排程 run 6804 的回執先前記成已送，但排程器沒收下（「complete run 6804: HTTP 422」）')
  expect(R.__main().items(r => r.kind !== 'digest')).toEqual([])                                     // nobody woken
  expect(R.__digest()!.text).toContain('run 6804 的回執交給主線（排程器沒收下：complete run 6804: HTTP 422）')
  expect(R.mainToolGate('Bash', { command: '~/.claude/tools/btcc-receipt complete 6804 --outcome ok' })).toBeNull()   // 11-23 14:45Z: refused
  expect(R.mainToolGate('Bash', { command: '~/.claude/tools/btcc-receipt complete 6900' })).toContain('已經回執過了')
  // a second boot on the same journal restores nothing more
  const before = jsonl(join(on.d2, 'lanes.jsonl')).filter(x => x.kind === 'receipt_restored').length
  process.env.LANES_DIR = on.d2
  const R2 = await import('./lanes.ts?wo137-boot-again') as typeof import('./lanes.ts')
  R2.lanesInit({ role: 'tg', agent: 'metis', workspaceDir: on.d2, transcriptDir: on.d2, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => [] } as any)
  process.env.LANES_DIR = dir
  expect(jsonl(join(on.d2, 'lanes.jsonl')).filter(x => x.kind === 'receipt_restored').length).toBe(before)
  const off = boot(false), R0 = await off.init()
  expect((R0.__events().get('mesh-1795401818723-58ec')!.obligations as any[]).find(o => o.kind === 'receipt')).toMatchObject({ state: 'met', ref: 'complete run 6804: HTTP 422' })
  expect(jsonl(join(off.d2, 'lanes.jsonl')).filter(x => x.kind === 'receipt_restored')).toEqual([])
}, 30000)

// ------------------------------------------------------------------ the agent-inbox daemon's /lanes/scheduler
test('1.41.1, the agent-inbox daemon\'s /lanes/scheduler: an older tg daemon\'s `done` goes to the scheduler as ok; the answer carries ok (false on a refusal)', async () => {
  const calls: any[] = []
  const I = await import('./lanes.ts?wo137-inbox') as typeof import('./lanes.ts')
  I.lanesInit({ role: 'inbox', agent: 'metis', workspaceDir: ws, transcriptDir: join(tmp, 'tr'), httpPort: 0, log: () => {}, authOk: () => true,
    schedulerCall: async (run: string, action: string, outcome?: string) => { calls.push({ run, action, outcome }); return action === 'complete' ? btcc(run, String(outcome)) : `${action} run ${run}: HTTP 200` } } as any)
  const srv = createServer(async (req, res) => { if (!(await I.handleLanesHttp(new URL(req.url ?? '/', 'http://127.0.0.1'), req, res))) res.writeHead(404).end() })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  const post = async (b: object) => (await fetch(`http://127.0.0.1:${(srv.address() as any).port}/lanes/scheduler`, { method: 'POST', body: JSON.stringify(b), headers: { Authorization: 'Bearer x' } })).json()
  try {
    expect(await post({ run_id: '6821', action: 'complete', outcome: 'done' })).toEqual({ text: 'complete run 6821: HTTP 200', ok: true })
    expect(calls.at(-1)).toEqual({ run: '6821', action: 'complete', outcome: 'ok' })
    expect(await post({ run_id: '6821', action: 'complete', outcome: 'ok' })).toEqual({ text: 'complete run 6821: HTTP 409 {"detail":"run is completed, not completable"}', ok: true })
    refuse.add('6822')
    expect(await post({ run_id: '6822', action: 'complete', outcome: 'failed' })).toMatchObject({ ok: false })
    expect(await post({ run_id: '6823', action: 'ack' })).toEqual({ text: 'ack run 6823: HTTP 200', ok: true })
    expect(calls.at(-1)).toEqual({ run: '6823', action: 'ack', outcome: undefined })
  } finally { srv.close(); refuse.delete('6822') }
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  expect(src).toContain("{ outcome: outcome ?? 'ok', ...(summary ? { summary } : {}) }")
  expect(src).toContain("return `${action} run ${runId}: HTTP ${r.status}${r.ok ? '' : ` ${(await r.text().catch(() => '')).replace(/\\s+/g, ' ').slice(0, 200)}`}`")
})
