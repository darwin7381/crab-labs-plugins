// WO-125 (telegram-http 1.37.0): the lanes' boundary, first step. A: the boundary card in every run's 〔車道資訊〕 block (default, or its 判例 from the main's
// .lanes/boundary.md; a long card is named once in the main's digest). B: what the guard refused in a run is a system fact: the run's notify_joey / ask_joey,
// its receipt and its digest line carry 「〔系統〕這一趟 N 次寫入或指令被擋：…」, and its scheduled receipt is not completed as a success. C: the receipt's
// steps, done or not; a step not done is not filed as a success. Each part has its switch (LANES_BOUNDARY_CARD, LANES_BLOCK_FACTS, LANES_RECEIPT_STEPS;
// `0` = 1.36.2's behaviour). The tests are named after the ticket's acceptance list (怎樣算完成 1-9).
// The lane process is a stand-in that records its argv and the lane env it got, prints the stream-json lines the test hands it (a tool call and its
// result) and ends when told. The guard hook runs as a real process with that env against the daemon's routes (/lane-blocked, /lane-receipt) on a port;
// the scheduler is a stand-in that counts completions. The five 11-23 runs that reported a refused write as done (Chiron's evidence-runs.md, 乙-1…乙-5)
// are replayed with their literal commands, the workspace path put in for theirs.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync, renameSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer } from 'http'
process.env.LANES_FLOOD_CONTROL = '0'
const schedCalls: any[] = []
const schedSrv = createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { schedCalls.push({ path: req.url, ...JSON.parse(b || '{}') }); res.end(JSON.stringify({ text: '{"state":"completed"}' })) }) })
await new Promise<void>(r => schedSrv.listen(0, '127.0.0.1', () => r()))
process.env.LANES_INBOX_PORT = String((schedSrv.address() as any).port)
const L = await import('./lanes.ts?wo125') as typeof import('./lanes.ts')
delete process.env.LANES_INBOX_PORT
const B = await import('./lanes-boundary.ts')
const { mainContext } = await import('./lanes-main.ts')

const ws = mkdtempSync(join(tmpdir(), 'lanes-wo125-ws-'))                  // the agent's workspace; its .lanes/ is the lanes dir
const dir = join(ws, '.lanes'); mkdirSync(dir)
const tmp = mkdtempSync(join(tmpdir(), 'lanes-wo125-'))                    // the stand-in's files and the transcripts, outside the workspace
mkdirSync(join(tmp, 'tr'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
const GO = join(tmp, 'go'), ARGV = join(tmp, 'argv.jsonl'), bin = join(tmp, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, sys, time
keys = ['LANES_BLOCK_FACTS', 'LANE_KIND', 'LANE_ID', 'LANES_DIR', 'LANES_WORKSPACE', 'LANES_MEMORY_DIR', 'LANE_RUN_TOKEN']
with open('${ARGV}', 'a') as f: f.write(json.dumps({'argv': sys.argv[1:], 'env': {k: os.environ[k] for k in keys if k in os.environ}}) + '\\n')
t0 = time.time()
end = False
while time.time() - t0 < 60 and not end:
    if os.path.exists('${GO}'):
        body = open('${GO}').read(); os.remove('${GO}')
        for line in body.split('\\n'):
            if line.startswith('EMIT '): print(line[5:], flush=True)
            elif line.strip() == 'END': end = True
    time.sleep(0.02)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
L.__setMailTool(async () => ({ text: '0 封未讀', isError: false }))
const sent: Array<{ text: string; silent: boolean }> = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: ws, transcriptDir: join(tmp, 'tr'), httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async (_c: string, text: string, o: any) => { sent.push({ text, silent: !!o?.silent }); return 9000 + sent.length }, joeyChatId: () => '1' } as any)
const laneSrv = createServer(async (req, res) => { if (!(await L.handleLanesHttp(new URL(req.url ?? '/', 'http://127.0.0.1'), req, res))) res.writeHead(404).end() })
await new Promise<void>(r => laneSrv.listen(0, '127.0.0.1', () => r()))
const SWITCHES = ['LANES_BOUNDARY_CARD', 'LANES_BLOCK_FACTS', 'LANES_RECEIPT_STEPS']
afterAll(() => { try { writeFileSync(GO, 'END') } catch {}; schedSrv.close(); laneSrv.close(); L.__setClaudeBin(restore); L.__setMailTool(null)
  delete process.env.LANES_FLOOD_CONTROL; for (const k of SWITCHES) delete process.env[k]; rmSync(ws, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }) })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const jsonl = (p: string): any[] => { try { return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const ledger = () => jsonl(join(dir, 'ledger.jsonl'))
const laneRows = () => jsonl(join(dir, 'lanes.jsonl'))
const runsOf = () => jsonl(ARGV)
const E = () => L.__events()
const completions = (run: string) => schedCalls.filter(c => c.path === '/lanes/scheduler' && c.action === 'complete' && c.run_id === run)
let n = 0
const mk = (from: string, text: string, extra: object = {}) => ({ id: `mesh-wo125-${++n}`, source: 'mesh', from, verified: true, text, meta: {}, notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } }, ...extra } as any)
const sched = (run: number, what: string) => { const e = mk('scheduler', `[scheduled][${what}][run:${run}][P3][routine] ${what}：照例檢查`); e.meta = { run_id: String(run) }; return e }
const reminder = () => { const text = '讀信箱（1 封未讀，最舊的等了 70 分鐘）：先用 mailbox_list'
  return mk('fleet-watchdog', text, { meta: { no_reply: 'true' }, no_reply: true, wake: 'mail', line: 'mail' }) }
