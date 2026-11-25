// WO-165 B (Chiron; Joey TG chiron:2423 「狀態同步要多久？顆粒度如何等都要確保延遲不要太誇張影響使用或造成誤判」; status-latency-lab.md 「會判錯的」 9): `seen`
// is the moment Joey's message enters a turn, not the moment it is handed to the session. Chiron's lab: a message waited 13–17 s in Claude Code's queue
// while /pending's unseen was already empty. The hand-over moment is its own fact, in_session.
//   lanes off  in_session: the notification written into the main's stream; seen: the transcript shows it taken in. Claude Code 2.1.3xx writes, for a
//              message that arrives while the main is idle, queue-operation enqueue → dequeue → the user record (seen = that record's time); for one
//              that arrives mid-turn, enqueue … queue-operation remove (absorbed_mid_turn) at the next tool boundary, then an attachment
//              queued_command whose timestamp is the ENQUEUE time (seen = the newest own timestamp before it, not the attachment's)
//   lanes on   in_session: M1 offered it (or bound it at a boundary: a pull hands it over and binds it at once); seen: M1 bound it (onsen-step3 tests)
//   ✍ (ONSEN_REACT_SEEN) goes with seen; a transcript tail read again at start writes seen (Onsen keeps the first) without ✍.
// Unit tests, the spool against an Onsen that does not list in_session yet, then a real daemon (server.ts, lanes off) against the Bot API stand-in,
// a stand-in Onsen, a registry and a transcript the test writes, and an MCP client standing in for the main session.
import { test, expect, describe, afterAll, beforeAll } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { DeliveryFacts, TurnWatch, type JoeyOf } from './onsen-status.ts'
import { OnsenClient, type DeliveryFact } from './onsen-client.ts'
import { startBotApiMock, dm, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, freePort, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const AGENT = 'adam'
const JOEY = 1828
const CHAT = String(JOEY)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const rec = (o: object) => JSON.stringify(o) + '\n'
const tag = (id: number | string) => `<channel source="plugin:telegram-http:telegram-http" chat_id="${CHAT}" message_id="${id}" user="joey" user_id="${CHAT}" ts="2026-11-25T18:00:00.000Z">`
const joeyOf: JoeyOf = m => m && m.user_id === CHAT ? { chat: String(m.chat_id), id: String(m.message_id) } : null
const at = (base: number, s: number) => new Date(base + s * 1000).toISOString()

describe('lanes off: seen from the transcript (Claude Code 2.1.3xx shapes)', () => {
  test('mid-turn: written into the stream = in_session only; absorbed at the tool boundary = seen at the remove, not at the attachment\'s enqueue time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wo165-tx-'))
    const f = join(dir, `${randomUUID()}.jsonl`)
    const T0 = Date.now() - 120_000                                                  // the turn began 2 min ago (inside the 10 min floor)
    writeFileSync(f, rec({ type: 'system', subtype: 'turn_duration', timestamp: at(T0, -5) }))
    const out: DeliveryFact[] = [], reacted: string[] = []
    const F = new DeliveryFacts({ agent: AGENT, sink: x => out.push(x), onSeen: (c, id, by) => reacted.push(`${c}:${id}:${by}`) })
    const W = new TurnWatch({ dir: () => dir, facts: F, joey: joeyOf, changed: () => {}, now: () => T0 - 1_000 })   // this watch began before the turn
    W.tick()
    // Joey's first message, the main idle: enqueue → dequeue → the user record starts the turn; then a 60 s Bash
    F.delivered(CHAT, 1); F.inSession(CHAT, 1, 'main')
    appendFileSync(f, rec({ type: 'queue-operation', operation: 'enqueue', timestamp: at(T0, 0), content: `${tag(1)}\n開始\n</channel>` }))
    appendFileSync(f, rec({ type: 'queue-operation', operation: 'dequeue', timestamp: at(T0, 0.02) }))
    appendFileSync(f, rec({ type: 'user', isMeta: true, promptId: 'p1', origin: { kind: 'channel' }, message: { role: 'user', content: `${tag(1)}\n開始\n</channel>` }, timestamp: at(T0, 0.04) }))
    appendFileSync(f, rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'x', timeout: 120000 } }] }, timestamp: at(T0, 1) }))
    W.tick()
    expect(out.filter(x => x.state === 'seen').map(x => [x.client_msg_id, x.at])).toEqual([['1', at(T0, 0.04)]])   // the prompt's own record
    expect(reacted).toEqual([`${CHAT}:1:main`])
    // two more while the Bash runs: handed to the session (Claude Code queues them); in_session, not seen, no ✍; queued 2
    for (const [id, s] of [[2, 10], [3, 11]] as const) {
      F.delivered(CHAT, id); F.inSession(CHAT, id, 'main', at(T0, s))
      appendFileSync(f, rec({ type: 'queue-operation', operation: 'enqueue', timestamp: at(T0, s), content: `${tag(id)}\n第 ${id} 則\n</channel>` }))
    }
    W.tick()
    expect(out.filter(x => x.state === 'in_session').map(x => [x.client_msg_id, x.by])).toEqual([['1', 'main'], ['2', 'main'], ['3', 'main']])
    expect(out.filter(x => x.state === 'seen').map(x => x.client_msg_id)).toEqual(['1'])
    expect(F.queued('seen')).toBe(2)
    expect(reacted.length).toBe(1)
    // the Bash ends at 61 s; at that boundary Claude Code absorbs both (remove … then the attachments, timestamped with their enqueue time)
    appendFileSync(f, rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'done' }] }, timestamp: at(T0, 61) }))
    appendFileSync(f, rec({ type: 'attachment', attachment: { type: 'prompt_snapshot' }, timestamp: at(T0, 61.001) }))
    for (const id of [2, 3]) appendFileSync(f, rec({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', deliveryId: `d${id}`, timestamp: at(T0, 61.1), content: `${tag(id)}\n</channel>` }))
    appendFileSync(f, rec({ type: 'api-request-shape' }))                             // no timestamp of its own: not a clock
    for (const [id, s] of [[2, 10], [3, 11]] as const) {
      appendFileSync(f, rec({ type: 'attachment', attachment: { type: 'queued_command', prompt: `${tag(id)}\n第 ${id} 則\n</channel>`, delivery_id: `d${id}`, timestamp: at(T0, s) }, timestamp: at(T0, s) }))
    }
    W.tick()
    const seen = out.filter(x => x.state === 'seen')
    expect(seen.map(x => [x.client_msg_id, x.at])).toEqual([['1', at(T0, 0.04)], ['2', at(T0, 61.1)], ['3', at(T0, 61.1)]])
    for (const x of seen.slice(1)) expect(Date.parse(x.at)).toBeGreaterThanOrEqual(Date.parse(at(T0, 61)))   // ≥ the boundary that took them in
    expect(F.queued('seen')).toBe(0)
    expect(reacted).toEqual([`${CHAT}:1:main`, `${CHAT}:2:main`, `${CHAT}:3:main`])
    // the turn ends: turn_end for all three
    appendFileSync(f, rec({ type: 'system', subtype: 'turn_duration', durationMs: 70_000, timestamp: at(T0, 70) }))
    W.tick()
    expect(out.filter(x => x.state === 'turn_end').map(x => x.client_msg_id)).toEqual(['1', '2', '3'])
    // the order of each message's facts, as the spool sends them
    for (const id of ['2', '3']) expect(out.filter(x => x.client_msg_id === id).map(x => x.state)).toEqual(['delivered', 'in_session', 'seen', 'turn_end'])
  })

  test('in_session never calls onSeen (the ✍ waits for the turn); seen does, once per message in the reactor', () => {
    const calls: string[] = []
    const F = new DeliveryFacts({ agent: AGENT, sink: () => {}, onSeen: (c, id, by) => calls.push(`${id}:${by}`) })
    F.album(CHAT, ['7', '8'])
    F.delivered(CHAT, 7); F.delivered(CHAT, 8)
    F.inSession(CHAT, 7, 'main')
    expect(calls).toEqual([])
    F.seen(CHAT, 7, 'main')
    expect(calls).toEqual(['7:main', '8:main'])
    F.seen(CHAT, 9, 'main', undefined, true)                                           // quiet: the fact only
    expect(calls).toEqual(['7:main', '8:main'])
  })

  test('a transcript read again at start: a message taken in before this daemon began is seen again (Onsen keeps the first), without ✍; one older than 10 min not at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wo165-tail-'))
    const f = join(dir, `${randomUUID()}.jsonl`)
    const now = Date.now()
    writeFileSync(f, rec({ type: 'user', message: { content: `${tag(40)}\n很久以前\n</channel>` }, timestamp: at(now, -3600) })
      + rec({ type: 'system', subtype: 'turn_duration', timestamp: at(now, -3590) })
      + rec({ type: 'user', message: { content: `${tag(41)}\n剛才（上一個 daemon）\n</channel>` }, timestamp: at(now, -30) }))
    const out: DeliveryFact[] = [], reacted: string[] = []
    const F = new DeliveryFacts({ agent: AGENT, sink: x => out.push(x), onSeen: (_c, id) => reacted.push(id) })
    const W = new TurnWatch({ dir: () => dir, facts: F, joey: joeyOf, changed: () => {} })
    W.tick()
    expect(out.map(x => `${x.client_msg_id}:${x.state}:${x.at}`)).toEqual([`41:seen:${at(now, -30)}`])
    expect(reacted).toEqual([])
    // the same turn takes another one in after this daemon began: ✍
    appendFileSync(f, rec({ type: 'attachment', attachment: { type: 'queued_command', prompt: `${tag(42)}\n新的\n</channel>` }, timestamp: at(now, 1) }))
    W.tick()
    expect(out.map(x => `${x.client_msg_id}:${x.state}`)).toEqual(['41:seen', '42:seen'])
    expect(reacted).toEqual(['42'])
  })
})

