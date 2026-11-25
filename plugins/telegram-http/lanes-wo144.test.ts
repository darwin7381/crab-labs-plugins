// WO-144 (telegram-http 1.46.0, Chiron; Joey TG chiron:2257): lanes often could not decide because they did not know the main's ongoing conversation with
// Joey. Every lane run's opening now carries it, attached by the program from Onsen (chat_history's own query: this agent's chat with Joey, Joey's restart
// line applied, the daemon's spool when Onsen is silent), after 「此刻」 and before the focus card; the boundary card says to look at it before judging.
// Part 1: the router in this process, a real OnsenClient against a stand-in Onsen (a fake fetch) wired as server.ts wires it, a stand-in lane binary that
// records every run's argv (the opening is the prompt after -p). Part 2: a real Telegram daemon (server.ts, lanes on) against a stand-in Onsen server: the
// wiring, end to end. Nothing reaches core.kbro.ai.
// WO-148 (telegram-http 1.50.0): the block holds Joey's latest messages with the main's first reply to each, and the main's latest two (the selection's own
// tests: lanes-wo148.test.ts); a resumed session gets only what is new. These tests reset the lane's memory of what its session was given (reset()), so
// each one starts as a new session would.
import { test, expect, afterAll, describe } from 'bun:test'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OnsenClient, inboundItem, outboundRecord, restartHead } from './onsen-client.ts'
import { startBotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, freePort } from './test-fixtures/tg-daemon.ts'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?wo144') as typeof import('./lanes.ts')
const B = await import('./lanes-boundary.ts')

const AGENT = 'adam', JOEY = '1828', CRED = 'mesh_WO144testSECRETsecret0123456789'   // a real credential's shape (mesh-identity.ts CRED_RE: the daemon reads it)
const dir = mkdtempSync(join(tmpdir(), 'lanes-wo144-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
writeFileSync(join(dir, 'focus.md'), '進行中：WO-150 回測。別碰：mock-api 設定。\n')
const ARGV = join(dir, 'argv.jsonl'), bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, sys
with open('${ARGV}', 'a') as f: f.write(json.dumps(sys.argv[1:]) + '\\n')
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restoreBin = L.__setClaudeBin(bin)
L.__setMailTool(async () => ({ text: '0 封未讀', isError: false }))

// ------------------------------------------------------------------ the stand-in Onsen: GET /messages as fleet-core answers it (newest first, limit, the restart line)
type Row = { id: number; at: string; sender: string; body: string; tg: number; chat?: string }
const onsen = { rows: [] as Row[], lines: [] as Array<{ id: number; at: string; chat: string }>, calls: [] as Array<{ path: string; via: string; auth: string }>,
  down: false, hang: false }
const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } })
const fakeFetch = (async (input: any, init?: any) => {
  const u = new URL(String(input)), path = u.pathname.replace(/^\/api\/onsen/, '')
  onsen.calls.push({ path: path + u.search, via: init?.headers?.['X-Onsen-Via'] ?? '', auth: init?.headers?.Authorization ?? '' })
  if (onsen.hang) return new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }))))
  if (onsen.down) throw new TypeError('fetch failed: connect ECONNREFUSED')
  if (init?.headers?.Authorization !== `Bearer ${CRED}`) return json(401, { error: 'no credential' })
  if (path === '/messages') {
    const chat = u.searchParams.get('chat') ?? JOEY, limit = Number(u.searchParams.get('limit') ?? 20)
    const line = onsen.lines.filter(l => l.chat === chat).at(-1) ?? null
    const all = onsen.rows.filter(r => (r.chat ?? JOEY) === chat && (!line || Date.parse(r.at) > Date.parse(line.at))).sort((a, b) => b.id - a.id)
    const rows = all.slice(0, limit)
    return json(200, { messages: rows.map(r => ({ id: r.id, at: r.at, direction: r.sender === 'joey' ? 'in' : 'out', sender: r.sender, kind: 'text',
      body: [...r.body].length > 300 ? [...r.body].slice(0, 300).join('') : r.body, truncated: [...r.body].length > 300, edited: false, client_msg_id: String(r.tg),
      status: 'ok', chat })), total: all.length, restart_line: line, restart_lines: line ? [line] : [], restart_line_applied: !!line })
  }
  return json(404, { error: 'no route' })
}) as typeof fetch
const mkClient = (d: string, cred: string | null = CRED) => new OnsenClient({ dir: d, base: 'https://onsen.test/api/onsen', agent: AGENT, record: true,
  credential: () => cred, log: () => {}, fetch: fakeFetch, intervalMs: 3_600_000, queryTimeoutMs: 4000, joeyChat: () => JOEY })
