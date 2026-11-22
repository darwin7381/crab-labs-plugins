import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  DOORBELL_DIR, HubSync, STATE_FILE, drainLeftoverDoorbells, gcState, hubSyncMode, loadState, parsePending, seenIn,
  payloadNotif, type HubOpts, type HubState, type Notif,
} from './hub-sync.ts'
import { msgIdKey, receivedIn } from './receipt.ts'

const DAY = 24 * 3600 * 1000

// How Claude Code 2.1.322 records a channel notification it took: a queue-operation enqueue line whose content is the
// rendered <channel …> tag, every meta attribute verbatim and space-separated (receipt.test.ts has the real form).
function rendered(n: Notif): string {
  const p = n.params as { content: string; meta: Record<string, string> }
  const attrs = Object.entries(p.meta).map(([k, v]) => `${k}="${v}"`).join(' ')
  return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date().toISOString(),
    content: `<channel source="plugin:agent-inbox:agent-inbox" ${attrs}>\n${p.content}\n</channel>` })
}

const payload = (text: string, extra: Record<string, unknown> = {}) => ({
  content: text, meta: { user: 'chiron', user_id: 'local-inject', via: 'local-inject', verified: 'true', relay: 'btcc',
    ts: '2026-11-17T15:00:00.000Z', ...extra },
})
const injectNotif = (id: number, text = 'from /inject'): Notif => ({ method: 'notifications/claude/channel',
  params: { content: text, meta: { chat_id: 'owner', user: 'chiron', ts: '2026-11-17T15:00:01.000Z', btcc_msg_id: String(id) } } })

/** A fake hub (pending/taken), a fake session, a fake transcript, a clock. */
function rig(o: Partial<HubOpts> & { dir?: string } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'hub-sync-'))
  const hub = new Map<number, { payload: unknown; received_at: number | null }>()
  const calls: Array<{ method: string; path: string; body?: any }> = []
  const r = {
    dir, hub, calls,
    mode: 'ok' as 'ok' | '404' | 'down' | '500' | 'hang',
    takenMode: 'ok' as 'ok' | '404' | '500',
    t: 1_800_000_000_000,
    ready: true,
    cred: true,
    pushed: [] as Notif[],
    transcript: [] as string[],
    dispatched: [] as Notif[],
    logs: [] as string[],
    walled: false,                                   // WO-120 hold
    ate: (_at: number): boolean => false,            // WO-120 wallAte
    add(id: number, p: unknown = payload(`msg ${id}`)) { hub.set(id, { payload: p, received_at: null }) },
    record(n: Notif) { r.transcript.push(rendered(n)) },
    gets() { return calls.filter(c => c.path.endsWith('/pending')).length },
    takenPosts() { return calls.filter(c => c.path.endsWith('/taken')) },
    sync: null as unknown as HubSync,
    make(extra: Partial<HubOpts> = {}) {
      r.sync = new HubSync({
        base: 'http://hub.test',
        auth: () => (r.cred ? { Authorization: 'Bearer mesh_test' } : {}),
        fetch: (async (url: string, init?: RequestInit) => {
          const path = new URL(url).pathname
          const body = init?.body ? JSON.parse(String(init.body)) : undefined
          calls.push({ method: init?.method ?? 'GET', path, body })
          if (r.mode === 'hang') return new Promise(() => {})
          if (r.mode === 'down') throw new Error('ECONNREFUSED')
          if (path === '/api/mesh/inbox/pending') {
            if (r.mode === '404') return new Response('{"detail":"Not Found"}', { status: 404 })
            if (r.mode === '500') return new Response('boom', { status: 500 })
            const rows = [...hub].filter(([, v]) => v.received_at == null).map(([id, v]) => ({ id, payload: v.payload }))
            return Response.json({ rows })
          }
          if (path === '/api/mesh/inbox/taken') {
            if (r.takenMode === '404') return new Response('{}', { status: 404 })
            if (r.takenMode === '500') return new Response('{}', { status: 500 })
            let updated = 0
            const ignored: number[] = []
            for (const id of body.msg_ids) {
              const row = hub.get(id)
              if (row && row.received_at == null) { row.received_at = r.t; updated++ } else if (!row) ignored.push(id)
            }
            return Response.json({ ok: true, updated, ignored })
          }
          return new Response('', { status: 404 })
        }) as unknown as typeof fetch,
        push: async n => { if (!r.ready) return 0; r.pushed.push(n); return 1 },
        seenLines: () => r.transcript,
        dispatchOld: async (_c, n) => { r.dispatched.push(n) },
        defaultChatId: () => 'owner',
        log: (_l, m) => { r.logs.push(m) },
        now: () => r.t,
        hold: () => r.walled,
        ate: at => r.ate(at),
      }, { stateDir: dir, receiptCheck: true, graceMs: 90_000, maxPushes: 3, backoffMs: 300_000, ...o, ...extra })
      return r.sync
    },
  }
  return r
}

