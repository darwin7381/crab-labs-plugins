// WO-172 (Chiron; Onsen contract v1 §2, §4; mapping A-4, B-3): three facts, no decision changed.
//   1 a message an agent sends carries the turn it was sent in (turn_id, a field of the message itself since 1.58.3 — Chiron WO-172 02:43Z: Onsen reads
//     the item's turn_id; 1.58.2 put it in meta: the main's prompt id, a lane's run id); the daemon's own notices none
//   2 turn_end carries outcome (done / interrupted / failed) and bound (Joey's client_msg_id, a colleague's msg id), computed once per turn: the same
//     value on every fact of the turn and on the observation's last_turn; seen and turn_end carry turn_id (Chiron WO-171 01:52Z). Fields of the fact
//     itself, as Onsen 0.16.0 reads them (delivery_events.turn_id / outcome / bound), not its detail
//   3 (the bot's photo as the Onsen avatar) was cancelled (Chiron 06:51Z, Joey: avatars regenerated with Codex, uploaded once by Chiron): removed in 1.58.16
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { DeliveryFacts, LanesTap, TurnWatch, runOutcome, type TurnEnded } from './onsen-status.ts'
import { outboundRecord, sendCtx, withPart, withSender } from './onsen-client.ts'

describe('1 turn_id on what is sent', () => {
  const pay = { chat_id: 1828, text: 'hi' }
  test('a message sent in a turn carries it as its own field (top level, not meta); one sent with none (a notice of the daemon\'s own) carries none; an edit or a reaction is no message', () => {
    const r = outboundRecord('adam', { sender: 'main', turn_id: 'p-1' }, 'sendMessage', pay, { message_id: 7, date: 1 }) as any
    expect(r.k).toBe('m'); expect(r.r.turn_id).toBe('p-1'); expect(r.r.meta).toBeUndefined()
    const lane = outboundRecord('adam', { sender: 'adam.reflex.3', turn_id: 'adam.reflex.3.r2', part: 1, parts: 2 }, 'sendRichMessage', { chat_id: 1828, rich_message: { markdown: 'x' } }, { message_id: 8 }) as any
    expect(lane.r.turn_id).toBe('adam.reflex.3.r2'); expect(lane.r.meta).toEqual({ part: 1, parts: 2 })
    for (const sender of ['system:status', 'router']) {
      const x = (outboundRecord('adam', { sender }, 'sendMessage', pay, { message_id: 9 }) as any).r
      expect(x.meta).toBeUndefined(); expect('turn_id' in x).toBe(false)
    }
    expect(JSON.stringify(outboundRecord('adam', { sender: 'main', turn_id: 'p-1' }, 'editMessageText', { chat_id: 1828, message_id: 7, text: 'y' }, true))).not.toContain('turn_id')
  })
  test('withSender keeps it for every part of one send', () => {
    const r = withSender('main', () => withPart(2, 3, () => outboundRecord('adam', sendCtx()!, 'sendMessage', pay, { message_id: 11 })), { turn_id: 'p-9' }) as any
    expect(r.r.turn_id).toBe('p-9'); expect(r.r.meta).toEqual({ part: 2, parts: 3 })
    expect(withSender('system:ack', () => sendCtx())).toEqual({ sender: 'system:ack' })
  })
})

