import { afterEach, expect, setSystemTime, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMain, INTERRUPTED_LINE, MAIN_STUCK_MS, type ItemKind, type MainEnv, type MainWall } from './lanes-main.ts'
import { Journal } from './lanes-state.ts'
import { OnsenClient } from './onsen-client.ts'
import { DeliveryFacts, LanesTap } from './onsen-status.ts'
import { decideWake, loadWakeTable } from './wake-decide.ts'

const sid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const T = Date.parse('2026-11-27T03:00:00Z')
afterEach(() => setSystemTime())

function daemon(age = 300_000, m2: 'idle' | 'walled' | 'offline' = 'walled') {
  setSystemTime(T)
  const dir = mkdtempSync(join(tmpdir(), 'wo200-'))
  const journal = new Journal(join(dir, 'journal'), () => Date.now())
  const wall: MainWall = { walled: true, lastWallMs: T - age, clearedMs: null, resets_at: '2026-12-02T07:00:00Z' }
  const offers: string[][] = [], texts: string[] = [], notices: string[] = []
  const requests: Array<{ method: string; path: string; body: any }> = []
  const calls = new Map<string, string>()
  const client = new OnsenClient({ agent: 'adam', base: 'http://fake', record: true, dir, credential: () => 'test', log: () => {},
    fetch: (async (input, init) => {
      const path = new URL(String(input)).pathname, body = init?.body ? JSON.parse(String(init.body)) : null
      requests.push({ method: init?.method ?? 'GET', path, body })
      const id = path.match(/^\/v1\/calls\/(\d+)$/)?.[1]
      return Response.json(id ? { data: { state: calls.get(id), thread_id: '9', conversation_id: '2', caller: 'scheduler' } }
        : path === '/deliveries/batch' ? { results: body.items.map(() => ({})) } : {})
    }) as typeof fetch })
  if (m2 !== 'offline') journal.write('main', '123', m2, { pid: 123, session_id: sid, retry_at: T + 3_600_000 })
  const env: MainEnv = { journal, agent: 'adam', usageWall: () => wall, memberState: () => wall.walled ? 'walled' : 'idle',
    offer: async n => { const p = n.params as any; offers.push(p.meta.did.split(',')); texts.push(p.content); return true },
    streamOpen: () => true, pidAlive: () => true, info: () => null, done: () => {}, undone: () => {},
    tellJoey: (_s, rule) => notices.push(rule), log: () => {}, expectedSession: () => [sid], refused: () => {}, genChanged: () => {}, context: () => '',
    blocked: (r, retry_after) => { for (const id of r.person_message_ids) client.recordBlocked({ message_id: id, retry_after }) },
    checkCall: (id, why) => client.checkWaitingCall(id, why) }
  const main = createMain(env)
  main.initMain()
  const facts = new DeliveryFacts({ agent: 'adam', sink: f => client.recordDelivery(f) })
  const tap = new LanesTap({ facts, joey: () => null, gen: () => main.currentGen(), changed: () => {} })
  journal.observe((r, l) => tap.journal(r, l))
  const add = (kind: ItemKind, n: string, batched = false) => main.enqueue(kind, { method: 'notifications/claude/channel',
    params: { content: n, meta: { chat_id: '44', message_id: 'client-' + n } } },
    { fields: kind === 'joey' ? { person_message_ids: [n] } : { call_id: n }, batched })
  const flush = async () => { await Bun.sleep(0); await main.pump(); await Bun.sleep(0) }
  const hook = (event: string, prompt_id: string, other: object = {}) => main.mainEvent({ event, prompt_id, session_id: sid, pid: 123, ...other })
  const clear = () => { wall.walled = false; wall.clearedMs = Date.now(); main.statusChanged() }
  return { env, journal, main, add, wall, offers, texts, notices, requests, calls, client, hook, clear, flush }
}