const ids = (ns: Notif[]) => ns.map(n => (n.params as { meta: Record<string, string> }).meta.msg_id)

describe('receipt key for a hub id', () => {
  test('leading space: msg_id matches, btcc_msg_id alone does not', () => {
    const k = msgIdKey(9714)
    expect(k).toBe(' msg_id=\\"9714\\"')
    const both = rendered({ method: 'm', params: { content: 'x', meta: { btcc_msg_id: '9714', msg_id: '9714' } } })
    const btccOnly = rendered({ method: 'm', params: { content: 'x', meta: { btcc_msg_id: '9714', ts: 't' } } })
    expect(receivedIn([both], [k])).toBe(true)
    expect(receivedIn([btccOnly], [k])).toBe(false)
  })
  test('a longer id is not this one', () => {
    const line = rendered({ method: 'm', params: { content: 'x', meta: { msg_id: '97140' } } })
    expect(receivedIn([line], [msgIdKey(9714)])).toBe(false)
  })
  test('seenIn: a hub push (msg_id) or an old-path delivery (btcc_msg_id) of the same id; nothing else', () => {
    const oldPath = rendered({ method: 'm', params: { content: 'x', meta: { chat_id: 'o', btcc_msg_id: '9714', ts: 't' } } })
    const reply = rendered({ method: 'm', params: { content: 'x', meta: { reply_to_id: '9714', btcc_msg_id: '9800', ts: 't' } } })
    expect(seenIn([oldPath], 9714)).toBe(true)
    expect(seenIn([reply], 9714)).toBe(false)
    expect(seenIn([oldPath], 971)).toBe(false)
  })
})

describe('parsing and building', () => {
  test('parsePending: shapes, ids, payload as object / JSON text / null, sorted by id', () => {
    const p = payload('hi')
    const rows = parsePending({ rows: [{ id: 12, payload: p }, { id: '7', payload: JSON.stringify(p) }, { id: 9, payload: null },
      { id: 'x', payload: p }, { id: 3, payload: { meta: {} } }, null] })!
    expect(rows.map(r => r.id)).toEqual([3, 7, 9, 12])
    expect(rows.map(r => r.payload == null)).toEqual([true, false, true, false])
    expect(rows[1].payload!.meta.verified).toBe('true')
    expect(parsePending([{ id: 1, payload: p }])!.length).toBe(1)
    expect(parsePending({ detail: 'nope' })).toBeNull()
    expect(parsePending(null)).toBeNull()
  })
  test('payloadNotif: msg_id = id; chat_id / ts / btcc_msg_id only when missing; meta values as strings', () => {
    const n = payloadNotif(42, { content: 'c', meta: { user: 'a', no_reply: 'true' } }, { chat_id: 'owner', ts: 'T' })
    expect(n.method).toBe('notifications/claude/channel')
    expect((n.params as any).meta).toEqual({ user: 'a', no_reply: 'true', chat_id: 'owner', ts: 'T', btcc_msg_id: '42', msg_id: '42' })
    const keep = payloadNotif(42, parsePending([{ id: 42, payload: { content: 'c', meta: { chat_id: 'x', ts: 'Z', no_reply: true, bad: { a: 1 } } } }])![0].payload!,
      { chat_id: 'owner', ts: 'T' })
    expect((keep.params as any).meta).toEqual({ chat_id: 'x', ts: 'Z', no_reply: 'true', btcc_msg_id: '42', msg_id: '42' })
  })
  test('hubSyncMode: HUB_SYNC=0 restores 1.32.2; agent-inbox with BTCC_API_BASE only', () => {
    expect(hubSyncMode({ HUB_SYNC: '0' }, true, 'http://b')).toEqual({ on: false, why: 'HUB_SYNC=0' })
    expect(hubSyncMode({}, false, 'http://b').on).toBe(false)
    expect(hubSyncMode({}, true, '').on).toBe(false)
    expect(hubSyncMode({}, true, 'http://b')).toEqual({ on: true, why: 'on' })
    expect(hubSyncMode({ HUB_SYNC: '1' }, true, 'http://b').on).toBe(true)
  })
})

