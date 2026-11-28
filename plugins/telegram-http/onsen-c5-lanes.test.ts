import { afterAll, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OnsenClient } from './onsen-client.ts'
import { TakeMode } from './onsen-take.ts'
import { ItemReceiver } from './onsen-receive.ts'
import { Claims } from './onsen-claims.ts'
import { fakeItems } from './test-fixtures/onsen-items.ts'
import { chatWaiter, promiseTime } from './onsen-promises.ts'
import { itemRef } from './onsen-items.ts'
import { outcomeFingerprint } from './lanes-followup.ts'

const dir = mkdtempSync(join(tmpdir(), 'c5-lanes-'))
const f = fakeItems()
const jev = Bun.serve({ hostname: '127.0.0.1', port: 0,
  fetch: () => Response.json({ answers: { promises: { type: 'noul', noul: 0.99 } } }) })
const env = { LANES_DIR: dir, TYPESAFE_API_KEY: 'test', TYPESAFE_BASE_URL: 'http://127.0.0.1:' + jev.port }
const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
Object.assign(process.env, env)
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
const L: typeof import('./lanes.ts') = await import(new URL('./lanes.ts?onsen-c5', import.meta.url).href)
const pushes: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  authOk: () => false, registryNames: () => ['eve'], joeyChatId: () => '6736970916',
  sendBot: async (_chat: string, text: string) => { pushes.push(text); return 1 } } as any)
L.__setMainConnected('test-main')
const client = new OnsenClient({ dir, agent: 'adam', record: true, base: f.base, credential: () => 'test-member', log: () => {} })
const mode = new TakeMode('adam', client.request.bind(client), () => {}, () => {})
const claims = new Claims(join(dir, 'claims.json'), client, () => {}, () => {}, f.now)
const receiver = new ItemReceiver(mode, claims, () => {})
L.useItemReceiver(receiver, write => client.recordItemWrite(write))
await mode.probe()
afterAll(() => {
  mode.stop(); claims.stop(); client.stop(); f.stop(); jev.stop(true)
  L.useItemReceiver(undefined)
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  rmSync(dir, { recursive: true, force: true })
})
const selfRows = () => [...f.rows.values()].filter(r => r.kind === 'self')
const notices = (id: string) => [...f.rows.values()].filter(r => r.kind === 'notice' && r.about_item_id === id)

test('a sent Telegram promise creates one self for the test account and reporting at minute five yields no notice', async () => {
  const at = Date.now()
  L.mainReplied(null, 'onsen:42', undefined, '10 分鐘後回報', '6736970916')
  L.mainReplied(null, 'onsen:42', undefined, '10 分鐘後回報', '6736970916')
  for (let i = 0; i < 100 && !selfRows().length; i++) { await Bun.sleep(10); await client.syncNow(true) }
  expect(selfRows()).toHaveLength(1)
  const row = selfRows()[0]!
  expect(row).toMatchObject({ from: 'adam', waiter: 'joey-test', session_id: 'main', deadline: null })
  expect(Date.parse(row.not_before!)).toBeGreaterThanOrEqual(at + 600_000)
  expect(Date.parse(row.not_before!)).toBeLessThanOrEqual(Date.now() + 600_000)
  f.advance(Date.parse(row.not_before!) - f.now() - 300_000)
  L.mainReplied(null, 'onsen:43', undefined, '已經完成，這是結果。', '6736970916')
  f.advance(300_001); L.dueTick(f.now())
  f.advance(60_000); L.dueTick(f.now())
  expect(notices(row.id)).toHaveLength(0)
  expect(pushes).toHaveLength(0)
})

