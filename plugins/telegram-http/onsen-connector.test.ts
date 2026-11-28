// WO-197 onsen-connector.ts: the switch (list or *, the machine config read again every 30 s), the numbers turned into Onsen's ids by asking Onsen
// (cached, onsen:<id> as it is), a reply written with conversation_id and the bridge's report waited for (3 s), reactions and edits
import { test, expect } from 'bun:test'
import { BridgeSwitch, bridgeOn, ConnectorSay, OnsenIds, numbersOf, reactionOk, withoutOnsenLabel, memberChat, HELD, NOT_TAKEN, type Request } from './onsen-connector.ts'

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

test('WO-197 segment 2: the machine config key is the reader\'s own (ONSEN_OWNER), read again as ONSEN_BRIDGE is; the plist\'s wins', () => {
  let file = 'ONSEN_BRIDGE=adam\nONSEN_OWNER=amy\n', t = 0
  const o = new BridgeSwitch({ agent: 'adam', file: 'x', key: 'ONSEN_OWNER', now: () => t, read: () => file })
  expect(o.value()).toBe('amy')
  file = 'ONSEN_OWNER=bob\n'; t = 30_000
  expect(o.value()).toBe('bob')
  expect(new BridgeSwitch({ agent: 'adam', file: 'x', key: 'ONSEN_OWNER', plist: 'carl', read: () => file }).value()).toBe('carl')
  expect(new BridgeSwitch({ agent: 'adam', file: 'x', key: 'ONSEN_OWNER', read: () => 'ONSEN_BRIDGE=adam\n' }).value()).toBeUndefined()
})

test('WO-197 segment 2: a chat member:<name> is written with `to` (the person\'s direct conversation), no conversation asked, no reply; the conversation Onsen answers is kept', async () => {
  const calls: Array<{ m: string; p: string; b: any }> = []
  const request: Request = async (m, p, b) => {
    calls.push({ m, p, b })
    if (p === '/v1/messages' && m === 'POST') return { status: 201, json: { data: { message_id: '5100', conversation_id: '88', duplicate: false, delivery: 'sent' } } }
    if (p === '/v1/conversations/88/messages/by-client-id/12') return { status: 200, json: { data: { id: '4100' } } }
    return { status: 404, json: {} }
  }
  const ids = new OnsenIds({ request })
  const say = new ConnectorSay({ request, ids, agent: 'adam', log: noLog, waitMs: 200, pollMs: 50 })
  expect(memberChat('amy')).toBe('member:amy')
  const r = await say.say({ chat: 'member:amy', sender: 'system:alert', text: '⚠️ 系統警告', replyTo: '12' })
  expect(r).toMatchObject({ onsenId: '5100', conversationId: '88', held: false })
  expect(calls.map(c => c.p)).toEqual(['/v1/messages'])
  const w = calls[0]!.b
  expect(w.to).toBe('amy')
  expect('conversation_id' in w || 'reply_to_message_id' in w).toBe(false)
  expect(w.idem_key).toMatch(/^c:adam:to-amy:out:/)
  expect(await ids.conversation('member:amy')).toBe('88')                // kept: no by-chat asked for it
})

test('the by-client-id lookup encodes both path segments and caches the returned id', async () => {
  const calls: string[] = []
  const ids = new OnsenIds({ request: async (method, path) => {
    calls.push(method + ' ' + path)
    return { status: 200, json: { data: { id: '401' } } }
  } })
  ids.know('-10042', 'room/2')
  expect(await ids.message('-10042', 'post?#7')).toBe('401')
  expect(await ids.message('-10042', 'post?#7')).toBe('401')
  expect(calls).toEqual(['GET /v1/conversations/room%2F2/messages/by-client-id/post%3F%237'])
})

test('a group reply keeps the shared conversation across Telegram and web', async () => {
  const f = fake({})
  f.ids.know('-10042', '42')
  for (const chat of ['-10042', 'onsen:42']) {
    await f.say.say({ chat, sender: 'main', text: '@lab-b 看一下' })
  }
  const writes = f.calls.filter(c => c.m === 'POST')
  expect(writes.map(c => [c.p, c.b.conversation_id, c.b.to])).toEqual([
    ['/v1/messages', '42', undefined], ['/v1/messages', '42', undefined],
  ])
  expect(f.calls.some(c => c.p.includes('by-chat'))).toBe(false)
  await expect(f.say.say({ chat: '-10099', sender: 'main', text: '未知群' })).rejects.toThrow('no conversation')
  expect(f.calls.filter(c => c.p === '/v1/messages')).toHaveLength(2)
})