type Run = { id: string; lane: string; tok: any; argv: string[]; prompt: string; env: Record<string, string> }
/** route an event and wait until its lane run is in progress: its token, its argv (the prompt follows -p) and the lane env it got */
async function start(ev: any): Promise<Run> {
  const before = runsOf().length
  const d = await L.routeEvent(ev)
  expect(d).toMatchObject({ target: 'lane' })
  expect(await until(() => !!L.__runTok(d.lane!) && runsOf().length > before)).toBe(true)
  const r = runsOf()[before]
  return { id: ev.id, lane: d.lane!, tok: L.__runTok(d.lane!)!, argv: r.argv, prompt: r.argv[r.argv.indexOf('-p') + 1], env: r.env }
}
async function say(body: string): Promise<void> {
  expect(await until(() => !existsSync(GO))).toBe(true)
  writeFileSync(GO + '.tmp', body); renameSync(GO + '.tmp', GO)
  expect(await until(() => !existsSync(GO))).toBe(true)
}
let tu = 0
/** the lane's stream: a tool call and its result (ok = not an error) */
const step = (name: string, input: object, result = 'ok', ok = true): string => { const id = `tu-wo125-${++tu}`
  return [`EMIT ${JSON.stringify({ type: 'assistant', message: { id: `m-${id}`, usage: {}, content: [{ type: 'tool_use', id, name, input }] } })}`,
    `EMIT ${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: result, ...(ok ? {} : { is_error: true }) }] } })}`].join('\n') }
async function end(r: Run): Promise<any> {
  await say('END')
  expect(await until(() => !L.__runTok(r.lane))).toBe(true)
  await sleep(40)
  return laneRows().filter(x => x.kind === 'exit' && x.event === r.id).at(-1)
}
/** the guard hook, as the lane's claude runs it: the env the lane got (laneEnv), the daemon's port */
async function hook(r: Run, tool: string, input: object, cwd = ws): Promise<{ deny: string | null; raw: string }> {
  const p = Bun.spawn(['python3', join(import.meta.dir, 'lanes-hooks', 'lane-guard-hook.py')], { stdin: 'pipe', stdout: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...r.env, LANES_HTTP_PORT: String((laneSrv.address() as any).port) } })
  p.stdin.write(JSON.stringify({ tool_name: tool, tool_input: input, cwd })); p.stdin.end()
  const raw = await new Response(p.stdout).text(); await p.exited
  return { deny: raw.trim() ? JSON.parse(raw).hookSpecificOutput.permissionDecisionReason : null, raw }
}
const bash = (r: Run, command: string, cwd = ws) => hook(r, 'Bash', { command }, cwd)
const call = (r: Run, name: string, a: object) => L.callLaneTool(r.tok, name, a)
const line = (k: number, ...targets: string[]) => B.blockedLine({ n: k, targets })
/** 1.39.0 (WO-129): the tests of B (what the guard refused) use the 1.38 receipt paths (a receipt without steps, btcc-receipt through the router): they run with
 *  LANES_RECEIPT_STEPS=0, which leaves B as it is; C (the steps) runs with it on, and lanes-wo129 tests the new receipt path */
const stepsOff = async (f: () => Promise<void>): Promise<void> => { process.env.LANES_RECEIPT_STEPS = '0'; try { await f() } finally { delete process.env.LANES_RECEIPT_STEPS } }
const DEFAULT_HEAD = '# 邊界卡（adam 的；主線寫的，你只能讀）'
const count = (s: string, sub: string) => s.split(sub).length - 1
/** a routine run that closes cleanly: its line and its receipt */
const quiet = async (r: Run, run: number) => { await call(r, 'notify_joey', { outcome: 'normal', text: `run ${run} 正常` }); await call(r, 'receipt', { outcome: 'nothing-to-do', run_id: String(run) }) }
const digestDone = (d: any) => L.__journal().write('msg', `dg-wo125-${Date.now()}-${Math.random()}`, 'done', { kind: 'digest', events: d.fields.events, ...(d.fields.boundary_card ? { boundary_card: d.fields.boundary_card } : {}) })

// ------------------------------------------------------------------ A: the boundary card
test('WO-125 #1: an agent with no boundary.md: a new lane session and a resumed one both get the default card in every run, inside 〔車道資訊〕', async () => {
  const a = await start(reminder())
  expect(a.argv).toContain('--session-id')
  for (const l of B.boundaryDefault('adam')) expect(a.prompt).toContain(l)
  expect(count(a.prompt, DEFAULT_HEAD)).toBe(1)
  expect(a.prompt).toContain('判例（主線留的，新的在上面；跟上面衝突時照判例）：\n- （還沒有）')
  expect(a.prompt.indexOf(DEFAULT_HEAD)).toBeGreaterThan(a.prompt.indexOf('# 焦點卡（主線寫的，你只能讀）'))      // after the focus card
  expect(a.prompt.indexOf(DEFAULT_HEAD)).toBeLessThan(a.prompt.indexOf('〔車道資訊結束；下面是事件〕'))           // inside the system-written block
  const sys = readFileSync(a.argv[a.argv.indexOf('--append-system-prompt-file') + 1], 'utf8')
  expect(sys).not.toContain(DEFAULT_HEAD); expect(sys).not.toContain('三樣都不需要')                            // the run prompt, not the replayed system prompt (WO-132: the lane card's critical line names the card)
  expect(L.__lanesState().lanes[a.lane].card_hash).toBe(L.cardHash('mail'))                                   // not part of the lane card's hash (1.36.2)
  expect(await end(a)).toMatchObject({ boundary_lines: 12, boundary_source: 'default' })                       // WO-132 (1.40.0): one line more; WO-144 (1.46.0): one more
  const b = await start(reminder())
  expect(b.lane).toBe(a.lane); expect(b.argv).toContain('--resume')
  expect(count(b.prompt, DEFAULT_HEAD)).toBe(1); expect(b.prompt).toContain('- （還沒有）')
  expect(b.prompt).not.toContain(L.CARD_UPDATED_HEAD)                                                         // the boundary card does not resend the lane card
  await end(b)
}, 30000)

