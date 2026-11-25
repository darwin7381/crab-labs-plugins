// WO-147 (Onsen step 4a) end to end: two real Telegram daemons (server.ts, lanes on, the fleet router) against their own Bot API stand-ins and one stand-in
// Onsen (a local HTTP server; nothing reaches core.kbro.ai or Telegram), in temp dirs (their HOME too).
//   on  (ONSEN_WAKE_LOG = adam): each of the 9 acceptance sources (Joey's Telegram message, a page answer, a peer call, the mailbox ring, a scheduled run,
//       an alert, a board push, the watchdog's keep-warm, an external program's no_reply notice) makes exactly one wake row, with its fields; the rows equal
//       routing.jsonl's lines, one for one
//   off (no switch): the same events, the same routing.jsonl rule / target; no wake row, no /wake/batch call
//   Onsen down, then up (and its first answer lost): routing goes on at the same speed, the rows wait in the spool, arrive after, none twice
// Mesh events reach the daemon the way the agent-inbox daemon sends every one of them with lanes on: POST /lanes/route with the loopback token.
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, dm, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, freePort, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const CRED_ON = 'mesh_WAKEonSECRETsecretSECRETsecret0123456', CRED_OFF = 'mesh_WAKEoffSECRETsecretSECRETsecret012345'
type Who = 'on' | 'off'
let apiOn: BotApiMock, apiOff: BotApiMock, on: TgDaemon, off: TgDaemon, onsenPort: number, root = ''
let up: ReturnType<typeof Bun.serve> | null = null
const calls: Array<{ who: Who; path: string; n: number }> = []
const wakePosted: Array<{ who: Who; item: any }> = []            // every wake item POSTed (a resend shows twice here)
const wakeRows = new Map<string, { who: Who; id: number; item: any }>()   // what the stand-in stored, by idem_key (Onsen's UNIQUE)
const inbox: Array<{ for: Who; id: number; form_id: number; chat: string; title: string; body: string; at: string; acked?: boolean }> = []
let next = 1, loseNextWakeAnswer = false
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function startOnsen(): void {
  up = Bun.serve({ port: onsenPort, hostname: '127.0.0.1', idleTimeout: 60, async fetch(req) {
    const u = new URL(req.url), path = u.pathname.replace(/^\/api\/onsen/, '')
    const auth = req.headers.get('authorization')
    const who: Who | null = auth === `Bearer ${CRED_ON}` ? 'on' : auth === `Bearer ${CRED_OFF}` ? 'off' : null
    if (!who) return Response.json({ error: 'auth' }, { status: 401 })
    const body = req.method === 'POST' ? await req.json() : undefined
    calls.push({ who, path, n: Array.isArray(body?.items) ? body.items.length : 1 })
    if (path === '/wake/batch') {
      const results = body.items.map((it: any) => {
        wakePosted.push({ who, item: it })
        if (!it.idem_key || !it.agent || !it.source_kind || !it.target) return { error: 'agent, idem_key, source_kind and target are required', status: 400 }
        const had = wakeRows.get(it.idem_key)
        if (had) return { id: had.id, duplicate: true }
        const id = next++
        wakeRows.set(it.idem_key, { who, id, item: it })
        return { id, duplicate: false }
      })
      // the answer lost once (stored, then 500): the daemon must send the same lines again and the idem_key keep them single
      if (loseNextWakeAnswer) { loseNextWakeAnswer = false; return Response.json({ error: 'answer lost (test)' }, { status: 500 }) }
      return Response.json({ results })
    }
    if (path === '/messages/batch' || path === '/deliveries/batch' || path === '/status/batch') return Response.json({ results: body.items.map(() => ({ id: next++, duplicate: false })) })
    if (path === '/events') return Response.json({ id: next++, duplicate: false })
    if (path === '/forms/inbox') {
      const end = Date.now() + Math.min(2, Number(u.searchParams.get('wait') ?? 0)) * 1000
      const mine = () => inbox.filter(i => i.for === who && !i.acked)
      while (Date.now() < end && !mine().length) await sleep(50)
      return Response.json({ agent: 'adam', items: mine().map(({ acked, for: _f, ...i }) => i) })
    }
    if (path === '/forms/ack') { let n = 0; for (const i of inbox) if (i.for === who && body.ids.includes(i.id) && !i.acked) { i.acked = true; n++ } return Response.json({ acked: n }) }
    return Response.json({ error: 'no route' }, { status: 404 })
  } })
}
const rows = (who: Who) => [...wakeRows.values()].filter(r => r.who === who).map(r => r.item)
const jl = (d: TgDaemon, f: string): any[] => { try { return readFileSync(join(d.ws, '.lanes', f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const routing = (d: TgDaemon) => jl(d, 'routing.jsonl')
const spoolWake = (d: TgDaemon): any[] => { const p = join(d.stateDir, 'onsen', 'spool.jsonl'); return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => l.k === 'w') : [] }
async function route(d: TgDaemon, ev: any): Promise<{ d: any; ms: number }> {
  const tok = readFileSync(join(root, d === on ? 'on' : 'off', 'tok', String(d.port)), 'utf8').trim()
  const t0 = performance.now()
  const r = await fetch(`http://127.0.0.1:${d.port}/lanes/route`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(ev) })
  return { d: await r.json(), ms: performance.now() - t0 }
}
const notif = (text: string, meta: Record<string, string>) => ({ method: 'notifications/claude/channel', params: { content: text, meta } })
/** a mesh event as the agent-inbox daemon's laneEventOf builds it */
function mesh(id: string, from: string, text: string, meta: Record<string, string> = {}): any {
  const m = { user: from, ...meta }
  return { id, source: 'mesh', from, text, meta: m, notif: notif(text, m), verified: meta.verified !== 'false', no_reply: meta.no_reply === 'true',
    ...(meta.btcc_msg_id ? { btcc_msg_id: meta.btcc_msg_id } : {}), line: meta.line ?? (meta.wake === 'mail' ? 'mail' : 'call'), ...(meta.wake ? { wake: meta.wake } : {}) }
}
const MESH = (): any[] => [
  mesh('mesh-501', 'eve', '維護幾點？', { btcc_msg_id: '501', line: 'call', verified: 'true' }),
  mesh('mesh-ring-1', 'mailbox', '讀信箱（2 封未讀，最舊的等了 3 分鐘）', { no_reply: 'true', ring: 'true', wake: 'mail', line: 'mail', verified: 'true' }),
  mesh('mesh-sch-1', 'scheduler', '[scheduled][backup-check][run:61][P3][routine] 查備份', { verified: 'true', run_id: '61' }),
  mesh('mesh-al-1', 'alert-dispatcher', '[P1] mock-api 全掛', { verified: 'true' }),
  mesh('mesh-900', 'board', '[board][WO-150] 球到你手上：照第二案做', { btcc_msg_id: '900', verified: 'true' }),
  mesh('mesh-kw-2', 'fleet-watchdog', '[保溫] 你閒了 50 分鐘，這一則只是為了不讓對話過期', { no_reply: 'true', wake: 'keepwarm', verified: 'true' }),
  mesh('mesh-ext-1', 'iris-slack', 'Slack DM from 王小明：明天的會改到 3 點', { no_reply: 'true', verified: 'false' }),
]

beforeAll(async () => {
  apiOn = startBotApiMock({}, { pollHoldMs: 300 }); apiOff = startBotApiMock({}, { pollHoldMs: 300 })
  onsenPort = await freePort()
  startOnsen()
  root = mkdtempSync(join(tmpdir(), 'onsen-wake-daemon-'))
  mkdirSync(join(root, 'cred'), { recursive: true })
  writeFileSync(join(root, 'cred', 'on'), CRED_ON + '\n'); writeFileSync(join(root, 'cred', 'off'), CRED_OFF + '\n')
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ eve: { url: 'http://127.0.0.1:9' }, adam: { url: 'http://127.0.0.1:9' } }))
  const base = { ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, ONSEN_PEER_LOOKUP: '0', ONSEN_CLAUDE_BIN: '/nonexistent/claude', ONSEN_REGISTRY_CLI: '0',
    ONSEN_FORM_LINKS: 'adam', AGENT_INBOX_REGISTRY: join(root, 'registry.json') }
  on = await startTgDaemon(apiOn, join(root, 'on'), JOEY, { ...base, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'on'), ONSEN_WAKE_LOG: 'someone-else, adam', ONSEN_HOST: 'lab-host' })
  off = await startTgDaemon(apiOff, join(root, 'off'), JOEY, { ...base, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'off'), ONSEN_WAKE_LOG: 'someone-else' })
  for (const d of [on, off]) expect(await until(() => { try { return !!readFileSync(join(root, d === on ? 'on' : 'off', 'tok', String(d.port)), 'utf8').trim() } catch { return false } }, 10000)).toBe(true)
}, 90000)
afterAll(async () => { await on?.stop(); await off?.stop(); apiOn?.stop(); apiOff?.stop(); up?.stop(true) })

