import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fakeItems } from './test-fixtures/onsen-items.ts'
import { OnsenClient } from './onsen-client.ts'
import { OnsenInbox, OnsenPuller, switchOn } from './onsen-inbox.ts'
import { deliveryMode, machineName, takeRefusal, TakeMode } from './onsen-take.ts'
import { ItemPeek, itemRef, type InboxItem } from './onsen-items.ts'
import { Claims } from './onsen-claims.ts'
import { ItemReceiver } from './onsen-receive.ts'
import { createMain, MAIN_STUCK_MS, type MainApi, type MainEvent, type MainWall } from './lanes-main.ts'
import { Journal } from './lanes-state.ts'
import { REGISTRY_SETTLE_MS } from './onsen-status.ts'

const clean: Array<() => void> = []
afterEach(() => { while (clean.length) clean.pop()!() })
async function until(ok: () => boolean, ms = 1500) {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await Bun.sleep(5)
  expect(ok()).toBe(true)
}
function rig() {
  const f = fakeItems(), dir = mkdtempSync(join(tmpdir(), 'wo213-'))
  const logs: string[] = [], misses: string[] = [], deadlines: string[] = []
  const client = new OnsenClient({ dir, agent: 'adam', record: true, base: f.base, credential: () => 'test-member', log: (_lv, m) => logs.push(m) })
  const mode = new TakeMode('adam', client.request.bind(client), () => {}, line => logs.push(line), 'mac-mini')
  const file = join(dir, 'claims.json')
  let main: MainApi | undefined
  const claims = new Claims(file, client, id => { misses.push(id); main?.offerMissed(id) }, () => {}, f.now)
  client.watchItemReports(r => claims.replay(r), (r, ok) => claims.acknowledged(r, ok))
  const receiver = new ItemReceiver(mode, claims, time => deadlines.push(time))
  clean.push(() => { mode.stop(); claims.stop(); client.stop(); f.stop(); rmSync(dir, { recursive: true, force: true }) })
  const outcomes = (id: string) => f.history.filter(r => r.item_id === id).map(r => r.body.outcome)
  return { f, client, mode, claims, file, receiver, dir, logs, misses, deadlines, outcomes, sync: () => client.syncNow(true),
    attach(m: MainApi) { main = m } }
}
async function mainRig(backoff = 300_000, onOffer = async () => true) {
  const r = rig()
  await r.mode.probe()
  const journal = new Journal(join(r.dir, 'state.jsonl')), offers: any[] = [], notices: string[] = []
  const sid = crypto.randomUUID(), pid = 1051
  let member = 'idle', bg = 0, owes = false, wall: MainWall | null = null
  const m = createMain({ journal, agent: 'adam', itemReceiver: () => r.receiver, log: () => {}, offer: async n => { offers.push(n); return onOffer() },
    wallBackoff: () => backoff, registry: { mainForAdoption: () => null, backgroundAgents: () => bg },
    streamOpen: () => true, memberState: () => member, expectedSession: () => [sid], pidAlive: () => true, context: () => '', info: () => null,
    genChanged: () => {}, refused: () => {}, done: () => {}, undone: () => {}, tellJoey: (_s, rule) => notices.push(rule), genuineAfter: () => 1,
    mainOwed: ids => owes ? ids.map(id => ({ id, from: 'joey', text: id, owes: ['reply'] })) : [], usageWall: () => wall })
  m.initMain(); r.attach(m)
  const hook = (event: string, data: Partial<MainEvent> = {}) => m.mainEvent({ event, pid, session_id: sid, prompt_id: 'turn', ...data })
  await hook('SessionStart', { source: 'startup' })
  const enqueue = (row: InboxItem, old = false) => m.enqueue(row.kind === 'message' ? 'joey' : 'peer',
    { method: 'notifications/claude/channel', params: { content: row.payload.text, meta: { chat_id: '1', message_id: String(row.number), user: row.from } } },
    { event: row.id, fields: old ? {} : { onsen_items: [itemRef(row)] } })
  const bind = async (row: InboxItem) => {
    const did = enqueue(row)
    await until(() => m.items(x => x.id === did)[0]?.state === 'offered')
    await hook('UserPromptSubmit', { dids: [did] }); await r.sync()
    expect(r.outcomes(row.id)).toContain('in_session')
    return did
  }
  return { ...r, m, journal, offers, notices, hook, enqueue, bind, sid, setWall(value: MainWall | null) { wall = value }, status(s: string, n = 0) { member = s; bg = n; r.claims.statusRecord(s, () => bg, REGISTRY_SETTLE_MS) },
    owing(value: boolean) { owes = value } }
}

