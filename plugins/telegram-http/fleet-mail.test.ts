import { describe, expect, test } from 'bun:test'
import { FLEET_INSTRUCTIONS, FLEET_TOOLS, handleFleetRpc, takeAfterSend, type FleetDeps } from './fleet-mail.ts'
import { FLEET_TEXT } from './fleet-text.ts'

function deps(over: Partial<FleetDeps> = {}) {
  const calls: any[] = []
  const btccCalls: any[] = []
  const d: FleetDeps = {
    call: async (to, text, replyTo, noReply, op) => { calls.push({ to, text, replyTo, noReply, op }); return `delivered to ${to}'s inbox` },
    btcc: async (method, path, body) => { btccCalls.push({ method, path, body }); return { status: 200, json: {} } },
    core: async () => ({ status: 200, json: { ask: false } }),
    ...over,
  }
  return { d, calls, btccCalls }
}
const rpc = (method: string, params: any = {}, id: any = 1) => ({ jsonrpc: '2.0', id, method, params })
const tool = (name: string, args: any = {}) => rpc('tools/call', { name, arguments: args })
const out = (r: any) => r.result.content[0].text as string

describe('fleet MCP server', () => {
  test('instructions are the main text, verbatim, and fit the 2048-char budget', async () => {
    const r = await handleFleetRpc(rpc('initialize', { protocolVersion: '2025-06-18' }), deps().d)
    expect(r.result.instructions).toBe(FLEET_TEXT)
    expect(FLEET_INSTRUCTIONS.length).toBeLessThan(2000)
    expect(FLEET_TEXT.startsWith('艦隊怎麼傳遞事情')).toBe(true)
    expect(r.result.protocolVersion).toBe('2025-06-18')
    expect(r.result.capabilities.tools).toBeDefined()
    expect(r.result.capabilities.experimental).toBeUndefined()   // never a channel
  })
  test('notifications get no response; unknown methods an error', async () => {
    expect(await handleFleetRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps().d)).toBeNull()
    const r = await handleFleetRpc(rpc('server/discover'), deps().d)
    expect(r.error.code).toBe(-32601)
  })
  test('tools/list: feed_ask only for agents on the ask list', async () => {
    const base = ['call', 'send_mail', 'mailbox_list', 'mailbox_open', 'mailbox_check', 'mailbox_reply', 'mail_sent',
      'feed_post', 'feed_search', 'feed_open']
    const r = await handleFleetRpc(rpc('tools/list'), deps().d)
    expect(r.result.tools.map((t: any) => t.name)).toEqual(base)
    const seen: any[] = []
    const on = await handleFleetRpc(rpc('tools/list'), deps({ core: async (m, p, b, t) => { seen.push([m, p, t]); return { status: 200, json: { ask: true } } } }).d)
    expect(on.result.tools.map((t: any) => t.name)).toEqual([...base.slice(0, 8), 'feed_ask', ...base.slice(8)])
    expect(seen).toEqual([['GET', '/api/feed/me', 1500]])
    const down = await handleFleetRpc(rpc('tools/list'), deps({ core: async () => ({ status: 599, json: {} }) }).d)
    expect(down.result.tools.map((t: any) => t.name)).toEqual(base)        // core unreachable → no ask, still listed the rest
    expect(FLEET_TOOLS.length).toBe(11)
  })
  test('call pushes; a reply to a call is no_reply automatically', async () => {
    const { d, calls } = deps()
    expect(out(await handleFleetRpc(tool('call', { to: 'pheme', text: '官網掛了' }), d))).toContain('delivered')
    expect(calls[0]).toEqual({ to: 'pheme', text: '官網掛了', replyTo: undefined, noReply: false, op: undefined })
    await handleFleetRpc(tool('call', { to: 'pheme', text: '已修', reply_to: '9123' }), d)
    expect(calls[1].replyTo).toBe(9123)
    expect(calls[1].noReply).toBe(true)
  })
  test('send_mail: title over 40 never leaves the daemon', async () => {
    const { d, btccCalls } = deps()
    const r = await handleFleetRpc(tool('send_mail', { to: 'chiron', title: '一'.repeat(41), body: 'b' }), d)
    expect(r.result.isError).toBe(true)
    expect(btccCalls.length).toBe(0)
  })
  test('send_mail: stored vs pushed vs refused', async () => {
    let reply: any = { status: 200, json: { id: 7, stored: true } }
    const { d, btccCalls } = deps({ btcc: async (m, p, b) => { btccCalls.push({ m, p, b }); return reply } })
    expect(out(await handleFleetRpc(tool('send_mail', { to: 'chiron', title: 'Pheme：OG 圖換不換', body: 'b', deadline: '6', no_reply: true }), d)))
      .toContain('已放進 chiron 的信箱（#7）')
    expect(btccCalls[0].p).toBe('/api/mesh/mail/send')
    expect(btccCalls[0].b).toEqual({ to: 'chiron', title: 'Pheme：OG 圖換不換', body: 'b', deadline: 6, no_reply: true })
    reply = { status: 200, json: { id: 8, stored: false, delivered: true } }
    expect(out(await handleFleetRpc(tool('send_mail', { to: 'pheme', title: 't', body: 'b' }), d))).toContain('信箱還沒開')
    reply = { status: 200, json: { id: 9, stored: true, op_id: 3 } }
    await handleFleetRpc(tool('send_mail', { to: 'chiron', title: 't', body: 'b', op: 'OP-3' }), d)
    expect(btccCalls.at(-1).b).toEqual({ to: 'chiron', title: 't', body: 'b', deadline: undefined, no_reply: false, op: 'OP-3' })
    reply = { status: 200, json: { id: 10, stored: true, warning: "unknown op 'OP-99'" } }
    expect(out(await handleFleetRpc(tool('send_mail', { to: 'chiron', title: 't', body: 'b', op: 'OP-99' }), d))).toContain("unknown op 'OP-99'")
    reply = { status: 409, json: { detail: '沒送出：一件事一個 owner' } }
    const r = await handleFleetRpc(tool('send_mail', { to: 'pheme', title: 't', body: 'b' }), d)
    expect(r.result.isError).toBe(true)
    expect(out(r)).toContain('一件事一個 owner')
  })
  test('mailbox_list: one line per mail, unread or read, no body', async () => {
    const { d } = deps({ btcc: async () => ({ status: 200, json: { mail: [
      { id: 11, from: 'pheme', title: 'Pheme：OG 圖換不換', deadline: '2026-11-16T04:00:00+00:00', waited: '40 分鐘', no_reply: false, status: 'unread' },
      { id: 12, from: 'atlas', title: 'Atlas：BVI 已付', deadline: null, waited: '5 分鐘', no_reply: true, status: 'read' }] } }) })
    const t = out(await handleFleetRpc(tool('mailbox_list'), d))
    expect(t.split('\n')[0]).toBe('1 封未讀、1 封已讀還沒勾掉：')
    expect(t).toContain('#11｜pheme｜Pheme：OG 圖換不換｜期限 11-16 04:00Z｜等了 40 分鐘｜未讀')
    expect(t).toContain('#12｜atlas｜Atlas：BVI 已付｜期限 —｜等了 5 分鐘｜已讀｜不用回')
  })
  test('mailbox_list empty', async () => {
    const { d } = deps({ btcc: async () => ({ status: 200, json: { mail: [] } }) })
    expect(out(await handleFleetRpc(tool('mailbox_list'), d))).toBe('信箱是空的。')
  })
  test('open / check / reply / sent route to BTCC and report back', async () => {
    const seen: any[] = []
    const { d } = deps({ btcc: async (m, p, b) => {
      seen.push([m, p, b])
      if (p.endsWith('/check')) return { status: 200, json: { id: 11, status: 'checked', was: 'unread' } }
      if (p.endsWith('/reply')) return { status: 200, json: { id: 30, stored: true } }
      if (p.startsWith('/api/mesh/mail/sent')) return { status: 200, json: { sent: [
        { id: 11, to: 'chiron', title: 'T', deadline: null, status: 'read', read_at: '2026-11-15T05:00:00+00:00' },
        { id: 12, to: 'chiron', title: 'U', deadline: null, status: 'checked', read_at: null }] } }
      return { status: 200, json: { id: 11, from: 'pheme', title: 'T', body: '全文', deadline: null, waited: '1 分鐘', no_reply: false, status: 'read' } }
    } })
    expect(out(await handleFleetRpc(tool('mailbox_open', { id: 11 }), d))).toContain('全文')
    expect(out(await handleFleetRpc(tool('mailbox_check', { id: 11 }), d))).toContain('寄的人看到的是未讀')
    expect(out(await handleFleetRpc(tool('mailbox_reply', { id: '11', body: '換了' }), d))).toContain('回信放進對方信箱了（#30')
    const sent = out(await handleFleetRpc(tool('mail_sent'), d))
    expect(sent).toContain('#11｜給 chiron｜T｜期限 —｜已讀 11-15 05:00Z')
    expect(sent).toContain('#12｜給 chiron｜U｜期限 —｜勾掉了（沒打開過）')
    expect(seen.map(x => x[1]).slice(0, 3)).toEqual(['/api/mesh/mail/11', '/api/mesh/mail/11/check', '/api/mesh/mail/11/reply'])
    expect(seen[2][2]).toEqual({ body: '換了' })
    const bad = await handleFleetRpc(tool('mailbox_reply', { id: 11 }), d)
    expect(bad.result.isError).toBe(true)
    const long = await handleFleetRpc(tool('mailbox_reply', { id: 11, body: 'x', title: '一'.repeat(41) }), d)
    expect(long.result.isError).toBe(true)
  })
  test('a reply that could not be delivered is an error, not a success', async () => {
    let reply: any = { status: 200, json: { id: 31, stored: false, delivered: false, detail: 'receiver 502' } }
    const { d } = deps({ btcc: async () => reply })
    const r = await handleFleetRpc(tool('mailbox_reply', { id: 11, body: 'x' }), d)
    expect(r.result.isError).toBe(true)
    expect(out(r)).toContain('送不到對方：receiver 502')
    reply = { status: 200, json: { id: 32, stored: false, delivered: true } }
    const ok = await handleFleetRpc(tool('mailbox_reply', { id: 11, body: 'x' }), d)
    expect(ok.result.isError).toBeUndefined()
    expect(out(ok)).toContain('直接送進它的 session（#32')
  })
  test('a BTCC error surfaces its detail', async () => {
    const { d } = deps({ btcc: async () => ({ status: 409, json: { detail: 'mail #11 is already checked off' } }) })
    const r = await handleFleetRpc(tool('mailbox_check', { id: 11 }), d)
    expect(r.result.isError).toBe(true)
    expect(out(r)).toContain('already checked off')
  })
})

