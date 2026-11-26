// Onsen (WO-139): the Telegram client's recording and chat_history, against a stand-in for Onsen (a fake fetch; nothing reaches core.kbro.ai).
import { test, expect, describe } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  OnsenClient, inboundItem, outboundRecord, withSender, withPart, richAttempt, sendCtx, recordFor, agentName, parseWhen, formatList, formatFull, forwardName,
  CHAT_HISTORY_TOOL, type OnsenItem, type OnsenEvent,
} from './onsen-client.ts'
import { LANE_TOOLS, laneToolsFor } from './lanes.ts'

const CRED = 'mesh_TESTSECRETabcdefghijklmnopqrstuvwxyz0123'
const AGENT = 'adam'
const JOEY = '1828'

/** a stand-in Onsen: dedupes by idem_key, numbers what it keeps, can be down / refuse / hang */
function fakeOnsen() {
  const store = new Map<string, any>()            // idem_key → row
  const events = new Map<string, any>()
  const calls: Array<{ method: string; path: string; headers: Record<string, string>; body: any }> = []
  const st = { down: false, status5xx: false, hang: false, refuseKey: '' as string, batch400: false }
  let next = 1
  const keep = (it: any) => {
    if (it.idem_key === st.refuseKey) return { error: 'refused by the test' }
    const was = store.get(it.idem_key)
    if (was) return { id: was.id, duplicate: true }
    const row = { ...it, id: next++ }
    store.set(it.idem_key, row)
    return { id: row.id, duplicate: false }
  }
  const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } })
  const f = (async (input: any, init?: any) => {
    const url = new URL(String(input)), path = url.pathname.replace(/^\/api\/onsen/, '') + url.search
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v)
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ method: init?.method ?? 'GET', path, headers, body })
    if (st.hang) return new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }))))
    if (st.down) throw new TypeError('fetch failed: connect ECONNREFUSED')
    if (st.status5xx) return json(503, { error: 'busy' })
    if (headers.authorization !== `Bearer ${CRED}`) return json(401, { error: 'no credential' })
    if (init?.method === 'POST' && path === '/messages/batch') {
      if (st.batch400) return json(400, { error: 'bad batch' })
      return json(200, { results: body.items.map(keep) })
    }
    if (init?.method === 'POST' && path === '/messages') { const r = keep(body); return r.error ? json(422, r) : json(200, r) }
    if (init?.method === 'POST' && path === '/events') {
      if (events.has(body.idem_key)) return json(200, { id: events.get(body.idem_key).id, duplicate: true })
      const id = next++; events.set(body.idem_key, { ...body, id }); return json(200, { id, duplicate: false, message_id: 1 })
    }
    if (path.startsWith('/messages?')) {
      const rows = [...store.values()].filter(r => !url.searchParams.get('chat') || r.chat === url.searchParams.get('chat'))
        .filter(r => !url.searchParams.get('q') || r.body.includes(url.searchParams.get('q')!))
        .sort((a, b) => b.id - a.id)
      const lim = Number(url.searchParams.get('limit') ?? 20)
      return json(200, { messages: rows.slice(0, lim).map(r => ({ id: r.id, at: r.sent_at, direction: r.direction, sender: r.direction === 'in' && r.sender === `tg:${JOEY}` ? 'joey' : r.sender,
        kind: r.kind, body: r.body.length > 300 ? r.body.slice(0, 300) : r.body, truncated: r.body.length > 300, edited: false, client_msg_id: r.client_msg_id ?? null,
        reply_to_client_msg_id: r.reply_to_client_msg_id ?? null, status: r.status, backfilled: false, chat: r.chat })), total: rows.length })
    }
    const one = /^\/messages\/(\d+)$/.exec(path)
    if (one) {
      const r = [...store.values()].find(x => x.id === Number(one[1]))
      return r ? json(200, { ...r, at: r.sent_at, events: [...events.values()].filter(e => e.target_client_msg_id === r.client_msg_id && e.chat === r.chat) }) : json(404, { error: 'not found' })
    }
    const alias = /^\/alias\/telegram\/([^/]+)\/([^/]+)\/(\d+)$/.exec(path)
    if (alias) {
      const r = [...store.values()].find(x => x.chat === alias[2] && x.client_msg_id === alias[3])
      return r ? json(200, { id: r.id }) : json(404, { error: 'no alias' })
    }
    return json(404, { error: 'no route' })
  }) as typeof fetch
  return { f, store, events, calls, st }
}