test('C4 a bare model error writes one resume; the normal peek takes it when due, with the WO-209 sentence', async () => {
  const r = await mainRig(250)
  await r.hook('UserPromptSubmit')
  const earliest = Date.now() + 250
  await r.hook('StopFailure', { error: 'overloaded' })
  const latest = Date.now() + 250
  await until(() => r.f.rows.size === 1)
  const row = [...r.f.rows.values()][0]!
  const writes = () => r.f.calls.filter(c => c.path === r.mode.path && c.body.kind === 'resume')
  expect(writes()).toHaveLength(1)
  expect(writes()[0]!.key).toBeTruthy()
  expect(row).toMatchObject({ kind: 'resume', session_id: 'main', state: 'waiting' })
  const due = Date.parse(row.not_before!)
  expect(due).toBeGreaterThanOrEqual(earliest)
  expect(due).toBeLessThanOrEqual(latest)
  const hhmm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' }).format(due - 250)
  const sentence = `上一回合 ${hhmm}（台北）被打斷（模型回應錯誤 overloaded），接著做沒做完的；沒有要接的就直接結束這一回合。`
  expect(row.payload.text).toBe(sentence)
  const peek = new ItemPeek(r.mode, () => new Map(), async it => r.m.routeResume(itemRef(it), it.payload.text), () => true)
  clean.push(() => peek.stop())
  await peek.poll()
  await r.m.pump()
  expect(r.offers).toHaveLength(0)
  expect(r.f.calls.filter(c => c.path.endsWith('/take'))).toHaveLength(0)
  r.f.advance(due - r.f.now())
  await until(() => r.offers.length === 1)
  const { content, meta } = r.offers[0].params
  expect(content).toBe(sentence)
  expect(meta).toMatchObject({ chat_id: 'lanes', user: 'lanes', via: 'lanes', no_reply: 'true' })
  expect(row.state).toBe('claimed')
  await r.hook('UserPromptSubmit', { prompt_id: 'resume', dids: [meta.did] })
  await r.hook('Stop', { prompt_id: 'resume', phase: 'final' })
  r.f.advance(3100); r.status('idle'); await r.sync()
  expect(r.outcomes(row.id)).toEqual(['in_session', 'completed'])
  await r.m.tick()
  expect([writes().length, r.offers.length]).toEqual([1, 1])
  expect(r.m.currentGen()?.resume_sent).toBeUndefined()
})

test('C4 a process cut records the old background count; an item failure and an asked restart create no resume', async () => {
  const d = await mainRig()
  d.status('busy', 2)
  await d.hook('UserPromptSubmit')
  await d.hook('SessionEnd')
  await until(() => d.f.rows.size === 1)
  const row = [...d.f.rows.values()][0]!
  expect(row.payload.text).toContain('（對話結束），接著做沒做完的；沒有要接的就直接結束這一回合。當時有 2 個背景工作在跑，重開後已經不在。')
  expect(row.not_before).toBeNull()

  const other = await mainRig()
  const message = other.f.add('work')
  await other.bind(message)
  await other.hook('StopFailure', { error: 'server_error' }); await other.sync()
  await other.hook('StopFailure', { error: 'server_error' })
  await other.hook('UserPromptSubmit', { prompt_id: 'typing' })
  other.m.markEnd('asked')
  await other.hook('SessionEnd')
  expect(other.outcomes('work')).toContain('error')
  expect([...other.f.rows.keys()]).toEqual(['work'])
})

async function accountCut() {
  const r = await mainRig()
  r.setWall({ walled: true, clearedMs: null })
  await r.hook('UserPromptSubmit')
  await r.hook('StopFailure', { error: 'rate_limit' })
  await until(() => !!r.m.currentGen()?.resume_items?.[0]?.id)
  const row = [...r.f.rows.values()][0]!
  r.m.routeResume(itemRef(row), row.payload.text)
  return { ...r, row }
}

test('C4 switch to take imports an unsent pull cut, and waits for a pull stream write already in flight', async () => {
  const pending = await mainRig()
  pending.mode.pause('pull', 60_000)
  await pending.hook('UserPromptSubmit')
  await pending.hook('StopFailure', { error: 'overloaded' })
  const retry = pending.m.currentGen()!.cut_turn.retry_at
  await pending.mode.probe(); await pending.m.pump()
  await until(() => pending.f.rows.size === 1)
  expect([...pending.f.rows.values()][0]!.not_before).toBe(new Date(retry).toISOString())
  expect(pending.m.currentGen()?.cut_turn).toBeUndefined()
  expect(pending.offers).toHaveLength(0)

  let finish!: (sent: boolean) => void
  const writing = await mainRig(0, () => new Promise(resolve => { finish = resolve }))
  writing.mode.pause('pull', 60_000)
  await writing.hook('UserPromptSubmit')
  await writing.hook('StopFailure', { error: 'overloaded' })
  const receipt = writing.m.pump()
  await until(() => writing.offers.length === 1)
  await writing.mode.probe(); await writing.m.pump()
  finish(true); await receipt; await writing.m.pump()
  expect(writing.m.currentGen()!.resumes).toBe(1)
  expect(writing.f.calls.filter(c => c.body.kind === 'resume')).toHaveLength(0)
})

test('C4 a refused resume probe belongs to its claimed row even if StopFailure is the first hook', async () => {
  const r = await accountCut()
  r.setWall({ walled: false, clearedMs: Date.now() + 1000 })
  await r.m.pump()
  await r.hook('StopFailure', { prompt_id: 'probe', error: 'rate_limit' })
  await r.sync()
  expect(r.outcomes(r.row.id)).toEqual(['in_session', 'usage_limit_probe'])
  expect(r.f.rows.size).toBe(1)
})