test('lane notify_joey and commitment leave timed member reminders without waiter deadlines', async () => {
  const lane = 'adam.reflex.promise', event = 'lane-promise', thread = 'adam#lane-promise', s = L.__lanesState()
  s.lanes[lane] = { id: lane, kind: 'reflex', thread, status: 'idle', runs: 0, last: new Date().toISOString() } as any
  s.threads[thread] = { id: thread, lane, peer: 'lilith' } as any
  L.__events().open(event, { class: 'joey', owner: lane, thread, obligations: [{ kind: 'joey', level: 'line' }] })
  const tok = { runId: 'lane-notify', lane, evId: event, trigger: 'joey', cls: 'joey', closers: [] } as any
  expect(await L.callLaneTool(tok, 'notify_joey', { outcome: 'changed', text: '10 分鐘後回報' })).toContain('sent to Joey')
  expect(await L.callLaneTool({ ...tok, runId: 'lane-commit' }, 'commitment', { who: 'lilith', what: '交圖', by: '10 分鐘後' })).toContain('commitment recorded')
  const rows = () => selfRows().filter(r => r.session_id === lane)
  for (let i = 0; i < 100 && rows().length < 2; i++) { await Bun.sleep(10); await client.syncNow(true) }
  expect(rows().map(r => r.waiter).sort()).toEqual(['joey-test', 'lilith'])
  for (const row of rows()) {
    expect(row.not_before).toBeTruthy()
    expect(row.deadline).toBeNull()
    f.advance(Math.max(0, Date.parse(row.not_before!) - f.now() + 1))
    expect(notices(row.id)).toHaveLength(0)
  }
})

