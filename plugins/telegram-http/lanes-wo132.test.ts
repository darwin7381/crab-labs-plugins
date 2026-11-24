// WO-132 (telegram-http 1.40.0): an alert's lane on a production machine (Chiron's ticket; Joey TG chiron:2081, 2095).
// The incident, Prometheus 11-24 09:27–09:30Z: four warning alerts of one host (1361, 1360, 1363, 1364: httpcheck of bt-xboard-falkenstein) in 49 s each
// opened a reflex lane (mesh-alert → prometheus.reflex.1–4, four threads); reflex.2 and reflex.3 each ran `docker compose … up -d` on the production identity
// box over ssh; reflex.4 reported normal after a 504; Joey got 5 messages in 3 minutes while the main was on that box. The tests follow the ticket's
// acceptance list (怎樣算完成 1-5) and the points added to it (kot.reflex.3, cadmus.reflex.7, mail #11101, prod_change). The alerts are replayed with their
// real ids and texts; the two lanes' Bash commands are replayed from their transcripts (test-fixtures/wo132-prometheus-reflex-commands.json: the box's
// address and the key file names replaced).
// The lane process is a stand-in: it prints the stream-json lines the test hands it, runs the lane's steering hook (lane-steer-hook.py) at a "tool
// boundary" when told, and ends when told. The main is a stand-in process driven through its hook events.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync, renameSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { decisionEvent } from './mail-events.ts'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?wo132') as typeof import('./lanes.ts')
const B = await import('./lanes-boundary.ts')