test('C4 a held claim is marked superseded offline before its offer lease can expire', async () => {
  const r = await accountCut()
  r.setWall({ walled: false, clearedMs: Date.now() + 1000 })
  await r.m.pump()
  r.f.down(true)
  await r.hook('UserPromptSubmit', { prompt_id: 'automatic', dids: [] })
  expect(r.client.hasItemReports()).toBe(true)
  r.f.advance(25_000); r.claims.start()
  await r.sync()
  r.f.down(false); await r.sync()
  expect(r.outcomes(r.row.id)).toEqual(['superseded'])
  expect(r.misses).toEqual([])
})

test('C4 a same-prompt independent turn supersedes the waiting row at its latest version', async () => {
  const r = await accountCut()
  expect(r.f.calls.find(c => c.body.kind === 'resume')!.body).not.toHaveProperty('not_before')
  await r.hook('PreToolUse', { sub: true })
  await r.hook('StopFailure', { error: 'rate_limit' })
  expect(r.row.state).toBe('waiting')
  expect(r.f.rows.size).toBe(1)
  r.f.change(r.row, 'updated')
  const version = r.row.version
  await r.hook('UserPromptSubmit', { dids: [] })
  await until(() => r.row.state === 'cancelled')
  expect(r.f.calls.filter(c => c.body.outcome === 'superseded')).toMatchObject([
    { path: '/v1/items/' + r.row.id, body: { expected_version: version, outcome: 'superseded' } },
  ])
  await r.hook('Stop', { phase: 'final' })
  await r.m.tick()
  expect(r.row.reason).toBe('superseded')
  expect(r.offers).toEqual([])
})

test('C4 auto-resume between the server take and its response spools superseded without a stream write', async () => {
  const r = await accountCut()
  r.f.delayTake(100)
  r.setWall({ walled: false, clearedMs: Date.now() + 1000 })
  const offer = r.m.pump()
  await until(() => r.row.state === 'claimed')
  const claim = r.row.claim!.id
  await r.hook('PreToolUse', { prompt_id: 'automatic', tool_name: 'Read' })
  await offer
  await r.sync()
  expect(r.f.history).toMatchObject([{ item_id: r.row.id, body: { claim_id: claim, outcome: 'superseded' } }])
  expect(r.row).toMatchObject({ state: 'cancelled', reason: 'superseded', failures: 0 })
  expect(r.f.calls.some(c => c.body.expected_version !== undefined)).toBe(false)
  expect(r.offers).toEqual([])
})

test('C4 a take recovered by its idempotency key reports the intervening auto-resume', async () => {
  const r = await accountCut()
  const request = r.mode.req
  let lost = false
  spyOn(r.mode, 'req').mockImplementation(async (...args) => {
    const reply = await request(...args)
    if (!lost && args[1].endsWith('/take')) {
      lost = true
      await r.hook('PreToolUse', { prompt_id: 'automatic', tool_name: 'Read' })
      throw Error('take response lost')
    }
    return reply
  })
  r.setWall({ walled: false, clearedMs: Date.now() + 1000 })
  await r.m.pump(); await r.sync()
  const takes = r.f.calls.filter(c => c.path.endsWith('/take'))
  expect(takes).toHaveLength(2)
  expect(takes[0]!.key).toBe(takes[1]!.key)
  expect(r.outcomes(r.row.id)).toEqual(['superseded'])
  expect(r.offers).toEqual([])
})

test('C4 a claimed offer without its did is superseded, while a turn opened by another item leaves the resume waiting', async () => {
  const claimed = await accountCut()
  claimed.setWall({ walled: false, clearedMs: Date.now() + 1000 })
  await claimed.m.pump()
  expect(claimed.offers).toHaveLength(1)
  await claimed.hook('UserPromptSubmit', { prompt_id: 'automatic', dids: [] })
  await until(() => claimed.client.hasItemReports())
  await claimed.sync(); await claimed.m.tick()
  expect(claimed.outcomes(claimed.row.id)).toEqual(['superseded'])
  expect(claimed.offers).toHaveLength(1)

  const other = await mainRig()
  await other.hook('UserPromptSubmit')
  await other.hook('StopFailure', { error: 'overloaded' })
  await until(() => other.f.rows.size === 1)
  const resume = [...other.f.rows.values()][0]!
  await other.bind(other.f.add('message'))
  await other.hook('Stop', { phase: 'final' })
  expect(resume.state).toBe('waiting')
})

test('C4 a lost POST response and a lost DELETE race keep the decision across retries', async () => {
  const r = await mainRig()
  const request = r.mode.req
  let losePost = true, conflict = true
  spyOn(r.mode, 'req').mockImplementation(async (...args) => {
    const [method, path] = args
    if (method === 'DELETE' && conflict) {
      conflict = false
      r.f.change([...r.f.rows.values()][0]!, 'updated')
    }
    const reply = await request(...args)
    if (method === 'POST' && path === r.mode.path && losePost) { losePost = false; throw Error('POST response lost') }
    return reply
  })
  await r.hook('UserPromptSubmit')
  await r.hook('StopFailure', { error: 'rate_limit' })
  await until(() => r.logs.some(l => l.includes('POST response lost')))
  await r.hook('UserPromptSubmit', { prompt_id: 'automatic', dids: [] })
  await until(() => !conflict && r.f.calls.some(c => c.body.expected_version === 1))
  const row = [...r.f.rows.values()][0]!
  expect(row.state).toBe('waiting')
  await until(() => { void r.m.pump(); return row.state === 'cancelled' })
  const posts = r.f.calls.filter(c => c.body.kind === 'resume')
  expect(posts).toHaveLength(2)
  expect(posts[0]!.key).toBe(posts[1]!.key)
  expect(r.f.calls.filter(c => c.body.outcome === 'superseded').map(c => c.body.expected_version)).toEqual([1, 2])
  expect(r.f.rows.size).toBe(1)
  expect(r.offers).toEqual([])
})

