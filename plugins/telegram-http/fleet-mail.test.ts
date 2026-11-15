import { describe, expect, test } from 'bun:test'
import { FLEET_INSTRUCTIONS, FLEET_TOOLS, handleFleetRpc, type FleetDeps } from './fleet-mail.ts'
import { FLEET_TEXT } from './fleet-text.ts'

function deps(over: Partial<FleetDeps> = {}) {
  const calls: any[] = []
  const btccCalls: any[] = []
  const d: FleetDeps = {
    call: async (to, text, replyTo, noReply, op) => { calls.push({ to, text, replyTo, noReply, op }); return `delivered to ${to}'s inbox` },
    btcc: async (method, path, body) => { btccCalls.push({ method, path, body }); return { status: 200, json: {} } },
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
  test('tools/list', async () => {
    const r = await handleFleetRpc(rpc('tools/list'), deps().d)
    expect(r.result.tools.map((t: any) => t.name)).toEqual(
      ['call', 'send_mail', 'mailbox_list', 'mailbox_open', 'mailbox_check', 'mailbox_reply', 'mail_sent'])
    expect(FLEET_TOOLS.length).toBe(7)
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
