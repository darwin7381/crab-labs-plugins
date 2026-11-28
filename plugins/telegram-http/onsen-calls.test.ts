// telegram-http 1.58.8 (board WO-175 一, Chiron; his 02:58Z ruling; Onsen contract v1 §4, §9): the moments of the Calls an agent receives, sent as
// PUT /v1/calls/<id>/state through the spool. Here: the rules (CallFacts), which items are Calls (lanes.ts callRefOf: the call id the pulled item
// carries, Onsen 0.24.1), and the spool (onsen-client.ts: in order, a refused step not retried, Onsen down retried).
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CALL_LEDGER_RESULT, CallFacts } from './onsen-status.ts'
import { OnsenClient, callStateOn, type CallRef, type CallStateLine } from './onsen-client.ts'
const L = await import('./lanes.ts?onsen-calls-test') as typeof import('./lanes.ts')

const PEER: CallRef = { kind: 'peer_call', id: '344' }
const SCHED: CallRef = { kind: 'scheduled', id: '350' }
function facts(t = { ms: Date.parse('2026-11-26T04:00:00.000Z') }) {
  const out: CallStateLine[] = []
  const f = new CallFacts({ sink: l => out.push(l), now: () => t.ms })
  const states = () => out.map(l => `${l.event}:${l.body.state}:${l.body.session_id ?? '-'}${l.body.result ? `:${JSON.stringify(l.body.result)}` : ''}`)
  return { f, out, states, t }
}

