// WO-181 (the plugin half): onsen-mentions.ts. The block from Onsen's answer (Chiron's title verbatim, one line per notification = the PostCard's `line`
// as Onsen made it, more than 20: the last line says how many more; nothing unread: no block), the fetch (GET with the agent's credential path, its
// timeout, Onsen erroring or slow: no block and one log line), the read (PUT /v1/posts/<id>/read {read: true} per post), the switch.
import { describe, expect, test } from 'bun:test'
import { MENTIONS_PATH, MentionCards, mentionBlock, mentionTitle } from './onsen-mentions.ts'

const card = (id: number, line = `#${id}｜11-26 13:05｜epeius｜留言｜WO-${id - 200000} 請你定：要不要改報法｜工單 WO-${id - 200000}`) =>
  ({ post_id: String(id), number: id, legacy_id: null, created_at: '2026-11-26T05:05:00Z', author: 'epeius', title: 't', preview: 'p', touches: [], ref: null, type: 'note', supersedes: null, superseded_by: null, line })
const note = (id: number, reason = 'mention', read_at: string | null = null) =>
  ({ id: `nt_${id}`, recipient: 'lab-relay', post_id: String(id), reason, created_at: '2026-11-26T05:05:00Z', read_at, line: `通知 nt_${id}｜lab-relay｜${reason}｜貼文 ${id}｜未讀` })
const answer = (ids: number[], total = ids.length) => ({ api_version: 1, as_of: '2026-11-26T05:06:00Z', viewer: 'lab-relay', read_by: 'lab-relay',
  items: ids.map(i => note(i)), next_cursor: null, counts: { wall: 40, thread: 3, mention: total, assignment: 0 }, cards: ids.map(i => card(i)) })

describe('the block', () => {
  test('Chiron\'s title with N, one line per notification, each the PostCard\'s line as Onsen made it, newest first as Onsen gave them', () => {
    const b = mentionBlock(answer([200302, 200301]))!
    expect(b.text.split('\n')).toEqual(['〔點名你的動態｜2 則。別人在你的單或你名下的串上說了什麼；只讓你知道，要看全文用 feed_open〕', card(200302).line, card(200301).line])
    expect(b).toMatchObject({ posts: ['200302', '200301'], count: 2 })
    expect(mentionTitle(1)).toBe('〔點名你的動態｜1 則。別人在你的單或你名下的串上說了什麼；只讓你知道，要看全文用 feed_open〕')
  })
  test('more than 20: twenty lines, then how many more (counts.mention is every unread one)', () => {
    const ids = Array.from({ length: 20 }, (_, i) => 200400 - i)
    const b = mentionBlock(answer(ids, 27))!
    const lines = b.text.split('\n')
    expect(lines).toHaveLength(22)
    expect(lines[0]).toBe(mentionTitle(27))
    expect(lines.slice(1, 21)).toEqual(ids.map(i => card(i).line))
    expect(lines[21]).toBe('還有 7 則沒列出，下一次附上')
    expect(b.posts).toHaveLength(20)
  })
  test('nothing unread, a read one, another reason, a card missing, not Onsen\'s shape: no block (never an empty title)', () => {
    expect(mentionBlock(answer([]))).toBeNull()
    expect(mentionBlock({ ...answer([200301]), items: [note(200301, 'mention', '2026-11-26T05:00:00Z')] })).toBeNull()
    expect(mentionBlock({ ...answer([200301]), items: [note(200301, 'thread')] })).toBeNull()
    expect(mentionBlock({ ...answer([200301]), cards: [] })).toBeNull()
    expect(mentionBlock({ error: { code: 'x' } })).toBeNull()
    expect(mentionBlock(null)).toBeNull()
    // the same post twice: once
    expect(mentionBlock({ ...answer([200301]), items: [note(200301), note(200301)] })!.posts).toEqual(['200301'])
  })
})

describe('the fetch and the read', () => {
  const rig = (reply: (m: string, path: string, body: unknown) => Promise<{ status: number; json: any } | null>, on = true, timeoutMs = 300) => {
    const calls: Array<{ m: string; path: string; body: unknown; t: number }> = [], logs: string[] = []
    const c = new MentionCards({ on: () => on, timeoutMs: () => timeoutMs, log: (_l, m) => logs.push(m),
      req: (m, path, body, t) => { calls.push({ m, path, body, t }); return reply(m, path, body) } })
    return { c, calls, logs }
  }
  test('GET /v1/notifications?reason=mention&read=unread&limit=20 (the agent\'s own credential: OnsenClient.request), its timeout; the block', async () => {
    const r = rig(async () => ({ status: 200, json: answer([200301]) }))
    const b = await r.c.fetchIfOn()
    expect(r.calls).toEqual([{ m: 'GET', path: '/v1/notifications?reason=mention&read=unread&limit=20', body: undefined, t: 300 }])
    expect(MENTIONS_PATH).toBe('/v1/notifications?reason=mention&read=unread&limit=20')
    expect(b!.text).toContain(card(200301).line)
    expect(r.c.health()).toMatchObject({ on: true, fetched: 1, blocks: 1, lines: 1, failed: 0 })
  })
  test('switched off: nothing asked, null at once (not a promise: the delivery awaits nothing)', () => {
    const r = rig(async () => ({ status: 200, json: answer([200301]) }), false)
    expect(r.c.fetchIfOn()).toBeNull()
    expect(r.calls).toEqual([])
  })
  test('Onsen erroring (500), refusing (401), unreachable, slow, no credential: no block, one log line each, never a throw', async () => {
    for (const [reply, why] of [
      [async () => ({ status: 500, json: { error: { code: 'internal' } } }), 'HTTP 500 internal'],
      [async () => ({ status: 401, json: null }), 'HTTP 401'],
      [async () => { throw new Error('ECONNREFUSED') }, 'ECONNREFUSED'],
      [() => new Promise<never>(() => {}), 'no answer within 300 ms'],
      [async () => null, 'no credential'],
    ] as const) {
      const r = rig(reply as any)
      const t0 = Date.now()
      expect(await r.c.fetchIfOn()).toBeNull()
      expect(Date.now() - t0).toBeLessThan(1000)
      expect(r.logs).toHaveLength(1)
      expect(r.logs[0]).toContain(why)
      expect(r.c.health()).toMatchObject({ failed: 1, blocks: 0 })
    }
  })
  test('read: one PUT /v1/posts/<id>/read {read: true} per post (Onsen\'s read for a notification), each once; a failure is one log line', async () => {
    const r = rig(async (m, path) => m === 'PUT' && path.includes('200302') ? { status: 404, json: null } : { status: 200, json: { data: {} } })
    r.c.read(['200301', '200302', '200301', 'nt_x'])
    await new Promise(res => setTimeout(res, 20))
    expect(r.calls.map(c => [c.m, c.path, c.body])).toEqual([['PUT', '/v1/posts/200301/read', { read: true }], ['PUT', '/v1/posts/200302/read', { read: true }]])
    expect(r.c.health()).toMatchObject({ read: 1, read_failed: 1 })
    expect(r.logs).toEqual(['lanes: mention cards: marking post 200302 read failed (HTTP 404)'])
  })
})