test('WO-125 #2: the main edits boundary.md: the next run of a resumed lane session has the new content; the default part and the 判例 heading stay', async () => {
  writeFileSync(join(dir, 'boundary.md'), '\n- 讀者低於標準線就是異常，交給我\n- 純知會的信勾掉就好\n\n')
  const c = await start(reminder())
  expect(c.argv).toContain('--resume')
  expect(c.prompt).toContain('判例（主線留的，新的在上面；跟上面衝突時照判例）：\n- 讀者低於標準線就是異常，交給我\n- 純知會的信勾掉就好\n')
  expect(c.prompt).not.toContain('- （還沒有）')
  for (const l of B.boundaryDefault('adam').slice(0, -1)) expect(c.prompt).toContain(l)                       // the three questions and the report sentences
  expect(await end(c)).toMatchObject({ boundary_lines: 13, boundary_source: 'file' })
  rmSync(join(dir, 'boundary.md'))
  const d = await start(reminder())
  expect(d.prompt).toContain('- （還沒有）'); expect(d.prompt).not.toContain('讀者低於標準線')
  await end(d)
}, 30000)

test('WO-125 #3: a card over 40 lines: every line is sent; the main\'s digest says 「邊界卡現在 N 行，整理一下」 once per content of boundary.md', async () => {
  const lines = Array.from({ length: 45 }, (_, i) => `- 判例 ${i + 1}：第 ${i + 1} 條（${'字'.repeat(i)}）`)
  writeFileSync(join(dir, 'boundary.md'), lines.join('\n') + '\n')
  const r = await start(sched(7201, 'backup-check'))
  for (const l of lines) expect(r.prompt).toContain(l)
  expect(r.prompt).toContain(`判例（主線留的，新的在上面；跟上面衝突時照判例）：\n${lines.join('\n')}\n`)   // whole, in order, nothing cut
  await quiet(r, 7201)
  expect(await end(r)).toMatchObject({ boundary_lines: 56, boundary_source: 'file' })
  const d1 = L.__digest()!
  expect(count(d1.text, '邊界卡現在 56 行，整理一下')).toBe(1)
  expect(L.__digest()!.text).toContain('邊界卡現在 56 行')                                                      // not yet at the main: still carried
  digestDone(d1)
  const r2 = await start(sched(7202, 'backup-check')); await quiet(r2, 7202); await end(r2)                   // the same content, another run
  const d2 = L.__digest()!
  expect(d2.text).not.toContain('邊界卡現在'); digestDone(d2)
  writeFileSync(join(dir, 'boundary.md'), [...lines, '- 判例 46'].join('\n'))                                   // new content: named again, once
  const r3 = await start(sched(7203, 'backup-check')); await quiet(r3, 7203); await end(r3)
  const d3 = L.__digest()!
  expect(d3.text).toContain('邊界卡現在 57 行，整理一下'); digestDone(d3)
  const r4 = await start(sched(7204, 'backup-check')); await quiet(r4, 7204); await end(r4)
  expect(L.__digest()?.text ?? '').not.toContain('邊界卡現在')
  rmSync(join(dir, 'boundary.md'))
}, 60000)

test('WO-125 #5 (A.5): the main\'s rules carry the boundary card\'s sentence right after the focus card\'s', () => {
  const ctx = mainContext('adam', 'sid').split('\n')
  const i = ctx.findIndex(l => l.startsWith('- 維護焦點卡 .lanes/focus.md'))
  expect(ctx[i + 1]).toBe(B.BOUNDARY_MAIN_RULE)
  expect(B.BOUNDARY_MAIN_RULE).toBe('- 邊界卡 .lanes/boundary.md：分身每一趟都讀。它交回來的事你覺得它自己做得完，或它自己做完的事你覺得該先問你，就在卡的「判例」加一行（例：「讀者低於標準線就是異常，交給我」「純知會的信勾掉就好」），新的寫在上面。沒寫這個檔的時候分身用內建的預設。焦點卡照舊只寫你現在在做什麼。')
})