describe('CallFacts: the moments, only forward', () => {
  test('C2 checks the current mode even for a scheduled end queued before activation', async () => {
    const lines: CallStateLine[] = [], takeMode = { active: false }
    const waits: string[] = []
    const f = new CallFacts({ takeMode, sink: line => lines.push(line), client: {
      callFate: async idem => { waits.push(idem); return { fate: 'took', state: 'completed' } },
      findRunCall: async () => ({ none: true }), getCall: async () => null,
    } })
    f.ended('prior-receipt', SCHED, 'main', 'completed', undefined, { outcome: 'ok' })
    f.running('old', SCHED, 'main')
    f.completeLater('old', SCHED, 'main', new Date().toISOString())
    takeMode.active = true
    expect(await f.receipt('prior-receipt', SCHED, 'main', 'completed', { outcome: 'ok' })).toMatchObject({ ok: false, fate: 'over' })
    expect(waits).toEqual([])
    f.flushLater()
    f.routed('new', PEER, 'lane')
    f.running('new', PEER, 'lane')
    f.handedOver('new', PEER)
    f.putBack('new', PEER, 'main')
    f.ended('new', PEER, 'main', 'completed')
    f.completeLater('take-late', SCHED, 'main', new Date().toISOString())
    takeMode.active = false
    f.flushLater()
    expect(lines.map(l => [l.event, l.body.state])).toEqual([['prior-receipt', 'completed'], ['old', 'accepted'], ['old', 'running']])
    f.routed('pull-again', PEER, 'main')
    expect(lines.at(-1)).toMatchObject({ event: 'pull-again', body: { state: 'accepted' } })
  })

  test('a lane: routed → accepted (its full id), its run → running, its end → completed with its summary; nothing twice', () => {
    const { f, states } = facts()
    f.routed('mesh-9001', PEER, 'lab-relay.reflex.25')
    f.running('mesh-9001', PEER, 'lab-relay.reflex.25')
    f.running('mesh-9001', PEER, 'lab-relay.reflex.25')                        // a second look: nothing
    f.routed('mesh-9001', PEER, 'lab-relay.reflex.25')                         // behind: nothing (Onsen would read accepted after running as a put-back)
    f.ended('mesh-9001', PEER, 'lab-relay.reflex.25', 'completed', undefined, { text: '17 × 23 = 391，已回 sonn' })
    f.ended('mesh-9001', PEER, 'lab-relay.reflex.25', 'failed')               // after the end: nothing
    expect(states()).toEqual(['mesh-9001:accepted:lab-relay.reflex.25', 'mesh-9001:running:lab-relay.reflex.25',
      'mesh-9001:completed:lab-relay.reflex.25:{"body":{"format":"markdown","text":"17 × 23 = 391，已回 sonn"}}'])
  })
  test('recorded only (no session): accepted with no session and completed at once, 「只記錄，沒有交給任何一條 session」', () => {
    const { f, out } = facts()
    f.routed('mesh-77', PEER, null)
    expect(out.map(l => l.body)).toEqual([{ state: 'accepted', session_id: null, at: '2026-11-26T04:00:00.000Z' },
      { state: 'completed', session_id: null, result: { body: { format: 'markdown', text: CALL_LEDGER_RESULT } }, at: '2026-11-26T04:00:00.000Z' }])
    expect(CALL_LEDGER_RESULT).toBe('只記錄，沒有交給任何一條 session')
  })
  test('the main: bound → running; its Stop → completed only when the record shows the turn over; the turn going on takes it back', () => {
    const { f, states, t } = facts()
    f.routed('mesh-1', PEER, 'main'); f.running('mesh-1', PEER, 'main')
    f.completeLater('mesh-1', PEER, 'main', '2026-11-26T04:00:01.000Z')
    f.statusRecord('busy')                                                      // a Stop hook sent the turn back: still running
    expect(states()).toEqual(['mesh-1:accepted:main', 'mesh-1:running:main'])
    f.cancelLater('mesh-1')                                                     // bound again: turn_continued
    t.ms += 5000
    f.completeLater('mesh-1', PEER, 'main', '2026-11-26T04:00:06.000Z')
    f.statusRecord('idle')
    expect(states().at(-1)).toBe('mesh-1:completed:main')
    expect(f.pendingLater()).toBe(0)
  })
  test('put back after it was in a turn (Esc, the item held for the next delivery): accepted again, the one step back; before running: nothing', () => {
    const { f, states } = facts()
    f.routed('mesh-2', PEER, 'main')
    f.putBack('mesh-2', PEER, 'main')                                           // never ran: nothing
    f.running('mesh-2', PEER, 'main')
    f.putBack('mesh-2', PEER, 'main')
    f.running('mesh-2', PEER, 'main')
    expect(states()).toEqual(['mesh-2:accepted:main', 'mesh-2:running:main', 'mesh-2:accepted:main', 'mesh-2:running:main'])
  })
  test('handed to the main while a lane ran it (Onsen 0.25.1: the daemon is the one writer): accepted, session main, once; the main\'s turn reports running', () => {
    const { f, states, out } = facts()
    f.routed('mesh-h', PEER, 'x.reflex.3'); f.running('mesh-h', PEER, 'x.reflex.3')
    f.handedOver('mesh-h', PEER)
    expect(states()).toEqual(['mesh-h:accepted:x.reflex.3', 'mesh-h:running:x.reflex.3', 'mesh-h:accepted:main'])
    expect(out.at(-1)!.idem).toMatch(/^call:mesh-h:accepted:hand:/)
    f.handedOver('mesh-h', PEER)                                                 // the event row written again: nothing more
    f.running('mesh-h', PEER, 'main')
    f.handedOver('mesh-h', PEER)                                                 // the main's own: nothing changes
    f.running('mesh-h', PEER, 'main')
    f.ended('mesh-h', PEER, 'main', 'completed')
    expect(states()).toEqual(['mesh-h:accepted:x.reflex.3', 'mesh-h:running:x.reflex.3', 'mesh-h:accepted:main', 'mesh-h:running:main', 'mesh-h:completed:main'])
    const g = facts()                                                            // handed before its run started: from the lane's accepted
    g.f.routed('mesh-h2', PEER, 'x.reflex.4'); g.f.handedOver('mesh-h2', PEER)
    expect(g.states()).toEqual(['mesh-h2:accepted:x.reflex.4', 'mesh-h2:accepted:main'])
    const n = facts(); n.f.handedOver('mesh-h3', PEER)                            // nothing sent for it before: nothing to hand over
    expect(n.states()).toEqual([])
  })
  test('a scheduled run: outcome and body; a completed Call with no result takes one once more (a late receipt); failed takes none', () => {
    const { f, out } = facts()
    f.ended('mesh-s1', SCHED, 'main', 'completed')
    f.ended('mesh-s1', SCHED, 'main', 'completed', undefined, { outcome: 'nothing_to_do', text: '磁碟 41%，沒事' })
    f.ended('mesh-s1', SCHED, 'main', 'completed', undefined, { outcome: 'ok', text: 'again' })   // filled already: nothing
    expect(out.map(l => l.body.result ?? null)).toEqual([null, { outcome: 'nothing_to_do', body: { format: 'markdown', text: '磁碟 41%，沒事' } }])
    f.ended('mesh-s2', SCHED, 'x.reflex.1', 'failed', undefined, { outcome: 'ok', text: 'x' })
    expect(out.at(-1)!.body).toEqual({ state: 'failed', session_id: 'x.reflex.1', at: '2026-11-26T04:00:00.000Z' })
  })
  test('the line carries the Call the item named; a session in a turn with it was handed it first (accepted, then running); a new prompt flushes what waited', () => {
    const { f, out } = facts()
    f.routed('mesh-3', { kind: 'board', id: '336' }, 'main')
    expect(out[0]).toMatchObject({ call_id: '336', kind: 'board', event: 'mesh-3' })
    f.running('mesh-4', SCHED, 'x.reflex.2')                                     // a lane's run starts inside the routing step: accepted comes with it
    expect(out.slice(-2).map(l => `${l.body.state}:${l.body.session_id}`)).toEqual(['accepted:x.reflex.2', 'running:x.reflex.2'])
    f.routed('mesh-4', SCHED, 'x.reflex.2')                                      // the router's record of it, after: nothing
    f.completeLater('mesh-4', SCHED, 'main', '2026-11-26T04:00:02.000Z')
    f.flushLater()
    expect(out.at(-1)).toMatchObject({ call_id: '350', body: { state: 'completed', session_id: 'main', at: '2026-11-26T04:00:02.000Z' } })
  })
})