function client(dir: string, f: typeof fetch, o: { cred?: string | null; logs?: string[]; queryTimeoutMs?: number } = {}) {
  const logs = o.logs ?? []
  return new OnsenClient({ dir, base: 'https://onsen.test/api/onsen', agent: AGENT, record: true, credential: () => o.cred === undefined ? CRED : o.cred,
    credentialWhere: '/x/.agent-inbox-state/mesh-credential', log: (l, m) => logs.push(`${l} ${m}`), fetch: f, intervalMs: 3_600_000, queryTimeoutMs: o.queryTimeoutMs ?? 300,
    joeyChat: () => JOEY })
}
const tmp = () => mkdtempSync(join(tmpdir(), 'onsen-client-'))
const tgMsg = (id: number, text: string, extra: Record<string, any> = {}) => ({ message_id: id, date: 1764020000 + id, chat: { id: Number(JOEY), type: 'private' },
  from: { id: Number(JOEY), is_bot: false, first_name: 'J', username: 'joey' }, text, ...extra })
const outText = (sender: string, id: number, text: string, method = 'sendRichMessage') =>
  withSender(sender, () => outboundRecord(AGENT, sendCtx()!, method, method === 'sendRichMessage' ? { chat_id: JOEY, rich_message: { markdown: text } } : { chat_id: JOEY, text },
    { message_id: id, date: 1764020000 + id }))!