test('WO-200 (a) human probes an old wall immediately', async () => {
  const d = daemon(300_000, 'idle')
  const item = d.add('joey', '100')
  await d.flush()
  expect(d.offers).toEqual([[item]])
  expect(decideWake({ kind: 'joey_tg' }, { member: 'walled', personTarget: 'main_now' }, loadWakeTable()).target).toBe('main_now')
})

test('WO-200 (b) human probes once at the 60-second boundary', async () => {
  const d = daemon(10_000), item = d.add('joey', '101')
  await d.flush()
  setSystemTime(T + 49_999)
  await d.main.tick()
  expect(d.offers).toEqual([])
  setSystemTime(T + 50_000)
  await d.main.tick(); await d.main.tick()
  expect(d.offers).toEqual([[item]])
})

test('WO-200 (c) program waits through a human probe and is offered once on clear', async () => {
  const d = daemon(), call = d.add('peer', '5'), person = d.add('joey', '101')
  d.calls.set('5', 'accepted')
  await d.flush()
  expect(d.offers).toEqual([[person]])
  await d.hook('UserPromptSubmit', 'p', { dids: [person] })
  expect((await d.hook('PostToolUse', 'p', { tool_name: 'Read' })).additionalContext).toBeUndefined()
  await d.hook('Stop', 'p', { phase: 'final' }); await d.flush()
  expect(d.offers).toEqual([[person]])
  d.clear(); await d.flush(); await d.main.tick()
  expect(d.offers).toEqual([[person], [call]])
})

test('WO-200 (d) two refusals write blocked receipts and replay in order once', async () => {
  const d = daemon(), ids: string[] = []
  for (const n of ['101', '102']) {
    const item = d.add('joey', n)
    ids.push(item)
    await d.flush()
    await d.hook('UserPromptSubmit', n, { dids: [item] })
    await d.hook('StopFailure', n, { error: 'rate_limit' })
    d.wall.resets_at = null
    setSystemTime(Date.now() + 60_000)
    await d.main.tick()
  }
  await d.client.syncNow(true)
  expect(d.requests.filter(r => r.method === 'PUT')).toEqual(['101', '102'].map(n => ({
    method: 'PUT', path: '/v1/messages/' + n + '/receipt', body: { handling: { state: 'blocked', blocked_by: 'usage_limit', retry_after: n === '101' ? '2026-12-02T07:00:00Z' : null } },
  })))
  expect(d.requests.some(r => r.path.includes('messages') && r.method === 'POST')).toBe(false)
  expect(d.requests.flatMap(r => r.body?.items ?? []).some(f => f.state === 'turn_end')).toBe(false)
  expect(d.offers).toEqual(ids.map(id => [id]))
  d.clear(); await d.flush()
  await d.hook('UserPromptSubmit', 'retry-1', { dids: [ids[0]] })
  await d.hook('Stop', 'retry-1', { phase: 'final' }); await d.flush()
  await d.hook('UserPromptSubmit', 'retry-2', { dids: [ids[1]] })
  await d.hook('Stop', 'retry-2', { phase: 'final' }); await d.flush(); await d.main.tick()
  expect(d.offers).toEqual([...ids, ...ids].map(id => [id]))
  await d.client.syncNow(true)
  expect(d.requests.flatMap(r => r.body?.items ?? []).filter(f => f.state === 'seen').map(f => f.turn_id)).toEqual(['101', '102', 'retry-1', 'retry-2'])
  expect(d.notices).toEqual(['main-wall-up', 'main-wall-down'])
})

