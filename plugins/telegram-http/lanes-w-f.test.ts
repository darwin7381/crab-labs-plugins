// 002w (F): every outbound text goes through one check. The tier of a lane's line comes from the class of the event it meets (a Joey message steered
// into a scheduled run is answered at his tier; a Joey run on a critical lane is not told 嚴重警報); ONE promise check runs on every outbound text (a lane's
// reply_agent and notify_joey, the main's send_to_agent and Telegram reply) and puts a promise on the event's M3 record, not only the ledger; and the C16
// claims check runs on the main's send_to_agent as on its reply. Jev is a local stand-in; a waiting lane script; no model. Each test names its path and gap.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
let jev: any, jevCalls: any[] = []
beforeAll(() => {
  jev = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const b: any = await req.json(); jevCalls.push(b)
    const q = b.questions ?? {}
    if (q.promises) return Response.json({ answers: { promises: { type: 'noul', noul: 0.93 }, deadline: { type: 'noul', noul: 0.9 } } })
    if (q.S1) return Response.json({ answers: Object.fromEntries(Object.keys(q).map(k => [k, { type: 'choice', choice: 'contradicts', confidence: 0.95 }])) })
    return Response.json({ answers: {} })
  } })
  process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${jev.port}`; process.env.TYPESAFE_API_KEY = 'k'
})
process.env.LANES_FLOOD_CONTROL = '0'; process.env.LANES_PEER_DISCLOSURE_CHECK = '0'
const L = await import('./lanes.ts?w-f-test') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-w-f-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
const GO = join(dir, 'go'), bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, time
t0 = time.time()
while time.time() - t0 < 60 and not os.path.exists('${GO}'): time.sleep(0.02)
try: os.remove('${GO}')
except OSError: pass
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
const meshOut: any[] = [], sent: Array<{ text: string; silent: boolean }> = []
L.__setMeshSend(async b => { meshOut.push(b); return { text: `sent to ${b.to}`, msgId: 66000 + meshOut.length, delivered: true } })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: (a: string | undefined) => a === 'Bearer t0k', registryNames: () => ['eve'],
  sendBot: async (_c: string, text: string, o: any) => { sent.push({ text, silent: !!o?.silent }); return 6100 + sent.length }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const procs: any[] = []
afterAll(() => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } try { writeFileSync(GO, 'ok') } catch {}; L.__setClaudeBin(restore); jev.stop(true); delete process.env.TYPESAFE_BASE_URL; delete process.env.TYPESAFE_API_KEY
  delete process.env.LANES_FLOOD_CONTROL; delete process.env.LANES_PEER_DISCLOSURE_CHECK })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const E = () => L.__events(), st = L.__lanesState()
const ledger = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const cms = () => ledger().filter(r => r.kind === 'commitment')
let n = 0
const mk = (from: string, text: string, extra: object = {}) => ({ id: `mesh-wf-${++n}`, source: 'mesh', from, verified: true, text, btcc_msg_id: String(67000 + n), meta: {}, notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } }, ...extra } as any)
async function laneRun(ev: any) { const d = await L.routeEvent(ev); expect(d.target).toBe('lane'); expect(await until(() => !!L.__runTok(d.lane!))).toBe(true); return { lane: d.lane!, tok: L.__runTok(d.lane!)! } }
async function done(lane: string) { writeFileSync(GO, 'ok'); await until(() => !L.__runTok(lane)); await sleep(30) }

test('002w F, gap 14, path notify_joey about Joey\'s message in a scheduled run: the tier is his event\'s (joey: push), not the run\'s class (scheduled: silent)', async () => {
  const r = await laneRun(mk('scheduler', '[scheduled][backup-check][run:9701][P3][routine] 檢查備份', { meta: { run_id: '9701' } }))
  E().open('tg-1-9702', { class: 'joey', owner: r.lane, lane: r.lane, from: 'joey', text: '備份順便看一下大小', obligations: [{ kind: 'joey', level: 'line' }], fields: { tg: { message_id: '9702', topic: null } } })
  L.__runSteer(r.lane, { id: 'tg-1-9702', source: 'telegram', from: 'joey', text: '備份順便看一下大小', meta: { message_id: '9702', chat_id: '1' }, notif: { method: '', params: {} } } as any)
  const k = sent.length
  expect(await L.callLaneTool(r.tok, 'notify_joey', { outcome: 'normal', text: '備份 12GB，正常。' })).toContain('sent to Joey')
  expect((E().get('tg-1-9702')!.obligations as any[]).find(o => o.kind === 'joey').state).toBe('met')
  expect(sent[k].silent).toBe(false)                                                                     // 2a936a7: the run's class (scheduled) made it silent
  await done(r.lane)
})

test('002w F, gap 14, path the lane\'s context block: a Joey run on a critical lane is not told 嚴重警報; the critical alert itself is', () => {
  const lane = { id: 'adam.reflex.77', kind: 'reflex', n: 77, thread: 'adam#t-77', critical: true } as any
  const joeyEv = { id: 'tg-1-9711', source: 'telegram', from: 'joey', text: '這種半夜不用叫我', meta: {}, notif: { method: '', params: {} } } as any
  const alertEv = { id: 'mesh-9712', source: 'mesh', from: 'alert-dispatcher', text: '[P1][critical] backup 全掛', trigger: 'alert-critical', meta: {}, notif: { method: '', params: {} } } as any
  expect(L.laneContext(lane, { ev: joeyEv })).not.toContain('嚴重警報')
  expect(L.laneContext(lane, { ev: alertEv })).toContain('分流器標記：嚴重警報')
})

test('002w F, gap 16, path a lane\'s reply_agent in a peer run: the promise is checked and put on the event\'s record (2a936a7: only a Joey run\'s relay was recorded)', async () => {
  const r = await laneRun(mk('eve', '報告什麼時候好？'))
  const k = cms().length
  expect(await L.callLaneTool(r.tok, 'reply_agent', { to: 'eve', text: '週五 12:00 前給你完整報告。' })).toContain('sent to eve')
  expect(await until(() => cms().length === k + 1)).toBe(true)
  expect(cms().at(-1)).toMatchObject({ lane: r.lane, event: r.tok.evId, refs: { from: 'lane-send', auto: true, who: 'eve' } })
  expect(E().get(r.tok.evId)!.promised).toEqual([cms().at(-1).text])
  await done(r.lane)
})

test('002w F, gap 16, path a lane\'s notify_joey: what it tells Joey it will do is a commitment on the event (2a936a7: not checked)', async () => {
  const r = await laneRun(mk('eve', 'mock-api 的 p95 怎麼了？'))
  const k = cms().length
  expect(await L.callLaneTool(r.tok, 'notify_joey', { outcome: 'changed', text: 'p95 升到 900ms，我 10 分鐘後再查一次並回報。' })).toContain('sent to Joey')
  expect(await until(() => cms().length === k + 1)).toBe(true)
  expect(cms().at(-1).refs).toMatchObject({ who: 'joey', from: 'lane-send' })
  expect(E().get(r.tok.evId)!.promised?.length).toBe(1)
  await done(r.lane)
})

const outbound = async (b: object) => {
  const req: any = Object.assign((async function* () { yield Buffer.from(JSON.stringify(b)) })(), { method: 'POST', headers: { authorization: 'Bearer t0k' } })
  const res: any = { writeHead: () => res, end: () => {} }
  await L.handleLanesHttp(new URL('http://127.0.0.1/lanes/outbound'), req, res)
}
async function mainTurnWith(evIds: string[]) {
  const proc = Bun.spawn(['sleep', '600'], { stdout: 'ignore', stderr: 'ignore' }); procs.push(proc)
  const sid = `00000000-0000-4000-8000-${String(proc.pid).padStart(12, '0')}`
  writeFileSync(join(dir, 'main-expected'), sid)
  await L.__mainEvent({ event: 'SessionStart', pid: proc.pid, session_id: sid })
  const prompt = `pf-${Math.random()}`
  await L.__mainEvent({ event: 'UserPromptSubmit', pid: proc.pid, prompt_id: prompt, dids: L.__main().items(r => r.state !== 'done' && evIds.includes(String(r.event))).map(r => r.id) })
  return { prompt, pid: proc.pid, stop: async () => { await L.__mainEvent({ event: 'Stop', pid: proc.pid, prompt_id: prompt, phase: 'final' }); await L.__mainEvent({ event: 'SessionEnd', pid: proc.pid }); proc.kill('SIGKILL') } }
}

test('002w F, gap 16, path the main\'s send_to_agent: its promise goes on the record of the event the turn works on (2a936a7: the ledger only)', async () => {
  const meta = { chat_id: '1', message_id: '9721', user: 'joey_lab' }
  await L.routeEvent({ id: 'tg-1-9721', source: 'telegram', from: 'joey', text: '跟 eve 說週四給她', meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: '跟 eve 說週四給她', meta } } } as any)
  const m = await mainTurnWith(['tg-1-9721'])
  const k = cms().length
  await outbound({ msgId: 69001, owner: 'main', to: 'eve', text: 'Joey 說週四前給你。', thread: null })
  expect(await until(() => cms().length === k + 1)).toBe(true)
  expect(cms().at(-1).refs).toMatchObject({ from: 'main-send', who: 'eve' })
  expect(E().get('tg-1-9721')!.promised).toEqual([cms().at(-1).text])
  await m.stop()
})

test('002w F, gap 16, path the main\'s Telegram reply: what it tells Joey it will do is checked and put on the event (2a936a7: never checked)', async () => {
  const meta = { chat_id: '1', message_id: '9731', user: 'joey_lab' }
  await L.routeEvent({ id: 'tg-1-9731', source: 'telegram', from: 'joey', text: '幫我查帳單', meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: '幫我查帳單', meta } } } as any)
  const m = await mainTurnWith(['tg-1-9731'])
  const k = cms().length
  L.mainReplied(L.mainReplyTier({}), 9732, undefined, '收到，今天 18:00 前查完回你。')
  expect(await until(() => cms().length === k + 1)).toBe(true)
  expect(cms().at(-1).refs).toMatchObject({ from: 'main-send', who: 'joey' })
  expect(E().get('tg-1-9731')!.promised?.length).toBe(1)
  await m.stop()
})

test('002w F, gap 18, path the main\'s send_to_agent at PreToolUse: the daemon hands the turn and main-hook runs the C16 claims check on it, as on a reply (2a936a7: never checked)', async () => {
  const meta = { chat_id: '1', message_id: '9741', user: 'joey_lab' }
  await L.routeEvent({ id: 'tg-1-9741', source: 'telegram', from: 'joey', text: '重啟 mock-api 後告訴 eve', meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: '重啟 mock-api 後告訴 eve', meta } } } as any)
  const m = await mainTurnWith(['tg-1-9741'])
  await L.__mainEvent({ event: 'PostToolUse', pid: m.pid, prompt_id: m.prompt, tool_name: 'Bash', tool_input: { command: './bin/svc POST mock-api/restart' }, tool_response: '{"error":"forbidden"}', tool_error: false })
  const pre = await L.__mainEvent({ event: 'PreToolUse', pid: m.pid, prompt_id: m.prompt, tool_name: 'mcp__plugin_agent-inbox_agent-inbox__send_to_agent', tool_input: { to: 'eve', text: '我已經重啟了 mock-api。' } })
  expect(pre.turn?.prompt_id).toBe(m.prompt)                                                              // the turn, as for a reply
  const srv = createServer((req, res) => { void L.handleLanesHttp(new URL(req.url ?? '/', 'http://127.0.0.1'), req, res) })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  const tokDir = mkdtempSync(join(tmpdir(), 'lanes-w-f-tok-')), port = (srv.address() as AddressInfo).port
  writeFileSync(join(tokDir, String(port)), 't0k')
  const payload = { hook_event_name: 'PreToolUse', session_id: 's-f', prompt_id: m.prompt, tool_name: 'mcp__plugin_agent-inbox_agent-inbox__send_to_agent', tool_input: { to: 'eve', text: '我已經重啟了 mock-api。' }, cwd: dir }
  const proc = Bun.spawn(['python3', join(import.meta.dir, 'lanes-hooks', 'main-hook.py')], { stdin: new Blob([JSON.stringify(payload)]), stdout: 'pipe',   // async: the daemon answers it in this process
    env: { ...process.env, TELEGRAM_HTTP_PORT: String(port), MCP_TOKEN_DIR: tokDir, CLAUDE_PID: String(m.pid), LANES_DIR: dir, MAIN_REPLY_CHECK: '1', SUMMARY_GATE_JEV: '1' } as any })
  const stdout = await new Response(proc.stdout).text(); await proc.exited
  srv.close()
  const out = JSON.parse(stdout || '{}')
  expect(out.hookSpecificOutput?.permissionDecision).toBe('deny')
  expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('我已經重啟了 mock-api')
  await m.stop()
})
