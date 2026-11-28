// WO-151 3a / 3b units (onsen-inbox.ts): the dedupe key, the local copy (persistence, crash replay, bounded keys), the pull against an in-process
// stand-in Onsen (first start after Onsen's acked_seq (WO-158), reset, down then up counted by events), the sender's outcome, the mailbox-type url.
import { test, expect, describe } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OnsenInbox, OnsenPuller, OnsenSender, dedupeKeyOf, isMailboxInject, itemKey, switchOn, BASELINE_AFTER, type PullItem, type Req, type HandResult } from './onsen-inbox.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'onsen-inbox-'))
const quiet = () => {}

describe('the key', () => {
  test('explicit dedupe wins, trimmed and cut at 200; else msg:<integer msg_id>; else none', () => {
    expect(dedupeKeyOf('  call:abc ', 5)).toBe('call:abc')
    expect(dedupeKeyOf('x'.repeat(300), undefined)).toBe('x'.repeat(200))
    expect(dedupeKeyOf(undefined, 123)).toBe('msg:123')
    expect(dedupeKeyOf('', 123)).toBe('msg:123')
    expect(dedupeKeyOf(null, '123')).toBeNull()          // a string id is not the BTCC id (as /inject reads msg_id)
    expect(dedupeKeyOf(null, 1.5)).toBeNull()
    expect(dedupeKeyOf(undefined, undefined)).toBeNull()
  })
  test('a pulled item: Onsen\'s dedupe, else dedupe_key, else the payload\'s, else msg:<msg_id>', () => {
    const it = (o: Partial<PullItem>): PullItem => ({ seq: 1, sender: 'eve', payload: { text: 't' }, ...o })
    expect(itemKey(it({ dedupe: 'k1', payload: { text: 't', msg_id: 9 } }))).toBe('k1')
    expect(itemKey(it({ dedupe_key: 'k2' }))).toBe('k2')
    expect(itemKey(it({ payload: { text: 't', dedupe: 'k3' } }))).toBe('k3')
    expect(itemKey(it({ payload: { text: 't', msg_id: 77 } }))).toBe('msg:77')
    expect(itemKey(it({}))).toBeNull()
  })
  test('switches: a comma list or *', () => {
    expect(switchOn('chiron, adam', 'adam')).toBe(true)
    expect(switchOn('*', 'x')).toBe(true)
    expect(switchOn('chiron', 'adam')).toBe(false)
    expect(switchOn(undefined, 'adam')).toBe(false)
    expect(switchOn('', 'adam')).toBe(false)
  })
})

