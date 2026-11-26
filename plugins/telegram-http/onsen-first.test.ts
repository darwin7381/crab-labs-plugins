// WO-192: an agent's reply written into Onsen first (A), then Telegram, then its delivery reported (B), against a stand-in for Onsen (a fake fetch or
// request; nothing reaches core.kbro.ai or Telegram).
//   the switch (ONSEN_FIRST), the version gate (GET /v1/meta ≥ 0.31.0), A's tries (1 s, 3 s, 10 s; a 4xx at once; files refused → once without them),
//   the steps in order, B sent with every id in order, Telegram failing → held (resent from the part that failed, B once at the end, a 429's
//   retry_after), a timeout never resent (B failed), giving up (B failed, which part), the spool's B line (k 'r': posted in order, 409 settled).
import { test, expect, describe } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OnsenClient } from './onsen-client.ts'
import { firstOn, versionAtLeast, idemPre, OnsenVersion, FirstSender, NOT_TAKEN, retryAfterS, HeldInOnsen, MIN_ONSEN, type FirstItem, type Report, type Step } from './onsen-first.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const item = (o: Partial<FirstItem> = {}): FirstItem => ({ idem_key: idemPre('adam', '1828'), agent: 'adam', client: 'telegram', chat: '1828', direction: 'out',
  sender: 'main', body: '一句話', kind: 'rich', sent_at: new Date().toISOString(), status: 'ok', backfilled: false, delivery: { client: 'telegram', state: 'pending' }, ...o })
class Timeout extends Error {}
/** a stand-in Onsen for A: answers in turn (a status, or a thrown network error); records every body */
function onsenA(answers: Array<number | 'down'>, id = 4242) {
  const bodies: any[] = []
  let n = 0
  const request = async (m: string, p: string, b?: unknown) => {
    bodies.push({ m, p, b })
    const a = answers[Math.min(n++, answers.length - 1)]!
    if (a === 'down') throw new TypeError('fetch failed: ECONNREFUSED')
    return a < 300 ? { status: a, json: { id, duplicate: n > 1 } } : { status: a, json: { detail: `said ${a}` } }
  }
  return { request: request as any, bodies }
}
function sender(request: any, o: { resendMs?: number[]; retryMs?: number[] } = {}) {
  const reports: Array<{ id: number; r: Report }> = [], logs: string[] = []
  const s = new FirstSender({ request, log: (l, m) => logs.push(`${l} ${m}`), report: (id, r) => reports.push({ id, r }), isTimeout: e => e instanceof Timeout || (e as any)?.cause instanceof Timeout,   // as server.ts: a part's wrapper carries it as its cause
    retryMs: o.retryMs ?? [10, 20, 30], resendMs: o.resendMs ?? [20, 20, 20] })
  return { s, reports, logs }
}
/** Telegram stand-in steps: each gives the next id; `fail(i, n)` makes step i fail on its n-th try (an Error or what it returns) */
function steps(n: number, fail: (i: number, tryN: number) => unknown = () => null, first = 7001) {
  const tries = new Array(n).fill(0), sent: number[] = []
  let next = first
  const list: Step[] = Array.from({ length: n }, (_, i) => ({ what: `第 ${i + 1} 段（共 ${n} 段）`, run: async () => {
    tries[i]++
    const f = fail(i, tries[i])
    if (f) throw f
    sent.push(next); return next++
  } }))
  return { list, tries, sent }
}

describe('the switch and the version', () => {
  test('ONSEN_FIRST: off by default; a list or *', () => {
    for (const v of [undefined, '', ' ', '0', 'off', 'OFF', 'false', 'no']) expect(firstOn(v, 'adam')).toBe(false)
    expect(firstOn('*', 'adam')).toBe(true)
    expect(firstOn('chiron, adam', 'adam')).toBe(true)
    expect(firstOn('chiron', 'adam')).toBe(false)
  })
  test('version ≥ 0.31.0', () => {
    expect(MIN_ONSEN).toBe('0.31.0')
    for (const v of ['0.31.0', '0.31.1', '0.33.0', '1.0.0', '0.31.0-rc1', 'v0.32']) expect(versionAtLeast(v, MIN_ONSEN)).toBe(true)
    for (const v of ['0.30.9', '0.29.4', '0.3.10', '', 'unknown']) expect(versionAtLeast(v, MIN_ONSEN)).toBe(false)
  })
  test('GET /v1/meta: ok from 0.31.0; no answer keeps what was known; an older Onsen turns it off', async () => {
    const answers: any[] = [{ status: 200, json: { api_version: 1, data: { server_version: '0.31.0', commit: '88c130b' } } }, 'down',
      { status: 200, json: { data: { server_version: '0.30.2' } } }]
    let n = 0
    const paths: string[] = [], logs: string[] = []
    const v = new OnsenVersion({ request: async (m, p) => { paths.push(`${m} ${p}`); const a = answers[n++]; if (a === 'down') throw new Error('ECONNREFUSED'); return a }, log: (l, m) => logs.push(m) })
    expect(v.ok).toBe(false)
    expect(await v.ensure(1000)).toBe(true)
    expect(paths).toEqual(['GET /v1/meta'])
    await v.check()
    expect([v.ok, v.version]).toEqual([true, '0.31.0'])             // no answer: kept
    await v.check()
    expect([v.ok, v.version]).toEqual([false, '0.30.2'])
    expect(logs.filter(l => l.includes('older than 0.31.0')).length).toBe(1)
  })
  test('no answer at all: not ok (the old path)', async () => {
    let asked = 0
    const v = new OnsenVersion({ request: async () => { asked++; return null }, log: () => {} })
    expect(await v.ensure(500)).toBe(false)
    expect(await v.ensure(500)).toBe(false)
    expect(asked).toBe(1)                                           // a reply does not wait on an Onsen that just did not answer
  })
})

