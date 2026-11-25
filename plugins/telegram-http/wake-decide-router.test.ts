// WO-157 phase 2 (Chiron's decisions, mesh-12029), the router in this process (lanes.ts, role tg) with LANES_WAKE_DECIDE on for this agent: every decision
// goes through decideWake and its route row says decided_by new with the rule wake:<id>; the doing code is today's. One test per decision:
//   1 a colleague's no_reply reply WITH reply_to wakes the line that asked (old: the ledger); the daemon's own notice (the router's interim) is sent
//     urgency silent and a silent item is recorded only
//   2 (13:46Z) one state source, statusOf (the server's mainStatus): main / lane / record / hold and now / after this step; the 此刻 line and the
//     same-matter gate read it too; keep-warm on a busy main is recorded only; no status computed here = the old path
//   4 an agent's own router.json rule (an outside program to the main) carries over to the new path
//   5 an unverified colleague → the main
//   and the switch off: the old rules, decided_by old
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const AGENT = 'wdtest'
process.env.LANES_WAKE_DECIDE = `someone-else,${AGENT}`
const L = await import('./lanes.ts?wake-decide-router') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'wake-decide-router-'))
process.env.LANES_DIR = dir
// the fleet router with one rule of the agent's own (decision 4: an outside program kept at the main)
const fleet = JSON.parse(readFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), 'utf8'))
fleet.rules.unshift({ id: 'sentinel-main', match: { source: 'mesh', from: ['sentinel'] }, to: 'main', note: 'WO-157 test' })
writeFileSync(join(dir, 'router.json'), JSON.stringify(fleet))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
/** statusOf as server.ts would compute it: the state, walled / compacting in the detail; null = no status computed (Onsen step 3 off) */
let member: string | null = 'idle'
const status = () => member == null ? null : member === 'walled' ? { state: 'busy', detail: { walled: { until: null } } }
  : member === 'compacting' ? { state: 'busy', detail: { compacting: true } } : { state: member, detail: {} }
L.lanesInit({ role: 'tg', agent: AGENT, workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false,
  registryNames: () => ['chiron', 'eve'], sendBot: async () => 1, joeyChatId: () => '1', mainStatus: status } as any)