describe('the local copy', () => {
  test('claim / seen / record / release: one arrival of a key passes; a released key is free again', () => {
    const b = new OnsenInbox({ file: join(dir(), 'i.json') })
    expect(b.claim('k')).toBe(true)
    expect(b.claim('k')).toBe(false)                     // in flight
    expect(b.seen('k')).toBe(true)
    b.release('k')
    expect(b.seen('k')).toBe(false)
    expect(b.claim('k')).toBe(true)
    b.record('k')
    expect(b.seen('k')).toBe(true)
    expect(b.claim('k')).toBe(false)
  })
  test('bounded: the oldest key goes first; a re-recorded key is young again', () => {
    const b = new OnsenInbox({ file: join(dir(), 'i.json'), maxKeys: 3 })
    for (const k of ['a', 'b', 'c']) b.record(k)
    b.record('a')
    b.record('d')
    expect(['a', 'b', 'c', 'd'].map(k => b.seen(k))).toEqual([true, false, true, true])
    expect(b.keyCount).toBe(3)
  })
  test('persisted atomically (0600) and read back: keys with times, last_seq, acked_seq, pending; based', () => {
    const f = join(dir(), 'i.json')
    const b = new OnsenInbox({ file: f, now: () => 1_000 })
    b.record('msg:1')
    b.baseline(10)
    b.take([{ seq: 12, sender: 'eve', payload: { text: 'b' } }, { seq: 11, sender: 'eve', payload: { text: 'a' } }, { seq: 9, sender: 'eve', payload: { text: 'old' } }])
    b.handed(11)
    b.acked(11)
    expect(existsSync(`${f}.tmp`)).toBe(false)
    expect(statSync(f).mode & 0o777).toBe(0o600)
    const j = JSON.parse(readFileSync(f, 'utf8'))
    expect(j).toMatchObject({ last_seq: 12, acked_seq: 11, based: true, keys: [['msg:1', 1000]] })
    const c = new OnsenInbox({ file: f })
    expect([c.lastSeq, c.ackedSeq, c.based, c.pending.map(p => p.seq), c.seen('msg:1')]).toEqual([12, 11, true, [12], true])
    expect(c.ackable()).toBe(11)                          // never past an item not yet handed on
  })
  test('a file written only by /inject (the pull never started) is not a starting point', () => {
    const f = join(dir(), 'i.json')
    new OnsenInbox({ file: f }).record('msg:5')
    const c = new OnsenInbox({ file: f })
    expect(c.based).toBe(false)
    expect(c.seen('msg:5')).toBe(true)
  })
  test('reset: continue from Onsen\'s count; keys kept', () => {
    const b = new OnsenInbox({ file: join(dir(), 'i.json') })
    b.baseline(0); b.take([{ seq: 5, sender: 'e', payload: { text: 'x' } }]); b.handed(5); b.acked(5); b.record('msg:5')
    b.reset(3)
    expect([b.lastSeq, b.ackedSeq, b.seen('msg:5')]).toEqual([3, 3, true])
  })
})

// ------------------------------------------------------------------ a stand-in Onsen in this process (onsen5.py's contract) and the pull against it
function standIn(o: { noAckedSeq?: boolean } = {}) {
  const items: PullItem[] = []
  let last = 0, acked = 0, down = false, polls = 0
  const keys = new Map<string, number>()
  const req: Req = async (m, path, body) => {
    await new Promise(r => setTimeout(r, 1))             // a real round trip yields to the timers
    if (down) throw new Error('ECONNREFUSED (test)')
    const u = new URL(`http://x${path}`)
    if (m === 'GET' && u.pathname === '/inbox') {
      polls++
      const after = Number(u.searchParams.get('after'))
      if (after > last) return { status: 200, json: { items: [], reset: true, continue_after: last, last_seq: last } }
      return { status: 200, json: { items: items.filter(i => i.seq > after).slice(0, Number(u.searchParams.get('limit') ?? 100)).map(i => ({ ...i })), last_seq: last, ...(o.noAckedSeq ? {} : { acked_seq: acked }) } }
    }
    if (m === 'POST' && u.pathname === '/inbox/ack') { acked = Math.max(acked, Math.min((body as any).upto, last)); return { status: 200, json: { acked: 1 } } }
    return { status: 404, json: {} }
  }
  const put = (text: string, dedupe?: string, msg_id?: number) => {
    const k = dedupe ?? (msg_id != null ? `msg:${msg_id}` : undefined)
    if (k && keys.has(k)) return keys.get(k)!
    const seq = ++last
    items.push({ seq, sender: 'eve', relay: null, kind: 'call', payload: { text, ...(msg_id != null ? { msg_id } : {}) }, ...(dedupe ? { dedupe } : {}) })
    if (k) keys.set(k, seq)
    return seq
  }
  return { req, put, items, get acked() { return acked }, get polls() { return polls }, set down(v: boolean) { down = v }, lose: (n: number) => { for (const it of items.splice(-n)) for (const [k, v] of keys) if (v === it.seq) keys.delete(k); last -= n } }
}
function puller(on: ReturnType<typeof standIn>, b: OnsenInbox, got: string[], deliver?: (it: PullItem) => Promise<HandResult>) {
  return new OnsenPuller({ req: on.req, base: 'test', inbox: b, log: quiet, host: 'h', waitS: 0, minBackoffMs: 5, maxBackoffMs: 20,
    deliver: deliver ?? (async it => { const k = itemKey(it); if (k && !b.claim(k)) return 'duplicate'; got.push(String(it.payload.text)); if (k) b.record(k); return 'delivered' }) })
}

