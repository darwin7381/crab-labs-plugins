// WO-172 (Chiron; Onsen contract v1 §2, §4; mapping A-4, B-3): three facts, no decision changed.
//   1 a message an agent sends carries the turn it was sent in (meta.turn_id: the main's prompt id, a lane's run id); the daemon's own notices none
//   2 turn_end carries outcome (done / interrupted / failed) and bound (Joey's client_msg_id, a colleague's msg id), computed once per turn: the same
//     value on every fact of the turn and on the observation's last_turn
//   3 the bot's own profile photo as the agent's Onsen avatar: uploaded when its hash changes, nothing without a photo, one log line on a failure
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { DeliveryFacts, LanesTap, TurnWatch, runOutcome, type TurnEnded } from './onsen-status.ts'
import { outboundRecord, sendCtx, withPart, withSender } from './onsen-client.ts'
import { AvatarSync, imageType, largest, type AvatarDeps } from './onsen-avatar.ts'

describe('1 turn_id on what is sent', () => {
  const pay = { chat_id: 1828, text: 'hi' }
  test('a message sent in a turn carries it in meta; one sent with none (a notice of the daemon\'s own) carries none; an edit or a reaction is no message', () => {
    const r = outboundRecord('adam', { sender: 'main', turn_id: 'p-1' }, 'sendMessage', pay, { message_id: 7, date: 1 }) as any
    expect(r.k).toBe('m'); expect(r.r.meta).toEqual({ turn_id: 'p-1' })
    const lane = outboundRecord('adam', { sender: 'adam.reflex.3', turn_id: 'adam.reflex.3.r2', part: 1, parts: 2 }, 'sendRichMessage', { chat_id: 1828, rich_message: { markdown: 'x' } }, { message_id: 8 }) as any
    expect(lane.r.meta).toEqual({ turn_id: 'adam.reflex.3.r2', part: 1, parts: 2 })
    expect((outboundRecord('adam', { sender: 'system:status' }, 'sendMessage', pay, { message_id: 9 }) as any).r.meta).toBeUndefined()
    expect((outboundRecord('adam', { sender: 'router' }, 'sendMessage', pay, { message_id: 10 }) as any).r.meta).toBeUndefined()
    expect(JSON.stringify(outboundRecord('adam', { sender: 'main', turn_id: 'p-1' }, 'editMessageText', { chat_id: 1828, message_id: 7, text: 'y' }, true))).not.toContain('turn_id')
  })
  test('withSender keeps it for every part of one send', () => {
    const r = withSender('main', () => withPart(2, 3, () => outboundRecord('adam', sendCtx()!, 'sendMessage', pay, { message_id: 11 })), { turn_id: 'p-9' }) as any
    expect(r.r.meta).toEqual({ turn_id: 'p-9', part: 2, parts: 3 })
    expect(withSender('system:ack', () => sendCtx())).toEqual({ sender: 'system:ack' })
  })
})

describe('2 turn_end: outcome and bound, once per turn', () => {
  function rig() {
    let gen: any = { rec: 'main', id: 'g1', state: 'idle', pid: 7 }
    const sent: any[] = [], ended: TurnEnded[] = []
    const facts = new DeliveryFacts({ agent: 'adam', sink: f => sent.push(f), settleMs: 60_000 })
    const joey = (m: any) => m?.chat_id && m?.user === 'joey' ? { chat: String(m.chat_id), id: String(m.message_id) } : null
    const tap = new LanesTap({ facts, joey, gen: () => gen, changed: () => {}, turnEnded: t => ended.push(t) })
    const main = (state: string, prompt: string | null, ts: string, extra: Record<string, unknown> = {}) => {
      gen = { ...gen, state, prompt_id: prompt, ts }; tap.journal({ ...gen } as any, { state, ...(prompt ? { prompt_id: prompt } : {}), ...extra })
    }
    const item = (id: string, kind: 'joey' | 'peer', mid: string) => ({ rec: 'msg', id, kind, notif: { params: { meta: kind === 'joey' ? { chat_id: '1828', message_id: mid, user: 'joey' } : { user: 'eve', btcc_msg_id: mid } } } })
    const line = (row: any, state: string, f: Record<string, unknown> = {}) => tap.journal({ ...row, state, ...f, ts: '2026-11-26T02:00:00.000Z' } as any, { state, ...f })
    const turnEnds = () => sent.filter(f => f.state === 'turn_end')
    return { tap, facts, main, item, line, ended, turnEnds, event: (b: any) => tap.mainEvent({ pid: 7, ...b }) }
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
    expect(r.turnEnds()).toEqual([expect.objectContaining({ client_msg_id: '691', by: 'main', detail: { outcome: 'done', bound: ['691', '71001'] } })])
    expect(r.ended).toEqual([{ session: 'main', turn_id: 'p1', outcome: 'done', bound: ['691', '71001'], ended_at: '2026-11-26T02:00:09.000Z', facts: 1 }])
    expect(r.tap.lastTurn()).toEqual({ id: 'p1', outcome: 'done', ended_at: '2026-11-26T02:00:09.000Z' })
  })
  test('Esc mid-turn: interrupted, at once (the cut message is held for the next turn); the M2 row the wrap-up writes says so for a turn with nothing bound', () => {
    const r = rig()
    const j = r.item('m3', 'joey', '692')
    r.line(j, 'bound', { prompt_id: 'p2' }); r.main('in_turn', 'p2', '2026-11-26T02:01:00.000Z')
    r.line(j, 'queued', { reason: 'interrupted', prompt_id: null, cut_at: 'x' })
    r.main('idle', null, '2026-11-26T02:01:05.000Z', { ended_by: 'interrupted' })
    expect(r.turnEnds()).toEqual([expect.objectContaining({ client_msg_id: '692', detail: { outcome: 'interrupted', bound: ['692'] } })])
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
    expect(r.turnEnds()).toEqual([expect.objectContaining({ client_msg_id: '693', detail: { outcome: 'failed', bound: ['693'] } })])
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
    expect(r.turnEnds()).toEqual([expect.objectContaining({ client_msg_id: '696', detail: { outcome: 'failed', bound: ['696'] } })])   // one fact, the real end's
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
    expect(r.turnEnds().at(-1)).toMatchObject({ client_msg_id: '694', by: 'adam.worker.1', detail: { reason: 'died', outcome: 'failed', bound: ['694', '71005'] } })
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
    expect(sent.filter(f => f.state === 'turn_end')).toEqual([expect.objectContaining({ client_msg_id: '695', detail: { outcome: 'done', bound: ['695', '71006'] } })])
    expect(ended).toEqual([expect.objectContaining({ session: 'main', outcome: 'done', bound: ['695', '71006'], facts: 1 })])
  })
})

