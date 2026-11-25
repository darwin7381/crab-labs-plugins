// WO-148 (telegram-http 1.50.0, Chiron; his recount of the first 100 runs after WO-144: claude-chiron/knowledge/lane-boundary-20261124/wo144-recount.md;
// Joey TG chiron:2257). Three changes:
//   1. the opening block: Joey's latest messages, each with the main's first reply, then the main's latest two; no system:* sender, no lane or router line;
//      ≤ 1,500 characters with the title; a resumed lane session gets only what it was never given (nothing new: one line)
//   2. a refusal holds for the rest of the run: angelia.reflex.13 (a receipt step refused as not done, then resent as done) and chiron.mail.3.r6 (「留給主線」
//      refused, then rewritten as 「純知會」) would now be refused again, without a model call, until the hand-over
//   3. a long turn's 「在處理」 is the main's newest activity (the open tool, its latest reply to Joey, its focus card), not the turn's first message
//      (sandwich-master.mail.2.r8: the turn ran 01:02Z–05:33Z)
// The router runs in this process: a real OnsenClient against a stand-in Onsen (a fake fetch), a stand-in lane binary that records each run's argv (and waits
// for the test when told to), a stand-in Jev, the mailbox and the mesh stubbed, the main a stand-in process driven through its hook events.
import { test, expect, afterAll, describe } from 'bun:test'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { OnsenClient, restartHead } from './onsen-client.ts'
process.env.LANES_FLOOD_CONTROL = '0'

// ------------------------------------------------------------------ Jev stand-in: same_matter 0.9 when the event and main_doing name the same matter (mock-api or 週報)
const jevCalls: any[] = []
const jev = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const body = await req.json() as any
  jevCalls.push(body)
  const keys = Object.keys(body.questions ?? {})
  const answers: Record<string, unknown> = {}
  if (keys.includes('same_matter')) {
    const ev = JSON.stringify(body.state?.event ?? ''), doing = String(body.state?.main_doing ?? '')
    const same = ['mock-api', '週報'].some(m => ev.includes(m) && doing.includes(m))
    answers.same_matter = { type: 'noul', noul: same ? 0.9 : 0.1 }
  } else for (const k of keys) answers[k] = { type: 'noul', noul: 0.03 }             // the promise check, the peer check: nothing found
  return Response.json({ model: 'jev-1.14.0', answers })
} })
process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${jev.port}`; process.env.TYPESAFE_API_KEY = 'k'

const L = await import('./lanes.ts?wo148') as typeof import('./lanes.ts')
const B = await import('./lanes-boundary.ts')
const AGENT = 'adam', JOEY = '1828', CRED = 'mesh_WO148testSECRETsecret0123456789'
const ws = mkdtempSync(join(tmpdir(), 'lanes-wo148-ws-'))
const dir = join(ws, '.lanes'); mkdirSync(dir)
const tmp = mkdtempSync(join(tmpdir(), 'lanes-wo148-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
const ARGV = join(tmp, 'argv.jsonl'), bin = join(tmp, 'lane.py'), HOLD = join(tmp, 'hold')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, sys, time
with open('${ARGV}', 'a') as f: f.write(json.dumps(sys.argv[1:]) + '\\n')
end = os.path.join('${tmp}', 'end-' + os.environ.get('LANE_ID', 'x'))
if os.path.exists('${HOLD}'):
  t0 = time.time()
  while time.time() - t0 < 60 and not os.path.exists(end): time.sleep(0.02)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restoreBin = L.__setClaudeBin(bin)

// ------------------------------------------------------------------ the stand-in Onsen: GET /messages as fleet-core answers it (newest first, limit, the restart line)
type Row = { id: number; at: string; sender: string; body: string; tg: number; dir?: 'in' | 'out' }
const onsen = { rows: [] as Row[], lines: [] as Array<{ id: number; at: string; chat: string }>, limits: [] as number[] }
const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } })
const fakeFetch = (async (input: any, init?: any) => {
  const u = new URL(String(input)), path = u.pathname.replace(/^\/api\/onsen/, '')
  if (init?.headers?.Authorization !== `Bearer ${CRED}`) return json(401, { error: 'no credential' })
  if (path === '/messages') {
    const limit = Number(u.searchParams.get('limit') ?? 20)
    onsen.limits.push(limit)
    const line = onsen.lines.at(-1) ?? null
    const all = onsen.rows.filter(r => !line || Date.parse(r.at) > Date.parse(line.at)).sort((a, b) => b.id - a.id)
    const rows = all.slice(0, limit)
    return json(200, { messages: rows.map(r => ({ id: r.id, at: r.at, direction: r.dir ?? (r.sender === `tg:${JOEY}` ? 'in' : 'out'), sender: r.sender, kind: 'text',
      body: [...r.body].length > 300 ? [...r.body].slice(0, 300).join('') : r.body, truncated: [...r.body].length > 300, edited: false, client_msg_id: String(r.tg),
      status: 'ok', chat: JOEY })), total: all.length, restart_line: line, restart_lines: line ? [line] : [], restart_line_applied: !!line })
  }
  return json(404, { error: 'no route' })
}) as typeof fetch
const oc = new OnsenClient({ dir: join(tmp, 'onsen'), base: 'https://onsen.test/api/onsen', agent: AGENT, record: true, credential: () => CRED, log: () => {}, fetch: fakeFetch,
  intervalMs: 3_600_000, queryTimeoutMs: 4000, joeyChat: () => JOEY })

// ------------------------------------------------------------------ the mailbox, the mesh, Telegram
const OPEN: Record<number, string> = {
  91001: '#91001 來自 chiron｜盤點：meetings 三段標成 txmonster\n要你：在盤點裡把 meetings 三段標成 txmonster\n期限 —｜等了 2 分鐘｜車道讀過\n\nchiron：meetings 那三段已經搬到 txmonster，盤點裡請改一下。',
  91002: '#91002 來自 lynceus｜mock-api p95 回到 180ms\n要你：知道就好\n期限 —｜等了 1 分鐘｜車道讀過\n\nlynceus：mock-api p95 回到 180ms，已恢復。',
  91003: '#91003 來自 eve｜週報 W48 數字\n要你：看一下\n期限 —｜等了 0 分鐘｜車道讀過\n\neve：週報 W48 的數字補好了。',
  91004: '#91004 來自 kairos｜要不要換 Haiku 6\n要你：決定要不要換\n期限 11-26 12:00Z｜等了 1 分鐘｜車道讀過\n\nkairos：Haiku 6 的價格表出來了，要不要換？',
  91005: '#91005 來自 kairos｜補充 #91004：Haiku 6 價格表（純知會）\n要你：知道就好\n期限 —｜等了 0 分鐘｜車道讀過\n\nkairos：補充 #91004 的價格表，純知會。',
}
const LIST = '3 封未讀、0 封已讀還沒勾掉：\n#91001｜chiron｜盤點：meetings 三段標成 txmonster｜要你：改盤點｜期限 —｜等了 2 分鐘｜未讀\n'
  + '#91002｜lynceus｜mock-api p95 回到 180ms｜要你：知道就好｜期限 —｜等了 1 分鐘｜未讀\n#91003｜eve｜週報 W48 數字｜要你：看一下｜期限 —｜等了 0 分鐘｜未讀'
const mailCalls: any[] = []
L.__setMailTool(async b => {
  mailCalls.push(b)
  if (b.name === 'mailbox_list') return { text: LIST, isError: false }
  if (b.name === 'mailbox_open') return OPEN[Number(b.args.id)] ? { text: OPEN[Number(b.args.id)], isError: false } : { text: '沒有這封信', isError: true }
  if (b.name === 'mailbox_check') return { text: `#${b.args.id} 勾掉了，不在清單上了。`, isError: false }
  if (b.name === 'mailbox_reply') return { text: `已回 #${b.args.id}`, isError: false, to: 'chiron' }
  return { text: 'ok', isError: false }
})
const meshed: any[] = []
L.__setMeshSend(async b => { meshed.push(b); return { msgId: 96000 + meshed.length, text: `sent to ${b.to}`, delivered: true } })
const toJoey: string[] = []
const open = new Set<string>()
L.lanesInit({ role: 'tg', agent: AGENT, workspaceDir: ws, transcriptDir: tmp, httpPort: 0, log: () => {}, authOk: () => true, registryNames: () => ['chiron', 'lynceus', 'eve'],
  notifySession: async (sid: string) => open.has(sid), streamOpen: (sid: string) => open.has(sid), toolsChanged: () => {},
  sendBot: async (_c: string, text: string) => { toJoey.push(text); return 8000 + toJoey.length }, joeyChatId: () => JOEY,
  mainChat: (a: any, o: any) => oc.queryHistory(a, 'hook', o) } as any)