/** the on-daemon's wake rows equal its routing.jsonl lines, and stay so for a moment (nothing in flight) */
async function settled(ms = 30000): Promise<boolean> {
  const same = () => rows('on').length === routing(on).length
  if (!await until(same, ms)) return false
  await sleep(1200)
  return until(same, ms)
}

test('on / off: the 9 sources, one wake row each with its fields; routing.jsonl rule / target identical; rows = routing.jsonl lines; off sends none', async () => {
  // 1 Joey's Telegram message, 2 a page answer (forms inbox), 3–9 the mesh sources (POST /lanes/route, as the agent-inbox daemon does)
  for (const [api] of [[apiOn], [apiOff]] as const) api.push(dm(JOEY, 7001, 'Joey：幫我看一下 WO-147'))
  for (const who of ['on', 'off'] as const) inbox.push({ for: who, id: 9101, form_id: 601, chat: String(JOEY), title: '排程', body: '週四 10:00', at: new Date().toISOString() })
  for (const d of [on, off]) for (const ev of MESH()) expect((await route(d, ev)).d.target).toBeDefined()
  const ids = ['tg-1828-7001', 'tg-1828-form-9101', ...MESH().map(e => e.id)]
  for (const d of [on, off]) expect(await until(() => ids.every(id => routing(d).some(r => r.event === id)), 20000)).toBe(true)
  expect(await settled()).toBe(true)
  // the routes are the same with the switch and without it
  const key = (r: any) => `${r.event}|${r.rule}|${r.target}|${r.lane ? String(r.lane).replace(/\.\d+$/, '') : ''}`
  for (const id of ids) expect(routing(on).filter(r => r.event === id).map(key)).toEqual(routing(off).filter(r => r.event === id).map(key))
  // one row per routing.jsonl line, in the same order (a route record's idem_key counts up), each source with its fields
  const mine = rows('on'), lines = routing(on)
  expect(mine.length).toBe(lines.length)
  expect([...mine].sort((a, b) => Number(a.idem_key.split(':').pop()) - Number(b.idem_key.split(':').pop())).map(r => `${r.refs.event_id}|${r.rule}`))
    .toEqual(lines.map(l => `${l.event}|${l.rule}`))
  const want: Array<[string, string, string, string, string, Record<string, string>]> = [
    ['tg-1828-7001', 'joey_tg', 'interrupt', 'tg-main', 'held:offline', { tg: '1828:7001' }],
    ['tg-1828-form-9101', 'joey_form', 'interrupt', 'web-form', 'held:offline', { form_id: '601', tg: '1828:form-9101' }],
    ['mesh-501', 'peer_call', 'interrupt', 'mesh-peer-call', 'lane:reflex', { btcc_msg_id: '501' }],
    ['mesh-ring-1', 'mail_ring', 'ordered', 'wake-mail', 'lane:mail', {}],
    ['mesh-sch-1', 'scheduled', 'ordered', 'mesh-scheduled', 'lane:reflex', { run_id: '61' }],
    ['mesh-al-1', 'alert', 'interrupt', 'mesh-alert', 'lane:reflex', {}],
    ['mesh-900', 'board', 'interrupt', 'mesh-board', 'held:offline', { ticket: 'WO-150', btcc_msg_id: '900' }],
    ['mesh-kw-2', 'wd_keepwarm', 'state', 'wake-keepwarm', 'held:offline', {}],
    ['mesh-ext-1', 'external', 'silent', 'mesh-no-reply', 'ledger', {}],
  ]
  for (const [id, kind, urgency, rule, target, refs] of want) {
    const first = lines.find(l => l.event === id)!
    const r = mine.filter(x => x.refs.event_id === id && x.rule === first.rule)
    expect(r.length).toBe(lines.filter(l => l.event === id && l.rule === first.rule).length)
    expect(r[0]).toMatchObject({ agent: 'adam', host: 'lab-host', source_kind: kind, urgency, rule, target, member_state: 'offline', refs: { event_id: id, ...refs } })
    expect(first).toMatchObject({ rule })
    expect(Date.parse(r[0].at)).toBeGreaterThan(Date.now() - 120_000)
    expect(r[0].idem_key).toMatch(/^wake:adam:\d+:[0-9a-f]{6}:\d+$/)
    expect(typeof r[0].preview).toBe('string')
  }
  expect(mine.find(r => r.refs.event_id === 'mesh-ext-1')!.sender).toBe('iris-slack')
  expect(mine.find(r => r.refs.event_id === 'mesh-ext-1')!.preview).toBe('Slack DM from 王小明：明天的會改到 3 點')
  // off: nothing
  expect(calls.filter(c => c.who === 'off' && c.path === '/wake/batch').length).toBe(0)
  expect(spoolWake(off).length).toBe(0)
  expect(rows('off').length).toBe(0)
  const h = await fetch(`http://127.0.0.1:${on.port}/healthz`).then(r => r.json()) as any
  expect(h.onsen.wake_recorded).toBe(lines.length)
  expect(h.onsen.status.wake_log).toEqual({ on: true, recorded: lines.length })
  const hOff = await fetch(`http://127.0.0.1:${off.port}/healthz`).then(r => r.json()) as any
  expect(hOff.onsen.wake_recorded).toBe(0); expect(hOff.onsen.status.wake_log).toBeUndefined()
  expect(on.log()).toContain('onsen: wake log on for adam (host lab-host)')
  expect(off.log()).not.toContain('onsen: wake log on')
  expect(on.log()).not.toContain(CRED_ON)
}, 120000)