describe('3 the avatar', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]), PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9])
  function rig(o: { sizes?: any[]; bytes?: Uint8Array; status?: number; throws?: string } = {}) {
    const puts: Array<{ bytes: Uint8Array; type: string }> = [], logs: string[] = []
    let stored: any = null
    const d: AvatarDeps = { agent: 'adam', botId: async () => 999,
      photoSizes: async id => { if (o.throws) throw new Error(o.throws); expect(id).toBe(999); return o.sizes ?? [{ file_id: 'small', width: 160, height: 160 }, { file_id: 'big', width: 640, height: 640 }] },
      download: async id => { expect(id).toBe('big'); return o.bytes ?? JPEG },
      put: async (bytes, type) => { puts.push({ bytes, type }); return { status: o.status ?? 200, ...(o.status && o.status >= 300 ? { detail: 'not_found' } : {}) } },
      load: () => stored, save: x => { stored = x }, log: (_l, m) => logs.push(m) }
    return { s: new AvatarSync(d), puts, logs, stored: () => stored, d }
  }
  test('the largest size, uploaded once; the same photo again: not uploaded; a new one: uploaded', async () => {
    const r = rig()
    expect(await r.s.syncOnce()).toBe('uploaded')
    expect(r.puts).toEqual([{ bytes: JPEG, type: 'image/jpeg' }])
    expect(r.stored()).toMatchObject({ sha256: createHash('sha256').update(JPEG).digest('hex'), bytes: JPEG.length })
    expect(await r.s.syncOnce()).toBe('same')
    expect(r.puts).toHaveLength(1)
    const again = new AvatarSync({ ...r.d, download: async () => PNG })
    expect(await again.syncOnce()).toBe('uploaded')
    expect(r.puts.at(-1)!.type).toBe('image/png')
  })
  test('no photo: nothing sent; a refusal or a failure: one line, nothing stored (tried again at the next check)', async () => {
    const none = rig({ sizes: [] })
    expect(await none.s.syncOnce()).toBe('no_photo'); expect(none.puts).toHaveLength(0)
    const refused = rig({ status: 404 })
    expect(await refused.s.syncOnce()).toBe('failed'); expect(refused.stored()).toBeNull()
    expect(refused.logs).toEqual([expect.stringContaining('answered 404')])
    const down = rig({ throws: 'getUserProfilePhotos: 502' })
    expect(await down.s.syncOnce()).toBe('failed'); expect(down.logs).toHaveLength(1)
    const notImage = rig({ bytes: new Uint8Array([1, 2, 3, 4]) })
    expect(await notImage.s.syncOnce()).toBe('failed'); expect(notImage.puts).toHaveLength(0)
  })
  test('helpers: the image type from the first bytes; the largest size', () => {
    expect([imageType(JPEG), imageType(PNG), imageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPx')), imageType(new TextEncoder().encode('GIF89a')), imageType(new Uint8Array([0]))])
      .toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/gif', null])
    expect(largest([{ file_id: 'a', width: 160, height: 160 }, { file_id: 'b', width: 640, height: 640 }, { file_id: 'c', width: 320, height: 320 }])!.file_id).toBe('b')
    expect(largest([])).toBeNull()
  })
})