describe('records', () => {
  test('WO-179: an incoming record carries chat_title (groups only) and sender_name as its own fields; an outgoing one neither', () => {
    const g = inboundItem(AGENT, tgMsg(9001, '群組裡說話', { chat: { id: -1003883107701, type: 'supergroup', title: 'Onsen 測試群' },
      from: { id: 777308933, is_bot: false, first_name: 'Alice', last_name: 'Wang', username: 'alicew' } }), '群組裡說話')
    expect(g.chat_title).toBe('Onsen 測試群')
    expect(g.sender_name).toBe('Alice Wang')
    const p = inboundItem(AGENT, tgMsg(9002, '私訊'), '私訊')
    expect(p.chat_title).toBeUndefined()
    expect(p.sender_name).toBe('J')
    const u = inboundItem(AGENT, tgMsg(9003, '只有帳號', { from: { id: 5, is_bot: false, username: 'onlyuser' } }), '只有帳號')
    expect(u.sender_name).toBe('@onlyuser')
    const none = inboundItem(AGENT, tgMsg(9004, '沒名字', { from: { id: 6, is_bot: false } }), '沒名字')
    expect('sender_name' in none).toBe(false)
    expect(outText('main', 9005, '送出的')).not.toHaveProperty('chat_title')
    expect(outText('main', 9006, '送出的')).not.toHaveProperty('sender_name')
  })
  test('inbound: direction in, sender tg:<from>, idem_key tg:<agent>:<chat>:in:<id>, reply / forward / topic / file fields', () => {
    const a = inboundItem(AGENT, tgMsg(2166, '你看這個', { reply_to_message: { message_id: 2161 } }), '你看這個')
    expect(a).toMatchObject({ idem_key: `tg:${AGENT}:${JOEY}:in:2166`, agent: AGENT, client: 'telegram', chat: JOEY, direction: 'in', sender: `tg:${JOEY}`,
      body: '你看這個', kind: 'text', client_msg_id: '2166', reply_to_client_msg_id: '2161', status: 'ok', backfilled: false })
    expect(a.sent_at).toBe(new Date((1764020000 + 2166) * 1000).toISOString())
    expect(inboundItem(AGENT, tgMsg(5, '/status'), '/status').kind).toBe('command')
    const photo = inboundItem(AGENT, { ...tgMsg(6, ''), text: undefined, caption: '圖說', photo: [{ file_id: 's', file_size: 1 }, { file_id: 'big', file_size: 99 }] }, '圖說')
    expect(photo).toMatchObject({ kind: 'photo', body: '圖說', attachments: [{ file_id: 'big', size: 99, mime: 'image/jpeg' }] })
    const doc = inboundItem(AGENT, { ...tgMsg(7, ''), text: undefined, document: { file_id: 'd1', file_name: 'a.pdf', mime_type: 'application/pdf', file_size: 10 } }, '')
    expect(doc).toMatchObject({ kind: 'document', body: '', attachments: [{ name: 'a.pdf', mime: 'application/pdf', size: 10, file_id: 'd1' }] })
    expect(inboundItem(AGENT, { ...tgMsg(8, ''), text: undefined, voice: { file_id: 'v', mime_type: 'audio/ogg' } }, '逐字稿').kind).toBe('voice')
    const fwd = inboundItem(AGENT, tgMsg(9, 'x', { forward_origin: { type: 'user', date: 1764000000, sender_user: { id: 42, first_name: 'Ann', username: 'ann' } } }), 'x')
    expect(fwd.forward_from).toBe('tg:42 @ann Ann')
    expect(fwd.meta).toMatchObject({ forward_date: new Date(1764000000 * 1000).toISOString() })
    // a message typed in a topic replies to the topic's creation message: that is the topic, not a reply
    const inTopic = inboundItem(AGENT, tgMsg(10, 'y', { message_thread_id: 7001, is_topic_message: true, reply_to_message: { message_id: 7001, forum_topic_created: { name: 't' } } }), 'y')
    expect(inTopic.thread).toBe('7001'); expect(inTopic.reply_to_client_msg_id).toBeUndefined()
  })

  test('outbound: the sender comes from the send context (main / a lane id / router / system); parts; a failure is a failed item with its own key', () => {
    const m = outText('main', 3001, '好的').r as OnsenItem
    expect(m).toMatchObject({ idem_key: `tg:${AGENT}:${JOEY}:out:3001`, direction: 'out', sender: 'main', body: '好的', kind: 'rich', client_msg_id: '3001', status: 'ok' })
    expect((outText('chiron.reflex.2', 3002, 'lane', 'sendMessage').r as OnsenItem)).toMatchObject({ sender: 'chiron.reflex.2', kind: 'text' })
    const part = withSender('router', () => withPart(2, 3, () => outboundRecord(AGENT, sendCtx()!, 'sendMessage', { chat_id: JOEY, text: 'b', reply_parameters: { message_id: 2166 }, message_thread_id: 7001, disable_notification: true }, { message_id: 3003 })))!.r as OnsenItem
    expect(part).toMatchObject({ sender: 'router', reply_to_client_msg_id: '2166', thread: '7001', meta: { part: 2, parts: 3, silent: true } })
    const failed = withSender('main', () => outboundRecord(AGENT, sendCtx()!, 'sendMessage', { chat_id: JOEY, text: 'x' }, undefined, new Error('sendMessage: 403 Forbidden: bot was blocked')))!.r as OnsenItem
    expect(failed.status).toBe('failed'); expect(failed.error).toContain('403'); expect(failed.client_msg_id).toBeUndefined()
    expect(failed.idem_key).toMatch(new RegExp(`^tg:${AGENT}:${JOEY}:out-failed:[0-9a-f-]{36}$`))
    const file = withSender('main', () => outboundRecord(AGENT, sendCtx()!, 'sendDocument', { chat_id: JOEY, document: { filename: 'r.csv' } }, { message_id: 3004, document: { file_id: 'F', file_name: 'r.csv', mime_type: 'text/csv', file_size: 5 } }))!.r as OnsenItem
    expect(file).toMatchObject({ kind: 'document', body: '', attachments: [{ name: 'r.csv', mime: 'text/csv', size: 5, file_id: 'F' }] })
    expect(withSender('main', () => outboundRecord(AGENT, sendCtx()!, 'sendChatAction', { chat_id: JOEY, action: 'typing' }, true))).toBeNull()
    // the rich attempt marker rides the context (server.ts drops a rich failure that falls back to plain)
    expect(withSender('main', () => richAttempt(() => sendCtx()))).toMatchObject({ sender: 'main', richAttempt: true })
    expect(sendCtx()).toBeUndefined()
  })

  test('edit and react become events on the target message (a failed edit is no event)', () => {
    const e = withSender('main', () => outboundRecord(AGENT, sendCtx()!, 'editMessageText', { chat_id: JOEY, message_id: 3001, rich_message: { markdown: '新的字' } }, { message_id: 3001 }))!
    expect(e.k).toBe('e')
    expect(e.r).toMatchObject({ agent: AGENT, client: 'telegram', chat: JOEY, target_client_msg_id: '3001', kind: 'edit', actor: 'main', body: '新的字' })
    expect((e.r as OnsenEvent).idem_key).toMatch(new RegExp(`^tg:${AGENT}:${JOEY}:edit:3001:`))
    const r = withSender('main', () => outboundRecord(AGENT, sendCtx()!, 'setMessageReaction', { chat_id: JOEY, message_id: 2166, reaction: [{ type: 'emoji', emoji: '🫡' }] }, true))!
    expect(r.r).toMatchObject({ kind: 'reaction', target_client_msg_id: '2166', actor: 'main', data: { emoji: '🫡' } })
    expect(withSender('main', () => outboundRecord(AGENT, sendCtx()!, 'editMessageText', { chat_id: JOEY, message_id: 1, text: 'x' }, undefined, new Error('400')))).toBeNull()
  })

  test('ONSEN_AGENTS / ONSEN_RECORD and the agent name', () => {
    expect(recordFor({}, 'chiron')).toBe(true)
    expect(recordFor({ ONSEN_AGENTS: 'chiron, epeius' }, 'chiron')).toBe(true)
    expect(recordFor({ ONSEN_AGENTS: 'chiron,epeius' }, 'sonn')).toBe(false)
    expect(recordFor({ ONSEN_AGENTS: '*' }, 'sonn')).toBe(true)
    expect(recordFor({ ONSEN_RECORD: '0' }, 'chiron')).toBe(false)
    expect(recordFor({ ONSEN_RECORD: '0', ONSEN_AGENTS: 'chiron' }, 'chiron')).toBe(false)
    expect(agentName({ LANES_AGENT: 'sonn', AGENT_INBOX_SELF: 'x' }, '/w/claude-foo')).toBe('sonn')
    expect(agentName({ AGENT_INBOX_SELF: 'x' }, '/w/claude-foo')).toBe('x')
    expect(agentName({}, '/Users/b/cc-workspaces/claude-chiron')).toBe('chiron')
  })
})