test('switch, prerequisites, stable machine/member and all probe refusals', async () => {
  const r = rig()
  expect(switchOn(undefined, 'adam')).toBe(false)
  expect(r.f.calls).toHaveLength(0)
  const valid = { inbox: false, roamer: false, lanes: true, record: true, observation: true }
  for (const key of Object.keys(valid) as Array<keyof typeof valid>) expect(takeRefusal({ ...valid, [key]: !valid[key] })).toBeTruthy()
  expect(takeRefusal(valid)).toBeUndefined()
  expect(machineName('  --Mac_Mini  ')).toBe('mac-mini')
  const { path, connector, req } = r.mode
  for (const status of [400, 404, 409]) { r.f.mode(status); expect(await deliveryMode(req, path, connector)).toBe('pull') }
  expect(await deliveryMode(async () => { throw Error('offline') }, path, connector)).toBe('pull')
  r.f.mode(200); await r.mode.probe()
  expect(r.mode.active).toBe(true)
  expect(r.f.calls.every(c => c.query.get('connector') === 'mac-mini/adam' && c.query.get('limit') === '1')).toBe(true)
})

test('agent-inbox reports a pause once, including first start, and can resume pull', async () => {
  const r = rig(), inbox = new OnsenInbox({ file: join(r.dir, 'inbox.json') })
  const pull = new OnsenPuller({ inbox, base: r.f.base, req: r.client.request.bind(r.client), takeEnabled: true, host: 'mac-mini',
    deliver: async () => 'delivered', log: (_lv, m) => r.logs.push(m) })
  await pull.once(); await pull.once()
  expect(r.logs.filter(s => s.includes('member is on take'))).toHaveLength(1)
  expect(inbox.based).toBe(false)
  r.f.mode(409); await pull.once()
  expect(inbox.based).toBe(true)
  expect(r.logs.filter(s => s.includes('on pull again'))).toHaveLength(1)
})

test('a 409 hands on locally held pull items and acks the delivered prefix before pausing', async () => {
  const r = rig(), inbox = new OnsenInbox({ file: join(r.dir, 'inbox.json') })
  const legacy = ['first', 'middle', 'last'].map(id => r.f.add(id, 'call'))
  const ready = new Set<string>(), trace: string[] = []
  const pull = new OnsenPuller({ inbox, base: r.f.base, takeEnabled: true, host: 'mac-mini', now: r.f.now,
    req: async (...args) => {
      const reply = await r.client.request(...args)
      if (reply?.status === 409) trace.push('409')
      return reply
    },
    deliver: async it => {
      const text = String(it.payload.text)
      if (!ready.has(text)) return 'later'
      trace.push(text)
      return 'delivered'
    },
    log: (_lv, line) => { if (line.includes('member is on take')) trace.push('pause at ' + inbox.ackedSeq) } })
  const acks = () => r.f.calls.filter(c => c.path === '/inbox/ack').map(c => c.body)
  r.f.mode(409) // old pull works until the member switches to take
  await pull.once(); await pull.once()
  expect(inbox.pending.map(it => it.seq)).toEqual(legacy.map(it => it.number))
  expect(acks()).toEqual([])

  r.f.mode(200)
  const fresh = r.f.add('new', 'call')
  ready.add('first'); ready.add('last')
  await pull.once()
  expect(trace).toEqual(['409', 'first', 'last', 'pause at 1'])
  expect(inbox.pending.map(it => it.seq)).toEqual([2])
  expect(acks()).toEqual([{ upto: 1 }])

  ready.add('middle')
  r.f.advance(60_000)
  await pull.once(); await pull.once()
  expect(trace).toEqual(['409', 'first', 'last', 'pause at 1', 'middle', '409', '409'])
  expect(inbox.pending).toEqual([])
  expect(acks()).toEqual([{ upto: 1 }, { upto: 3 }])
  await r.mode.probe()
  const page = (await r.mode.req('GET', r.mode.path + '?state=waiting&connector=' + encodeURIComponent(r.mode.connector)))!.json
  expect(page.items.map((it: InboxItem) => it.id)).toEqual([fresh.id])
  expect([...(await r.receiver.receive([...legacy, fresh].map(itemRef))).given]).toEqual([fresh.id])
})