describe('the pull', () => {
  test('the legacy inbox exposes the member mode to reminders, including when only the tg daemon opted in', async () => {
    let status = 409
    const p = new OnsenPuller({ inbox: new OnsenInbox({ file: join(dir(), 'i.json') }), base: 'test', host: 'h', log: quiet,
      req: async () => ({ status, json: { acked_seq: 0 } }), deliver: async () => 'delivered' })
    await p.once().catch(() => {})
    expect(p.mode.active).toBe(true)
    status = 200
    await p.once()
    expect(p.mode.active).toBe(false)
  })
  test('first start (no local copy, WO-158): starts after Onsen\'s acked_seq; a new agent (nothing acked) gets the 3 items sent before its first poll, then a 4th once', async () => {
    const on = standIn(), got: string[] = [], logs: string[] = []
    for (const t of ['old-1', 'old-2', 'old-3']) on.put(t)
    const b = new OnsenInbox({ file: join(dir(), 'i.json') })
    const p = new OnsenPuller({ req: on.req, base: 'test', inbox: b, log: (_l, m) => logs.push(m), host: 'h', waitS: 0, minBackoffMs: 5, maxBackoffMs: 20,
      deliver: async it => { got.push(String(it.payload.text)); return 'delivered' } })
    await p.once()                                        // the baseline: GET after=0 → acked_seq 0
    expect([b.lastSeq, b.based, p.stats.baseline]).toEqual([0, true, 0])
    expect(logs.join('\n')).toContain('starting after seq 0 (the last acked in Onsen); 3 item(s) not acked yet are handed on')
    await p.once()
    expect(got).toEqual(['old-1', 'old-2', 'old-3'])
    on.put('new-4')
    await p.once(); await p.once()
    expect(got).toEqual(['old-1', 'old-2', 'old-3', 'new-4'])
    expect(on.acked).toBe(4)
  })
  test('first start after a lost state file: what a daemon of this agent acked is not given again; what it did not ack is', async () => {
    const on = standIn(), got: string[] = []
    for (const t of ['a', 'b', 'c']) on.put(t)
    await on.req('POST', '/inbox/ack', { upto: 2 })      // the previous daemon took and acked a and b, then its state file was lost
    const b = new OnsenInbox({ file: join(dir(), 'i.json') })
    const p = puller(on, b, got)
    await p.once(); await p.once()
    expect([p.stats.baseline, got]).toEqual([2, ['c']])
  })
  test('first start against an Onsen that gives no acked_seq: its count, the earlier items skipped (1.51.0)', async () => {
    const on = standIn({ noAckedSeq: true }), got: string[] = []
    for (const t of ['old-1', 'old-2', 'old-3']) on.put(t)
    const b = new OnsenInbox({ file: join(dir(), 'i.json') })
    const p = puller(on, b, got)
    await p.once()                                        // after past any count → reset → continue_after 3
    expect([b.lastSeq, b.based, p.stats.baseline]).toEqual([3, true, 3])
    await p.once()
    expect(got).toEqual([])
    expect(BASELINE_AFTER).toBeLessThan(2 ** 63)
  })
  test('in seq order, acked after the hand-off; an item given again is not taken twice', async () => {
    const on = standIn(), got: string[] = []
    const b = new OnsenInbox({ file: join(dir(), 'i.json') }); b.baseline(0)
    for (const t of ['a', 'b', 'c']) on.put(t)
    const p = puller(on, b, got)
    await p.once()
    expect(got).toEqual(['a', 'b', 'c'])
    expect([b.lastSeq, b.ackedSeq, on.acked, p.stats.taken, p.stats.delivered, p.stats.unkeyed]).toEqual([3, 3, 3, 3, 3, 3])
    b.ackedSeq = 0                                       // as if the ack had been lost: Onsen gives them again; they are at or below last_seq
    await p.once()
    expect(got).toEqual(['a', 'b', 'c'])
  })
  test('crash between take and hand-off: the pending item is handed on once at the next start, then the poll goes on', async () => {
    const f = join(dir(), 'i.json'), on = standIn()
    const b1 = new OnsenInbox({ file: f }); b1.baseline(0)
    on.put('x', 'call:1'); on.put('y', 'call:2')
    let n = 0
    const crash = puller(on, b1, [], async () => { if (++n === 2) throw new Error('process killed (test)'); return 'delivered' })
    await expect(crash.once()).rejects.toThrow('killed')
    // the first item was handed on (and its key recorded by the delivery); the second stays pending in the file
    const got: string[] = []
    const b2 = new OnsenInbox({ file: f })
    expect(b2.pending.map(p => p.seq)).toEqual([2])
    const p2 = puller(on, b2, got)
    await p2.once()
    expect(got).toEqual(['y'])
    expect(p2.stats.replayed).toBe(1)
    expect([b2.pending.length, on.acked]).toEqual([0, 2])
  })
  test('reset (Onsen lost the last two): continue from its count; a repeat of a delivered key is dropped, a new item delivered', async () => {
    const on = standIn(), got: string[] = []
    const b = new OnsenInbox({ file: join(dir(), 'i.json') }); b.baseline(0)
    on.put('a', 'k-a'); on.put('b', 'k-b'); on.put('c', 'k-c')
    const p = puller(on, b, got)
    await p.once()
    on.lose(2)                                            // a standby promoted without b and c
    await p.once()
    expect([p.stats.resets, b.lastSeq]).toEqual([1, 1])
    on.put('c', 'k-c'); on.put('d', 'k-d')                // the sender's retry of c (same key) and a new one: seq 2, 3 again
    await p.once()
    expect(got).toEqual(['a', 'b', 'c', 'd'])
    expect(p.stats.dup_dropped).toBe(1)
  })
  test('Onsen down while 5 items are queued, then up (counted by events): all 5 delivered in order, none twice; the loop backed off', async () => {
    const on = standIn(), got: string[] = [], logs: string[] = []
    const b = new OnsenInbox({ file: join(dir(), 'i.json') }); b.baseline(0)
    const p = new OnsenPuller({ req: on.req, base: 'test', inbox: b, log: (_l, m) => logs.push(m), host: 'h', waitS: 0, minBackoffMs: 5, maxBackoffMs: 20,
      deliver: async it => { const k = itemKey(it)!; if (!b.claim(k)) return 'duplicate'; got.push(String(it.payload.text)); b.record(k); return 'delivered' } })
    on.down = true
    p.start()
    await new Promise(r => setTimeout(r, 60))
    for (let i = 1; i <= 5; i++) on.put(`m${i}`, `call:${i}`)
    await new Promise(r => setTimeout(r, 30))
    expect(got).toEqual([])
    expect(p.stats.errors).toBeGreaterThan(1)
    on.down = false
    const end = Date.now() + 3000
    while (got.length < 5 && Date.now() < end) await new Promise(r => setTimeout(r, 10))
    await p.stop()
    expect(got).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
    expect(on.acked).toBe(5)
    expect(logs.some(l => l.includes('retrying in'))).toBe(true)
    expect(logs.some(l => l.includes('answers again'))).toBe(true)
  })
  test('no credential: the pull waits; nothing taken', async () => {
    const b = new OnsenInbox({ file: join(dir(), 'i.json') })
    const p = new OnsenPuller({ req: async () => null, base: 'test', inbox: b, log: quiet, host: 'h', deliver: async () => 'delivered' })
    await expect(p.once()).rejects.toBeDefined()
    expect(b.based).toBe(false)
  })
})