describe('2 turn_end: outcome and bound, once per turn', () => {
  function rig() {
    let gen: any = { rec: 'main', id: 'g1', state: 'idle', pid: 7 }
    const sent: any[] = [], ended: TurnEnded[] = []
    const facts = new DeliveryFacts({ agent: 'adam', sink: f => sent.push(f) })
    const joey = (m: any) => m?.chat_id && m?.user === 'joey' ? { chat: String(m.chat_id), id: String(m.message_id) } : null
    const tap = new LanesTap({ facts, joey, gen: () => gen, changed: () => {}, turnEnded: t => ended.push(t) })
    const main = (state: string, prompt: string | null, ts: string, extra: Record<string, unknown> = {}) => {
      gen = { ...gen, state, prompt_id: prompt, ts }; tap.journal({ ...gen } as any, { state, ...(prompt ? { prompt_id: prompt } : {}), ...extra })
    }
    const item = (id: string, kind: 'joey' | 'peer', mid: string) => ({ rec: 'msg', id, kind, notif: { params: { meta: kind === 'joey' ? { chat_id: '1828', message_id: mid, user: 'joey' } : { user: 'eve', btcc_msg_id: mid } } } })
    const line = (row: any, state: string, f: Record<string, unknown> = {}) => tap.journal({ ...row, state, ...f, ts: '2026-11-26T02:00:00.000Z' } as any, { state, ...f })
    const turnEnds = () => sent.filter(f => f.state === 'turn_end')
    return { tap, facts, main, item, line, ended, turnEnds, facts0: () => sent, event: (b: any) => tap.mainEvent({ pid: 7, ...b }) }
  }
  test('a normal turn: done; bound = Joey\'s message and the colleague\'s item it took in; the same outcome on the fact, the callback and last_turn', () => {
    const r = rig()
    const j = r.item('m1', 'joey', '691'), p = r.item('m2', 'peer', '71001')
    r.line(j, 'offered'); r.line(j, 'bound', { prompt_id: 'p1' }); r.line(p, 'bound', { prompt_id: 'p1', via_pull: true })
    r.main('in_turn', 'p1', '2026-11-26T02:00:01.000Z')
    r.line(j, 'done', { prompt_id: 'p1' }); r.line(p, 'done', { prompt_id: 'p1' })
    r.main('idle', null, '2026-11-26T02:00:09.000Z')
    expect(r.turnEnds()).toHaveLength(0)                                    // the main's turn_end settles first (a Stop that was not the end)
    r.facts.flushLater()
    expect(r.turnEnds()).toEqual([expect.objectContaining({ client_msg_id: '691', by: 'main', turn_id: 'p1', outcome: 'done', bound: ['691', '71001'] })])
    expect(r.turnEnds()[0].detail).toBeUndefined()                         // Onsen reads them as the fact's own fields (0.16.0), not its detail
    expect(r.facts0().filter(f => f.state === 'seen')).toEqual([expect.objectContaining({ client_msg_id: '691', by: 'main', turn_id: 'p1' })])   // seen carries its turn too
    expect(r.ended).toEqual([{ session: 'main', turn_id: 'p1', outcome: 'done', bound: ['691', '71001'], ended_at: '2026-11-26T02:00:09.000Z', facts: 1 }])
    expect(r.tap.lastTurn()).toEqual({ id: 'p1', outcome: 'done', ended_at: '2026-11-26T02:00:09.000Z' })
  })
  test('Esc mid-turn: interrupted, at once (the cut message is held for the next turn); the M2 row the wrap-up writes says so for a turn with nothing bound', () => {
    const r = rig()
    const j = r.item('m3', 'joey', '692')
    r.line(j, 'bound', { prompt_id: 'p2' }); r.main('in_turn', 'p2', '2026-11-26T02:01:00.000Z')
    r.line(j, 'queued', { reason: 'interrupted', prompt_id: null, cut_at: 'x' })
    r.main('idle', null, '2026-11-26T02:01:05.000Z', { ended_by: 'interrupted' })
    expect(r.turnEnds()).toEqual([expect.objectContaining({ client_msg_id: '692', turn_id: 'p2', outcome: 'interrupted', bound: ['692'] })])
    expect(r.ended.at(-1)).toMatchObject({ turn_id: 'p2', outcome: 'interrupted', facts: 1 })
    expect(r.tap.lastTurn()).toMatchObject({ id: 'p2', outcome: 'interrupted' })
    r.main('in_turn', 'p3', '2026-11-26T02:02:00.000Z')
    r.main('idle', null, '2026-11-26T02:02:04.000Z', { ended_by: 'interrupted' })
    expect(r.ended.at(-1)).toEqual({ session: 'main', turn_id: 'p3', outcome: 'interrupted', bound: [], ended_at: '2026-11-26T02:02:04.000Z', facts: 0 })
  })
  test('StopFailure: failed (the item goes back to the queue, the main walled); the fact and last_turn agree', () => {
    const r = rig()
    const j = r.item('m4', 'joey', '693')
    r.line(j, 'bound', { prompt_id: 'p4' }); r.main('in_turn', 'p4', '2026-11-26T02:03:00.000Z')
    r.event({ event: 'StopFailure', error: 'rate_limit' })
    r.line(j, 'queued', { reason: 'stop_failure:rate_limit', prompt_id: null })
    r.main('walled', null, '2026-11-26T02:03:02.000Z')
    expect(r.turnEnds()).toEqual([expect.objectContaining({ client_msg_id: '693', turn_id: 'p4', outcome: 'failed', bound: ['693'] })])
    expect(r.tap.lastTurn()).toMatchObject({ id: 'p4', outcome: 'failed' })
    expect(r.ended.at(-1)).toMatchObject({ outcome: 'failed', bound: ['693'] })
  })
  test('a turn that went on after its Stop (another Stop hook held it) is decided at its real end: the Stop\'s done is taken back, last_turn stays on the turn before', () => {
    const r = rig()
    r.main('in_turn', 'p5', '2026-11-26T02:04:50.000Z'); r.main('idle', null, '2026-11-26T02:04:55.000Z')
    const j = r.item('m6', 'joey', '696')
    r.line(j, 'bound', { prompt_id: 'p6' }); r.main('in_turn', 'p6', '2026-11-26T02:05:00.000Z')
    r.line(j, 'done', { prompt_id: 'p6' }); r.main('idle', null, '2026-11-26T02:05:09.000Z')        // the Stop
    expect(r.tap.lastTurn()).toMatchObject({ id: 'p6', outcome: 'done' })
    r.main('in_turn', 'p6', '2026-11-26T02:05:12.000Z'); r.line(j, 'bound', { reason: 'turn_continued' })   // lanes-main continueTurn
    expect(r.tap.lastTurn()).toMatchObject({ id: 'p5', outcome: 'done' })
    r.event({ event: 'StopFailure', error: 'server_error' })
    r.line(j, 'queued', { reason: 'stop_failure:server_error', prompt_id: null }); r.main('idle', null, '2026-11-26T02:05:40.000Z')
    r.facts.flushLater()
    expect(r.turnEnds()).toEqual([expect.objectContaining({ client_msg_id: '696', turn_id: 'p6', outcome: 'failed', bound: ['696'] })])   // one fact, the real end's
    expect(r.ended.at(-1)).toEqual({ session: 'main', turn_id: 'p6', outcome: 'failed', bound: ['696'], ended_at: '2026-11-26T02:05:40.000Z', facts: 1 })
    expect(r.tap.lastTurn()).toEqual({ id: 'p6', outcome: 'failed', ended_at: '2026-11-26T02:05:40.000Z' })
  })
  test("a lane's run is its turn: a colleague's call alone gives no fact (Onsen takes delivery facts for Telegram messages only) but its turn ends with its msg id bound", () => {
    const r = rig()
    const call = { id: 'mesh-71005', source: 'mesh', from: 'eve', btcc_msg_id: '71005', meta: { user: 'eve' } }
    r.tap.journal({ rec: 'run', id: 'mesh-71005#a', run: 'adam.reflex.4.r1', lane: 'adam.reflex.4', ev: call, ts: '2026-11-26T02:04:00.000Z' } as any, { state: 'running' })
    r.tap.journal({ rec: 'run', id: 'mesh-71005#a', run: 'adam.reflex.4.r1', lane: 'adam.reflex.4', ev: call, reason: 'normal', ts: '2026-11-26T02:04:30.000Z' } as any, { state: 'exited' })
    expect(r.turnEnds()).toHaveLength(0)
    expect(r.ended.at(-1)).toEqual({ session: 'adam.reflex.4', turn_id: 'adam.reflex.4.r1', outcome: 'done', bound: ['71005'], ended_at: '2026-11-26T02:04:30.000Z', facts: 0 })
    // a run with Joey's message and a colleague's steered in: the fact carries both; died → failed
    const jm = { id: 'tg-1828-694', source: 'telegram', from: 'joey', meta: { chat_id: '1828', message_id: '694', user: 'joey' } }
    r.tap.journal({ rec: 'run', id: 'tg#b', run: 'adam.worker.1.r3', lane: 'adam.worker.1', ev: jm, steered: [call], ts: 't' } as any, { state: 'running' })
    r.tap.journal({ rec: 'run', id: 'tg#b', run: 'adam.worker.1.r3', lane: 'adam.worker.1', ev: jm, steered: [call], reason: 'died', ts: 't2' } as any, { state: 'exited' })
    expect(r.turnEnds().at(-1)).toMatchObject({ client_msg_id: '694', by: 'adam.worker.1', detail: { reason: 'died' }, turn_id: 'adam.worker.1.r3', outcome: 'failed', bound: ['694', '71005'] })
    expect(r.facts0().filter(f => f.state === 'seen').at(-1)).toMatchObject({ client_msg_id: '694', by: 'adam.worker.1', turn_id: 'adam.worker.1.r3' })
    expect(r.ended.at(-1)).toMatchObject({ turn_id: 'adam.worker.1.r3', outcome: 'failed', facts: 1 })
    expect([runOutcome('normal'), runOutcome('closed'), runOutcome('wall:rate_limit'), runOutcome('timeout'), runOutcome('cap_turns')]).toEqual(['done', 'interrupted', 'failed', 'failed', 'failed'])
  })
  test('lanes off: the transcript\'s turn ends done; bound = the Joey messages and the colleagues\' items it took in', () => {
    const sent: any[] = [], ended: TurnEnded[] = []
    const facts = new DeliveryFacts({ agent: 'adam', sink: f => sent.push(f) })
    const w = new TurnWatch({ dir: () => null, facts, joey: (m: any) => m?.chat_id ? { chat: String(m.chat_id), id: String(m.message_id) } : null, changed: () => {}, turnEnded: t => ended.push(t) })
    const tg = `<channel source="plugin:telegram-http:telegram-http" chat_id="1828" message_id="695" user="joey" user_id="1828" ts="x">\nhi\n</channel>`
    const mesh = `<channel source="plugin:agent-inbox:agent-inbox" user="eve" btcc_msg_id="71006" ts="x">\n在嗎\n</channel>`
    w.handle({ type: 'user', message: { role: 'user', content: `${tg}\n${mesh}` }, timestamp: '2026-11-26T02:05:00.000Z' })
    w.handle({ type: 'system', subtype: 'turn_duration', durationMs: 800, timestamp: '2026-11-26T02:05:04.000Z' })
    const tid = `turn-${Date.parse('2026-11-26T02:05:00.000Z')}`               // the observation's turn.id with lanes off
    expect(sent.filter(f => f.state === 'turn_end')).toEqual([expect.objectContaining({ client_msg_id: '695', turn_id: tid, outcome: 'done', bound: ['695', '71006'] })])
    expect(sent.filter(f => f.state === 'seen')).toEqual([expect.objectContaining({ client_msg_id: '695', turn_id: tid })])
    expect(ended).toEqual([expect.objectContaining({ session: 'main', outcome: 'done', bound: ['695', '71006'], facts: 1 })])
  })
})