// ------------------------------------------------------------------ B: what the guard refused, as system facts
// The five runs of 11-23 that told Joey and the main a refused write had been made (evidence-runs.md 乙-1…乙-5), with their own commands and calls.
const REPLAYS = [
  { name: 'cadmus.reflex.3 (run 6818)', run: 6818, what: 'cadmus-eng-heartbeat', target: 'state/eng-log.md',
    first: `echo "- 2026-11-23 13:37 TW run:6818 全 ✓（origin 5xx 4、redis 11.2G/12G 逐出+0、副本 lag 1s/0s、備份新鮮）；僅已知 ⚠️ worker 批次16分/編輯最慢2.75s（基準內）" >> state/eng-log.md; ~/.claude/tools/btcc-receipt complete 6818 --outcome ok --note '全 ✓ 無 🔴；已知 ⚠️ 基準內'`,
    notify: { text: '工程心跳 13:37：全 ✓ 無 🔴（5xx 4／4.3h、redis 11.2G/12G 無逐出、副本 lag 1s/0s、備份新鮮）。僅已知 ⚠️ worker 批次 16 分、編輯最慢 2.75s（基準內）。', outcome: 'normal' },
    second: `echo "- 2026-11-23 13:37 TW run:6818 全 ✓（5xx 4、redis 11.2G/12G 逐出+0、副本 lag 1s/0s、備份新鮮）；僅已知 ⚠️ worker批次16分（基準內）" >> state/eng-log.md`,
    receipt: { outcome: 'done', run_id: '6818', happened: '工程心跳 run 6818 跑完，全 ✓ 無 🔴，只有已知 ⚠️（worker 批次 16 分、編輯最慢 2.75s，都在基準內）', did: 'ack 6818；跑 eng_check.py；append state/eng-log.md；notify_joey normal（msg 2609）；run 已由路由完成', promised: '無', needs_main: '無' } },
  { name: 'cadmus.reflex.5 (run 6863)', run: 6863, what: 'cadmus-eng-heartbeat', target: 'state/eng-log.md',
    first: `echo "- 2026-11-23 21:37 TW 心跳 run 6863：全 ✓（origin 5xx 4、redis 11.21G/12G、備份/副本鏈正常）" >> state/eng-log.md && ~/.claude/tools/btcc-receipt complete 6863 --outcome ok --note '全 ✓，無異常'`,
    notify: { text: '工程心跳 21:37：全 ✓（origin 5xx 4、redis 11.21G/12G 無逐出、副本鏈 lag 0、備份新鮮、bt-api 正常）。', outcome: 'normal', service: 'eng-heartbeat', check: 'heartbeat' },
    second: `echo "- 2026-11-23 21:37 TW 心跳 run 6863：全 ✓（origin 5xx 4、redis 11.21G/12G、備份/副本鏈正常）" >> state/eng-log.md`,
    receipt: { outcome: 'done', run_id: '6863', happened: '工程心跳 21:37 TW 全 ✓，僅 worker 批次 7 分為已知基準 ⚠️', did: '跑 eng_check.py、append state/eng-log.md；run 6863 已由路由完成；notify_joey 因同件事已有 normal 通知被擋', promised: '無', needs_main: '無' } },
  { name: 'elsa.reflex.1 (run 6843)', run: 6843, what: 'inbox-watch', target: 'data/login-habits.md',
    first: `cd ${ws} && echo "- 11-23 05:43Z ether.fi（cryptoxlab 信箱）新登入通知，單封、無改密碼/轉出跡象，記錄觀察（與 etherfi 取得交易紀錄待辦相符）" >> data/login-habits.md; python3 scripts/cf_access_watch.py --ack 2>&1 | tail -2; ~/.claude/tools/btcc-receipt complete 6843 --outcome ok --note '31封，1封ether.fi新登入通知已記錄，無需處理'`,
    notify: { text: '信箱巡邏 18:05：31 封新信，沒有要你處理的。（1 封 ether.fi 新登入通知，單次無異常，已記到登入習性；CF Access 無可疑登入。）', outcome: 'normal' },
    second: `cd ${ws} && echo "- 11-23 05:43Z ether.fi（cryptoxlab 信箱）新登入通知，單封、無改密碼/轉出跡象，記錄觀察" >> data/login-habits.md; python3 scripts/cf_access_watch.py --ack 2>&1 | tail -2`,
    receipt: { outcome: 'done', happened: '信箱巡邏 run 6843：31 封，Jev 標 1 封（ether.fi 新登入通知，11-23 05:43Z）；CF Access 無可疑。', did: '記一行到 data/login-habits.md、cf_access_watch --ack；TG 一句話給 Joey（msg 4220）；排程 run 已完成。', promised: '無', needs_main: '無' } },
  { name: 'pheme.reflex.1 (run 6815)', run: 6815, what: 'pheme-heartbeat', target: 'state/situation.md',
    first: `cd ${ws}; echo "- 11-23 13:08 TW [hb 6815] 在線 836／基準 979（0.85x），週日 17:38 後新文 15 篇（13:06 最新、09:31 起每小時有稿），發稿已恢復；11:04、12:34 兩筆 realert 屬 08:02 episode 追蹤，已處置＝流量回到 0.85x、開工清單 08:03 已發。radar／seo-nightly 正常、delivery 無失敗；轉址 7 條仍等 Joey（TG 2645）。ledger 261123-0803 待 11:00 對帳項照追。" >> state/situation.md; ~/.claude/tools/btcc-receipt complete 6815 --outcome ok --note '13:07 在線836/979(0.85x)、新文15篇、發稿恢復、2筆realert已留痕處置'`,
    notify: { text: '值班 13:07：在線 836／基準 979（0.85x），新文 15 篇、發稿已恢復；兩筆 realert 已對帳留痕；SEO 夜檢 739 項全過，轉址 7 條仍等你（TG 2645）。', outcome: 'normal' },
    second: `cd ${ws}; echo "- 11-23 13:08 TW [hb 6815] 在線 836／基準 979（0.85x），週日 17:38 後新文 15 篇（13:06 最新），發稿已恢復；11:04、12:34 兩筆 realert 屬 08:02 episode 追蹤，已處置（流量 0.85x、開工清單 08:03 已發）。radar／seo-nightly 正常、delivery 無失敗；轉址 7 條仍等 Joey（TG 2645）。" >> state/situation.md; tail -1 state/situation.md | cut -c1-40`,
    receipt: { outcome: 'done', run_id: '6815', happened: '13:07 心跳：在線 836／基準 979（0.85x），新文 15 篇，發稿恢復；2 筆 realert（11:04、12:34）待對帳。', did: '跑 situation_check、寫 situation.md 值班行（13:08）、notify_joey（msg 2669, normal）；btcc-receipt complete 6815 已完成。', promised: '無', needs_main: '無（轉址 7 條仍等 Joey TG 2645；ledger 261123-0803 照追）' } },
  { name: 'metis.reflex.3 (run 6870)', run: 6870, what: 'metis-fleet-sweep', target: 'state/board-baseline.json',
    first: `cd ${ws}; cp /tmp/board_new.json state/board-baseline.json; cp /tmp/board_new.json state/snapshots/board-20261123T0244Z.json\ncat >> knowledge/mission-registry.md <<'EOF'\n\n### 巡檢 run 6870（2026-11-23 10:43）— 安靜；板面大量完成、mnemosyne#6 結案消失\n- **BVI 年費**：atlas#33 仍無付款證明。Rosie 要求不提醒、Joey 已知，不戳。\nEOF\n~/.claude/tools/btcc-receipt complete 6870 --outcome ok --note '板1302→1360/open 426，零真遺失（9列皆改名/完成，mnemosyne#6 建置結案）；xboard ssh 解析失敗未取窗口；BVI watch 不戳；無需推動'`,
    notify: { text: '巡檢 run 6870：安靜，板 1360／open 426，無遺失、無需推動（Pyth Pro 試用 12-04 到期、$2,500/月起，Nestor 在帶數字給你）。', outcome: 'normal' },
    second: `cd ${ws}; cp /tmp/board_new.json state/board-baseline.json; cp /tmp/board_new.json state/snapshots/board-20261123T0244Z.json\ncat >> knowledge/mission-registry.md <<'EOF'\n\n### 巡檢 run 6870（2026-11-23 10:43）— 安靜；mnemosyne#6 結案消失\n- **BVI 年費**：atlas#33 仍無證明，不戳。\nEOF`,
    receipt: { outcome: 'done', run_id: '6870', happened: 'run 6870 巡檢：板 1302→1360／open 426，消失 9 列皆改名或完成。', did: 'complete 6870 已成功（HTTP 200）；基線與快照已更新、registry 已追加；notify_joey normal 一行。未做：ssh xboard 窗口（主機名無法解析）、1.json 的 status_note 未更新。', promised: '無', needs_main: '下輪確認 xboard ssh 別名是否壞掉；補更新 1.json status_note。' },
    handoff: 'run 6870 巡檢已 complete、Joey 已收一行。反射線不能寫工作區，請主線補：①cp /tmp/board_new.json 成 state/board-baseline.json ②在 knowledge/mission-registry.md 追加「巡檢 run 6870」' },
]