const procs: any[] = []
afterAll(() => {
  try { rmSync(HOLD) } catch {}
  for (const id of Object.keys(L.__lanesState().lanes)) try { writeFileSync(join(tmp, `end-${id}`), 'END') } catch {}
  for (const p of procs) try { p.kill('SIGKILL') } catch {}
  jev.stop(true); L.__setClaudeBin(restoreBin); L.__setMailTool(null); L.__setMeshSend(null)
  for (const k of ['LANES_FLOOD_CONTROL', 'TYPESAFE_BASE_URL', 'TYPESAFE_API_KEY', 'LANES_MAIN_DOING_NEWEST_MIN', 'LANES_MAIN_DOING_NEWEST', 'LANES_REFUSAL_HOLD']) delete process.env[k]
  rmSync(ws, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 10000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const jsonl = (p: string): any[] => { try { return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const argvs = (): string[][] => jsonl(ARGV)
const spawns = (): any[] => jsonl(join(dir, 'lanes.jsonl')).filter(r => r.kind === 'spawn')
let n = 0
const reminder = () => { const text = '讀信箱（1 封未讀，最舊的等了 3 分鐘）：先用 mailbox_list'
  return { id: `mesh-wo148-${++n}`, source: 'mesh', from: 'fleet-watchdog', verified: true, text, meta: { no_reply: 'true' }, no_reply: true, wake: 'mail', line: 'mail',
    notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any }
/** one mail-lane run, start to end: its prompt and spawn row */
async function run(): Promise<{ lane: string; argv: string[]; prompt: string; spawn: any }> {
  const before = argvs().length, sBefore = spawns().length
  const d = await L.routeEvent(reminder())
  expect(d).toMatchObject({ target: 'lane' })
  expect(await until(() => spawns().length > sBefore && argvs().length > before)).toBe(true)
  expect(await until(() => !L.__runTok(d.lane!))).toBe(true)
  await sleep(30)
  const argv = argvs()[before]
  return { lane: d.lane!, argv, prompt: argv[argv.indexOf('-p') + 1], spawn: spawns()[sBefore] }
}
/** the block as it stands in a prompt: from its title (or the one-line note) to the blank line before the focus card */
const blockOf = (prompt: string): string[] => {
  const i = Math.max(prompt.indexOf(L.MAIN_CHAT_TITLE), prompt.indexOf(L.MAIN_CHAT_SAME))
  return i < 0 ? [] : prompt.slice(i, prompt.indexOf('\n\n# 焦點卡（', i)).split('\n')
}
const T0 = Date.parse('2026-11-25T01:00:00Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const hm = (min: number) => { const d = new Date(T0 + min * 60_000); return `11-25 ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z` }
let id = 0
const put = (min: number, sender: string, body: string, dir?: 'in' | 'out'): Row => { const r: Row = { id: ++id, at: at(min), sender, body, tg: 3000 + id, ...(dir ? { dir } : {}) }; onsen.rows.push(r); return r }
const J = `tg:${JOEY}`
const line = (r: Row, who: string, body = r.body) => `${hm((Date.parse(r.at) - T0) / 60_000)}｜${who}｜#${r.id} tg:${r.tg}｜${body}`

// ================================================================== 1. the opening block
describe('1. the opening block', () => {
  test('Joey\'s three messages and the main\'s first reply to each are there although the main then posted 12 progress lines; system:* rows never; ≤ 1,500 with the title; one query of 60', async () => {
    onsen.rows = []; onsen.lines = []
    const j1 = put(0, J, 'WO-150 的回測先暫停，等我看完數字')
    const r1 = put(1, 'main', '好，回測停在第 3 輪\n數字在 knowledge/wo150.md，看完跟我說')                     // its first line only
    put(1.2, 'main', '補充：第 3 輪的 p95 是 2.1s')                                                         // not the first reply: not shown
    put(1.5, 'system:status', '🟡 處理中（09:01 起）：Bash')
    put(2, 'adam.reflex.3', '〔reflex #3〕mock-api p95 回到 180ms，已恢復')
    const j2 = put(3, J, 'mock-api 的設定這週都別動')
    put(3.1, 'system:form-echo', '〔你在頁面送出的｜WO-150〕 ok')
    const r2 = put(4, 'main', '收到，mock-api 設定這週不動')
    put(4.5, 'router', '〔交給主線〕mail lane handed #11552')
    const j3 = put(5, J, '週報的格式照上週的')
    const r3 = put(6, 'main', '好，照上週的格式')
    const prog: Row[] = []
    for (let k = 0; k < 12; k++) { prog.push(put(7 + k, 'main', `進度 ${k + 1}/12：第 ${k + 1} 段做完`)); put(7.5 + k, 'system:status', `🟡 處理中：Edit ${k}`) }
    const r = await run()
    const b = blockOf(r.prompt)
    expect(b).toEqual([
      L.MAIN_CHAT_TITLE,
      line(j1, 'Joey'), line(r1, 'main', '好，回測停在第 3 輪…（全文用 id 取）'),
      line(j2, 'Joey'), line(r2, 'main'),
      line(j3, 'Joey'), line(r3, 'main'),
      line(prog[10], 'main'), line(prog[11], 'main'),                                                  // then the main's latest two
    ])
    expect(L.MAIN_CHAT_TITLE).toBe('# Joey 最近對主線說的，和主線怎麼回（系統從 Onsen 附的；更早的、全文：用 chat_history 查）')   // Chiron's words
    const text = b.join('\n'), body = b.slice(1).join('\n')
    expect(body).not.toContain('系統'); expect(body).not.toContain('處理中'); expect(body).not.toContain('你在頁面送出的')
    expect(body).not.toContain('adam.reflex.3'); expect(body).not.toContain('router'); expect(body).not.toContain('補充：第 3 輪')
    expect(text.length).toBeLessThanOrEqual(1500)
    expect(onsen.limits.at(-1)).toBe(60)
    expect(r.spawn).toMatchObject({ main_chat: 'onsen', main_chat_n: 8 })
    expect(r.spawn.main_chat_known).toBeUndefined()
    console.log(`\n--- sample block (WO-148, test 1) ---\n${text}\n---`)
  }, 20000)

  test('more than five of Joey\'s messages: the latest five with their replies; over 1,500: the oldest pair goes first, the main\'s latest two stay', async () => {
    onsen.rows = []; onsen.lines = []
    const js: Row[] = [], rs: Row[] = []
    for (let k = 0; k < 7; k++) { js.push(put(k * 2, J, `Joey ${k}：` + '話'.repeat(300))); rs.push(put(k * 2 + 1, 'main', `回 ${k}：` + '答'.repeat(300))) }
    const p1 = put(20, 'main', '進度 A：' + '進'.repeat(300)), p2 = put(21, 'main', '進度 B：' + '進'.repeat(300))
    const b = blockOf((await run()).prompt)
    expect(b.join('\n').length).toBeLessThanOrEqual(1500)
    const msgs = b.slice(1)
    expect(msgs.slice(-2).map(l => l.split('｜')[2])).toEqual([`#${p1.id} tg:${p1.tg}`, `#${p2.id} tg:${p2.tg}`])
    const pairs = msgs.slice(0, -2)
    expect(pairs.length % 2).toBe(0)
    const kept = pairs.length / 2
    expect(kept).toBeGreaterThan(0); expect(kept).toBeLessThan(5)                                       // five pairs and two would be over 1,500
    expect(pairs.map(l => l.split('｜')[2])).toEqual(js.slice(7 - kept).flatMap((j, k) => [`#${j.id} tg:${j.tg}`, `#${rs[7 - kept + k].id} tg:${rs[7 - kept + k].tg}`]))
    for (const l of msgs) expect(l.endsWith('…（全文用 id 取）')).toBe(true)
  }, 20000)

  test('WO-148 lab: Joey = the DM\'s human by direction: Onsen names him joey-test (the bench) or the human is rosie: their lines are picked; an outbound line under another name is not; the spool path as before', async () => {
    for (const who of ['joey-test', 'rosie']) {
      onsen.rows = []; onsen.lines = []
      const a = put(0, who, 'C1-甲：先查 mock-api', 'in'), ra = put(1, 'main', '收到甲')
      put(1.5, 'eve', '（一則 out 列，不是人說的）', 'out')
      const b = put(2, who, 'C1-乙：再查一次', 'in'), rb = put(3, 'main', '收到乙')
      expect(blockOf((await run()).prompt)).toEqual([L.MAIN_CHAT_TITLE, line(a, who), line(ra, 'main'), line(b, who), line(rb, 'main')])
      // 1.50.0 as the bench ran it (by the name 「Joey」, no direction): none of the human's lines, only the main's latest two
      const answer = await oc.queryHistory({ limit: 60 }, 'hook', { cut: 100 })
      expect(L.mainChatBlock(answer).lines).toEqual([L.MAIN_CHAT_TITLE, line(ra, 'main'), line(rb, 'main')])
      const inbound = new Set<string>()
      expect(L.mainChatBlock(await oc.queryHistory({ limit: 60 }, 'hook', { cut: 100, inbound }), inbound).lines).toEqual([L.MAIN_CHAT_TITLE, line(a, who), line(ra, 'main'), line(b, who), line(rb, 'main')])
      expect([...inbound].sort()).toEqual([`tg:${a.tg}`, `tg:${b.tg}`])
    }
  }, 30000)

  test('Joey\'s restart line: nothing before it, its head line kept; a Joey message with no reply yet stands alone', async () => {
    onsen.rows = []; onsen.lines = []
    put(0, J, '舊話題：WO-149 先放著'); put(1, 'main', '好，WO-149 放著')
    onsen.lines.push({ id: 88, at: at(2), chat: JOEY })
    const j = put(3, J, '重新開始：今天只做 WO-150'), r = put(4, 'main', '收到，只做 WO-150'), j2 = put(5, J, 'WO-150 先跑第一輪')
    const b = blockOf((await run()).prompt)
    expect(b).toEqual([L.MAIN_CHAT_TITLE, restartHead(at(2)), line(j, 'Joey'), line(r, 'main'), line(j2, 'Joey')])
    expect(b.join('\n')).not.toContain('WO-149')
  }, 20000)
})

// ================================================================== 1b. a resumed session
describe('1b. a resumed lane session', () => {
  test('a resumed run gets only the lines its session was never given; nothing new: one line; remembered in the lanes state (survives a restart)', async () => {
    onsen.rows = []; onsen.lines = []
    for (const l of Object.values(L.__lanesState().lanes)) delete (l as any).chat_seen        // as a new session
    const j1 = put(0, J, '先查 mock-api'), r1 = put(1, 'main', '在查 mock-api')
    const a = await run()
    expect(blockOf(a.prompt)).toEqual([L.MAIN_CHAT_TITLE, line(j1, 'Joey'), line(r1, 'main')])
    // the second run resumes the same session, nothing new in the conversation: one line, nothing repeated
    const b = await run()
    expect(b.lane).toBe(a.lane); expect(b.argv).toContain('--resume')
    expect(blockOf(b.prompt)).toEqual([L.MAIN_CHAT_SAME])
    expect(b.prompt).not.toContain('先查 mock-api')
    expect(b.spawn).toMatchObject({ main_chat: 'onsen', main_chat_n: 0, main_chat_known: 2 })
    // the third: Joey said more and the main answered: only those two lines, under the title
    const j2 = put(2, J, 'mock-api 修好了嗎'), r2 = put(3, 'main', '修好了，p95 180ms')
    const c = await run()
    expect(blockOf(c.prompt)).toEqual([L.MAIN_CHAT_TITLE, line(j2, 'Joey'), line(r2, 'main')])
    expect(c.spawn).toMatchObject({ main_chat_n: 2, main_chat_known: 2 })
    // remembered in the lanes state on disk: a daemon that boots from it (the lane as read back) gives that session nothing again
    const disk = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).lanes[c.lane]
    expect(disk.chat_seen.sid).toBe(disk.session_id)
    expect(disk.chat_seen.keys).toEqual([`tg:${j1.tg}`, `tg:${r1.tg}`, `tg:${j2.tg}`, `tg:${r2.tg}`])
    const answer = await oc.queryHistory({ limit: 60 }, 'hook', { cut: 100 })
    expect(L.chatForRun(JSON.parse(JSON.stringify(disk)), L.mainChatBlock(answer))!.lines).toEqual([L.MAIN_CHAT_SAME])
    // a new session (another lane, or the mail lane renewed) gets the whole block
    const fresh = { ...JSON.parse(JSON.stringify(disk)), id: 'adam.mail.99', session_id: randomUUID(), runs: 0, transcript: '' }
    expect(L.chatForRun(fresh, L.mainChatBlock(answer))!.lines).toEqual([L.MAIN_CHAT_TITLE, line(j1, 'Joey'), line(r1, 'main'), line(j2, 'Joey'), line(r2, 'main')])
  }, 30000)
})

// ================================================================== 2. a refusal holds for the run
/** a lane's run as the router leaves it (no process): its lane, its event in the queue, its token */
let f = 0
function fakeRun(kind: 'mail' | 'reflex', ev: Record<string, unknown> = {}): any {
  f += 1
  const lid = `adam.${kind}.h${f}`, thread = `adam#t-h${f}`
  L.__lanesState().lanes[lid] = { id: lid, kind, n: 100 + f, session_id: randomUUID(), thread, status: 'running', created: '', last: '', transcript: join(tmp, `h${f}.jsonl`), runs: 0, tokens_in: 0, tokens_out: 0 } as any
  L.__lanesState().threads[thread] = { id: thread, lane: lid, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
  const e: any = { id: `mesh-wo148h-${f}`, source: 'mesh', from: 'mailbox', verified: false, text: '讀信箱（3 封未讀）：先用 mailbox_list 看清單', meta: {}, notif: { method: '', params: {} }, ...ev }
  L.__putQueue({ ev: e, lane: lid, state: 'leased', lease_until: 0, attempts: 1, priority: 1, enqueued: '' })
  return { runId: `${lid}.r1`, lane: lid, evId: e.id, closers: [], critical: false, trigger: kind === 'mail' ? 'mail' : 'peer', cls: kind === 'mail' ? 'mail' : 'peer' }
}
const held = () => jsonl(join(dir, 'lanes.jsonl')).filter(r => r.kind === 'refusal_held')

describe('2. a refusal holds for the run', () => {
  test('chiron.mail.3.r6: 「留給主線」 without handoff_main is refused; the reworded 「純知會」 is refused again without a model call; after handoff_main the hold is lifted', async () => {
    const tok = fakeRun('mail')
    await L.callLaneTool(tok, 'mailbox_list', {})
    await L.callLaneTool(tok, 'mailbox_open', { id: 91001 })
    const j0 = jevCalls.length, t0 = toJoey.length
    const said = '讀了 1 封：#91001 chiron 要改盤點 meetings 三段，這件我沒做，留給主線。', phrase = B.mainAskPhrase(said)
    expect(phrase).toBe('讀了 1 封：#91001 chiron 要改盤點 meetings 三段，這件我沒做，留給主線')
    const first = await L.callLaneTool(tok, 'notify_joey', { outcome: 'normal', text: said })
    expect(first).toBe(B.mainAskRefusal('notify_joey', phrase))
    expect(first).toContain('這一趟在交給主線之前，notify_joey／ask_joey 都不會送出，拿掉或改寫那一句也一樣。')   // it names the action; no 「把那一句拿掉，再送一次」
    expect(first).not.toContain('把那一句拿掉，再送一次')
    // the rewording of 08:22Z: 「純知會」 — refused again, the same check's text, nothing asked, nothing sent
    const again = await L.callLaneTool(tok, 'notify_joey', { outcome: 'normal', text: '讀了 1 封：#91001 chiron 的盤點更新，純知會。' })
    expect(again).toBe(B.mainAskHeld(phrase))
    expect(again).toContain('先用 handoff_main 交給它')
    const ask = await L.callLaneTool(tok, 'ask_joey', { text: '#91001 要不要改盤點？' })                // ask_joey is a line to Joey too
    expect(ask).toBe(again)
    expect(jevCalls.length).toBe(j0); expect(toJoey.length).toBe(t0)
    expect(held().filter(r => r.run === tok.runId).map(r => [r.check, r.tool, r.n])).toEqual([['main_ask', 'notify_joey', 1], ['main_ask', 'ask_joey', 2]])
    // the action it asked for: the hand-over goes through, and the next line is judged as usual again (the matter is the main's now: M3 says so)
    expect(await L.callLaneTool(tok, 'handoff_main', { text: '#91001 chiron：盤點裡把 meetings 三段標成 txmonster（主線的檔），交給你。' })).toStartWith('handed to the main:')
    const after = await L.callLaneTool(tok, 'notify_joey', { outcome: 'normal', text: '讀了 1 封：#91001 交給主線了。' })
    expect(after).not.toBe(again); expect(after).toContain('this event is handed to the main')
    expect(held().filter(r => r.run === tok.runId).length).toBe(2)
    expect(await L.callLaneTool(tok, 'receipt', { outcome: 'done', happened: '讀信 1 封', did: '#91001 交給主線', promised: '無', needs_main: '#91001 改盤點' })).toStartWith('receipt recorded')
  })

  test('LANES_REFUSAL_HOLD=0: as 1.49.0, the reworded line goes out', async () => {
    process.env.LANES_REFUSAL_HOLD = '0'
    try {
      const tok = fakeRun('mail')                                                                 // #91001 is with the main now (the test above handed it over): #91002
      await L.callLaneTool(tok, 'mailbox_open', { id: 91002 })
      const first = await L.callLaneTool(tok, 'notify_joey', { outcome: 'normal', text: '#91002 這件我沒做，留給主線。' })
      expect(first).toContain('不需要主線的：把那一句拿掉，再送一次。這個提醒一趟只有一次。')
      expect(await L.callLaneTool(tok, 'notify_joey', { outcome: 'normal', text: '#91002 純知會。' })).toContain('sent to Joey')
    } finally { delete process.env.LANES_REFUSAL_HOLD }
  })

  test('angelia.reflex.13: a receipt step refused as not done, resent as done with a reason: refused again (its steps are not read again); after handoff_main the receipt goes through', async () => {
    const tok = fakeRun('reflex', { from: 'lynceus', text: 'mock-api 的建置推進一下，跑完回我', line: 'mail' })
    const steps = (two: boolean, note2: string) => [{ step: '線路健康', done: true, note: '110 ok / 2 降級' }, { step: '推進建置', done: two, note: note2 }, { step: '回 Joey', done: true }]
    const first = await L.callLaneTool(tok, 'receipt', { outcome: 'done', happened: 'x', did: 'x', promised: '無', needs_main: '無', steps: steps(false, '本輪未推進，只做檢查') })
    expect(first).toBe(B.stepsRefusal('done', steps(false, '本輪未推進，只做檢查') as any))
    expect(first).toContain('這一趟在交給主線之前，結果填 done、ok、normal 的回執都不會記錄，把沒做的步驟改寫成 done 也一樣。')
    // 05:47:41Z: step ② rewritten as done, 「條件沒成立」 — refused again, naming the action
    const again = await L.callLaneTool(tok, 'receipt', { outcome: 'done', happened: 'x', did: 'x', promised: '無', needs_main: '無', steps: steps(true, '本輪無可推進的項目，條件沒成立') })
    expect(again).toBe(B.stepsHeld('第 2 步「推進建置」（本輪未推進，只做檢查）'))
    expect(again).toContain('先 handoff_main 把那幾步交給主線'); expect(again).toContain('把那幾步改寫成 done 不算。')
    expect(await L.callLaneTool(tok, 'receipt', { outcome: 'ok', happened: 'x', did: 'x', promised: '無', needs_main: '無' })).toBe(again)   // any success, steps or not
    expect(jsonl(join(dir, 'ledger.jsonl')).filter(r => r.kind === 'receipt' && r.event === tok.evId).length).toBe(0)
    expect(tok.receiptRefused).toMatchObject({ not_done_success: 3 })
    // the action: hand the step to the main; then the receipt goes through with its steps as they are
    expect(await L.callLaneTool(tok, 'handoff_main', { text: '推進建置這一步我接不住：要主線看 TaskList 和設計檔再推。' })).toStartWith('handed to the main:')
    expect(await L.callLaneTool(tok, 'receipt', { outcome: 'done', happened: 'x', did: 'x', promised: '無', needs_main: '推進建置', steps: steps(false, '交給主線') })).toStartWith('receipt recorded')
    expect(jsonl(join(dir, 'ledger.jsonl')).filter(r => r.kind === 'receipt' && r.event === tok.evId).at(-1).text).toContain('沒做：第 2 步「推進建置」（交給主線）')
  })

  test('the receipt hold: outcome failed (partly done) is judged as usual; a report step not done is met by a line to Joey', async () => {
    const a = fakeRun('reflex', { from: 'lynceus', text: '跑一下檢查', line: 'mail' })
    const st = [{ step: '檢查', done: true }, { step: '推進建置', done: false, note: '接不住' }]
    await L.callLaneTool(a, 'receipt', { outcome: 'done', happened: 'x', did: 'x', promised: '無', needs_main: '無', steps: st })
    expect(await L.callLaneTool(a, 'receipt', { outcome: 'failed', happened: 'x', did: '檢查做了；推進建置沒做', promised: '無', needs_main: '無', steps: st })).toStartWith('receipt recorded')
    const b = fakeRun('reflex', { from: 'lynceus', text: '跑一下檢查並回報 Joey', line: 'mail' })
    const rs = (done: boolean) => [{ step: '檢查', done: true }, { step: '回報 Joey', done }]
    const r1 = await L.callLaneTool(b, 'receipt', { outcome: 'done', happened: 'x', did: 'x', promised: '無', needs_main: '無', steps: rs(false) })
    expect(r1).toContain('沒做的是回報 Joey：用 notify_joey 送出，那一步就算做了。')
    expect(await L.callLaneTool(b, 'receipt', { outcome: 'done', happened: 'x', did: 'x', promised: '無', needs_main: '無', steps: rs(true) })).toContain('用 notify_joey 送出，那一步就算做了')
    expect(await L.callLaneTool(b, 'notify_joey', { outcome: 'changed', text: '檢查做完：p95 從 2.6s 回到 180ms。' })).toContain('sent to Joey')
    expect(await L.callLaneTool(b, 'receipt', { outcome: 'done', happened: 'x', did: 'x', promised: '無', needs_main: '無', steps: rs(true) })).toStartWith('receipt recorded')
  })

  test('the claims check holds too: 「已轉給主線」 to a peer, then 「收到」 to the same peer: refused again until handoff_main', async () => {
    const tok = fakeRun('reflex', { from: 'eve', text: 'mock-api 的設定我可以改嗎？', line: 'call', btcc_msg_id: '12001' })
    const r1 = await L.callLaneTool(tok, 'reply_agent', { to: 'eve', text: '這件已轉給主線處理。' })
    expect(r1).toContain('not sent: your message says the matter was (or will be) passed to Joey or the main')
    expect(r1).toContain('Until one of them is done in this run, reply_agent is refused again, whatever its wording.')
    const m0 = meshed.length
    expect(await L.callLaneTool(tok, 'reply_agent', { to: 'eve', text: '收到。' })).toContain('earlier in this run your reply_agent said the matter was passed to Joey or the main')
    expect(meshed.length).toBe(m0)
    expect(await L.callLaneTool(tok, 'handoff_main', { text: 'Eve 問能不能改 mock-api 設定（這週 Joey 說別動）：要主線答。' })).toStartWith('handed to the main:')
    expect(await L.callLaneTool(tok, 'reply_agent', { to: 'eve', text: '我這邊先不動，主線會回你。' })).not.toContain('earlier in this run')
  })
})

describe('2b. a matter already with the main is no false claim (WO-148 lab, point 3)', () => {
  test('an earlier run put a card on mail #91004; a new run says 「留給主線」 about #91004: not refused, not held, the line goes out; a mail with no card is still refused', async () => {
    const a = fakeRun('mail')
    await L.callLaneTool(a, 'mailbox_open', { id: 91004 })
    expect(await L.callLaneTool(a, 'mailbox_card', { id: 91004, card: { decide: '要不要換 Haiku 6', deadline: '2026-11-26T12:00:00Z', facts: 'kairos 的價格表', recommend: '換', after: '回 kairos' } }))
      .toContain('It can wait')
    // the bench's r5: the next run reads the 純知會 about #91004 and says the decision stays with the main
    const b = fakeRun('mail')
    await L.callLaneTool(b, 'mailbox_open', { id: 91005 })
    const t0 = toJoey.length
    const r = await L.callLaneTool(b, 'notify_joey', { outcome: 'normal', text: '讀了 1 封：#91005 是 #91004 的補充（純知會），已勾掉。這件的決定仍留給主線（#91004 決定卡在主線信箱）。' })
    expect(r).toContain('sent to Joey'); expect(toJoey.length).toBe(t0 + 1)
    const rows = jsonl(join(dir, 'lanes.jsonl')).filter(x => x.run === b.runId)
    expect(rows.filter(x => x.kind === 'main_ask_refused' || x.kind === 'refusal_held')).toEqual([])
    expect(rows.find(x => x.kind === 'main_ask_matter_with_main')).toMatchObject({ phrase: '這件的決定仍留給主線（#91004 決定卡在主線信箱）', by: expect.stringContaining('card on #91004') })
    // a mail nobody carded or handed over: refused, and the refusal holds
    const c = fakeRun('mail')
    await L.callLaneTool(c, 'mailbox_open', { id: 91005 })
    expect(await L.callLaneTool(c, 'notify_joey', { outcome: 'normal', text: '#91005 這件留給主線。' })).toBe(B.mainAskRefusal('notify_joey', '#91005 這件留給主線'))
    // once the card is decided or checked off, #91004 no longer waits on the main
    L.mailChecked(91004, 'main')
    const d = fakeRun('mail')
    await L.callLaneTool(d, 'mailbox_open', { id: 91005 })
    expect(await L.callLaneTool(d, 'notify_joey', { outcome: 'normal', text: '#91004 的決定仍留給主線。' })).toStartWith('沒有送出：這一則 notify_joey 說主線會接手')
  })
})

// ================================================================== 3. a long turn's 「在處理」 is the newest
const JOEY_WEEKLY = '週報那件事你來處理：先整理 W48 的數字，跑完再跟我說週報信你打算怎麼處理'
const CMD = 'curl -s -H "Authorization: Bearer sk-live-9f3a77c01d4e" https://mock-api.internal/health | jq .p95'
// WO-148 lab: lanes-hooks/main-hook.py run as Claude Code runs it, against a stand-in for the daemon's /lanes/main-event: what it posts
const HOOK = join(import.meta.dir, 'lanes-hooks', 'main-hook.py')
async function mainHookPosts(payload: object, pid?: number): Promise<any> {
  const got: any[] = []
  const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { got.push(await req.json()); return Response.json({}) } })
  const tokDir = join(tmp, `hooktok-${srv.port}`); mkdirSync(tokDir, { recursive: true }); writeFileSync(join(tokDir, String(srv.port)), 'tok\n')
  try {
    const h = Bun.spawn(['python3', HOOK], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', TELEGRAM_HTTP_PORT: String(srv.port),
      MCP_TOKEN_DIR: tokDir, CLAUDE_PID: pid ? String(pid) : '', PYTHONDONTWRITEBYTECODE: '1', TYPESAFE_API_KEY: '', TYPESAFE_KEY_FILE: '/nonexistent' } })
    h.stdin.write(JSON.stringify(payload)); h.stdin.end()
    await new Response(h.stdout).text(); expect(await h.exited).toBe(0)
    return got[0] ?? null
  } finally { srv.stop(true) }
}
describe('3a. the main\'s hook carries what the open tool is about', () => {
  test('every PreToolUse posts tool_brief (the field the call is about, cut to 300); tool_input stays as it was: a btcc-receipt Bash, send_to_agent\'s line; a subagent\'s call posts no brief', async () => {
    const edit = await mainHookPosts({ hook_event_name: 'PreToolUse', session_id: 's', prompt_id: 'p', tool_name: 'Edit', tool_input: { file_path: 'notes/a.md', old_string: 'x', new_string: 'y' } }, 4242)
    expect(edit).toMatchObject({ event: 'PreToolUse', tool_name: 'Edit', pid: 4242, tool_brief: { file_path: 'notes/a.md' } }); expect(edit.tool_input).toBeUndefined()
    const long = await mainHookPosts({ hook_event_name: 'PreToolUse', session_id: 's', prompt_id: 'p', tool_name: 'Bash', tool_input: { command: 'x'.repeat(500) } })
    expect(long.tool_brief.command.length).toBe(300); expect(long.tool_timeout_ms).toBe(120000)
    const rc = await mainHookPosts({ hook_event_name: 'PreToolUse', session_id: 's', prompt_id: 'p', tool_name: 'Bash', tool_input: { command: '~/.claude/tools/btcc-receipt complete 7004 --outcome ok' } })
    expect(rc.tool_input).toEqual({ command: '~/.claude/tools/btcc-receipt complete 7004 --outcome ok' })   // the receipt check reads it, unchanged
    expect(rc.tool_brief).toEqual({ command: '~/.claude/tools/btcc-receipt complete 7004 --outcome ok' })
    const send = await mainHookPosts({ hook_event_name: 'PreToolUse', session_id: 's', prompt_id: 'p', tool_name: 'mcp__plugin_agent-inbox_agent-inbox__send_to_agent',
      tool_input: { line: 'mail', to: 'eve', title: 't', ask: 'a', text: '週報補好了' } })
    expect(send.tool_input).toEqual({ line: 'mail', to: 'eve', reply_to: null, no_reply: null }); expect(send.tool_brief).toEqual({ title: 't' })
    const none = await mainHookPosts({ hook_event_name: 'PreToolUse', session_id: 's', prompt_id: 'p', tool_name: 'TodoWrite', tool_input: { todos: [] } })
    expect(none.tool_brief).toBeUndefined()
    const sub = await mainHookPosts({ hook_event_name: 'PreToolUse', session_id: 's', prompt_id: 'p', agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'ls' } })
    expect(sub).toMatchObject({ sub: true }); expect(sub.tool_brief).toBeUndefined()
    expect(L.toolWhat({ command: CMD })).toBe('curl -s -H "Authorization: Bearer …" https://mock-api.internal/health | jq .p95')
    expect(L.toolWhat({ command: 'export TYPESAFE_API_KEY=abc123 && echo token: xyz && gh auth ghp_abcdefghij1234' })).toBe('export TYPESAFE_API_KEY=… && echo token: … && gh auth …')
  }, 30000)
})
describe('3. main_doing takes the newest', () => {
  test('a turn longer than the threshold that switched matters: the gate\'s Jev payload carries the open tool, the latest reply to Joey and the focus card (the new matter), not the turn\'s first message', async () => {
    process.env.LANES_MAIN_DOING_NEWEST_MIN = '0.05'                                                   // 3 s stands for the 10 minutes
    try {
      const p = Bun.spawn(['sleep', '600']); procs.push(p)
      const sid = randomUUID(); writeFileSync(join(dir, 'main-expected'), sid); open.add(`mcp-${p.pid}`); L.__noteMcpPid(`mcp-${p.pid}`, p.pid)
      const hook = (event: string, o: object = {}) => L.__mainEvent({ event, pid: p.pid, session_id: sid, ...o } as any)
      await hook('SessionStart', { source: 'startup' })
      // the turn opens on Joey's 週報 message (01:02Z in sandwich-master's case)
      const item = L.__main().enqueue('joey', { method: 'notifications/claude/channel', params: { content: JOEY_WEEKLY, meta: { chat_id: JOEY, user: 'joey' } } }, { event: null })
      await hook('UserPromptSubmit', { prompt_id: 'p-long', dids: [item] })
      expect(L.mainTurnNow()).toMatchObject({ doing: JOEY_WEEKLY, from: 'turn' })                     // a young turn: as before
      // the turn moves on to the mock-api incident: a reply to Joey, the focus card, the tool open now
      L.mainReplied(null, 777, undefined, '先放下另一件：mock-api p95 2600ms，我在修，修好跟你說', JOEY)
      writeFileSync(join(dir, 'focus.md'), '進行中：mock-api 事故（p95 2600ms）\n之後：W48 的數字\n別碰：mock-api 設定\n第四行不讀\n')
      // the main's real hook (lanes-hooks/main-hook.py) posts the PreToolUse: WO-148 lab: its tool_brief carries the command (1.50.0 sent nothing but the name)
      const posted = await mainHookPosts({ hook_event_name: 'PreToolUse', session_id: sid, prompt_id: 'p-long', tool_name: 'Bash',
        tool_input: { command: CMD, description: 'mock-api health' } }, p.pid)
      expect(posted.tool_brief).toEqual({ command: CMD }); expect(posted.tool_input).toBeUndefined()      // tool_input as before: only for a btcc-receipt Bash
      await L.__mainEvent(posted)
      expect(L.mainTurnNow()!.from).toBe('turn')
      await sleep(3100)
      const now = L.mainTurnNow()!
      expect(now.from).toBe('newest')
      expect(now.doing).toMatch(/^正在用 Bash：curl -s -H "Authorization: Bearer …" https:\/\/mock-api\.internal\/health \| jq \.p95（自 \d\d:\d\d 起）；最近回 Joey（\d\d:\d\d）：先放下另一件：mock-api p95 2600ms，我在修，修好跟你說；焦點卡：進行中：mock-api 事故（p95 2600ms） \/ 之後：W48 的數字 \/ 別碰：mock-api 設定$/)
      expect(now.doing).not.toContain('週報'); expect(now.doing).not.toContain('第四行')
      expect(now.doing.length).toBeLessThanOrEqual(L.MAIN_SAME_DOING_MAX)
      expect(now.doing).not.toContain('sk-live')                                                     // the token in the command is masked
      expect(L.mainNowLine()).toContain('在處理：正在用 Bash：curl -s -H "Authorization: Bearer …"')      // the 此刻 line reads the same field (cut at 80)
      // a mail-lane run: the mail on the mock-api incident is the matter the main is on now: refused; the 週報 mail is not (it was the turn's first message)
      const tok = fakeRun('mail')
      await L.callLaneTool(tok, 'mailbox_open', { id: 91002 }); await L.callLaneTool(tok, 'mailbox_open', { id: 91003 })
      const j0 = jevCalls.length
      const refused = await L.callLaneTool(tok, 'mailbox_check', { id: 91002 })
      expect(refused).toBe(B.mainSameMatterRefusal(now.doing))
      const q = jevCalls.slice(j0).find(c => c.questions?.same_matter)!
      expect(q.state.main_doing).toBe(now.doing)
      expect(q.state.main_doing).toContain('mock-api'); expect(q.state.main_doing).not.toContain('週報那件事你來處理')
      expect(q.state.setting).toContain('long turn'); expect(q.state.setting).toContain('the tool it has open, its latest reply to Joey, its focus card')
      expect(Object.keys(q.state).sort()).toEqual(['event', 'main_doing', 'setting'])
      expect(await L.callLaneTool(tok, 'mailbox_check', { id: 91003 })).toBe('#91003 勾掉了，不在清單上了。')
      const jc = jsonl(join(dir, 'run', 'jev-calls.jsonl')).filter(r => r.site === 'main-same-matter-WO144').at(-2)
      expect(jc.inputs).toMatchObject({ subject: 'mail:91002', doing_from: 'newest' })
      // the tool closed: the open tool leaves 「在處理」; the reply and the focus card stay
      await hook('PostToolUse', { prompt_id: 'p-long', tool_name: 'Edit', tool_input: {}, tool_response: 'ok' })
      expect(L.mainTurnNow()!.doing).toStartWith('最近回 Joey（')
      // LANES_MAIN_DOING_NEWEST=0: the turn's items, as 1.49.0 (by now the tool boundary pulled the hand-overs of part 2 into this turn: 「…（另有 N 件）」)
      process.env.LANES_MAIN_DOING_NEWEST = '0'
      try {
        const old = L.mainTurnNow()!
        expect(old.from).toBe('turn'); expect(old.doing).toMatch(/（另有 \d+ 件）$/); expect(old.doing).not.toContain('最近回 Joey')
      } finally { delete process.env.LANES_MAIN_DOING_NEWEST }
      // the main left its turn: the hold keeps the refused mail refused until the run hands it over (no Jev call)
      await hook('Stop', { prompt_id: 'p-long', phase: 'final' })
      expect(L.mainTurnNow()).toBeNull()
      const j1 = jevCalls.length
      expect(await L.callLaneTool(tok, 'mailbox_check', { id: 91002 })).toBe(refused)
      expect(jevCalls.length).toBe(j1)
      expect(await L.callLaneTool(tok, 'handoff_main', { text: '#91002 lynceus：mock-api p95 回到 180ms（主線在修這件）。' })).toStartWith('handed to the main:')
      expect(await L.callLaneTool(tok, 'mailbox_check', { id: 91002 })).toBe('#91002 勾掉了，不在清單上了。')
      await hook('SessionEnd'); p.kill('SIGKILL')
    } finally { delete process.env.LANES_MAIN_DOING_NEWEST_MIN }
  }, 30000)
})