describe('feed wall tools (WO-92)', () => {
  const post = { id: 7, time: '2026-11-15T07:52:00+00:00', author: 'hephaestus', title: 'Hephaestus：ton 網域改走 Cloudflare',
    touches: ['ton-dns', 'cloudflare'], ref: 'WO-25', supersedes: null, superseded_by: null, superseded_by_author: null }
  test('feed_post: title over 40 and six touches never leave the daemon; posted → told nobody is notified', async () => {
    const seen: any[] = []
    const { d } = deps({ core: async (m, p, b) => { seen.push([m, p, b]); return { status: 200, json: { id: 12 } } } })
    expect((await handleFleetRpc(tool('feed_post', { title: '一'.repeat(41), body: 'b' }), d)).result.isError).toBe(true)
    expect((await handleFleetRpc(tool('feed_post', { title: 't', body: 'b', touches: ['a', 'b', 'c', 'd', 'e', 'f'] }), d)).result.isError).toBe(true)
    expect(seen.length).toBe(0)
    const t = out(await handleFleetRpc(tool('feed_post', { title: 'Epeius：牆上線', body: '全文', touches: ['fleet-core'], ref: 'WO-92', supersedes: '3' }), d))
    expect(t).toContain('已貼出 #12（取代 #3）')
    expect(t).toContain('不會通知任何人')
    expect(seen[0]).toEqual(['POST', '/api/feed/posts', { title: 'Epeius：牆上線', body: '全文', touches: ['fleet-core'], ref: 'WO-92', supersedes: 3, links: [] }])
  })
  test('feed_post: the service refusal is passed through', async () => {
    const { d } = deps({ core: async () => ({ status: 409, json: { detail: '沒貼出：#3 已經被 #5 取代；要更正就取代 #5' } }) })
    const r = await handleFleetRpc(tool('feed_post', { title: 't', body: 'b', supersedes: 3 }), d)
    expect(r.result.isError).toBe(true)
    expect(out(r)).toBe('沒貼出：#3 已經被 #5 取代；要更正就取代 #5')
  })
  test('feed_ask: related posts come back in full; more and unjudged are counted', async () => {
    const seen: any[] = []
    const { d } = deps({ core: async (m, p, b, t) => { seen.push([m, p, b, t])
      if (p === '/api/feed/read') return { status: 200, json: { marked: 2 } }
      return { status: 200, json: {
      candidates: 9, judged: 7, related: 3, more: 1, unjudged: 2, jev: 'partial',
      given: [{ ...post, body: 'ton 開頭的網域 DNS 已搬到 Cloudflare', links: ['https://x'], read: false }, { ...post, id: 6, body: '第二則', links: [], read: false }] } } } })
    const res = await handleFleetRpc(tool('feed_ask', { about: '要改 ton 網域' }), d)
    const t = out(res)
    expect(seen[0]).toEqual(['POST', '/api/feed/ask', { about: '要改 ton 網域' }, 20000])
    expect(t).toContain('跟這件事有關的 2 則')
    expect(t).toContain('#7｜11-15 07:52Z｜hephaestus｜Hephaestus：ton 網域改走 Cloudflare\n　動到：ton-dns、cloudflare　連動：WO-25\n\nton 開頭的網域 DNS 已搬到 Cloudflare\nhttps://x')
    expect(t).toContain('另有 1 則有關的，再問一次接著給。')
    expect(t).toContain('另外 2 則 Jev 沒判到，可以用 feed_search 找。')
    // nothing is marked while the answer is being built: only an after-send hook rides on the result
    expect(seen.length).toBe(1)
    const hooks = takeAfterSend([res])
    expect(hooks.length).toBe(1)
    expect(JSON.stringify(res)).not.toContain('_afterSend')
    expect(res.result._afterSend).toBeUndefined()
    await hooks[0]()
    expect(seen[1]).toEqual(['POST', '/api/feed/read', { ids: [7, 6], via: 'ask' }, undefined])
  })
  test('after-send hooks: a failed read-mark throws (the route logs it; the post stays unread and comes again)', async () => {
    const seen: string[] = []
    const { d } = deps({ core: async (m, p) => { seen.push(p)
      if (p === '/api/feed/read') return { status: 599, json: {} }
      if (p === '/api/feed/ask') return { status: 200, json: { candidates: 1, judged: 1, related: 1, more: 0, unjudged: 0, jev: 'ok',
        given: [{ ...post, body: '全文', links: [], read: false }] } }
      return { status: 200, json: { ...post, body: '打開的全文', links: [], read: false } } } })
    const a = await handleFleetRpc(tool('feed_ask', { about: 'x' }), d)
    expect(out(a)).toContain('全文')
    expect(a.result.isError).toBeUndefined()
    const o = await handleFleetRpc(tool('feed_open', { id: 7 }), d)
    expect(out(o)).toContain('打開的全文')
    const hooks = takeAfterSend([a, o])
    expect(hooks.length).toBe(2)
    expect(seen).toEqual(['/api/feed/ask', '/api/feed/posts/7'])     // nothing marked before sending
    await expect(hooks[0]()).rejects.toThrow('599')
    await expect(hooks[1]()).rejects.toThrow('599')
  })
  test('feed_open of a post already read (or your own) carries no hook', async () => {
    const { d } = deps({ core: async () => ({ status: 200, json: { ...post, body: 'b', links: [], read: true } }) })
    const o = await handleFleetRpc(tool('feed_open', { id: 7 }), d)
    expect(takeAfterSend([o]).length).toBe(0)
  })
  test('feed_ask: Jev not answering → use search; nothing unread; nothing related; not on the list', async () => {
    let reply: any = { status: 200, json: { candidates: 4, judged: 0, given: [], jev: 'timeout' } }
    const { d } = deps({ core: async () => reply })
    let r = await handleFleetRpc(tool('feed_ask', { about: 'x' }), d)
    expect(out(r).startsWith('Jev 沒回，改用搜尋')).toBe(true)
    expect(r.result.isError).toBeUndefined()
    reply = { status: 599, json: { detail: '艦隊核心連不上' } }
    expect(out(await handleFleetRpc(tool('feed_ask', { about: 'x' }), d)).startsWith('Jev 沒回，改用搜尋')).toBe(true)
    reply = { status: 200, json: { candidates: 0, jev: 'none', given: [] } }
    expect(out(await handleFleetRpc(tool('feed_ask', { about: 'x' }), d))).toBe('牆上沒有你還沒讀過的貼文。')
    reply = { status: 200, json: { candidates: 3, judged: 3, related: 0, more: 0, unjudged: 0, jev: 'ok', given: [] } }
    expect(out(await handleFleetRpc(tool('feed_ask', { about: 'x' }), d))).toBe('Jev 看了 3 則你還沒讀過的貼文，沒有跟這件事有關的。')
    reply = { status: 403, json: { detail: '問牆還沒開給 cadmus；可以用 feed_search 找' } }
    r = await handleFleetRpc(tool('feed_ask', { about: 'x' }), d)
    expect(r.result.isError).toBe(true)
    expect(out(r)).toContain('feed_search')
  })
  test('feed_search lists cards (not bodies, marks read and superseded); feed_open gives the full text', async () => {
    const seen: any[] = []
    const { d } = deps({ core: async (m, p) => { seen.push(p)
      if (p.startsWith('/api/feed/search')) return { status: 200, json: { total: 3, cards: [
        { ...post, read: true }, { ...post, id: 5, superseded_by: 7, superseded_by_author: 'cadmus', touches: [], ref: null, read: false }] } }
      if (p === '/api/feed/read') return { status: 200, json: { marked: 1 } }
      return { status: 200, json: { ...post, body: '全文在這', links: [], read: false } } } })
    const t = out(await handleFleetRpc(tool('feed_search', { q: 'ton 網域', limit: 99 }), d))
    expect(seen[0]).toBe('/api/feed/search?q=ton%20%E7%B6%B2%E5%9F%9F&limit=50')
    expect(t).toContain('3 則對上，列出最新的 2 則：')
    expect(t).toContain('#7｜11-15 07:52Z｜hephaestus｜Hephaestus：ton 網域改走 Cloudflare｜讀過')
    expect(t).toContain('#5｜11-15 07:52Z｜hephaestus｜Hephaestus：ton 網域改走 Cloudflare｜已被 #7（cadmus）取代')
    expect(t).not.toContain('全文')
    const or = await handleFleetRpc(tool('feed_open', { id: 7 }), d)
    expect(out(or)).toContain('全文在這')
    expect(seen.slice(1)).toEqual(['/api/feed/posts/7'])
    await takeAfterSend([or])[0]()
    expect(seen.slice(1)).toEqual(['/api/feed/posts/7', '/api/feed/read'])
  })
})