describe('which items are Calls (callRefOf): the four kinds, by the call id the pulled item carries', () => {
  const ev = (o: Record<string, unknown>) => ({ id: 'mesh-x', source: 'mesh', from: 'chiron', text: 't', meta: {}, notif: { method: '', params: {} }, ...o }) as any
  test('a peer call, a scheduled run, a paged alert, an urgent board item: the id it carries', () => {
    for (const k of ['peer_call', 'scheduled', 'alert', 'board']) expect(L.callRefOf(ev({ item_kind: k, call_id: '344' }))).toEqual({ kind: k, id: '344' })
  })
  test('nothing to report: no call id (before its Call exists), a reply, a daemon\'s silent notice, a watchdog wake line, a mail, Joey, a synthetic run', () => {
    expect(L.callRefOf(ev({ item_kind: 'peer_call', btcc_msg_id: '1' }))).toBeNull()
    expect(L.callRefOf(ev({ item_kind: 'peer_call', call_id: 'x1' }))).toBeNull()
    expect(L.callRefOf(ev({ item_kind: 'peer_call', call_id: '1', reply_to_id: '9001' }))).toBeNull()
    expect(L.callRefOf(ev({ item_kind: 'peer_call', call_id: '1', urgency: 'silent' }))).toBeNull()
    expect(L.callRefOf(ev({ item_kind: 'peer_call', call_id: '1', wake: 'keepwarm' }))).toBeNull()
    expect(L.callRefOf(ev({ item_kind: 'peer_mail', call_id: '1' }))).toBeNull()
    expect(L.callRefOf(ev({ source: 'telegram', item_kind: 'peer_call', call_id: '1' }))).toBeNull()
    expect(L.callRefOf(ev({ item_kind: 'peer_call', call_id: '1', synthetic: '[x]' }))).toBeNull()
  })
  test('ONSEN_CALL_STATE: on unless 0 / off; a list names agents', () => {
    expect(callStateOn({}, 'adam')).toBe(true)
    expect(callStateOn({ ONSEN_CALL_STATE: '0' }, 'adam')).toBe(false)
    expect(callStateOn({ ONSEN_CALL_STATE: 'lab-relay,chiron' }, 'adam')).toBe(false)
    expect(callStateOn({ ONSEN_CALL_STATE: 'lab-relay,chiron' }, 'chiron')).toBe(true)
    expect(callStateOn({ ONSEN_CALL_STATE: '*' }, 'adam')).toBe(true)
  })
})

