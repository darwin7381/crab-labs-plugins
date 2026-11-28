import { afterEach, expect, test } from 'bun:test'
import { fakeItems } from './test-fixtures/onsen-items.ts'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OnsenClient } from './onsen-client.ts'
import { ownItem } from './onsen-item-writes.ts'

let fake: ReturnType<typeof fakeItems>
afterEach(() => fake?.stop())
const base = '/v1/members/adam/items'
function request(method: string, path: string, body: unknown, key = '', token = 'test-member') {
  return fetch(fake.base + path, { method, headers: { Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) })
}

test('S2 member POST authenticates the writer, validates the shape and returns the same row on retry', async () => {
  fake = fakeItems()
  const due = new Date(fake.now() + 600_000).toISOString()
  const b = { kind: 'self', body: { format: 'markdown', text: '10 分鐘後回報' }, session_id: 'main', waiter: 'joey-test',
    not_before: due, deadline: due, refs: [{ kind: 'item', value: 'origin' }] }
  const post = (body: unknown, key = 'promise') => request('POST', base, body, key)
  expect((await request('POST', base, b, 'k', 'other')).status).toBe(401)
  expect((await request('POST', '/v1/members/eve/items', b, 'k')).status).toBe(403)
  for (const bad of [{ ...b, kind: 'notice' }, { ...b, refs: {} }, { ...b, from: 'eve' }, { ...b, deadline: 'later' }, { ...b, deadline: '11' }]) {
    expect((await post(bad)).status).toBe(400)
  }
  expect((await post(b, '')).status).toBe(400)
  const { data } = await (await post(b)).json()
  expect(data).toMatchObject({ from: 'adam', member: 'adam', waiter: 'joey-test', kind: 'self', state: 'waiting',
    session_id: 'main', payload: { text: b.body.text }, preview: b.body.text, about_item_id: null, retry_after: null,
    takeable: { now: false, why: 'not_before' }, not_before: due, deadline: due, refs: b.refs })
  expect(data.line).toContain('自己留的｜adam → 等的人 joey-test｜等著')
  expect(data.events[0]).toMatchObject({ kind: 'created', claim_id: null, state: 'waiting', at: data.updated_at })
  expect((await (await post(b)).json()).data.id).toBe(data.id)
  expect((await post({ ...b, waiter: 'eve' })).status).toBe(409)
  expect(fake.rows.size).toBe(1)
  for (const kind of ['keepwarm', 'resume']) {
    expect((await (await post({ kind, refs: [] }, kind)).json()).data).toMatchObject({ kind, waiter: 'adam', deadline: null })
  }
})

test('S2 DELETE checks writer, version, claim and outcome', async () => {
  fake = fakeItems()
  const close = (id: string, version: number, outcome?: string) => request('DELETE', '/v1/items/' + id, { expected_version: version, outcome })
  const create = async (kind: string, key: string) => (await (await request('POST', base, { kind, refs: [] }, key)).json()).data
  const self = await create('self', 'promise')
  expect((await close(self.id, self.version + 1, 'completed')).status).toBe(409)
  expect((await close(self.id, self.version, 'superseded')).status).toBe(400)
  expect((await (await close(self.id, self.version, 'completed')).json()).data.state).toBe('completed')
  expect(await create('self', 'promise')).toEqual(self)
  const warm = await create('keepwarm', 'warm')
  expect((await close(warm.id, warm.version, 'completed')).status).toBe(400)
  expect((await (await close(warm.id, warm.version)).json()).data.reason).toBe('withdrawn')
  const resume = await create('resume', 'resume')
  expect((await (await close(resume.id, resume.version, 'superseded')).json()).data.state).toBe('cancelled')
  const other = fake.add('incoming')
  expect((await close(other.id, other.version)).status).toBe(403)
  const claimed = await create('self', 'claimed')
  await request('POST', base + '/take', { connector: 'bench/adam', item_ids: [claimed.id], limit: 1, wait: 0 }, 'take')
  expect((await close(claimed.id, fake.rows.get(claimed.id)!.version, 'completed')).status).toBe(409)
})