for (const rp of REPLAYS) test(`WO-125 #4: replay ${rp.name}: Joey's line and the receipt carry 〔系統〕; the scheduled run is not completed as done / ok`, () => stepsOff(async () => {
  const r = await start(sched(rp.run, rp.what))
  expect(r.env.LANES_BLOCK_FACTS).toBe('1')                                                                   // laneEnv hands the switch to the hook
  const first = await bash(r, rp.first)
  expect(first.deny).toContain('NOTHING in it ran, the btcc-receipt complete included')                          // 1.36.2, unchanged: nothing completed
  expect(first.deny).toContain(`(${rp.target})`)
  expect(completions(String(rp.run)).length).toBe(0)
  const sentBefore = sent.length
  expect(await call(r, 'notify_joey', rp.notify)).toContain('sent to Joey')
  expect(sent.length).toBe(sentBefore + 1)                                                                     // the line Joey gets anyway, no other message
  expect(sent.at(-1)!.text.endsWith(`\n${line(1, rp.target)}`)).toBe(true)
  expect(sent.at(-1)!.text).toContain(rp.notify.text.split('\n')[0].slice(0, 20))
  expect((await bash(r, rp.second)).deny).toContain(`(${rp.target})`)
  const asIs = await call(r, 'receipt', rp.receipt)                                                            // the receipt the lane filed that day
  if (rp.receipt.run_id) {
    expect(asIs).toStartWith(`沒有記錄，排程 run ${rp.run} 也沒有完成：${line(2, rp.target)}`)
    expect(asIs).toContain('outcome 填 failed')
    expect(ledger().filter(x => x.event === r.id && x.kind === 'receipt').length).toBe(0)                    // refused: nothing recorded
    expect(await call(r, 'receipt', { ...rp.receipt, outcome: 'failed', did: `寫 ${rp.target} 被擋，沒寫成` })).toContain('receipt recorded; scheduler:')
    expect(completions(String(rp.run))).toMatchObject([{ outcome: 'failed' }])
  } else {                                                                                                     // elsa filed no run_id: recorded, the run not completed
    expect(asIs).toContain('receipt recorded')
    expect(completions(String(rp.run)).length).toBe(0)
    const cli = await bash(r, `~/.claude/tools/btcc-receipt complete ${rp.run} --outcome ok --note '已記錄'`)       // the CLI as a success: refused the same way
    expect(cli.deny).toContain(`run ${rp.run} not completed: 沒有記錄，排程 run ${rp.run} 也沒有完成：${line(2, rp.target)}`)
    expect(cli.deny).toContain('File the receipt again'); expect(cli.deny).not.toContain('Do not run btcc-receipt complete again')
    expect(completions(String(rp.run)).length).toBe(0)
    expect((await bash(r, `~/.claude/tools/btcc-receipt complete ${rp.run} --outcome failed --note '寫入被擋'`)).deny).toContain(`run ${rp.run} completed`)
    expect(completions(String(rp.run))).toMatchObject([{ outcome: 'failed' }])
  }
  const rec = ledger().filter(x => x.event === r.id && x.kind === 'receipt')
  expect(rec.length).toBeGreaterThan(0)
  for (const x of rec) { expect(x.text).toContain(line(2, rp.target)); expect(x.refs.blocked).toEqual({ n: 2, targets: [rp.target] }) }
  expect(completions(String(rp.run)).some(c => B.isSuccess(c.outcome))).toBe(false)
  if (rp.handoff) expect(await call(r, 'handoff_main', { text: rp.handoff })).toContain('handed to the main')
  expect(await end(r)).toMatchObject({ blocked_n: 2, blocked_targets: [rp.target] })
  expect(laneRows().filter(x => x.kind === 'blocked' && x.event === r.id).map(x => x.target)).toEqual([rp.target, rp.target])
  expect(E().get(r.id)!.blocked).toBe(line(2, rp.target))
  expect(L.activityList(undefined)).toContain(line(2, rp.target))                                             // the run's line in the main's views
  const dg = L.__digest(); if (dg) digestDone(dg)
}), 30000)

