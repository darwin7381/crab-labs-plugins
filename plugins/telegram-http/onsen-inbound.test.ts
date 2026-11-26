// WO-194 onsen-inbound.ts: the switch, the facts kept until a message comes back (on disk, once), A in arrival order (retries, the 15 s notice, refused)
import { test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { InboundStore, InboundWriter, inboundOn, heldText, type Job, type Facts } from './onsen-inbound.ts'

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
