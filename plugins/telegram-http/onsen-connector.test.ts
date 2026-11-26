// WO-197 onsen-connector.ts: the switch (list or *, the machine config read again every 30 s), the numbers turned into Onsen's ids by asking Onsen
// (cached, onsen:<id> as it is), a reply written with conversation_id and the bridge's report waited for (3 s), reactions and edits
import { test, expect } from 'bun:test'
import { BridgeSwitch, bridgeOn, ConnectorSay, OnsenIds, numbersOf, reactionOk, HELD, NOT_TAKEN, type Request } from './onsen-connector.ts'

const noLog = () => {}

test('the switch: none by default; a list or *; the machine config read again at most every 30 s; a plist value wins', () => {
  for (const v of [undefined, '', '0', 'off']) expect(bridgeOn(v, 'adam')).toBe(false)
  expect(bridgeOn('lab-relay, adam', 'adam')).toBe(true)
  expect(bridgeOn('*', 'adam')).toBe(true)
  expect(bridgeOn('lab-relay', 'adam')).toBe(false)
  let file = 'ONSEN_BRIDGE=adam\n', t = 0, reads = 0
  const s = new BridgeSwitch({ agent: 'adam', file: 'x', now: () => t, read: () => { reads++; return file } })
  expect(s.on()).toBe(true)
  file = 'ONSEN_BRIDGE=0\n'; t = 29_000
  expect(s.on()).toBe(true)                       // not read again yet
  t = 30_000
  expect(s.on()).toBe(false)
  expect(reads).toBe(2)
  expect(new BridgeSwitch({ agent: 'adam', file: 'x', plist: '*', read: () => 'ONSEN_BRIDGE=0' }).on()).toBe(true)
})

test('the reaction set: Telegram\'s; a variation selector does not matter', () => {
  for (const e of ['🫡', '👍', '💯', '🎉', '🤔', '😢', '🔥', '👀', '✍', '❤️']) expect(reactionOk(e)).toBe(true)
  for (const e of ['✅', '❌', '💪', '🔍', '']) expect(reactionOk(e)).toBe(false)
})

/** a fake Onsen: one conversation (77) for chat 1828; message 4001 has Telegram numbers 950, 951 */
function fake(o: { report?: 'sent' | 'failed' | 'never'; afterMs?: number; status?: number[] } = {}) {
  const calls: Array<{ m: string; p: string; b: any }> = []
  const t0 = Date.now(), statuses = [...(o.status ?? [])]
  const request: Request = async (m, p, b) => {
    calls.push({ m, p, b })
    if (p === '/v1/conversations/by-chat/1828') return { status: 200, json: { data: { id: '77' } } }
    if (p.startsWith('/v1/conversations/by-chat/')) return { status: 404, json: { error: { code: 'not_found', message: 'none' } } }
    if (p === '/v1/conversations/77/messages/by-client-id/950') return { status: 200, json: { data: { id: '4001' } } }
    if (p.startsWith('/v1/conversations/77/messages/by-client-id/')) return { status: 404, json: {} }
    if (p === '/v1/messages' && m === 'POST') {
      const s = statuses.shift() ?? 201
      if (s >= 300) return { status: s, json: { error: { message: 'nope' } } }
      return { status: 201, json: { data: { message_id: '5001', conversation_id: b.conversation_id, duplicate: false, delivery: b.conversation_id === '9' ? 'sent' : 'pending' } } }
    }
    if (p === '/messages/5001') {
      const done = o.report !== 'never' && Date.now() - t0 >= (o.afterMs ?? 0)
      return { status: 200, json: { id: 5001, delivery: { state: done ? (o.report ?? 'sent') : 'pending' }, aliases: done && o.report !== 'failed' ? [
        { client: 'telegram', scope: 'adam', client_ref: '1828:961' }, { client: 'telegram', scope: 'adam', client_ref: '1828:960' }] : [] } }
    }
    if (/^\/v1\/messages\/\d+\/reactions$/.test(p) || /^\/v1\/messages\/\d+$/.test(p)) return { status: 200, json: { data: { message_id: p.split('/')[3] } } }
    return { status: 404, json: {} }
  }
  const ids = new OnsenIds({ request })
  return { calls, ids, say: new ConnectorSay({ request, ids, agent: 'adam', log: noLog, waitMs: 600, pollMs: 50, retryMs: [20, 20] }) }
}