test('Onsen down, then up with its first answer lost: routing unaffected, the rows written meanwhile arrive, none twice', async () => {
  const before = routing(on).length
  up!.stop(true); up = null
  await sleep(300)
  const evs = [mesh('mesh-d1', 'eve', '在嗎？', { btcc_msg_id: 'd1', line: 'call', verified: 'true' }),
    mesh('mesh-d2', 'fleet-watchdog', '[保溫] 你閒了 50 分鐘', { no_reply: 'true', wake: 'keepwarm', verified: 'true' }),
    mesh('mesh-d3', 'iris-slack', 'Slack：收到', { no_reply: 'true', verified: 'false' })]
  const lat: number[] = []
  for (const ev of evs) {
    const r = await route(on, ev), o2 = await route(off, JSON.parse(JSON.stringify(ev)))
    expect(r.d.rule).toBe(o2.d.rule); expect(r.d.target).toBe(o2.d.target)
    lat.push(r.ms)
  }
  console.log(`/lanes/route with Onsen down (ms): ${lat.map(x => x.toFixed(0)).join(', ')}`)
  expect(Math.max(...lat)).toBeLessThan(2000)
  expect(await until(() => evs.every(e => routing(on).some(r => r.event === e.id)), 10000)).toBe(true)
  // the rows are in the spool, not in Onsen
  expect(await until(() => evs.every(e => spoolWake(on).some(l => l.r.refs.event_id === e.id)), 5000)).toBe(true)
  expect(evs.some(e => rows('on').some(r => r.refs.event_id === e.id))).toBe(false)
  const h = await fetch(`http://127.0.0.1:${on.port}/healthz`).then(r => r.json()) as any
  expect(h.onsen.pending_bytes).toBeGreaterThan(0)
  // Onsen back; its first /wake/batch answer is lost (stored, then 500): the same lines go again, Onsen answers duplicate
  loseNextWakeAnswer = true
  const posted0 = wakePosted.length
  startOnsen()
  expect(await until(() => evs.every(e => rows('on').some(r => r.refs.event_id === e.id)), 60000)).toBe(true)
  expect(loseNextWakeAnswer).toBe(false)                                            // the lost answer happened (stored, answered 500)
  // the daemon only moves its cursor past lines Onsen answered: the spool drains once the same lines went again
  const health = async () => (await fetch(`http://127.0.0.1:${on.port}/healthz`).then(r => r.json()) as any).onsen
  expect(await until(async () => (await health()).pending_bytes === 0, 90000)).toBe(true)
  expect(await settled(60000)).toBe(true)
  const sent = wakePosted.slice(posted0).filter(p => p.who === 'on').map(p => p.item.idem_key)
  expect(sent.length).toBeGreaterThan(new Set(sent).size)                           // a resend happened …
  const stored = rows('on').map(r => r.idem_key)
  expect(stored.length).toBe(new Set(stored).size)                                  // … and nothing is stored twice
  expect(rows('on').length).toBe(routing(on).length)
  expect(routing(on).length).toBeGreaterThanOrEqual(before + evs.length)
  for (const e of evs) expect(rows('on').filter(r => r.refs.event_id === e.id).length).toBe(routing(on).filter(r => r.event === e.id).length)
  const h2 = await fetch(`http://127.0.0.1:${on.port}/healthz`).then(r => r.json()) as any
  expect(h2.onsen.duplicates).toBeGreaterThan(0)
  expect(h2.onsen.pending_bytes).toBe(0)
}, 200000)