describe('2b WO-177 (Chiron WO-172 02:43Z): a normal turn_end goes when the status record shows the turn over, no 60 s wait; a pushed-back turn sends nothing until its real end', () => {
  function rig() {
    let gen: any = { rec: 'main', id: 'g1', state: 'idle', pid: 7 }
    const sent: any[] = []
    const facts = new DeliveryFacts({ agent: 'adam', sink: f => sent.push(f) })
    const joey = (m: any) => m?.chat_id && m?.user === 'joey' ? { chat: String(m.chat_id), id: String(m.message_id) } : null
    const tap = new LanesTap({ facts, joey, gen: () => gen, changed: () => {} })
    const main = (state: string, prompt: string | null, ts: string, extra: Record<string, unknown> = {}) => {
      gen = { ...gen, state, prompt_id: prompt, ts }; tap.journal({ ...gen } as any, { state, ...(prompt ? { prompt_id: prompt } : {}), ...extra })
    }
    const item = (id: string, mid: string) => ({ rec: 'msg', id, kind: 'joey', notif: { params: { meta: { chat_id: '1828', message_id: mid, user: 'joey' } } } })
    const line = (row: any, state: string, f: Record<string, unknown> = {}) => tap.journal({ ...row, state, ...f, ts: '2026-11-26T03:00:00.000Z' } as any, { state, ...f })
    return { facts, main, item, line, turnEnds: () => sent.filter(f => f.state === 'turn_end') }
  }
  test('the normal case: Stop; while the record still says busy nothing is sent; the first record that shows the turn over (idle) sends it at once, done', async () => {
    const r = rig(), j = r.item('n1', '801')
    r.line(j, 'offered'); r.line(j, 'bound', { prompt_id: 'q1' }); r.main('in_turn', 'q1', '2026-11-26T03:00:01.000Z')
    r.line(j, 'done', { prompt_id: 'q1' }); r.main('idle', null, '2026-11-26T03:00:05.000Z', { stopped_prompt: 'q1' })
    r.facts.statusRecord('busy')                                            // the screen not judged again yet: the record still busy
    await new Promise(res => setTimeout(res, 50))
    expect(r.turnEnds()).toHaveLength(0)                                   // no timer sends it either
    expect(r.facts.pendingLater()).toBe(1)
    r.facts.statusRecord('idle')
    expect(r.turnEnds()).toEqual([expect.objectContaining({ client_msg_id: '801', turn_id: 'q1', outcome: 'done', bound: ['801'], at: '2026-11-26T03:00:00.000Z' })])
    r.facts.statusRecord('idle')
    expect(r.turnEnds()).toHaveLength(1)                                   // once
  })
  test('the pushed-back case: Stop, another Stop hook holds it: the record stays busy (nothing sent), the turn goes on (taken back), its real Stop and an idle record: one turn_end', () => {
    const r = rig(), j = r.item('n2', '802')
    r.line(j, 'bound', { prompt_id: 'q2' }); r.main('in_turn', 'q2', '2026-11-26T03:01:00.000Z')
    r.line(j, 'done', { prompt_id: 'q2' }); r.main('idle', null, '2026-11-26T03:01:04.000Z', { stopped_prompt: 'q2' })
    r.facts.statusRecord('busy'); r.facts.statusRecord('stuck'); r.facts.statusRecord('compacting')
    expect(r.turnEnds()).toHaveLength(0)
    r.main('in_turn', 'q2', '2026-11-26T03:01:06.000Z'); r.line(j, 'bound', { prompt_id: 'q2', reason: 'turn_continued' })   // lanes-main continueTurn
    expect(r.facts.pendingLater()).toBe(0)
    r.facts.statusRecord('idle')                                           // nothing pending: nothing sent
    expect(r.turnEnds()).toHaveLength(0)
    r.line(j, 'done', { prompt_id: 'q2' }); r.main('idle', null, '2026-11-26T03:01:30.000Z', { stopped_prompt: 'q2' })
    r.facts.statusRecord('waiting')                                        // a menu after the end: the turn is over too
    expect(r.turnEnds()).toEqual([expect.objectContaining({ client_msg_id: '802', turn_id: 'q2', outcome: 'done' })])
  })
  test('an interrupted turn still sends at once (no record needed); a new prompt still ends the last one\'s wait', () => {
    const r = rig(), a = r.item('n3', '803'), b = r.item('n4', '804'), c = r.item('n5', '805')
    r.line(a, 'bound', { prompt_id: 'q3' }); r.main('in_turn', 'q3', '2026-11-26T03:02:00.000Z')
    r.line(a, 'queued', { reason: 'interrupted', prompt_id: null, cut_at: 'x' }); r.main('idle', null, '2026-11-26T03:02:03.000Z', { ended_by: 'interrupted' })
    expect(r.turnEnds()).toEqual([expect.objectContaining({ client_msg_id: '803', outcome: 'interrupted' })])
    r.line(b, 'bound', { prompt_id: 'q4' }); r.main('in_turn', 'q4', '2026-11-26T03:03:00.000Z')
    r.line(b, 'done', { prompt_id: 'q4' }); r.main('idle', null, '2026-11-26T03:03:02.000Z', { stopped_prompt: 'q4' })
    r.facts.statusRecord('busy')
    r.line(c, 'bound', { prompt_id: 'q5' }); r.main('in_turn', 'q5', '2026-11-26T03:03:03.000Z')    // a new prompt: q4's Stop was its end
    expect(r.turnEnds().map(f => f.client_msg_id)).toEqual(['803', '804'])
  })
})