test('say: conversation_id from the chat (asked once, cached), reply_to as Onsen\'s id, no client / chat / delivery; the bridge\'s numbers back, in order', async () => {
  const f = fake({ afterMs: 100 })
  const r = await f.say.say({ chat: '1828', sender: 'main', text: '收到', replyTo: '950', silent: true, turn_id: 't1' })
  expect(r).toEqual({ onsenId: '5001', conversationId: '77', ids: ['960', '961'], held: false })
  const w = f.calls.find(c => c.p === '/v1/messages')!.b
  expect(w.conversation_id).toBe('77')
  expect(w.reply_to_message_id).toBe('4001')
  expect(w.urgency).toBe('silent')
  for (const k of ['client', 'chat', 'delivery', 'client_msg_id', 'to', 'agent']) expect(k in w).toBe(false)
  await f.say.say({ chat: '1828', sender: 'main', text: '再一句' })
  expect(f.calls.filter(c => c.p === '/v1/conversations/by-chat/1828').length).toBe(1)          // cached
  expect(await f.ids.message('1828', '961')).toBe('5001')                                         // learned from the report
})

test('say: no report in time → held (said, not a failure); a failed report → held; nothing to draw it (onsen:<id>) → sent, no numbers', async () => {
  const a = fake({ report: 'never' })
  const r = await a.say.say({ chat: '1828', sender: 'main', text: 'x' })
  expect(r.held).toBe(true)
  expect(HELD).toBe('已寫進 Onsen（網頁看得到）；Telegram 還沒送到，會再送')
  expect((await fake({ report: 'failed' }).say.say({ chat: '1828', sender: 'main', text: 'x' })).held).toBe(true)
  const d = fake()
  const s = await d.say.say({ chat: 'onsen:9', sender: 'main', text: 'x' })
  expect(s).toEqual({ onsenId: '5001', conversationId: '9', ids: [], held: false })
  expect(d.calls.some(c => c.p.startsWith('/v1/conversations/by-chat/'))).toBe(false)
})

test('say: a 5xx is tried again (1 s, 3 s; here shortened), a 4xx fails at once; an unknown chat fails; an unknown reply_to is left out', async () => {
  const a = fake({ status: [500, 503] })
  expect((await a.say.say({ chat: '1828', sender: 'main', text: 'x' })).onsenId).toBe('5001')
  expect(a.say.stats.retries).toBe(2)
  await expect(fake({ status: [500, 500, 500] }).say.say({ chat: '1828', sender: 'main', text: 'x' })).rejects.toThrow(NOT_TAKEN)
  await expect(fake({ status: [400] }).say.say({ chat: '1828', sender: 'main', text: 'x' })).rejects.toThrow(/HTTP 400: nope/)
  await expect(fake().say.say({ chat: '555', sender: 'main', text: 'x' })).rejects.toThrow(/no conversation for chat 555/)
  const u = fake()
  await u.say.say({ chat: '1828', sender: 'main', text: 'x', replyTo: '12345' })
  expect('reply_to_message_id' in u.calls.find(c => c.p === '/v1/messages')!.b).toBe(false)
})

test('react / edit: the Telegram number turned into Onsen\'s message, then POST reactions / PUT messages; an unknown number fails', async () => {
  const f = fake()
  expect(await f.say.react('1828', '950', '👍')).toBe('4001')
  expect(f.calls.find(c => c.p === '/v1/messages/4001/reactions')!.b).toEqual({ emojis: ['👍'] })
  expect(await f.say.edit('1828', '950', '新的字')).toBe('4001')
  expect(f.calls.find(c => c.m === 'PUT' && c.p === '/v1/messages/4001')!.b).toEqual({ text: '新的字' })
  expect(await f.say.react('1828', 'onsen:4002', '👍')).toBe('4002')
  await expect(f.say.edit('1828', '1', 'x')).rejects.toThrow(/not a message Onsen knows/)
  expect(numbersOf({ aliases: [{ client_ref: '1:12' }, { client_ref: '1:3' }, { client_ref: '1:12' }] })).toEqual(['3', '12'])
})