test('an interrupted ack on a first-start 409 is retried after restart without repeating the hand-off', async () => {
  const r = rig(), file = join(r.dir, 'inbox.json'), handed: number[] = []
  r.f.mode(409)
  const row = r.f.add('pending', 'call')
  const old = await r.client.request('GET', '/inbox?after=0&wait=0&limit=1')
  const inbox = new OnsenInbox({ file })
  inbox.take(old!.json.items)
  expect(inbox.based).toBe(false)
  const puller = (local: OnsenInbox) => new OnsenPuller({ inbox: local, base: r.f.base, takeEnabled: true, host: 'mac-mini',
    req: r.client.request.bind(r.client), log: (_lv, line) => r.logs.push(line),
    deliver: async it => { handed.push(it.seq); r.f.down(true); return 'delivered' } })

  r.f.mode(200)
  await expect(puller(inbox).once()).rejects.toThrow('ack 1: HTTP 503')
  expect(r.logs.some(line => line.includes('member is on take'))).toBe(false)
  const restored = new OnsenInbox({ file })
  expect(restored.pending).toEqual([])
  expect(restored.ackedSeq).toBe(0)
  r.f.down(false)
  const resumed = puller(restored)
  await resumed.once(); await resumed.once()
  expect(handed).toEqual([row.number])
  expect(restored.ackedSeq).toBe(row.number)
  expect(row.state).toBe('completed')
  expect(r.f.calls.filter(c => c.path === '/inbox/ack').map(c => c.body)).toEqual([{ upto: 1 }, { upto: 1 }])
})

test('peek waits without claiming and reads a gated row again on release', async () => {
  const r = rig(), row = r.f.add('gate', 'call'), index = new Map<string, number>(), seen: string[] = []
  let held = true
  await r.mode.probe()
  const peek = new ItemPeek(r.mode, () => index, async (it, edit) => {
    seen.push(it.id); if (!held) { index.set(it.id, it.version); if (edit) seen.push('edit') }
  }, () => !r.claims.blocked())
  clean.push(() => { r.mode.stop(); peek.stop() })
  peek.reset(); await until(() => r.f.calls.some(c => c.query.has('changed_after')))
  expect(index.size).toBe(0); expect(row.claim).toBeNull()
  held = false; peek.reset(); await until(() => index.has(row.id))
  r.f.change(row, 'edited'); await until(() => seen.includes('edit'))
  expect(r.f.calls.filter(c => c.path.endsWith('/take'))).toHaveLength(0)
})

test('peek echoes Onsen’s token and sees a transaction that commits after the previous as_of', async () => {
  const r = rig(), seen: string[] = []
  r.f.add('old')
  r.f.advance(2000)
  const startedAt = new Date(r.f.now()).toISOString()
  r.f.advance(250)
  await r.mode.probe()
  const path = r.mode.path + '?connector=' + encodeURIComponent(r.mode.connector)
  const page = (await r.mode.req('GET', path))!.json
  expect(Date.parse(page.changed_after)).toBeLessThan(Date.parse(startedAt))
  expect(Date.parse(startedAt)).toBeLessThan(Date.parse(page.as_of))
  const peek = new ItemPeek(r.mode, () => new Map(), async it => { seen.push(it.id + '/' + it.version) }, () => true)
  clean.push(() => { r.mode.stop(); peek.stop() })
  const polls = () => r.f.calls.filter(c => c.query.has('wait') && c.query.has('changed_after'))
  peek.reset()
  await until(() => polls().length > 0)
  expect(polls()[0].query.get('changed_after')).toBe(page.changed_after)
  const late = r.f.add('late', 'message', { updated_at: startedAt })
  expect(r.f.now()).toBeGreaterThan(Date.parse(page.as_of))
  const overlap = (await r.mode.req('GET', path + '&' + new URLSearchParams({ changed_after: page.changed_after })))!.json
  expect(overlap.items.map((it: InboxItem) => it.id)).toEqual(['late'])
  await until(() => seen.includes('late/1') && polls().length >= 2)
  r.f.change(late, 'edited')
  await until(() => seen.includes('late/2'))
  expect(seen).toEqual(['old/1', 'late/1', 'late/2'])
})

test('idle main takes before offer, binds, completes only after final Stop and idle with the conversation reply', async () => {
  const r = await mainRig(), row = r.f.add('happy')
  await r.bind(row)
  expect(r.f.calls.find(c => c.path.endsWith('/take'))!.body).toEqual({ connector: 'mac-mini/adam', item_ids: ['happy'], wait: 0, limit: 1 })
  r.claims.reply('turn', 'other', 'wrong'); r.claims.reply('other', 'conv', 'wrong'); r.claims.reply('turn', 'conv', 'message-91')
  await r.hook('Stop', { phase: 'final' }); r.f.advance(3001)
  for (const state of ['busy', 'stuck', 'compacting']) r.status(state)
  expect(r.claims.held()).toEqual(['happy'])
  r.status('idle'); expect(r.claims.held()).toEqual(['happy'])
  await r.sync()
  expect(r.outcomes(row.id)).toEqual(['in_session', 'completed'])
  expect(row.response_message_ids).toEqual(['message-91']); expect(r.claims.held()).toEqual([])
})

