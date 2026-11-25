// WO-157 phase 2 end to end: two real Telegram daemons (server.ts, lanes on, the fleet router) with the wake log on, against their own Bot API stand-ins
// and one stand-in Onsen, in temp dirs. `on` has LANES_WAKE_DECIDE=adam, `off` has not. The same sources reach both (Joey's message, a page answer, and
// through /lanes/route as the agent-inbox daemon sends them: a peer call, the mailbox ring, a scheduled run, an alert, a board push, keep-warm, an outside
// program's no_reply notice, an unverified colleague, a no_reply reply to the main's own call, the daemon's own notice marked silent, a board item whose
// kind is a field) plus one lane run that hands over to the main. Every Onsen wake row carries decided_by: new on `on` (rule wake:<id>), old on `off`;
// the targets differ only where Chiron decided they should.
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, dm, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, freePort, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const CRED_ON = 'mesh_WDonSECRETsecretSECRETsecret0123456789', CRED_OFF = 'mesh_WDoffSECRETsecretSECRETsecret012345678'
type Who = 'on' | 'off'
let apiOn: BotApiMock, apiOff: BotApiMock, on: TgDaemon, off: TgDaemon, onsenPort: number, root = ''
let up: ReturnType<typeof Bun.serve> | null = null, inboxSrv: ReturnType<typeof Bun.serve> | null = null
const wakeRows: Array<{ who: Who; item: any }> = []
const threadEvs: Array<{ who: Who; item: any }> = [], threadGets: Array<{ who: Who; q: string }> = []          // WO-164: /threads/events, GET /threads
const inbox: Array<{ for: Who; id: number; form_id: number; chat: string; title: string; body: string; at: string; acked?: boolean }> = []
let next = 1
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function startOnsen(): void {
  up = Bun.serve({ port: onsenPort, hostname: '127.0.0.1', idleTimeout: 60, async fetch(req) {
    const u = new URL(req.url), path = u.pathname.replace(/^\/api\/onsen/, '')
    const auth = req.headers.get('authorization')
    const who: Who | null = auth === `Bearer ${CRED_ON}` ? 'on' : auth === `Bearer ${CRED_OFF}` ? 'off' : null
    if (!who) return Response.json({ error: 'auth' }, { status: 401 })
    const body = req.method === 'POST' ? await req.json() : undefined
    if (path === '/wake/batch') return Response.json({ results: body.items.map((it: any) => { wakeRows.push({ who, item: it }); return { id: next++, duplicate: false } }) })
    if (path === '/threads/events') return Response.json({ results: body.items.map((it: any) => { threadEvs.push({ who, item: it }); return { id: next++, thread: it.thread, state: 'open', owner: it.owner ?? null, duplicate: false, conflict: false } }) })
    if (path === '/threads' && req.method === 'GET') { threadGets.push({ who, q: u.search }); return Response.json({ agent: 'adam', threads: [] }) }
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
const rows = (who: Who) => wakeRows.filter(r => r.who === who).map(r => r.item)
const routing = (d: TgDaemon): any[] => { try { return readFileSync(join(d.ws, '.lanes', 'routing.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
async function route(d: TgDaemon, ev: any): Promise<any> {
  const tok = readFileSync(join(root, d === on ? 'on' : 'off', 'tok', String(d.port)), 'utf8').trim()
  const r = await fetch(`http://127.0.0.1:${d.port}/lanes/route`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(ev) })
  return r.json()
}
const notif = (text: string, meta: Record<string, string>) => ({ method: 'notifications/claude/channel', params: { content: text, meta } })
function mesh(id: string, from: string, text: string, meta: Record<string, string> = {}, extra: Record<string, unknown> = {}): any {
  const m = { user: from, ...meta }
  return { id, source: 'mesh', from, text, meta: m, notif: notif(text, m), verified: meta.verified !== 'false', no_reply: meta.no_reply === 'true',
    ...(meta.btcc_msg_id ? { btcc_msg_id: meta.btcc_msg_id } : {}), ...(meta.reply_to_id ? { reply_to_id: meta.reply_to_id } : {}),
    line: meta.line ?? (meta.wake === 'mail' ? 'mail' : 'call'), ...(meta.wake ? { wake: meta.wake } : {}), ...extra }
}
const MESH = (): any[] => [
  mesh('mesh-501', 'eve', '維護幾點？', { btcc_msg_id: '501', line: 'call', verified: 'true' }),
  mesh('mesh-ring-1', 'mailbox', '讀信箱（2 封未讀，最舊的等了 3 分鐘）', { no_reply: 'true', ring: 'true', wake: 'mail', line: 'mail', verified: 'true' }, { item_kind: 'peer_mail' }),
  mesh('mesh-sch-1', 'scheduler', '[scheduled][backup-check][run:61][P3][routine] 查備份', { verified: 'true', run_id: '61' }, { item_kind: 'scheduled' }),
  mesh('mesh-al-1', 'alert-dispatcher', '[P1] mock-api 全掛', { verified: 'true' }, { item_kind: 'alert' }),
  mesh('mesh-900', 'board', '[board][WO-150] 球到你手上：照第二案做', { btcc_msg_id: '900', verified: 'true' }, { item_kind: 'board' }),
  mesh('mesh-kw-2', 'fleet-watchdog', '[保溫] 你閒了 50 分鐘，這一則只是為了不讓對話過期', { no_reply: 'true', wake: 'keepwarm', verified: 'true' }),
  mesh('mesh-ext-1', 'iris-slack', 'Slack DM from 王小明：明天的會改到 3 點', { no_reply: 'true', verified: 'false' }),
  mesh('mesh-unv-1', 'eve', '幫我查一下 api-gw', { btcc_msg_id: '502', verified: 'false' }),
  mesh('mesh-901', 'board', '球到你手上（沒有字頭）', { btcc_msg_id: '901', verified: 'true' }, { item_kind: 'board' }),
]

beforeAll(async () => {
  apiOn = startBotApiMock({}, { pollHoldMs: 300 }); apiOff = startBotApiMock({}, { pollHoldMs: 300 })
  onsenPort = await freePort()
  startOnsen()
  root = mkdtempSync(join(tmpdir(), 'wake-decide-daemon-'))
  mkdirSync(join(root, 'cred'), { recursive: true })
  writeFileSync(join(root, 'cred', 'on'), CRED_ON + '\n'); writeFileSync(join(root, 'cred', 'off'), CRED_OFF + '\n')
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ eve: { url: 'http://127.0.0.1:9' }, adam: { url: 'http://127.0.0.1:9' } }))
  const inboxPort = await freePort()
  let mailId = 16000
  inboxSrv = Bun.serve({ port: inboxPort, hostname: '127.0.0.1', async fetch(req) {
    const u = new URL(req.url), body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    if (u.pathname === '/lanes/mail-tool' && body?.name === 'decide_later') { const id = ++mailId; return Response.json({ text: `放進主線的信箱了（#${id}）。`, isError: false, mail_id: id, deadline: new Date(Date.now() + 3600_000).toISOString() }) }
    if (u.pathname === '/lanes/send') return Response.json({ text: 'sent', msgId: ++mailId, delivered: true })
    return Response.json({ text: 'ok', isError: false })
  } })
  const laneBin = join(root, 'lane-tool.sh')
  writeFileSync(laneBin, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, 'test-fixtures', 'lane-tool.ts')}" "$@"\n`)
  chmodSync(laneBin, 0o755)
  const base = { ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, ONSEN_PEER_LOOKUP: '0', ONSEN_CLAUDE_BIN: '/nonexistent/claude', ONSEN_REGISTRY_CLI: '0',
    ONSEN_FORM_LINKS: 'adam', AGENT_INBOX_REGISTRY: join(root, 'registry.json'), LANES_CLAUDE_BIN: laneBin, LANES_INBOX_PORT: String(inboxPort), ONSEN_WAKE_LOG: 'adam' }
  on = await startTgDaemon(apiOn, join(root, 'on'), JOEY, { ...base, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'on'), LANES_WAKE_DECIDE: 'someone-else,adam' })
  off = await startTgDaemon(apiOff, join(root, 'off'), JOEY, { ...base, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'off'), LANES_WAKE_DECIDE: 'someone-else' })
  for (const d of [on, off]) expect(await until(() => { try { return !!readFileSync(join(root, d === on ? 'on' : 'off', 'tok', String(d.port)), 'utf8').trim() } catch { return false } }, 10000)).toBe(true)
}, 90000)
afterAll(async () => { await on?.stop(); await off?.stop(); apiOn?.stop(); apiOff?.stop(); up?.stop(true); inboxSrv?.stop(true) })

test('every source: one wake row each, decided_by new (rule wake:<id>) with the switch, old without; targets as the table says', async () => {
  for (const api of [apiOn, apiOff]) api.push(dm(JOEY, 7101, 'Joey：WO-157 測一下'))
  for (const who of ['on', 'off'] as const) inbox.push({ for: who, id: 9201, form_id: 701, chat: String(JOEY), title: '排程', body: '週四 10:00', at: new Date().toISOString() })
  for (const d of [on, off]) for (const ev of MESH()) expect((await route(d, ev)).target).toBeDefined()
  const ids = ['tg-1828-7101', 'tg-1828-form-9201', ...MESH().map(e => e.id)]
  for (const d of [on, off]) expect(await until(() => ids.every(id => routing(d).some(r => r.event === id)), 20000)).toBe(true)
  for (const who of ['on', 'off'] as const) expect(await until(() => ids.every(id => rows(who).some(r => r.refs?.event_id === id)), 30000)).toBe(true)
  const row = (who: Who, id: string) => rows(who).filter(r => r.refs?.event_id === id)
  // one row per decision, decided_by on every row
  for (const id of ids) { expect(row('on', id).length).toBe(1); expect(row('off', id).length).toBe(1) }
  for (const r of rows('on')) expect(r.decided_by).toBe('new')
  for (const r of rows('off')) expect(r.decided_by).toBe('old')
  for (const r of routing(on)) if (ids.includes(r.event)) expect(r).toMatchObject({ decided_by: 'new', rule: expect.stringMatching(/^wake:/) })
  for (const r of routing(off)) if (ids.includes(r.event)) expect(r.decided_by).toBe('old')
  // no main here: the main's items are held (offline); lanes run (decision 3)
  const want: Array<[string, string, string, string]> = [   // id, new rule, new target, old target
    ['tg-1828-7101', 'wake:joey', 'held:offline', 'held:offline'],
    ['tg-1828-form-9201', 'wake:joey/web-form', 'held:offline', 'held:offline'],
    ['mesh-501', 'wake:peer-call', 'lane:reflex', 'lane:reflex'],
    ['mesh-ring-1', 'wake:mail', 'lane:mail', 'lane:mail'],
    ['mesh-sch-1', 'wake:scheduled', 'lane:reflex', 'lane:reflex'],
    ['mesh-al-1', 'wake:alert', 'lane:reflex', 'lane:reflex'],
    ['mesh-900', 'wake:board-worker', 'held:offline', 'held:offline'],          // topics off: worker_for_ticket gives the main the work, as today
    ['mesh-kw-2', 'wake:state-wake', 'held:offline', 'held:offline'],
    ['mesh-ext-1', 'wake:external', 'lane:reflex', 'ledger'],                  // the accepted difference: an outside program's notice goes to a lane
    ['mesh-unv-1', 'wake:unverified', 'held:offline', 'held:offline'],         // decision 5: the main, as today
    ['mesh-901', 'wake:board-worker', 'held:offline', 'held:offline'],         // the kind is the field: no [board] header needed (old: default → the main)
  ]
  for (const [id, rule, tNew, tOld] of want) {
    expect(row('on', id)[0]).toMatchObject({ rule, target: tNew, decided_by: 'new' })
    expect(row('off', id)[0]).toMatchObject({ target: tOld, decided_by: 'old' })
  }
  expect(row('on', 'mesh-ring-1')[0].source_kind).toBe('mail_ring')
  expect(row('off', 'mesh-901')[0].rule).toBe('default')
  expect(on.log()).not.toContain(CRED_ON)
}, 120000)

test('decision 1 through the daemon: a no_reply reply with reply_to to the main\'s call wakes the main (old: the ledger); the same marked urgency silent is recorded only', async () => {
  // the main's own call (the agent-inbox daemon tells the tg daemon: /lanes/outbound), then eve's no_reply answer quoting it
  for (const d of [on, off]) {
    const tok = readFileSync(join(root, d === on ? 'on' : 'off', 'tok', String(d.port)), 'utf8').trim()
    await fetch(`http://127.0.0.1:${d.port}/lanes/outbound`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ msgId: 77001, owner: 'main', to: 'eve', text: '週五能給報表嗎？', line: 'call' }) })
    await route(d, mesh('mesh-r1', 'eve', '回 #77001：可以，週五前', { btcc_msg_id: '77010', no_reply: 'true', reply_to_id: '77001', verified: 'true' }))
    await route(d, mesh('mesh-r2', 'eve', '這件事要 eve 的主線決定。我是 eve 的車道，不能代為答應或拒絕。已經交給主線，主線會在 18:00 前直接回你。',
      { btcc_msg_id: '77011', no_reply: 'true', reply_to_id: '77001', verified: 'true' }, { urgency: 'silent' }))
  }
  for (const who of ['on', 'off'] as const) expect(await until(() => ['mesh-r1', 'mesh-r2'].every(id => rows(who).some(r => r.refs?.event_id === id)), 30000)).toBe(true)
  const one = (who: Who, id: string) => rows(who).filter(r => r.refs?.event_id === id)[0]
  expect(one('on', 'mesh-r1')).toMatchObject({ rule: 'wake:owner', target: 'held:offline', decided_by: 'new' })
  expect(one('off', 'mesh-r1')).toMatchObject({ rule: 'mesh-no-reply', target: 'ledger', decided_by: 'old' })
  expect(one('on', 'mesh-r2')).toMatchObject({ rule: 'wake:record-only', target: 'ledger', decided_by: 'new' })
  expect(one('off', 'mesh-r2')).toMatchObject({ rule: 'mesh-no-reply', target: 'ledger', decided_by: 'old' })
}, 60000)