describe('reconcile', () => {
  test('pushes listed rows with a payload, in id order, into a ready session; state written 0600', async () => {
    const r = rig()
    r.add(5); r.add(3); r.add(4, null)
    await r.make().start()
    expect(ids(r.pushed)).toEqual(['3', '5'])
    expect(r.sync.entry(3)).toMatchObject({ pushes: 1, last_push_at: r.t, seen_at: null, taken_at: null })
    expect(r.sync.entry(4)).toBeUndefined()
    const st = join(r.dir, STATE_FILE)
    expect(statSync(st).mode & 0o777).toBe(0o600)
    expect(Object.keys(JSON.parse(readFileSync(st, 'utf8')))).toEqual(['3', '5'])
    expect(r.sync.health()).toMatchObject({ last_sync_ok: true, pending_from_hub: 2, pushed_unseen: 2, without_payload: 1 })
  })
  test('no ready session: nothing pushed or recorded; the session becoming ready pushes it', async () => {
    const r = rig()
    r.add(1)
    r.ready = false
    await r.make().start()
    expect(r.pushed).toEqual([])
    expect(r.sync.entry(1)).toBeUndefined()
    r.ready = true
    await r.sync.kick('session-ready')
    expect(ids(r.pushed)).toEqual(['1'])
  })
  test('push → seen in the transcript → taken (batched) → the hub stops listing it', async () => {
    const r = rig()
    r.add(1); r.add(2)
    await r.make().start()
    r.record(r.pushed[0]); r.record(r.pushed[1])
    r.t += 30_000
    await r.sync.kick('timer')
    expect(r.takenPosts().map(c => c.body.msg_ids)).toEqual([[1, 2]])
    expect(r.hub.get(1)!.received_at).not.toBeNull()
    expect(r.sync.entry(1)).toMatchObject({ seen_at: r.t, taken_at: r.t })
    r.t += 30_000
    await r.sync.kick('timer')
    expect(r.pushed.length).toBe(2)
    expect(r.takenPosts().length).toBe(1)
    expect(r.sync.health()).toMatchObject({ pending_from_hub: 0, pushed_unseen: 0, to_confirm: 0 })
  })
  test('not seen → no re-push within grace → re-push after grace → stop at the cap (log once); the hub keeps it untaken', async () => {
    const r = rig()
    r.add(7)
    await r.make().start()
    r.t += 30_000; await r.sync.kick('timer')
    expect(r.pushed.length).toBe(1)
    r.t += 61_000; await r.sync.kick('timer')
    expect(r.pushed.length).toBe(2)
    r.t += 91_000; await r.sync.kick('timer')
    expect(r.pushed.length).toBe(3)
    for (let i = 0; i < 4; i++) { r.t += 91_000; await r.sync.kick('timer') }
    expect(r.pushed.length).toBe(3)
    expect(r.sync.entry(7)!.pushes).toBe(3)
    expect(r.logs.filter(l => l.includes('#7 pushed 3 times')).length).toBe(1)
    expect(r.hub.get(7)!.received_at).toBeNull()
    expect(r.takenPosts().length).toBe(0)
    expect(r.sync.health()).toMatchObject({ capped: 1, pushed_unseen: 1 })
    // the client takes it late after all: still seen and confirmed
    r.record(r.pushed[2]); r.t += 30_000; await r.sync.kick('timer')
    expect(r.hub.get(7)!.received_at).not.toBeNull()
  })
  test('restart mid-flight: the pushed-unseen id survives, waits out the grace, is re-pushed and then confirmed', async () => {
    const r = rig()
    r.add(11)
    await r.make().start()
    expect(r.sync.entry(11)!.pushes).toBe(1)
    // new process, same state dir
    r.t += 20_000
    await r.make().start()
    expect(r.pushed.length).toBe(1)
    expect(r.logs.some(l => l.includes('1 pushed and not yet seen'))).toBe(true)
    r.t += 75_000
    await r.sync.kick('timer')
    expect(r.pushed.length).toBe(2)
    expect(r.sync.entry(11)!.pushes).toBe(2)
    r.record(r.pushed[1]); r.t += 30_000
    await r.sync.kick('timer')
    expect(r.hub.get(11)!.received_at).not.toBeNull()
  })
  test('seen in the transcript before the restart is picked up after it (no re-push)', async () => {
    const r = rig()
    r.add(12)
    await r.make().start()
    r.record(r.pushed[0])
    r.t += 200_000
    await r.make().start()
    expect(r.pushed.length).toBe(1)
    expect(r.hub.get(12)!.received_at).not.toBeNull()
  })
  test('a row the old path already delivered (btcc_msg_id in the transcript) is not pushed again, only reported taken', async () => {
    const r = rig()
    r.record(injectNotif(70))            // e.g. delivered by 1.32.2 before this version, never reported taken
    r.add(70); r.add(71)
    await r.make().start()
    expect(ids(r.pushed)).toEqual(['71'])
    expect(r.takenPosts().map(c => c.body.msg_ids)).toEqual([[70]])
    expect(r.hub.get(70)!.received_at).not.toBeNull()
    expect(r.logs.some(l => l.includes('#70 is already in the transcript'))).toBe(true)
  })
  test('kicks while a sync runs coalesce', async () => {
    const r = rig()
    r.add(1)
    const s = r.make()
    await Promise.all([s.kick('a'), s.kick('b'), s.kick('c'), s.kick('d')])
    expect(r.gets()).toBeLessThanOrEqual(2)
    expect(r.pushed.length).toBe(1)
  })
  test('no mesh credential: no hub call; a doorbell takes the old path at once', async () => {
    const r = rig()
    r.cred = false
    r.add(1)
    await r.make().start()
    expect(r.calls.length).toBe(0)
    expect(r.sync.doorbell(1, 'owner', injectNotif(1))).toBe('old')
  })
})

