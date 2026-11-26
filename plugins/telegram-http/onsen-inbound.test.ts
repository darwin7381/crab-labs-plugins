// WO-194 onsen-inbound.ts: the switch, the facts kept until a message comes back (on disk, once), A in arrival order (retries, the 15 s notice, refused)
import { test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { InboundStore, InboundWriter, inboundOn, inboundEffective, hasInboxPartner, clientMetaOf, applyClientMeta, CLIENT_META_FIXED, TG_OWN_FILE_NAME, heldText, type Job, type Facts } from './onsen-inbound.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const until = async (fn: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(10) } return false }
const dir = () => mkdtempSync(join(tmpdir(), 'onsen-inbound-'))
const noLog = () => {}
const facts = (id: number): Facts => ({ chat_id: '1828', msgId: id, text: `t${id}`, from: { id: 1828, username: 'joey' }, date: 1, fromReply: false, rfm: {} })
const job = (id: number): Job => ({ key: `1828:${id}`, item: { idem_key: `tg:adam:1828:in:${id}`, agent: 'adam', client: 'telegram', chat: '1828', direction: 'in', sender: 'tg:1828',
  body: `t${id}`, kind: 'text', sent_at: '2026-11-26T00:00:00.000Z', client_msg_id: String(id), status: 'ok', backfilled: false, deliver: true } as any, at: Date.now(), tries: 0, held: false })

test('the switch: off by default; a list of agents or *', () => {
  for (const v of [undefined, '', '0', 'off', 'false', 'no']) expect(inboundOn(v, 'adam')).toBe(false)
  expect(inboundOn('lab-relay, adam', 'adam')).toBe(true)
  expect(inboundOn('lab-relay', 'adam')).toBe(false)
  expect(inboundOn('*', 'adam')).toBe(true)
  expect(heldText('adam')).toBe('Onsen 現在連不上，這一則還沒交給 adam；連上會自動補交，不用重傳。')
})

test('WO-197: the switch takes effect only with an agent-inbox partner (LANES_INBOX_PORT): a roamer named by * stays on the path before', () => {
  expect(hasInboxPartner({ LANES_INBOX_PORT: '17680' })).toBe(true)
  for (const v of [undefined, '', '0', 'x']) expect(hasInboxPartner({ LANES_INBOX_PORT: v })).toBe(false)
  expect(inboundEffective('*', 'roamer-mbp', false)).toBe(false)
  expect(inboundEffective('roamer-mbp', 'roamer-mbp', false)).toBe(false)
  expect(inboundEffective('*', 'adam', true)).toBe(true)
  expect(inboundEffective('0', 'adam', true)).toBe(false)
  expect(inboundEffective('lab-relay', 'adam', true)).toBe(false)
})

test('WO-197: client.meta → tag attributes: every key as is (no key named here); other JSON values as their text; not an attribute name: left out', () => {
  expect(clientMetaOf({ meta: { a: '1', b: 'x y', reply_to_user_id: '42', n: 3, o: { k: 1 } } })).toEqual({ a: '1', b: 'x y', reply_to_user_id: '42', n: '3', o: '{"k":1}' })
  for (const c of [null, {}, { meta: null }, { meta: [] }, { meta: {} }, { meta: { '1x': 'a', 'a-b': 'b', z: null } }]) expect(clientMetaOf(c)).toBe(null)
})

test('WO-197 rule A (Chiron 16:1xZ): client.meta over the tag\'s own values, a new key last; the fixed list (chat_id, message_id, ts, source, topic, user_id) never', () => {
  const meta: Record<string, string> = { chat_id: '1828', message_id: '5', user: 'joey', user_id: '1828', ts: 'T', topic: '3', reply_to_user: 'joey-test', reply_to_text: 'x' }
  applyClientMeta(meta, { reply_to_user: 'awesometon5', chat_id: '9', message_id: '9', ts: 'U', source: 's', topic: '9', user_id: '9', forward_origin: 'user' })
  expect(meta).toEqual({ chat_id: '1828', message_id: '5', user: 'joey', user_id: '1828', ts: 'T', topic: '3', reply_to_user: 'awesometon5', reply_to_text: 'x', forward_origin: 'user' })
  expect(Object.keys(meta).at(-1)).toBe('forward_origin')
  expect([...CLIENT_META_FIXED].sort()).toEqual(['chat_id', 'message_id', 'source', 'topic', 'ts', 'user_id'])
  applyClientMeta(meta, null); applyClientMeta(meta, undefined)
  expect(meta.reply_to_user).toBe('awesometon5')
  // a local image path is never taken from client.meta (the agent Reads it), nor added
  const img: Record<string, string> = { chat_id: '1', image_path: '/home/x/.telegram-state/inbox/a.jpg' }
  applyClientMeta(img, { image_path: '/etc/passwd', image_path_2: '/etc/shadow', image_pathx: 'kept' })
  expect(img).toEqual({ chat_id: '1', image_path: '/home/x/.telegram-state/inbox/a.jpg', image_pathx: 'kept' })
})

test('WO-197 (lab 1007): Telegram\'s own file name (a nameless file\'s, the file path\'s last part) is told from a name the person gave', () => {
  for (const n of ['file_7.oga', 'file_9.mp4', 'file_12', 'file_0.jpg']) expect(TG_OWN_FILE_NAME.test(n)).toBe(true)
  for (const n of ['r.pdf', 'song.mp3', 'file_7.oga.pdf', 'my file_7.oga', 'file_x.oga', '👍']) expect(TG_OWN_FILE_NAME.test(n)).toBe(false)
})

test('the store: facts kept on disk until delivered; then remembered (a second hand-over is a duplicate), across a restart', () => {
  const file = join(dir(), 'store.json')
  const a = new InboundStore({ file, log: noLog })
  a.park('1828:5', facts(5))
  expect(a.viaOnsen('1828:5')).toBe(true)
  const b = new InboundStore({ file, log: noLog })                  // a restart keeps them
  expect(b.take('1828:5')?.text).toBe('t5')
  b.finish(['1828:5', 'pm:77'])
  const c = new InboundStore({ file, log: noLog })
  expect(c.get('1828:5')).toBeUndefined()
  expect(c.isDone('1828:5') && c.isDone('pm:77') && c.viaOnsen('1828:5')).toBe(true)
  expect(c.update('1828:6', () => {})).toBe(false)
})

test('A: in arrival order, one at a time; a message waits behind one Onsen did not take; retried 1 s / 3 s / 10 s (here shortened), then written', async () => {
  const seen: string[] = [], written: string[] = []
  let fail = 2
  const w = new InboundWriter({ file: join(dir(), 'q.json'), log: noLog, retryMs: [30, 30, 30], heldMs: 10_000, laterMs: 50,
    request: async (_m, _p, body: any) => { seen.push(body.client_msg_id); if (body.client_msg_id === '1' && fail-- > 0) return { status: 503, json: { detail: 'down' } }; return { status: 200, json: { id: 900 + Number(body.client_msg_id), duplicate: false } } },
    written: (j, id) => written.push(`${j.key}=${id}`), held: () => {}, refused: () => {} })
  w.enqueue(job(1)); w.enqueue(job(2))
  expect(await until(() => written.length === 2)).toBe(true)
  expect(written).toEqual(['1828:1=901', '1828:2=902'])
  expect(seen).toEqual(['1', '1', '1', '2'])                         // 2 never went before 1 was in
  expect(w.health()).toMatchObject({ written: 2, retries: 2, waiting: 0 })
})

test('A: not written 15 s after it came (here 300 ms): the person is told once per message; it keeps being tried, then goes on (late)', async () => {
  let down = true
  const held: string[] = [], written: Array<[string, boolean]> = []
  const w = new InboundWriter({ file: join(dir(), 'q.json'), log: noLog, retryMs: [20, 20, 20], heldMs: 300, laterMs: 100,
    request: async () => down ? { status: 500, json: { detail: 'database is down' } } : { status: 200, json: { id: 1, duplicate: false } },
    written: (j, _id, _d, late) => written.push([j.key, late]), held: j => held.push(j.key), refused: () => {} })
  w.enqueue(job(1)); await sleep(150); w.enqueue(job(2))
  expect(await until(() => held.length === 2, 3000)).toBe(true)
  await sleep(400)
  expect(held).toEqual(['1828:1', '1828:2'])                          // once each
  expect(written).toEqual([])
  down = false
  expect(await until(() => written.length === 2, 3000)).toBe(true)
  expect(written).toEqual([['1828:1', true], ['1828:2', true]])
  expect(w.health()).toMatchObject({ held: 2, late: 2, waiting: 0 })
})

test('A: refused (4xx) or no credential: never retried, handed back to be delivered here; a duplicate (same idem_key) counts as written', async () => {
  const refused: string[] = [], written: Array<[string, boolean]> = []
  const w = new InboundWriter({ file: join(dir(), 'q.json'), log: noLog, retryMs: [10],
    request: async (_m, _p, body: any) => body.client_msg_id === '1' ? { status: 400, json: { detail: 'bad' } } : body.client_msg_id === '2' ? null : { status: 200, json: { id: 5, duplicate: true } },
    written: (j, _id, dup) => written.push([j.key, dup]), held: () => {}, refused: j => refused.push(j.key) })
  w.enqueue(job(1)); w.enqueue(job(2)); w.enqueue(job(3))
  expect(await until(() => written.length === 1)).toBe(true)
  expect(refused).toEqual(['1828:1', '1828:2'])
  expect(written).toEqual([['1828:3', true]])
})

test('A: the queue is on disk: a restart writes what was not written yet, first; an edit of a waiting message rewrites its text', async () => {
  const file = join(dir(), 'q.json')
  const a = new InboundWriter({ file, log: noLog, retryMs: [5000], request: async () => ({ status: 502, json: {} }), written: () => {}, held: () => {}, refused: () => {} })
  a.enqueue(job(7))
  await sleep(50)
  expect(a.rewrite('1828:7', 'edited')).toBe(true)
  const bodies: string[] = []
  const b = new InboundWriter({ file, log: noLog, request: async (_m, _p, body: any) => { bodies.push(body.body); return { status: 200, json: { id: 1 } } }, written: () => {}, held: () => {}, refused: () => {} })
  expect(await until(() => bodies.length === 1)).toBe(true)
  expect(bodies).toEqual(['edited'])
  expect(await until(() => b.size === 0)).toBe(true)
})

test('point 8: an edit of a message still waiting to be written goes into the same queue behind it (POST /events after the message, on disk); refused: dropped', async () => {
  const file = join(dir(), 'q.json'), calls: string[] = [], written: string[] = [], logs: string[] = []
  let down = true
  const ev = (id: number, body: string) => ({ idem_key: `tg:adam:1828:edit:${id}:9`, agent: 'adam', client: 'telegram', chat: '1828', target_client_msg_id: String(id), kind: 'edit', actor: 'tg:1828', body, at: '2026-11-26T00:00:09.000Z' })
  const request = async (_m: string, path: string, body: any) => {
    calls.push(`${path} ${body.client_msg_id ?? body.target_client_msg_id}:${body.body}${down ? ' (down)' : ''}`)
    if (down) return { status: 503, json: {} }
    if (path === '/events' && body.target_client_msg_id === '3') return { status: 404, json: { detail: 'no message' } }
    return { status: 200, json: path === '/events' ? { id: 77, duplicate: false } : { id: 900 + Number(body.client_msg_id), duplicate: false } }
  }
  const opts = { file, log: (_l: string, m: string) => logs.push(m), retryMs: [20, 20, 20], heldMs: 10_000, laterMs: 40,
    written: (j: Job) => written.push(j.key), held: () => {}, refused: () => {} }
  let gone = false                                                  // the first daemon stops: its requests never come back
  const w = new InboundWriter({ ...opts, request: (m, p, b) => gone ? new Promise(() => {}) : request(m, p, b) })
  w.enqueue(job(1)); w.enqueue(job(2))
  expect(await until(() => calls.length >= 1)).toBe(true)
  // the edit of 1 while it waits (A already tried with the old text): rewritten, and its event queued behind 1 and 2
  expect(w.rewrite('1828:1', 't1 改')).toBe(true)
  expect(w.after('1828:1', ev(1, 't1 改'))).toBe(true)
  expect(w.after('1828:9', ev(9, 'x'))).toBe(false)               // not waiting here: the caller records it the usual way
  expect(w.pending('1828:1')?.key).toBe('1828:1')                  // pending() finds messages only
  expect(w.size).toBe(3)
  gone = true
  // a restart while Onsen is down: the event job is read back from disk, behind its message
  const w2 = new InboundWriter({ ...opts, request })
  expect(w2.size).toBe(3)
  down = false
  expect(await until(() => w2.size === 0)).toBe(true)
  const at = (s: string) => calls.indexOf(s)
  expect(at('/messages 1:t1 改')).toBeGreaterThan(-1)
  expect(at('/messages 1:t1 改')).toBeLessThan(at('/events 1:t1 改'))
  expect(at('/messages 2:t2')).toBeLessThan(at('/events 1:t1 改'))    // in arrival order: the edit came after 2 was queued
  expect(calls.filter(c => c.startsWith('/events') && !c.endsWith('(down)')).length).toBe(1)
  expect(w2.health()).toMatchObject({ edits_after: 1, waiting: 0 })
  expect(written).toEqual(['1828:1', '1828:2'])                     // written() is for messages only
  expect(logs.some(l => /the edit of 1828:1 made while it waited to be written is in Onsen now, after the message/.test(l))).toBe(true)
  // an edit event Onsen refuses (4xx): dropped, nothing else happens
  down = true
  w2.enqueue(job(3))
  expect(w2.after('1828:3', ev(3, 't3 改'))).toBe(true)
  down = false
  expect(await until(() => w2.size === 0)).toBe(true)
  expect(logs.some(l => /the edit of 1828:3 not taken by Onsen \(HTTP 404 no message\): dropped/.test(l))).toBe(true)
  expect(written).toEqual(['1828:1', '1828:2', '1828:3'])
})