test('while busy mail waits, a person binds inside PostToolUse, pre-switch work finishes without an item report', async () => {
  const r = await mainRig(), old = r.f.add('legacy'), mail = r.f.add('mail', 'mail'), message = r.f.add('person')
  old.state = 'completed'
  const legacy = r.enqueue(old, true)
  await until(() => r.offers.length === 1)
  await r.hook('UserPromptSubmit', { dids: [legacy] }); r.status('busy')
  r.enqueue(mail); r.enqueue(message)
  expect(r.claims.held()).toEqual([])
  await r.hook('PostToolUse'); await r.sync()
  expect(mail.claim).toBeNull(); expect(r.outcomes('legacy')).toEqual([])
  expect(message.claim?.session_id).toBe('main')
  for (const id of r.claims.held()) { const it = r.f.rows.get(id)!; expect(!!it.in_session_at || r.f.now() - Date.parse(it.claim!.taken_at) < 20_000).toBe(true) }
})

test('a due keepwarm waits through a busy turn, then binds and completes on an idle main', async () => {
  const r = await mainRig()
  await r.hook('UserPromptSubmit'); r.status('busy')
  const row = r.f.add('warm', 'keepwarm', { from: 'adam', session_id: 'main', not_before: new Date(r.f.now() + 60_000).toISOString() })
  const did = r.enqueue(row)
  await r.m.pump()
  expect(row.state).toBe('waiting')
  r.f.advance(60_000)
  await r.hook('PostToolUse')
  expect(row.claim).toBeNull()
  r.status('idle'); await r.hook('Stop', { phase: 'final' })
  await r.m.pump()
  await until(() => r.m.items(x => x.id === did)[0]?.state === 'offered')
  await r.hook('UserPromptSubmit', { dids: [did], prompt_id: 'warm' })
  await r.hook('Stop', { prompt_id: 'warm', phase: 'final' })
  r.f.advance(REGISTRY_SETTLE_MS + 1); r.status('idle')
  await r.sync()
  expect(r.outcomes(row.id)).toEqual(['in_session', 'completed'])
})

test('20 s without a bind returns the offer, the same did can bind once on a new claim', async () => {
  const r = await mainRig(), row = r.f.add('miss'), did = r.enqueue(row)
  await until(() => r.offers.length === 1)
  const first = row.claim!.id
  r.f.advance(20_001); r.claims.start(); await until(() => r.misses.length === 1); await r.sync()
  expect(r.m.items(x => x.id === did)[0]?.reason).toBe('offer_untaken')
  expect(r.outcomes(row.id)).toEqual(['not_taken'])
  await r.m.pump(); expect(r.offers.length).toBe(1)
  await r.hook('UserPromptSubmit', { dids: [did] }); await r.sync()
  expect(row.claim!.id).not.toBe(first); expect(r.outcomes(row.id)).toEqual(['not_taken', 'in_session']); expect(r.offers.length).toBe(1)
})

test('a later hook reopens a final Stop; owed and background remain claimed through the next session Stop', async () => {
  const r = await mainRig(), row = r.f.add('owed')
  await r.bind(row); r.owing(true)
  expect((await r.hook('Stop')).block).toBeTruthy(); await r.sync()
  expect(r.outcomes(row.id)).toContain('owed')
  await r.hook('Stop', { phase: 'final' }); await r.hook('PreToolUse')
  r.f.advance(3100); r.status('idle'); await r.sync()
  expect(r.outcomes(row.id)).not.toContain('completed')
  await r.hook('Stop', { phase: 'final' }); r.f.advance(3100); r.status('idle', 1); await r.sync()
  expect(r.outcomes(row.id)).toContain('background')
  r.status('idle', 0); await r.sync(); expect(r.claims.held()).toEqual(['owed'])
  await r.hook('UserPromptSubmit', { prompt_id: 'next' }); await r.hook('Stop', { phase: 'final', prompt_id: 'next' })
  r.f.advance(3100); r.status('idle'); await r.sync(); expect(row.state).toBe('completed')
})

for (const [kind, event, err, expected] of [
  ['message', 'UserPromptSubmit', '', 'cut_person'], ['call', 'UserPromptSubmit', '', 'cut'],
  ['message', 'SessionEnd', '', 'cut'], ['call', 'StopFailure', 'server_error', 'error'],
  ['message', 'StopFailure', 'rate_limit', 'usage_limit'],
] as const) test(kind + ' ends with ' + event + ' ' + err + ' -> ' + expected, async () => {
  const r = await mainRig(), row = r.f.add('work', kind)
  await r.bind(row)
  await r.hook('PreToolUse', { tool_name: 'Read' }); await r.hook('PreCompact'); await r.sync(); expect(r.outcomes(row.id)).toEqual(['in_session'])
  await r.hook(event, { prompt_id: event === 'UserPromptSubmit' ? 'other' : 'turn', error: err }); await r.sync()
  expect(r.outcomes(row.id)).toEqual(['in_session', expected]); expect(r.f.history.at(-1)!.body.half_done).toBe(true)
})

test('asked restart closes the commander’s work and cuts the peer on the same turn', async () => {
  const r = await mainRig(), person = r.f.add('person'), call = r.f.add('call', 'call', { from: 'eve' })
  await r.bind(person); r.enqueue(call); await r.hook('PostToolUse'); await r.sync()
  r.m.markEnd('asked', { from: 'joey', message_id: 'command-7' }); await r.hook('SessionEnd'); await r.sync()
  expect(r.f.history.find(l => l.item_id === 'person' && l.body.outcome === 'stopped')!.body.command_message_id).toBe('command-7')
  expect(r.outcomes('call')).toEqual(['in_session', 'cut'])
})