describe('doorbell', () => {
  test('listed id: hub delivers it once; a duplicate doorbell pushes nothing', async () => {
    const r = rig()
    const s = r.make()
    await s.start()
    r.add(20)
    expect(s.doorbell(20, 'owner', injectNotif(20))).toBe('hub')
    await s.kick('wait')
    expect(ids(r.pushed)).toEqual(['20'])
    expect(r.dispatched).toEqual([])
    expect(existsSync(join(r.dir, DOORBELL_DIR, '20.json'))).toBe(false)
    expect(s.doorbell(20, 'owner', injectNotif(20))).toBe('dup-hub')
    await s.kick('wait')
    expect(r.pushed.length).toBe(1)
    expect(r.dispatched).toEqual([])
  })
  test('id the hub does not list (no payload yet): old path once, never pushed from the hub later, dup → dup-old', async () => {
    const r = rig()
    const s = r.make()
    await s.start()
    r.add(21, null)
    expect(s.doorbell(21, 'owner', injectNotif(21))).toBe('hub')
    await s.kick('wait')
    expect(r.dispatched.length).toBe(1)
    expect(s.entry(21)).toMatchObject({ old_path: true })
    expect(s.doorbell(21, 'owner', injectNotif(21))).toBe('dup-old')
    r.add(21)   // payload filled later: still not pushed a second time
    r.t += 200_000; await s.kick('timer')
    expect(r.pushed).toEqual([])
    expect(r.dispatched.length).toBe(1)
    // the old path's receipt sees it → taken
    s.oldPathSeen(injectNotif(21))
    await s.kick('timer')
    expect(r.takenPosts().map(c => c.body.msg_ids)).toEqual([[21]])
    expect(r.hub.get(21)!.received_at).not.toBeNull()
  })
  test('hub 404 (BTCC not deployed): held doorbell → old path; then old path at once, and GET backs off', async () => {
    const r = rig()
    r.mode = '404'
    const s = r.make()
    expect(s.doorbell(30, 'owner', injectNotif(30))).toBe('hub')   // before any sync: held, decided async
    await s.start()
    expect(r.dispatched.length).toBe(1)
    expect(s.health()).toMatchObject({ last_sync_ok: false })
    expect(s.doorbell(31, 'owner', injectNotif(31))).toBe('old')    // known bad: the caller delivers it now
    expect(s.entry(31)).toMatchObject({ old_path: true })
    const g = r.gets()
    r.t += 60_000; await s.kick('timer')
    expect(r.gets()).toBe(g)                                         // within the backoff
    r.mode = 'ok'; r.t += 300_000; await s.kick('timer')
    expect(r.gets()).toBe(g + 1)
    expect(s.health()).toMatchObject({ last_sync_ok: true })
  })
  test('hub unreachable: held doorbell → old path', async () => {
    const r = rig()
    r.mode = 'down'
    const s = r.make()
    expect(s.doorbell(40, 'owner', injectNotif(40))).toBe('hub')
    await s.kick('wait')
    expect(r.dispatched.map(n => (n.params as any).content)).toEqual(['from /inject'])
    expect(r.logs.some(l => l.includes('#40 → old path (hub unreachable'))).toBe(true)
  })
  test('a held doorbell survives a restart and is decided by the boot sync', async () => {
    const r = rig()
    r.mode = 'hang'                     // the first process never gets an answer
    const s1 = r.make()
    expect(s1.doorbell(50, 'owner', injectNotif(50))).toBe('hub')
    expect(existsSync(join(r.dir, DOORBELL_DIR, '50.json'))).toBe(true)
    await new Promise(res => setTimeout(res, 5))   // s1's GET is out and never answers (the process "dies" here)
    r.mode = 'ok'                       // new process; the hub does not list 50
    const s2 = r.make()
    await s2.start()
    expect(r.dispatched.length).toBe(1)
    expect(readdirSync(join(r.dir, DOORBELL_DIR))).toEqual([])
    expect(s2.entry(50)).toMatchObject({ old_path: true })
  })
  test('HUB_SYNC=0 after a restart: leftover held doorbells go down the old path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-sync-'))
    mkdirSync(join(dir, DOORBELL_DIR))
    writeFileSync(join(dir, DOORBELL_DIR, '60.json'), JSON.stringify({ chatId: 'owner', notif: injectNotif(60) }))
    const got: Notif[] = []
    expect(await drainLeftoverDoorbells(dir, async (_c, n) => { got.push(n) }, () => {})).toBe(1)
    expect(got.length).toBe(1)
    expect(readdirSync(join(dir, DOORBELL_DIR))).toEqual([])
    expect(await drainLeftoverDoorbells(join(dir, 'nope'), async () => {}, () => {})).toBe(0)
  })
})

