import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fakeItems } from './test-fixtures/onsen-items.ts'
import { OnsenClient, roamerMember } from './onsen-client.ts'
import { OnsenInbox, OnsenPuller, switchOn } from './onsen-inbox.ts'
import { deliveryMode, machineName, takeRefusal, TakeMode, takeModeActive } from './onsen-take.ts'
import { ItemPeek, itemRef, roamerSessionId, type InboxItem } from './onsen-items.ts'
import { Claims } from './onsen-claims.ts'
import { ItemReceiver, type Outcome } from './onsen-receive.ts'
import { createMain, MAIN_IDLE_CONFIRM_MS, MAIN_STUCK_MS, toolSilenceMs, type MainApi, type MainEvent, type MainWall } from './lanes-main.ts'
import { Journal } from './lanes-state.ts'
import { Registry, REGISTRY_SETTLE_MS } from './onsen-status.ts'

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
  const client = new OnsenClient({ dir, agent: 'adam', record: true, base: f.base, credential: () => 'test-member', log: (level, m) => logs.push(`[${level}] ${m}`) })
  const mode = new TakeMode('adam', client.request.bind(client), () => {}, line => logs.push(line), 'mac-mini')
  const file = join(dir, 'claims.json')
  let main: MainApi | undefined
  const claims = new Claims(file, client, (id, outcome) => { misses.push(id); main?.offerMissed(id, outcome) }, () => {}, f.now, id => main?.unboundOutcome(id) ?? 'not_taken')
  client.watchItemReports(r => claims.replay(r), (r, ok) => claims.acknowledged(r, ok))
  const receiver = new ItemReceiver(mode, claims, time => deadlines.push(time))
  clean.push(() => { mode.stop(); claims.stop(); client.stop(); f.stop(); rmSync(dir, { recursive: true, force: true }) })
  const outcomes = (id: string) => f.history.filter(r => r.item_id === id).map(r => r.body.outcome)
  return { f, client, mode, claims, file, receiver, dir, logs, misses, deadlines, outcomes, sync: () => client.syncNow(true),
    attach(m: MainApi) { main = m } }
}
async function mainRig(backoff = 300_000, onOffer = async () => true, restart?: (retryPid?: number) => Promise<void>, pid = 1051) {
  const r = rig()
  await r.mode.probe()
  const journal = new Journal(join(r.dir, 'state.jsonl')), offers: any[] = [], notices: string[] = []
  const sid = crypto.randomUUID()
  let oldPidAlive = true
  let member = 'idle', bg = 0, owes: boolean | string = false, wall: MainWall | null = null
  const restarts: string[] = []
  const writer = { write: (write: import('./onsen-item-writes.ts').ItemWrite) => { r.client.recordItemWrite(write); r.client.start() } }
  const m = createMain({ journal, agent: 'adam', takingItems: () => r.mode.active, writeItem: write => writer.write(write), writtenItemId: key => r.client.writtenItemId(key), itemReceiver: () => r.receiver, log: () => {}, offer: async n => { offers.push(n); return onOffer() },
    wallBackoff: () => backoff, registry: { mainForAdoption: () => null, backgroundAgents: () => bg },
    streamOpen: () => true, memberState: () => member, expectedSession: () => [sid], pidAlive: n => n !== pid || oldPidAlive, context: () => '', info: () => null,
    genChanged: () => {}, refused: () => {}, done: () => {}, undone: () => {},
    restartSession: async retryPid => { restarts.push(sid); await restart?.(retryPid); return sid }, tellJoey: (_s, rule) => notices.push(rule), genuineAfter: () => 1,
    mainOwed: ids => ids.filter(id => owes === true || owes === id).map(id => ({ id, from: 'joey', text: id, owes: ['reply'] })), usageWall: () => wall })
  r.client.watchItemWrites(m.itemWriteSettled)
  m.initMain(); r.attach(m)
  const hook = (event: string, data: Partial<MainEvent> = {}) => m.mainEvent({ event, pid, session_id: sid, prompt_id: 'turn', ...data })
  await hook('SessionStart', { source: 'startup' })
  const enqueue = (row: InboxItem, old = false) => m.enqueue(row.kind === 'message' ? 'joey' : 'peer',
    { method: 'notifications/claude/channel', params: { content: row.payload.text, meta: { chat_id: '1', message_id: String(row.number), user: row.from } } },
    { event: row.id, fields: old ? {} : { onsen_items: [itemRef(row)], person_message_ids: row.message_id ? [row.message_id] : [] } })
  const bind = async (row: InboxItem, prompt = 'turn') => {
    const did = enqueue(row)
    await until(() => m.items(x => x.id === did)[0]?.state === 'offered')
    await hook('UserPromptSubmit', { dids: [did], prompt_id: prompt }); await r.sync()
    expect(r.outcomes(row.id)).toContain('in_session')
    return did
  }
  return { ...r, writer, m, journal, offers, notices, restarts, hook, enqueue, bind, sid, oldPidExited() { oldPidAlive = false }, setWall(value: MainWall | null) { wall = value }, status(s: string, n = 0) { member = s; bg = n; r.claims.statusRecord(sid, s, () => bg, REGISTRY_SETTLE_MS) },
    owing(value: boolean | string) { owes = value } }
}

test('loopback list and detail match the captured 0.40.0 envelopes and add the S2 fields', async () => {
  const captured = (file: string) => JSON.parse(readFileSync(join(import.meta.dir, 'test-fixtures', 'onsen-0.40.0', file + '.json'), 'utf8'))
  const r = rig(), page = captured('list-completed'), empty = captured('list-waiting')
  expect(captured('list-cancelled').items).toEqual(empty.items)
  expect(page.items.filter((row: any) => row.session_id === 'main')).toHaveLength(34)
  for (const kind of ['message', 'control', 'call']) {
    const real = captured('detail-' + kind).data
    const row = r.f.add(kind, kind, { message_id: real.message_id, call_id: real.call_id })
    const result = (await r.client.request('GET', '/v1/items/' + row.id))!.json.data
    expect(Object.keys(result).sort()).toEqual([...Object.keys(real), 'note', 'payload'].sort())
    expect(Object.keys(result.events[0]).sort()).toEqual(Object.keys(real.events[0]).sort())
    expect(result.takeable.now).toBe(true)
  }
  // No mail was captured. Settled 34 preserves the payload from the legacy mail push verbatim.
  const payload = { text: 'station ready', line: 'mail', logged: true, msg_id: 81 }
  const mail = r.f.add('mail', 'mail', { from: 'eve', mail_id: '81', payload })
  r.f.mode(409)
  const old = (await r.client.request('GET', '/inbox?after=0&limit=100'))!.json.items.find((it: any) => it.seq === mail.number)
  expect(old.payload).toEqual(payload)
  r.f.mode(200)
  const list = (await r.client.request('GET', r.mode.path + '?connector=mac-mini/adam'))!.json
  expect(Object.keys(list).sort()).toEqual([...Object.keys(empty), 'changed_after'].sort())
  for (const row of list.items) expect(Object.keys(row).sort()).toEqual([...Object.keys(page.items[0]), 'note', 'payload'].sort())
  const detail = (await r.client.request('GET', '/v1/items/mail'))!.json.data
  const take = (await r.client.request('POST', r.mode.path + '/take', { connector: r.mode.connector, item_ids: ['mail'], limit: 1, wait: 0 },
    3000, { 'Idempotency-Key': 'mail-contract' }))!.json.data.items[0]
  for (const row of [list.items.find((it: any) => it.id === mail.id), detail, take])
    expect(row).toMatchObject({ kind: 'mail', mail_id: '81', note: null, payload: old.payload })
  expect(detail.events).toBeArray()
})

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

