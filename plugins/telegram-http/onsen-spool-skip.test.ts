import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OnsenClient, answeredCall, credentialRefused, isRoamerEnv, recordFor, refusedForGood } from './onsen-client.ts'
import type { ItemReport } from './onsen-receive.ts'

const BASE = 'http://127.0.0.1:1'
const report: ItemReport = { item_id: 'item-1', body: { claim_id: 'claim-1', outcome: 'completed', at: '2026-11-28T00:00:00Z' } }

describe('upgrading a durable report spool', () => {
  test('a scheduled result is retried with the same body and key after restart, before the claim completes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'result-spool-'))
    const requests: Array<{ path: string; method: string; body: unknown; key: string | null }> = []
    const statuses = [503, 200, 200]
    const cfg = { dir, agent: 'adam', base: BASE, record: true, credential: () => 'fixture', log: () => {},
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ path: new URL(url).pathname, method: init.method!, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get('Idempotency-Key') })
        return Response.json({}, { status: statuses.shift() })
      }) as typeof fetch }
    const result = { outcome: 'failed', body: { format: 'markdown' as const, text: 'disk full' } }
    const c = new OnsenClient(cfg)
    expect(c.recordCall({ call_id: '71', run_id: '93', event: 's', idem: 'call:run:93:result', body: { result } })).toBe(true)
    expect(c.recordItemReport(report)).toBe(true)
    await c.syncNow(true); c.stop()
    const restarted = new OnsenClient(cfg)
    await restarted.syncNow(true); restarted.stop()
    const put = { path: '/v1/calls/71/state', method: 'PUT', body: { result }, key: 'call:run:93:result' }
    expect(requests).toEqual([put, put, { path: '/v1/items/item-1/report', method: 'PUT', body: report.body, key: 'ir:item-1:claim-1:completed' }])
    expect(restarted.pendingBytes()).toBe(0)
  })

  test('old receipts advance locally, an unacknowledged claim survives two refusals and replays after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spool-upgrade-'))
    const old = ['d', 'w', 'c', 'a', 'r', 'blocked'].map(k => ({ k, r: { id: 'old', body: { state: 'completed' } } }))
    writeFileSync(join(dir, 'spool.jsonl'), old.map(x => JSON.stringify(x)).join('\n') + '\n')
    const requests: Array<{ path: string; method: string; body: unknown; key: string | null }> = []
    const statuses = [401, 403, 200]
    const cfg = { agent: 'adam', dir, base: BASE, log: () => {}, credential: () => 'fixture', record: true,
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ path: new URL(url).pathname, method: init.method!, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get('idempotency-key') })
        return Response.json({ error: { code: 'not_authenticated' } }, { status: statuses.shift() })
      }) as typeof fetch }
    const first = new OnsenClient(cfg)
    expect(first.recordItemReport(report)).toBe(true)
    await first.syncNow(true)
    first.stop()
    const client = new OnsenClient(cfg)
    const replay: ItemReport[] = [], accepted: boolean[] = []
    client.watchItemReports(r => replay.push(r), (_r, ok) => accepted.push(ok))
    expect(replay).toEqual([report])
    await client.syncNow(true)
    expect(client.hasItemReports()).toBe(true)
    expect(accepted).toEqual([])
    await client.syncNow(true)
    expect(accepted).toEqual([true])
    expect(client.pendingBytes()).toBe(0)
    expect(client.hasItemReports()).toBe(false)
    expect(requests).toHaveLength(3)
    expect(requests).toEqual(Array(3).fill({ path: '/v1/items/item-1/report', method: 'PUT', body: report.body, key: 'ir:item-1:claim-1:completed' }))
    expect(existsSync(join(dir, 'rejected.jsonl'))).toBe(false)
    client.stop()
  })

  test('preserves unsupported records in full before advancing to a live report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'future-spool-'))
    const unknown = ['iw', 'item', 'self', 'new-kind', 'c'].map(k => ({ k, r: { text: 'x'.repeat(3100) } }))
    const c = new OnsenClient({ dir, agent: 'adam', base: BASE, record: true, credential: () => 'fixture', log: () => {},
      fetch: (async () => Response.json({})) as typeof fetch })
    writeFileSync(c.spool, unknown.map(x => JSON.stringify(x)).join('\n') + '\n')
    c.recordItemReport(report)
    mkdirSync(c.rejected) // refusal to store the rejected record must keep the cursor on it
    const pending = c.pendingBytes()
    await c.syncNow(true)
    expect(c.pendingBytes()).toBe(pending)
    rmdirSync(c.rejected)
    await c.syncNow(true)
    const rejected = readFileSync(c.rejected, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rejected.map(r => r.line)).toEqual(unknown)
    expect(rejected.every(r => r.why.includes(r.line.k))).toBe(true)
    expect(c.stats.rejected).toBe(5)
    expect(c.hasItemReports()).toBe(false)
    expect(c.pendingBytes()).toBe(0)
    c.stop()
  })

  test('refused for good: every 4xx but the credential (401, 403 not_authenticated), a timeout (408), too early (425), too fast (429)', () => {
    const r = (status: number, code?: string) => ({ status, json: code ? { error: { code, message: 'x' } } : { detail: 'x' } })
    for (const x of [r(400), r(403), r(403, 'not_authorized'), r(404), r(404, 'not_found'), r(409, 'version_conflict'), r(410), r(413), r(422)]) expect(refusedForGood(x)).toBe(true)
    for (const x of [r(401), r(401, 'not_authenticated'), r(403, 'not_authenticated'), r(408), r(425), r(429, 'rate_limited'), r(500), r(503), r(0), r(200)]) expect(refusedForGood(x)).toBe(false)
    expect(credentialRefused(r(401))).toBe(true); expect(credentialRefused(r(403, 'not_authenticated'))).toBe(true)
    expect(credentialRefused(r(403, 'not_authorized'))).toBe(false); expect(credentialRefused(r(403))).toBe(false)
  })
})

