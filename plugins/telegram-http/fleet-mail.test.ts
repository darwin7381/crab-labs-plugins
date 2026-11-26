import { describe, expect, test } from 'bun:test'
import { FLEET_INSTRUCTIONS, FLEET_TOOLS, feedPath, handleFleetRpc, takeAfterSend, type FleetDeps } from './fleet-mail.ts'
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
    expect(FLEET_TEXT.startsWith('艦隊通訊：一個工具，三級')).toBe(true)
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
  test('send_mail: a title over 50 is not refused here — it goes to the server, which cuts it, and the sender is told (Joey TG chiron:1407)', async () => {
    const seen: any[] = []
    const { d } = deps({ btcc: async (m, p, b) => { seen.push(b); return { status: 200, json: { id: 5, stored: true, title_truncated: true } } } })
    const r = await handleFleetRpc(tool('send_mail', { to: 'chiron', title: '一'.repeat(51), body: 'b' }), d)
    expect(r.result.isError).toBeUndefined()
    expect(seen[0].title).toBe('一'.repeat(51))
    expect(out(r)).toContain('標題超過 50 字，已截短，完整標題在內容第一行')
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
    const long = await handleFleetRpc(tool('mailbox_reply', { id: 11, body: 'x', title: '一'.repeat(51) }), d)
    expect(long.result.isError).toBeUndefined()      // the server cuts it (Joey 1407), nothing refused here
  })
  test('WO-124: the lane opens with by=lane; the main opens without; list and sent say who read it', async () => {
    const seen: string[] = []
    const btcc = async (m: string, p: string) => {
      seen.push(p)
      if (p.startsWith('/api/mesh/mail/list')) return { status: 200, json: { mail: [
        { id: 21, from: 'pheme', title: 'A', deadline: null, waited: '1 分鐘', no_reply: false, status: 'lane_read', lane_read_at: '2026-11-23T11:18:00+00:00' },
        { id: 22, from: 'atlas', title: 'B', deadline: null, waited: '2 分鐘', no_reply: false, status: 'unread' }] } }
      if (p.startsWith('/api/mesh/mail/sent')) return { status: 200, json: { sent: [
        { id: 21, to: 'chiron', title: 'A', deadline: null, status: 'lane_read', read_at: null, lane_read_at: '2026-11-23T11:18:00+00:00' },
        { id: 23, to: 'chiron', title: 'C', deadline: null, status: 'read', read_at: '2026-11-23T12:00:00+00:00', lane_read_at: '2026-11-23T11:30:00+00:00' },
        { id: 24, to: 'chiron', title: 'D', deadline: null, status: 'checked', read_at: null, lane_read_at: '2026-11-23T11:40:00+00:00' },
        { id: 25, to: 'pheme', title: 'E', deadline: null, status: 'read', read_at: '2026-11-23T12:10:00+00:00', lane_read_at: null }] } }
      return { status: 200, json: { id: 21, from: 'pheme', title: 'A', body: '全文', deadline: null, waited: '1 分鐘', no_reply: false,
        status: p.includes('by=lane') ? 'lane_read' : 'read', lane_read_at: '2026-11-23T11:18:00+00:00' } }
    }
    const lane = deps({ btcc }).d as any
    lane.openBy = 'lane'
    const lo = out(await handleFleetRpc(tool('mailbox_open', { id: 21 }), lane))
    expect(seen.at(-1)).toBe('/api/mesh/mail/21?by=lane')
    // WO-173: a lane that knows its id names it, so Onsen records which session read the mail first
    lane.lane = 'chiron.mail.3'
    await handleFleetRpc(tool('mailbox_open', { id: 21 }), lane)
    expect(seen.at(-1)).toBe('/api/mesh/mail/21?by=lane&lane=chiron.mail.3')
    expect(lo).toContain('車道讀過（寄件人看到的是車道讀過，不是主線已讀）')
    const main = deps({ btcc }).d
    const mo = out(await handleFleetRpc(tool('mailbox_open', { id: 21 }), main))
    expect(seen.at(-1)).toBe('/api/mesh/mail/21')                                   // the main's open: no by → 主線已讀
    expect(mo).toContain('車道 11-23 11:18Z 先讀過')
    const l = out(await handleFleetRpc(tool('mailbox_list'), main))
    expect(l.split('\n')[0]).toBe('1 封未讀、1 封車道讀過（等主線）、0 封已讀還沒勾掉：')
    expect(l).toContain('#21｜pheme｜A｜期限 —｜等了 1 分鐘｜車道讀過 11-23 11:18Z（主線還沒打開）')
    const s = out(await handleFleetRpc(tool('mail_sent'), main))
    expect(s).toContain('#21｜給 chiron｜A｜期限 —｜車道讀過 11-23 11:18Z，主線還沒看')
    expect(s).toContain('#23｜給 chiron｜C｜期限 —｜主線已讀 11-23 12:00Z（車道 11-23 11:30Z 先讀）')
    expect(s).toContain('#24｜給 chiron｜D｜期限 —｜勾掉了（車道讀過 11-23 11:40Z，主線沒打開）')
    expect(s).toContain('#25｜給 pheme｜E｜期限 —｜已讀 11-23 12:10Z')               // a recipient without lanes: as before
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
  test('feed_post: six touches never leave the daemon; a long title goes to the server; posted → told nobody is notified', async () => {
    const seen: any[] = []
    const { d } = deps({ core: async (m, p, b) => { seen.push([m, p, b]); return { status: 200, json: { id: 12 } } } })
    expect((await handleFleetRpc(tool('feed_post', { title: 't', body: 'b', touches: ['a', 'b', 'c', 'd', 'e', 'f'] }), d)).result.isError).toBe(true)
    expect(seen.length).toBe(0)
    const cutR = await handleFleetRpc(tool('feed_post', { title: '一'.repeat(51), body: 'b' }),
      deps({ core: async () => ({ status: 200, json: { id: 13, title_truncated: true } }) }).d)
    expect(out(cutR)).toContain('標題超過 50 字，已截短')
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
    expect(seen[0]).toEqual(['POST', '/api/feed/ask', { about: '要改 ton 網域', two_step: true }, 20000])
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
  // WO-167 section four (c), Chiron 00:27Z: more related than give_max → Onsen gives each post's line only; nothing given in full, nothing marked
  const LINES = { about: '要改 ton 網域', candidates: 40, judged: 39, related: 25, given: [], more: 0, unjudged: 1, jev: 'ok', mode: 'lines', give_max: 20,
    offset: 0, ask_id: 9, next_cursor: 'ask.9.2', lines: [
      { id: 300690, line: '#300690｜2026-11-26 08:10（Asia/Taipei）｜hephaestus｜動態｜Hephaestus：ton DNS｜WO-25｜動到：ton-dns' },
      { id: 300645, line: '#646｜2026-11-24 16:05（Asia/Taipei）｜epeius｜動態｜Mac mini: TUIs dropped｜WO-126｜動到：tmux' }] }
  test('feed_ask: over give_max, the lines only; open them with feed_open; nothing marked', async () => {
    const seen: any[] = []
    const { d } = deps({ core: async (m, p, b, t) => { seen.push([m, p, b, t]); return { status: 200, json: LINES } } })
    const res = await handleFleetRpc(tool('feed_ask', { about: '要改 ton 網域' }), d)
    const t = out(res)
    expect(seen[0]).toEqual(['POST', '/api/feed/ask', { about: '要改 ton 網域', two_step: true }, 20000])
    expect(t).toBe([
      '跟這件事有關的有 25 則，比一次給全文的 20 則多，先給短卡（新的在前；列出短卡不算讀）：',
      LINES.lines[0].line, LINES.lines[1].line, '',
      '要讀哪幾則，用 feed_open 打開（打開才算讀過）。',
      '還有 23 則短卡：再用 feed_ask，about 照填，加 cursor「ask.9.2」看下一頁。',
      '另外 1 則 Jev 沒判到，可以用 feed_search 找。'].join('\n'))
    expect(res.result.isError).toBeUndefined()
    expect(takeAfterSend([res]).length).toBe(0)
    expect(seen.length).toBe(1)
  })
  test('feed_ask with a cursor: the next page; the last page says no more; a cursor Onsen refuses is an error', async () => {
    const seen: any[] = []
    let reply: any = { status: 200, json: { ...LINES, offset: 2, next_cursor: null, unjudged: 1, lines: [LINES.lines[0]] } }
    const { d } = deps({ core: async (m, p, b) => { seen.push(b); return reply } })
    const t = out(await handleFleetRpc(tool('feed_ask', { about: '要改 ton 網域', cursor: 'ask.9.2' }), d))
    expect(seen[0]).toEqual({ about: '要改 ton 網域', two_step: true, cursor: 'ask.9.2' })
    expect(t).toBe(['接著的短卡（第 3–3 則，共 25 則）：', LINES.lines[0].line, '', '要讀哪幾則，用 feed_open 打開（打開才算讀過）。'].join('\n'))
    reply = { status: 400, json: { detail: 'cursor 對不上：不是你問過、還有下一頁的那一次' } }
    const r = await handleFleetRpc(tool('feed_ask', { about: 'x', cursor: 'ask.1.0' }), d)
    expect(r.result.isError).toBe(true)
    expect(out(r)).toBe('cursor 對不上：不是你問過、還有下一頁的那一次')
  })
  test('feed_ask: at or under give_max the full texts as before (mode full); an Onsen without two steps (no mode) as before', async () => {
    const full = { candidates: 2, judged: 2, related: 1, more: 0, unjudged: 0, jev: 'ok', given: [{ ...post, body: '全文', links: [], read: false }] }
    for (const json of [{ ...full, mode: 'full', give_max: 20 }, full]) {
      const { d } = deps({ core: async () => ({ status: 200, json }) })
      const res = await handleFleetRpc(tool('feed_ask', { about: 'x' }), d)
      expect(out(res).startsWith('跟這件事有關的 1 則（全文，新的在前；給了就算讀過）：')).toBe(true)
      expect(takeAfterSend([res]).length).toBe(1)
    }
  })
  test('feed_ask takes an optional cursor; about stays required', () => {
    const ask = FLEET_TOOLS.find(t => t.name === 'feed_ask')!
    expect(ask.inputSchema.required).toEqual(['about'])
    expect(Object.keys(ask.inputSchema.properties)).toEqual(['about', 'cursor'])
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

// ── WO-99 v3: send_to_agent, one tool, three lines (Joey TG chiron:1503) ──
import { ASK_MISSING, BECAUSE_MISSING, INBOX_TOOLS, LINE_MISSING, callInboxTool, sendToAgent } from './fleet-mail.ts'
import { INBOX_TEXT } from './inbox-text.ts'

describe('send_to_agent (three lines)', () => {
  const coreCalls: any[] = []
  const mk = () => {
    const r = deps({ core: async (method, path, body) => { coreCalls.push({ method, path, body }); return { status: 200, json: { id: 47 } } } })
    r.d.btcc = async (method, path, body) => { r.btccCalls.push({ method, path, body }); return { status: 200, json: { id: 9, stored: true } } }
    return r
  }
  const msg = (r: any) => r.content[0].text as string

  test('the tools: send_to_agent plus the receiving ones; no call / send_mail / feed_post', () => {
    const names = INBOX_TOOLS.map(t => t.name)
    expect(names[0]).toBe('send_to_agent')
    expect(names).toEqual(['send_to_agent', 'mailbox_list', 'mailbox_open', 'mailbox_check', 'mailbox_reply', 'mail_sent', 'feed_ask', 'feed_search', 'feed_open'])
    expect((INBOX_TOOLS[0] as any).inputSchema.required).toEqual(['line', 'text'])
    expect(INBOX_TEXT.split('\n')[0]).toBe('send_to_agent：找別隻 agent 只有這一個工具，底下三條線')
  })
  test('no line: the spec\'s sentence (old shape is a call only while legacy is on)', async () => {
    const r = mk()
    expect(msg(await sendToAgent({ to: 'chiron', text: 'x' }, r.d, false))).toBe(LINE_MISSING)
    expect(r.calls).toEqual([])
    await sendToAgent({ to: 'chiron', text: 'x', no_reply: true }, r.d, true)
    expect(r.calls).toEqual([{ to: 'chiron', text: 'x', replyTo: undefined, noReply: true, op: undefined }])
    expect(msg(await sendToAgent({ text: 'x' }, r.d, true))).toBe(LINE_MISSING)
  })
  test('mail: ask required; sent with ask, text as the body', async () => {
    const r = mk()
    const out = await sendToAgent({ line: 'mail', to: 'chiron', title: 't', text: 'body' }, r.d, true)
    expect(msg(out)).toBe(ASK_MISSING)
    expect(r.btccCalls).toEqual([])
    await sendToAgent({ line: 'mail', to: 'chiron', title: 't', ask: '決定 A 或 B', text: 'body', no_reply: true }, r.d, true)
    expect(r.btccCalls[0].path).toBe('/api/mesh/mail/send')
    expect(r.btccCalls[0].body).toMatchObject({ to: 'chiron', title: 't', body: 'body', ask: '決定 A 或 B', no_reply: true })
  })
  test('call: because required unless it answers a call; because goes first in the text', async () => {
    const r = mk()
    expect(msg(await sendToAgent({ line: 'call', to: 'chiron', text: 'x' }, r.d, true))).toBe(BECAUSE_MISSING)
    expect(r.calls).toEqual([])
    await sendToAgent({ line: 'call', to: 'chiron', because: 'Joey 在等', text: '看一下' }, r.d, true)
    expect(r.calls[0].text).toBe('因為：Joey 在等\n看一下')
    await sendToAgent({ line: 'call', to: 'chiron', reply_to: '9651', text: '好了' }, r.d, true)
    expect(r.calls[1]).toMatchObject({ text: '好了', replyTo: 9651, noReply: true })
  })
  test('feed: a wall post, text as the body', async () => {
    const r = mk()
    coreCalls.length = 0
    await sendToAgent({ line: 'feed', title: '做完了', text: '細節', touches: ['a'] }, r.d, true)
    expect(coreCalls[0]).toMatchObject({ method: 'POST', path: '/api/feed/posts', body: { title: '做完了', body: '細節', touches: ['a'] } })
  })
  test('old tool names only while legacy is on', async () => {
    const r = mk()
    expect(msg(await callInboxTool('call', { to: 'chiron', text: 'x' }, r.d, false))).toBe('unknown tool: call')
    await callInboxTool('call', { to: 'chiron', text: 'x' }, r.d, true)
    expect(r.calls.length).toBe(1)
  })
  test('the mailbox shows what the sender asks for', async () => {
    const r = mk()
    r.d.btcc = async (_m, path) => path.endsWith('/list')
      ? { status: 200, json: { mail: [{ id: 3, from: 'chiron', title: 't', ask: '回答 X', deadline: null, waited: '1 分鐘', status: 'unread' }] } }
      : { status: 200, json: { id: 3, from: 'chiron', title: 't', ask: '回答 X', deadline: null, waited: '1 分鐘', body: 'b' } }
    expect(msg(await callInboxTool('mailbox_list', {}, r.d, true))).toContain('｜要你：回答 X｜')
    expect(msg(await callInboxTool('mailbox_open', { id: 3 }, r.d, true))).toContain('\n要你：回答 X\n')
  })
})

describe('WO-167 feedPath (FEED_ONSEN)', () => {
  const PATHS = ['/api/feed/posts', '/api/feed/posts/646', '/api/feed/read', '/api/feed/ask', '/api/feed/search?q=ton%20dns&limit=50', '/api/feed/me',
    '/api/feed/config', '/api/feed/asks?hours=24']
  test('on: every /api/feed call goes to /api/onsen/feed, the rest of the path and the query as given', () => {
    expect(PATHS.map(p => feedPath(p, true))).toEqual(['/api/onsen/feed/posts', '/api/onsen/feed/posts/646', '/api/onsen/feed/read', '/api/onsen/feed/ask',
      '/api/onsen/feed/search?q=ton%20dns&limit=50', '/api/onsen/feed/me', '/api/onsen/feed/config', '/api/onsen/feed/asks?hours=24'])
    expect(feedPath('/api/feed', true)).toBe('/api/onsen/feed')
  })
  test('off: exactly the path as given; anything that is not the wall is never touched', () => {
    for (const p of PATHS) expect(feedPath(p, false)).toBe(p)
    for (const p of ['/api/mesh/mail/send', '/api/feeds', '/api/feedback', '/api/onsen/feed/posts', '/x/api/feed/posts']) {
      expect(feedPath(p, true)).toBe(p)
      expect(feedPath(p, false)).toBe(p)
    }
  })
  test('the feed tools keep naming /api/feed; with the switch on, the paths they reach are Onsen\'s and the texts are the same', async () => {
    const card = { id: 300645, legacy_id: 646, time: '2026-11-25T19:21:00+00:00', author: 'epeius', title: 'Mac mini: TUIs', touches: [], ref: null,
      supersedes: null, superseded_by: null, superseded_by_author: null }
    const run = async (onsen: boolean) => {
      const seen: string[] = []
      const answer = (p: string) => p.endsWith('/posts') ? { id: 300700 } : p.endsWith('/ask') ? { candidates: 1, judged: 1, related: 1, more: 0, unjudged: 0, jev: 'ok',
        given: [{ ...card, body: '全文', links: [], read: false }] } : p.includes('/search') ? { total: 1, cards: [card] }
        : p.endsWith('/read') ? { marked: 1 } : p.endsWith('/me') ? { ask: true } : { ...card, body: '全文', links: [], read: false }
      const { d } = deps({ core: async (m, p) => { const q = feedPath(p, onsen); seen.push(`${m} ${q}`); return { status: 200, json: answer(q) } } })
      const texts: string[] = []
      for (const [name, args] of [['feed_post', { title: 't', body: 'b' }], ['feed_ask', { about: '要改 ton 網域' }], ['feed_search', { q: 'mac' }],
        ['feed_open', { id: 646 }]] as const) {
        const r = await handleFleetRpc(tool(name, args), d)
        texts.push(out(r))
        for (const h of takeAfterSend([r])) await h()
      }
      await handleFleetRpc(rpc('tools/list'), d)
      return { seen, texts }
    }
    const on = await run(true), off = await run(false)
    expect(on.seen).toEqual(['POST /api/onsen/feed/posts', 'POST /api/onsen/feed/ask', 'POST /api/onsen/feed/read', 'GET /api/onsen/feed/search?q=mac&limit=20',
      'GET /api/onsen/feed/posts/646', 'POST /api/onsen/feed/read', 'GET /api/onsen/feed/me'])
    expect(off.seen).toEqual(on.seen.map(x => x.replace('/api/onsen/feed', '/api/feed')))
    expect(on.texts).toEqual(off.texts)
    expect(on.texts[3]).toContain('#300645｜')
  })
})