test('WO-125 #4 (B): a refusal stops counting only when a later call of the run succeeds on its target: a read of it does not; a Write, a shell write or append_file does', () => stepsOff(async () => {
  writeFileSync(join(dir, 'appendable.txt'), 'state/eng-log.md\n')
  const r = await start(sched(7001, 'eng-heartbeat'))
  expect((await bash(r, 'echo "- 心跳 ok" >> state/eng-log.md')).deny).toContain('append_file')                // a declared file: append_file only
  expect((await hook(r, 'Write', { file_path: join(ws, 'state', 'other.md'), content: 'x' })).deny).toContain('does not edit workspace files')
  expect((await bash(r, './bin/svc DELETE mock-api/cache')).deny).toContain('is refused')                       // a command: its first 80 characters
  const tok = r.tok
  expect(tok.blocked.map((b: any) => [b.category, b.target])).toEqual([['file', 'state/eng-log.md'], ['file', 'state/other.md'], ['command', './bin/svc DELETE mock-api/cache']])
  await say([step('Bash', { command: 'tail -3 state/eng-log.md' }, '- 心跳 ok'), step('Bash', { command: 'cat state/other.md > /tmp/x' }),
    step('Write', { file_path: join(ws, 'state', 'other.md'), content: 'x' }, 'error', false),                  // an error result clears nothing
    step('Write', { file_path: join(ws, 'out', 'marker.md'), content: 'x' })].join('\n'))
  expect(await until(() => tok.calls?.some((c: any) => c.input?.file_path?.endsWith('marker.md')))).toBe(true); await sleep(50)
  expect(B.blockedFacts(tok.blocked)).toEqual({ n: 3, targets: ['state/eng-log.md', 'state/other.md', './bin/svc DELETE mock-api/cache'] })
  await say(step('Write', { file_path: join(ws, 'state', 'other.md'), content: 'x' }, 'File created successfully'))   // a success on the same path (absolute form)
  expect(await until(() => B.blockedFacts(tok.blocked)?.n === 2)).toBe(true)
  expect(await call(r, 'append_file', { path: 'state/eng-log.md', text: '- 心跳 ok' })).toStartWith('added ')
  expect(B.blockedFacts(tok.blocked)).toEqual({ n: 1, targets: ['./bin/svc DELETE mock-api/cache'] })
  expect(B.bashWritesPath('echo x >> state/eng-log.md', 'state/eng-log.md')).toBe(true)
  expect(B.bashWritesPath('cp /tmp/a state/eng-log.md', 'state/eng-log.md')).toBe(true)
  expect(B.bashWritesPath(`sed -i 's/a/b/' ${ws}/state/eng-log.md`, 'state/eng-log.md')).toBe(true)
  expect(B.bashWritesPath('tail -3 state/eng-log.md | cut -c1-40', 'state/eng-log.md')).toBe(false)
  expect(B.bashWritesPath('cp state/eng-log.md out/', 'state/eng-log.md')).toBe(false)
  await call(r, 'notify_joey', { outcome: 'normal', text: '心跳正常' })
  expect(sent.at(-1)!.text.endsWith(`\n${line(1, './bin/svc DELETE mock-api/cache')}`)).toBe(true)
  await call(r, 'receipt', { outcome: 'failed', run_id: '7001', happened: '心跳', did: 'svc DELETE 被擋', promised: '無', needs_main: '無' })
  expect(await end(r)).toMatchObject({ blocked_n: 1, blocked_targets: ['./bin/svc DELETE mock-api/cache'] })
  rmSync(join(dir, 'appendable.txt'))
}), 30000)

test('WO-125 #4 (B): more than three targets: three are listed, then 「等 N 個」; ask_joey carries the line too', () => stepsOff(async () => {
  const r = await start(sched(7002, 'cleanup'))
  for (const f of ['a.md', 'b.md', 'c.md', 'd.md']) expect((await bash(r, `echo x > state/${f}`)).deny).toContain(`state/${f}`)
  const l = line(4, 'state/a.md', 'state/b.md', 'state/c.md', 'state/d.md')
  expect(l).toBe('〔系統〕這一趟 4 次寫入或指令被擋：state/a.md、state/b.md、state/c.md 等 4 個')
  expect(await call(r, 'ask_joey', { text: '四個狀態檔都寫不進去，要不要交主線？' })).toContain('sent to Joey')
  expect(sent.at(-1)!.text.endsWith(`\n${l}`)).toBe(true)
  expect(await end(r)).toMatchObject({ blocked_n: 4, blocked_targets: ['state/a.md', 'state/b.md', 'state/c.md'] })
}), 30000)

test('WO-125 #5: a repeated receipt refused (already completed) and a receipt chained after allowed steps are the receipt\'s own handling: no 〔系統〕 line, the outcome as filed', () => stepsOff(async () => {
  const r = await start(sched(7003, 'backup-check'))
  expect((await bash(r, "echo ok >> out/note.md && ~/.claude/tools/btcc-receipt complete 7003 --outcome ok")).deny).toContain('The receipt has to be a command of its own')
  expect((await bash(r, "~/.claude/tools/btcc-receipt complete 7003 --outcome ok --note '照例，無事'")).deny).toContain('run 7003 completed')
  const again = await bash(r, "~/.claude/tools/btcc-receipt complete 7003 --outcome ok")
  expect(again.deny).toContain('already completed (by this event)'); expect(again.deny).toContain('Do not run btcc-receipt complete again')
  expect(completions('7003')).toMatchObject([{ outcome: 'ok' }])
  expect(r.tok.blocked ?? []).toEqual([])
  await call(r, 'notify_joey', { outcome: 'normal', text: '備份檢查正常' })
  expect(sent.at(-1)!.text).not.toContain('〔系統〕')
  expect(await call(r, 'receipt', { outcome: 'done', run_id: '7003', happened: '備份正常', did: '查了', promised: '無', needs_main: '無' })).toContain('already completed')
  expect(ledger().filter(x => x.event === r.id && x.kind === 'receipt').every(x => !x.text.includes('〔系統〕') && !x.refs?.blocked)).toBe(true)
  const exit = await end(r)
  expect(exit).toMatchObject({ blocked_n: 0, blocked_targets: [] })
  expect(E().get(r.id)!.blocked).toBeUndefined()
}), 30000)