describe('taken', () => {
  test('batches of 200; a failure keeps them for the next sync; 404 backs off', async () => {
    const r = rig({ receiptCheck: false })   // RECEIPT_CHECK=0: pushed = seen
    for (let i = 1; i <= 450; i++) r.add(i)
    r.takenMode = '500'
    await r.make().start()
    expect(r.pushed.length).toBe(450)
    expect(r.takenPosts().length).toBe(1)                 // first batch failed: stop, retry next sync
    expect(r.sync.health()).toMatchObject({ to_confirm: 450 })
    r.takenMode = '404'; r.t += 30_000; await r.sync.kick('timer')
    const n404 = r.takenPosts().length
    r.t += 30_000; await r.sync.kick('timer')
    expect(r.takenPosts().length).toBe(n404)              // backing off
    r.takenMode = 'ok'; r.t += 300_000; await r.sync.kick('timer')
    const ok = r.takenPosts().slice(n404)
    expect(ok.map(c => c.body.msg_ids.length)).toEqual([200, 200, 50])
    expect(r.sync.health()).toMatchObject({ to_confirm: 0 })
    expect([...r.hub.values()].every(v => v.received_at != null)).toBe(true)
    expect(r.logs.filter(l => l.startsWith('hub: taken not confirmed')).length).toBe(2)   // quiet: once per reason
  })
})

describe('no transcript to read', () => {
  test('receipt check unavailable: one push each, counted as seen and taken; available later: back to receipts', async () => {
    let available = false
    const r = rig({ receiptCheck: () => available })   // the channel bot's daemon on 11-20: its transcript dir didn't exist
    r.add(1); r.add(2)
    await r.make().start()
    expect(ids(r.pushed)).toEqual(['1', '2'])
    for (let i = 0; i < 5; i++) { r.t += 120_000; await r.sync.kick('timer') }
    expect(r.pushed.length).toBe(2)                         // not re-pushed up to maxPushes
    expect(r.hub.get(1)!.received_at).not.toBeNull()
    expect(r.hub.get(2)!.received_at).not.toBeNull()
    expect(r.logs.some(l => l.includes('never seen'))).toBe(false)
    available = true
    r.add(3)
    r.t += 30_000; await r.sync.kick('timer')
    expect(ids(r.pushed)).toEqual(['1', '2', '3'])
    r.t += 120_000; await r.sync.kick('timer')
    expect(ids(r.pushed)).toEqual(['1', '2', '3', '3'])      // receipts again: unseen after the grace → pushed again
    expect(r.hub.get(3)!.received_at).toBeNull()
  })
})