test('self writes survive a disconnected connector and close the same Item on restart', async () => {
  fake = fakeItems()
  const dir = mkdtempSync(join(tmpdir(), 'self-spool-'))
  const client = () => new OnsenClient({ dir, agent: 'adam', base: fake.base, record: true, credential: () => 'test-member', log: () => {} })
  const write = { key: 'promise-1', item: ownItem('self', 'main', '交報告', fake.now() + 60_000, 'eve', fake.now() + 60_000) }
  let c = client()
  try {
    fake.down(true)
    c.recordItemWrite(write)
    await c.syncNow(true)
    expect(fake.rows.size).toBe(0)
    c.stop()
    fake.down(false)
    c = client()
    c.recordItemWrite(write)
    await c.syncNow(true)
    expect(fake.rows.size).toBe(1)
    const row = [...fake.rows.values()][0]!
    expect(row).toMatchObject({ state: 'waiting', from: 'adam', waiter: 'eve' })
    expect(c.writtenItemId(write.key)).toBe(row.id)
    const otherMember = new OnsenClient({ ...c.cfg, agent: 'eve' })
    expect(otherMember.writtenItemId(write.key)).toBeUndefined()
    otherMember.stop()
    c.stop()
    c = client()
    expect(c.writtenItemId(write.key)).toBe(row.id)
    const posted = fake.calls.filter(call => call.key === write.key).length
    c.recordItemWrite({ ...write, complete: true })
    c.recordItemWrite({ ...write, complete: true })
    await c.syncNow(true)
    expect(row.state).toBe('completed')
    expect(fake.calls.filter(call => call.key === write.key)).toHaveLength(posted)
    expect(fake.calls.find(call => call.body.outcome === 'completed')?.path).toBe('/v1/items/' + row.id)
    c.recordItemWrite({ ...write, item: { ...write.item, waiter: 'ken' } })
    await c.syncNow(true)
    expect(c.stats.rejected).toBe(1)
    const offline = { key: 'finished-before-ack', item: write.item }
    fake.down(true)
    c.recordItemWrite(offline); c.recordItemWrite({ ...offline, complete: true })
    await c.syncNow(true)
    c.stop(); c = client(); fake.down(false)
    await c.syncNow(true)
    expect(fake.rows.get(c.writtenItemId(offline.key)!)!.state).toBe('completed')
    expect(fake.calls.filter(call => call.path === '/v1/items/' + row.id && call.body.outcome === 'completed')).toHaveLength(1)
  } finally { c.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('one ordered spool reads legacy self lines, drops a permanent refusal once and continues to resume and keepwarm', async () => {
  fake = fakeItems()
  const dir = mkdtempSync(join(tmpdir(), 'item-spool-')), logs: string[] = []
  const client = new OnsenClient({ dir, agent: 'adam', base: fake.base, record: true, credential: () => 'test-member',
    log: (_, line) => logs.push(line) })
  try {
    const legacy = { key: 'old-self', item: ownItem('self', 'main', 'old', fake.now()) }
    appendFileSync(client.spool, JSON.stringify({ k: 'self', r: legacy }) + '\n')
    client.recordItemWrite({ key: 'invalid-waiter', item: ownItem('self', 'main', 'bad', null, 'invalid!') })
    client.recordItemWrite({ key: 'resume', item: { kind: 'resume', refs: [] } })
    client.recordItemWrite({ key: 'keepwarm', item: ownItem('keepwarm', 'main', 'keepwarm', null) })
    await client.syncNow(true); await client.syncNow(true)
    expect([...fake.rows.values()].map(r => r.kind)).toEqual(['self', 'resume', 'keepwarm'])
    expect(fake.calls.map(c => c.key)).toEqual(['old-self', 'invalid-waiter', 'resume', 'keepwarm'])
    expect(logs.filter(l => l.includes('invalid-waiter') && l.includes('HTTP 400'))).toHaveLength(1)
    expect(client.stats.rejected).toBe(1)
  } finally { client.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('a pre-receipt commitment closes by matching its original waiting Item without a second POST', async () => {
  fake = fakeItems()
  const dir = mkdtempSync(join(tmpdir(), 'item-upgrade-'))
  const c = new OnsenClient({ dir, agent: 'adam', base: fake.base, record: true, credential: () => 'test-member', log: () => {} })
  try {
    const item = ownItem('self', 'main', '回報（old-event）', fake.now() + 60_000, 'eve')
    const row = (await (await request('POST', base, item, 'pre-upgrade')).json()).data
    const other = (await (await request('POST', base, { ...item, waiter: 'cain' }, 'other')).json()).data
    const nested = fake.add('body-only', 'self', { from: 'adam', session_id: 'main', waiter: 'eve',
      not_before: item.not_before, deadline: item.deadline, payload: { body: { text: item.body!.text } } })
    c.recordItemWrite({ key: 'pre-upgrade', item, complete: true })
    await c.syncNow(true)
    expect(c.writtenItemId('pre-upgrade')).toBe(row.id)
    expect(fake.rows.get(row.id)!.state).toBe('completed')
    expect(fake.rows.get(other.id)!.state).toBe('waiting')
    expect(nested.state).toBe('waiting')
    expect(fake.calls.filter(call => call.key === 'pre-upgrade')).toHaveLength(1)
  } finally { c.stop(); rmSync(dir, { recursive: true, force: true }) }
})