const ws = mkdtempSync(join(tmpdir(), 'lanes-wo132-ws-'))
const dir = join(ws, '.lanes'); mkdirSync(dir)
const tmp = mkdtempSync(join(tmpdir(), 'lanes-wo132-'))
mkdirSync(join(tmp, 'tr'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
const HOOKS = join(import.meta.dir, 'lanes-hooks')
const ARGV = join(tmp, 'argv.jsonl'), bin = join(tmp, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, sys, time, subprocess
lid = os.environ.get('LANE_ID', 'x')
with open('${ARGV}', 'a') as f: f.write(json.dumps({'lane': lid, 'argv': sys.argv[1:]}) + '\\n')
go = os.path.join('${tmp}', 'go-' + lid)
t0 = time.time()
end = False
while time.time() - t0 < 90 and not end:
    if os.path.exists(go):
        body = open(go).read(); os.remove(go)
        for line in body.split('\\n'):
            if line.startswith('EMIT '): print(line[5:], flush=True)
            elif line.strip() == 'HOOK':
                r = subprocess.run(['python3', '${HOOKS}/lane-steer-hook.py'], input=json.dumps({'hook_event_name': 'PostToolUse', 'tool_name': 'Bash', 'session_id': 's'}),
                                   capture_output=True, text=True, env=os.environ)
                with open(os.path.join('${tmp}', 'hook-' + lid + '.jsonl'), 'a') as f: f.write(json.dumps({'out': r.stdout.strip()}) + '\\n')
            elif line.strip() == 'END': end = True
    time.sleep(0.02)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
const sent: Array<{ text: string; silent: boolean }> = []
const open = new Set<string>()
L.__setMailTool(async b => ({ text: b.name === 'decide_later' ? '放進主線的信箱了（#13201，期限 11-25 03:00Z）。' : 'ok', isError: false, ...(b.name === 'decide_later' ? { mail_id: 13201, deadline: '2026-11-25T03:00:00.000Z' } : {}) }))
L.lanesInit({ role: 'tg', agent: 'prometheus', workspaceDir: ws, transcriptDir: join(tmp, 'tr'), httpPort: 0, log: () => {}, authOk: () => true, registryNames: () => ['eve', 'scheduler'],
  notifySession: async (sid: string) => open.has(sid), streamOpen: (sid: string) => open.has(sid), toolsChanged: () => {},
  sendBot: async (_c: string, text: string, o: any) => { sent.push({ text, silent: !!o?.silent }); return 900 + sent.length }, joeyChatId: () => '1' } as any)
const procs: any[] = []
const ENVS = ['LANES_FLOOD_CONTROL', 'LANES_INCIDENT_MERGE', 'LANES_INCIDENT_WINDOW_S', 'LANES_RUN_CONTEXT', 'LANES_PROD_CHANGE', 'LANES_BOUNDARY_CARD', 'LANES_BLOCK_FACTS', 'LANES_RECEIPT_STEPS']
afterAll(() => { for (const f of Object.keys(L.__lanesState().lanes)) try { writeFileSync(join(tmp, `go-${f}`), 'END') } catch {}
  for (const p of procs) try { p.kill('SIGKILL') } catch {}
  L.__setClaudeBin(restore); L.__setMailTool(null); for (const k of ENVS) delete process.env[k]
  rmSync(ws, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }) })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const jsonl = (p: string): any[] => { try { return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const ledger = () => jsonl(join(dir, 'ledger.jsonl'))
const laneRows = () => jsonl(join(dir, 'lanes.jsonl'))
const routing = () => jsonl(join(dir, 'routing.jsonl'))
const runsOf = () => jsonl(ARGV)
const hookOut = (lane: string): string[] => jsonl(join(tmp, `hook-${lane}.jsonl`)).map(r => r.out).filter(Boolean)
const E = () => L.__events(), M = () => L.__main(), st = () => L.__lanesState()
const FIX = JSON.parse(readFileSync(join(import.meta.dir, 'test-fixtures', 'wo132-prometheus-reflex-commands.json'), 'utf8')) as Record<string, Array<[string, string]>>
// the four alerts, as the dispatcher sent them (prometheus .telegram-state/lanes/state.jsonl, their run records)
const TAIL = '\n接收人：prometheus（建立者 hephaestus；alert_recipients#12 netdata/*/httpcheck_kbro_auth*）。\n接手就把這張 ack（by=你）。'
const ALERTS: Array<[string, string, string]> = [
  ['09:27:21.000', 'mesh-1795512440975-4e08', '【警報 warning】alert 1361：netdata / bt-xboard-falkenstein / httpcheck_kbro_auth_authui_branding.request_status = 1 checks\nhttpcheck_kbro_auth_timeouts: Every HTTP check to https://auth.kbro.ai/authui/api/branding timed out for the last 2 minutes' + TAIL],
  ['09:27:21.291', 'mesh-1795512441285-5d65', '【警報 warning】alert 1360：netdata / bt-xboard-falkenstein / httpcheck_kbro_auth_authui_login.request_status = 1 checks\nhttpcheck_kbro_auth_timeouts: Every HTTP check to https://auth.kbro.ai/authui/login timed out for the last 2 minutes' + TAIL],
  ['09:27:50.443', 'mesh-1795512470420-124f', '【警報 warning】alert 1363：netdata / bt-xboard-falkenstein / httpcheck_kbro_auth_oidc_discovery.request_status = 1 checks\nhttpcheck_kbro_auth_timeouts: Every HTTP check to https://auth.kbro.ai/.well-known/openid-configuration timed out for the last 2 minutes' + TAIL],
  ['09:28:10.635', 'mesh-1795512490628-3ddb', '【警報 warning】alert 1364：netdata / bt-xboard-falkenstein / httpcheck_kbro_auth_landing.request_status = 20%\nhttpcheck_web_service_bad_status: Percentage of HTTP responses from https://auth.kbro.ai/ with unexpected status in the last 5 minutes' + TAIL],
]
const META = { chat_id: 'local-inject', user: 'alert-dispatcher', user_id: 'local-inject', via: 'local-inject', verified: 'true', relay: 'oncall-receiver', line: 'call' }
const alert = (id: string, text: string) => ({ id, source: 'mesh', from: 'alert-dispatcher', verified: true, text, line: 'call', meta: { ...META }, notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any)
let n = 0
const mk = (from: string, text: string, extra: object = {}) => ({ id: `mesh-wo132-${++n}`, source: 'mesh', from, verified: true, text, meta: {}, notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } }, ...extra } as any)
const sched = (run: number, what: string) => { const e = mk('scheduler', `[scheduled][${what}][run:${run}][P3][routine] ${what}：照例檢查，回報 Joey 一行`); e.meta = { run_id: String(run) }; return e }
type Run = { id: string; lane: string; tok: any; prompt: string }
async function start(ev: any): Promise<Run> {
  const before = runsOf().length
  const d = await L.routeEvent(ev)
  expect(d).toMatchObject({ target: 'lane' })
  expect(await until(() => !!L.__runTok(d.lane!) && L.__runTok(d.lane!)!.evId === ev.id && runsOf().length > before)).toBe(true)
  const r = runsOf().filter(x => x.lane === d.lane).at(-1)
  return { id: ev.id, lane: d.lane!, tok: L.__runTok(d.lane!)!, prompt: r.argv[r.argv.indexOf('-p') + 1] }
}
async function say(lane: string, body: string): Promise<void> {
  const go = join(tmp, `go-${lane}`)
  expect(await until(() => !existsSync(go))).toBe(true)
  writeFileSync(go + '.tmp', body); renameSync(go + '.tmp', go)
  expect(await until(() => !existsSync(go))).toBe(true)
}
async function end(r: Run): Promise<any> {
  await say(r.lane, 'END')
  expect(await until(() => L.__runTok(r.lane)?.evId !== r.id)).toBe(true)
  await sleep(40)
  return laneRows().filter(x => x.kind === 'exit' && x.event === r.id).at(-1)
}
let tu = 0
const bash = (command: string, result = 'ok'): string => { const id = `tu-wo132-${++tu}`
  return [`EMIT ${JSON.stringify({ type: 'assistant', message: { id: `m-${id}`, usage: {}, content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })}`,
    `EMIT ${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: result }] } })}`].join('\n') }
const call = (r: Run, name: string, a: object) => L.callLaneTool(r.tok, name, a)
/** the main: a stand-in process registered as this agent's main, its Telegram stream open (an idle main is offered items) */
async function mainUp(): Promise<{ pid: number; hook: (event: string, o?: object) => Promise<any>; kill: () => Promise<void> }> {
  const p = Bun.spawn(['sleep', '600']); procs.push(p)
  const sid = randomUUID(); writeFileSync(join(dir, 'main-expected'), sid); open.add(`mcp-${p.pid}`); L.__noteMcpPid(`mcp-${p.pid}`, p.pid)
  const hook = (event: string, o: object = {}) => L.__mainEvent({ event, pid: p.pid, session_id: sid, ...o } as any)
  await hook('SessionStart', { source: 'startup' })
  return { pid: p.pid, hook, kill: async () => { await hook('SessionEnd'); p.kill('SIGKILL') } }
}
const reflexLanes = () => Object.values(st().lanes).filter(l => l.kind === 'reflex')
const hhmm = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

// ------------------------------------------------------------------ 1: the words
test('WO-132 #1: the words, verbatim: questions 2 and 3 of the boundary card, the line after 「沒把握」, the identity card\'s 「做可逆的小處理」 and its critical-alert line; the lane card\'s hash changes', () => {
  const card = B.boundaryDefault('prometheus')
  expect(card[3]).toBe('2. 收不回的動作，或動到正式環境的動作：錢、金鑰、發布、刪除、改設定、對外；在正式的機器或服務上重啟、重建、部署、套用設定也算，就算文件寫了怎麼做、就算是把它恢復原狀。')
  expect(card[4]).toBe('3. 只有主對話才知道的事：Joey 剛講的、談到一半的、prometheus 自己的標準、主線手上正在動的東西。正式服務出事時，先當成主線可能正在動它。')
  const i = card.indexOf('沒把握：交給主線，不猜著做完。')
  expect(i).toBeGreaterThan(0)
  expect(card[i + 1]).toBe('正式服務正在壞、等不起：唯讀查清楚、把要下的指令備好，用 handoff_main 交給主線，第一句寫什麼壞了、誰在等。不自己下那個指令。')
  expect(card.length).toBe(11)
  const id = L.identityCard({ kind: 'reflex' }).split('\n')
  expect(id.find(l => l.startsWith('- 權限上限：'))).toContain('可以查、回覆別的 agent、做可逆的小處理（不動正式的機器或服務）、記帳。')
  const crit = id.find(l => l.includes('分流器標記：嚴重警報'))!
  expect(crit).toBe('- 事件訊息最前面的「〔車道資訊〕」區塊裡，有「分流器標記：嚴重警報」就是嚴重警報：查證後一定要讓 Joey 知道，用 notify_joey 回報（這一類分流器會響鈴）；需要他決定就改用 ask_joey。'
    + '嚴重本身不是交主線的理由，也不是不交的理由：照邊界卡的三問判，要主線的照樣用 handoff_main 交。摘要不會叫醒主線。')
  const on = Object.fromEntries((['reflex', 'mail', 'worker', 'fork'] as const).map(k => [k, L.cardHash(k)]))
  process.env.LANES_BOUNDARY_CARD = '0'
  try { for (const k of ['reflex', 'mail', 'worker', 'fork'] as const) expect(L.cardHash(k)).not.toBe(on[k]) } finally { delete process.env.LANES_BOUNDARY_CARD }
})

// ------------------------------------------------------------------ 2 + 3: the replay, one lane for the incident; what a run is told of the main and the other lanes
test('WO-132 #2 + #3, replay of Prometheus 09:27:21–09:28:10Z: four alerts, one lane; the three later ones are merged into its run in progress (its next tool boundary); Joey gets one message; the exit row counts them; the run was told the main is in a turn on the Traefik hand-over', async () => {
  const m = await mainUp()
  // the main's turn since 09:25Z: the mail lane's hand-over of the Traefik notices (ho-a248c3, the real one's first words)
  const item = M().enqueue('handoff', { method: 'notifications/claude/channel', params: { content: '〔交給主線｜ho-a248c3〕#11128 警報 1359 critical（未勾、未 ack）：Traefik 3 則公告（11-24）。[high] GHSA-3rh5-223h-cpwr：Compress middleware 的 Brotli writer…',
    meta: { chat_id: 'lanes', user: 'lanes', user_id: 'lanes', via: 'lanes', kind: 'handoff', handoff: 'ho-a248c3' } } }, { event: 'mesh-1795512280202-54f8' })
  await m.hook('UserPromptSubmit', { prompt_id: 'p-traefik', dids: [item] })
  expect(M().currentGen()!.state).toBe('in_turn')
  const lanesBefore = reflexLanes().length, sentBefore = sent.length, spawnsBefore = laneRows().filter(x => x.kind === 'spawn').length
  const r = await start(alert(ALERTS[0][1], ALERTS[0][2]))
  // #3: the run's 〔車道資訊〕: the main in a turn since when, on what; no other lane of the agent running
  const at = L.__lanesState().lanes[r.lane].last
  expect(r.prompt).toContain(`# 此刻（系統寫的，時間為 UTC+8）\n主線：回合中（自 ${hhmm(new Date().toISOString())} 起，在處理：〔交給主線｜ho-a248c3〕#11128 警報 1359 critical（未勾、未 ack）：Traefik 3 則公告（11-24）。`)
  expect(r.prompt).toContain('…）\n這一隻此刻沒有別的分身在跑\n\n# 焦點卡')
  expect(r.prompt.indexOf('# 此刻（')).toBeLessThan(r.prompt.indexOf('# 焦點卡'))
  expect(at).toBeTruthy()
  // the three later alerts, in their order: merged into the run in progress, no lane of their own
  for (const [, id, text] of ALERTS.slice(1)) {
    const d = await L.routeEvent(alert(id, text))
    expect(d).toMatchObject({ rule: 'incident-merge', target: 'lane', lane: r.lane })
    expect(String(d.note)).toContain(`merged into the running ${r.tok.runId}`)
  }
  expect(reflexLanes().length).toBe(lanesBefore + 1)
  expect(L.__runEvents(r.lane)).toEqual([ALERTS[0][1]])                                   // not in the run's set until the run has them
  // the lane's next tool boundary: the three alerts, with the system's head, once
  await say(r.lane, `${bash('curl -s -o /dev/null -w "%{http_code}" https://auth.kbro.ai/authui/api/branding', '000')}\nHOOK`)
  expect(await until(() => hookOut(r.lane).length === 1)).toBe(true)
  const ctx = JSON.parse(hookOut(r.lane)[0]).hookSpecificOutput.additionalContext as string
  for (const a of ['1360', '1363', '1364']) expect(ctx).toContain(`alert ${a}：netdata / bt-xboard-falkenstein`)
  expect(ctx).toContain('〔系統併入｜同一件事故在你這一趟還在跑的時候又來了 1 張警報（同一台 bt-xboard-falkenstein，10 分鐘內），分流器沒有另開分身，交給你一起看。一起回報一次')
  expect(ctx).not.toContain('Joey 中途訊息')                                                  // not dressed as a message of Joey's
  expect(await until(() => L.__runEvents(r.lane).length === 4)).toBe(true)
  expect(L.__runEvents(r.lane)).toEqual(ALERTS.map(a => a[1]))
  await say(r.lane, 'HOOK'); await sleep(150)
  expect(hookOut(r.lane).length).toBe(1)                                                    // handed over once
  // each merged alert has its record: riding on the incident's first, owing nothing of its own
  for (const [, id] of ALERTS.slice(1)) expect(E().get(id)).toMatchObject({ state: 'closed', owner: r.lane, incident_of: ALERTS[0][1], incident: 'prometheus|host:bt-xboard-falkenstein' })
  expect(ledger().filter(x => x.refs?.incident === 'delivered').map(x => x.event)).toEqual(ALERTS.slice(1).map(a => a[1]))
  // one line to Joey for the incident
  expect(await call(r, 'notify_joey', { outcome: 'changed', text: 'auth.kbro.ai 登入、branding、OIDC discovery 約 2 分鐘逾時（1361、1360、1363、1364 同一台），現已恢復。' })).toContain('sent to Joey')
  expect(await call(r, 'receipt', { happened: '1361/1360/1363/1364 同一台 httpcheck', did: '唯讀查證', promised: '無', needs_main: '無' })).toContain('receipt recorded')
  const ex = await end(r)
  expect(sent.length - sentBefore).toBe(1)
  expect(laneRows().filter(x => x.kind === 'spawn').length - spawnsBefore).toBe(1)
  expect(ex.merged_events).toEqual({ n: 3, alert_ids: ['1360', '1363', '1364'], events: ALERTS.slice(1).map(a => a[1]) })
  expect(ex.prod_change).toEqual([])
  expect(routing().filter(x => ALERTS.some(a => a[1] === x.event)).map(x => [x.rule, x.lane])).toEqual([['mesh-alert', r.lane], ...ALERTS.slice(1).map(() => ['incident-merge', r.lane])])
  await m.hook('Stop', { prompt_id: 'p-traefik' }); await m.kill()
}, 40000)

test('WO-132 #2: the incident\'s lane ended inside the window: the next alert of that host is its next run, on its thread (a resumed session gets the new card once); after the window it opens a lane of its own', async () => {
  const owner = st().incidents!['prometheus|host:bt-xboard-falkenstein']
  const lane = st().lanes[owner.lane]
  const old = (() => { process.env.LANES_BOUNDARY_CARD = '0'; try { return L.cardHash('reflex') } finally { delete process.env.LANES_BOUNDARY_CARD } })()
  lane.card_hash = old                                                                      // a session that got 1.39.1's card
  const before = reflexLanes().length
  const r = await start(alert('mesh-wo132-console', '【警報 warning】alert 1365：netdata / bt-xboard-falkenstein / httpcheck_kbro_auth_console.request_status = 1 checks' + TAIL))
  expect(r.lane).toBe(lane.id)
  expect(reflexLanes().length).toBe(before)
  expect(routing().at(-1)).toMatchObject({ event: 'mesh-wo132-console', rule: 'incident-merge', lane: lane.id, thread: lane.thread })
  expect(r.prompt).toContain('分流器標記：跟這條線在處理的是同一件事故（同一台 bt-xboard-falkenstein），分流器沒有另開分身')
  expect(r.prompt.split(L.CARD_UPDATED_HEAD).length - 1).toBe(1)                           // #1: the resumed session gets the current card once
  expect(r.prompt).toContain('做可逆的小處理（不動正式的機器或服務）')
  expect(E().get('mesh-wo132-console')!.obligations.some((o: any) => o.kind === 'joey')).toBe(true)   // its own run owes its line
  await call(r, 'notify_joey', { outcome: 'normal', text: 'console 檢查已恢復。' })
  const ex = await end(r)
  expect(ex.merged_events).toEqual({ n: 1, alert_ids: ['1365'], events: ['mesh-wo132-console'] })
  // after the window: a new incident, a lane of its own
  process.env.LANES_INCIDENT_WINDOW_S = '1'
  try {
    await sleep(1200)
    const s = await start(alert('mesh-wo132-later', '【警報 warning】alert 1367：netdata / bt-xboard-falkenstein / httpcheck_kbro_auth_landing2.request_status = 1 checks' + TAIL))
    expect(s.lane).not.toBe(lane.id)
    expect(routing().at(-1)).toMatchObject({ event: 'mesh-wo132-later', rule: 'mesh-alert' })
    expect(st().incidents!['prometheus|host:bt-xboard-falkenstein'].lane).toBe(s.lane)
    await call(s, 'notify_joey', { outcome: 'normal', text: '短暫抖動。' }); await end(s)
  } finally { delete process.env.LANES_INCIDENT_WINDOW_S }
}, 30000)

test('WO-132 #2: a critical alert merged into a warning run: the run\'s Joey line goes at the critical tier (it rings); merged after that line went, the critical alert owes its own', async () => {
  const w = '【警報 warning】alert 2101：netdata / lab-box-1 / disk_space./ = 91%\nroot 使用 91%'
  const c = '【警報 critical】alert 2102：netdata / lab-box-1 / load.cpu = 99%\nCPU 99% 十分鐘'
  const r = await start(alert('mesh-wo132-w1', w))
  expect(E().get(r.id)!.class).toBe('alert')
  const d = await L.routeEvent(alert('mesh-wo132-c1', c))
  expect(d).toMatchObject({ rule: 'incident-merge', lane: r.lane })
  expect(E().get(r.id)).toMatchObject({ class: 'critical', must_know: true, raised_by: 'mesh-wo132-c1' })
  expect(E().get(r.id)!.obligations.find((o: any) => o.kind === 'joey')).toMatchObject({ ring: true })
  await say(r.lane, 'HOOK')
  expect(await until(() => hookOut(r.lane).length === 1)).toBe(true)
  expect(JSON.parse(hookOut(r.lane)[0]).hookSpecificOutput.additionalContext).toContain('其中有嚴重警報（critical）：這件事故照嚴重警報處理，查證後一定要讓 Joey 知道。')
  const k = sent.length
  expect(await call(r, 'notify_joey', { outcome: 'changed', text: 'lab-box-1 磁碟 91%、CPU 99%：同一台，查證中。' })).toContain('sent to Joey')
  expect(sent.length - k).toBe(1)
  expect(sent.at(-1)!.silent).toBe(false)                                                    // the tiered table: an alert line is silent, a critical one pushes
  expect(ledger().filter(x => x.event === r.id && x.kind === 'notify').at(-1).refs).toMatchObject({ class: 'alert-critical', tier: 'push' })
  await end(r)
  // the line went already (silent, a warning): the critical alert merged after it owes its own line, ringing
  const r2 = await start(alert('mesh-wo132-w2', '【警報 warning】alert 2103：netdata / lab-box-2 / disk_space./ = 92%'))
  expect(await call(r2, 'notify_joey', { outcome: 'normal', text: 'lab-box-2 磁碟 92%。' })).toContain('sent to Joey')
  expect(sent.at(-1)!.silent).toBe(true)
  await L.routeEvent(alert('mesh-wo132-c2', '【警報 critical】alert 2104：netdata / lab-box-2 / load.cpu = 99%'))
  expect(E().get(r2.id)!.class).toBe('alert')                                               // nothing to raise: its line went
  expect(E().get('mesh-wo132-c2')!.obligations.find((o: any) => o.kind === 'joey')).toMatchObject({ state: 'open', ring: true })
  await say(r2.lane, 'HOOK')
  expect(await until(() => L.__runEvents(r2.lane).includes('mesh-wo132-c2'))).toBe(true)
  const k2 = sent.length
  expect(await call(r2, 'notify_joey', { outcome: 'changed', text: 'lab-box-2 CPU 99%（嚴重）。' })).toContain('sent to Joey')
  expect(sent.length - k2).toBe(1); expect(sent.at(-1)!.silent).toBe(false)
  expect(E().get('mesh-wo132-c2')!.obligations.find((o: any) => o.kind === 'joey').state).toBe('met')
  await end(r2)
}, 30000)

// ------------------------------------------------------------------ 3: the run context, the other lanes; 5: switches off (the 1.39.1 replay)
test('WO-132 #3 + #5, the same replay with LANES_INCIDENT_MERGE=0 (1.39.1): four lanes, four lines to Joey, no merged_events; each later lane is told which lanes of the agent are running; the main is idle', async () => {
  process.env.LANES_INCIDENT_MERGE = '0'
  try {
    st().alert_fp = {}                                                                        // the replay above left these alerts' fingerprints (B12, as 1.39.1 would)
    const sentBefore = sent.length, before = reflexLanes().length
    const runs: Run[] = []
    for (const [, id, text] of ALERTS) runs.push(await start(alert(`${id}-off`, text)))
    expect(reflexLanes().length).toBe(before + 4)
    expect(new Set(runs.map(r => r.lane)).size).toBe(4)
    expect(routing().filter(x => runs.some(r => r.id === x.event)).every(x => x.rule === 'mesh-alert')).toBe(true)
    expect(runs[0].prompt).toContain('主線：目前沒有在跑\n這一隻此刻沒有別的分身在跑')
    const s0 = st().lanes[runs[0].lane]
    expect(runs[1].prompt).toContain(`這一隻此刻還在跑的分身：${runs[0].lane}（alert-dispatcher：【警報 warning】alert 1361：netdata / bt-xboard-falkenstein / ht…，自 `)
    expect(runs[3].prompt).toMatch(new RegExp(`這一隻此刻還在跑的分身：${runs[0].lane.replace(/\./g, '\\.')}（[^）]*）；${runs[1].lane.replace(/\./g, '\\.')}（[^）]*）；${runs[2].lane.replace(/\./g, '\\.')}（`))
    expect(s0).toBeTruthy()
    for (const r of runs) expect(await call(r, 'notify_joey', { outcome: 'changed', text: `${r.id}：查證中` })).toContain('sent to Joey')
    expect(sent.length - sentBefore).toBe(4)
    for (const r of runs) { const ex = await end(r); expect('merged_events' in ex).toBe(false); expect(ex.prod_change).toEqual([]) }
  } finally { delete process.env.LANES_INCIDENT_MERGE }
  // LANES_RUN_CONTEXT=0: the block has no 此刻 lines; nothing else differs
  const lane = reflexLanes()[0], it = { ev: alert('mesh-wo132-ctx', ALERTS[0][2]) } as any
  const on = L.laneContext(lane, it)
  process.env.LANES_RUN_CONTEXT = '0'
  try { expect(L.laneContext(lane, it)).toBe(on.replace(`\n\n# 此刻（系統寫的，時間為 UTC+8）\n${L.mainNowLine()}\n${L.lanesNowLine(lane.id)}`, '')) } finally { delete process.env.LANES_RUN_CONTEXT }
  expect(on).toContain('\n主線：目前沒有在跑\n')
}, 40000)

test('WO-132 #3: the main idle, then in a turn begun before this daemon saw it: 「主線：閒著」, 「主線：回合中（在處理：…）」', async () => {
  const m = await mainUp()
  expect(L.mainNowLine()).toBe('主線：閒著')
  const item = M().enqueue('joey', { method: 'notifications/claude/channel', params: { content: 'Joey：auth 登入壞了嗎？', meta: { chat_id: '1', user: 'joey' } } }, { event: null })
  await m.hook('UserPromptSubmit', { prompt_id: 'p-q', dids: [item] })
  expect(L.mainNowLine()).toMatch(/^主線：回合中（自 \d\d:\d\d 起，在處理：Joey：auth 登入壞了嗎？）$/)
  await m.kill()
  expect(L.mainNowLine()).toBe('主線：目前沒有在跑')
})

// ------------------------------------------------------------------ 4: the hand-over carries what the guard refused
test('WO-132 #4: a run with a refused write still counting hands over to the main: the item that wakes it has the 〔系統〕 line (hephaestus.reflex.3\'s target); decide_later too; LANES_BLOCK_FACTS=0: as before', async () => {
  const m = await mainUp()
  const line = B.blockedLine({ n: 1, targets: ['maintenance/flightlog/plutus-data-size.log'] })
  const r = await start(sched(6914, 'morning-check'))
  expect(L.recordBlocked(r.tok, { target: 'maintenance/flightlog/plutus-data-size.log', category: 'file', tool: 'Bash' })).toBe(true)
  expect(await call(r, 'handoff_main', { text: '晨檢：plutus 資料夾 12G，WATCHLIST 要寫一行，請主線處理。' })).toContain('handed to the main')
  const it = M().items(x => x.event === r.id && x.kind === 'handoff').at(-1)!
  expect(String((it.notif.params as any).content)).toContain(`晨檢：plutus 資料夾 12G，WATCHLIST 要寫一行，請主線處理。\n${line}`)
  expect(ledger().filter(x => x.event === r.id && x.kind === 'escalation').at(-1).text).toContain(line)
  expect(E().get(r.id)!.blocked).toBe(line)
  await call(r, 'receipt', { run_id: '6914', outcome: 'failed', steps: [{ step: '寫 WATCHLIST', done: false, note: '被擋' }], happened: '晨檢', did: '交主線', promised: '無', needs_main: '寫一行' })
  await end(r)
  const r2 = await start(sched(6915, 'morning-check'))
  L.recordBlocked(r2.tok, { target: 'state/watch.md', category: 'file', tool: 'Write' })
  expect(await call(r2, 'decide_later', { title: '要不要清 plutus 快取', card: { decide: '清不清', recommend: '清' } })).toContain('The main was woken')
  const it2 = M().items(x => x.event === r2.id && x.kind === 'carry').at(-1)!
  expect(String((it2.notif.params as any).content)).toContain(`\n${B.blockedLine({ n: 1, targets: ['state/watch.md'] })}`)
  await call(r2, 'receipt', { run_id: '6915', outcome: 'failed', steps: [{ step: '清快取', done: false }], happened: 'x', did: 'x', promised: '無', needs_main: 'x' }); await end(r2)
  // a run that ends with its event still owing: the exit rule's hand-over carries the line too
  const r4 = await start(sched(6918, 'morning-check'))
  L.recordBlocked(r4.tok, { target: 'maintenance/flightlog/plutus-data-size.log', category: 'file', tool: 'Bash' })
  await end(r4)
  expect(String((M().items(x => x.event === r4.id && x.kind === 'handoff').at(-1)!.notif.params as any).content)).toContain(`\n${line}`)
  process.env.LANES_BLOCK_FACTS = '0'
  try {
    const r3 = await start(sched(6917, 'morning-check'))
    expect(L.recordBlocked(r3.tok, { target: 'state/x.md', category: 'file', tool: 'Write' })).toBe(false)
    await call(r3, 'handoff_main', { text: '交給主線：寫一行。' })
    expect(String((M().items(x => x.event === r3.id && x.kind === 'handoff').at(-1)!.notif.params as any).content)).toBe(`〔交給主線｜${ledger().filter(x => x.event === r3.id && x.kind === 'escalation').at(-1).refs.handoff}〕交給主線：寫一行。\n（這件事交給你了：處理完由你回報 Joey 一次。）\n（排程 run 6917 的回執也交給你了：做完用 ~/.claude/tools/btcc-receipt complete 6917 回執；車道不會替這一輪回執。）`)
    await call(r3, 'receipt', { run_id: '6917', outcome: 'failed', happened: 'x', did: 'x', promised: '無', needs_main: 'x' }); await end(r3)
  } finally { delete process.env.LANES_BLOCK_FACTS }
  await m.kill()
}, 30000)

// ------------------------------------------------------------------ 5: closing check (kot.reflex.3)
const KOT_1356 = '【警報 critical】alert 1356：kot-bstocks / kot-tokyo-1 / bstocks_live.stopped_FUSE = FUSE\n真單程式自己停了：保險絲（累計虧到觸發線），部位已清（剩的不到最小名目）。已實現 -5.42215、手續費 0.349521、含未平 -5.771671、量 20348.22、部位 空手（狀態檔 2026-11-24 02:30:00.236）。現在要報 Joey；FUSE 之後不刪狀態檔、不重開，等他說。\n接收人：kot（建立者 kot；alert）。\n接手就把這張 ack（by=你）。'
const KOT_142 = 'bStocks 真單保險絲觸發，程式已停、部位已清（SOXLB 賣出 8.034 全成交，空手）。\n- 已實現 −5.42、手續費 0.35、含未平 −5.77（觸發線 −5.50）、量 20,348、38 趟來回。\n- 停機時間 2026-11-24 02:30Z。狀態檔保留，不重開，等你說。\n- 第二支 USDC/USDT 掛單仍在跑：已實現 +0.20、費 0、量 184,965、288 趟，未觸發保險絲（−2.00）。\n- 子帳整體權益 −4.56（保險絲 −5.5）。\n主線接手決定後續。'
test('WO-132 item 5, replay of kot.reflex.3 (alert 1356 critical): its notify_joey says 「主線接手決定後續」 with no hand-over: refused once with the hint; it hands over and the main is woken; LANES_BOUNDARY_CARD=0: the line goes out as on 11-24', async () => {
  const m = await mainUp()
  const k = sent.length
  const r = await start(alert('mesh-1795487426117-55ba', KOT_1356))
  expect(E().get(r.id)!.class).toBe('critical')
  await say(r.lane, [bash('systemctl is-active bstocks-live'), bash('cat state/bstocks_live_status.json'), bash('journalctl -u bstocks-live -n 20')].join('\n'))
  const out = await call(r, 'notify_joey', { outcome: 'changed', text: KOT_142 })
  expect(out).toBe(B.mainAskRefusal('notify_joey', '主線接手決定後續'))
  expect(sent.length).toBe(k)                                                                // nothing went to Joey
  expect(laneRows().filter(x => x.kind === 'main_ask_refused' && x.event === r.id)).toMatchObject([{ tool: 'notify_joey', phrase: '主線接手決定後續' }])
  expect(await call(r, 'handoff_main', { text: 'alert 1356 critical：bStocks 真單保險絲觸發，程式已停、部位已清（空手）。子帳權益 −4.56 離帳戶保險絲 −5.5 很近。要主線決定後續並報 Joey；alert 1356 要 ack。' })).toContain('handed to the main')
  const it = M().items(x => x.event === r.id && x.kind === 'handoff').at(-1)!
  expect(it).toBeTruthy()
  // the wake decision (11-24: 「no_wake: the run ended; the event owes nothing more」): owed to the main, the idle main is offered it
  expect(jsonl(join(dir, 'lanes', 'state.jsonl')).filter(w => w.rec === 'wake' && w.id === r.id).map(w => w.state)).toEqual(['wake'])
  expect(['queued', 'offered']).toContain(it.state)                                         // owed to the main (it takes its items oldest first)
  await end(r)
  // 11-24 the event's only wake line was the exit's no_wake; now the hand-over's wake comes first, the exit's no_wake (nothing more owed by the lane) after it
  expect(jsonl(join(dir, 'lanes', 'state.jsonl')).filter(w => w.rec === 'wake' && w.id === r.id).map(w => w.state)).toEqual(['wake', 'no_wake'])
  // the same run with the boundary card off: the line goes out (1.39.1)
  process.env.LANES_BOUNDARY_CARD = '0'
  try {
    const r2 = await start(alert('mesh-wo132-kot-off', KOT_1356.replace('alert 1356', 'alert 1356b')))
    const k2 = sent.length
    expect(await call(r2, 'notify_joey', { outcome: 'changed', text: KOT_142 })).toContain('sent to Joey')
    expect(sent.length - k2).toBe(1)
    await end(r2)
  } finally { delete process.env.LANES_BOUNDARY_CARD }
  // the words: kot.reflex.4 「要主線核對」, prometheus.reflex.4 「主線可再看」, prometheus.reflex.2 「主線有需要請補」; denials and the main's own past are not asks
  expect(B.mainAskPhrase('- 一個要主線核對的點：現在的啟動參數是 `--budget 340`。')).toBe('- 一個要主線核對的點：現在的啟動參數是 `--budget 340`')
  expect(B.mainAskPhrase('另外 /healthz 回 504，還沒確認這個路徑本來就該存在，主線可再看。')).toBe('另外 /healthz 回 504，還沒確認這個路徑本來就該存在，主線可再看')
  expect(B.mainAskPhrase('- 我沒有 ack 警報 1360，也沒登記 BTCC change，主線有需要請補。')).toBeTruthy()
  for (const t of ['我沒交給主線，自己處理完了。', '不用交給主線。', '主線已經修好了。', '主線正在處理這台。', 'I did not hand it to the main.',
    '錯誤原文：\n\n```\nPreToolUse:Write hook error: … or hand the change to the main with handoff_main.\n```']) expect(B.mainAskPhrase(t)).toBe('')   // a quoted hook error is not the lane's sentence
  await m.kill()
}, 30000)

// ------------------------------------------------------------------ 6: the de-duplication and the steps (cadmus.reflex.7)
test('WO-132 item 6, replay of cadmus.reflex.7 (run 6933): Joey already has the sec-patrol line, its notify_joey is dropped and the tool result says the step counts as done; the receipt with 「回報 Joey 一行」 done=false goes through, recorded as done; no hand-over', async () => {
  const PATROL = '資安巡檢 PASS：管理員 6（皆合法）、Pods 3.2.8.4、新 PHP 0、外掛新發布 0（落後 2、無安全相關）。攻擊特徵請求 2 筆／1 IP，已擋。'
  const STEPS = [{ step: 'ack', done: true }, { step: '跑 patrol.py', done: true, note: 'PASS' }, { step: '回報 Joey 一行', done: false, note: '被擋：同事項已有 normal 通知' }, { step: 'complete 回執', done: true, note: '由 receipt 完成' }]
  const a = await start(sched(6921, 'sec-patrol'))                                            // cadmus.reflex.2: the line Joey has
  expect(await call(a, 'notify_joey', { outcome: 'normal', text: '資安巡檢 PASS：管理員 6（全合法）。', service: 'blocktempo-main', check: 'sec-patrol' })).toContain('held for your receipt')
  expect(await call(a, 'receipt', { run_id: '6921', outcome: 'done', steps: STEPS.map(s => ({ ...s, done: true })), happened: 'PASS', did: '巡檢', promised: '無', needs_main: '無' })).toContain('sent to Joey')
  await end(a)
  const r = await start(sched(6933, 'sec-patrol'))
  const out = await call(r, 'notify_joey', { outcome: 'normal', text: PATROL, service: 'blocktempo-main', check: 'sec-patrol' })
  expect(out.startsWith('refused: Joey already has a line about blocktempo-main/sec-patrol with outcome normal')).toBe(true)
  expect(out.endsWith('（Joey 已經收過同一則，這一步算做了：receipt 的 steps 裡回報 Joey 的那一步填 done=true。）')).toBe(true)
  const rec = await call(r, 'receipt', { outcome: 'done', run_id: '6933', happened: '每日資安巡檢 PATROL PASS', did: '跑 patrol.py；notify_joey 被擋（同事已回報 normal，一件事一則）', promised: '無', needs_main: '無', steps: STEPS })
  expect(rec).toContain('receipt recorded')
  const row = ledger().filter(x => x.event === r.id && x.kind === 'receipt').at(-1)
  expect(row.text).toContain('步驟 4 步，都做了')
  expect(row.refs.steps[2]).toEqual({ step: '回報 Joey 一行', done: true, note: '被擋：同事項已有 normal 通知；Joey 已經收過同一則（通知被去重擋下），算做了' })
  expect(M().items(x => x.event === r.id).length).toBe(0)                                   // the main was not woken to send the line the dedupe held back
  const ex = await end(r)
  expect(ex).toMatchObject({ steps_marked: 4, steps_not_done: 0, receipt_refused: { missing_steps: 0, not_done_success: 0, cli_blocked: 0 } })
  // LANES_RECEIPT_STEPS=0: the refusal as before, nothing added
  process.env.LANES_RECEIPT_STEPS = '0'
  try {
    const r2 = await start(sched(6934, 'sec-patrol'))
    const out2 = await call(r2, 'notify_joey', { outcome: 'normal', text: PATROL, service: 'blocktempo-main', check: 'sec-patrol' })
    expect(out2).not.toContain('這一步算做了'); expect(out2.startsWith('refused: Joey already has a line about')).toBe(true)
    await call(r2, 'receipt', { run_id: '6934', outcome: 'done', happened: 'x', did: 'x', promised: '無', needs_main: '無' }); await end(r2)
  } finally { delete process.env.LANES_RECEIPT_STEPS }
}, 30000)

// ------------------------------------------------------------------ 7: the main's note reaches the lane (mail #11101)
test('WO-132 item 7, mail #11101: the main decides as_recommended with a note; the lane\'s run has 「主線附註：…」 (and so for changed and declined)', async () => {
  const NOTE = '主線已用 fleet 身分建好：schedule id 386（eurymedon，cron 0 9 * * *，tag eurymedon-expiry-check，內容照它信裡的 JSON 原樣）。回它這一行，另外告訴它：agent 端建排程要 require_scheduler 權限，agent 沒有這把；之後要建或改排程就寄信給 sonn。'
  const CARD = { decide: '是否由 sonn 代 eurymedon 在 BTCC scheduler 建這列每日到期檢查', recommend: '由主線用有 scheduler 權限的身分建並回 schedule id', then: '主線回決定後，我回信 eurymedon 一行 schedule id 或正確身分，並勾掉 #11101。' }
  const b = await start(alert('mesh-wo132-dec', '【警報 warning】alert 2201：netdata / dec-box / disk_space./ = 90%'))
  await call(b, 'notify_joey', { outcome: 'normal', text: 'dec-box 磁碟 90%。' }); await end(b)
  const base = st().lanes[b.lane]
  for (const [i, decision] of (['as_recommended', 'changed', 'declined'] as const).entries()) {
    const ev = decisionEvent({ id: 11101 + i * 10, lane: base.id, thread: base.thread, title: 'BTCC 排程：幫 eurymedon 建一列每日到期檢查（我這邊 POST 回 401）', decision, note: NOTE, card: CARD }) as any
    const r = await start(ev)
    expect(r.prompt).toContain(`主線附註：${NOTE}`)
    expect(r.prompt.indexOf('主線附註：')).toBeLessThan(r.prompt.indexOf('── 決定卡 ──'))
    await call(r, 'notify_joey', { outcome: 'changed', text: '已回 eurymedon：schedule id 386。' }); await end(r)
  }
  // no note: no line
  const ev = decisionEvent({ id: 11199, lane: base.id, thread: base.thread, title: 't', decision: 'as_recommended', card: CARD }) as any
  const r = await start(ev)
  expect(r.prompt).not.toContain('主線附註')
  await call(r, 'notify_joey', { outcome: 'changed', text: '照建議做完。' }); await end(r)
}, 30000)

// ------------------------------------------------------------------ 8: prod_change (recorded, never refused)
test('WO-132 item 8, replay of prometheus.reflex.2 and .3\'s commands: the exit row\'s prod_change lists the one command each sent that changed the production box (the dry-run does not count); nothing is refused; LANES_PROD_CHANGE=0: no field', async () => {
  process.env.LANES_INCIDENT_MERGE = '0'                                                     // as on 11-24: two lanes of their own
  st().alert_fp = {}
  try {
    const out: Record<string, any> = {}
    for (const [k, a] of [['reflex2', ALERTS[1]], ['reflex3', ALERTS[2]]] as const) {
      const r = await start(alert(`${a[1]}-pc`, a[2]))
      await say(r.lane, FIX[k].map(([, c]) => bash(c)).join('\n'))
      expect(await call(r, 'notify_joey', { outcome: 'changed', text: `${k}：已恢復` })).toContain('sent to Joey')
      out[k] = await end(r)
    }
    expect(out.reflex2.prod_change).toEqual([{ host: 'root@192.0.2.12', what: ['docker compose up', 'docker exec … nginx -s reload'], cmd: expect.stringContaining('docker compose $F up -d proxy') }])
    expect(out.reflex3.prod_change).toEqual([{ host: 'root@192.0.2.12', what: ['docker compose up'], cmd: expect.stringContaining('docker-compose.kbro-auth-edge.yml up -d 2>&1 | tail -5') }])
    expect(out.reflex3.prod_change[0].cmd).not.toContain('--dry-run')
    process.env.LANES_PROD_CHANGE = '0'
    st().alert_fp = {}
    const r = await start(alert(`${ALERTS[1][1]}-pc-off`, ALERTS[1][2]))
    await say(r.lane, FIX.reflex2.map(([, c]) => bash(c)).join('\n'))
    await call(r, 'notify_joey', { outcome: 'changed', text: 'x' })
    expect('prod_change' in (await end(r))).toBe(false)
  } finally { delete process.env.LANES_INCIDENT_MERGE; delete process.env.LANES_PROD_CHANGE }
  // the reading of a command: reads, local writes and scratch paths are not changes; restarts, writes, removals and copies to a remote are
  const rc = B.remoteChanges
  expect(rc(`ssh -i ~/.ssh/k -o BatchMode=yes root@h 'docker ps; docker logs --tail 5 x; systemctl is-active kbro-auth; ufw status; tail -5 /root/*.log'`)).toEqual([])
  expect(rc(`ssh root@h 'docker compose -f a.yml up -d --dry-run'`)).toEqual([])
  expect(rc(`ssh root@h 'rm -f /tmp/x.log'`)).toEqual([])
  expect(rc(`rm -rf build; docker compose up -d`)).toEqual([])                               // this machine, not another one
  expect(rc(`ssh -p 2222 admin@h "sudo systemctl restart nginx && echo ok"`)).toEqual([{ host: 'admin@h', what: ['systemctl restart'] }])
  expect(rc(`ssh h 'cd /opt/app && git pull && docker restart app; echo x > /etc/app.conf'`)).toEqual([{ host: 'h', what: ['git pull', 'docker restart', '> /etc/app.conf'] }])
  expect(rc(`scp -i k ./site.conf root@h:/etc/nginx/conf.d/`)).toEqual([{ host: 'root@h', what: ['scp to remote'] }])
  expect(rc(`scp -q -i k /tmp/chk.sh root@h:/tmp/ && ssh -i k root@h 'bash /tmp/chk.sh'`)).toEqual([])            // cadmus.reflex.8's check: a scratch copy, a script it runs
  expect(rc(`ssh root@h bash -s <<'EOF'\nset -e\nrm -rf /var/www/old\nEOF`)).toEqual([{ host: 'root@h', what: ['rm'] }])
}, 40000)

// ------------------------------------------------------------------ 5: the switches off, the words
test('WO-132 #5: with the boundary card off the lane card is 1.39.1\'s, byte for byte (the new words are the only difference)', () => {
  const on = (['reflex', 'mail', 'worker'] as const).map(k => L.identityCard({ kind: k }))
  process.env.LANES_BOUNDARY_CARD = '0'
  try {
    const off = (['reflex', 'mail', 'worker'] as const).map(k => L.identityCard({ kind: k }))
    for (const [i, c] of off.entries()) {
      expect(c).toContain('可以查、回覆別的 agent、做可逆的小處理、記帳。')
      expect(c).toContain('需要他決定就改用 ask_joey。不要為了「嚴重」而 handoff_main：主線會在摘要裡看到。')
      expect(c).toBe(on[i].replace(B.IDENTITY_SMALL_NEW, B.IDENTITY_SMALL_OLD).replace(B.CRITICAL_TAIL_NEW, B.CRITICAL_TAIL_OLD))
    }
  } finally { delete process.env.LANES_BOUNDARY_CARD }
})