L.__setMainConnected('mcp-main')
const meshed: any[] = []
L.__setMeshSend(async b => { meshed.push(b); return { msgId: 95000 + meshed.length, text: `sent to ${b.to}`, delivered: true } })
afterAll(() => { L.__setMeshSend(null); delete process.env.LANES_WAKE_DECIDE })
const st = L.__lanesState()
const routing = (): any[] => { try { return readFileSync(join(dir, 'routing.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const rowOf = (id: string) => routing().filter(r => r.event === id).at(-1)
const items = (id: string) => L.__main().items((r: any) => r.event === id)
let n = 0
function mesh(from: string, text: string, o: Record<string, unknown> = {}): any {
  n += 1
  return { id: `mesh-wd-${n}`, source: 'mesh', from, text, verified: true, meta: { user: from }, notif: { method: 'notifications/claude/channel', params: { content: text, meta: { user: from } } },
    line: 'call', btcc_msg_id: String(70000 + n), ...o }
}
const pid = process.pid
const busy = async () => { await L.__mainEvent({ event: 'UserPromptSubmit', pid, prompt_id: `p-${n}` }) }
const idle = async () => { await L.__mainEvent({ event: 'Stop', pid }) }

test('the switch: on for this agent (a list naming it)', () => {
  expect(L.wakeDecideOn()).toBe(true)
})

test('decision 1: a no_reply reply WITH reply_to to the main\'s own call wakes the main (old path: the ledger); its row says decided_by new, rule wake:owner', async () => {
  await idle()
  member = 'idle'
  // the main called eve (its outbound, as /lanes/outbound records it), eve answers no_reply with reply_to
  st.outbound['88001'] = { owner: 'main', thread: null } as any
  const ev = mesh('eve', '回 #88001：可以，週五前給你', { no_reply: true, reply_to_id: '88001' })
  const d = await L.routeEvent(ev)
  expect(d).toMatchObject({ target: 'main', rule: 'wake:owner' })
  expect(rowOf(ev.id)).toMatchObject({ rule: 'wake:owner', target: 'main', decided_by: 'new', wake_target: 'main_now' })
  expect(items(ev.id).length).toBe(1)
})

test('decision 1: a reply to a lane\'s question goes to that lane (its thread), not the ledger', async () => {
  const lane = 'wdtest.reflex.1', thread = 'wdtest#t-aa0001'
  st.lanes[lane] = { id: lane, kind: 'reflex', n: 1, session_id: 's1', thread, status: 'idle', created: '', last: new Date().toISOString(), transcript: join(dir, 'l1.jsonl'), runs: 1, tokens_in: 0, tokens_out: 0 } as any
  st.threads[thread] = { id: thread, lane, peer: 'eve', hops: 1, tokens: 0, created: '', last: '' } as any
  const ev = mesh('eve', '答案是 3 台', { no_reply: true, thread, hop: 2 })
  const d = await L.routeEvent(ev)
  expect(d).toMatchObject({ target: 'lane', lane, rule: 'wake:owner' })
  expect(rowOf(ev.id)).toMatchObject({ decided_by: 'new', wake_target: 'lane:reflex' })
})

test('decision 1: the daemon\'s own notice — the router\'s interim — leaves with urgency silent; a silent item is recorded only, owner or not', async () => {
  const lane = 'wdtest.reflex.2', thread = 'wdtest#t-aa0002'
  st.lanes[lane] = { id: lane, kind: 'reflex', n: 2, session_id: 's2', thread, status: 'running', created: '', last: '', transcript: join(dir, 'l2.jsonl'), runs: 0, tokens_in: 0, tokens_out: 0 } as any
  st.threads[thread] = { id: thread, lane, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
  const ev: any = mesh('eve', '可以答應我週五前給 10 月可用率嗎？')
  L.__putQueue({ ev, lane, state: 'leased', lease_until: 0, attempts: 1, priority: 1, enqueued: '' })
  const tok = { runId: `${lane}.r1`, lane, evId: ev.id, closers: [], critical: false, trigger: 'peer', cls: 'peer', escalated: false, pushed: false }
  const k = meshed.length
  await L.callLaneTool(tok as any, 'handoff_main', { text: 'Eve 要 10 月可用率；要主線決定答不答應' })
  const interim = meshed.slice(k).filter(m => m.owner === '主線')
  expect(interim.length).toBe(1)
  expect(interim[0]).toMatchObject({ to: 'eve', no_reply: true, urgency: 'silent' })
  expect(interim[0].text).toContain('主線會在')                                        // the text unchanged
  // such a notice arriving here (the sender marked it): recorded only, even with a reply_to we own
  st.outbound['88002'] = { owner: 'main', thread: null } as any
  const notice = mesh('eve', '這件事要 eve 的主線決定。我是 eve 的車道，不能代為答應或拒絕。已經交給主線，主線會在 18:00 前直接回你。', { no_reply: true, reply_to_id: '88002', urgency: 'silent' })
  const d = await L.routeEvent(notice)
  expect(d).toMatchObject({ target: 'ledger', rule: 'wake:record-only' })
  expect(items(notice.id).length).toBe(0)
  expect(rowOf(notice.id)).toMatchObject({ decided_by: 'new', wake_target: 'ledger' })
})

test('decision 2: keep-warm on a main the Onsen status calls busy is recorded only (no M1 item, no ledger line); idle → the main now', async () => {
  member = 'busy'
  const kw = mesh('fleet-watchdog', '[保溫] 你閒了 50 分鐘', { no_reply: true, wake: 'keepwarm', btcc_msg_id: undefined })
  const before = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').length
  expect(await L.routeEvent(kw)).toMatchObject({ target: 'ledger', rule: 'wake:keepwarm-busy' })
  expect(items(kw.id).length).toBe(0)
  expect(readFileSync(join(dir, 'ledger.jsonl'), 'utf8').length).toBe(before)
  expect(rowOf(kw.id)).toMatchObject({ decided_by: 'new', wake_target: 'ledger', wake: 'keepwarm' })
  member = 'idle'
  await idle()
  const kw2 = mesh('fleet-watchdog', '[保溫] 你閒了 50 分鐘', { no_reply: true, wake: 'keepwarm', btcc_msg_id: undefined })
  expect(await L.routeEvent(kw2)).toMatchObject({ target: 'main', rule: 'wake:state-wake' })
  expect(items(kw2.id).length).toBe(1)
  expect(rowOf(kw2.id)).toMatchObject({ decided_by: 'new', wake_target: expect.stringMatching(/^main_/) })
})

test('decision 2 (13:46Z): statusOf alone — idle = now even while the hook says in a turn; busy = after this step; walled = held (M1 holds it as today)', async () => {
  member = 'idle'
  await busy()                                                            // the hook state says in a turn: not read for the decision any more
  const j = mesh('eve', '維護幾點？', { verified: false })                     // (decision 5 below: unverified → the main)
  await L.routeEvent(j)
  expect(rowOf(j.id)).toMatchObject({ rule: 'wake:unverified', target: 'main', decided_by: 'new', wake_target: 'main_now' })
  member = 'busy'
  const b = mesh('eve', '在嗎？', { verified: false })
  await L.routeEvent(b)
  expect(rowOf(b.id)).toMatchObject({ wake_target: 'main_after_step' })
  member = 'walled'
  const w = mesh('eve', '還在嗎？', { verified: false })
  await L.routeEvent(w)
  expect(rowOf(w.id)).toMatchObject({ target: 'main', wake_target: 'held:wall' })
  member = 'idle'
  await idle()
})

test('decision 2 (13:46Z): the 此刻 line and the same-matter gate read statusOf, with today\'s words', async () => {
  await busy()                                                            // M2: in a turn
  member = 'idle'
  expect(L.mainNowLine()).toBe('主線：閒著')
  expect(L.mainTurnNow()).toBeNull()                                      // statusOf idle: not in a turn, whatever M2 says
  for (const m of ['busy', 'waiting', 'stuck', 'compacting']) { member = m; expect(L.mainNowLine()).toMatch(/^主線：回合中/) }
  member = 'busy'
  expect(L.mainTurnNow()).not.toBeNull()
  member = 'walled'; expect(L.mainNowLine()).toMatch(/^主線：暫時不能用模型/)
  member = 'offline'; expect(L.mainNowLine()).toBe('主線：目前沒有在跑'); expect(L.mainTurnNow()).toBeNull()
  member = 'idle'
  await idle()
})

test('no status computed here (Onsen step 3 off): the old path decides, decided_by old', async () => {
  member = null
  try {
    const v = mesh('chiron', '幫我查一下')                                 // (another peer: eve's flood bucket is the other tests')
    expect(await L.routeEvent(v)).toMatchObject({ target: 'lane', rule: 'mesh-peer-call' })
    expect(rowOf(v.id)).toMatchObject({ decided_by: 'old' })
  } finally { member = 'idle' }
})

test('detail.lanes: the status report carries this agent\'s lane runs (lanes.runningLanes → statusOf detail)', async () => {
  const { statusOf } = await import('./onsen-status.ts')
  const lanes = [{ id: 'wdtest.reflex.9', run: 'wdtest.reflex.9.r2', kind: 'reflex', since: '2026-11-25T13:50:00.000Z' }]
  const v = statusOf({ main: { status: 'busy' }, last_activity_at: new Date().toISOString(), queued_joey: 0, lanes })
  expect(v.detail?.lanes).toEqual(lanes)
  expect(statusOf({ main: { status: 'idle' }, last_activity_at: null, queued_joey: 0, lanes: [] }).detail?.lanes).toBeUndefined()
  expect(Array.isArray(L.runningLanes())).toBe(true)
})

test('decision 3: a lane-bound item while the main is offline still goes to its lane', async () => {
  member = 'offline'
  const s = mesh('scheduler', '[scheduled][backup][run:61][P3][routine] 查備份', { btcc_msg_id: undefined, meta: { user: 'scheduler', run_id: '61' } })
  const d = await L.routeEvent(s)
  expect(d).toMatchObject({ target: 'lane', rule: 'wake:scheduled' })
  expect(rowOf(s.id)).toMatchObject({ decided_by: 'new', wake_target: 'lane:reflex' })
  member = 'idle'
})

test('decision 4: the agent\'s own router.json rule (sentinel → the main) holds on the new path', async () => {
  const s = mesh('sentinel', '[哨兵] 低流量 episode 開啟', { verified: false })
  expect(await L.routeEvent(s)).toMatchObject({ target: 'main', rule: 'wake:legacy:sentinel-main' })
  expect(rowOf(s.id)).toMatchObject({ decided_by: 'new' })
})

test('decision 5: an unverified colleague → the main; a verified one → a reflex lane', async () => {
  await idle()
  const u = mesh('eve', '幫我查一下', { verified: false })
  expect(await L.routeEvent(u)).toMatchObject({ target: 'main', rule: 'wake:unverified' })
  const v = mesh('eve', '幫我查一下')
  expect(await L.routeEvent(v)).toMatchObject({ target: 'lane', rule: 'wake:peer-call' })
})

test('the kind is the sender\'s field: an Onsen item of kind board with no [board] header goes to a worker (topics off here: the main)', async () => {
  const b = mesh('board', '球到你手上：照第二案做', { item_kind: 'board', btcc_msg_id: undefined })
  const d = await L.routeEvent(b)
  expect(d.rule).toMatch(/^wake:board-worker/)
  expect(rowOf(b.id)).toMatchObject({ decided_by: 'new' })
})

test('switch off for the agent: the old rules, decided_by old', async () => {
  process.env.LANES_WAKE_DECIDE = 'someone-else'
  try {
    expect(L.wakeDecideOn()).toBe(false)
    st.outbound['88003'] = { owner: 'main', thread: null } as any
    const ev = mesh('eve', '回 #88003：好', { no_reply: true, reply_to_id: '88003' })
    expect(await L.routeEvent(ev)).toMatchObject({ target: 'ledger', rule: 'mesh-no-reply' })
    expect(rowOf(ev.id)).toMatchObject({ decided_by: 'old' })
    expect(rowOf(ev.id).wake_target).toBeUndefined()
  } finally { process.env.LANES_WAKE_DECIDE = `someone-else,${AGENT}` }
})