test('C4 reuses the C5 pending Item line and durable id across client restart', async () => {
  const r = await mainRig()
  r.writer.write = write => r.client.recordItemWrite(write)
  await r.hook('UserPromptSubmit')
  await r.hook('StopFailure', { error: 'overloaded' })
  const { key, create } = r.m.currentGen()!.resume_items[0]
  const restarted = new OnsenClient(r.client.cfg)
  for (let n = 0; n < 10; n++) {
    await r.m.pump()
    restarted.recordItemWrite({ key, item: create })
  }
  const lines = () => readFileSync(r.client.spool, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(lines()).toEqual([{ k: 'item', r: { key, item: create } }])
  await r.sync()
  const [row] = r.f.rows.values()
  expect(restarted.writtenItemId(key)).toBe(row!.id)
  await r.hook('UserPromptSubmit', { prompt_id: 'continued', dids: [] })
  await r.sync()
  expect(lines().map(line => line.k)).toEqual(['item', 'item'])
  expect(lines()[1].r).toMatchObject({ id: row!.id, outcome: 'superseded' })
  expect(row).toMatchObject({ state: 'cancelled', reason: 'superseded' })
  expect(restarted.writtenItemId(key)).toBeUndefined()
  expect(r.f.calls.filter(call => call.body.kind === 'resume')).toHaveLength(1)
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

async function accountCut(onOffer?: () => Promise<boolean>) {
  const r = await mainRig(undefined, onOffer)
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
  pending.f.mode(409); await pending.mode.probe() // C3: only a probe that answers pull puts the member on pull
  await pending.hook('UserPromptSubmit')
  await pending.hook('StopFailure', { error: 'overloaded' })
  const retry = pending.m.currentGen()!.cut_turn.retry_at
  pending.f.mode(200); await pending.mode.probe(); await pending.m.pump()
  await until(() => pending.f.rows.size === 1)
  expect([...pending.f.rows.values()][0]!.not_before).toBe(new Date(retry).toISOString())
  expect(pending.m.currentGen()?.cut_turn).toBeUndefined()
  expect(pending.offers).toHaveLength(0)

  let finish!: (sent: boolean) => void
  const writing = await mainRig(0, () => new Promise(resolve => { finish = resolve }))
  writing.f.mode(409); await writing.mode.probe()
  await writing.hook('UserPromptSubmit')
  await writing.hook('StopFailure', { error: 'overloaded' })
  const receipt = writing.m.pump()
  await until(() => writing.offers.length === 1)
  writing.f.mode(200); await writing.mode.probe(); await writing.m.pump()
  finish(true); await receipt; await writing.m.pump()
  expect(writing.m.currentGen()!.resumes).toBe(1)
  expect(writing.f.calls.filter(c => c.body.kind === 'resume')).toHaveLength(0)
})

test.each(['queued create', 'waiting row'])('C4 a refused new prompt shares the session’s %s', async stage => {
  const r = await mainRig()
  r.writer.write = write => r.client.recordItemWrite(write)
  r.setWall({ walled: true, clearedMs: null })
  await r.hook('UserPromptSubmit')
  await r.hook('StopFailure', { error: 'rate_limit' })
  if (stage === 'waiting row') await r.sync()
  const key = r.m.currentGen()!.resume_items[0].key
  await r.hook('StopFailure', { prompt_id: 'refused-retry', error: 'rate_limit' })
  await r.sync()
  const rows = [...r.f.rows.values()]
  expect(rows).toHaveLength(1)
  expect(r.f.calls.filter(c => c.body.kind === 'resume').map(c => c.key)).toEqual([key])
  r.m.routeResume(itemRef(rows[0]!), rows[0]!.payload.text)
  r.setWall({ walled: false, clearedMs: Date.now() + 1000 })
  await until(() => { void r.m.pump(); return r.offers.length === 1 })
  await r.hook('UserPromptSubmit', { prompt_id: 'received', dids: [r.offers[0].params.meta.did] })
  await r.hook('Stop', { prompt_id: 'received', phase: 'final' })
  r.f.advance(REGISTRY_SETTLE_MS + 1); r.status('idle'); await r.sync()
  expect(r.outcomes(rows[0]!.id)).toEqual(['in_session', 'completed'])
  expect(r.offers).toHaveLength(1)
  await r.hook('UserPromptSubmit', { prompt_id: 'later-work', dids: [] })
  await r.hook('StopFailure', { prompt_id: 'later-work', error: 'server_error' }); await r.sync()
  expect([...r.f.rows.values()].map(row => row.state)).toEqual(['completed', 'waiting'])
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

test.each(['settling', 'background'])('C4 a later itemless turn lets the delivered resume finish (%s)', async phase => {
  const background = phase === 'background'
  const r = await accountCut()
  r.setWall({ walled: false, clearedMs: Date.now() + 1000 })
  await r.m.pump()
  await r.hook('UserPromptSubmit', { prompt_id: 'received', dids: [r.offers[0].params.meta.did] })
  await r.hook('Stop', { prompt_id: 'received', phase: 'final' })
  r.f.advance(background ? REGISTRY_SETTLE_MS + 1 : 100)
  r.status('idle', background ? 1 : 0); await r.sync()
  const prior: Outcome[] = background ? ['in_session', 'background'] : ['in_session']
  expect(r.outcomes(r.row.id)).toEqual(prior)
  await r.hook('UserPromptSubmit', { prompt_id: 'notification', dids: [] })
  await r.sync()
  expect(r.outcomes(r.row.id)).toEqual(prior)
  await r.hook('Stop', { prompt_id: 'notification', phase: 'final' })
  r.f.advance(REGISTRY_SETTLE_MS + 1); r.status('idle'); await r.sync()
  expect(r.outcomes(r.row.id)).toEqual([...prior, 'completed'])
  expect(r.offers).toHaveLength(1)
})

test.each(['bound', 'done'])('C4 a folded %s M1 delivery protects a resume without a local claim', async state => {
  const r = await accountCut()
  const receipt = r.m.items(it => it.onsen_items?.[0]?.onsen_item_id === r.row.id)[0]!
  r.journal.write('msg', receipt.id, state, { gen: r.m.currentGen()!.id, prompt_id: 'received' })
  await r.hook('UserPromptSubmit', { prompt_id: 'automatic', dids: [] })
  await r.sync()
  expect(r.row.state).toBe('waiting')
  expect(r.f.calls.some(c => c.body.outcome === 'superseded')).toBe(false)
})

test('C4 an in-session claim protects a resume before the M1 bound write', async () => {
  const r = await accountCut()
  r.setWall({ walled: false, clearedMs: Date.now() + 1000 }); await r.m.pump()
  r.claims.bind(r.row.id, 'main', 'received', r.sid); await r.sync()
  await r.hook('UserPromptSubmit', { prompt_id: 'automatic', dids: [] }); await r.sync()
  expect(r.outcomes(r.row.id)).toEqual(['in_session'])
})

test('C4 a delayed create acknowledgement respects an existing M1 delivery of that Item', async () => {
  const r = await mainRig()
  r.writer.write = write => r.client.recordItemWrite(write)
  r.setWall({ walled: true, clearedMs: null })
  const request = r.client.request.bind(r.client)
  let release!: () => void
  const ack = new Promise<void>(resolve => { release = resolve })
  spyOn(r.client, 'request').mockImplementation(async (...args) => {
    const reply = await request(...args)
    if (args[0] === 'POST' && args[1] === r.mode.path) await ack
    return reply
  })
  await r.hook('UserPromptSubmit')
  await r.hook('StopFailure', { error: 'rate_limit' })
  const writing = r.sync()
  await until(() => r.f.rows.size === 1)
  const row = [...r.f.rows.values()][0]!
  r.m.routeResume(itemRef(row), row.payload.text)
  const receipt = r.m.items(it => it.onsen_items?.[0]?.onsen_item_id === row.id)[0]!
  r.journal.write('msg', receipt.id, 'bound', { gen: r.m.currentGen()!.id, prompt_id: 'received' })
  await r.hook('UserPromptSubmit', { prompt_id: 'notification', dids: [] })
  release()
  await writing; await r.sync()
  expect(r.journal.get('msg', receipt.id)?.state).toBe('bound')
  expect(r.f.calls.some(c => c.body.outcome === 'superseded')).toBe(false)
})

test('C4 an offline unbound resume remembers the continuation and expires as superseded', async () => {
  const r = await accountCut()
  r.setWall({ walled: false, clearedMs: Date.now() + 1000 })
  await r.m.pump()
  r.f.down(true)
  await r.hook('UserPromptSubmit', { prompt_id: 'automatic', dids: [] })
  await r.hook('Stop', { prompt_id: 'automatic', phase: 'final' })
  expect(r.client.hasItemReports()).toBe(false)
  r.f.advance(25_000); r.claims.start()
  await until(() => r.client.hasItemReports())
  await r.sync()
  r.f.down(false); await r.sync()
  expect(r.outcomes(r.row.id)).toEqual(['superseded'])
  expect(r.misses).toEqual([r.row.id])
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

test.each(['UserPromptSubmit', 'PreToolUse', 'Stop'])('C4 a background notification first seen at %s preserves the waiting resume', async event => {
  const r = await accountCut()
  await r.hook(event, { prompt_id: 'notification', source: 'task-notification', dids: [], phase: 'final' })
  if (event !== 'Stop') await r.hook('Stop', { prompt_id: 'notification', phase: 'final' })
  await r.sync()
  expect(r.row.state).toBe('waiting')
  expect(r.f.calls.filter(c => c.body.outcome)).toHaveLength(0)
})

test('a pull member keeps its local offer binding when a background notification opens a turn', async () => {
  const r = await mainRig()
  r.mode.stop()
  const did = r.enqueue(r.f.add('legacy-delivery'), true)
  await until(() => r.journal.get('msg', did)?.state === 'offered')
  await r.hook('UserPromptSubmit', { prompt_id: 'legacy-prompt', source: 'task-notification', dids: [] })
  expect(r.journal.get('msg', did)).toMatchObject({ state: 'bound', prompt_id: 'legacy-prompt' })
  expect(r.f.calls.some(c => c.path.endsWith('/take'))).toBe(false)
})

test('a take member ignores a delivery id quoted inside background output', async () => {
  const r = await accountCut()
  const did = r.enqueue(r.f.add('quoted-work', 'call'))
  await r.hook('UserPromptSubmit', { prompt_id: 'notification', source: 'task-notification', dids: [did], channel_dids: [] })
  await r.hook('Stop', { prompt_id: 'notification', phase: 'final' }); await r.sync()
  expect(r.journal.get('msg', did)?.state).toBe('queued')
  expect(r.row.state).toBe('waiting')
})

test('C4 a new prompt first seen at a tool with no origin cannot discard the interrupted prompt', async () => {
  const r = await accountCut()
  await r.hook('PreToolUse', { prompt_id: 'unidentified', tool_name: 'Read' })
  await r.hook('Stop', { prompt_id: 'unidentified', phase: 'final' }); await r.sync()
  expect(r.row.state).toBe('waiting')
})

test('C4 auto-resume between the server take and its response spools superseded without a stream write', async () => {
  const r = await accountCut()
  r.f.delayTake(100)
  r.setWall({ walled: false, clearedMs: Date.now() + 1000 })
  const offer = r.m.pump()
  await until(() => r.row.state === 'claimed')
  const claim = r.row.claim!.id
  await r.hook('PreToolUse', { prompt_id: 'turn', tool_name: 'Read' })
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
      await r.hook('PreToolUse', { prompt_id: 'turn', tool_name: 'Read' })
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

test.each(['PreToolUse', 'Stop'])('C4 the first %s binds the offered resume claim when UserPromptSubmit was lost', async first => {
  const r = await accountCut()
  r.setWall({ walled: false, clearedMs: Date.now() + 1000 }); await r.m.pump()
  const did = r.offers[0].params.meta.did
  expect(r.claims.owns(r.row.id)).toBe(true)
  await r.hook(first, { prompt_id: 'by-claim', tool_name: 'Read', phase: 'final' })
  await r.sync()
  expect(r.outcomes(r.row.id)).toEqual(['in_session'])
  expect(r.journal.get('msg', did)?.prompt_id).toBe('by-claim')
  if (first !== 'Stop') await r.hook('Stop', { prompt_id: 'by-claim', phase: 'final' })
  r.f.advance(REGISTRY_SETTLE_MS + 1); r.status('idle'); await r.sync()
  expect(r.outcomes(r.row.id)).toEqual(['in_session', 'completed'])
})

test('C4 a late did whose re-take is blocked preserves the unrelated waiting resume', async () => {
  const r = await accountCut()
  r.client.stop()
  r.writer.write = write => r.client.recordItemWrite(write)
  const prior = r.f.add('prior-claim')
  await r.receiver.receive([itemRef(prior)])
  r.claims.report(prior.id, 'cut')
  const late = r.f.add('late-work', 'call'), did = r.enqueue(late)
  expect(r.claims.blocked()).toBe(true)
  await r.hook('UserPromptSubmit', { prompt_id: 'late', dids: [did] })
  await r.sync(); await r.m.pump(); await r.sync()
  expect(r.journal.get('msg', did)?.state).toBe('queued')
  expect(r.outcomes(late.id)).toEqual([])
  expect(r.row.state).toBe('waiting')
  expect(r.f.calls.some(c => c.body.outcome === 'superseded')).toBe(false)
})

test.each(['item id', 'earlier did'])('C4 a prompt naming the %s binds the current receipt for that Item', async name => {
  const r = await accountCut()
  const row = r.f.add('named-work', 'call')
  const old = r.enqueue(row)
  r.journal.write('msg', old, 'done', { reason: 'old receipt' })
  const current = r.enqueue(row)
  await r.hook('UserPromptSubmit', { prompt_id: 'named', dids: [name === 'item id' ? row.id : old] })
  await r.sync()
  expect(r.outcomes(row.id)).toEqual(['in_session'])
  expect(r.journal.get('msg', current)).toMatchObject({ state: 'bound', prompt_id: 'named' })
  expect(r.row.state).toBe('waiting')
})

test('C4 a claimed offer that never reaches a turn is superseded', async () => {
  const claimed = await accountCut()
  claimed.setWall({ walled: false, clearedMs: Date.now() + 1000 })
  await claimed.m.pump()
  expect(claimed.offers).toHaveLength(1)
  await claimed.hook('UserPromptSubmit', { prompt_id: 'automatic', dids: [] })
  await claimed.hook('Stop', { prompt_id: 'automatic', phase: 'final' })
  expect(claimed.client.hasItemReports()).toBe(false)
  claimed.f.advance(20_001); claimed.claims.start()
  await until(() => claimed.client.hasItemReports())
  await claimed.sync(); await claimed.m.tick()
  expect(claimed.outcomes(claimed.row.id)).toEqual(['superseded'])
  expect(claimed.offers).toHaveLength(1)
})

test.each(['same prompt', 'next prompt'])('settled 59: a queued resume actually enters the %s after an independent turn starts', async timing => {
  const r = await accountCut()
  r.setWall({ walled: false, clearedMs: Date.now() + 1000 })
  await r.m.pump()
  const did = r.offers[0].params.meta.did, claim = r.row.claim!.id
  await r.hook('UserPromptSubmit', { prompt_id: 'automatic', dids: [] })
  if (timing === 'next prompt') await r.hook('Stop', { prompt_id: 'automatic', phase: 'final' })
  await r.sync()
  expect(r.row.state).toBe('claimed')
  const prompt_id = timing === 'next prompt' ? 'with-text' : 'automatic'
  await r.hook('UserPromptSubmit', { prompt_id, dids: [did] })
  await r.hook('Stop', { prompt_id, phase: 'final' })
  r.f.advance(REGISTRY_SETTLE_MS + 1); r.status('idle'); await r.sync()
  expect(r.outcomes(r.row.id)).toEqual(['in_session', 'completed'])
  expect(r.f.history.every(h => h.body.claim_id === claim)).toBe(true)
  expect(r.offers).toHaveLength(1)
})

test.each([true, false])('settled 59: continuation during the stream write reports what reached the turn (write=%p)', async written => {
  let finish!: (ok: boolean) => void
  const r = await accountCut(() => new Promise(resolve => { finish = resolve }))
  r.setWall({ walled: false, clearedMs: Date.now() + 1000 })
  const sending = r.m.pump()
  await until(() => r.offers.length === 1)
  await r.hook('UserPromptSubmit', { prompt_id: 'automatic', dids: [] })
  await r.sync()
  expect(r.outcomes(r.row.id)).toEqual([])
  finish(written); await sending
  if (written) {
    await r.hook('UserPromptSubmit', { prompt_id: 'with-text', dids: [r.offers[0].params.meta.did] })
    await r.hook('Stop', { prompt_id: 'with-text', phase: 'final' })
    r.f.advance(REGISTRY_SETTLE_MS + 1); r.status('idle')
  }
  await r.sync()
  expect(r.outcomes(r.row.id)).toEqual(written ? ['in_session', 'completed'] : ['superseded'])
})

test.each(['late receipt', 'session end', 'confirmed idle'])('settled 59: a long independent turn leaves the queued input open for its %s', async end => {
  const r = await accountCut()
  r.setWall({ walled: false, clearedMs: Date.now() + 1000 }); await r.m.pump()
  const did = r.offers[0].params.meta.did
  await r.hook('UserPromptSubmit', { prompt_id: 'automatic', dids: [] })
  r.f.advance(20_001); r.claims.start()
  await until(() => r.client.hasItemReports()); await r.sync()
  expect(r.row.state).toBe('waiting')
  expect(r.outcomes(r.row.id)).toEqual(['not_taken'])
  if (end === 'late receipt') {
    await r.hook('Stop', { prompt_id: 'automatic', phase: 'final' })
    r.m.statusIdle(true)
    await r.hook('UserPromptSubmit', { prompt_id: 'queued-text', dids: [did] })
    await r.hook('Stop', { prompt_id: 'queued-text', phase: 'final' })
    r.f.advance(REGISTRY_SETTLE_MS + 1); r.status('idle'); await r.sync()
    expect(r.outcomes(r.row.id)).toEqual(['not_taken', 'in_session', 'completed'])
    expect(r.row.state).toBe('completed')
  } else {
    if (end === 'confirmed idle') {
      await r.hook('Stop', { prompt_id: 'automatic', phase: 'final' })
      const now = Date.now()
      r.m.statusIdle(true, now); await r.sync()
      expect(r.row.state).toBe('waiting')
      r.m.statusIdle(true, now + MAIN_IDLE_CONFIRM_MS + 1)
    } else await r.hook('SessionEnd')
    await r.sync()
    expect(r.row).toMatchObject({ state: 'cancelled', reason: 'superseded' })
  }
  expect(r.offers).toHaveLength(1)
})

test.each(['waiting', 'claimed before the receipt', 'claimed after the receipt'])('settled 59: after a blocked claim spool the late receipt completes an Item that is %s', async state => {
  const r = await accountCut()
  r.client.stop()
  r.writer.write = write => r.client.recordItemWrite(write)
  r.setWall({ walled: false, clearedMs: Date.now() + 1000 }); await r.m.pump()
  const did = r.offers[0].params.meta.did
  await r.hook('UserPromptSubmit', { prompt_id: 'automatic', dids: [] })
  r.f.advance(20_001); r.claims.start(); await until(() => r.claims.blocked())
  await r.hook('Stop', { prompt_id: 'automatic', phase: 'final' })
  const receiveAndStop = async () => {
    await r.hook('UserPromptSubmit', { prompt_id: 'received-late', dids: [did] })
    await r.hook('Stop', { prompt_id: 'received-late', phase: 'final' })
  }
  if (state !== 'claimed before the receipt') await receiveAndStop()
  await r.sync()
  if (state !== 'waiting') {
    const held = await r.mode.req('POST', r.mode.path + '/take', { connector: r.mode.connector, item_ids: [r.row.id], wait: 0, limit: 1 },
      3000, { 'Idempotency-Key': crypto.randomUUID() })
    expect(held?.json.data.items).toHaveLength(1)
    if (state === 'claimed before the receipt') await receiveAndStop()
    await r.m.pump()
    const takes = () => r.f.calls.filter(c => c.path.endsWith('/take')).length
    const before = takes()
    await r.m.pump()
    expect(takes()).toBe(before)
    const released = await fetch(r.f.base + '/v1/items/' + r.row.id + '/report', { method: 'PUT',
      headers: { Authorization: 'Bearer test-member', 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ claim_id: held!.json.data.claim_id, outcome: 'not_taken', at: new Date(r.f.now()).toISOString() }) })
    expect(await released.json()).toMatchObject({ data: { state: 'waiting' } })
  }
  r.m.initMain(); r.m.routeResume(itemRef(r.row), r.row.payload.text)
  await until(() => r.claims.inSession(r.row.id)); await r.sync()
  r.f.advance(REGISTRY_SETTLE_MS + 1); r.status('idle'); await r.sync()
  const expected: Outcome[] = ['not_taken', 'in_session', 'completed']
  if (state !== 'waiting') expected.unshift('not_taken')
  expect(r.outcomes(r.row.id)).toEqual(expected)
  expect(r.offers).toHaveLength(1)
})

async function waitingModelCut() {
  const r = await mainRig()
  await r.hook('UserPromptSubmit')
  await r.hook('StopFailure', { error: 'overloaded' })
  await until(() => !!r.m.currentGen()?.resume_items?.[0]?.id)
  const resume = [...r.f.rows.values()][0]!
  return { ...r, resume, line: resume.payload.text as string }
}

test('settled 59: the next delivery carries the waiting line once and its normal Stop withdraws that exact resume', async () => {
  const r = await waitingModelCut()
  const { key } = r.m.currentGen()!.resume_items[0]
  await r.bind(r.f.add('message'))
  const content = r.offers[0].params.content
  expect(content).toContain('message')
  expect(content.split(r.line)).toHaveLength(2)
  expect(r.resume.state).toBe('waiting')
  expect(r.f.calls.some(c => c.path.endsWith('/take') && c.body.item_ids?.includes(r.resume.id))).toBe(false)
  await r.hook('Stop', { phase: 'check' }); await r.sync()
  expect(r.resume.state).toBe('waiting')
  expect(r.client.writtenItemId(key)).toBe(r.resume.id)
  await r.hook('Stop', { phase: 'final' }); await r.sync()
  expect(r.resume).toMatchObject({ state: 'cancelled', reason: 'withdrawn' })
  expect(r.client.writtenItemId(key)).toBeUndefined()
  expect(r.f.calls.filter(c => c.path === '/v1/items/' + r.resume.id && c.body.outcome)).toMatchObject([{ body: { expected_version: 1, outcome: 'withdrawn' } }])
})

test.each([false, true])('settled 59: a turn first seen at a tool withdraws its carrier only with a matching receipt (late did=%p)', async received => {
  const r = await waitingModelCut()
  const did = r.enqueue(r.f.add('carrier'))
  await until(() => r.journal.get('msg', did)?.state === 'offered')
  expect(r.offers[0].params.content).toContain(r.line)
  await r.hook('PreToolUse', { prompt_id: 'tool-first', tool_name: 'Read' })
  if (received) await r.hook('UserPromptSubmit', { prompt_id: 'tool-first', dids: [did] })
  await r.hook('Stop', { prompt_id: 'tool-first', phase: 'final' }); await r.sync()
  expect(r.resume.state).toBe(received ? 'cancelled' : 'waiting')
  expect(r.resume.reason).toBe(received ? 'withdrawn' : null)
})

test('settled 59: when the wall clears with a message already waiting, the resume rides that message', async () => {
  const r = await accountCut()
  r.enqueue(r.f.add('also-waiting'))
  r.setWall({ walled: false, clearedMs: Date.now() + 1000 })
  await until(() => { void r.m.pump(); return r.offers.length === 1 })
  expect(r.offers).toHaveLength(1)
  expect(r.offers[0].params.content).toContain('also-waiting')
  expect(r.offers[0].params.content.split(r.row.payload.text)).toHaveLength(2)
  expect(r.row.state).toBe('waiting')
  await r.hook('UserPromptSubmit', { dids: [r.offers[0].params.meta.did] })
  await r.hook('Stop', { phase: 'final' }); await r.sync()
  expect(r.row.reason).toBe('withdrawn')
})

test.each(['PostToolUse', 'Stop'])('settled 59: a row pulled at %s carries the line into that prompt once', async boundary => {
  const r = await waitingModelCut()
  const turn = { prompt_id: 'background', source: 'task-notification' }
  await r.hook('UserPromptSubmit', turn)
  r.enqueue(r.f.add('during-task'))
  const got = await r.hook(boundary, { ...turn, phase: 'check' })
  expect((got.additionalContext ?? got.block)!.split(r.line)).toHaveLength(2)
  r.enqueue(r.f.add('also-during-task')); await r.sync()
  const more = await r.hook('PostToolUse', turn)
  expect(more.additionalContext).toContain('also-during-task')
  expect(more.additionalContext).not.toContain(r.line)
  await r.hook('Stop', { ...turn, phase: 'final' }); await r.sync()
  expect(r.resume.reason).toBe('withdrawn')
})

test('settled 59: a failed carrier and an unrelated normal Stop keep the line for the next delivery', async () => {
  const r = await waitingModelCut()
  await r.bind(r.f.add('first-carrier'))
  expect(r.offers[0].params.content).toContain(r.line)
  await r.hook('StopFailure', { error: 'server_error' }); await r.sync()
  await r.hook('UserPromptSubmit', { prompt_id: 'background', source: 'task-notification', dids: [] })
  await r.hook('Stop', { prompt_id: 'background', phase: 'final' }); await r.sync()
  expect(r.resume.state).toBe('waiting')
  await r.bind(r.f.add('second-carrier'))
  expect(r.offers.at(-1).params.content).toContain(r.line)
  await r.hook('Stop', { phase: 'final' }); await r.sync()
  expect(r.resume.reason).toBe('withdrawn')
})

test('settled 59: an older acknowledged resume recovers its sentence from its original journal entry', async () => {
  const r = await waitingModelCut()
  const g = r.m.currentGen()!, { key, id, session } = g.resume_items[0]
  r.journal.write('main', g.id, g.state, { resume_items: [{ key, id, session }] })
  r.m.initMain()
  await r.bind(r.f.add('after-restart'))
  expect(r.offers[0].params.content).toContain(r.line)
  await r.hook('Stop', { phase: 'final' }); await r.sync()
  expect(r.resume.reason).toBe('withdrawn')
})

test('settled 59: a new session receives its row without the previous session’s resume', async () => {
  const r = await waitingModelCut(), session_id = crypto.randomUUID()
  await r.hook('SessionStart', { session_id, source: 'clear' })
  const did = r.enqueue(r.f.add('another-session'))
  await until(() => r.offers.length === 1)
  expect(r.offers[0].params.content).not.toContain(r.line)
  await r.hook('UserPromptSubmit', { session_id, prompt_id: 'new', dids: [did] })
  await r.hook('Stop', { session_id, prompt_id: 'new', phase: 'final' }); await r.sync()
  expect(r.resume.state).toBe('waiting')
})

test('settled 59: a carrier can finish before the create is acknowledged', async () => {
  const r = await mainRig()
  r.writer.write = write => r.client.recordItemWrite(write)
  await r.hook('UserPromptSubmit')
  await r.hook('StopFailure', { error: 'overloaded' })
  const line = r.m.currentGen()!.resume_items[0].create.body.text
  const did = r.enqueue(r.f.add('early-carrier'))
  await until(() => r.offers.length === 1)
  expect(r.offers[0].params.content).toContain(line)
  await r.hook('UserPromptSubmit', { prompt_id: 'early', dids: [did] })
  await r.hook('Stop', { prompt_id: 'early', phase: 'final' })
  expect(r.f.rows.size).toBe(1)
  await r.sync(); await r.m.pump(); await r.sync()
  expect([...r.f.rows.values()].find(row => row.kind === 'resume')).toMatchObject({ state: 'cancelled', reason: 'withdrawn' })
})

test('C4 a resume create acknowledged during an unrelated take preserves the delivery claim', async () => {
  const r = await mainRig()
  const write = r.client.request.bind(r.client), request = r.mode.req
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  spyOn(r.client, 'request').mockImplementation(async (...args) => {
    const reply = await write(...args)
    if (args[0] === 'POST' && args[1] === r.mode.path) await gate
    return reply
  })
  spyOn(r.mode, 'req').mockImplementation(async (...args) => {
    const reply = await request(...args)
    if (args[1].endsWith('/take')) {
      release()
      await until(() => r.m.currentGen()?.resume_items?.some((e: any) => !!e.id))
    }
    return reply
  })
  await r.hook('UserPromptSubmit')
  await r.hook('StopFailure', { error: 'overloaded' })
  await until(() => r.f.rows.size === 1)
  const row = r.f.add('unrelated-message'), did = r.enqueue(row)
  await until(() => r.offers.length > 0 || r.client.hasItemReports() || r.outcomes(row.id).includes('not_taken'))
  await r.sync()
  expect(r.outcomes(row.id)).not.toContain('not_taken')
  expect(r.journal.get('msg', did)?.state).toBe('offered')
  expect(r.offers).toHaveLength(1)
})

test.each([400, 403, 409])('C4 a permanent HTTP %i rejects one spooled create and leaves other resumes deliverable', async status => {
  const r = await mainRig()
  const request = r.client.request.bind(r.client)
  let calls = 0, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  spyOn(r.client, 'request').mockImplementation(async (...args) => {
    if (args[0] !== 'POST' || args[1] !== r.mode.path) return request(...args)
    calls++
    await gate
    return { status, json: { error: { code: 'invalid_request' } } }
  })
  await r.hook('UserPromptSubmit')
  await r.hook('StopFailure', { error: 'overloaded' })
  await until(() => calls === 1)
  const other = r.f.add('previous-resume', 'resume', { from: 'adam', payload: { text: '之前的工作' } })
  r.m.routeResume(itemRef(other), other.payload.text)
  await until(() => r.offers.length === 1)
  release()
  await until(() => r.client.skipped.count === 1)
  for (let i = 0; i < 10; i++) { await r.m.pump(); await r.sync() }
  expect(calls).toBe(1)
  expect(r.logs.filter(l => l.includes('moved to rejected.jsonl'))).toHaveLength(1)
  expect(r.m.currentGen()?.resume_items?.some((e: any) => e.create)).toBe(false)
  expect(r.client.pendingBytes()).toBe(0)
  expect(JSON.parse(readFileSync(r.client.rejected, 'utf8').trim()).line.k).toBe('item')
})

test('C4 a permanently refused DELETE retires its local offer and advances the spool once', async () => {
  const r = await accountCut()
  r.client.stop()
  r.writer.write = write => r.client.recordItemWrite(write)
  const request = r.client.request.bind(r.client)
  let deletes = 0
  spyOn(r.client, 'request').mockImplementation(async (...args) => {
    if (args[0] !== 'DELETE') return request(...args)
    deletes++
    return { status: 409, json: { error: { code: 'version_conflict' } } }
  })
  await r.hook('UserPromptSubmit', { prompt_id: 'automatic', dids: [] })
  // A spool pass already in flight makes syncNow return at once; wait for the DELETE's own pass before counting.
  await until(() => { void r.sync(); return deletes > 0 && r.client.pendingBytes() === 0 })
  for (let i = 0; i < 10; i++) { await r.m.pump(); await r.sync() }
  r.m.routeResume(itemRef(r.row), r.row.payload.text)
  expect([deletes, r.client.skipped.count, r.client.pendingBytes(), r.offers.length]).toEqual([1, 1, 0, 0])
  expect(r.logs.filter(l => l.includes('moved to rejected.jsonl'))).toHaveLength(1)
})

test.each(['accepted', 'rejected'])('C4 an identical sentence keeps its own Item id while another create is %s', async outcome => {
  const r = await mainRig()
  r.writer.write = write => r.client.recordItemWrite(write)
  r.setWall({ walled: true, clearedMs: null })
  await r.hook('UserPromptSubmit')
  await r.hook('StopFailure', { error: 'rate_limit' })
  const text = r.m.currentGen()!.resume_items[0].create.body.text
  const other = r.f.add('same-sentence', 'resume', { from: 'adam', payload: { text } })
  r.m.routeResume(itemRef(other), text)
  if (outcome === 'rejected') {
    const request = r.client.request.bind(r.client)
    spyOn(r.client, 'request').mockImplementation((...args) => args[0] === 'POST' && args[1] === r.mode.path
      ? Promise.resolve({ status: 400, json: { error: 'invalid_request' } }) : request(...args))
  }
  await r.sync()
  await r.hook('UserPromptSubmit', { prompt_id: 'independent', dids: [] })
  await r.sync()
  const count = outcome === 'accepted' ? 2 : 1
  expect([...r.f.rows.values()].map(row => row.reason)).toEqual(Array(count).fill('superseded'))
  expect(r.f.calls.filter(c => c.body.outcome === 'superseded')).toHaveLength(count)
  expect(r.offers).toHaveLength(0)
})

test('C4 a waiting peek before the create acknowledgement shares the same supersede write', async () => {
  const r = await mainRig()
  r.setWall({ walled: true, clearedMs: null })
  const request = r.client.request.bind(r.client)
  let release!: () => void
  const ack = new Promise<void>(resolve => { release = resolve })
  const requests = spyOn(r.client, 'request').mockImplementation(async (...args) => {
    const reply = await request(...args)
    if (args[0] === 'POST' && args[1] === r.mode.path) await ack
    return reply
  })
  await r.hook('UserPromptSubmit')
  await r.hook('StopFailure', { error: 'rate_limit' })
  await until(() => r.f.rows.size === 1)
  const row = [...r.f.rows.values()][0]!
  r.m.routeResume(itemRef(row), row.payload.text)
  await r.hook('UserPromptSubmit', { prompt_id: 'independent', dids: [] })
  release()
  await until(() => row.state === 'cancelled')
  await r.sync()
  expect(requests.mock.calls.filter(([method, path]) => method === 'GET' && path === '/v1/items/' + row.id)).toHaveLength(1)
  expect(r.f.calls.filter(c => c.body.outcome === 'superseded')).toHaveLength(1)
  expect(r.offers).toHaveLength(0)
})

test('C4 a lost POST response and a lost DELETE race keep the decision across retries', async () => {
  const r = await mainRig()
  r.writer.write = write => r.client.recordItemWrite(write)
  const request = r.client.request.bind(r.client)
  let losePost = true, conflict = true
  spyOn(r.client, 'request').mockImplementation(async (...args) => {
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
  await r.sync()
  expect(r.logs.some(l => l.includes('POST response lost'))).toBe(true)
  await r.hook('UserPromptSubmit', { prompt_id: 'automatic', dids: [] })
  await r.sync() // replay the create, then encounter a newer version on the queued DELETE
  const row = [...r.f.rows.values()][0]!
  expect(row.state).toBe('waiting')
  await r.sync()
  expect(row.state).toBe('cancelled')
  const posts = r.f.calls.filter(c => c.body.kind === 'resume')
  expect(posts).toHaveLength(2)
  expect(posts[0]!.key).toBe(posts[1]!.key)
  expect(r.f.calls.filter(c => c.body.outcome === 'superseded').map(c => c.body.expected_version)).toEqual([1, 2])
  expect(r.f.rows.size).toBe(1)
  expect(r.offers).toEqual([])
})

test.each(['pre-C6', 'C6'])('%s main claim replays as main and only its local UUID can finish the turn', async version => {
  const r = rig(), row = r.f.add('old', 'message', { session_id: 'main' }), sid = crypto.randomUUID()
  await r.mode.probe()
  await r.receiver.receive([itemRef(row)])
  const saved = JSON.parse(readFileSync(r.file, 'utf8'))
  const oldSession = version === 'C6' ? sid : 'main'
  Object.assign(saved.claims.old, { registry_session: version === 'C6' ? undefined : sid, session_id: oldSession, turn: 'turn' })
  writeFileSync(r.file, JSON.stringify(saved))
  const claims = new Claims(r.file, r.client, () => {}, () => {}, r.f.now)
  r.client.recordItemReport({ item_id: row.id, body: { claim_id: row.claim!.id, outcome: 'in_session', session_id: oldSession, at: new Date().toISOString() } })
  r.client.watchItemReports(l => claims.replay(l), (l, ok) => claims.acknowledged(l, ok))
  await r.sync()
  expect(row.session_id).toBe('main')
  expect(row.claim!.session_id).toBe('main')
  claims.finalStop('main', 'turn')
  claims.statusRecord(sid, 'idle', () => 0, 0)
  claims.finalStop(sid, 'turn')
  claims.statusRecord('main', 'idle', () => 0, 0)
  expect(r.client.hasItemReports()).toBe(false)
  claims.statusRecord(sid, 'idle', () => 0, 0)
  await r.sync()
  expect(r.outcomes('old')).toEqual(['in_session', 'completed'])
  expect(r.f.history.map(h => h.body.session_id)).toEqual(['main', 'main'])
})

test('an intake spooled just before a crash restores its local turn without sending the binding to Onsen', async () => {
  const r = rig(), row = r.f.add('crash'), sid = crypto.randomUUID()
  await r.mode.probe(); await r.receiver.receive([itemRef(row)])
  const beforeBind = readFileSync(r.file)
  r.receiver.bind([itemRef(row)], 'main', 'receiving-turn', sid)
  writeFileSync(r.file, beforeBind)
  const recovered = new Claims(r.file, r.client, () => {}, () => {}, r.f.now)
  r.client.watchItemReports(l => recovered.replay(l), (l, ok) => recovered.acknowledged(l, ok))
  await r.sync()
  // A second restart has only the ledger. The acknowledged intake has left the spool.
  const restored = new Claims(r.file, r.client, () => {}, () => {}, r.f.now)
  r.client.watchItemReports(l => restored.replay(l), (l, ok) => restored.acknowledged(l, ok))
  restored.finalStop(sid, 'receiving-turn')
  restored.statusRecord(sid, 'idle', () => 0, 0)
  await r.sync()
  expect(r.outcomes(row.id)).toEqual(['in_session', 'completed'])
  expect(r.f.history.map(h => h.body.session_id)).toEqual(['main', 'main'])
  expect(JSON.stringify(r.f.history)).not.toContain(sid)
})

test.each([false, true])('a C6 report drains without a claim watcher, roamer=%s', async roamer => {
  const r = rig(), row = r.f.add('old-spool'), sid = crypto.randomUUID()
  await r.mode.probe(); await r.receiver.receive([itemRef(row)])
  const client = new OnsenClient({ ...r.client.cfg, roamer })
  client.recordItemReport({ item_id: row.id, body: { claim_id: row.claim!.id, at: new Date().toISOString(), outcome: 'in_session', session_id: sid } })
  await client.syncNow(true)
  expect(row.claim!.session_id).toBe(roamer ? roamerSessionId('adam', sid) : 'main')
  expect(row.in_session_at).toBeTruthy()
})

test('the four roamer bot names resolve to their registered members without lanes', () => {
  for (const [bot, member] of [['space_roamers', 'space-roamers'], ['time_travelers', 'time-travelers'],
    ['@SpaceX_Roamer_bot', 'spacex-roamer'], ['@SpaceY_Roamer_bot', 'spacey-roamer']]) {
    expect(roamerMember({ ROAMER_MODE: '1', ROAMER_BOT_NAME: bot })).toBe(member)
  }
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
  for (const status of [400, 404, 409]) { r.f.mode(status); expect(await deliveryMode(req, path, connector)).toMatchObject({ take: false, status }) }
  expect((await deliveryMode(async () => { throw Error('offline') }, path, connector)).take).toBe(false)
  r.f.mode(200); await r.mode.probe()
  expect(r.mode.active).toBe(true)
  expect(r.f.calls.every(c => c.query.get('connector') === 'mac-mini/adam' && c.query.get('limit') === '1')).toBe(true)
})

for (const envelope of ['detail', 'error']) test('old pull pauses once and resumes for 409 ' + envelope + '.code', async () => {
  const r = rig(), inbox = new OnsenInbox({ file: join(r.dir, 'inbox.json') })
  const pull = new OnsenPuller({ inbox, base: r.f.base, host: 'mac-mini',
    req: async (...args) => {
      const response = await r.client.request(...args)
      if (envelope === 'error' && response?.status === 409) return { status: 409, json: { error: response.json.detail } }
      return response
    }, deliver: async () => 'delivered', log: (_lv, m) => r.logs.push(m) })
  pull.start()
  try {
    await until(() => r.logs.some(s => s.includes('member is on take')))
    expect(pull.health()).toMatchObject({ errors: 0, backoff_s: 0, last_error: null })
  } finally { await pull.stop() }
  await pull.once()
  expect(r.logs.filter(s => s.includes('member is on take'))).toHaveLength(1)
  expect(inbox.based).toBe(false)
  r.f.mode(409); await pull.once()
  expect(inbox.based).toBe(true)
  expect(r.logs.filter(s => s.includes('on pull again'))).toHaveLength(1)
  r.f.mode(200); await pull.once()
  expect(r.logs.filter(s => s.includes('member is on take'))).toHaveLength(2)
})

test('other 409s from old pull still back off as errors', async () => {
  const r = rig(), inbox = new OnsenInbox({ file: join(r.dir, 'inbox.json') })
  const pull = new OnsenPuller({ inbox, base: r.f.base, host: 'mac-mini', req: async () => ({ status: 409, json: { detail: { code: 'conflict' } } }),
    deliver: async () => 'delivered', log: (_lv, m) => r.logs.push(m) })
  pull.start()
  try {
    await until(() => pull.stats.errors > 0)
    expect(pull.health()).toMatchObject({ errors: 1, backoff_s: 2 })
    expect(r.logs.some(s => s.includes('member is on take'))).toBe(false)
  } finally { await pull.stop() }
})

test('after the switch the next pull round delivers and acks the pending prefix', async () => {
  const r = rig(), inbox = new OnsenInbox({ file: join(r.dir, 'inbox.json') })
  const handed: number[] = []
  let ready = false
  const pull = new OnsenPuller({ inbox, base: r.f.base, host: 'mac-mini', now: r.f.now,
    req: r.client.request.bind(r.client), log: () => {},
    deliver: async it => { if (!ready) return 'later'; handed.push(it.seq); return 'delivered' } })
  r.f.mode(409)
  const old = r.f.add('pending', 'call')
  await pull.once(); await pull.once()
  expect(inbox.pending.map(it => it.seq)).toEqual([old.number])
  r.f.mode(200)
  await pull.once()
  ready = true
  r.f.advance(60_000)
  await pull.once()
  expect(handed).toEqual([old.number])
  expect(r.f.calls.filter(c => c.path === '/inbox/ack').map(c => c.body)).toEqual([{ upto: old.number }])
  expect(old.state).toBe('completed')
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

test('a routing failure retries its waiting row after the cursor advances without blocking the page', async () => {
  const r = rig(), routed: string[] = [], held = new Map<string, number>()
  for (const id of ['one', 'two', 'three']) r.f.add(id)
  await r.mode.probe()
  const peek = new ItemPeek(r.mode, () => held, async row => {
    routed.push(row.id)
    if (row.id === 'two' && routed.filter(id => id === 'two').length < 3) throw Error('delivery failed')
    held.set(row.id, row.version)
  }, () => true)
  clean.push(() => peek.stop())
  await peek.poll()
  expect(routed).toEqual(['one', 'two', 'three'])
  r.f.advance(10_000)
  r.f.add('four')
  await until(() => held.has('four'))
  await until(() => held.has('two'), 5500)
  expect(routed).toEqual(['one', 'two', 'three', 'four', 'two', 'two'])
  expect(r.f.calls.some(c => c.query.has('changed_after'))).toBe(true)
}, 7000)

test('the probe clock corrects both not_before and the 20-second unbound claim deadline', async () => {
  const r = rig()
  r.f.advance(3600_000)
  await r.mode.probe()
  const now = r.mode.now
  expect(Math.abs(now() - r.f.now())).toBeLessThan(100)
  const claims = new Claims(join(r.dir, 'skew.json'), r.client, () => {}, () => {}, now)
  clean.push(() => claims.stop())
  const row = r.f.add('skew'), taken = new Date(r.f.now() - 20_001).toISOString()
  claims.taken({ ...row, claim: { id: 'skew-claim', connector: r.mode.connector, session_id: null, taken_at: taken, expires_at: taken } }, itemRef(row))
  await until(() => r.client.hasItemReports())
  row.not_before = new Date(now() + 120).toISOString()
  const routed: string[] = []
  const peek = new ItemPeek(r.mode, () => new Map(), async it => { routed.push(it.id) }, () => true)
  clean.push(() => peek.stop())
  await peek.poll(); expect(routed).toEqual([])
  await until(() => routed.includes(row.id))
})

test('an unchanged row in the overlap produces about one peek per second over ten seconds', async () => {
  const r = rig()
  r.f.add('overlap')
  await r.mode.probe()
  let routed = 0
  const peek = new ItemPeek(r.mode, () => new Map(), async () => { routed++ }, () => true)
  clean.push(() => peek.stop())
  await peek.poll()
  await Bun.sleep(10_000)
  const polls = r.f.calls.filter(c => c.query.has('wait')).length
  expect(routed).toBe(1)
  expect(polls).toBeGreaterThanOrEqual(9)
  expect(polls).toBeLessThanOrEqual(12)
}, 12_000)

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
  row.session_id = 'main'
  await r.bind(row)
  expect(row.session_id).toBe('main')
  expect(row.claim?.session_id).toBe('main')
  r.claims.finalStop('another-session', 'turn')
  r.f.advance(3001); r.status('idle'); await r.sync()
  expect(r.outcomes(row.id)).toEqual(['in_session'])
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

test('claim attribution survives restart and follows the quote or the conversation and turn', async () => {
  const r = await mainRig()
  const first = r.f.add('one', 'message', { message_id: '23' }), second = r.f.add('two', 'message', { message_id: '24' })
  await r.bind(first)
  r.enqueue(second); await r.hook('PostToolUse'); await r.sync()
  expect(second.claim?.session_id).toBe('main')
  const oldLedger = JSON.parse(readFileSync(r.file, 'utf8'))
  delete oldLedger.claims[first.id].message_id
  writeFileSync(r.file, JSON.stringify(oldLedger))
  const restored = new Claims(r.file, r.client, () => {}, () => {}, r.f.now)
  restored.restoreMessageIds(r.journal)
  expect(JSON.parse(readFileSync(r.file, 'utf8')).claims[first.id].message_id).toBe('23')
  restored.reply('turn', 'conv', '25', null, '23')
  restored.reply('turn', 'conv', '25', null, '23')
  restored.reply('another turn', 'conv', '26', null, '24')
  restored.reply('turn', 'conv', 'shared')
  restored.reply('turn', 'conv', 'other-target', null, '100')
  restored.reply('turn', 'other conversation', 'wrong-conversation', null, '23')
  restored.reply('another turn', 'conv', 'wrong-turn')
  for (const row of [first, second]) restored.report(row.id, 'completed')
  await r.sync()
  expect(first.response_message_ids).toEqual(['25', 'shared'])
  expect(second.response_message_ids).toEqual(['26', 'shared'])
})

test('an unacknowledged final main Stop completes with its replies on offline or replacement UUID', async () => {
  for (const state of ['offline', 'busy']) {
    const r = await mainRig(), row = r.f.add('main-' + state)
    await r.bind(row)
    r.claims.reply('turn', 'conv', 'my-reply', r.sid)
    await r.hook('Stop', { phase: 'final' })
    r.claims.statusRecord(state === 'offline' ? null : crypto.randomUUID(), state, () => null, REGISTRY_SETTLE_MS, true)
    await r.sync()
    expect(r.outcomes(row.id)).toEqual(['in_session', 'completed'])
    expect(row.response_message_ids).toEqual(['my-reply'])
    expect(r.claims.held()).toEqual([])
  }
})

test('cutting an unfinished target reports half_done for genuine output or a reply after intake', async () => {
  const r = rig()
  await r.mode.probe()
  for (const evidence of ['neither', 'output', 'reply', 'synthetic']) {
    const sid = crypto.randomUUID(), transcript = join(r.dir, sid + '.jsonl'), row = r.f.add(evidence)
    const target = { session_id: sid, claude_pid: 53, tmux: 'lab', transcript }
    await r.receiver.receive([{ ...itemRef(row), target }])
    const input = new Date().toISOString()
    r.claims.accept(sid, [row.claim!.id], 'turn', input)
    const record = (timestamp: string, model: string) => JSON.stringify({ timestamp, type: 'assistant', message: { model, content: 'text' } })
    const lines = [record(new Date(Date.parse(input) - 1000).toISOString(), 'before-intake')]
    if (evidence === 'output' || evidence === 'synthetic') lines.push(record(new Date(Date.parse(input) + 1).toISOString(), evidence === 'output' ? 'claude' : '<synthetic>'))
    writeFileSync(transcript, lines.join('\n') + '\n')
    if (evidence === 'reply') r.claims.reply('turn', 'conv', 'sent', sid)
    r.claims.cutTarget(target)
    await r.sync()
    expect(r.outcomes(row.id)).toEqual(['in_session', 'cut'])
    expect(r.f.history.at(-1)!.body.half_done).toBe(['output', 'reply'].includes(evidence))
  }
})

test('a main session with no subagents directory completes at its settled Stop', async () => {
  const r = await mainRig()
  const registry = new Registry({ dir: r.dir, workspace: r.dir, transcripts: () => r.dir, connected: () => true, log: () => {} })
  const row = r.f.add('without-subagents')
  await r.bind(row)
  await r.hook('Stop', { phase: 'final' })
  r.f.advance(REGISTRY_SETTLE_MS)
  r.claims.statusRecord(r.sid, 'idle', sid => registry.backgroundAgents(sid), REGISTRY_SETTLE_MS)
  await r.sync()
  expect(r.outcomes(row.id)).toEqual(['in_session', 'completed'])
})

test('batched mail waits in Onsen and rides the next M1 take or leads after the batch timeout', async () => {
  for (const timeout of [false, true]) {
    const r = await mainRig(), mail = r.f.add('mail', 'mail')
    const did = r.m.enqueue('peer', { method: 'notifications/claude/channel', params: { content: 'mail', meta: {} } },
      { batched: true, fields: { onsen_items: [itemRef(mail)] } })
    await r.m.pump()
    expect(mail.state).toBe('waiting'); expect(r.offers).toHaveLength(0)
    if (timeout) r.journal.write('msg', did, 'queued', { batched_at: new Date(Date.now() - 2701_000).toISOString() })
    else r.enqueue(r.f.add('next'))
    await r.m.pump()
    await until(() => mail.state === 'claimed')
    expect(r.f.calls.filter(c => c.path.endsWith('/take')).map(c => c.body.item_ids)).toEqual([timeout ? ['mail'] : ['next', 'mail']])
  }
})

test('a peer’s waiting calls share one take; its later call waits for the next main turn', async () => {
  const r = await mainRig()
  r.status('busy')
  const calls = ['first', 'second', 'later'].map(id => r.f.add(id, 'call', { from: 'eve' }))
  const dids = calls.slice(0, 2).map(row => r.enqueue(row))
  await r.sync()
  r.status('idle'); await r.m.pump()
  await until(() => r.m.items(row => row.state === 'offered').length === 2)
  expect(r.f.calls.filter(c => c.path.endsWith('/take')).map(c => c.body.item_ids)).toEqual([['first', 'second']])
  await r.hook('UserPromptSubmit', { dids }); await r.sync()
  r.enqueue(calls[2]); r.status('busy')
  await r.hook('PostToolUse', { tool_name: 'Read' }); await r.sync()
  expect(calls[2].state).toBe('waiting')
  await r.hook('Stop', { phase: 'final' }); r.f.advance(4000); r.status('idle'); await r.sync()
  expect(calls.slice(0, 2).map(row => row.state)).toEqual(['completed', 'completed'])
  await r.m.pump()
  await until(() => r.f.calls.some(c => c.body.item_ids?.includes('later')))
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

test('claim invariant after every idle, busy and walled main transition', async () => {
  const r = await mainRig()
  const step = async (act: () => unknown) => {
    await act(); await r.sync()
    const held = [...r.f.rows.values()].filter(row => row.state === 'claimed')
    expect(r.claims.held().sort()).toEqual(held.map(row => row.id).sort())
    for (const row of held) {
      if (row.in_session_at) expect(row.claim!.session_id).toBe('main')
      else {
        const offered = r.m.items(it => it.state === 'offered' && it.onsen_items?.some((ref: any) => ref.onsen_item_id === row.id))
        expect(offered).toHaveLength(1)
        expect(r.f.now() - Date.parse(row.claim!.taken_at)).toBeLessThan(20_000)
      }
    }
  }
  const person = r.f.add('idle-person'), mail = r.f.add('busy-mail', 'mail'), steer = r.f.add('busy-person')
  let did = ''
  await step(async () => { did = r.enqueue(person); await until(() => r.offers.length === 1) })
  await step(() => r.hook('UserPromptSubmit', { dids: [did] }))
  await step(() => r.status('busy'))
  await step(() => r.enqueue(mail)); expect(mail.state).toBe('waiting')
  await step(() => r.enqueue(steer)); expect(steer.state).toBe('waiting')
  await step(() => r.hook('PostToolUse')); expect(steer.in_session_at).toBeTruthy()
  await step(() => r.f.advance(21_000)); expect(mail.state).toBe('waiting')
  const reset = new Date(r.f.now() + 60_000).toISOString()
  await step(() => r.setWall({ walled: true, lastWallMs: Date.now(), clearedMs: null, resets_at: reset }))
  await step(() => r.hook('StopFailure', { error: 'rate_limit' }))
  const waiting = r.f.add('walled-person')
  await step(() => r.enqueue(waiting)); await step(() => r.m.pump())
  expect(waiting.state).toBe('waiting'); expect(mail.state).toBe('waiting')
  expect(r.claims.held()).toEqual([])
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

test('automatic restart addresses only the exact configured tmux session and checks its wrapper', () => {
  const { dir } = rig(), args = join(dir, 'tmux-args')
  writeFileSync(join(dir, 'tmux'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$C3_ARGS"\n', { mode: 0o700 })
  writeFileSync(join(dir, 'launchctl'), '#!/bin/sh\ntest "$1" = print && echo "state = running"\n', { mode: 0o700 })
  const proc = Bun.spawnSync([process.execPath, '--no-env-file', '-e',
    "import { restartClaudeTUI } from './channel-bot-control.ts'; await restartClaudeTUI(true)"], {
    cwd: import.meta.dir, env: { ...process.env, PATH: dir, C3_ARGS: args, CHANNEL_BOT_TMUX_SESSION: 'test-c3',
      CHANNEL_BOT_SERVICE_MANAGER: 'launchd', CHANNEL_BOT_WRAPPER_LABEL: 'fixture-only' },
  })
  expect(proc.stderr.toString()).toBe(''); expect(proc.exitCode).toBe(0)
  expect(readFileSync(args, 'utf8').trim().split('\n')).toEqual(['kill-session', '-t', '=test-c3'])
  writeFileSync(join(dir, 'tmux'), '#!/bin/sh\nexit 1\n')
  const missing = Bun.spawnSync([process.execPath, '--no-env-file', '-e',
    "import { restartClaudeTUI } from './channel-bot-control.ts'; await restartClaudeTUI(true)"], {
    cwd: import.meta.dir, env: { ...process.env, PATH: dir, CHANNEL_BOT_TMUX_SESSION: 'test-c3', CHANNEL_BOT_WRAPPER_LABEL: 'fixture-only' },
  })
  expect(missing.exitCode).not.toBe(0)
  expect(missing.stderr.toString()).toContain('tmux kill-session =test-c3 failed (1)')

})

test('the last-result check and open obligations share one owed prompt on the bound Item', async () => {
  const r = await mainRig(), row = r.f.add('work-after-reply')
  await r.bind(row)
  const check = await r.hook('Stop')
  expect(check.item_stop).toBe('check')
  const owed = { phase: 'owed' as const, owed_mids: [check.items![0].mid] }
  expect((await r.hook('Stop', { ...owed, owed_mids: ['not-this-turn'] })).accepted).toBeUndefined()
  expect((await r.hook('Stop', owed)).accepted).toBe(true)
  expect((await r.hook('Stop', owed)).accepted).toBeUndefined()
  r.owing(true)
  const next = await r.hook('Stop')
  expect(next.block).toBeUndefined(); expect(next.item_stop).toBe('done')
  await r.hook('Stop', { phase: 'final' }); r.f.advance(4000); r.status('idle'); await r.sync()
  expect(r.outcomes(row.id)).toEqual(['in_session', 'owed', 'completed'])
  expect(row.reason).toBe('not_answered')
  await r.hook('UserPromptSubmit', { prompt_id: 'empty' })
  expect((await r.hook('Stop', { prompt_id: 'empty' })).block).toBeUndefined()
})

for (const structural of [false, true]) test('the Stop hook combines a missed answer and an unsent result, existing hold=' + structural, () => {
  const r = rig()
  const script = `
import importlib.util, io, json, os, sys
from unittest.mock import patch
def load(name):
    spec = importlib.util.spec_from_file_location(name, 'lanes-hooks/' + name + '.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
hook, gate = load('main-hook'), load('main-answered-gate')
items = [{'mid': name, 'user': name, 'kind': 'tg', 'no_reply': False, 'system': False, 'body': body}
         for name, body in [('eve', 'report the result'), ('adam', 'when is the deadline?')]]
turn = {'prompt_id': 'p', 'calls': [{'name': 'mcp__reply'}, {'name': 'Read'}]}
payload = {'hook_event_name': 'Stop', 'session_id': 's', 'prompt_id': 'p',
           'last_assistant_message': 'There were 194 failed requests in the logs across twenty pages.'}
phases, printed = [], []
def post(b, timeout):
    phases.append(b['phase'])
    if b['phase'] == 'owed':
        assert b['owed_mids'] == ['adam', 'eve']
        return {} if ${structural ? 'True' : 'False'} else {'accepted': True}
    return {'block': 'existing obligation' if ${structural ? 'True' : 'False'} and 'owed' not in phases else None,
            'item_stop': 'done' if 'owed' in phases else 'check', 'items': items,
            'turn': turn, 'outputs': [{'to': 'eve', 'reply_to': 'eve', 'text': 'Looking up the logs.'}]}
def aid(file, fn, *args):
    return gate.take_owed(*args) if fn == 'take_owed' else None
with patch.object(hook, 'post', post), patch.object(hook, 'out', printed.append), patch.object(hook, 'aid', aid), \\
     patch.object(gate, 'ask', lambda state, questions: {k: {'noul': 1 if k.endswith('reply_needed') else 0} for k in questions}), \
     patch.object(gate, 'unsent_p', lambda msgs, outs, final: 1 if msgs[0]['user'] == 'eve' else 0):
    for _ in range(2):
        with patch.object(sys, 'stdin', io.StringIO(json.dumps(payload))):
            hook.main()
assert 'when is the deadline?' in printed[0]['reason'] and gate.UNSENT_WORDS in printed[0]['reason']
assert ('existing obligation' in printed[0]['reason']) == ${structural ? 'True' : 'False'}
print(json.dumps([phases, len(printed), bool(os.path.exists(os.path.join(os.environ['LANES_DIR'], 'run', 'answered-gate.json')))]))
`
  const proc = Bun.spawnSync(['python3', '-B', '-c', script], { cwd: import.meta.dir, env: { ...process.env, LANES_DIR: r.dir } })
  expect(proc.stderr.toString()).toBe('')
  expect(proc.exitCode).toBe(0)
  expect(JSON.parse(proc.stdout.toString())).toEqual([['check', 'owed', 'check', 'final'], 1, false])
})

test('the content check adds the missed claim to an existing obligation in the same Stop', async () => {
  const r = await mainRig(), a = r.f.add('explicit-obligation'), b = r.f.add('missed-content')
  await r.bind(a); r.status('busy'); r.enqueue(b); await r.hook('PostToolUse')
  r.owing(a.id)
  const check = await r.hook('Stop')
  expect(check.block).toContain(a.id)
  expect(check.item_stop).toBe('check')
  await r.hook('Stop', { phase: 'owed', owed_mids: [String(b.number)] })
  expect((await r.hook('Stop')).item_stop).toBe('done')
  await r.hook('Stop', { phase: 'final' }); r.f.advance(4000); r.status('idle'); await r.sync()
  for (const row of [a, b]) expect(r.outcomes(row.id)).toEqual(['in_session', 'owed', 'completed'])
})

test('a missed pre-switch message can hold one Stop without claiming it', async () => {
  const r = await mainRig(), local = r.f.add('legacy'), owned = r.f.add('owned')
  await r.bind(owned)
  r.status('busy'); r.enqueue(local, true); await r.hook('PostToolUse')
  const check = await r.hook('Stop')
  expect(check.items?.length).toBe(2)
  const mids = [String(local.number)]
  expect((await r.hook('Stop', { phase: 'owed', owed_mids: mids })).accepted).toBe(true)
  expect((await r.hook('Stop')).item_stop).toBe('done')
  await r.hook('Stop', { phase: 'final' }); r.f.advance(4000); r.status('idle'); await r.sync()
  expect(r.outcomes(local.id)).toEqual([])
  expect(r.outcomes(owned.id)).toEqual(['in_session', 'completed'])
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
  await r.mode.probe(); await r.receiver.receive([itemRef(row)]); r.receiver.bind([itemRef(row)], 'main', 't'); await r.sync()
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
  const earlier = itemRef(parked), oldRider = itemRef(ride)
  delete oldRider.reason // the journal still has the message from before it was cut
  r.f.change(ride, 'cut_person')
  r.f.change(parked, 'edited') // the refused detail is newer than the pump's journal snapshot
  await r.mode.probe()
  const result = await r.receiver.receive([later, ride, parked, gone].map(itemRef))
  expect(result.given.size).toBe(0); expect([...result.gone]).toEqual(['gone']); expect(r.deadlines).toContain(later.not_before!)
  expect(r.f.calls.filter(c => /^\/v1\/items\//.test(c.path))).toHaveLength(4)
  const held = r.f.add('already-held')
  await r.receiver.receive([itemRef(held)])
  const before = r.f.calls.length
  for (let seconds = 0; seconds < 60; seconds += 5) {
    r.f.advance(5000)
    await r.receiver.receive([earlier, oldRider, itemRef(held)])
  }
  expect(r.f.calls.length).toBe(before)
  parked.released = true; r.f.change(parked, 'released')
  expect([...(await r.receiver.receive([itemRef(parked)])).given]).toEqual([parked.id])
  const other = r.f.add('other')
  expect((await r.receiver.receive([ride, other].map(itemRef))).given.size).toBe(2)
})

test('a hook returns its take before inspecting refusals; a lost non-hook response recovers its grant', async () => {
  const r = rig(), good = r.f.add('good'), missing = r.f.add('missing', 'call', { state: 'cancelled' })
  let release!: () => void, checking = false, lose = false
  const wait = new Promise<void>(resolve => { release = resolve })
  const mode = new TakeMode('adam', async (...args) => {
    if (args[1].endsWith('/missing')) { checking = true; await wait }
    const answer = await r.mode.req(...args)
    if (lose && args[0] === 'POST') { lose = false; throw Error('response lost') }
    return answer
  }, () => {}, () => {}, 'mac-mini')
  await mode.probe(); clean.push(() => mode.stop())
  const receiver = new ItemReceiver(mode, r.claims, () => {})
  const gone = new Set<string>()
  expect([...(await receiver.receive([good, missing].map(itemRef), true, false, ids => ids.forEach(id => gone.add(id)))).given]).toEqual(['good'])
  expect(checking).toBe(false)
  await until(() => checking); release(); await until(() => gone.has('missing'))
  const next = r.f.add('recovered')
  lose = true
  expect([...(await receiver.receive([itemRef(next)])).given]).toEqual(['recovered'])
  receiver.report([itemRef(next)], 'completed'); await r.sync()
  expect(r.outcomes(next.id)).toEqual(['completed'])
  const keys = r.f.calls.filter(c => c.body.item_ids?.includes(next.id)).map(c => c.key)
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1])
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

test('a stuck non-report cannot block an item report, including after restarting the spool', async () => {
  const r = rig(), row = r.f.add('priority')
  await r.mode.probe()
  await r.receiver.receive([itemRef(row)])
  let stuck = true
  r.client.cfg.fetch = ((url, opts) => String(url).endsWith('/forms/ack') && stuck
    ? Promise.resolve(new Response('', { status: 503 })) : fetch(url, opts)) as typeof fetch
  r.client.recordFormAck([123])
  await r.sync()
  r.receiver.report([itemRef(row)], 'completed')
  await r.client.syncNow() // the transient form-ack backoff is still pending
  expect(r.outcomes(row.id)).toEqual(['completed'])
  expect(r.client.hasItemReports()).toBe(false)
  expect(r.client.pendingBytes()).toBeGreaterThan(0)
  const restored = new OnsenClient(r.client.cfg)
  restored.watchItemReports(() => { throw Error('replayed an acknowledged report') }, () => {})
  expect(restored.hasItemReports()).toBe(false)
  stuck = false; await restored.syncNow(true)
  expect(restored.pendingBytes()).toBe(0)
  expect(r.f.calls.filter(c => c.path.endsWith('/report'))).toHaveLength(1)
})

test('late conflicting report is logged, a permanent 4xx is rejected and the spool advances', async () => {
  const r = rig(), row = r.f.add('settled')
  await r.mode.probe(); await r.receiver.receive([itemRef(row)])
  const id = row.claim!.id
  r.claims.report(row.id, 'completed'); await r.sync()
  for (const item_id of [row.id, 'missing']) r.client.recordItemReport({ item_id, body: { claim_id: id, at: new Date().toISOString(), outcome: 'cut' } })
  r.client.recordItemReport({ item_id: row.id, body: { claim_id: id, at: new Date().toISOString(), outcome: 'in_session', session_id: 'another.worker.1' } })
  await r.sync(); await r.sync()
  expect(r.client.pendingBytes()).toBe(0); expect(r.logs.some(l => l.includes('version_conflict'))).toBe(true)
  const errors = r.logs.filter(l => l.startsWith('[error]'))
  expect(errors).toHaveLength(3)
  expect(errors[0]).toMatch(/Item settled cut .*409 version_conflict/)
  expect(errors[1]).toMatch(/Item missing cut .*404 not_found/)
  expect(errors[2]).toMatch(/Item settled in_session .*400 session_id 是收件成員的對話編號/)
  expect(readFileSync(r.client.rejected, 'utf8').trim().split('\n').map(l => JSON.parse(l).line.r.item_id)).toEqual(['settled', 'missing', 'settled'])
})

test('a plain-text report refusal keeps the server explanation on one error line', async () => {
  const r = rig()
  const client = new OnsenClient({ ...r.client.cfg, fetch: async () => new Response('invalid claim\nfor this item', { status: 422 }) })
  client.recordItemReport({ item_id: 'gone', body: { claim_id: 'old', outcome: 'cut', at: new Date().toISOString() } })
  await client.syncNow(true); await client.syncNow(true)
  const errors = r.logs.filter(s => s.startsWith('[error]'))
  expect(errors).toHaveLength(1)
  expect(errors[0]).toMatch(/Item gone cut .*HTTP 422 invalid claim for this item/)
  expect(errors[0]).not.toContain('\n')
})

test.each([200, 400])('a retryable Item refusal logs once across a restart and a final HTTP %i', async endStatus => {
  const r = rig()
  let status = 429
  const cfg = { ...r.client.cfg, fetch: async () => new Response(status === 429 ? 'slow down' : 'final answer', { status }) }
  const client = new OnsenClient(cfg)
  client.recordItemReport({ item_id: 'limited', body: { claim_id: 'one', outcome: 'cut', at: new Date().toISOString() } })
  await client.syncNow(true)
  expect(client.pendingBytes()).toBeGreaterThan(0)
  expect(existsSync(client.rejected)).toBe(false)
  client.stop()
  const restarted = new OnsenClient(cfg)
  await restarted.syncNow(true)
  status = endStatus
  await restarted.syncNow(true)
  expect(restarted.pendingBytes()).toBe(0)
  const errors = r.logs.filter(l => l.startsWith('[error]'))
  expect(errors).toHaveLength(1)
  expect(errors[0]).toMatch(/Item limited cut .*HTTP 429 slow down/)
  expect(existsSync(restarted.rejected)).toBe(endStatus === 400)
  if (endStatus === 400) expect(JSON.parse(readFileSync(restarted.rejected, 'utf8')).why).toContain('HTTP 400 final answer')
  restarted.stop()
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
  expect(interval).toBe(45_000); expect(takeModeActive(mode)).toBe(true); expect(mode.canReceive).toBe(false); expect(mode.observationRequired).toBe(true)
  const calls = r.f.calls.length
  await receiver.receive([itemRef(row)])
  const peek = new ItemPeek(mode, () => new Map(), async () => {}, () => true)
  await peek.poll(); expect(r.f.calls.length).toBe(calls)
  expect(r.logs.filter(s => s.includes('not_current_connector'))).toHaveLength(1)
  await mode.probe()  // the other connector still owns the take member
  expect(takeModeActive(mode)).toBe(true); expect(mode.canReceive).toBe(false)
  r.f.advance(45_001); retry!(); await until(() => mode.canReceive)
  expect([...(await receiver.receive([itemRef(row)])).given]).toEqual(['ownership'])
})

test('a 409 pause keeps the take gate until the probe confirms pull', async () => {
  const r = rig(), transitions: Array<[boolean, boolean]> = []
  const mode = new TakeMode('adam', r.mode.req, ready => transitions.push([takeModeActive(mode), ready]), () => {}, 'mac-mini')
  clean.push(() => mode.stop())
  await mode.probe()
  r.f.mode(409)
  await new ItemReceiver(mode, r.claims, () => {}).receive([itemRef(r.f.add('changed-mode'))])
  expect(transitions).toEqual([[true, true], [true, false]])
  r.f.down(true); await mode.probe()
  expect(takeModeActive(mode)).toBe(true)
  expect(mode.canReceive).toBe(false)
  r.f.down(false); await mode.probe()
  expect(transitions.at(-1)).toEqual([false, false])
  r.f.mode(200); await mode.probe()
  expect(transitions.at(-1)).toEqual([true, true])
})

test('take tools respect declared timeouts and open remote calls remain active until their result', () => {
  expect(toolSilenceMs(24000, 'mcp__lab__read')).toBe(30000)
  expect(toolSilenceMs(800, 'WebFetch')).toBe(1000)
  expect(toolSilenceMs(undefined, 'mcp__lab__read')).toBe(Infinity)
  expect(toolSilenceMs(undefined, 'WebFetch')).toBe(Infinity)
  expect(toolSilenceMs(undefined, 'Read')).toBe(0)
})

test('one stuck turn reports each claim, restarts once, then cuts with one failure per Item', async () => {
  const r = await mainRig(), a = r.f.add('stuck'), b = r.f.add('rider', 'call')
  await r.bind(a)
  r.status('busy'); r.enqueue(b); await r.hook('PostToolUse')
  const late = Date.now() + MAIN_STUCK_MS + 1000
  for (const blocker of ['waiting', 'compacting', 'starting']) {
    r.status(blocker); await r.m.tick(late)
  }
  expect(r.restarts).toHaveLength(0)
  r.status('stuck')
  await Promise.all([r.m.tick(late), r.m.tick(late + 1)])
  await r.sync()
  expect(r.restarts).toEqual([r.sid])
  expect(r.claims.held().sort()).toEqual(['rider', 'stuck'])
  await r.hook('SessionEnd'); expect(r.m.currentGen()?.item_restart).toBe('stuck')
  r.oldPidExited(); await r.m.tick(late + 5000); await r.sync()
  for (const row of [a, b]) {
    expect(r.outcomes(row.id)).toEqual(['in_session', 'stuck', 'cut'])
    expect(r.f.history.find(h => h.item_id === row.id && h.body.outcome === 'cut')?.body.note).toBe('卡住重開')
    expect(row.failures).toBe(1)
  }
  expect(r.notices).toEqual([])
})

test('a surviving pid unlocks hooks and a failed restart retries until the old pid exits', async () => {
  const targets: (number | undefined)[] = []
  let failWrapper!: (reason: Error) => void
  const r = await mainRig(undefined, undefined, async pid => {
    targets.push(pid)
    if (pid === undefined) await new Promise<void>((_, reject) => { failWrapper = reject })
    if (targets.length === 2) throw Error('signal failed')
  })
  const row = r.f.add('surviving-pid')
  await r.bind(row)
  const late = Date.now() + MAIN_STUCK_MS + 100
  const first = r.m.tick(late)
  await until(() => targets.length === 1)
  await r.m.tick(late + 4999)
  expect(r.m.currentGen()?.item_restart).toBe('stuck')
  await r.m.tick(late + 5000)
  expect(r.m.currentGen()?.item_restart).toBeUndefined()
  failWrapper(Error('wrapper check failed after the session closed')); await first
  expect(r.m.currentGen()?.item_restart_retry).toBe('stuck')
  await r.m.tick(late + 10000)
  await r.hook('SessionEnd')
  expect(r.m.currentGen()?.item_restart_retry).toBe('stuck')
  expect(r.m.currentGen()?.item_restart).toBeUndefined()
  await r.m.tick(late + 15000)
  expect(targets).toEqual([undefined, 1051, 1051])
  r.oldPidExited(); await r.m.tick(late + 20000); await r.sync()
  expect(r.outcomes(row.id)).toEqual(['in_session', 'stuck', 'cut'])
  expect(r.f.history.at(-1)?.body.note).toBe('卡住重開')
})

test('a restart retry sends TERM then KILL to the lingering PID and leaves the replacement tmux session alive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'restart-retry-'))
  const signals = join(dir, 'signals'), pane = join(dir, 'pane-pid'), kills = join(dir, 'session-kills')
  const old = Bun.spawn([process.execPath, '--no-env-file', '-e', `
    import { appendFileSync } from 'fs'
    const log = text => appendFileSync(process.env.SIGNAL_LOG, text + '\\n')
    for (const signal of ['SIGHUP', 'SIGTERM']) process.on(signal, () => log(signal))
    log('ready')
    setInterval(() => {}, 60_000)
  `], { env: { ...process.env, SIGNAL_LOG: signals } })
  const fresh = Bun.spawn(['sleep', '60'])
  try {
    await until(() => existsSync(signals))
    writeFileSync(pane, old.pid + '\n')
    writeFileSync(join(dir, 'tmux'), `#!/bin/sh
set -eu
test "$*" = 'kill-session -t =test-c3'
read -r pid < "$PANE"
echo "$pid" >> "$KILLS"
kill -HUP "$pid"
echo "$FRESH" > "$PANE"
`, { mode: 0o700 })
    const wrapperChecks = join(dir, 'wrapper-checks')
    writeFileSync(join(dir, 'launchctl'), '#!/bin/sh\ntest "$1" = print || exit 1\necho "$1" >> "$CHECKS"\necho "state = running"\n', { mode: 0o700 })
    const r = await mainRig(undefined, undefined, async retryPid => {
      const proc = Bun.spawn([process.execPath, '--no-env-file', '-e',
        "import { restartClaudeTUI } from './channel-bot-control.ts'; await restartClaudeTUI(true, " + retryPid + ")"], {
        cwd: import.meta.dir, stderr: 'pipe', env: { ...process.env, PATH: dir, PANE: pane, KILLS: kills, FRESH: String(fresh.pid), CHECKS: wrapperChecks,
          CHANNEL_BOT_TMUX_SESSION: 'test-c3', CHANNEL_BOT_SERVICE_MANAGER: 'launchd', CHANNEL_BOT_WRAPPER_LABEL: 'fixture-only' },
      })
      if (await proc.exited !== 0) throw Error(await new Response(proc.stderr).text())
    }, old.pid)
    const row = r.f.add('lingering-pid')
    await r.bind(row)
    const late = Date.now() + MAIN_STUCK_MS + 100
    await r.m.tick(late)
    await until(() => readFileSync(signals, 'utf8').includes('SIGHUP'))
    expect(readFileSync(pane, 'utf8').trim()).toBe(String(fresh.pid))
    expect(old.exitCode).toBeNull()
    await r.m.tick(late + 5000)
    const retryAt = Date.now(), exitedAt = old.exited.then(() => Date.now())
    const retry = r.m.tick(late + 10000)
    await until(() => readFileSync(signals, 'utf8').includes('SIGTERM'))
    await r.hook('SessionStart', { pid: fresh.pid, source: 'startup' })
    expect(old.exitCode).toBeNull()
    await retry
    await until(() => old.signalCode === 'SIGKILL')
    expect((await exitedAt) - retryAt).toBeGreaterThanOrEqual(3_000)
    expect(readFileSync(kills, 'utf8').trim()).toBe(String(old.pid))
    expect(readFileSync(wrapperChecks, 'utf8').trim().split('\n')).toEqual(['print', 'print'])
    expect(fresh.exitCode).toBeNull()
    expect(r.m.currentGen()?.pid).toBe(fresh.pid)
    r.oldPidExited(); await r.m.tick(late + 15000); await r.sync()
    expect(r.outcomes(row.id)).toEqual(['in_session', 'stuck', 'cut'])
  } finally {
    old.kill('SIGKILL'); fresh.kill('SIGKILL')
    await Promise.all([old.exited, fresh.exited])
    rmSync(dir, { recursive: true, force: true })
  }
}, 12000)

test('the surviving main can make progress after the failed restart', async () => {
  const targets: (number | undefined)[] = []
  const r = await mainRig(undefined, undefined, async pid => { targets.push(pid) }), row = r.f.add('still-working')
  await r.bind(row)
  const late = Date.now() + MAIN_STUCK_MS + 100
  await r.m.tick(late); await r.m.tick(late + 5000)
  await r.hook('PreToolUse', { tool_name: 'Read' })
  expect(r.m.currentGen()?.tool_open).toBe('Read')
  await r.m.tick()
  expect(targets).toEqual([undefined])
  await r.m.tick(late + 10000)
  expect(targets).toEqual([undefined, 1051])
})

for (const source of ['typed', 'pull', 'returned'] as const) test('a silent main with no claim to report stays alive: ' + source, async () => {
  const r = await mainRig(), row = r.f.add('unowned')
  if (source === 'returned') {
    await r.bind(row)
    r.receiver.report([itemRef(row)], 'reassigned')
    await r.sync()
  } else {
    const dids = source === 'pull' ? [r.enqueue(row, true)] : []
    if (dids.length) await until(() => r.m.items(x => x.id === dids[0])[0]?.state === 'offered')
    await r.hook('UserPromptSubmit', { dids })
  }
  expect(r.m.currentGen()?.state).toBe('in_turn')
  await r.m.tick(Date.now() + MAIN_STUCK_MS + 1_000); await r.sync()
  expect(r.restarts).toHaveLength(0)
  expect(r.outcomes(row.id)).not.toContain('stuck')
  expect(r.m.currentGen()?.item_restart).toBeUndefined()
})

test('Onsen parks on the third error and releases once after another Item completes', async () => {
  const r = await mainRig(), row = r.f.add('failing')
  for (let i = 1; i <= 3; i++) {
    const prompt_id = 'failure-' + i
    await r.bind(row, prompt_id); await r.hook('StopFailure', { prompt_id, error: 'server_error' }); await r.sync()
    expect(row.failures).toBe(i)
    expect(r.m.items(m => m.fails || m.fail_retry_at || m.fail_released)).toHaveLength(0)
    r.f.advance(i * 300_000 + 1)
  }
  expect(row.reason).toBe('parked')
  expect((await r.receiver.receive([itemRef(row)])).given.size).toBe(0)
  const good = r.f.add('good')
  await r.bind(good); await r.hook('Stop', { phase: 'final' })
  r.f.advance(3100); r.status('idle'); await r.sync()
  expect(row.released).toBe(true)
  await r.bind(row, 'released'); await r.hook('StopFailure', { prompt_id: 'released', error: 'server_error' }); await r.sync()
  expect(row.reason).toBe('gave_up')
  expect(row.events.filter(e => e.kind === 'released')).toHaveLength(1)
  expect(r.notices).toEqual([])
})

test('a waiting person’s original row records one limit and completes after recovery with zero connector notices', async () => {
  const r = await mainRig(), row = r.f.add('person-at-limit')
  await r.bind(row)
  r.setWall({ walled: true, clearedMs: null, lastWallMs: Date.now() })
  await r.hook('StopFailure', { error: 'rate_limit' }); await r.sync()
  expect([row.state, row.reason, row.failures]).toEqual(['waiting', 'usage_limit', 0])
  const did = r.enqueue(row)
  await r.m.tick(); await r.m.tick()
  expect(r.outcomes(row.id)).toEqual(['in_session', 'usage_limit'])
  r.setWall({ walled: false, clearedMs: Date.now() + 1000 })
  await r.m.pump()
  await until(() => r.m.items(x => x.id === did)[0].state === 'offered')
  await r.hook('UserPromptSubmit', { dids: [did], prompt_id: 'recovered' })
  await r.hook('Stop', { phase: 'final', prompt_id: 'recovered' })
  r.f.advance(4000); r.status('idle'); await r.sync()
  expect(row.state).toBe('completed')
  expect(r.outcomes(row.id)).toEqual(['in_session', 'usage_limit', 'in_session', 'completed'])
  expect(r.notices).toEqual([])
})

test('walled main leaves mail and person waiting, keeper-clear probe reports the reset time when refused', async () => {
  const targets: (number | undefined)[] = []
  const r = await mainRig(undefined, undefined, async pid => { targets.push(pid) }), first = r.f.add('first'), mail = r.f.add('blocked-mail', 'mail'), person = r.f.add('probe')
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
  expect(r.restarts).toEqual([r.sid]); expect(r.notices).toEqual([])
  expect(r.f.history.at(-1)!.body.retry_after).toBe(reset); expect(mail.state).toBe('waiting')
  const restartAt = r.m.currentGen()!.item_restart_at
  await r.m.tick(restartAt + 5000); await r.m.tick(restartAt + 10000)
  expect(targets).toEqual([undefined, 1051])
  r.oldPidExited(); await r.m.tick()
  await r.hook('SessionStart', { pid: 1052, source: 'startup' })
  await r.m.pump(); await r.sync()
  expect(r.m.currentGen()?.state).toBe('walled')
  expect(mail.claim).toBeNull()
  r.setWall({ walled: false, clearedMs: Date.now() + 5000 })
  await r.m.pump()
  await until(() => !!mail.claim)
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