describe('spool and sync', () => {
  test('the spool keeps order and survives a restart: nothing is posted without a credential, all of it in order once there is one', async () => {
    const dir = tmp(), on = fakeOnsen(), logs: string[] = []
    const a = client(dir, on.f, { cred: null, logs })
    a.recordMessage(inboundItem(AGENT, tgMsg(1, 'one'), 'one'))
    a.recordMessage(outText('main', 2, 'two').r as OnsenItem)
    a.recordEvent(outboundRecord(AGENT, { sender: 'main' }, 'editMessageText', { chat_id: JOEY, message_id: 2, text: 'two!' }, { message_id: 2 })!.r as OnsenEvent)
    a.recordMessage(outText('chiron.reflex.1', 3, 'three').r as OnsenItem)
    await a.syncNow(true)
    expect(on.calls.length).toBe(0)
    expect(logs.join('\n')).toContain('no mesh credential at /x/.agent-inbox-state/mesh-credential')
    // "restart": a new client on the same dir
    const b = client(dir, on.f)
    await b.syncNow(true)
    expect(on.calls.map(c => `${c.method} ${c.path}`)).toEqual(['POST /messages/batch', 'POST /events', 'POST /messages/batch'])
    expect(on.calls[0]!.body.items.map((i: any) => i.client_msg_id)).toEqual(['1', '2'])
    expect(on.calls[2]!.body.items.map((i: any) => i.sender)).toEqual(['chiron.reflex.1'])
    expect(b.pendingBytes()).toBe(0)
    await b.syncNow(true)
    expect(on.calls.length).toBe(3)                                        // nothing left to send
  })

  test('offline then online: kept while down (backoff), flushed once up, and no duplicate when it is sent again after a crash', async () => {
    const dir = tmp(), on = fakeOnsen(), logs: string[] = []
    const c = client(dir, on.f, { logs })
    on.st.down = true
    for (let i = 1; i <= 5; i++) c.recordMessage(inboundItem(AGENT, tgMsg(i, `m${i}`), `m${i}`))
    await c.syncNow(true)
    expect(on.store.size).toBe(0)
    expect(c.pendingBytes()).toBeGreaterThan(0)
    expect(c.health().backoff_s).toBeGreaterThanOrEqual(1)
    expect(logs.join('\n')).toContain('unreachable')
    await c.syncNow()                                                       // inside the backoff: not tried
    expect(on.calls.length).toBe(1)
    on.st.down = false; on.st.status5xx = true
    await c.syncNow(true)
    expect(on.store.size).toBe(0); expect(c.pendingBytes()).toBeGreaterThan(0)
    on.st.status5xx = false
    await c.syncNow(true)
    expect(on.store.size).toBe(5); expect(c.pendingBytes()).toBe(0)
    // a crash between the POST and the cursor write: the cursor is back at 0 and everything goes again
    writeFileSync(join(dir, 'cursor.json'), JSON.stringify({ offset: 0 }))
    const again = client(dir, on.f)
    await again.syncNow(true)
    expect(on.store.size).toBe(5)                                           // the server deduped by idem_key
    expect(again.stats.duplicates).toBe(5); expect(again.stats.posted).toBe(0)
  })

  test('a 4xx for one item goes to rejected.jsonl and is not retried; the others go through; a refused batch is sent one by one', async () => {
    const dir = tmp(), on = fakeOnsen()
    const c = client(dir, on.f)
    const bad = inboundItem(AGENT, tgMsg(2, 'bad'), 'bad')
    on.st.refuseKey = bad.idem_key
    c.recordMessage(inboundItem(AGENT, tgMsg(1, 'ok1'), 'ok1')); c.recordMessage(bad); c.recordMessage(inboundItem(AGENT, tgMsg(3, 'ok3'), 'ok3'))
    await c.syncNow(true)
    expect([...on.store.values()].map(r => r.client_msg_id)).toEqual(['1', '3'])
    const rej = readFileSync(join(dir, 'rejected.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(rej.length).toBe(1); expect(rej[0].line.r.idem_key).toBe(bad.idem_key); expect(rej[0].why).toContain('refused by the test')
    expect(c.pendingBytes()).toBe(0)
    await c.syncNow(true)
    expect(readFileSync(join(dir, 'rejected.jsonl'), 'utf8').trim().split('\n').length).toBe(1)
    // the whole batch refused (400): one by one, the bad one rejected (422), the good one kept
    on.st.batch400 = true
    const bad2 = inboundItem(AGENT, tgMsg(5, 'bad2'), 'bad2'); on.st.refuseKey = bad2.idem_key
    c.recordMessage(inboundItem(AGENT, tgMsg(4, 'ok4'), 'ok4')); c.recordMessage(bad2)
    await c.syncNow(true)
    expect([...on.store.values()].map(r => r.client_msg_id)).toEqual(['1', '3', '4'])
    expect(readFileSync(join(dir, 'rejected.jsonl'), 'utf8').trim().split('\n').length).toBe(2)
    expect(on.calls.filter(x => x.path === '/messages').length).toBe(2)
  })

  test('the credential never appears in a log line, the spool or rejected.jsonl (a refused credential is said without it)', async () => {
    const dir = tmp(), on = fakeOnsen(), logs: string[] = []
    const wrong = 'mesh_WRONGwrongWRONGwrongWRONGwrong0000'
    const c = new OnsenClient({ dir, base: 'https://onsen.test/api/onsen', agent: AGENT, record: true, credential: () => wrong, log: (l, m) => logs.push(`${l} ${m}`), fetch: on.f, intervalMs: 3_600_000 })
    c.recordMessage(inboundItem(AGENT, tgMsg(1, 'x'), 'x'))
    await c.syncNow(true)
    expect(on.calls[0]!.headers.authorization).toBe(`Bearer ${wrong}`)    // it is sent, as a header only
    expect(logs.join('\n')).toContain('the credential was not accepted')
    const ok = client(dir, on.f, { logs }); await ok.syncNow(true); await ok.queryHistory({}); await ok.queryHistory({ id: 'tg:1' })
    const everything = [logs.join('\n'), readFileSync(join(dir, 'spool.jsonl'), 'utf8'), existsSync(join(dir, 'rejected.jsonl')) ? readFileSync(join(dir, 'rejected.jsonl'), 'utf8') : '',
      JSON.stringify(ok.health())].join('\n')
    expect(everything).not.toContain(wrong); expect(everything).not.toContain(CRED); expect(everything).not.toContain('mesh_')
  })

  test('the spool rotates when drained and big; the previous generation still answers chat_history locally', async () => {
    const dir = tmp(), on = fakeOnsen()
    const c = new OnsenClient({ dir, base: 'https://onsen.test/api/onsen', agent: AGENT, record: true, credential: () => CRED, log: () => {}, fetch: on.f, intervalMs: 3_600_000, rotateBytes: 200, queryTimeoutMs: 200, joeyChat: () => JOEY })
    c.recordMessage(inboundItem(AGENT, tgMsg(1, '舊的一則 old'), '舊的一則 old'))
    await c.syncNow(true); await c.syncNow(true)
    expect(existsSync(join(dir, 'spool.1.jsonl'))).toBe(true)
    expect(existsSync(join(dir, 'spool.jsonl'))).toBe(false)
    on.st.down = true
    c.recordMessage(inboundItem(AGENT, tgMsg(2, '新的'), '新的'))
    const out = await c.queryHistory({})
    expect(out).toContain('舊的一則 old'); expect(out).toContain('新的')
    on.st.down = false
    await c.syncNow(true)
    expect(on.store.size).toBe(2)
  })

  test('record off: nothing is written', async () => {
    const dir = tmp(), on = fakeOnsen()
    const c = new OnsenClient({ dir, base: 'https://onsen.test/api/onsen', agent: AGENT, record: false, credential: () => CRED, log: () => {}, fetch: on.f })
    c.recordMessage(inboundItem(AGENT, tgMsg(1, 'x'), 'x'))
    expect(existsSync(join(dir, 'spool.jsonl'))).toBe(false)
  })
})

describe('chat_history', () => {
  test('list: oldest first, UTC, who / #id tg:n / text, truncation marked, the count line; the agent credential and X-Onsen-Via: tool go with it', async () => {
    const dir = tmp(), on = fakeOnsen(), c = client(dir, on.f)
    c.recordMessage(inboundItem(AGENT, tgMsg(2166, '第一則\n第二行'), '第一則\n第二行'))
    c.recordMessage(outText('main', 2168, '收到').r as OnsenItem)
    c.recordMessage(outText('chiron.reflex.2', 2170, 'x'.repeat(400)).r as OnsenItem)
    c.recordMessage(withSender('system:duty-officer', () => outboundRecord(AGENT, sendCtx()!, 'sendMessage', { chat_id: JOEY, text: '值班' }, { message_id: 2171, date: 1764022171 }))!.r as OnsenItem)
    await c.syncNow(true)
    const out = await c.queryHistory({ limit: 10 })
    const q = on.calls.find(x => x.path.startsWith('/messages?'))!
    expect(q.headers['x-onsen-via']).toBe('tool'); expect(q.headers.authorization).toBe(`Bearer ${CRED}`)
    expect(new URLSearchParams(q.path.split('?')[1]).get('agent')).toBe(AGENT)
    expect(new URLSearchParams(q.path.split('?')[1]).get('chat')).toBe(JOEY)       // Joey's DM chat by default
    const lines = out.split('\n')
    expect(lines[0]).toMatch(/^\d\d-\d\d \d\d:\d\dZ｜Joey｜#1 tg:2166｜第一則 ⏎ 第二行$/)
    expect(lines[1]).toMatch(/｜main｜#2 tg:2168｜收到$/)
    expect(lines[2]).toMatch(/｜chiron\.reflex\.2｜#3 tg:2170｜x{300}…（全文用 id 取）$/)
    expect(lines[3]).toMatch(/｜系統｜#4 tg:2171｜值班$/)
    expect(lines.at(-1)).toBe('共 4 則，顯示 4 則')
  })

  test('step 2: a hook asks through the daemon (/onsen/history): the same text, counted as X-Onsen-Via: hook, list and one message alike', async () => {
    const dir = tmp(), on = fakeOnsen(), c = client(dir, on.f)
    c.recordMessage(outText('main', 2168, '收到').r as OnsenItem)
    await c.syncNow(true)
    const n0 = on.calls.length
    const out = await c.queryHistory({ limit: 5 }, 'hook')
    expect(out).toMatch(/｜main｜#1 tg:2168｜收到/)
    await c.queryHistory({ id: 'tg:2168' }, 'hook')
    expect(on.calls.slice(n0).map(x => x.headers['x-onsen-via'])).toEqual(['hook', 'hook', 'hook'])
    const src = require('fs').readFileSync(require('path').join(import.meta.dir, 'server.ts'), 'utf8')
    expect(src).toContain("if (!INBOX_ONLY && onsen && u.pathname === '/onsen/history' && req.method === 'GET') {")
    expect(src).toContain("const text = await onsen.queryHistory(args, 'hook')")
  })

  test('id: an Onsen id; tg:<n>; a bare number (Onsen id first, then the Telegram alias); full text with its events', async () => {
    const dir = tmp(), on = fakeOnsen(), c = client(dir, on.f)
    c.recordMessage(outText('main', 2168, 'y'.repeat(500)).r as OnsenItem)
    c.recordEvent(outboundRecord(AGENT, { sender: 'main' }, 'editMessageText', { chat_id: JOEY, message_id: 2168, text: '改過的字' }, { message_id: 2168 })!.r as OnsenEvent)
    c.recordEvent(outboundRecord(AGENT, { sender: `tg:${JOEY}` }, 'setMessageReaction', { chat_id: JOEY, message_id: 2168, reaction: [{ type: 'emoji', emoji: '👍' }] }, true)!.r as OnsenEvent)
    await c.syncNow(true)
    const full = await c.queryHistory({ id: '1' })
    expect(full).toContain('y'.repeat(500))
    expect(full).toContain('main 改成：改過的字'); expect(full).toContain('Joey 按了 👍')
    expect(await c.queryHistory({ id: 'tg:2168' })).toContain('y'.repeat(500))
    const n0 = on.calls.length
    expect(await c.queryHistory({ id: '2168' })).toContain('y'.repeat(500))    // no Onsen #2168: the alias
    expect(on.calls.slice(n0).map(x => x.path)).toEqual(['/messages/2168', `/alias/telegram/${AGENT}/${JOEY}/2168`, '/messages/1'])
    expect(await c.queryHistory({ id: 'tg:9999' })).toContain('找不到')
  })

  test('Onsen silent (no answer in time, down, or no credential): the local spool answers and says so', async () => {
    const dir = tmp(), on = fakeOnsen(), c = client(dir, on.f, { queryTimeoutMs: 150 })
    c.recordMessage(inboundItem(AGENT, tgMsg(10, '本機的一則 hello'), '本機的一則 hello'))
    c.recordMessage(outText('main', 11, '回覆').r as OnsenItem)
    c.recordEvent(outboundRecord(AGENT, { sender: 'main' }, 'editMessageText', { chat_id: JOEY, message_id: 11, text: '回覆（改）' }, { message_id: 11 })!.r as OnsenEvent)
    on.st.hang = true
    const t0 = Date.now()
    const out = await c.queryHistory({})
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(out.split('\n')[0]).toContain('秒內沒回應')
    expect(out).toContain('本機暫存'); expect(out).toMatch(/Joey｜tg:10｜本機的一則 hello/); expect(out).toMatch(/main｜tg:11｜（改過）回覆（改）/)
    expect(out.trim().split('\n').at(-1)).toBe('共 2 則，顯示 2 則')
    on.st.hang = false; on.st.down = true
    expect(await c.queryHistory({ q: 'hello' })).toMatch(/Onsen 連不上[\s\S]*共 1 則，顯示 1 則/)
    expect(await c.queryHistory({ id: 'tg:10' })).toContain('本機的一則 hello')
    const noCred = client(dir, on.f, { cred: null })
    expect(await noCred.queryHistory({})).toContain('沒有 mesh credential')
  })

  test('since / until: ISO or relative; a bad one is said', () => {
    const now = Date.parse('2026-11-25T00:00:00Z')
    expect(parseWhen('2h', now)).toBe('2026-11-24T22:00:00.000Z')
    expect(parseWhen('30m', now)).toBe('2026-11-24T23:30:00.000Z')
    expect(parseWhen('3d', now)).toBe('2026-11-22T00:00:00.000Z')
    expect(parseWhen('2026-11-24T21:00Z', now)).toBe('2026-11-24T21:00:00.000Z')
    expect(parseWhen('', now)).toBeUndefined()
    expect(() => parseWhen('昨天', now)).toThrow('看不懂時間')
    expect(formatList([], 0)).toContain('共 0 則，顯示 0 則')
    expect(formatFull({ id: 7, at: '2026-11-24T21:45:00Z', direction: 'in', sender: 'joey', body: 'b', client_msg_id: '9', events: [] })).toBe('11-24 21:45Z｜Joey｜#7 tg:9\nb')
    // the full row as the live API gives it (fleet-core b82ab67, read 11-25): sender agent:<name> + sender_part, the Telegram id in meta / aliases
    expect(formatFull({ id: 15200, agent: 'epeius', chat: '1828173984', at: '2026-11-24T21:54:34+00:00', direction: 'out', sender: 'agent:epeius', sender_part: 'main', kind: 'text',
      body: 'b', status: 'ok', meta: { source: 'session-jsonl:reply', client_msg_id: '538' }, aliases: [{ client: 'telegram', scope: 'epeius', client_ref: '1828173984:538' }], attachments: [], events: [] }))
      .toBe('11-24 21:54Z｜main｜#15200 tg:538\nb')
    expect(formatFull({ id: 1, at: '2026-11-24T21:54:34Z', direction: 'out', sender: 'agent:epeius', sender_part: 'epeius.reflex.1', body: 'x', aliases: [{ client: 'telegram', client_ref: '1:77' }] }))
      .toBe('11-24 21:54Z｜epeius.reflex.1｜#1 tg:77\nx')
  })

  test('WO-197 (Chiron 18:46Z, 「轉傳自 [object Object]」): a forwarded message names who it came from as the tag does, whatever shape Onsen keeps it in', () => {
    // GET /api/onsen/messages/<id>: forward_from is JSONB (fleet-core onsen._forward): {origin: <the daemon's one-line form>} (switch off, tg:1159),
    // {origin: <the bridge's display name>} (connector, tg:1139)
    const row = (forward_from: unknown) => ({ id: 43683, at: '2026-11-26T17:49:57Z', direction: 'in', sender: 'joey-test', body: 'R4：只回一個字：好', client_msg_id: '1159', forward_from, events: [] })
    expect(formatFull(row({ origin: 'tg:6736970916 @awesometon5 awesometon5' }))).toBe('11-26 17:49Z｜joey-test｜#43683 tg:1159｜轉傳自 awesometon5\nR4：只回一個字：好')
    expect(formatFull(row({ origin: 'awesometon5' }))).toContain('｜轉傳自 awesometon5\n')
    expect(formatFull(row({ origin: 'tg:42 Mary Ann' }))).toContain('｜轉傳自 Mary Ann\n')
    expect(formatFull(row({ origin: 'hidden:Old Friend' }))).toContain('｜轉傳自 Old Friend\n')
    expect(formatFull(row({ origin: 'chat:-1001234 Crypto News (editor)' }))).toContain('｜轉傳自 Crypto News\n')
    expect(formatFull(row('tg:6736970916 @awesometon5'))).toContain('｜轉傳自 awesometon5\n')
    expect(formatFull(row({ username: 'someone', id: 5 }))).toContain('｜轉傳自 someone\n')
    expect(formatFull(row({ origin: 'x' }))).not.toContain('[object Object]')
    expect(forwardName(null)).toBe('')
  })

  test('chat_history is listed for the main (server.ts) and for every lane kind (lanes.ts); the old "ask them to paste" sentence is gone', () => {
    expect(CHAT_HISTORY_TOOL.description.startsWith('查之前講過什麼：你和 Joey 在這裡的每一則問答（他說的、你回的、分身推的）都在 Onsen。')).toBe(true)
    expect(CHAT_HISTORY_TOOL.inputSchema.properties.limit.description).toContain('最多 200')
    expect(LANE_TOOLS.map(t => t.name)).toContain('chat_history')
    for (const k of ['reflex', 'worker', 'mail', 'fork', undefined] as any[]) expect(laneToolsFor(k).map((t: any) => t.name)).toContain('chat_history')
    const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
    expect(src).toContain("...(onsen ? [Onsen.CHAT_HISTORY_TOOL] : []),")
    expect(src).toContain('if (onsen && req.params.name === Onsen.CHAT_HISTORY_TOOL.name) {')
    expect(src).toContain("chatHistory: (a: Record<string, unknown>) => onsen ? onsen.queryHistory(a)")
    expect(src).toContain("'之前講過什麼（你說的、你回的、分身推的）：先用 chat_history 查，最新幾則、一段時間、搜內容都可以；查不到才去翻 session 紀錄。不用請對方再貼一次。',")
    expect(src).not.toContain('For earlier context, ask them to paste or summarize')
    const lanes = readFileSync(join(import.meta.dir, 'lanes.ts'), 'utf8')
    expect(lanes).toContain("case 'chat_history': return D.chatHistory ? D.chatHistory(a ?? {})")
    // the four hooks of the first step: inbound, the main's reply (text and files), edit_message, a lane's / the router's line
    expect(src).toContain('if (!onsenVoice) onsenIn(ctx.message, text)')
    expect(src).toContain("await Onsen.withSender('main', () => sendTextParts(chat_id,")
    expect(src).toContain("await Onsen.withSender('main', () => method === 'sendPhoto' ?")
    expect(src).toContain("await Onsen.withSender('main', () => Onsen.richAttempt(() => callBotApi('editMessageText',")
    expect(src).toContain("await Onsen.withSender('main', () => bot.api.editMessageText(")
    expect(src).toContain("await Onsen.withSender(o.laneId || 'router', () => sendTextParts(chat,")
    expect(lanes).toContain('...(lane ? { laneId: lane.id } : {}) })')
  })
})

describe('WO-162: the newest status does not wait behind a pass', () => {
  test('a status recorded while a slow /messages/batch is in flight reaches Onsen at once; the spool still sends it in order (a duplicate)', async () => {
    const dir = tmp(), posts: Array<{ path: string; at: number; ids: string[] }> = []
    let release: () => void = () => {}
    const gate = new Promise<void>(r => { release = r })
    const f = (async (url: any, init: any) => {
      const path = String(url).replace('https://onsen.test/api/onsen', '')
      const body = JSON.parse(init?.body ?? '{}')
      const items = Array.isArray(body.items) ? body.items : []
      posts.push({ path, at: Date.now(), ids: items.map((x: any) => x.idem_key) })
      if (path === '/messages/batch') await gate                                   // the slow round trip that held the busy rows
      return new Response(JSON.stringify({ results: items.map((_: any, n: number) => ({ id: n + 1, ...(path === '/status/batch' && posts.filter(p => p.path === path).length > 1 ? { duplicate: true } : {}) })) }), { status: 200 })
    }) as unknown as typeof fetch
    const c = new OnsenClient({ dir, base: 'https://onsen.test/api/onsen', agent: AGENT, record: true, credential: () => CRED, log: () => {}, fetch: f, intervalMs: 3_600_000 })
    c.start()
    c.recordMessage(inboundItem(AGENT, tgMsg(1, '一則'), '一則'))
    await new Promise(r => setTimeout(r, 120))                                     // the pass is now waiting on /messages/batch
    const t0 = Date.now()
    c.recordStatus({ idem_key: 'st-busy-1', agent: AGENT, state: 'busy', at: new Date().toISOString(), detail: { tool: { name: 'Bash' } } } as any)
    await new Promise(r => setTimeout(r, 30))
    const fast = posts.find(p => p.path === '/status/batch')
    expect(fast && fast.ids).toEqual(['st-busy-1'])
    expect(fast!.at - t0).toBeLessThan(30)                                          // not behind the pass
    release()
    await new Promise(r => setTimeout(r, 150))
    expect(posts.filter(p => p.path === '/status/batch').length).toBe(2)           // the spool sent it too, in its place
    expect(c.fastStats).toEqual({ sent: 1, failed: 0 })
    c.stop()
  })

  test('fastStatus false: only the spool', async () => {
    const dir = tmp(), on = fakeOnsen()
    const c = new OnsenClient({ dir, base: 'https://onsen.test/api/onsen', agent: AGENT, record: true, credential: () => CRED, log: () => {}, fetch: on.f, intervalMs: 3_600_000, fastStatus: false })
    c.start()
    c.recordStatus({ idem_key: 'st-2', agent: AGENT, state: 'idle', at: new Date().toISOString(), detail: {} } as any)
    await new Promise(r => setTimeout(r, 120))
    expect(c.fastStats.sent).toBe(0)
    c.stop()
  })
})