describe('lanes off: the transcript read follows the main\'s session (the registry\'s session id)', () => {
  test('a new session\'s file is read the moment it exists (not at the next 10 s rescan); while it is read, a newer file of another session does not take over', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wo165-sid-'))
    let t = Date.now(), sid: string | null = 'old-session'
    writeFileSync(join(dir, 'old-session.jsonl'), rec({ type: 'system', subtype: 'turn_duration', timestamp: at(t, -60) }))
    const out: DeliveryFact[] = []
    const F = new DeliveryFacts({ agent: AGENT, sink: x => out.push(x) })
    const W = new TurnWatch({ dir: () => dir, facts: F, joey: joeyOf, changed: () => {}, now: () => t, session: () => sid })
    W.tick()
    expect(W.watching()).toBe(join(dir, 'old-session.jsonl'))
    // /clear or a restart: the registry names a new session; its file appears with Joey's message as its first prompt, 1 s later (no rescan due)
    sid = 'new-session'; t += 1_000
    W.tick()
    expect(W.watching()).toBe(join(dir, 'old-session.jsonl'))                       // not there yet: the file it has
    writeFileSync(join(dir, 'new-session.jsonl'), rec({ type: 'user', message: { content: `${tag(60)}\n第一則\n</channel>` }, timestamp: at(t, 0) }))
    t += 250
    W.tick()
    expect(W.watching()).toBe(join(dir, 'new-session.jsonl'))
    expect(out.map(x => `${x.client_msg_id}:${x.state}`)).toEqual(['60:seen'])
    // another claude in the same folder (a `claude -p`) writes a newer file: the main's file stays the one read, rescan or not
    writeFileSync(join(dir, 'other.jsonl'), rec({ type: 'user', message: { content: `${tag(61)}\n不是主線\n</channel>` }, timestamp: at(t, 1) }))
    t += 20_000
    W.tick()
    expect(W.watching()).toBe(join(dir, 'new-session.jsonl'))
    expect(out.map(x => x.client_msg_id)).toEqual(['60'])
    // no session id known (no registration): the newest file, as before
    sid = null; t += 20_000
    W.tick()
    expect(W.watching()).toBe(join(dir, 'other.jsonl'))
  })
})

