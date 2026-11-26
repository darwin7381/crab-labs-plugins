// telegram-http 1.58.32 (Chiron, Joey: one refused record never blocks the queue). Production: a Call state the daemon wrote for a Call its agent made
// (PUT /v1/calls/541/state, Onsen 403 not_authorized: only the recipient writes it) was retried forever (403 was in RETRYABLE_4XX); the cursor stood
// 5½ h on chiron's daemon (calls 541/546/573/580/590/598/616 behind it) and everything after it (delivery facts, reactions, status) waited.
// Here, against the stand-in Onsen (real HTTP, fleet-core put_state's answers):
//   a 403 for one record: skipped in the same pass (rejected.jsonl, one log line, /healthz onsen.skipped), the facts behind it posted
//   chiron's spool: seven caller-state Calls, three moments each, between facts: every fact posted in one pass, 21 skipped; a recipient's Call still PUT
//   401 (the credential itself) and a 403 that says not_authenticated: kept and tried again, nothing thrown away; flushed once the credential is taken
//   which statuses are refused for good
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startOnsenStandin } from './test-fixtures/onsen-standin.ts'
import { OnsenClient, credentialRefused, refusedForGood, type CallStateLine, type DeliveryFact } from './onsen-client.ts'

const CRED = 'mesh_SKIPchironSECRETsecretSECRET01234', SONN = 'mesh_SKIPsonnSECRETsecretSECRET0123456'
const on = startOnsenStandin({ [CRED]: 'chiron', [SONN]: 'sonn' })
afterAll(() => on.stop())
const BASE = `http://127.0.0.1:${on.port}/api/onsen`
function client(o: { cred?: () => string | null; fetch?: typeof fetch } = {}) {
  const logs: string[] = []
  const dir = mkdtempSync(join(tmpdir(), 'onsen-skip-'))
  const c = new OnsenClient({ dir, base: BASE, agent: 'chiron', record: true, credential: o.cred ?? (() => CRED), log: (l, m) => logs.push(`${l} ${m}`),
    intervalMs: 3_600_000, ...(o.fetch ? { fetch: o.fetch } : {}) })
  return { c, logs, dir }
}
const call = (id: string, state: CallStateLine['body']['state']): CallStateLine => ({ call_id: id, kind: 'peer_call', event: `mesh-${id}`, idem: `call:mesh-${id}:${state}`,
  body: { state, session_id: 'chiron.reflex.1', at: new Date().toISOString() } })
let n = 0
const fact = (state: DeliveryFact['state'] = 'delivered'): DeliveryFact => {
  n++
  return { idem_key: `tg:chiron:1828:dlv:${n}:${state}`, agent: 'chiron', client: 'telegram', chat: '1828', client_msg_id: String(n), state, at: new Date().toISOString() }
}
const postedFacts = (from: number) => on.seen.slice(from).filter(s => s.path === '/deliveries/batch').flatMap(s => (s.body?.items ?? []).map((x: any) => x.idem_key))
const puts = (from: number) => on.seen.slice(from).filter(s => s.method === 'PUT' && /^\/v1\/calls\/\d+\/state$/.test(s.path)).map(s => `${s.path.split('/')[3]}:${s.body?.state}`)

