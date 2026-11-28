// WO-180: the observation sender's rules (onsen-observation.ts), with a stand-in put. A change goes at once; reported_at alone is no change; unchanged,
// one every heartbeat with the record computed again; one request in flight and the newest after it (nothing between, nothing queued); a 400 is counted
// and written once per message, the same observation not sent again; a put that fails or hangs never throws and never holds the slot; the switch off
// sends nothing. Every observation used here passes Chiron's status_v1_check.py port.
import { describe, expect, test } from 'bun:test'
import { ObservationPut, changeKey, HEARTBEAT_MS, TIMEOUT_MS, type PutAnswer } from './onsen-observation.ts'
import type { Observation } from './screen-status.ts'
import { checkObservation } from './test-fixtures/status-v1-check.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const T0 = Date.parse('2026-11-26T05:00:00.000Z')
/** an observation of an idle main (or a running one with `tool`), reported at `ms` */
function obs(ms: number, tool: string | null = null): Observation {
  const at = new Date(T0).toISOString()
  return { presence: 'online', presence_reason: null, lifecycle: 'ready', main_session_id: 'main',
    sessions: [{ id: 'main', kind: 'main', thread_id: null, activity: tool ? 'running' : 'idle', activity_since: at,
      turn: tool ? { id: 'p1', started_at: at, trigger: { kind: 'message', conversation_id: '1828', message_id: '77' } } : null,
      doing: tool ? { kind: 'tool', tool, since: at } : null, blockers: [], last_turn: null }],
    background: { agents: 0, shells: 0, tasks: 0, monitors: 0 }, queue: { pending: 0, unread_by_member: 0 }, last_activity_at: at,
    reported_at: new Date(ms).toISOString(), evidence: { source: 'runtime', confidence: null } }
}
type Call = { body: Observation; timeoutMs: number; resolve: (a: PutAnswer) => void; reject: (e: unknown) => void }
/** a sender with a stand-in put whose answers the test gives (auto: answer 200 at once); counts the requests in flight at once */
function rig(o: { on?: () => boolean; auto?: PutAnswer | ((b: Observation) => PutAnswer) | null; heartbeatMs?: number; timeoutMs?: number; refresh?: (s: ObservationPut) => void; now?: () => number } = {}) {
  const calls: Call[] = [], exceptions: Array<Record<string, unknown>> = [], logs: string[] = []
  let inFlight = 0, maxInFlight = 0
  const ref: { s?: ObservationPut } = {}
  const s = new ObservationPut({ agent: 'adam', on: o.on ?? (() => true), now: o.now,
    put: (body, timeoutMs) => new Promise<PutAnswer>((resolve, reject) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
      let settled = false
      const done = (f: () => void) => { if (settled) return; settled = true; inFlight--; f() }
      calls.push({ body, timeoutMs, resolve: a => done(() => resolve(a)), reject: e => done(() => reject(e)) })
      if (o.auto !== undefined && o.auto !== null) { const a = typeof o.auto === 'function' ? o.auto(body) : o.auto; queueMicrotask(() => calls[calls.length - 1]!.resolve(a)) }
    }),
    ...(o.refresh ? { refresh: () => o.refresh!(ref.s!) } : {}),
    exception: l => exceptions.push(l), log: (_lv, m) => logs.push(m) }, { heartbeatMs: o.heartbeatMs ?? 60_000, timeoutMs: o.timeoutMs })
  ref.s = s
  return { s, calls, exceptions, logs, max: () => maxInFlight }
}
const OK: PutAnswer = { status: 200, json: { api_version: '1', data: { name: 'adam' } } }