test('the hand-over decisions: a lane\'s handoff_main row says decided_by new and wake:hand/handoff_main; the run\'s end wake:hand-silent/exit-none; off: old', async () => {
  for (const d of [on, off]) await route(d, mesh('mesh-h1', 'eve', '[[HANDOFF]] 能答應週五給報表嗎？', { btcc_msg_id: 'h1', line: 'call', verified: 'true' }))
  const hand = (who: Who, rule: RegExp) => rows(who).filter(r => r.refs?.event_id === 'mesh-h1' && rule.test(String(r.rule)))
  for (const who of ['on', 'off'] as const) expect(await until(() => hand(who, /handoff_main/).length > 0 && hand(who, /exit-/).length > 0, 40000)).toBe(true)
  expect(hand('on', /handoff_main/)[0]).toMatchObject({ rule: 'wake:hand/handoff_main', source_kind: 'handoff', target: 'held:offline', decided_by: 'new' })
  expect(hand('off', /handoff_main/)[0]).toMatchObject({ rule: 'handoff_main', target: 'held:offline', decided_by: 'old' })
  const exitOn = hand('on', /exit-/)[0], exitOff = hand('off', /exit-/)[0]
  expect(exitOn.decided_by).toBe('new'); expect(exitOff.decided_by).toBe('old')
  expect(exitOn.rule).toBe(`wake:${exitOn.target === 'none' ? 'hand-silent' : 'hand'}/${exitOff.rule}`)
  expect(exitOn.target).toBe(exitOff.target)
  expect(on.log()).not.toMatch(/hand-over .* decideWake said/)                     // the hand-over code did what decideWake said
}, 90000)