test('WO-197 segment 2 (sonn\'s ruling 9): a thread Onsen refuses (a Telegram topic kept from before the switch) is dropped once and the message written; thread lookup by client_thread', async () => {
  const calls: Array<{ m: string; p: string; b: any }> = []
  const request: Request = async (m, p, b) => {
    calls.push({ m, p, b: b && JSON.parse(JSON.stringify(b)) })
    if (p === '/v1/conversations/by-chat/1828') return { status: 200, json: { data: { id: '77' } } }
    if (p === '/v1/messages' && m === 'POST') return b.thread != null ? { status: 400, json: { error: { code: 'invalid_request', message: `thread ${b.thread}: not a thread of conversation 77` } } }
      : { status: 201, json: { data: { message_id: '5200', conversation_id: '77', duplicate: false, delivery: 'sent' } } }
    if (p === '/v1/conversations/77/threads?client_thread=7001') return { status: 200, json: { items: [{ thread: '301', name: 'x', state: 'open', client_thread: '7001' }] } }
    if (p.startsWith('/v1/conversations/77/threads?client_thread=')) return { status: 200, json: { items: [] } }
    return { status: 404, json: {} }
  }
  const logs: string[] = []
  const ids = new OnsenIds({ request })
  const say = new ConnectorSay({ request, ids, agent: 'adam', log: (_l, m) => logs.push(m), waitMs: 200, pollMs: 50 })
  const r = await say.say({ chat: '1828', sender: 'adam.worker.1', text: 'x', thread: '7401' })
  expect(r.onsenId).toBe('5200')
  const posts = calls.filter(c => c.p === '/v1/messages')
  expect(posts.map(c => c.b.thread ?? null)).toEqual(['7401', null])
  expect(say.stats.thread_dropped).toBe(1)
  expect(logs.some(l => l.includes('Onsen refused thread 7401'))).toBe(true)
  expect(await ids.thread('1828', '7001')).toBe('301')
  expect(await ids.thread('1828', '7001')).toBe('301')
  expect(calls.filter(c => c.p.includes('client_thread=7001'))).toHaveLength(1)    // cached
  expect(await ids.thread('1828', '7999')).toBeNull()
  ids.learnThread('77', '7002', '302')
  expect(await ids.thread('1828', '7002')).toBe('302')
})

test('WO-197 segment 2 (sonn\'s ruling 4; Chiron mesh 12916 point 4): the lane\'s or router\'s label Onsen draws itself leaves the text; what follows it on the line is the first line; another first line stays', () => {
  const kind = (k: string) => ({ worker: '工作線', fork: '分身線' } as Record<string, string>)[k] ?? k
  // equal: the line dropped (as before)
  expect(withoutOnsenLabel('〔adam·工作線#1〕\n做完了', 'adam.worker.1', 'adam', kind)).toBe('做完了')
  expect(withoutOnsenLabel('〔adam·分流器〕\n收到', 'router', 'adam', kind)).toBe('收到')
  expect(withoutOnsenLabel('〔adam·工作線#1〕', 'adam.worker.1', 'adam', kind)).toBe('〔adam·工作線#1〕')   // only the label: kept, never an empty text
  // starts with the label: the label goes, 「負責：X」 (no leading 「｜」) is the first line
  expect(withoutOnsenLabel('〔adam·工作線#1〕｜負責：主線\n做完了', 'adam.worker.1', 'adam', kind)).toBe('負責：主線\n做完了')
  expect(withoutOnsenLabel('〔adam·工作線#1｜負責：主線〕\n做完了\n第二行', 'adam.worker.1', 'adam', kind)).toBe('負責：主線\n做完了\n第二行')   // lanes.ts pushJoey's head
  expect(withoutOnsenLabel('〔adam·工作線#1〕｜負責：主線', 'adam.worker.1', 'adam', kind)).toBe('負責：主線')
  // does not start with it: unchanged
  expect(withoutOnsenLabel('〔adam·工作線#12〕\nx', 'adam.worker.1', 'adam', kind)).toBe('〔adam·工作線#12〕\nx')
  expect(withoutOnsenLabel('〔adam·工作線#12｜負責：主線〕\nx', 'adam.worker.1', 'adam', kind)).toBe('〔adam·工作線#12｜負責：主線〕\nx')
  expect(withoutOnsenLabel('前言〔adam·工作線#1〕\nx', 'adam.worker.1', 'adam', kind)).toBe('前言〔adam·工作線#1〕\nx')
  expect(withoutOnsenLabel('〔adam·分身線#2〕\nx', 'adam.worker.2', 'adam', kind)).toBe('〔adam·分身線#2〕\nx')
  expect(withoutOnsenLabel('一行', 'adam.worker.1', 'adam', kind)).toBe('一行')
  expect(withoutOnsenLabel('〔adam·工作線#1〕\nx', 'main', 'adam', kind)).toBe('〔adam·工作線#1〕\nx')
})