// ------------------------------------------------------------------ C: the steps
test('WO-125 #6: a numbered schedule with step 2 skipped: done / normal are refused with the ticket\'s words and record nothing; failed (部分完成) is recorded with the step not done', async () => {
  const r = await start(sched(7004, 'eng-heartbeat'))
  const steps = [{ step: '1. 跑 eng_check.py', done: true }, { step: '2. append 一行到 state/eng-log.md', done: false, note: '寫入被擋' }, { step: '3. notify_joey 一行', done: true }]
  await call(r, 'notify_joey', { outcome: 'normal', text: '工程心跳：全 ✓' })
  for (const outcome of ['done', 'normal']) {
    const t = await call(r, 'receipt', { outcome, run_id: '7004', steps, happened: '心跳', did: '跑了', promised: '無', needs_main: '無' })
    // WO-148: the first refusal has the ticket's words; it holds for the run, so the second success receipt gets the held refusal (it names the same step)
    expect(t).toContain(outcome === 'done' ? '把沒做的那幾步交給主線，或把結果改成部分完成' : '先 handoff_main 把那幾步交給主線')
    expect(t).toContain('第 2 步「2. append 一行到 state/eng-log.md」（寫入被擋）')
  }
  expect(ledger().filter(x => x.event === r.id && x.kind === 'receipt').length).toBe(0)
  expect(completions('7004').length).toBe(0)
  expect(await call(r, 'receipt', { outcome: 'done', run_id: '7004', steps: 'all done' })).toContain('steps 要是一個陣列')
  expect(await call(r, 'receipt', { outcome: 'failed', run_id: '7004', steps, happened: '心跳全 ✓', did: '跑了 eng_check；第 2 步沒做', promised: '無', needs_main: '補 eng-log 一行' })).toContain('receipt recorded; scheduler:')
  const rec = ledger().filter(x => x.event === r.id && x.kind === 'receipt')
  expect(rec.length).toBe(1)
  expect(rec[0].text).toContain('步驟 3 步，沒做：第 2 步「2. append 一行到 state/eng-log.md」（寫入被擋）')
  expect(rec[0].refs.steps).toEqual(steps)
  expect(completions('7004')).toMatchObject([{ outcome: 'failed' }])
  expect(E().get(r.id)!.did).toContain('沒做：第 2 步')                                                         // the digest's line names it too
  expect(await end(r)).toMatchObject({ steps_marked: 3, steps_not_done: 1 })
}, 30000)

test('WO-125 #6 (C): after the steps not done were handed to the main (an accepted handoff_main), the receipt goes through with its steps as they are', async () => {
  const r = await start(sched(7005, 'eng-heartbeat'))
  const steps = [{ step: '1. 檢查', done: true }, { step: '2. 改設定', done: false, note: '交給主線' }]
  expect(await call(r, 'handoff_main', { text: '第 2 步改設定要主線做：…' })).toContain('handed to the main')
  expect(await call(r, 'receipt', { outcome: 'done', steps, happened: '檢查完', did: '第 2 步交主線', promised: '無', needs_main: '改設定' })).toContain('receipt recorded')
  expect(ledger().filter(x => x.event === r.id && x.kind === 'receipt')[0].refs.steps).toEqual(steps)
  expect(await end(r)).toMatchObject({ steps_marked: 2, steps_not_done: 1 })
}, 30000)

test('WO-125 (C): the receipt tool says how to list the steps and takes them; LANES_RECEIPT_STEPS=0 gives the tool as it was', () => {
  const rc = L.laneToolsFor('reflex').find((t: any) => t.name === 'receipt')
  expect(rc.description).toContain('List each step of the instruction in steps')
  expect(rc.description).toContain('部分完成'); expect(rc.description).toContain('outcome failed')
  expect(rc.inputSchema.properties.steps.items.required).toEqual(['step', 'done'])
  process.env.LANES_RECEIPT_STEPS = '0'; process.env.LANES_DECISIONS = '0'                                    // WO-127 (1.38.0): decide_later has its own switch
  try {
    expect(L.laneToolsFor('reflex')).toBe(L.LANE_TOOLS)
    expect(L.laneToolsFor('mail').filter((t: any) => t.name === 'receipt')).toEqual(L.LANE_TOOLS.filter(t => t.name === 'receipt'))
  } finally { delete process.env.LANES_RECEIPT_STEPS; delete process.env.LANES_DECISIONS }
})