test('restart renews the same connector, terminal report survives outage and blocks peek/take until ack', async () => {
  const r = rig(), row = r.f.add('restart')
  await r.mode.probe(); await r.receiver.receive([itemRef(row)]); r.receiver.bind([itemRef(row)], 'main', 't', 's'); await r.sync()
  r.claims.stop(); r.mode.stop()
  const other = new TakeMode('adam', r.client.request.bind(r.client), () => {}, () => {}, 'mac-mini')
  await other.probe()
  const restored = new Claims(r.file, r.client, () => {}, () => {}, r.f.now)
  r.client.watchItemReports(l => restored.replay(l), (l, ok) => restored.acknowledged(l, ok))
  clean.push(() => { restored.stop(); other.stop() })
  r.f.advance(40_000)
  const renew = await r.client.putBytes('/v1/members/adam/observation', Buffer.from(JSON.stringify({ connector: other.connector, held_item_ids: restored.held() })),
    'application/json', 3000, { 'Idempotency-Key': 'renew' })
  expect(renew?.status).toBe(200); expect(row.claim?.expires_at).toBe(new Date(r.f.now() + 45_000).toISOString())
  r.f.down(true); restored.report(row.id, 'completed'); await r.sync()
  r.f.advance(120_000); expect(row.reason).toBe('cut')
  const rec = new ItemReceiver(other, restored, () => {}), next = r.f.add('next')
  r.f.down(false)
  const count = r.f.calls.length
  expect((await rec.receive([itemRef(next)])).given.size).toBe(0)
  const peek = new ItemPeek(other, () => new Map(), async () => {}, () => !restored.blocked())
  await peek.poll(); peek.stop(); expect(r.f.calls).toHaveLength(count)
  await r.sync(); expect(r.f.calls[count]!.path).toBe('/v1/items/restart/report')
  expect(restored.held()).toEqual([]); expect(row.state).toBe('completed'); expect(restored.completed(row.id)).toBe(true)
})