test('WO-200 (e) output before refusal rides the next item or waits a quiet period from clear', async () => {
  for (const ride of [false, true]) {
    const d = daemon(), item = d.add('joey', '107')
    await d.flush()
    await d.hook('UserPromptSubmit', 'work', { dids: [item] })
    await d.hook('PreToolUse', 'work', { tool_name: 'Read' })
    await d.hook('StopFailure', 'work', { error: 'rate_limit' })
    expect(d.journal.get('msg', item)).toMatchObject({ state: 'queued', reason: 'interrupted', cut_by: 'stop_failure:rate_limit' })
    setSystemTime(T + 2 * MAIN_STUCK_MS)
    d.clear(); await d.flush(); await d.main.tick()
    expect(d.offers).toEqual([[item]])
    if (ride) {
      const next = d.add('joey', '108'); await d.flush()
      expect(d.offers[1]).toEqual([next, item])
    } else {
      setSystemTime(Date.now() + MAIN_STUCK_MS + 1)
      await d.main.tick(); await d.flush()
      expect(d.offers).toEqual([[item], [item]])
    }
    expect(d.texts[1]).toContain(INTERRUPTED_LINE)
  }
})

test('WO-200 (f) final Call gets one thread line and only the open Call reaches main', async () => {
  const d = daemon()
  d.calls.set('5', 'failed'); d.calls.set('6', 'accepted')
  const stale = d.add('peer', '5'), open = d.add('peer', '6')
  await d.flush()
  expect(d.requests).toEqual([])
  d.clear(); await d.flush(); await d.main.tick()
  expect(d.offers).toEqual([[open]])
  expect(d.journal.get('msg', stale)).toMatchObject({ state: 'done', reason: 'call_already_final' })
  expect(d.requests.filter(r => r.method === 'POST')).toEqual([expect.objectContaining({ path: '/v1/conversations/2/messages',
    body: expect.objectContaining({ thread_ids: ['9'], body: { format: 'markdown', text: '上限解除時這件已經是 failed，沒有交給主線' } }) })])
})

test('WO-200 offline and restored Calls are checked before a hook can pull them', async () => {
  for (const cause of ['offline', 'restart']) {
    const d = daemon(300_000, cause === 'offline' ? 'offline' : 'idle')
    d.wall.walled = false
    // A batched Call cannot lead an offer. On restart this is an older journal without wait metadata.
    const item = d.add('peer', '8', true)
    const m = cause === 'restart' ? createMain(d.env) : d.main
    if (cause === 'restart') m.initMain()
    else expect((await m.mainEvent({ event: 'SessionStart', session_id: sid, pid: 123 })).accepted).toBe(true)
    await m.mainEvent({ event: 'UserPromptSubmit', prompt_id: 'work', session_id: sid, pid: 123 })
    const boundary = () => m.mainEvent({ event: 'PostToolUse', prompt_id: 'work', session_id: sid, pid: 123 })
    expect((await boundary()).additionalContext).toBeUndefined() // lookup has no state
    expect(d.journal.get('msg', item)?.state).toBe('queued')
    d.calls.set('8', cause === 'restart' ? 'expired' : 'cancelled')
    expect((await boundary()).additionalContext).toBeUndefined()
    expect((await boundary()).additionalContext).toBeUndefined()
    expect(d.journal.get('msg', item)).toMatchObject({ state: 'done', call_state: d.calls.get('8') })
    expect(d.requests.filter(r => r.method === 'POST').map(r => r.body.body.text)).toEqual([
      cause === 'restart' ? '重新啟動時這件已經是 expired，沒有交給主線' : '主線恢復連線時這件已經是 cancelled，沒有交給主線',
    ])
    expect(d.offers).toEqual([])
  }
})

test('WO-200 a wall returning during Call lookup keeps the program queued', async () => {
  const d = daemon(), item = d.add('peer', '5')
  await d.flush()
  let complete!: (result: 'open') => void
  d.env.checkCall = () => new Promise(resolve => { complete = resolve })
  d.clear()
  d.wall.walled = true
  d.wall.lastWallMs = Date.now()
  complete('open')
  await d.flush()
  expect(d.offers).toEqual([])
  expect(d.journal.get('msg', item)?.state).toBe('queued')
  d.env.checkCall = async () => 'open'
  d.clear(); await d.flush()
  expect(d.offers).toEqual([[item]])
})