describe('the spool against an Onsen that does not list in_session yet', () => {
  test('each in_session item is refused alone (400 in its result: rejected.jsonl, a warn line); delivered / seen / turn_end and the messages behind go in', async () => {
    const CRED = 'mesh_WO165oldONSENsecretSECRETsecret0123'
    const posted: any[] = []
    // the old Onsen's own rule (fleet-core 0.12.5 app/onsen3.py _delivery_one): an unknown state answers that item 400, the rest of the batch is taken
    const OLD = ['delivered', 'seen', 'turn_end']
    let n = 1
    const f = (async (input: any, init?: any) => {
      const path = new URL(String(input)).pathname.replace(/^\/api\/onsen/, '')
      const body = init?.body ? JSON.parse(init.body) : undefined
      if (path === '/deliveries/batch') return Response.json({ results: body.items.map((it: any) => {
        if (!OLD.includes(it.state)) return { error: `agent, chat, client_msg_id, idem_key and state (${OLD.join('|')}) are required`, status: 400 }
        posted.push(it); return { id: n++, duplicate: false }
      }) })
      if (path === '/messages/batch') { posted.push(...body.items); return Response.json({ results: body.items.map(() => ({ id: n++, duplicate: false })) }) }
      return Response.json({ error: 'no route' }, { status: 404 })
    }) as typeof fetch
    const dir = mkdtempSync(join(tmpdir(), 'wo165-old-'))
    const logs: string[] = []
    const c = new OnsenClient({ dir, base: 'https://core.test/api/onsen', agent: AGENT, record: true, credential: () => CRED, log: (_l, m) => logs.push(m), fetch: f, intervalMs: 3_600_000 })
    const F = new DeliveryFacts({ agent: AGENT, sink: x => c.recordDelivery(x) })
    F.delivered(CHAT, 501); F.inSession(CHAT, 501, 'main'); F.seen(CHAT, 501, 'main'); F.turnEnd(CHAT, 501, 'main')
    c.recordMessage({ idem_key: `tg:${AGENT}:${CHAT}:in:502`, agent: AGENT, client: 'telegram', chat: CHAT, direction: 'in', sender: `tg:${CHAT}`, body: '下一則', kind: 'text',
      sent_at: new Date().toISOString(), client_msg_id: '502', status: 'ok' })
    await c.syncNow(true)
    expect(c.pendingBytes()).toBe(0)                                                       // nothing held behind the refused item
    expect(posted.map(x => x.state ? `${x.client_msg_id}:${x.state}` : `msg:${x.client_msg_id}`)).toEqual(['501:delivered', '501:seen', '501:turn_end', 'msg:502'])
    expect(c.health()).toMatchObject({ rejected: 1 })
    const rej = readFileSync(join(dir, 'rejected.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(rej.length).toBe(1)
    expect(rej[0].line).toMatchObject({ k: 'd', r: { state: 'in_session', client_msg_id: '501' } })
    expect(rej[0].why).toContain('(400)')
    expect(logs.filter(l => l.includes('rejected') && l.includes('not retried')).length).toBe(1)
  })
})

// ------------------------------------------------------------------ a real daemon, lanes off: Chiron's criterion 3 on the bench
const CRED = 'mesh_WO165DAEMONsecretSECRETsecret0123456'
let api: BotApiMock, d: TgDaemon, onsenPort: number
let up: ReturnType<typeof Bun.serve> | null = null
const facts: Array<DeliveryFact & { got_at: number }> = []
const procs: any[] = []
beforeAll(async () => {
  api = startBotApiMock({}, { pollHoldMs: 300 })
  onsenPort = await freePort()
  up = Bun.serve({ port: onsenPort, hostname: '127.0.0.1', async fetch(req) {
    const body = req.method === 'POST' ? await req.json() : undefined
    const path = new URL(req.url).pathname.replace(/^\/api\/onsen/, '')
    if (path === '/deliveries/batch') for (const it of (body as any).items) facts.push({ ...it, got_at: Date.now() })
    if (path.endsWith('/batch')) return Response.json({ results: (body as any).items.map((_: unknown, i: number) => ({ id: i + 1, duplicate: false })) })
    return Response.json({ id: 1, duplicate: false })
  } })
  const root = mkdtempSync(join(tmpdir(), 'wo165-daemon-'))
  mkdirSync(join(root, 'cred'), { recursive: true })
  writeFileSync(join(root, 'cred', 'mesh-credential'), CRED + '\n')
  d = await startTgDaemon(api, root, JOEY, { ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'mesh-credential'),
    GENESIS_LANES: '0', ONSEN_PEER_LOOKUP: '0', ONSEN_REGISTRY_CLI: '0', ONSEN_REACT_SEEN: AGENT })
}, 40000)
afterAll(async () => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } await d?.stop(); api?.stop(); up?.stop(true) })

