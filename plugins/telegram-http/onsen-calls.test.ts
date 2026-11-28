// telegram-http 1.58.8 (board WO-175 一, Chiron; his 02:58Z ruling; Onsen contract v1 §4, §9): the moments of the Calls an agent receives, sent as
// PUT /v1/calls/<id>/state through the spool. Here: the rules (CallFacts), which items are Calls (lanes.ts callRefOf: the call id the pulled item
// carries, Onsen 0.24.1), and the spool (onsen-client.ts: in order, a refused step not retried, Onsen down retried).
import { describe, expect, test } from 'bun:test'
import { CALL_LEDGER_RESULT, CallFacts } from './onsen-status.ts'
import { type CallRef, type CallStateLine } from './onsen-client.ts'
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
    for (const k of ['peer_call', 'scheduled', 'alert', 'board'] as const) expect(L.callRefOf(ev({ item_kind: k, call_id: '344' }))).toEqual({ kind: k, id: '344' })
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