describe('gc', () => {
  test('taken entries go 24 h after taken; never-taken ones 48 h after their last activity', () => {
    const now = 10 * DAY
    const s: HubState = {
      '1': { pushes: 1, last_push_at: now - 2 * DAY, seen_at: now - 2 * DAY, taken_at: now - 25 * 3600_000 },
      '2': { pushes: 1, last_push_at: now - DAY, seen_at: now - DAY, taken_at: now - 23 * 3600_000 },
      '3': { pushes: 3, last_push_at: now - 49 * 3600_000, seen_at: null, taken_at: null },
      '4': { pushes: 3, last_push_at: now - 47 * 3600_000, seen_at: null, taken_at: null },
      '5': { pushes: 0, last_push_at: now - 3 * DAY, seen_at: null, taken_at: null, old_path: true },
    }
    expect(gcState(s, now)).toBe(3)
    expect(Object.keys(s).sort()).toEqual(['2', '4'])
  })
  test('loadState tolerates garbage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-sync-'))
    const p = join(dir, STATE_FILE)
    writeFileSync(p, '{not json')
    expect(loadState(p)).toEqual({})
    writeFileSync(p, JSON.stringify({ '7': { pushes: 2, last_push_at: 5, seen_at: 'x' }, abc: {}, '8': 3 }))
    expect(loadState(p)).toEqual({ '7': { pushes: 2, last_push_at: 5, seen_at: null, taken_at: null } })
  })
})

describe('WO-120 usage wall', () => {
  test('walled: nothing pushed, rows stay untaken and are counted; after the clear each is pushed once, in order', async () => {
    const r = rig()
    r.add(5); r.add(3); r.add(9)
    const s = r.make()
    r.walled = true
    await s.kick('t')
    r.t += 120_000
    await s.kick('t')
    expect(r.pushed).toEqual([])
    expect(s.withheld().count).toBe(3)
    expect(s.health().withheld_wall).toBe(3)
    expect(r.takenPosts().length).toBe(0)
    expect([...r.hub.values()].every(v => v.received_at == null)).toBe(true)
    r.walled = false
    await s.kick('wall-cleared')
    expect(ids(r.pushed)).toEqual(['3', '5', '9'])
    expect(s.withheld().count).toBe(0)
    for (const n of r.pushed) r.record(n)
    r.t += 1000
    await s.kick('t')
    r.t += 300_000
    await s.kick('t')
    expect(ids(r.pushed)).toEqual(['3', '5', '9'])
    expect([3, 5, 9].map(id => s.entry(id)!.pushes)).toEqual([1, 1, 1])
    expect([...r.hub.values()].every(v => v.received_at != null)).toBe(true)
  })
  test('a push the wall ate: not seen, not counted, pushed once more after the clear (and remembered across a restart)', async () => {
    const r = rig()
    r.add(7)
    let s = r.make()
    await s.kick('t')
    expect(ids(r.pushed)).toEqual(['7'])
    r.record(r.pushed[0])                       // in the transcript: the wall answered it
    const pushedAt = r.t
    r.walled = true
    r.ate = at => at === pushedAt
    r.t += 30_000
    await s.kick('t')
    expect(s.entry(7)).toMatchObject({ pushes: 0, seen_at: null, wall_ate: pushedAt })
    expect(r.takenPosts().length).toBe(0)
    s = r.make()                                // restart inside the wall
    expect(s.entry(7)).toMatchObject({ pushes: 0, wall_ate: pushedAt })
    r.t += 120_000
    await s.kick('t')
    expect(r.pushed.length).toBe(1)
    expect(s.withheld().count).toBe(1)
    r.walled = false
    await s.kick('wall-cleared')
    expect(ids(r.pushed)).toEqual(['7', '7'])
    expect(s.entry(7)!.pushes).toBe(1)
    r.record(r.pushed[1])
    r.t += 1000
    await s.kick('t')
    expect(s.entry(7)!.seen_at).not.toBeNull()
    expect(r.hub.get(7)!.received_at).not.toBeNull()
    r.t += 300_000
    await s.kick('t')
    expect(r.pushed.length).toBe(2)
  })
})
