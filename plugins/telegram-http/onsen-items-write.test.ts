import { afterEach, expect, test } from 'bun:test'
import { fakeItems } from './test-fixtures/onsen-items.ts'

let f: ReturnType<typeof fakeItems>
afterEach(() => f.stop())
function member() {
  f = fakeItems()
  const path = '/v1/members/adam/items'
  const send = async (method: string, path: string, body?: unknown, key?: string) => {
    const r = await fetch(f.base + path, { method, headers: { Authorization: 'Bearer test-member', 'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) })
    return { status: r.status, ...await r.json() as any }
  }
  const create = (kind: string) => send('POST', path, { kind, refs: [] }, crypto.randomUUID())
  const take = async (id: string) => (await send('POST', path + '/take', { connector: 'lab/adam', item_ids: [id], wait: 0, limit: 1 }, crypto.randomUUID())).data
  const report = (id: string, claim_id: string, outcome: string) => send('PUT', '/v1/items/' + id + '/report',
    { claim_id, at: new Date(f.now()).toISOString(), outcome }, crypto.randomUUID())
  return { path, send, create, take, report }
}

test('member creates one waiting item with its body, sender, times and refs; a replay returns the original response', async () => {
  const { path, send, take } = member()
  const not_before = new Date(f.now() + 2000).toISOString()
  const body = { kind: 'resume', session_id: 'main', not_before, body: { format: 'markdown', text: '接著做' }, refs: [] }
  const first = await send('POST', path, body, 'one-cut'), row = first.data
  expect(first.status).toBe(201)
  expect(row).toMatchObject({ kind: 'resume', from: 'adam', waiter: 'adam', member: 'adam', state: 'waiting', reason: null,
    session_id: 'main', version: 1, not_before, about_item_id: null, refs: [], payload: { text: '接著做' },
    takeable: { now: false, why: 'not_before' }, line: expect.stringContaining('adam/main｜接著做｜adam → 等的人 adam') })
  expect((await take(row.id)).items).toEqual([])
  f.advance(2000)
  expect((await take(row.id)).items).toHaveLength(1)
  expect(await send('POST', path, body, 'one-cut')).toEqual(first)
  expect((await send('POST', path, { ...body, kind: 'self' }, 'one-cut')).status).toBe(409)
  expect((await send('POST', path, body)).status).toBe(400)
  for (const invalid of [{ ...body, from: 'joey' }, { ...body, kind: 'notice' }, { ...body, not_before: 'later' }, { ...body, deadline: '2026-01-02' }]) {
    expect((await send('POST', path, invalid, 'invalid')).status).toBe(400)
  }
  expect((await send('POST', '/v1/members/joey/items', body, 'wrong-member')).status).toBe(403)
  expect(f.rows.size).toBe(1)
})

test('the new item displays same-year and next-year deadlines in Taipei time', async () => {
  const { path, send } = member()
  const year = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Taipei', year: 'numeric' }).format(f.now()))
  const response = await send('POST', path, { kind: 'self', refs: [], body: { format: 'markdown', text: '記得\n回報' },
    deadline: year + '-01-01T19:04:00Z', expires_at: (year + 1) + '-01-01T21:06:00Z' }, 'dates')
  expect(response.data.preview).toBe('記得 回報')
  expect(response.data.line).toEndWith('｜該回 01-02 03:04 台北｜作廢 ' + (year + 1) + '-01-02 05:06 台北')
})

test('DELETE checks author, waiting state, version and kind for all three outcomes', async () => {
  const { create, send, take } = member()
  const end = (id: string, expected_version: number, outcome?: string) => send('DELETE', '/v1/items/' + id, { expected_version, outcome })
  const resume = (await create('resume')).data
  expect((await end(resume.id, 0, 'superseded')).status).toBe(409)
  expect((await end(resume.id, 1, 'completed')).status).toBe(400)
  expect((await end(resume.id, 1, 'superseded')).data).toMatchObject({ state: 'cancelled', reason: 'superseded', version: 2, cancelled_at: expect.any(String) })
  expect((await take(resume.id)).items).toEqual([])
  const self = (await create('self')).data, warm = (await create('keepwarm')).data
  expect((await end(self.id, 1, 'superseded')).status).toBe(400)
  expect((await end(self.id, 1, 'completed')).data).toMatchObject({ state: 'completed', reason: null, completed_at: expect.any(String) })
  expect((await end(warm.id, 1)).data).toMatchObject({ state: 'cancelled', reason: 'withdrawn' })
  expect((await end(f.add('received').id, 1)).status).toBe(403)
  const claimed = (await create('resume')).data
  await take(claimed.id)
  expect((await end(claimed.id, 2, 'superseded')).error.code).toBe('version_conflict')
})

test('superseded is a terminal claim report only for resume, including a late report before another take', async () => {
  const { create, take, report } = member()
  const resume = (await create('resume')).data, claim = (await take(resume.id)).claim_id
  f.advance(45_001)
  expect((await report(resume.id, claim, 'superseded')).data).toMatchObject({ state: 'cancelled', reason: 'superseded', failures: 0, claim: null })
  expect((await take(resume.id)).items).toEqual([])
  const self = (await create('self')).data
  expect((await report(self.id, (await take(self.id)).claim_id, 'superseded')).status).toBe(400)
})

test('settled 55 counts an expired intermediate-only take once at the next take', async () => {
  const { create, take, report } = member()
  const row = (await create('resume')).data, first = (await take(row.id)).claim_id
  await report(row.id, first, 'in_session')
  f.advance(45_001)
  expect((await report(row.id, first, 'background')).data).toMatchObject({ state: 'waiting', reason: 'cut', failures: 0 })
  expect((await report(row.id, first, 'stuck')).data.failures).toBe(0)
  const second = await take(row.id)
  expect(second.items[0].failures).toBe(1)
  expect((await report(row.id, first, 'superseded')).data).toMatchObject({ state: 'claimed', claim: { id: second.claim_id } })
  expect((await report(row.id, second.claim_id, 'superseded')).data).toMatchObject({ reason: 'superseded', failures: 1 })
})