describe('1.58.32: a record Onsen refuses never holds the spool', () => {
  test('a Call state Onsen answers 403 (this agent was its caller): skipped in the same pass; the delivery facts behind it are posted', async () => {
    on.calls['541'] = 'sonn'                                                     // sonn is the recipient: chiron made Call 541
    const { c, logs, dir } = client(), from = on.seen.length
    const f1 = fact(), f2 = fact('in_session'), f3 = fact('seen')
    c.recordCall(call('541', 'accepted')); c.recordDelivery(f1); c.recordDelivery(f2); c.recordCall(call('541', 'running')); c.recordDelivery(f3)
    const t0 = Date.now()
    await c.syncNow(true)
    expect(Date.now() - t0).toBeLessThan(3_000)
    expect(c.pendingBytes()).toBe(0)
    expect(postedFacts(from)).toEqual([f1.idem_key, f2.idem_key, f3.idem_key])
    expect(puts(from)).toEqual(['541:accepted', '541:running'])                  // each tried once, never again
    const h = c.health() as any
    expect(h.rejected).toBe(2)
    expect(h.skipped.count).toBe(2)
    expect(h.skipped.last).toMatchObject({ kind: 'c', path: '/v1/calls/541/state', status: 403, code: 'not_authorized', key: 'call:mesh-541:running' })
    expect(h.last_error).toBeNull()
    const rej = readFileSync(join(dir, 'rejected.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(rej.map(r => r.why)).toEqual([expect.stringMatching(/^PUT \/v1\/calls\/541\/state accepted: HTTP 403 只有收件人 sonn/),
      expect.stringMatching(/^PUT \/v1\/calls\/541\/state running: HTTP 403/)])
    expect(logs.filter(l => l.includes('rejected call:mesh-541:')).length).toBe(2)   // one line per record
    expect(logs.join('\n')).not.toContain('the credential was not accepted')
    await c.syncNow(true)
    expect(puts(from).length).toBe(2)
  })

  test('chiron\'s spool (calls 541/546/573/580/590/598/616, all caller state, three moments each, between facts): all facts in one pass, 21 skipped; a Call of his own is still PUT', async () => {
    const theirs = ['541', '546', '573', '580', '590', '598', '616']
    for (const id of theirs) on.calls[id] = 'sonn'
    on.calls['620'] = 'chiron'                                                   // a Call chiron received: his to write
    const { c } = client(), from = on.seen.length, facts: string[] = []
    for (const id of theirs) for (const st of ['accepted', 'running', 'completed'] as const) { c.recordCall(call(id, st)); const f = fact(); facts.push(f.idem_key); c.recordDelivery(f) }
    c.recordCall(call('620', 'accepted')); c.recordCall(call('620', 'running'))
    const last = fact('turn_end'); facts.push(last.idem_key); c.recordDelivery(last)
    const t0 = Date.now()
    await c.syncNow(true)
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(c.pendingBytes()).toBe(0)
    expect(postedFacts(from)).toEqual(facts)
    const h = c.health() as any
    expect(h.skipped.count).toBe(21); expect(h.rejected).toBe(21)
    expect(h.calls_put).toBe(2)
    expect(puts(from).filter(x => x.startsWith('620:'))).toEqual(['620:accepted', '620:running'])
    expect(await c.callFate('call:mesh-541:completed', 200)).toEqual({ fate: 'refused', status: 403, said: '只有收件人 sonn 的常駐程式能回報這一通的狀態' })
  })

  test('a Call Onsen does not have (404): skipped too', async () => {
    on.calls['700'] = 'chiron'
    const { c } = client(), from = on.seen.length
    c.recordCall(call('99999', 'accepted'))
    const f = fact(); c.recordDelivery(f)
    await c.syncNow(true)
    expect(c.pendingBytes()).toBe(0)
    expect(postedFacts(from)).toEqual([f.idem_key])
    expect((c.health() as any).skipped.last).toMatchObject({ kind: 'c', status: 404, code: 'not_found' })
  })

  test('401 (the credential itself) is kept and tried again, nothing skipped; flushed once the credential is taken', async () => {
    let cred = 'mesh_SKIPunknownSECRETsecretSECRET0000'
    const { c, logs, dir } = client({ cred: () => cred }), from = on.seen.length
    on.calls['701'] = 'chiron'
    const f = fact(); c.recordCall(call('701', 'accepted')); c.recordDelivery(f)
    await c.syncNow(true)
    expect(c.pendingBytes()).toBeGreaterThan(0)
    const h = c.health() as any
    expect(h.rejected).toBe(0); expect(h.skipped.count).toBe(0)
    expect(h.last_error).toContain('HTTP 401')
    expect(logs.join('\n')).toContain('answered 401: the credential was not accepted')
    expect(existsSync(join(dir, 'rejected.jsonl'))).toBe(false)
    await c.syncNow(true)                                                         // still 401: still kept
    expect(c.pendingBytes()).toBeGreaterThan(0)
    cred = CRED                                                                   // a rotated credential now taken
    await c.syncNow(true)
    expect(c.pendingBytes()).toBe(0)
    expect(postedFacts(from)).toEqual([f.idem_key])
    expect(puts(from).at(-1)).toBe('701:accepted')
  })

  test('a 403 whose code says not_authenticated is the credential: kept and tried again', async () => {
    let deny = true
    const f0 = fetch
    const wrapped = (async (u: any, init?: any) => deny
      ? new Response(JSON.stringify({ error: { code: 'not_authenticated', message: 'credential revoked', retryable: true } }), { status: 403, headers: { 'content-type': 'application/json' } })
      : f0(u, init)) as typeof fetch
    const { c, dir } = client({ fetch: wrapped }), from = on.seen.length
    const f = fact(); c.recordDelivery(f)
    await c.syncNow(true)
    expect(c.pendingBytes()).toBeGreaterThan(0)
    expect((c.health() as any).skipped.count).toBe(0)
    expect(existsSync(join(dir, 'rejected.jsonl'))).toBe(false)
    deny = false
    await c.syncNow(true)
    expect(c.pendingBytes()).toBe(0)
    expect(postedFacts(from)).toEqual([f.idem_key])
  })

  test('refused for good: every 4xx but the credential (401, 403 not_authenticated), a timeout (408), too early (425), too fast (429)', () => {
    const r = (status: number, code?: string) => ({ status, json: code ? { error: { code, message: 'x' } } : { detail: 'x' } })
    for (const x of [r(400), r(403), r(403, 'not_authorized'), r(404), r(404, 'not_found'), r(409, 'version_conflict'), r(410), r(413), r(422)]) expect(refusedForGood(x)).toBe(true)
    for (const x of [r(401), r(401, 'not_authenticated'), r(403, 'not_authenticated'), r(408), r(425), r(429, 'rate_limited'), r(500), r(503), r(0), r(200)]) expect(refusedForGood(x)).toBe(false)
    expect(credentialRefused(r(401))).toBe(true); expect(credentialRefused(r(403, 'not_authenticated'))).toBe(true)
    expect(credentialRefused(r(403, 'not_authorized'))).toBe(false); expect(credentialRefused(r(403))).toBe(false)
  })
})