// ------------------------------------------------------------------ 7, 8, 9: Joey's phone, the observation points, the switches off
/** one run as on 11-23: a refused write, a line to Joey, a receipt that says what happened */
async function scenario(run: number): Promise<{ r: Run; sentN: number; notify: string; texts: string[]; exit: any; receipt: string }> {
  const r = await start(sched(run, 'eng-heartbeat'))
  const before = sent.length
  await bash(r, `echo "- run ${run}" >> state/eng-log.md`)
  const notify = await call(r, 'notify_joey', { outcome: 'normal', text: `工程心跳 run ${run}：全 ✓` })
  const receipt = await call(r, 'receipt', { outcome: 'failed', run_id: String(run), steps: [{ step: '1. eng_check', done: true }, { step: '2. append eng-log', done: false }], happened: '心跳', did: 'append 被擋', promised: '無', needs_main: '補一行' })
  const exit = await end(r)
  return { r, sentN: sent.length - before, notify, texts: sent.slice(before).map(s => s.text), exit, receipt }
}
test('WO-125 #7: Joey gets as many messages with the feature as without it; only the line he gets anyway has one more line', async () => {
  const on = await scenario(7101)
  for (const k of SWITCHES) process.env[k] = '0'
  let off: Awaited<ReturnType<typeof scenario>>
  try { off = await scenario(7102) } finally { for (const k of SWITCHES) delete process.env[k] }
  expect(on.sentN).toBe(1); expect(off.sentN).toBe(1)
  const norm = (t: string) => t.replace(/反射線#\d+/g, '反射線#N').replace(/71\d\d/g, 'RUN')
  // 1.39.0 (WO-129, item 4): the receipt's steps not done follow on the same line Joey gets anyway, in the same form (still one message)
  expect(norm(on.texts[0])).toBe(`${norm(off.texts[0])}\n${line(1, 'state/eng-log.md')}\n${B.stepsLine([{ step: '1. eng_check', done: true }, { step: '2. append eng-log', done: false }])}`)
}, 30000)

test('WO-125 #8: the observation points are on each run\'s exit record in lanes.jsonl', async () => {
  writeFileSync(join(dir, 'boundary.md'), '- 純知會的信勾掉就好\n')
  const s = await scenario(7103)
  expect(s.exit).toMatchObject({ blocked_n: 1, blocked_targets: ['state/eng-log.md'], steps_marked: 2, steps_not_done: 1, boundary_lines: 12, boundary_source: 'file' })
  rmSync(join(dir, 'boundary.md'))
}, 30000)

test('WO-125 #9: all three switches off: prompts, tool results, records and the exit record are as before the feature', async () => {
  const lane = { id: 'adam.reflex.900', kind: 'reflex', n: 900, session_id: 's900', thread: 'adam#t-900', status: 'idle', created: '', last: '', transcript: '', runs: 1, tokens_in: 0, tokens_out: 0 } as any
  const it = { ev: { id: 'mesh-wo125-ctx', source: 'mesh', from: 'eve', text: 'x', meta: {}, notif: { method: '', params: {} } } } as any
  writeFileSync(join(dir, 'boundary.md'), '- 判例甲\n')
  const ctxOn = L.laneContext(lane, it), mainOn = mainContext('adam', 'sid'), card = B.boundaryCard('adam', dir)
  for (const k of SWITCHES) process.env[k] = '0'
  try {
    const ctxOff = L.laneContext(lane, it)
    expect(ctxOff).not.toContain('邊界卡')
    expect(ctxOff).toBe(ctxOn.replace(`\n\n${card.text}`, ''))                                                   // the card is the only difference
    expect(mainContext('adam', 'sid')).toBe(mainOn.replace(`\n${B.BOUNDARY_MAIN_RULE}`, ''))
    process.env.LANES_DECISIONS = '0'                                                                          // WO-127 (1.38.0) adds decide_later with its own switch
    try { expect(L.laneToolsFor('reflex')).toBe(L.LANE_TOOLS) } finally { delete process.env.LANES_DECISIONS }
    const s = await scenario(7104)
    expect(runsOf().at(-1).env.LANES_BLOCK_FACTS).toBeUndefined()                                               // the hook is not asked to report
    expect(laneRows().filter(x => x.kind === 'blocked' && x.event === s.r.id).length).toBe(0)
    expect(s.r.prompt).not.toContain('邊界卡')
    expect(s.texts[0]).not.toContain('〔系統〕')
    expect(s.receipt).toBe('receipt recorded; scheduler: {"state":"completed"}')
    const rec = ledger().filter(x => x.event === s.r.id && x.kind === 'receipt')[0]
    expect(rec.text).toBe('run 7104: failed — 心跳')                                                            // steps ignored: the record as before
    expect(Object.keys(rec.refs)).toEqual(['report', 'class'])
    for (const k of ['blocked_n', 'blocked_targets', 'steps_marked', 'steps_not_done', 'boundary_lines', 'boundary_source']) expect(k in s.exit).toBe(false)
    expect(E().get(s.r.id)!.blocked).toBeUndefined()
    // a step not done with done: today's receipt (steps not read)
    const r = await start(sched(7105, 'eng-heartbeat'))
    expect(await call(r, 'receipt', { outcome: 'done', run_id: '7105', steps: [{ step: '1', done: false }], happened: 'x', did: 'y', promised: '無', needs_main: '無' })).toBe('receipt recorded; scheduler: {"state":"completed"}')
    await end(r)
  } finally { for (const k of SWITCHES) delete process.env[k]; rmSync(join(dir, 'boundary.md')) }
}, 30000)

test('WO-125: the guard hook decides exactly as before whether or not it reports (same output for every command, allowed or refused)', () => stepsOff(async () => {
  const r = await start(sched(7106, 'eng-heartbeat'))
  const withFacts = r, without = { ...r, env: Object.fromEntries(Object.entries(r.env).filter(([k]) => k !== 'LANES_BLOCK_FACTS')) }
  const cmds = [...REPLAYS.map(x => x.second), 'echo ok >> out/a.md', 'cat state/eng-log.md', './bin/svc GET mock-api/health', 'GENESIS_ACTOR=main ./bin/svc GET x', 'echo x >> .lanes/focus.md']
  for (const c of cmds) {
    const a = await bash(without, c), b = await bash(withFacts, c)
    expect(b.raw).toBe(a.raw)
  }
  for (const [tool, input] of [['Write', { file_path: join(ws, 'state', 'x.md'), content: 'x' }], ['Edit', { file_path: join(ws, 'out', 'x.md'), old_string: 'a', new_string: 'b' }], ['Write', { file_path: join(dir, 'focus.md'), content: 'x' }]] as const) {
    expect((await hook(withFacts, tool, input)).raw).toBe((await hook(without, tool, input)).raw)
  }
  expect(laneRows().filter(x => x.kind === 'blocked' && x.event === r.id).length).toBe(REPLAYS.length + 4)      // reported only with the switch: the 5 writes, the identity, .lanes/ by shell, 2 Writes
  const dead = createServer(); await new Promise<void>(res => dead.listen(0, '127.0.0.1', () => res())); const port = (dead.address() as any).port; dead.close()
  const unreachable = async (command: string) => { const p = Bun.spawn(['python3', join(import.meta.dir, 'lanes-hooks', 'lane-guard-hook.py')], { stdin: 'pipe', stdout: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...r.env, LANES_HTTP_PORT: String(port) } })
    p.stdin.write(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: ws })); p.stdin.end(); const raw = await new Response(p.stdout).text(); await p.exited; return raw }
  for (const c of [REPLAYS[0].second, 'echo ok >> out/a.md']) expect(await unreachable(c)).toBe((await bash(without, c)).raw)   // a report that fails changes nothing
  await end(r)
}), 30000)