describe('an item answered later (WO-194 A.2, Chiron 11:35Z)', () => {
  test('a person_message its Telegram daemon does not take stays in its place (not acked) and is tried again every 30 s; the items behind it go on', async () => {
    const on = standIn(), got: string[] = [], logs: string[] = [], tries: Array<{ text: string; again: boolean; at: number }> = []
    let clock = 1_000_000, tgUp = false
    const b = new OnsenInbox({ file: join(dir(), 'i.json'), now: () => clock })
    b.baseline(0)
    const p = new OnsenPuller({ req: on.req, base: 'test', inbox: b, log: (_l, m) => logs.push(m), host: 'h', waitS: 25, minBackoffMs: 5, maxBackoffMs: 20, now: () => clock,
      deliver: async (it, again) => {
        const text = String(it.payload.text)
        if (text.startsWith('person')) { tries.push({ text, again: !!again, at: clock }); if (!tgUp) return 'later' }
        const k = itemKey(it); if (k && !b.claim(k)) return 'duplicate'
        got.push(text); if (k) b.record(k); return 'delivered'
      } })
    on.put('person 1', 'pm:1'); on.put('call 2', 'c2'); on.put('person 3', 'pm:3'); on.put('call 4', 'c4')
    await p.once()
    // the two calls behind are delivered at once; both person items are kept, in their place; nothing is acked past the first kept one
    expect(got).toEqual(['call 2', 'call 4'])
    expect(b.pending.map(i => i.seq)).toEqual([1, 3])
    expect(on.acked).toBe(0)
    expect(p.health()).toMatchObject({ held: 2, holding: 2, pending: 2 })
    expect(logs.filter(l => /not taken: kept in its place \(not acked\), tried again every 30 s/.test(l)).length).toBe(2)
    // the long poll waits no longer than the first one's retry (25 s asked, 30 s left: 25; then 5)
    clock += 10_000
    await p.once()
    expect(tries.length).toBe(2)                          // 10 s later: not tried again
    on.put('call 5', 'c5')
    await p.once()
    expect(got).toEqual(['call 2', 'call 4', 'call 5'])   // a new item behind them still goes on
    expect(on.acked).toBe(0)
    clock += 20_000                                       // 30 s after: tried again (once each, marked as a retry), still not taken
    await p.once()
    expect(tries.map(t => [t.text, t.again])).toEqual([['person 1', false], ['person 3', false], ['person 1', true], ['person 3', true]])
    expect(logs.filter(l => /not taken: kept/.test(l)).length).toBe(2)   // logged once each
    tgUp = true
    clock += 30_000
    await p.once()
    expect(got).toEqual(['call 2', 'call 4', 'call 5', 'person 1', 'person 3'])
    expect(b.pending.length).toBe(0)
    expect(on.acked).toBe(5)                              // now everything is acked
    expect(p.health()).toMatchObject({ held: 2, held_then_delivered: 2, holding: 0 })
    expect(logs.some(l => /item 1 \(call\) handed on after it was kept \(delivered\)/.test(l))).toBe(true)
  })
  test('a restart tries a kept item at once; the long poll wait is cut to the kept item\'s retry', async () => {
    const on = standIn(), asked: string[] = []
    let clock = 5_000_000
    const req: Req = async (m, path, body, t) => { if (m === 'GET') asked.push(path); return on.req(m, path, body, t) }
    const f = join(dir(), 'i.json')
    const b = new OnsenInbox({ file: f, now: () => clock }); b.baseline(0)
    on.put('person 1', 'pm:1')
    const p = new OnsenPuller({ req, base: 'test', inbox: b, log: quiet, host: 'h', waitS: 25, minBackoffMs: 5, maxBackoffMs: 20, now: () => clock, laterMs: 7_000,
      deliver: async () => 'later' })
    await p.once()
    expect(asked.at(-1)).toContain('wait=25')             // nothing kept yet: the usual wait; the item taken is kept, due in 7 s
    await p.once()
    expect(asked.at(-1)).toContain('wait=7')
    clock += 5_000
    await p.once()
    expect(asked.at(-1)).toContain('wait=2')
    const b2 = new OnsenInbox({ file: f, now: () => clock })
    expect(b2.pending.map(i => i.seq)).toEqual([1])        // on disk, still pending
    let tried = 0
    const p2 = new OnsenPuller({ req: on.req, base: 'test', inbox: b2, log: quiet, host: 'h', waitS: 0, minBackoffMs: 5, maxBackoffMs: 20, now: () => clock,
      deliver: async () => { tried++; return 'delivered' } })
    await p2.once()
    expect([tried, b2.pending.length, on.acked]).toEqual([1, 0, 1])
  })
})

