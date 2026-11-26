// telegram-http 1.58.8 (board WO-175 一, Chiron; his 02:58Z ruling; Onsen contract v1 §4, §9): the moments of the Calls an agent receives, sent as
// PUT /v1/calls/<id>/state through the spool. Here: the rules (CallFacts), which items are Calls (lanes.ts callRefOf: the call id the pulled item
// carries, Onsen 0.24.1), and the spool (onsen-client.ts: in order, a refused step not retried, Onsen down retried).
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
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
  test('handed to the main while a lane ran it: nothing sent then; the main\'s turn reports running (Onsen made it accepted, recipient main, from the lane\'s exit row)', () => {
    const { f, states } = facts()
    f.routed('mesh-h', PEER, 'x.reflex.3'); f.running('mesh-h', PEER, 'x.reflex.3')
    f.handedOver('mesh-h')
    expect(states()).toEqual(['mesh-h:accepted:x.reflex.3', 'mesh-h:running:x.reflex.3'])
    f.running('mesh-h', PEER, 'main')
    f.handedOver('mesh-h')                                                       // the main's own: nothing changes
    f.running('mesh-h', PEER, 'main')
    expect(states()).toEqual(['mesh-h:accepted:x.reflex.3', 'mesh-h:running:x.reflex.3', 'mesh-h:running:main'])
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