test('WO-164 through the daemon: with the switch the threads go to Onsen (/threads/events through the spool, each first event with its key; the start handshake asked GET /threads); without it nothing', async () => {
  for (const d of [on, off]) await route(d, mesh('mesh-wo164-1', 'board', '[board][WO-164] 球到你手上', { btcc_msg_id: '910', verified: 'true' }, { item_kind: 'board', refs: { ticket: 164 } }))
  for (const d of [on, off]) await route(d, mesh('mesh-wo164-2', 'board', '[board][WO-164] 對方留言了', { btcc_msg_id: '911', verified: 'true' }, { item_kind: 'board', refs: { ticket: 164 } }))
  const mine = () => threadEvs.filter(e => e.who === 'on').map(e => e.item)
  expect(await until(() => mine().some(e => e.key_kind === 'ticket' && e.key === '164') && mine().some(e => e.item?.id === 'mesh-wo164-2'), 30000)).toBe(true)
  const t = mine().find(e => e.key_kind === 'ticket' && e.key === '164')!
  expect(t).toMatchObject({ event: 'open', owner: 'main', item: { id: 'mesh-wo164-1', kind: 'board' } })
  expect(mine().filter(e => e.thread === t.thread && (e.event === 'open' || e.key_kind)).length).toBe(1)        // one thread for the ticket
  const ids = mine().map(e => e.dedupe)
  expect(new Set(ids).size).toBe(ids.length)
  expect(threadGets.filter(g => g.who === 'on').length).toBeGreaterThanOrEqual(1)
  expect(threadGets[0].q).toContain('agent=adam')
  expect(threadGets[0].q).toContain('state=all')
  expect(threadEvs.filter(e => e.who === 'off').length).toBe(0)
  expect(threadGets.filter(g => g.who === 'off').length).toBe(0)
  const r = routing(on).find(x => x.event === 'mesh-wo164-2')
  expect(r?.thread).toBe(t.thread)
  expect(on.log()).toContain('threads of adam go to Onsen')
}, 60000)