test('not_before, rides_next and parked refusals are checked by id; a vanished row leaves the local queue', async () => {
  const r = rig(), later = r.f.add('later', 'mail', { not_before: new Date(r.f.now() + 60000).toISOString() }),
    ride = r.f.add('ride', 'message', { reason: 'cut_person' }), parked = r.f.add('parked', 'call', { reason: 'parked' }),
    gone = r.f.add('gone', 'mail', { state: 'cancelled' })
  await r.mode.probe()
  const result = await r.receiver.receive([later, ride, parked, gone].map(itemRef))
  expect(result.given.size).toBe(0); expect([...result.gone]).toEqual(['gone']); expect(r.deadlines).toContain(later.not_before!)
  expect(r.f.calls.filter(c => /^\/v1\/items\//.test(c.path))).toHaveLength(4)
  const other = r.f.add('other')
  expect((await r.receiver.receive([ride, other].map(itemRef))).given.size).toBe(2)
})

test('hook timeout gets nothing; the exact take is replayed and its claim returned through ir', async () => {
  const r = rig(), row = r.f.add('slow')
  await r.mode.probe(); r.f.delayTake(3300)
  const began = Date.now()
  expect((await r.receiver.receive([itemRef(row)], true)).given.size).toBe(0)
  expect(Date.now() - began).toBeLessThan(3200)
  await until(() => r.client.hasItemReports())
  const takes = r.f.calls.filter(c => c.path.endsWith('/take'))
  expect(takes).toHaveLength(2); expect(takes[0]!.key).toEqual(takes[1]!.key)
  await r.sync(); expect(r.outcomes('slow')).toEqual(['not_taken'])
}, 6000)

test('late conflicting report is logged, a permanent 4xx is rejected and the spool advances', async () => {
  const r = rig(), row = r.f.add('settled')
  await r.mode.probe(); await r.receiver.receive([itemRef(row)])
  const id = row.claim!.id
  r.claims.report(row.id, 'completed'); await r.sync()
  for (const item_id of [row.id, 'missing']) r.client.recordItemReport({ item_id, body: { claim_id: id, at: new Date().toISOString(), outcome: 'cut' } })
  await r.sync()
  expect(r.client.pendingBytes()).toBe(0); expect(r.logs.some(l => l.includes('version_conflict'))).toBe(true)
  expect(readFileSync(r.client.rejected, 'utf8')).toContain('missing')
})

test('a foreign connector pauses all receives for 45 s and keeps the observation latched', async () => {
  const r = rig()
  let retry: (() => void) | undefined, interval = 0
  const mode = new TakeMode('adam', r.mode.req, () => {}, line => r.logs.push(line), 'mac-mini', (next, ms) => {
    interval = ms; retry = next
    return setTimeout(() => {}, ms).unref()
  })
  clean.push(() => mode.stop())
  await mode.probe(); r.f.advance(45_001)
  await deliveryMode(mode.req, mode.path, 'other/adam')
  const receiver = new ItemReceiver(mode, r.claims, () => {}), row = r.f.add('ownership')
  await receiver.receive([itemRef(row)])
  expect(interval).toBe(45_000); expect(mode.active).toBe(false); expect(mode.observationRequired).toBe(true)
  const calls = r.f.calls.length
  await receiver.receive([itemRef(row)])
  const peek = new ItemPeek(mode, () => new Map(), async () => {}, () => true)
  await peek.poll(); expect(r.f.calls.length).toBe(calls)
  expect(r.logs.filter(s => s.includes('not_current_connector'))).toHaveLength(1)
  r.f.advance(45_001); retry!(); await until(() => mode.active)
  expect([...(await receiver.receive([itemRef(row)])).given]).toEqual(['ownership'])
})

test('M2 stuck is intermediate, the lease remains open and the final Stop completes it', async () => {
  const r = await mainRig(), row = r.f.add('stuck')
  await r.bind(row); r.status('busy')
  await r.m.tick(Date.now() + MAIN_STUCK_MS + 1000); await r.sync()
  expect(r.outcomes(row.id)).toEqual(['in_session', 'stuck']); expect(r.claims.held()).toEqual(['stuck'])
  await r.hook('Stop', { phase: 'final' }); r.f.advance(3100); r.status('idle'); await r.sync()
  expect(row.state).toBe('completed')
})

test('walled main leaves mail and person waiting, keeper-clear probe reports the reset time when refused', async () => {
  const r = await mainRig(), first = r.f.add('first'), mail = r.f.add('blocked-mail', 'mail'), person = r.f.add('probe')
  await r.bind(first)
  const reset = new Date(r.f.now() + 60_000).toISOString()
  r.setWall({ walled: true, clearedMs: null, lastWallMs: Date.now(), resets_at: reset })
  await r.hook('StopFailure', { error: 'rate_limit' }); await r.sync()
  expect(r.f.history.at(-1)!.body.retry_after).toBe(reset)
  const did = r.enqueue(person); r.enqueue(mail); await r.m.pump()
  expect(r.claims.held()).toEqual([]); expect(mail.state).toBe('waiting'); expect(person.state).toBe('waiting')
  r.setWall({ walled: false, clearedMs: Date.now() + 1000, resets_at: reset })
  await r.m.pump(); await r.hook('UserPromptSubmit', { dids: [did], prompt_id: 'probe' })
  await r.hook('StopFailure', { prompt_id: 'probe', error: 'rate_limit' }); await r.sync()
  expect(r.outcomes(person.id)).toEqual(['in_session', 'usage_limit_probe'])
  expect(r.f.history.at(-1)!.body.retry_after).toBe(reset); expect(mail.state).toBe('waiting')
})

test('one album offer acquires its three rows in one request and sends one notification', async () => {
  const r = await mainRig(), album = ['a','b','c'].map(id => r.f.add(id))
  const did = r.m.enqueue('joey', { method: 'notifications/claude/channel', params: { content: '3 photos', meta: { chat_id: '1' } } },
    { fields: { onsen_items: album.map(itemRef) } })
  await until(() => r.offers.length === 1)
  expect(r.f.calls.filter(c => c.path.endsWith('/take')).map(c => c.body.item_ids)).toEqual([['a','b','c']])
  await r.hook('UserPromptSubmit', { dids: [did] }); await r.sync()
  expect(album.every(row => row.claim?.session_id === 'main')).toBe(true)
})

for (const take of [false, true]) test('both closed-work notices on inherited rows, take=' + take, async () => {
  for (const why of ['cut_twice', 'stop_failure_gave_up']) {
    const r = await mainRig()
    if (!take) r.mode.stop()
    const row = r.f.add(why), did = r.enqueue(row, true)
    await until(() => r.offers.length > 0)
    await r.hook('UserPromptSubmit', { dids: [did] })
    r.journal.write('msg', did, 'bound', { cuts: 1, fails: 3, fail_released: true })
    if (why === 'cut_twice') {
      await r.hook('PreToolUse', { tool_name: 'Read' }); await r.hook('SessionEnd')
    } else await r.hook('StopFailure', { error: 'server_error' })
    expect(r.journal.get('msg', did)?.reason).toBe(why)
    expect(r.notices.filter(n => n === 'main-cut')).toHaveLength(take ? 0 : 1)
    expect(r.f.calls.some(c => c.path.endsWith('/report'))).toBe(false)
  }
})

test('an inclusive timestamp shared by two pages does not route unchanged gated rows twice', async () => {
  const r = rig(), versions: string[] = []
  const rows = Array.from({ length: 102 }, (_, i) => r.f.add(String(i)))
  const at = new Date(r.f.now()).toISOString()
  for (const row of rows) row.updated_at = at
  await r.mode.probe()
  const first = (await r.mode.req('GET', r.mode.path + '?connector=' + encodeURIComponent(r.mode.connector)))!.json
  const peek = new ItemPeek(r.mode, () => new Map(), async row => {
    if (!versions.length) r.f.advance(100)
    versions.push(row.id)
  }, () => true)
  clean.push(() => { r.mode.stop(); peek.stop() })
  peek.reset()
  await until(() => r.f.calls.filter(c => c.query.has('changed_after') && c.query.has('cursor')).length >= 2)
  expect(r.f.calls.filter(c => c.query.has('changed_after')).slice(0, 2).map(c => c.query.get('changed_after')))
    .toEqual([first.changed_after, first.changed_after])
  expect(versions).toEqual(rows.map(row => row.id))
})