let oc = mkClient(join(dir, 'onsen'))
/** how the dep answers: 'client' = server.ts's wiring (queryHistory, via hook, the opening's bounds); 'throw' / 'never' = a broken dep */
let depMode: 'client' | 'throw' | 'never' = 'client'
const depCalls: Array<{ a: any; o: any }> = []

L.lanesInit({ role: 'tg', agent: AGENT, workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async () => 1, joeyChatId: () => JOEY,
  mainChat: (a: any, o: any) => {
    depCalls.push({ a, o })
    if (depMode === 'throw') throw new Error('boom')
    if (depMode === 'never') return new Promise<string>(() => {})
    return oc.queryHistory(a, 'hook', o)
  } } as any)
afterAll(() => { L.__setClaudeBin(restoreBin); L.__setMailTool(null); delete process.env.LANES_FLOOD_CONTROL; delete process.env.LANES_MAIN_CHAT_TIMEOUT_MS
  rmSync(dir, { recursive: true, force: true }) })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 10000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const argvs = (): string[][] => { try { return readFileSync(ARGV, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const spawns = (): any[] => { try { return readFileSync(join(dir, 'lanes.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.kind === 'spawn') } catch { return [] } }
let n = 0
const reminder = () => { const text = '讀信箱（1 封未讀，最舊的等了 70 分鐘）：先用 mailbox_list'
  return { id: `mesh-wo144-${++n}`, source: 'mesh', from: 'fleet-watchdog', verified: true, text, meta: { no_reply: 'true' }, no_reply: true, wake: 'mail', line: 'mail',
    notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any }
type Run = { lane: string; argv: string[]; prompt: string; spawn: any; ms: number }
/** one mail-lane run, start to end */
async function run(): Promise<Run> {
  const before = argvs().length, sBefore = spawns().length
  const t0 = Date.now()
  const d = await L.routeEvent(reminder())
  expect(d).toMatchObject({ target: 'lane' })
  expect(await until(() => spawns().length > sBefore)).toBe(true)
  const ms = Date.now() - t0
  expect(await until(() => argvs().length > before)).toBe(true)
  expect(await until(() => !L.__runTok(d.lane!))).toBe(true)
  await sleep(30)
  const argv = argvs()[before]
  return { lane: d.lane!, argv, prompt: argv[argv.indexOf('-p') + 1], spawn: spawns()[sBefore], ms }
}
/** the block as it stands in a prompt: from its title to the blank line before the focus card */
const blockOf = (prompt: string): string[] => {
  const i = prompt.indexOf(L.MAIN_CHAT_TITLE)
  if (i < 0) return []
  return prompt.slice(i, prompt.indexOf('\n\n# 焦點卡（', i)).split('\n')
}
const at = (min: number) => new Date(Date.parse('2026-11-25T01:00:00Z') + min * 60_000).toISOString()
const hm = (min: number) => { const d = new Date(Date.parse('2026-11-25T01:00:00Z') + min * 60_000); return `11-25 ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z` }
let id = 0
const put = (min: number, sender: string, body: string, chat?: string): Row => { const r = { id: ++id, at: at(min), sender, body, tg: 2200 + id, ...(chat ? { chat } : {}) }; onsen.rows.push(r); return r }
let gen = 0
const reset = () => { onsen.rows = []; onsen.lines = []; onsen.calls = []; onsen.down = false; onsen.hang = false; depMode = 'client'; id = 0; oc = mkClient(join(dir, `onsen-${++gen}`))
  for (const l of Object.values(L.__lanesState().lanes)) delete (l as any).chat_seen }   // WO-148: as a new session (the ids above start again at 2201)

describe('part 1: the router', () => {
  test('the opening: the title, then Joey\'s messages and the main\'s answers in chat_history\'s line format, oldest to newest, after 此刻 and before the focus card; the query is chat_history\'s (Joey\'s chat, counted as a hook)', async () => {
    reset()
    put(0, 'joey', 'WO-150 的回測先暫停，等我看完數字')
    put(1, 'main', '好，回測停在第 3 輪，數字在 knowledge/wo150.md')
    put(2, 'adam.reflex.3', '〔reflex #3〕mock-api p95 回到 180ms，已恢復')
    put(3, 'joey', 'mock-api 的設定這週都別動\n等 Eve 的報告')
    put(4, 'main', 'x', '-100777')                                         // another chat: not this block's
    const r = await run()
    expect(blockOf(r.prompt)).toEqual([
      '# Joey 最近對主線說的，和主線怎麼回（系統從 Onsen 附的；更早的、全文：用 chat_history 查）',
      `${hm(0)}｜Joey｜#1 tg:2201｜WO-150 的回測先暫停，等我看完數字`,
      `${hm(1)}｜main｜#2 tg:2202｜好，回測停在第 3 輪，數字在 knowledge/wo150.md`,
      `${hm(3)}｜Joey｜#4 tg:2204｜mock-api 的設定這週都別動 ⏎ 等 Eve 的報告`,                     // WO-148: a lane's line is not in the block
    ])
    const p = r.prompt
    expect(p.indexOf('# 此刻（')).toBeGreaterThan(p.indexOf('〔車道資訊｜'))
    expect(p.indexOf(L.MAIN_CHAT_TITLE)).toBeGreaterThan(p.indexOf('# 此刻（'))
    expect(p.indexOf('# 焦點卡（主線寫的，你只能讀）')).toBeGreaterThan(p.indexOf(L.MAIN_CHAT_TITLE))
    expect(p).toContain(`這一隻此刻沒有別的分身在跑\n\n${L.MAIN_CHAT_TITLE}\n`)                        // right after 此刻
    expect(p).toContain(`等 Eve 的報告\n\n# 焦點卡（主線寫的，你只能讀）\n進行中：WO-150 回測。`)          // right before the focus card, which is as it was
    const q = onsen.calls.find(c => c.path.startsWith('/messages?'))!
    expect(q.via).toBe('hook'); expect(q.auth).toBe(`Bearer ${CRED}`)
    expect(Object.fromEntries(new URL(`https://x${q.path}`).searchParams)).toEqual({ agent: AGENT, limit: '60', chat: JOEY })   // WO-148: a window of 60 to choose from
    expect(depCalls.at(-1)).toEqual({ a: { limit: 60 }, o: { timeoutMs: 2100, cut: 100 } })
    expect(r.spawn).toMatchObject({ main_chat: 'onsen', main_chat_n: 3 })
  }, 20000)

  test('long bodies cut at 100 with chat_history\'s mark; Joey\'s latest five with their answers; the whole block ≤ 1,500 characters with the oldest pair dropped first', async () => {
    reset()
    for (let i = 0; i < 14; i++) put(i, i % 2 ? 'main' : 'joey', `第 ${i} 則 短`)
    const a = blockOf((await run()).prompt)
    expect(a.length).toBe(11)
    expect(a[1]).toContain('｜第 4 則 短'); expect(a[10]).toContain('｜第 13 則 短')                    // Joey 4, 6, 8, 10, 12 and the answers 5…13, oldest first
    reset()
    for (let i = 0; i < 14; i++) put(i, i % 2 ? 'main' : 'joey', `${i}號：` + '長'.repeat(500))
    put(14, 'main', '14號：' + '長'.repeat(500)); put(15, 'main', '15號：' + '長'.repeat(500))          // the main's latest two: not answers
    const r = await run()
    const b = blockOf(r.prompt)
    expect(b.join('\n').length).toBeLessThanOrEqual(1500)
    expect(b[0]).toBe(L.MAIN_CHAT_TITLE)
    const msgs = b.slice(1)
    const nums = msgs.map(l => Number(/｜(\d+)號：/.exec(l)![1]))
    expect(nums.slice(-2)).toEqual([14, 15])                                                          // the main's latest two are kept
    expect(nums.slice(0, -2)).toEqual(Array.from({ length: nums.length - 2 }, (_, k) => 14 - (nums.length - 2) + k))   // the newest pairs, contiguous: the oldest went
    expect(nums.length).toBeLessThan(12)                                                              // five pairs and two would be over 1,500
    for (const l of msgs) {
      expect(l.endsWith('…（全文用 id 取）')).toBe(true)
      const body = l.split('｜').slice(3).join('｜').replace('…（全文用 id 取）', '')
      expect([...body].length).toBe(100)
    }
    expect(r.spawn).toMatchObject({ main_chat: 'onsen', main_chat_n: msgs.length })
  }, 30000)

  test('Joey\'s restart line is active: only the messages after it, with chat_history\'s line at the top (counted in the 1,500)', async () => {
    reset()
    put(0, 'joey', '舊話題：WO-149 先放著')
    put(1, 'main', '好，WO-149 放著')
    onsen.lines.push({ id: 77, at: at(2), chat: JOEY })
    put(3, 'joey', '重新開始：今天只做 WO-150')
    put(4, 'main', '收到，只做 WO-150')
    const b = blockOf((await run()).prompt)
    expect(b).toEqual([L.MAIN_CHAT_TITLE, restartHead(at(2)), `${hm(3)}｜Joey｜#3 tg:2203｜重新開始：今天只做 WO-150`, `${hm(4)}｜main｜#4 tg:2204｜收到，只做 WO-150`])
    expect(b.join('\n')).not.toContain('WO-149')
    // nothing after the line yet: the line, and that there is nothing
    reset()
    put(0, 'joey', '舊的')
    onsen.lines.push({ id: 78, at: at(1), chat: JOEY })
    expect(blockOf((await run()).prompt)).toEqual([L.MAIN_CHAT_TITLE, restartHead(at(1)), L.MAIN_CHAT_EMPTY])
  }, 20000)

  test('Onsen down: the daemon\'s spool answers (its first line says so, the restart lines it drew applied); neither: （這一趟取不到） and the run starts', async () => {
    reset()
    const tg = (mid: number, text: string) => ({ message_id: mid, date: Math.floor(Date.parse(at(mid)) / 1000), chat: { id: Number(JOEY), type: 'private' },
      from: { id: Number(JOEY), is_bot: false, first_name: 'J' }, text })
    oc.recordMessage(inboundItem(AGENT, tg(10, '本機記下的：WO-150 暫停'), '本機記下的：WO-150 暫停'))
    oc.recordLine(outboundRecord(AGENT, { sender: 'main' } as any, 'sendMessage', { chat_id: JOEY, text: '好，暫停' }, { message_id: 11, date: Math.floor(Date.parse(at(10.2)) / 1000) }))
    onsen.down = true
    const r = await run()
    const b = blockOf(r.prompt)
    expect(b[0]).toBe(L.MAIN_CHAT_TITLE)
    expect(b[1]).toMatch(/^（Onsen 連不上（.*）：以下是這個常駐程式本機暫存的紀錄，只有它自己記下的，可能不完整）$/)
    expect(b.slice(2)).toEqual([`${hm(10)}｜Joey｜tg:10｜本機記下的：WO-150 暫停`, `${hm(10.2)}｜main｜tg:11｜好，暫停`])
    expect(r.spawn).toMatchObject({ main_chat: 'spool', main_chat_n: 2 })
    // a restart line drawn while Onsen is down (lines.json) cuts the spool's answer the same way
    await oc.drawLine({ chat: JOEY, clientMsgId: 12, by: `tg:${JOEY}`, at: at(10.5) })
    oc.recordMessage(inboundItem(AGENT, tg(13, '線之後的一則'), '線之後的一則'))
    const c = blockOf((await run()).prompt)
    expect(c.slice(2)).toEqual([restartHead(at(10.5)), `${hm(13)}｜Joey｜tg:13｜線之後的一則`])
    // Onsen down and nothing in the spool; no credential and nothing in the spool; the dep throwing: the one line, and the run starts
    reset(); onsen.down = true
    const d = await run()
    expect(blockOf(d.prompt)).toEqual([L.MAIN_CHAT_TITLE, L.MAIN_CHAT_NONE])
    expect(d.spawn).toMatchObject({ main_chat: 'none', main_chat_n: 0 })
    reset(); oc = mkClient(join(dir, 'onsen-nocred'), null)
    expect(blockOf((await run()).prompt)).toEqual([L.MAIN_CHAT_TITLE, L.MAIN_CHAT_NONE])
    reset(); depMode = 'throw'
    expect(blockOf((await run()).prompt)).toEqual([L.MAIN_CHAT_TITLE, L.MAIN_CHAT_NONE])
  }, 30000)

  test('a hanging Onsen does not hold the start past the timeout: the spool answers within it; a dep that never answers: （這一趟取不到） at the timeout', async () => {
    process.env.LANES_MAIN_CHAT_TIMEOUT_MS = '1000'
    try {
      reset()
      oc.recordMessage(inboundItem(AGENT, { message_id: 20, date: Math.floor(Date.parse(at(20)) / 1000), chat: { id: Number(JOEY), type: 'private' }, from: { id: Number(JOEY) },
        text: '本機的一則' }, '本機的一則'))
      onsen.hang = true
      const a = await run()
      expect(a.ms).toBeGreaterThanOrEqual(650)                                                     // Onsen got its 700 ms
      expect(a.ms).toBeLessThan(1000 + 1500)                                                       // the timeout, with room for a loaded machine
      expect(blockOf(a.prompt)[1]).toMatch(/^（Onsen 1 秒內沒回應：以下是這個常駐程式本機暫存的紀錄/)
      expect(blockOf(a.prompt)[2]).toBe(`${hm(20)}｜Joey｜tg:20｜本機的一則`)
      expect(depCalls.at(-1)!.o).toEqual({ timeoutMs: 700, cut: 100 })
      reset(); depMode = 'never'
      const b = await run()
      expect(b.ms).toBeGreaterThanOrEqual(950)
      expect(b.ms).toBeLessThan(1000 + 1500)
      expect(blockOf(b.prompt)).toEqual([L.MAIN_CHAT_TITLE, L.MAIN_CHAT_NONE])
      expect(L.__chatFetching()).toBe(0)
    } finally { delete process.env.LANES_MAIN_CHAT_TIMEOUT_MS }
  }, 30000)

  test('every run gets it, a resumed one included, fetched afresh (WO-148: only what is new); it is not part of the lane card: card_hash and the card-update block do not see it', async () => {
    reset()
    put(0, 'joey', '第一趟之前的話')
    const hash = L.cardHash('mail')
    const a = await run()
    const b0 = blockOf(a.prompt)
    put(1, 'joey', '兩趟之間 Joey 又說了一則')
    const b = await run()
    expect(b.lane).toBe(a.lane)
    expect(b.argv).toContain('--resume')
    expect(blockOf(b.prompt)).toEqual([L.MAIN_CHAT_TITLE, `${hm(1)}｜Joey｜#2 tg:2202｜兩趟之間 Joey 又說了一則`])   // WO-148: the session has the first one
    expect(b0).toEqual([L.MAIN_CHAT_TITLE, `${hm(0)}｜Joey｜#1 tg:2201｜第一趟之前的話`])
    expect(b.prompt).not.toContain(L.CARD_UPDATED_HEAD)
    expect(L.__lanesState().lanes[a.lane].card_hash).toBe(hash)
    expect(L.identityCard({ kind: 'mail' })).not.toContain('Joey 最近對主線說的')
    const sys = b.argv[b.argv.indexOf('--append-system-prompt-file') + 1]
    expect(readFileSync(sys, 'utf8')).not.toContain(L.MAIN_CHAT_TITLE)
    process.env.LANES_MAIN_CHAT = '0'
    try { for (const k of ['reflex', 'mail', 'worker', 'fork'] as const) { const off = L.cardHash(k); delete process.env.LANES_MAIN_CHAT; expect(L.cardHash(k)).toBe(off); process.env.LANES_MAIN_CHAT = '0' } }
    finally { delete process.env.LANES_MAIN_CHAT }
  }, 20000)

  test('the boundary card: Chiron\'s sentence right before the 「沒把握」 line, in the default card and in the one built from .lanes/boundary.md, with either 「沒把握」 line', async () => {
    const LOOK = '判斷之前：先看上面「Joey 最近對主線說的，和主線怎麼回」；跟這件事有關的不夠，用 chat_history 搜（工單編號、標題裡的詞）。Joey 在對話裡已經講定的事，照他講的做，回報或交回時附那一則的編號。但書：對話裡還在談、沒有講定的，不算；主線正在回合中而且在處理同一件事（看上面「此刻」），交給主線，不跟它同時動手。'
    expect(B.BOUNDARY_LOOK_LINE).toBe(LOOK)
    const card = B.boundaryDefault(AGENT)
    expect(card.length).toBe(12)
    expect(card[card.indexOf(B.BOUNDARY_DEFER_LINE) - 1]).toBe(LOOK)
    expect(card.filter(l => l === LOOK).length).toBe(1)
    process.env.LANES_DEFER_DECISIONS = '0'
    try { const old = B.boundaryDefault(AGENT); expect(old[old.indexOf('沒把握：交給主線，不猜著做完。') - 1]).toBe(LOOK) } finally { delete process.env.LANES_DEFER_DECISIONS }
    writeFileSync(join(dir, 'boundary.md'), '- 讀者低於標準線就是異常，交給我\n')
    try {
      const f = B.boundaryCard(AGENT, dir)
      expect(f.source).toBe('file')
      expect(f.text).toContain(`${LOOK}\n${B.BOUNDARY_DEFER_LINE}\n`)
      expect(f.text.endsWith('- 讀者低於標準線就是異常，交給我')).toBe(true)
      reset(); put(0, 'joey', '一則')
      const r = await run()
      expect(r.prompt).toContain(`${LOOK}\n${B.BOUNDARY_DEFER_LINE}\n`)
      expect(r.prompt.indexOf(LOOK)).toBeGreaterThan(r.prompt.indexOf(L.MAIN_CHAT_TITLE))         // 「上面」: the block is above it
    } finally { rmSync(join(dir, 'boundary.md')) }
    expect(B.boundaryCard(AGENT, dir).text).toContain(`${LOOK}\n${B.BOUNDARY_DEFER_LINE}\n`)
  }, 20000)

  test('LANES_MAIN_CHAT=0: no block, no sentence, nothing fetched; the opening is otherwise the same', async () => {
    const lane = { id: 'adam.reflex.900', kind: 'reflex', n: 900, session_id: 's900', thread: 'adam#t-900', status: 'idle', created: '', last: '', transcript: '', runs: 1, tokens_in: 0, tokens_out: 0 } as any
    const it = { ev: { id: 'mesh-wo144-ctx', source: 'mesh', from: 'eve', text: 'x', meta: {}, notif: { method: '', params: {} } } } as any
    const chat = L.mainChatBlock(`${hm(0)}｜Joey｜#1 tg:1｜一則\n共 1 則，顯示 1 則`)
    const on = L.laneContext(lane, it, [], undefined, chat)
    expect(on).toContain(`\n\n${L.MAIN_CHAT_TITLE}\n${hm(0)}｜Joey｜#1 tg:1｜一則\n\n# 焦點卡`)
    process.env.LANES_MAIN_CHAT = '0'
    try {
      expect(B.boundaryDefault(AGENT)).not.toContain(B.BOUNDARY_LOOK_LINE)
      expect(B.boundaryDefault(AGENT).length).toBe(11)
      const off = L.laneContext(lane, it, [], undefined, null)
      expect(off).toBe(on.replace(`\n\n${chat.lines.join('\n')}`, '').replace(`${B.BOUNDARY_LOOK_LINE}\n`, ''))
      reset(); put(0, 'joey', '一則')
      const k = onsen.calls.length, dk = depCalls.length
      const r = await run()
      expect(r.prompt).not.toContain(L.MAIN_CHAT_TITLE); expect(r.prompt).not.toContain('判斷之前：')
      expect(onsen.calls.length).toBe(k); expect(depCalls.length).toBe(dk)
      expect('main_chat' in r.spawn).toBe(false)
    } finally { delete process.env.LANES_MAIN_CHAT }
  }, 20000)

  test('the block from chat_history\'s answer: an error text or nothing is （這一趟取不到）; Onsen\'s empty list is （沒有訊息）', () => {
    expect(L.mainChatBlock(null).lines).toEqual([L.MAIN_CHAT_TITLE, L.MAIN_CHAT_NONE])
    expect(L.mainChatBlock('chat_history failed: boom').lines).toEqual([L.MAIN_CHAT_TITLE, L.MAIN_CHAT_NONE])
    expect(L.mainChatBlock('沒有符合的訊息。\n共 0 則，顯示 0 則')).toMatchObject({ lines: [L.MAIN_CHAT_TITLE, L.MAIN_CHAT_EMPTY], from: 'onsen', n: 0 })
    expect(L.mainChatBlock('（Onsen 連不上（x）：以下是這個常駐程式本機暫存的紀錄，只有它自己記下的，可能不完整）\n沒有符合的訊息。\n共 0 則，顯示 0 則').lines)
      .toEqual([L.MAIN_CHAT_TITLE, L.MAIN_CHAT_NONE])
  })
})

// ------------------------------------------------------------------ part 2: a real daemon (server.ts, lanes on): the wiring end to end
describe('part 2: a real Telegram daemon', () => {
  test('a mail lane run started by the daemon carries the block from Onsen (X-Onsen-Via: hook), right after 此刻', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lanes-wo144-d-'))
    const port = await freePort(), got: Array<{ path: string; via: string }> = []
    const srv = Bun.serve({ port, hostname: '127.0.0.1', fetch(req) {
      const u = new URL(req.url)
      got.push({ path: u.pathname + u.search, via: req.headers.get('x-onsen-via') ?? '' })
      if (req.headers.get('authorization') !== `Bearer ${CRED}`) return Response.json({ error: 'auth' }, { status: 401 })
      if (u.pathname === '/api/onsen/messages' && req.method === 'GET')
        return Response.json({ messages: [{ id: 9, at: at(9), direction: 'in', sender: 'joey', kind: 'text', body: 'WO-150：照第二案做', truncated: false, edited: false, client_msg_id: '2309', status: 'ok', chat: '1828' }],
          total: 1, restart_line: null, restart_line_applied: false })
      if (u.pathname === '/api/onsen/messages/batch') return Response.json({ results: [] })
      return Response.json({ error: 'no route' }, { status: 404 })
    } })
    const dArgv = join(root, 'argv.jsonl'), dBin = join(root, 'lane.py')
    writeFileSync(dBin, `#!/usr/bin/env python3\nimport json, sys\nwith open('${dArgv}', 'a') as f: f.write(json.dumps(sys.argv[1:]) + '\\n')\nprint(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)\n`)
    chmodSync(dBin, 0o755)
    mkdirSync(join(root, 'cred'), { recursive: true }); writeFileSync(join(root, 'cred', 'mesh-credential'), CRED + '\n')
    const api = startBotApiMock({}, { pollHoldMs: 300 })
    const d = await startTgDaemon(api, root, 1828, { ONSEN_BASE: `http://127.0.0.1:${port}/api/onsen`, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'mesh-credential'),
      LANES_CLAUDE_BIN: dBin, ONSEN_RECORD: '0' })
    try {
      const tokFile = join(root, 'tok', String(d.port))
      expect(await until(() => { try { return !!readFileSync(tokFile, 'utf8').trim() } catch { return false } })).toBe(true)
      const r = await fetch(`http://127.0.0.1:${d.port}/lanes/route`, { method: 'POST', headers: { authorization: `Bearer ${readFileSync(tokFile, 'utf8').trim()}`, 'content-type': 'application/json' },
        body: JSON.stringify(reminder()) })
      expect(await r.json()).toMatchObject({ target: 'lane' })
      const rows = (): string[][] => { try { return readFileSync(dArgv, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
      expect(await until(() => rows().length > 0, 15000)).toBe(true)
      const argv = rows()[0], prompt = argv[argv.indexOf('-p') + 1]
      expect(blockOf(prompt)).toEqual([L.MAIN_CHAT_TITLE, `${hm(9)}｜Joey｜#9 tg:2309｜WO-150：照第二案做`])
      expect(prompt).toMatch(/\n# 此刻（[^\n]*\n[^\n]*\n[^\n]*\n\n# Joey 最近對主線說的，和主線怎麼回/)
      const q = got.find(g => g.path.startsWith('/api/onsen/messages?'))!
      expect(q.via).toBe('hook')
      expect(q.path).toContain('limit=60'); expect(q.path).toContain('chat=1828')
    } finally { await d.stop(); api.stop(); srv.stop(true); rmSync(root, { recursive: true, force: true }) }
  }, 60000)
})