test('daemon, lanes off: two messages while the main runs a long tool: in_session at once, unseen (no seen, no ✍, queued_joey 2) until the boundary that takes them in; seen ≥ it, then ✍', async () => {
  const sessions = join(d.home, '.claude', 'sessions'), tdir = join(d.home, '.claude', 'projects', d.ws.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(sessions, { recursive: true }); mkdirSync(tdir, { recursive: true })
  const spool = join(d.stateDir, 'onsen', 'spool.jsonl')
  const st = () => existsSync(spool) ? readFileSync(spool, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => l.k === 's').map(l => l.r) : []
  const of = (id: string) => facts.filter(x => x.client_msg_id === id).map(x => x.state)
  const react = () => api.of('setMessageReaction').filter(c => c.body.reaction?.[0]?.emoji === '✍').map(c => Number(c.body.message_id))
  const main = Bun.spawn(['sleep', '600']); procs.push(main)
  const lstart = String(spawnSync('ps', ['-o', 'lstart=', '-p', String(main.pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).stdout).trim()
  const sid = randomUUID(), tf = join(tdir, `${sid}.jsonl`)
  writeFileSync(tf, '')
  const reg = (status: string) => writeFileSync(join(sessions, `${main.pid}.json`), JSON.stringify({ pid: main.pid, sessionId: sid, cwd: d.ws, startedAt: Date.now(),
    procStart: lstart, version: '2.1.322', kind: 'interactive', entrypoint: 'cli', name: AGENT, status, updatedAt: Date.now(), statusUpdatedAt: Date.now() }))
  reg('idle')
  const got: string[] = []
  const c = new Client({ name: 'wo165', version: '0' }, { capabilities: {} })
  c.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') got.push(String((n.params as any)?.meta?.message_id ?? '')) }
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${d.port}/mcp`)))
  expect(await until(() => st().at(-1)?.state === 'idle', 15000)).toBe(true)
  const iso = () => new Date().toISOString()
  const put = (o: object) => appendFileSync(tf, rec({ ...o, timestamp: (o as any).timestamp ?? iso() }))

  // the turn: Joey's first message, the main takes it in and starts a 60 s tool
  api.push(dm(JOEY, 9001, '跑 60 秒的工具'))
  expect(await until(() => got.includes('9001'), 10000)).toBe(true)
  expect(await until(() => of('9001').includes('in_session'), 5000)).toBe(true)
  expect(of('9001')).not.toContain('seen')
  reg('busy')
  const turnStart = iso()
  put({ type: 'queue-operation', operation: 'enqueue', content: `${tag(9001)}\n跑 60 秒的工具\n</channel>` })
  put({ type: 'queue-operation', operation: 'dequeue' })
  put({ type: 'user', isMeta: true, message: { role: 'user', content: `${tag(9001)}\n跑 60 秒的工具\n</channel>` }, timestamp: turnStart })
  put({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'long1', name: 'Bash', input: { command: 'python3 -c "..."', timeout: 120000 } }] } })
  expect(await until(() => of('9001').includes('seen'), 3000)).toBe(true)
  expect(facts.find(x => x.client_msg_id === '9001' && x.state === 'seen')!.at).toBe(turnStart)
  expect(await until(() => react().includes(9001), 3000)).toBe(true)

  // two messages while the tool runs: written into the stream (in_session) and queued by Claude Code (enqueue)
  for (const id of [9002, 9003]) {
    api.push(dm(JOEY, id, `第 ${id} 則`))
    expect(await until(() => got.includes(String(id)), 10000)).toBe(true)
    put({ type: 'queue-operation', operation: 'enqueue', content: `${tag(id)}\n第 ${id} 則\n</channel>` })
  }
  expect(await until(() => of('9002').includes('in_session') && of('9003').includes('in_session'), 5000)).toBe(true)
  const enq = { '9002': facts.find(x => x.client_msg_id === '9002' && x.state === 'in_session')!.at, '9003': facts.find(x => x.client_msg_id === '9003' && x.state === 'in_session')!.at }
  expect(await until(() => st().at(-1)?.detail?.queued_joey === 2, 5000)).toBe(true)
  // the tool keeps running: still unseen (the lab's 13–17 s, shortened); no ✍; queued_joey stays 2
  const t0 = Date.now()
  while (Date.now() - t0 < 2500) {
    expect(of('9002')).toEqual(['delivered', 'in_session']); expect(of('9003')).toEqual(['delivered', 'in_session'])
    expect(st().at(-1)?.detail?.queued_joey).toBe(2)
    await sleep(250)
  }
  expect(react()).toEqual([9001])

  // the tool ends; Claude Code absorbs both at that boundary (remove, then the attachments carrying their enqueue time)
  const toolEnd = iso()
  put({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'long1', content: '12345' }] }, timestamp: toolEnd })
  await sleep(5)
  const absorbed = iso()
  for (const id of [9002, 9003]) put({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', deliveryId: `dv${id}`, content: `${tag(id)}\n</channel>`, timestamp: absorbed })
  appendFileSync(tf, rec({ type: 'api-request-shape' }))                             // no timestamp of its own
  for (const id of [9002, 9003] as const) {
    const e = enq[String(id) as '9002' | '9003']
    appendFileSync(tf, rec({ type: 'attachment', attachment: { type: 'queued_command', prompt: `${tag(id)}\n第 ${id} 則\n</channel>`, delivery_id: `dv${id}`, timestamp: e }, timestamp: e }))
  }
  const tAbs = Date.now()
  expect(await until(() => of('9002').includes('seen') && of('9003').includes('seen'), 3000)).toBe(true)
  const lag = Math.max(...facts.filter(x => x.state === 'seen' && x.client_msg_id !== '9001').map(x => x.got_at)) - tAbs
  for (const id of ['9002', '9003']) {
    const s = facts.find(x => x.client_msg_id === id && x.state === 'seen')!
    expect(s.at).toBe(absorbed)
    expect(Date.parse(s.at)).toBeGreaterThanOrEqual(Date.parse(toolEnd))
    expect(Date.parse(s.at)).toBeGreaterThanOrEqual(Date.parse(turnStart))
    expect(s.by).toBe('main')
  }
  expect(await until(() => st().at(-1)?.detail?.queued_joey === 0, 3000)).toBe(true)
  expect(await until(() => react().includes(9002) && react().includes(9003), 3000)).toBe(true)
  console.log(`WO-165 bench: absorbed → seen at the stand-in Onsen ${lag} ms (transcript poll 250 ms); seen.at = the remove record (${absorbed}), the attachments said ${enq['9002']} / ${enq['9003']}`)

  // the turn ends: turn_end; every message's facts in order
  put({ type: 'system', subtype: 'turn_duration', durationMs: 65_000 })
  reg('idle')
  expect(await until(() => ['9001', '9002', '9003'].every(id => of(id).includes('turn_end')), 5000)).toBe(true)
  for (const id of ['9001', '9002', '9003']) expect(of(id)).toEqual(['delivered', 'in_session', 'seen', 'turn_end'])
  await c.close()
}, 90000)