describe('the sender', () => {
  test('stored / duplicate / pulling from Onsen\'s answer; a failure never throws and says why', async () => {
    const sent: any[] = []
    let answer: any = { status: 200, json: { results: [{ to: 'eve', seq: 4, duplicate: false, pulling: true }] } }
    const s = new OnsenSender({ req: async (_m, _p, b) => { sent.push(b); if (answer instanceof Error) throw answer; return answer }, log: quiet })
    expect(await s.send('eve', 'peer_call', { text: 'hi' }, 'msg:9', { refs: { btcc_msg_id: 9 }, no_reply: true })).toEqual({ stored: true, duplicate: false, pulling: true })
    expect(sent[0]).toEqual({ to: 'eve', kind: 'peer_call', payload: { text: 'hi' }, dedupe: 'msg:9', refs: { btcc_msg_id: 9 }, no_reply: true })
    answer = { status: 200, json: { results: [{ to: 'eve', seq: 4, duplicate: true, pulling: false }] } }
    expect(await s.send('eve', 'peer_call', { text: 'hi' }, 'msg:9')).toEqual({ stored: true, duplicate: true, pulling: false })
    answer = { status: 200, json: { results: [{ to: 'eve', seq: 5, duplicate: false, pulling: false }] } }
    expect(await s.send('eve', 'peer_call', { text: 'later' }, 'msg:10')).toEqual({ stored: true, duplicate: false, pulling: false })
    answer = new Error('down')
    expect(await s.send('eve', 'peer_call', { text: 'hi' }, null)).toEqual({ stored: false, duplicate: false, pulling: false, error: 'down' })
    answer = { status: 400, json: { detail: 'payload.text is required' } }
    expect(await s.send('eve', 'peer_call', {}, null)).toEqual({ stored: false, duplicate: false, pulling: false, error: 'HTTP 400 payload.text is required' })
    const none = new OnsenSender({ req: async () => null, log: quiet })
    expect((await none.send('eve', 'peer_call', { text: 'x' }, null)).error).toBe('no mesh credential')
    expect(s.stats).toMatchObject({ sent: 3, duplicate: 1, not_pulling: 2, failed: 2 })
  })
})

describe('the roster url of a mailbox-type identity (WO-158)', () => {
  test('BTCC\'s /api/mesh/mailbox/<name>/inject only', () => {
    expect(isMailboxInject('https://btcc.blocktempo.ai/api/mesh/mailbox/bt-app-codex/inject')).toBe(true)
    expect(isMailboxInject('https://btcc.blocktempo.ai/api/mesh/mailbox/bt-app-codex/inject/')).toBe(true)
    expect(isMailboxInject('http://127.0.0.1:17696/inject')).toBe(false)
    expect(isMailboxInject('https://steropes-inbox.fud.city/relay/atlas')).toBe(false)
    expect(isMailboxInject('https://inbox.mbp.fud.city/inject')).toBe(false)
    expect(isMailboxInject('https://x/api/mesh/mailbox/a/b/inject')).toBe(false)
    expect(isMailboxInject('not a url')).toBe(false)
    expect(isMailboxInject(undefined)).toBe(false)
  })
})
