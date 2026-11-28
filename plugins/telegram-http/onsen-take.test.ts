import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fakeItems } from './test-fixtures/onsen-items.ts'
import { OnsenClient } from './onsen-client.ts'
import { machineName, TakeMode } from './onsen-take.ts'
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
async function mainRig() {
  const r = rig()
  await r.mode.probe()
  const journal = new Journal(join(r.dir, 'state.jsonl')), offers: any[] = [], notices: string[] = []
  const sid = crypto.randomUUID(), pid = 1051
  let member = 'idle', bg = 0, owes = false, wall: MainWall | null = null
  const m = createMain({ journal, agent: 'adam', itemReceiver: () => r.receiver, log: () => {}, offer: async n => { offers.push(n); return true },
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

test('a pull member retries only the Item probe and starts when Onsen accepts the connector', async () => {
  const r = rig()
  expect(machineName('  --Mac_Mini  ')).toBe('mac-mini')
  let retry!: () => void, interval = 0
  const mode = new TakeMode('adam', r.mode.req, () => {}, line => r.logs.push(line), 'mac-mini', (fn, ms) => {
    retry = fn; interval = ms
    return setTimeout(() => {}, ms).unref()
  })
  clean.push(() => mode.stop())
  const alerts: string[] = []
  mode.onUnavailable = reason => alerts.push(reason)
  r.f.mode(409); await mode.probe()
  expect(mode.active).toBe(false)
  expect(mode.health()).toEqual({ state: 'pull-refused', active: false, reason: 'not_take_member' })
  mode.pause('not_take_member', 60_000)
  await mode.probe()
  expect(alerts).toEqual(['not_take_member'])
  expect(interval).toBe(60_000)
  expect(r.logs.some(l => l.includes('not_take_member'))).toBe(true)
  r.f.mode(200); retry(); await until(() => mode.active)
  expect(mode.health()).toEqual({ state: 'take', active: true, reason: null })
  mode.pause('not_take_member', 60_000)
  expect(alerts).toEqual(['not_take_member', 'not_take_member'])
  expect(r.f.calls.map(c => [c.path, c.query.get('connector')])).toEqual(Array(3).fill([mode.path, 'mac-mini/adam']))
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
  await mode.req('GET', mode.path + '?connector=other%2Fadam&limit=1')
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