describe('1.58.32: an answer that names the Call it answers is no Call of this agent\'s', () => {
  test('refs.call (a string or a number of digits) is the Call answered; anything else names none', () => {
    expect(answeredCall({ call: '541' })).toBe('541'); expect(answeredCall({ call: 485 })).toBe('485')
    expect(answeredCall({ thread: 't', call: ' 616 ' })).toBe('616')
    for (const v of [undefined, null, {}, [], { call: '' }, { call: 'x1' }, { call: null }, { thread: 'lab-relay#t-1' }, 'call']) expect(answeredCall(v)).toBeNull()
  })
})

describe('1.58.32: a roamer records nothing into the spool', () => {
  test('ROAMER_MODE=1: recording off whatever ONSEN_RECORD / ONSEN_AGENTS say; nothing appended; the spool an older version left is kept', async () => {
    expect(isRoamerEnv({ ROAMER_MODE: '1' })).toBe(true); expect(isRoamerEnv({})).toBe(false); expect(isRoamerEnv({ ROAMER_MODE: '0' })).toBe(false)
    expect(recordFor({ ROAMER_MODE: '1' }, 'roamer-space-roamers')).toBe(false)
    expect(recordFor({ ROAMER_MODE: '1', ONSEN_RECORD: '1', ONSEN_AGENTS: '*' }, 'x')).toBe(false)
    expect(recordFor({}, 'chiron')).toBe(true)
    expect(recordFor({ ROAMER_MODE: '0' }, 'chiron')).toBe(true)
    // a roamer's client (record from recordFor): every record kind is dropped, the spool file never grows, no sync loop runs
    const dir = mkdtempSync(join(tmpdir(), 'onsen-roamer-'))
    const c = new OnsenClient({ dir, base: BASE, agent: 'roamer-space-roamers', record: recordFor({ ROAMER_MODE: '1' }, 'roamer-space-roamers'), credential: () => null,
      log: () => {}, intervalMs: 3_600_000 })
    c.start()
    c.recordEvent({ idem_key: 'e1', agent: 'r', client: 'telegram', chat: '1', target_client_msg_id: '1', kind: 'reaction', actor: 'main', at: new Date().toISOString() })
    expect(c.recordItemReport(report)).toBe(false)
    expect(await c.drawLine({ chat: '1', clientMsgId: 5, by: 'tg:1' })).toBeNull()
    expect(existsSync(join(dir, 'spool.jsonl'))).toBe(false)
    expect((c.health() as any).recorded).toBe(0)
    c.stop()
  })
})
