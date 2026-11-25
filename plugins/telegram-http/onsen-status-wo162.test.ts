// WO-162 (Chiron's lab, status-latency-lab.md; Joey TG chiron:2423 「狀態同步要多久？顆粒度如何等都要確保延遲不要太誇張影響使用或造成誤判」): the status the daemon
// reports to Onsen.
//   (1) the message being answered is not queued (fixed in 1.55.1, Sonn, WO-157b: lanes off, a kick reads the transcript first; lanes on, the offered item
//       is the turn's once the status says it began): verified here through the daemon (lanes off) and in onsen-step3.test.ts (lanes on); a message
//       that arrives mid-turn is counted at once (the status is computed when the count moves, not at the next 2 s tick)
//   (2) a detail change is written at once (a tool starting or ending, waitingFor, dialog_open); the transcript is read every 250 ms (lanes off)
//   (3) a report at least every 15 s, unchanged or not, each with detail.heartbeat_s (Onsen: no report for 3 × heartbeat_s = reporting lost)
// Unit tests, then a real daemon (server.ts, lanes off) against the Bot API stand-in, a stand-in Onsen, a registry and a transcript the test writes, and an
// MCP client standing in for the main session.
import { test, expect, describe, afterAll, beforeAll } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { DeliveryFacts, StatusFacts, HEARTBEAT_MS } from './onsen-status.ts'
import type { StatusFact } from './onsen-client.ts'
import { startBotApiMock, dm, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, freePort, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const AGENT = 'adam'
const JOEY = 1828
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('(1) the queued count moves the status at once', () => {
  test('changed: a message taken in, written into the stream, into a turn, its turn ended: each asks for the status now', () => {
    let n = 0
    const F = new DeliveryFacts({ agent: AGENT, sink: () => {}, changed: () => { n++ } })
    F.delivered('1', 1); F.seen('1', 1, 'main'); F.taken('1', 1); F.turnEnd('1', 1, 'main')
    expect(n).toBe(4)
  })
})

describe('(2) a detail change at once; (3) the heartbeat', () => {
  test('the heartbeat: nothing new for heartbeatMs: the latest view again, each report carrying heartbeat_s; a view not handed in lately (freshMs) is not repeated', async () => {
    const out: StatusFact[] = []
    const S = new StatusFacts({ agent: AGENT, sink: f => out.push(f), heartbeatMs: 150, freshMs: 150 })
    const idle = { state: 'idle' as const, detail: { queued_joey: 0 }, last_activity_at: 'a1' }
    S.update(idle)
    expect(out[0]!.detail).toEqual({ queued_joey: 0, heartbeat_s: 0.15 })
    // the compute loop hands the same view in every 50 ms: a report every 150 ms
    for (let i = 0; i < 10; i++) { await sleep(50); S.update(idle) }
    const gaps = out.slice(1).map((f, i) => Date.parse(f.at) - Date.parse(out[i]!.at))
    expect(out.length).toBeGreaterThanOrEqual(3)
    for (const g of gaps) { expect(g).toBeGreaterThanOrEqual(140); expect(g).toBeLessThan(260) }
    for (const f of out) expect(f).toMatchObject({ state: 'idle', detail: { queued_joey: 0, heartbeat_s: 0.15 }, last_activity_at: 'a1' })
    expect(new Set(out.map(f => f.idem_key)).size).toBe(out.length)               // each a new row
    // the loop stops handing views in: one more beat at most, then nothing (Onsen sees the reports stop)
    const n = out.length
    await sleep(500)
    expect(out.length - n).toBeLessThanOrEqual(1)
    const m = out.length
    S.update(idle)                                                                  // it resumes: overdue, reported at once
    expect(out.length).toBe(m + 1)
    S.stop()
    await sleep(200)
    expect(out.length).toBe(m + 1)                                                  // stopped: no beat
    S.update(idle)
    expect(out.length).toBe(m + 1)
  })

  test('the default heartbeat is 15 s; heartbeatMs 0: none, and no heartbeat_s', () => {
    expect(HEARTBEAT_MS).toBe(15_000)
    const a: StatusFact[] = [], b: StatusFact[] = []
    const A = new StatusFacts({ agent: AGENT, sink: f => a.push(f) }), B = new StatusFacts({ agent: AGENT, sink: f => b.push(f), heartbeatMs: 0 })
    A.update({ state: 'busy', detail: { queued_joey: 0 } }); B.update({ state: 'busy', detail: { queued_joey: 0 } })
    expect(a[0]!.detail).toEqual({ queued_joey: 0, heartbeat_s: 15 })
    expect(b[0]!.detail).toEqual({ queued_joey: 0 })
    A.stop(); B.stop()
  })

  test('a tool shorter than the old 5 s window shows and goes: the tool row, then the row without it, both at once', () => {
    const out: StatusFact[] = []
    const S = new StatusFacts({ agent: AGENT, sink: f => out.push(f), heartbeatMs: 0 })
    const b = (tool: string | null, act: string) => ({ state: 'busy' as const, detail: { turn_started_at: 't', tool: tool ? { name: tool, since: 't1' } : null, subagents: 0, queued_joey: 0 }, last_activity_at: act })
    S.update(b(null, 'a0'))
    S.update(b('react', 'a1'))
    S.update(b(null, 'a2'))
    expect(out.map(f => (f.detail as any).tool?.name ?? null)).toEqual([null, 'react', null])
    S.stop()
  })
})

// ------------------------------------------------------------------ a real daemon, lanes off
const CRED = 'mesh_WO162DAEMONsecretSECRETsecret01234567'
let api: BotApiMock, d: TgDaemon, onsenPort: number
let up: ReturnType<typeof Bun.serve> | null = null
const procs: any[] = []
beforeAll(async () => {
  api = startBotApiMock({}, { pollHoldMs: 300 })
  onsenPort = await freePort()
  up = Bun.serve({ port: onsenPort, hostname: '127.0.0.1', async fetch(req) {
    const body = req.method === 'POST' ? await req.json() : undefined
    const path = new URL(req.url).pathname.replace(/^\/api\/onsen/, '')
    if (path.endsWith('/batch')) return Response.json({ results: (body as any).items.map((_: unknown, i: number) => ({ id: i + 1, duplicate: false })) })
    return Response.json({ id: 1, duplicate: false })
  } })
  const root = mkdtempSync(join(tmpdir(), 'wo162-daemon-'))
  mkdirSync(join(root, 'cred'), { recursive: true })
  writeFileSync(join(root, 'cred', 'mesh-credential'), CRED + '\n')
  d = await startTgDaemon(api, root, JOEY, { ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'mesh-credential'),
    GENESIS_LANES: '0', ONSEN_PEER_LOOKUP: '0', ONSEN_REGISTRY_CLI: '0', ONSEN_STATUS_HEARTBEAT_S: '1' })
}, 40000)
afterAll(async () => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } await d?.stop(); api?.stop(); up?.stop(true) })