describe('A: written first', () => {
  test('taken at once: the item as given (delivery pending, no client_msg_id)', async () => {
    const a = onsenA([200]); const { s } = sender(a.request)
    const it = item()
    expect(await s.write(it)).toEqual({ id: 4242 })
    expect(a.bodies).toEqual([{ m: 'POST', p: '/messages', b: it }])
    expect(it.idem_key).toMatch(/^tg:adam:1828:out:pre:[0-9a-f-]{36}$/)
    expect('client_msg_id' in it).toBe(false)
  })
  test('500 / down: tried again after each wait; the same idem_key; taken on the 4th', async () => {
    const a = onsenA([500, 'down', 503, 200]); const { s } = sender(a.request)
    expect(await s.write(item())).toEqual({ id: 4242 })
    expect(a.bodies.length).toBe(4)
    expect(new Set(a.bodies.map(x => x.b.idem_key)).size).toBe(1)
    expect(s.stats.write_retries).toBe(3)
  })
  test('never taken: 4 tries, then the error', async () => {
    const a = onsenA([500]); const { s } = sender(a.request)
    expect(await s.write(item())).toEqual({ error: 'POST /messages answered HTTP 500 (said 500)' })
    expect(a.bodies.length).toBe(4)
  })
  test('the waits are 1 s, 3 s, 10 s by default', async () => {
    const { WRITE_RETRY_MS, RESEND_MS } = await import('./onsen-first.ts')
    expect(WRITE_RETRY_MS).toEqual([1000, 3000, 10000])
    expect(RESEND_MS).toEqual([10000, 30000, 120000])
  })
  test('a 400: not tried again', async () => {
    const a = onsenA([400]); const { s } = sender(a.request)
    expect(await s.write(item())).toEqual({ error: 'POST /messages answered HTTP 400 (said 400)' })
    expect(a.bodies.length).toBe(1)
  })
  test('refused with its files: once more without them (their names instead), at once', async () => {
    const a = onsenA([400, 200]); const { s, logs } = sender(a.request)
    const it = item({ attachment_file_ids: ['901'] }), bare = item({ idem_key: it.idem_key, attachments: [{ name: 'a.png', mime: 'image/png', size: 9 }] })
    expect(await s.write(it, bare)).toEqual({ id: 4242 })
    expect(a.bodies.map(x => x.b)).toEqual([it, bare])
    expect(s.stats.written_without_files).toBe(1)
    expect(logs.some(l => l.includes('refused it with its files'))).toBe(true)
  })
  test('no credential: an error at once', async () => {
    const { s } = sender(async () => null)
    expect(await s.write(item())).toEqual({ error: 'no mesh credential' })
  })
})

