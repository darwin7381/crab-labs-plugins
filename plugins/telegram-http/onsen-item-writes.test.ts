import { afterEach, expect, test } from 'bun:test'
import { fakeItems } from './test-fixtures/onsen-items.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OnsenClient } from './onsen-client.ts'
import { ownItem } from './onsen-self.ts'

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
  for (const bad of [{ ...b, kind: 'notice' }, { ...b, refs: {} }, { ...b, from: 'eve' }, { ...b, deadline: 'later' }]) {
    expect((await post(bad)).status).toBe(400)
  }
  expect((await post(b, '')).status).toBe(400)
  fake.mode(409)
  expect((await post(b)).status).toBe(409)
  fake.mode(200)
  const { data } = await (await post(b)).json()
  expect(data).toMatchObject({ from: 'adam', member: 'adam', waiter: 'joey-test', kind: 'self', state: 'waiting',
    session_id: 'main', payload: { text: b.body.text }, not_before: due, deadline: due, refs: b.refs })
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
    c.recordSelfWrite(write)
    await c.syncNow(true)
    expect(fake.rows.size).toBe(0)
    c.stop()
    fake.down(false)
    c = client()
    c.recordSelfWrite(write)
    await c.syncNow(true)
    expect(fake.rows.size).toBe(1)
    const row = [...fake.rows.values()][0]!
    expect(row).toMatchObject({ state: 'waiting', from: 'adam', waiter: 'eve' })
    c.recordSelfWrite({ ...write, complete: true })
    c.recordSelfWrite({ ...write, complete: true })
    await c.syncNow(true)
    expect(row.state).toBe('completed')
    expect(fake.calls.filter(call => call.body.outcome === 'completed')).toHaveLength(1)
  } finally { c.stop(); rmSync(dir, { recursive: true, force: true }) }
})