test('daemon, lanes off: idle reported every heartbeat_s; 1.55.1: the first busy row does not count the message it answers (transcript flushed); a message mid-turn counts at once; a tool shows and goes within a transcript read; transcript flushed after the busy: counted until the next read only', async () => {
  const sessions = join(d.home, '.claude', 'sessions'), tdir = join(d.home, '.claude', 'projects', d.ws.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(sessions, { recursive: true }); mkdirSync(tdir, { recursive: true })
  const spool = join(d.stateDir, 'onsen', 'spool.jsonl')
  const lines = () => existsSync(spool) ? readFileSync(spool, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  const st = () => lines().filter(l => l.k === 's').map(l => l.r)
  const main = Bun.spawn(['sleep', '600']); procs.push(main)
  const lstart = String(spawnSync('ps', ['-o', 'lstart=', '-p', String(main.pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).stdout).trim()
  const sid = randomUUID(), tf = join(tdir, `${sid}.jsonl`)
  writeFileSync(tf, '')
  const reg = (status: string) => writeFileSync(join(sessions, `${main.pid}.json`), JSON.stringify({ pid: main.pid, sessionId: sid, cwd: d.ws, startedAt: Date.now(),
    procStart: lstart, version: '2.1.322', kind: 'interactive', entrypoint: 'cli', name: 'adam', status, updatedAt: Date.now(), statusUpdatedAt: Date.now() }))
  reg('idle')
  const got: string[] = []
  const c = new Client({ name: 'wo162', version: '0' }, { capabilities: {} })
  c.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') got.push(String((n.params as any)?.meta?.message_id ?? '')) }
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${d.port}/mcp`)))
  expect(await until(() => st().at(-1)?.state === 'idle', 15000)).toBe(true)

  // (3) idle and nothing new: reported every heartbeat_s (1 s here), each with heartbeat_s
  const n0 = st().length
  await sleep(3200)
  const beats = st().slice(n0)
  expect(beats.length).toBeGreaterThanOrEqual(2)
  for (const b of beats) expect(b).toMatchObject({ state: 'idle', detail: { queued_joey: 0, heartbeat_s: 1 } })
  const gaps = beats.slice(1).map((b, i) => Date.parse(b.at) - Date.parse(beats[i]!.at))
  console.log(`heartbeat gaps (ms), heartbeat_s 1: ${gaps.join(', ')}`)
  for (const g of gaps) expect(g).toBeLessThanOrEqual(1100)

  // (1) 1.55.1 (Sonn, WO-157b): a status kick reads the transcript first. Joey's message is written into the stream; the transcript already holds the
  // user record when the registry says busy: the turn's first busy row does not count it
  const iso = () => new Date().toISOString()
  const userRec = (id: number, text: string) => JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: `<channel source="plugin:telegram-http:telegram-http" chat_id="${JOEY}" message_id="${id}" user="joey" user_id="${JOEY}" ts="x">\n${text}\n</channel>` }, timestamp: iso() }) + '\n'
  api.push(dm(JOEY, 7001, '開始'))
  expect(await until(() => got.includes('7001'), 10000)).toBe(true)
  await sleep(50)
  const n1 = st().length
  appendFileSync(tf, userRec(7001, '開始'))
  reg('busy')
  expect(await until(() => st().slice(n1).some(s => s.state === 'busy'), 5000)).toBe(true)
  const first = st().slice(n1).find(s => s.state === 'busy')
  expect(first.detail.queued_joey).toBe(0)                                       // 1.55.0: 1 (the message being answered)

  // a second message while it works: queued at once (delivered → the status computed now, not at the next 2 s tick)
  const n2 = lines().length, t2 = performance.now()
  api.push(dm(JOEY, 7002, '還有這個'))
  expect(await until(() => lines().slice(n2).some(l => l.k === 's' && l.r.detail?.queued_joey === 1), 5000)).toBe(true)
  const ls = lines().slice(n2)
  const dAt = ls.findIndex(l => l.k === 'd' && l.r.client_msg_id === '7002' && l.r.state === 'delivered')
  const qAt = ls.findIndex(l => l.k === 's' && l.r.detail?.queued_joey === 1)
  expect(dAt).toBeGreaterThanOrEqual(0)
  console.log(`a message mid-turn → queued_joey 1 in the spool: ${(performance.now() - t2).toFixed(0)} ms after the push (delivered at line ${dAt}, status at line ${qAt})`)
  expect(Date.parse(ls[qAt].r.at) - Date.parse(ls[dAt].r.at)).toBeLessThan(500)

  // (2) a tool in the transcript: in the spool within a transcript read (250 ms) and the kick; its result: gone as fast
  const toolLat: number[] = []
  for (let i = 0; i < 4; i++) {
    let n = st().length, t0 = performance.now()
    appendFileSync(tf, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu${i}`, name: 'Bash', input: { command: 'sleep 4' } }] }, timestamp: iso() }) + '\n')
    expect(await until(() => st().slice(n).some(s => s.detail?.tool?.name === 'Bash'), 3000)).toBe(true)
    toolLat.push(performance.now() - t0)
    n = st().length; t0 = performance.now()
    appendFileSync(tf, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu${i}`, content: 'ok' }] }, timestamp: iso() }) + '\n')
    expect(await until(() => st().slice(n).some(s => s.state === 'busy' && s.detail?.tool === null), 3000)).toBe(true)
    toolLat.push(performance.now() - t0)
  }
  console.log(`transcript write → tool shown / gone in the spool (ms): ${toolLat.map(x => x.toFixed(0)).join(', ')}`)
  for (const x of toolLat) expect(x).toBeLessThan(700)

  // the second message pulled into the turn at a tool boundary: no longer queued
  const n3 = st().length
  appendFileSync(tf, JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: `<channel source="plugin:telegram-http:telegram-http" chat_id="${JOEY}" message_id="7002" user="joey" user_id="${JOEY}" ts="x">\n還有這個\n</channel>` }, timestamp: iso() }) + '\n')
  expect(await until(() => st().slice(n3).some(s => s.detail?.queued_joey === 0), 3000)).toBe(true)

  // the turn ends. Joey's next message, in the order Claude Code writes them (Chiron's lab, txmonster, 7 turn starts caught within 37 ms of the busy:
  // the user record was not in the transcript 57–87 ms after statusUpdatedAt, it was by 94–110 ms): the registry's busy first, the transcript 90 ms later.
  // The kick (registry watch + 25 ms) reads the transcript before the record is there; the 250 ms transcript read finds it and the count is written at
  // once (WO-162 (2)): the message being answered counts at most until that read
  appendFileSync(tf, JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 900, timestamp: iso() }) + '\n')
  reg('idle')
  expect(await until(() => st().at(-1)?.state === 'idle', 5000)).toBe(true)
  api.push(dm(JOEY, 7003, '下一則'))
  expect(await until(() => got.includes('7003'), 10000)).toBe(true)
  await sleep(50)
  const n4 = st().length
  reg('busy')
  await sleep(90)
  const tw = performance.now()
  appendFileSync(tf, userRec(7003, '下一則'))
  expect(await until(() => st().slice(n4).some(s => s.state === 'busy'), 5000)).toBe(true)
  const firstLate = st().slice(n4).find(s => s.state === 'busy')
  expect(await until(() => st().slice(n4).some(s => s.state === 'busy' && s.detail.queued_joey === 0), 2000)).toBe(true)
  const fix = st().slice(n4).find(s => s.state === 'busy' && s.detail.queued_joey === 0)
  console.log(`transcript 90 ms after the busy: first busy row queued_joey ${firstLate.detail.queued_joey}; 0 written ${(Date.parse(fix.at) - (performance.timeOrigin + tw)).toFixed(0)} ms after the record`)
  expect(Date.parse(fix.at) - (performance.timeOrigin + tw)).toBeLessThan(500)
  await c.close()
}, 90000)