describe('the send: A, Telegram, B', () => {
  test('all parts go: B sent with every Telegram id in order; nothing sent before A answered', async () => {
    const order: string[] = []
    const a = onsenA([200]); const { s, reports } = sender(async (...x: any[]) => { order.push('A'); return a.request(...x) })
    const st = steps(3)
    for (const x of st.list) { const run = x.run; x.run = async () => { order.push('tg'); return run() } }
    const r = await s.send({ item: item(), steps: st.list })
    expect(r).toEqual({ ids: [7001, 7002, 7003] })
    expect(order).toEqual(['A', 'tg', 'tg', 'tg'])
    expect(reports.length).toBe(1)
    expect(reports[0]!.id).toBe(4242)
    expect(reports[0]!.r).toMatchObject({ client: 'telegram', state: 'sent', client_msg_ids: ['7001', '7002', '7003'] })
    expect(Date.parse(reports[0]!.r.at)).toBeGreaterThan(0)
    expect(reports[0]!.r.error).toBeUndefined()
  })
  test('Onsen never takes it: the send fails with 「Onsen 沒收下，這一則沒有送出」, Telegram untouched, no B', async () => {
    const { s, reports } = sender(onsenA([500]).request)
    const st = steps(2)
    await expect(s.send({ item: item(), steps: st.list })).rejects.toThrow(NOT_TAKEN)
    expect(st.tries).toEqual([0, 0])
    expect(reports).toEqual([])
  })
  test('Telegram fails at part 2 of 3: held (said), resent from part 2, B sent once at the end with all three ids, late gets them', async () => {
    const { s, reports, logs } = sender(onsenA([200]).request)
    const st = steps(3, (i, n) => i === 1 && n <= 2 ? new Error("Call to 'sendMessage' failed! (502: Bad Gateway)") : null)
    let late: number[] | null = null
    const r = await s.send({ item: item(), steps: st.list, late: ids => { late = ids } })
    expect('held' in r).toBe(true)
    if (!('held' in r)) return
    expect(r.held).toBe("已寫進 Onsen（網頁看得到）；Telegram 還沒送到：第 2 段（共 3 段）（前 1 則已送到）：Call to 'sendMessage' failed! (502: Bad Gateway)，會再送")
    expect([r.onsenId, r.ids]).toEqual([4242, [7001]])
    expect(reports).toEqual([])                                     // not yet: once, at the end
    expect(await until(() => reports.length > 0, 2000)).toBe(true)
    expect(st.tries).toEqual([1, 3, 1])                             // part 1 never twice
    expect(reports.length).toBe(1)
    expect(reports[0]!.r).toMatchObject({ state: 'sent', client_msg_ids: ['7001', '7002', '7003'] })
    expect(late).toEqual([7001, 7002, 7003])
    expect(s.stats).toMatchObject({ held: 1, resent: 1, gave_up: 0 })
    expect(logs.some(l => l.includes('sent again: Telegram has all 3'))).toBe(true)
  })
  test('Telegram never recovers: B failed once, naming the part, with the ids that went', async () => {
    const { s, reports } = sender(onsenA([200]).request)
    const st = steps(2, i => i === 1 ? new Error('Network request for \'sendDocument\' failed! bot123456:SECRET-token/sendDocument') : null)
    const r = await s.send({ item: item(), steps: st.list })
    expect('held' in r).toBe(true)
    expect(await until(() => reports.length > 0, 2000)).toBe(true)
    await sleep(50)
    expect(reports.length).toBe(1)
    expect(reports[0]!.r.state).toBe('failed')
    expect(reports[0]!.r.client_msg_ids).toEqual(['7001'])
    expect(reports[0]!.r.error).toContain('第 2 段（共 2 段）')
    expect(reports[0]!.r.error).toContain('bot<token>')
    expect(reports[0]!.r.error).not.toContain('SECRET')
    expect(st.tries).toEqual([1, 4])                                // the first try and three resends
    expect(s.stats.gave_up).toBe(1)
  })
  test('a Telegram timeout (it may have arrived): never sent again, B failed at once, the sentence says so', async () => {
    const { s, reports } = sender(onsenA([200]).request)
    const st = steps(1, () => new Error('reply failed after 0 of 1 chunk(s) sent: …', { cause: new Timeout('sendRichMessage: no answer from Telegram within 30 s') }))
    const r = await s.send({ item: item(), steps: st.list })
    expect('held' in r && r.held).toBe('已寫進 Onsen（網頁看得到）；Telegram 沒有回應：第 1 段（共 1 段）：sendRichMessage: no answer from Telegram within 30 s；可能已經送到，不會再送（先看 Telegram 再決定要不要再說一次）')
    expect(reports.length).toBe(1)
    expect(reports[0]!.r).toMatchObject({ state: 'failed', client_msg_ids: [] })
    await sleep(100)
    expect(st.tries).toEqual([1])
  })
  test('429: the resend waits its retry_after at least', async () => {
    const { s, reports } = sender(onsenA([200]).request, { resendMs: [10, 10, 10] })
    const at: number[] = []
    const st = steps(1, (_, n) => { at.push(Date.now()); return n === 1 ? Object.assign(new Error("Call to 'sendMessage' failed! (429: Too Many Requests: retry after 1)"), { parameters: { retry_after: 1 } }) : null })
    await s.send({ item: item(), steps: st.list })
    expect(await until(() => reports.length > 0, 3000)).toBe(true)
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(950)
    expect(reports[0]!.r.state).toBe('sent')
  })
  test('retry_after is read from the cause and from the words', () => {
    expect(retryAfterS(new Error('x', { cause: Object.assign(new Error('y'), { parameters: { retry_after: 7 } }) }))).toBe(7)
    expect(retryAfterS(new Error('sendRichMessage: 429 Too Many Requests: retry after 12'))).toBe(12)
    expect(retryAfterS(new Error('502'))).toBe(0)
  })
  test('HeldInOnsen carries the sentence and says it is held', () => {
    const e = new HeldInOnsen('已寫進 Onsen…', 9, [1])
    expect([e.message, (e as any).heldInOnsen, e.onsenId]).toEqual(['已寫進 Onsen…', true, 9])
  })
})