describe('WO-180 the observation sender', () => {
  test('the defaults are the contract: a beat every 15 s, a 5 s timeout', () => {
    expect([HEARTBEAT_MS, TIMEOUT_MS]).toEqual([15_000, 5_000])
    expect(checkObservation(obs(T0))).toEqual([])
    expect(checkObservation(obs(T0, 'Bash'))).toEqual([])
  })

  test('the first one goes at once; a change goes at once; reported_at alone is no change', async () => {
    const r = rig({ auto: OK })
    r.s.update(obs(T0))
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]!.body).toEqual(obs(T0))                                 // the object handed in, unchanged
    expect(r.calls[0]!.timeoutMs).toBe(5_000)
    await sleep(5)
    r.s.update(obs(T0 + 2000)); r.s.update(obs(T0 + 4000))                   // the tick's records: nothing changed but reported_at
    expect(r.calls).toHaveLength(1)
    r.s.update(obs(T0 + 4100, 'Bash'))                                        // a tool started
    expect(r.calls).toHaveLength(2)
    expect(r.calls[1]!.body.sessions[0]!.doing).toMatchObject({ kind: 'tool', tool: 'Bash' })
    await sleep(5)
    r.s.update(obs(T0 + 4200))                                               // it ended
    expect(r.calls).toHaveLength(3)
    await sleep(5)
    expect(r.s.health()).toEqual({ on: true, sent: 3, rejected: 0, last_ok_at: expect.any(String), last_status: 200, last_error: null })
    expect(changeKey(obs(T0))).toBe(changeKey(obs(T0 + 99_000)))
    r.s.stop()
  })

  test('unchanged: one every heartbeat, the record computed again for it (refresh), its reported_at new; a change resets the beat', async () => {
    const at: number[] = []
    let n = 0
    const r = rig({ auto: OK, heartbeatMs: 120, refresh: s => s.update(obs(T0 + 1000 * ++n)) })
    const t0 = Date.now()
    r.s.update(obs(T0)); at.push(Date.now() - t0)
    while (r.calls.length < 4) { await sleep(5); if (r.calls.length > at.length) at.push(Date.now() - t0) }
    const gaps = at.slice(1).map((t, i) => t - at[i]!)
    for (const g of gaps) { expect(g).toBeGreaterThanOrEqual(115); expect(g).toBeLessThan(200) }
    expect(r.calls.map(c => c.body.reported_at)).toEqual([0, 1, 2, 3].map(k => new Date(T0 + 1000 * k).toISOString()))   // each one new
    // a change at 60 ms after a beat: it goes, and the next beat is 120 ms after it
    await sleep(60)
    const before = r.calls.length, tc = Date.now()
    r.s.update(obs(T0 + 50_000, 'Read'))
    expect(r.calls.length).toBe(before + 1)
    while (r.calls.length < before + 2) await sleep(3)
    expect(Date.now() - tc).toBeGreaterThanOrEqual(115)
    r.s.stop()
  })

  test('a beat with no fresh record (the compute loop stopped, no refresh) sends nothing: the next update sends at once', async () => {
    let now = T0
    const r = rig({ auto: OK, heartbeatMs: 60, now: () => now })
    r.s.update(obs(now))
    now += 200   // The record is already stale when the first real timer fires.
    await sleep(200)
    expect(r.calls).toHaveLength(1)                                           // the one held is 200 ms old: not reported as alive
    r.s.update(obs(now))                                                      // unchanged, but the beat is overdue
    expect(r.calls).toHaveLength(2)
    r.s.stop()
  })

  test('one in flight; changes meanwhile: when it comes back only the newest goes (nothing between, nothing queued); in flight never above 1', async () => {
    const r = rig({ heartbeatMs: 60_000 })
    r.s.update(obs(T0))
    expect(r.calls).toHaveLength(1)
    r.s.update(obs(T0 + 100, 'Bash')); r.s.update(obs(T0 + 200, 'Read')); r.s.update(obs(T0 + 300, 'Edit'))
    expect(r.calls).toHaveLength(1)                                           // the first is still out
    r.calls[0]!.resolve(OK); await sleep(1)
    expect(r.calls).toHaveLength(2)
    expect(r.calls[1]!.body.sessions[0]!.doing?.tool).toBe('Edit')            // the newest, not Bash or Read
    expect(r.calls[1]!.body.reported_at).toBe(new Date(T0 + 300).toISOString())
    r.calls[1]!.resolve(OK); await sleep(1)
    expect(r.calls).toHaveLength(2)                                           // nothing left over
    // changes that went back to what is out: nothing more after it returns
    r.s.update(obs(T0 + 400, 'Bash')); r.s.update(obs(T0 + 500, 'Edit')); r.s.update(obs(T0 + 600, 'Bash'))
    expect(r.calls).toHaveLength(3)
    r.calls[2]!.resolve(OK); await sleep(1)
    expect(r.calls).toHaveLength(3)
    r.s.update(obs(T0 + 700, 'Edit'))
    expect(r.calls).toHaveLength(4)
    r.calls[3]!.resolve(OK); await sleep(1)
    // a burst of 200 changes while one is out: still one at a time
    for (let i = 0; i < 200; i++) { r.s.update(obs(T0 + 1000 + i, i % 2 ? 'Bash' : 'Read')); if (i % 50 === 0 && r.calls.length) r.calls[r.calls.length - 1]!.resolve(OK); await sleep(0) }
    r.calls[r.calls.length - 1]!.resolve(OK); await sleep(1)
    expect(r.max()).toBe(1)
    expect(r.calls.length).toBeLessThan(15)
    r.s.stop()
  })

  test('a 400 invalid_request: counted, one exception line per message in a life, the same observation not sent again; the next change goes', async () => {
    const bad = (m: string): PutAnswer => ({ status: 400, json: { error: { code: 'invalid_request', message: m, retryable: false } } })
    let answer = bad('觀測不合法：sessions[0].turn.trigger.message_id：帶起這個回合的那一則')
    const r = rig({ auto: () => answer, heartbeatMs: 80 })
    r.s.update(obs(T0, 'Bash'))
    await sleep(5)
    expect(r.s.health()).toMatchObject({ sent: 1, rejected: 1, last_status: 400, last_ok_at: null, last_error: 'invalid_request: 觀測不合法：sessions[0].turn.trigger.message_id：帶起這個回合的那一則' })
    expect(r.exceptions).toEqual([{ ts: expect.any(String), agent: 'adam', kind: 'observation_rejected', kinds: ['observation_rejected'], status: 400,
      code: 'invalid_request', message: '觀測不合法：sessions[0].turn.trigger.message_id：帶起這個回合的那一則', observation: obs(T0, 'Bash') }])
    r.s.update(obs(T0 + 10, 'Bash')); await sleep(5)
    expect(r.calls).toHaveLength(1)                                           // not hammered again with the same one
    r.s.update(obs(T0 + 20, 'Read')); await sleep(5)                          // a change: sent, the same message: no second line
    expect(r.calls).toHaveLength(2)
    expect(r.exceptions).toHaveLength(1)
    await sleep(100); r.s.update(obs(T0 + 30, 'Read')); await sleep(5)        // the beat: sent again (the next one, as usual), still one line
    expect(r.calls).toHaveLength(3)
    expect(r.exceptions).toHaveLength(1)
    expect(r.s.health().rejected).toBe(3)
    answer = bad('觀測不合法：queue：pending、unread_by_member 是非負整數或 null')
    r.s.update(obs(T0 + 40, 'Edit')); await sleep(5)
    expect(r.exceptions.map(e => e.message)).toEqual(['觀測不合法：sessions[0].turn.trigger.message_id：帶起這個回合的那一則', '觀測不合法：queue：pending、unread_by_member 是非負整數或 null'])
    answer = OK
    r.s.update(obs(T0 + 50, 'Grep')); await sleep(5)
    expect(r.s.health()).toMatchObject({ sent: 5, rejected: 4, last_status: 200, last_error: null })
    expect(r.logs.filter(l => l.includes('observation rejected'))).toHaveLength(2)
    r.s.stop()
  })

  test('other failures: never thrown, recorded on /healthz, the next one goes at the next change or beat (no retry loop); no credential: nothing to send', async () => {
    let mode: 'throw' | 'timeout' | 'down' | 'nocred' | 'ok' = 'throw'
    const r = rig({ heartbeatMs: 60_000, auto: null })
    const answerLast = () => {
      const c = r.calls[r.calls.length - 1]!
      if (mode === 'throw') c.reject(new Error('connect ECONNREFUSED 127.0.0.1:9'))
      else if (mode === 'timeout') c.reject(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }))
      else if (mode === 'down') c.resolve({ status: 503, json: { error: { code: 'unavailable', message: 'db down', retryable: true } } })
      else if (mode === 'nocred') c.resolve(null)
      else c.resolve(OK)
    }
    r.s.update(obs(T0)); answerLast(); await sleep(1)
    expect(r.s.health()).toMatchObject({ sent: 1, last_status: null, last_error: 'connect ECONNREFUSED 127.0.0.1:9' })
    r.s.update(obs(T0 + 1)); await sleep(1)
    expect(r.calls).toHaveLength(1)                                           // the same one: not retried
    mode = 'timeout'; r.s.update(obs(T0 + 2, 'Bash')); answerLast(); await sleep(1)
    expect(r.s.health()).toMatchObject({ sent: 2, last_status: null, last_error: 'timeout' })
    mode = 'down'; r.s.update(obs(T0 + 3)); answerLast(); await sleep(1)
    expect(r.s.health()).toMatchObject({ sent: 3, rejected: 0, last_status: 503, last_error: 'unavailable: db down' })
    mode = 'nocred'; r.s.update(obs(T0 + 4, 'Read')); answerLast(); await sleep(1)
    expect(r.s.health()).toMatchObject({ sent: 4, last_status: null, last_error: 'no mesh credential' })
    mode = 'ok'; r.s.update(obs(T0 + 5)); answerLast(); await sleep(1)
    expect(r.s.health()).toMatchObject({ sent: 5, rejected: 0, last_status: 200, last_error: null })
    expect(r.exceptions).toEqual([])
    expect(r.max()).toBe(1)
    r.s.stop()
  })

  test('a put that ignores its timeout does not hold the slot: given up at timeout + 1 s, and the newest goes', async () => {
    const r = rig({ heartbeatMs: 60_000, timeoutMs: 50, auto: null })
    r.s.update(obs(T0))
    r.s.update(obs(T0 + 1, 'Bash'))
    expect(r.calls).toHaveLength(1)
    await sleep(1150)
    expect(r.calls).toHaveLength(2)
    expect(r.calls[1]!.body.sessions[0]!.doing?.tool).toBe('Bash')
    expect(r.s.health().last_error).toBe('timeout')
    r.calls[1]!.resolve(OK); r.calls[0]!.resolve(OK); await sleep(1)
    r.s.stop()
  })

  test('the switch off: nothing is sent at all (no request, no beat); on: the next one goes at once; off again: it stops', async () => {
    let on = false
    const r = rig({ on: () => on, auto: OK, heartbeatMs: 40, refresh: s => s.update(obs(Date.now())) })
    r.s.update(obs(T0)); r.s.update(obs(T0 + 1, 'Bash'))
    await sleep(120)
    expect(r.calls).toHaveLength(0)
    expect(r.s.health()).toEqual({ on: false, sent: 0, rejected: 0, last_ok_at: null, last_status: null, last_error: null })
    expect(r.logs).toEqual([])                                                // never on: not even a line
    on = true
    r.s.update(obs(T0 + 2, 'Bash'))
    expect(r.calls).toHaveLength(1)
    await sleep(100)
    expect(r.calls.length).toBeGreaterThanOrEqual(2)                          // the beat runs while on
    on = false
    r.s.update(obs(T0 + 3, 'Read'))
    const n = r.calls.length
    await sleep(150)
    expect(r.calls.length).toBe(n)                                            // off: no change sent, no beat
    expect(r.logs.some(l => l.includes('observation on for adam'))).toBe(true)
    expect(r.logs.some(l => l.includes('observation off for adam'))).toBe(true)
    on = true
    r.s.update(obs(T0 + 4, 'Read'))
    expect(r.calls.length).toBe(n + 1)                                        // on again: at once, even unchanged since the last one sent
    r.s.stop()
  })

  test('stop: no beat after it, nothing sent', async () => {
    const r = rig({ auto: OK, heartbeatMs: 30, refresh: s => s.update(obs(Date.now())) })
    r.s.update(obs(T0)); await sleep(5)
    r.s.stop()
    const n = r.calls.length
    await sleep(100)
    r.s.update(obs(T0 + 1, 'Bash'))
    expect(r.calls.length).toBe(n)
  })
})