test('the main tool and a handed peer answer keep their actual waiter and finish early', async () => {
  const due = new Date(f.now() + 600_000).toISOString()
  expect(await L.callMainTool('commitment', { who: '未指明', what: '寄圖', due }, 'test-main')).toContain('who must identify')
  const reply = await L.callMainTool('commitment', { who: 'member:eve', what: '寄圖', due }, 'test-main')
  const id = /\(id (cm-[^;]+)/.exec(reply)![1]!
  await client.syncNow(true)
  const row = selfRows().find(r => r.waiter === 'eve')!
  expect(row).toMatchObject({ deadline: due, not_before: due, state: 'waiting' })
  expect(await L.callMainTool('commitment_done', { commitment_id: id }, 'test-main')).toContain('marked done')
  L.__events().open('handed', { class: 'peer', owner: 'main', thread: 't', obligations: [
    { kind: 'peer', level: 'answer', state: 'handed', what: '回信', to: 'cain', due_at: Date.parse(due) }] })
  await L.mainSentTo('cain', 't', null, '已寄出', '33', true)
  await client.syncNow(true)
  expect(row.state).toBe('completed')
  const peer = selfRows().find(r => r.waiter === 'cain')!
  expect(peer.state).toBe('completed')
  f.advance(700_000)
  expect(notices(row.id)).toHaveLength(0)
  expect(notices(peer.id)).toHaveLength(0)

  const missed = new Date(f.now() + 60_000).toISOString()
  await L.callMainTool('commitment', { who: 'sable', what: '交付分析', due: missed }, 'test-main')
  await client.syncNow(true)
  const open = selfRows().find(r => r.waiter === 'sable')!
  f.advance(60_001); f.advance(60_000)
  expect(notices(open.id)).toHaveLength(1)
  expect(notices(open.id)[0]).toMatchObject({ member: 'sable', reason: 'promise_due' })
})

test('untimed replies and explicit commitments stay in M3 without waking a member', async () => {
  const count = selfRows().length
  expect(await L.promiseCheck({ who: 'main', to: 'cain', text: '我會回報結果', thread: null, ref: 'no-time' })).toBe('written')
  const reply = await L.callMainTool('commitment', { who: 'eve', what: '稍後回報' }, 'test-main')
  expect(reply).toContain('commitment recorded')
  await client.syncNow(true)
  expect(selfRows()).toHaveLength(count)
})

test('only definite times become deadlines', () => {
  const at = Date.parse('2026-11-28T23:50:00+08:00')
  expect(promiseTime('12 分鐘後回報', at)).toBe(at + 720_000)
  expect(promiseTime('明天 10:15 前回報', at)).toBe(Date.parse('2026-11-29T10:15:00+08:00'))
  expect(promiseTime('明天下午 3 點半回覆', at)).toBe(Date.parse('2026-11-29T15:30:00+08:00'))
  expect(promiseTime('週一上午 9 時回覆', at)).toBe(Date.parse('2026-11-30T09:00:00+08:00'))
  expect(promiseTime('稍後回報', at)).toBeNull()
  expect(promiseTime('第 1 點', at)).toBeNull()
})

test('clock times belong to the promise clause and bare past clocks roll to tomorrow', async () => {
  const at = Date.parse('2026-11-28T15:00:00+08:00')
  expect(promiseTime('10:30 那次重啟是正常的，晚點跟你說', at)).toBeNull()
  expect(promiseTime('10 分鐘後，我會回報', at)).toBe(at + 600_000)
  expect(promiseTime('9 點前給你', at)).toBe(Date.parse('2026-11-29T09:00:00+08:00'))
  expect(promiseTime('10:30 那次重啟是正常的，我會 16:30 回報', at)).toBe(at + 90 * 60_000)
  expect(promiseTime('今天 10:30 前回報', at)).toBeNull()
  expect(promiseTime('回報', at, '2026-11-27T10:00:00+08:00')).toBeNull()
  const count = selfRows().length
  expect(await L.promiseCheck({ who: 'main', to: 'ken', text: '10:30 那次重啟是正常的，我會稍後回報', thread: null, ref: 'historical-clock' })).toBe('written')
  await client.syncNow(true)
  expect(selfRows()).toHaveLength(count)
})

test('a direct chat or a single group sender identifies the waiter', () => {
  const a = itemRef(f.add('group-a', 'message', { from: 'eve' })), b = { ...a, from: 'cain' }
  expect(chatWaiter('member:cain', [a])).toBe('cain')
  expect(chatWaiter('789', [a])).toBe('tg-789')
  expect(chatWaiter('-123', [a, a])).toBe('eve')
  expect(chatWaiter('-123', [a, b])).toBeUndefined()
})

test('a promise marked done while the connector is paused closes its original Item on reactivation', async () => {
  const reply = await L.callMainTool('commitment', { who: 'eve', what: '10 分鐘後回圖' }, 'test-main')
  const id = /\(id (cm-[^;]+)/.exec(reply)![1]!
  await client.syncNow(true)
  const row = selfRows().find(r => r.payload.text.includes(id))!
  expect(row.deadline).toBeTruthy()
  mode.pause('paused for test', 60_000)
  await L.callMainTool('commitment_done', { commitment_id: id }, 'test-main')
  await mode.probe()
  L.resumeSelfItems()
  await client.syncNow(true)
  expect(row.state).toBe('completed')
})

test('switching a mixed pull-era event publishes only the outstanding future commitment', async () => {
  const id = 'switch-mixed', now = Date.now(), due = now + 300_000
  mode.pause('test first switch', 60_000)
  const base = { kind: 'peer' as const, level: 'commitment', to: 'ken', due_at: due }
  L.__events().open(id, { class: 'peer', owner: 'main', obligations: [
    { ...base, what: 'future' }, { ...base, what: 'overdue', due_at: now - 1 },
    { ...base, what: 'told', told: true }, { ...base, what: 'rung', rang: true },
    { ...base, what: 'terminal', state: 'met' }, { ...base, what: 'handed', state: 'handed' },
    { ...base, what: 'old answer', level: 'answer', state: 'handed' }
  ] })
  await mode.probe()
  L.resumeSelfItems(); L.__events().note(id, { did: 'updated digest' }); L.resumeSelfItems()
  await client.syncNow(true)
  const rows = selfRows().filter(r => r.payload.text.includes(id))
  expect(rows).toHaveLength(1)
  expect(rows[0]!.payload.text).toContain('future')
})

test('an overdue answer on an inbound Item keeps its single L18 push', async () => {
  const id = 'item-answer-due', what = '補上 api 日誌', now = Date.now()
  const before = pushes.length
  L.__events().open(id, { class: 'peer', owner: 'main', fields: { onsen_items: [itemRef(f.add(id))] },
    obligations: [{ level: 'answer', kind: 'peer', state: 'handed', to: 'cain', what, due_at: now - 1 }] })
  L.dueTick(now); L.dueTick(now + 1000)
  await client.syncNow(true)
  expect(selfRows().filter(r => r.payload.text.includes(id))).toHaveLength(0)
  expect(pushes.slice(before).filter(text => text.includes(what))).toHaveLength(1)
})

test('a pull member keeps a new commitment entirely in M3', async () => {
  f.mode(409); await mode.probe()
  try {
    const count = selfRows().length
    const reply = await L.callMainTool('commitment', { who: 'eve', what: 'another report', due: new Date(f.now() + 60_000).toISOString() }, 'test-main')
    expect(reply).toContain('Joey is rung once')
    const id = /\(id (cm-[^;]+)/.exec(reply)![1]!
    await client.syncNow(true)
    expect(selfRows()).toHaveLength(count)
    await L.callMainTool('commitment_done', { commitment_id: id }, 'test-main')
  } finally { f.mode(200); await mode.probe() }
})

test('followup keeps the origin lane and sender limits, and only a due Item enters the lane queue', async () => {
  const s = L.__lanesState(), lane = 'adam.reflex.25', thread = 'adam#checks', event = 'check-25'
  s.lanes[lane] = { id: lane, kind: 'reflex', thread, status: 'idle', runs: 0, last: new Date().toISOString() } as any
  s.threads[thread] = { id: thread, lane, peer: 'eve' } as any
  const tok = { runId: 'check-r1', lane, evId: event, trigger: 'peer', cls: 'peer', closers: [] } as any
  L.__events().open(event, { class: 'peer', owner: lane, thread, obligations: [] })
  const schedule = (note: string) => L.callLaneTool(tok, 'followup', { after_minutes: 10, note })
  for (const note of ['重查 A', '重查 B', '重查 C']) expect(await schedule(note)).toContain('scheduled')
  expect(await schedule('第四個')).toContain('max 3')
  await client.syncNow(true)
  const rows = selfRows().filter(r => r.session_id === lane)
  expect(rows).toHaveLength(3)
  const row = rows[0]!, follow = s.followups[row.refs[0]!.value]!
  expect(row).toMatchObject({ waiter: 'eve', deadline: null, not_before: follow.due_iso, state: 'waiting' })
  expect(row.payload.text).toContain(follow.note)
  // Make the old local tick see an overdue check. Only the Item route can dispatch it.
  follow.due = Date.now() - 1
  L.followupTick()
  L.resumeSelfItems()
  expect(follow.state).toBe('pending')
  s.wall = { kind: 'usage', probe_at: Date.now() + 3600_000 } as any
  L.routeOwnItem(row, itemRef(row), row.payload.text)
  expect(follow.state).toBe('fired')
  expect(follow.fired_event).toBe(event)
  expect(L.itemIndex().get(row.id)).toBe(row.version)
  expect(row.claim).toBeNull()
  expect(await schedule('到點但還沒有領走')).toContain('max 3')
  f.advance(Math.max(0, Date.parse(row.not_before!) - f.now() + 1))
  expect((await receiver.receive([itemRef(row)])).given.has(row.id)).toBe(true)
  const next = { ...tok, runId: 'check-r2', followup: true, followupId: follow.id }
  const did = '數量仍是 12 件'
  s.threads[thread]!.fu_fp = outcomeFingerprint('normal', { did })
  expect(await L.callLaneTool(next, 'followup', { after_minutes: 5, note: '再看一次' })).toContain('scheduled')
  await L.callLaneTool(next, 'receipt', { outcome: 'normal', happened: '查了', did, promised: '無', needs_main: '無' })
  await client.syncNow(true)
  expect(selfRows().filter(r => r.session_id === lane)).toHaveLength(3)
  expect(Object.values(s.followups).filter(f => f.ended === 'no-change')).toHaveLength(1)
  follow.chain = 4
  expect(await L.callLaneTool({ ...next, unchanged: false }, 'followup', { after_minutes: 5, note: '第五趟' })).toContain('cap 4')
})