async function until(fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (fn()) return true; await sleep(10) }
  return false
}

describe('B through the spool (k r)', () => {
  function fake(answer: (path: string, body: any) => { status: number; json: any } | 'down') {
    const calls: Array<{ path: string; body: any }> = []
    const f = (async (input: any, init?: any) => {
      const path = new URL(String(input)).pathname.replace(/^\/api\/onsen/, '')
      const body = init?.body ? JSON.parse(init.body) : undefined
      calls.push({ path, body })
      const a = answer(path, body)
      if (a === 'down') throw new TypeError('fetch failed')
      return new Response(JSON.stringify(a.json), { status: a.status, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return { f, calls }
  }
  const mk = (f: typeof fetch, logs: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'onsen-first-'))
    return { dir, c: new OnsenClient({ dir, base: 'https://onsen.test/api/onsen', agent: 'adam', record: true, credential: () => 'mesh_x', log: (l, m) => logs.push(`${l} ${m}`), fetch: f, intervalMs: 3_600_000 }) }
  }
  const body = (state: 'sent' | 'failed', ids: string[], error?: string) => ({ client: 'telegram' as const, state, client_msg_ids: ids, at: '2026-11-26T11:00:00.000Z', ...(error ? { error } : {}) })
  test('posted to /messages/<id>/delivery, in order behind the lines before it', async () => {
    const logs: string[] = []
    const { f, calls } = fake(p => p === '/messages/batch' ? { status: 200, json: { results: [{ id: 1, duplicate: false }] } } : { status: 200, json: { id: 4242, state: 'sent', duplicate: false, aliases: ['7001'] } })
    const { c } = mk(f, logs)
    c.recordMessage({ idem_key: 'tg:adam:1828:in:1', agent: 'adam', client: 'telegram', chat: '1828', direction: 'in', sender: 'tg:1828', body: 'hi', kind: 'text', sent_at: '2026-11-26T11:00:00Z', status: 'ok' })
    expect(c.recordDeliveryReport(4242, body('sent', ['7001', '7002']))).toBe(true)
    c.recordEvent({ idem_key: 'e1', agent: 'adam', client: 'telegram', chat: '1828', target_client_msg_id: '7001', kind: 'edit', actor: 'main', body: 'x', at: '2026-11-26T11:00:01Z' })
    await c.syncNow(true)
    expect(calls.map(x => x.path)).toEqual(['/messages/batch', '/messages/4242/delivery', '/events'])
    expect(calls[1]!.body).toEqual(body('sent', ['7001', '7002']))
    expect(c.pendingBytes()).toBe(0)
    expect(c.stats.delivery_reported).toBe(1)
  })
  test('Onsen down: kept, sent once it answers; 409 (already delivered): settled, not rejected; 400: rejected', async () => {
    const logs: string[] = []
    let mode: 'down' | 'ok' = 'down'
    const { f, calls } = fake((p, b) => mode === 'down' ? 'down' : b.state === 'failed' && p.includes('/4243/') ? { status: 409, json: { detail: 'message 4243 was already delivered' } }
      : p.includes('/4244/') ? { status: 400, json: { detail: 'client: telegram' } } : { status: 200, json: { id: 1, duplicate: false } })
    const { c, dir } = mk(f, logs)
    c.recordDeliveryReport(4242, body('sent', ['1']))
    c.recordDeliveryReport(4243, body('failed', [], 'x'))
    c.recordDeliveryReport(4244, body('sent', ['2']))
    await c.syncNow(true)
    expect(c.pendingBytes()).toBeGreaterThan(0)
    mode = 'ok'
    await c.syncNow(true)
    expect(c.pendingBytes()).toBe(0)
    expect(calls.filter(x => x.path === '/messages/4242/delivery').length).toBe(2)
    expect(c.stats).toMatchObject({ delivery_reported: 1, delivery_conflicts: 1, rejected: 1 })
    expect(logs.some(l => l.includes('Onsen message 4243: Onsen answered 409') && l.includes('taken as delivered'))).toBe(true)
    expect(readFileSync(join(dir, 'rejected.jsonl'), 'utf8')).toContain('/messages/4244/delivery: HTTP 400')
  })
})