describe('the spool: PUT /v1/calls/<id>/state', () => {
  const CRED = 'mesh_CALLSTESTsecret'
  function onsen(o: { put?: (id: string, body: any) => { status: number; json: any } } = {}) {
    const log: Array<{ m: string; path: string; body: any }> = []
    const f = (async (u: any, init?: any) => {
      const url = new URL(String(u)), path = url.pathname.replace(/^\/api\/onsen/, '') + url.search
      const body = init?.body ? JSON.parse(init.body) : null
      log.push({ m: init?.method ?? 'GET', path, body })
      const json = (s: number, j: unknown) => new Response(JSON.stringify(j), { status: s, headers: { 'content-type': 'application/json' } })
      if (init?.headers?.Authorization !== `Bearer ${CRED}`) return json(401, {})
      const m = /\/v1\/calls\/(\d+)\/state$/.exec(url.pathname)
      if (init.method === 'PUT' && m) { const r = o.put?.(m[1]!, body); return json(r?.status ?? 200, r?.json ?? { data: { id: m[1], state: body.state } }) }
      return json(404, {})
    }) as typeof fetch
    return { f, log }
  }
  const client = (f: typeof fetch, logs: string[] = []) => new OnsenClient({ dir: mkdtempSync(join(tmpdir(), 'onsen-calls-')), base: 'https://onsen.test/api/onsen', agent: 'lab-relay',
    record: true, credential: () => CRED, log: (l, m) => logs.push(`${l} ${m}`), fetch: f, intervalMs: 3_600_000 })
  const line = (o: Partial<CallStateLine> & { state: CallStateLine['body']['state']; at?: string }): CallStateLine => ({ call_id: o.call_id ?? '1', kind: o.kind ?? 'peer_call',
    event: o.event ?? 'mesh-9001', idem: 'i', body: { state: o.state, session_id: o.body?.session_id ?? 'main', at: o.at ?? new Date().toISOString() } })
  test('by its id: PUT with the body Onsen takes (state, session_id, result, at), in order', async () => {
    const o = onsen(), c = client(o.f)
    c.recordCall(line({ call_id: '344', state: 'accepted' })); c.recordCall(line({ call_id: '344', state: 'running' }))
    await c.syncNow(true)
    expect(o.log.map(x => `${x.m} ${x.path} ${x.body?.state ?? ''}`)).toEqual(['PUT /v1/calls/344/state accepted', 'PUT /v1/calls/344/state running'])
    expect(Object.keys(o.log[0]!.body).sort()).toEqual(['at', 'session_id', 'state'])
    expect(c.pendingBytes()).toBe(0)
  })
  test('a step Onsen refuses (400: past it, or the Call over) is not retried and holds nothing behind it; Onsen down (5xx) is retried', async () => {
    let put = (id: string, b: any) => ({ status: 400, json: { error: { code: 'invalid_request', message: '呼叫現在是 completed，不能改成 running' } } })
    const o = onsen({ put: (id, b) => put(id, b) }), logs: string[] = [], c = client(o.f, logs)
    c.recordCall(line({ call_id: '9', state: 'running' }))
    c.recordCall(line({ call_id: '10', state: 'accepted', event: 'mesh-other' }))
    await c.syncNow(true)
    expect(o.log.filter(x => x.m === 'PUT').map(x => x.path)).toEqual(['/v1/calls/9/state', '/v1/calls/10/state'])
    const rej = readFileSync(join(c.cfg.dir, 'rejected.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x))
    expect(rej.map(r => r.why)).toEqual([expect.stringMatching(/^PUT \/v1\/calls\/9\/state running: HTTP 400 呼叫現在是 completed/),
      expect.stringMatching(/^PUT \/v1\/calls\/10\/state accepted: HTTP 400/)])
    put = () => ({ status: 503, json: {} })
    c.recordCall(line({ call_id: '12', state: 'running' }))
    await c.syncNow(true)
    expect(c.pendingBytes()).toBeGreaterThan(0)                                    // kept for the next pass
    put = (id, b) => ({ status: 200, json: { data: { id, state: b.state } } })
    await c.syncNow(true)
    expect(c.pendingBytes()).toBe(0)
  })
})

// Chiron's WO-175 ruling of 05:55Z: a receipt goes to Onsen only. Onsen not answering or 5xx: the first try and three more, all within 10 s, then
// not recorded; a refused step: Onsen's sentence (recorded when the Call is already there: a resend); no credential: a broken setup; only a run
// Onsen has no Call for goes to BTCC (lanes-wo175.test.ts). Here the client's half (what Onsen said to a spooled line; a run's Call) and CallFacts.receipt.
describe('a receipt goes to Onsen only (Chiron 05:55Z): what Onsen said to the line, a run\'s Call', () => {
  const CRED = 'mesh_CALLSTESTsecret'
  function onsen(o: { put?: (id: string, body: any) => { status: number; json?: any }; list?: (q: URLSearchParams) => { status: number; json?: any }
    one?: (id: string) => { status: number; json?: any } } = {}) {
    const log: Array<{ m: string; path: string; body: any; at: number }> = []
    const t0 = Date.now()
    const f = (async (u: any, init?: any) => {
      const url = new URL(String(u)), path = url.pathname.replace(/^\/api\/onsen/, '') + url.search
      const body = init?.body ? JSON.parse(init.body) : null
      log.push({ m: init?.method ?? 'GET', path, body, at: Date.now() - t0 })
      const json = (s: number, j: unknown) => new Response(JSON.stringify(j ?? {}), { status: s, headers: { 'content-type': 'application/json' } })
      if (init?.headers?.Authorization !== `Bearer ${CRED}`) return json(401, {})
      const m = /\/v1\/calls\/(\d+)\/state$/.exec(url.pathname)
      if (init?.method === 'PUT' && m) { const r = o.put?.(m[1]!, body); return json(r?.status ?? 200, r?.json ?? { data: { id: m[1], state: body.state } }) }
      if ((init?.method ?? 'GET') === 'GET' && url.pathname.endsWith('/v1/calls')) { const r = o.list?.(url.searchParams) ?? { status: 200, json: { items: [], next_cursor: null } }; return json(r.status, r.json) }
      const one = /\/v1\/calls\/(\d+)$/.exec(url.pathname)
      if ((init?.method ?? 'GET') === 'GET' && one) { const r = o.one?.(one[1]!) ?? { status: 404 }; return json(r.status, r.json) }
      return json(404, {})
    }) as typeof fetch
    return { f, log }
  }
  const client = (f: typeof fetch, cred: string | null = CRED) => new OnsenClient({ dir: mkdtempSync(join(tmpdir(), 'onsen-calls-r-')), base: 'https://onsen.test/api/onsen',
    agent: 'lab-relay', record: true, credential: () => cred, log: () => {}, fetch: f, intervalMs: 3_600_000 })
  const said = { error: { code: 'invalid_transition', message: '呼叫已經是 failed，不能改成 completed' } }
  test('a take result survives an unavailable run lookup and replays after restart without a progress write', async () => {
    let available = false
    const o = onsen({ list: () => available ? { status: 200, json: { items: [{ id: '350' }] } } : { status: 503 } })
    const c = client(o.f)
    const body = { result: { outcome: 'failed', steps: [{ step: 'Verify snapshot', done: false }],
      body: { format: 'markdown' as const, text: 'No checksum.' } } }
    // An older daemon left this on disk before it could look up the scheduler's Call.
    writeFileSync(c.spool, JSON.stringify({ k: 'c', r: { run_id: '762', call_id: null, event: 'schedule', idem: 'call:run:762:result', body } }) + '\n')
    await c.syncNow(true)
    expect(c.pendingBytes()).toBeGreaterThan(0)
    expect(o.log.filter(r => r.m === 'PUT')).toHaveLength(0)

    available = true
    const restarted = new OnsenClient(c.cfg)
    await restarted.syncNow(true)
    await restarted.syncNow(true)
    expect(o.log.filter(r => r.m === 'PUT').map(r => [r.path, r.body])).toEqual([['/v1/calls/350/state',
      { result: { outcome: 'failed', body: { format: 'markdown', text: 'No checksum.\n\n- [ ] Verify snapshot' } } }]])
    expect(restarted.pendingBytes()).toBe(0)
  })

  test('took: the PUT answered 2xx (Onsen\'s state); refused: a 4xx with Onsen\'s sentence; a fate is kept for a line asked about again', async () => {
    let put = (id: string, b: any) => ({ status: 200, json: { data: { id, state: b.state } } }) as { status: number; json: any }
    const o = onsen({ put: (id, b) => put(id, b) }), c = client(o.f)
    c.recordCall({ call_id: '350', kind: 'scheduled', event: 'e1', idem: 'k1', body: { state: 'completed', session_id: 'x.reflex.1', at: new Date().toISOString() } })
    expect(await c.callFate('k1')).toEqual({ fate: 'took', state: 'completed' })
    expect(await c.callFate('k1')).toEqual({ fate: 'took', state: 'completed' })
    put = () => ({ status: 400, json: said })
    c.recordCall({ call_id: '351', kind: 'scheduled', event: 'e2', idem: 'k2', body: { state: 'completed', session_id: 'main', at: new Date().toISOString() } })
    expect(await c.callFate('k2')).toEqual({ fate: 'refused', status: 400, said: '呼叫已經是 failed，不能改成 completed' })
    expect(o.log.filter(x => x.m === 'PUT')).toHaveLength(2)                        // a refused step is not tried again
  })
  test('Onsen answering 503: the first try and three more within 10 s, whatever the spool\'s backoff; then pending, the line still in the spool', async () => {
    const o = onsen({ put: () => ({ status: 503, json: {} }) }), c = client(o.f)
    c.start()
    c.recordCall({ call_id: '352', kind: 'scheduled', event: 'e3', idem: 'k3', body: { state: 'completed', session_id: 'main', at: new Date().toISOString() } })
    const t0 = Date.now(), f = await c.callFate('k3')
    c.stop()
    expect(f).toEqual({ fate: 'pending', why: expect.stringContaining('HTTP 503') })
    expect(Date.now() - t0).toBeLessThan(10_500)
    const puts = o.log.filter(x => x.m === 'PUT')
    expect(puts.length).toBe(4)
    expect(puts.at(-1)!.at).toBeLessThan(10_000)
    expect(c.pendingBytes()).toBeGreaterThan(0)
  }, 20_000)
  test('no mesh credential: nocred at once, nothing sent', async () => {
    const o = onsen(), c = client(o.f, null)
    c.recordCall({ call_id: '353', kind: 'scheduled', event: 'e4', idem: 'k4', body: { state: 'completed', session_id: 'main', at: new Date().toISOString() } })
    expect((await c.callFate('k4')).fate).toBe('nocred')
    expect((await c.findRunCall('7')).fate).toBe('nocred')
    expect(await c.checkWaitingCall('353', 'wall')).toBe('wait')
    expect(o.log).toEqual([])
  })
  test('getCall returns the Call for a receipt and null on a 404', async () => {
    const data = { state: 'completed', result: { outcome: 'ok' }, thread_id: '9', conversation_id: '2', caller: 'scheduler' }
    const o = onsen({ one: id => id === '350' ? { status: 200, json: { data } } : { status: 404 } }), c = client(o.f)
    expect(await c.getCall('350')).toEqual(data)
    expect(await c.getCall('351')).toBeNull()
  })
  test('a final Call with just its state closes a threadless wait', async () => {
    const o = onsen({ one: () => ({ status: 200, json: { state: 'completed' } }) })
    expect(await client(o.f).checkWaitingCall('350', 'offline')).toEqual({ final: 'completed' })
    expect(o.log.map(r => `${r.m} ${r.path}`)).toEqual(['GET /v1/calls/350'])
  })
  test.each([408, 429, 503])('a delayed Call still waits on HTTP %i and opens when the GET recovers', async status => {
    let recovered = false
    const o = onsen({ one: () => recovered ? { status: 200, json: { state: 'running' } } : { status } }), c = client(o.f)
    expect(await c.checkWaitingCall('350', 'restart')).toBe('wait')
    recovered = true
    expect(await c.checkWaitingCall('350', 'restart')).toBe('open')
  })
  test('a run\'s Call: found, none, a refused lookup, and Onsen not answering (tried again within the wait)', async () => {
    let list = (q: URLSearchParams) => ({ status: 200, json: { items: q.get('ref_value') === '7221' ? [{ id: 374, state: 'running', result: null }] : [], next_cursor: null } }) as any
    const o = onsen({ list: q => list(q) }), c = client(o.f)
    expect(await c.findRunCall('7221')).toEqual({ found: { id: '374', state: 'running', result: null } })
    expect(o.log[0]!.path).toBe('/v1/calls?ref_kind=run&ref_value=7221&limit=5')
    expect(await c.findRunCall('7222')).toEqual({ none: true })
    list = () => ({ status: 403, json: { error: { code: 'forbidden', message: 'not your call' } } })
    expect(await c.findRunCall('7223')).toEqual({ fate: 'refused', status: 403, said: 'not your call' })
    list = () => ({ status: 502, json: {} })
    o.log.length = 0
    expect(await c.findRunCall('7224', 1_500)).toEqual({ fate: 'pending', why: expect.stringContaining('HTTP 502') })
    expect(o.log.map(x => x.at >= 900)).toEqual([false, true])                      // the first try and one more inside 1.5 s
  })
})

describe('CallFacts.receipt: a scheduled run\'s receipt as its Call\'s end, and what Onsen said to it', () => {
  type Fate = import('./onsen-client.ts').CallLineFate
  function rig() {
    const out: CallStateLine[] = [], fates = new Map<string, Fate>()
    let next: Fate = { fate: 'took', state: 'completed' }, now: { state: string | null; result: unknown } | null = null
    const f = new CallFacts({ sink: l => out.push(l), client: { callFate: async idem => fates.get(idem) ?? (fates.set(idem, next), next),
      findRunCall: async () => ({ none: true }), getCall: async () => now } })
    return { f, out, set: (x: Fate) => { next = x }, onsenHas: (x: typeof now) => { now = x }, fates }
  }
  const RES = { outcome: 'ok', text: '磁碟 41%' }
  test('taken: recorded; the same receipt again: recorded (a resend), no second line', async () => {
    const r = rig()
    r.f.running('ev1', SCHED, 'x.reflex.1')
    expect(await r.f.receipt('ev1', SCHED, 'x.reflex.1', 'completed', RES)).toEqual({ ok: true, state: 'completed' })
    expect(await r.f.receipt('ev1', SCHED, 'x.reflex.1', 'completed', RES)).toEqual({ ok: true, state: 'completed', resend: true })
    expect(r.out.filter(l => l.body.state === 'completed')).toHaveLength(1)
  })
  test('refused: recorded when Onsen has the Call where the receipt puts it (a resend), else Onsen\'s sentence and the Call\'s state', async () => {
    const r = rig()
    r.set({ fate: 'refused', status: 409, said: 'result already set' }); r.onsenHas({ state: 'completed', result: { outcome: 'ok' } })
    expect(await r.f.receipt('ev2', SCHED, 'main', 'completed', RES)).toEqual({ ok: true, state: 'completed', resend: true })
    const q = rig()
    q.set({ fate: 'refused', status: 400, said: '呼叫已經是 failed' }); q.onsenHas({ state: 'failed', result: null })
    expect(await q.f.receipt('ev3', SCHED, 'main', 'completed', RES)).toEqual({ ok: false, fate: 'refused', why: 'Onsen refused it (HTTP 400): 呼叫已經是 failed; the Call is failed' })
  })
  test('pending (Onsen not answering): not recorded; filed again once the spool has sent it: recorded, still one line', async () => {
    const r = rig()
    r.set({ fate: 'pending', why: '/v1/calls/350/state answered HTTP 503' })
    expect(await r.f.receipt('ev4', SCHED, 'main', 'completed', RES)).toEqual({ ok: false, fate: 'pending', why: '/v1/calls/350/state answered HTTP 503' })
    const idem = r.out.at(-1)!.idem
    r.fates.set(idem, { fate: 'took', state: 'completed' })                         // the spool sent it later
    expect(await r.f.receipt('ev4', SCHED, 'main', 'completed', RES)).toEqual({ ok: true, state: 'completed', resend: true })
    expect(r.out).toHaveLength(1)
  })
  test('no credential: nocred; a receipt after the Call ended otherwise (failed here): over, nothing sent', async () => {
    const r = rig()
    r.set({ fate: 'nocred', why: 'no mesh credential' })
    expect(await r.f.receipt('ev5', SCHED, 'main', 'completed', RES)).toMatchObject({ ok: false, fate: 'nocred' })
    const q = rig()
    q.f.ended('ev6', SCHED, 'x.reflex.2', 'failed')
    const n = q.out.length
    expect(await q.f.receipt('ev6', SCHED, 'x.reflex.2', 'completed', RES)).toMatchObject({ ok: false, fate: 'over' })
    expect(q.out.length).toBe(n)
  })
})
