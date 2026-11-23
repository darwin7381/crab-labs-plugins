// WO-126 (seam claude-epeius/knowledge/lane-mailbox-seam.md v2): the mailbox side of the lane boundary in fleet-mail.ts. The main's list line says
// what to decide, by when, the recommendation; open shows the card and the original; mailbox_decide is the main's, once, and hands the router its event;
// the lanes' decide_later / mailbox_card reach BTCC with by=lane and the lane's id. Mail without a card reads exactly as before.
import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { CARD_SCHEMA, DECIDE_TOOL, INBOX_TOOLS, LANE_DECIDE_LATER_TOOL, MAILBOX_CARD_TOOL, callInboxTool, type FleetDeps } from './fleet-mail.ts'

const CARD = { decide: '週三 02:00 停機要不要照排', deadline: '2026-11-24T12:00:00+00:00', recommend: '照排' }
const FULL = { ...CARD, facts: '影響 3 個站；細節 /tmp/plan.md', basis: '流量最低', then: '回 lynx、掛排程' }
function deps(routes: Record<string, (body: any) => { status: number; json: any }>, over: Partial<FleetDeps> = {}) {
  const seen: any[] = []
  const d: FleetDeps = {
    call: async () => 'delivered',
    btcc: async (method, path, body) => { seen.push({ method, path, body }); const f = routes[`${method} ${path}`]; return f ? f(body) : { status: 404, json: { detail: `no route ${path}` } } },
    core: async () => ({ status: 200, json: {} }),
    ...over,
  }
  return { d, seen }
}
const msg = (r: any) => String(r.content[0].text)

test('list: a card line says what to decide, the decision deadline and the recommendation; a lane item names its lane; plain mail unchanged', async () => {
  const mail = [
    { id: 1, from: 'lynx', title: 'Lynx：維護時段', ask: '回可不可以', deadline: '2026-11-25T00:00:00+00:00', waited: '5 分鐘', status: 'lane_read', lane_read_at: '2026-11-24T06:00:00+00:00',
      no_reply: false, card: CARD, from_lane: null, card_lane: 'kot.mail.1', decision: null },
    { id: 2, from: 'kot', title: 'Kot：重開 daemon', ask: '要不要重開', deadline: '2026-11-24T07:00:00+00:00', waited: '1 分鐘', status: 'lane_read', lane_read_at: '2026-11-24T06:10:00+00:00',
      no_reply: true, card: { decide: '要不要重開', deadline: '2026-11-24T07:00:00+00:00', recommend: '重開' }, from_lane: 'kot.reflex.2', card_lane: 'kot.reflex.2', decision: 'as_recommended' },
    { id: 3, from: 'eve', title: 'Eve：週報', ask: '收下', deadline: '2026-11-25T00:00:00+00:00', waited: '2 分鐘', status: 'unread', lane_read_at: null, no_reply: true },
  ]
  const { d } = deps({ 'GET /api/mesh/mail/list': () => ({ status: 200, json: { mail } }) })
  const lines = msg(await callInboxTool('mailbox_list', {}, d, false)).split('\n')
  expect(lines[1]).toBe('其中 1 件等你決定（mailbox_decide 回）。')
  expect(lines[2]).toBe('#1｜lynx｜Lynx：維護時段｜要你決定：週三 02:00 停機要不要照排｜決定期限 11-24 12:00Z｜建議：照排｜等了 5 分鐘｜車道讀過 11-24 06:00Z（主線還沒打開）')
  expect(lines[3]).toBe('#2｜kot（分身 kot.reflex.2）｜Kot：重開 daemon｜要你決定：要不要重開｜決定期限 11-24 07:00Z｜建議：重開｜已決定：照建議｜等了 1 分鐘')
  expect(lines[4]).toBe('#3｜eve｜Eve：週報｜要你：收下｜期限 11-25 00:00Z｜等了 2 分鐘｜未讀｜不用回')
  // without any card, the list reads exactly as before WO-126 (criterion 6)
  const { d: d0 } = deps({ 'GET /api/mesh/mail/list': () => ({ status: 200, json: { mail: [mail[2]] } }) })
  expect(msg(await callInboxTool('mailbox_list', {}, d0, false))).toBe('1 封未讀、0 封已讀還沒勾掉：\n#3｜eve｜Eve：週報｜要你：收下｜期限 11-25 00:00Z｜等了 2 分鐘｜未讀｜不用回')
})

test('open: the card (five boxes, who put it, how to answer) and then the original; a lane item shows its card once', async () => {
  const m = { id: 1, from: 'lynx', title: 'Lynx：維護時段', ask: '回可不可以', body: '週三 02:00 可以嗎？', deadline: '2026-11-25T00:00:00+00:00', waited: '5 分鐘',
    no_reply: false, status: 'read', lane_read_at: '2026-11-24T06:00:00+00:00', card: FULL, card_lane: 'kot.mail.1', card_at: '2026-11-24T06:01:00+00:00', from_lane: null, decision: null }
  const { d } = deps({ 'GET /api/mesh/mail/1': () => ({ status: 200, json: m }), 'GET /api/mesh/mail/2': () => ({ status: 200, json: { ...m, id: 2, from: 'kot', from_lane: 'kot.reflex.2',
    body: '要你決定：…', decision: 'changed', note: '改週四', decided_at: '2026-11-24T06:20:00+00:00' } }) })
  const t = msg(await callInboxTool('mailbox_open', { id: 1 }, d, false))
  expect(t).toContain('── 決定卡（kot.mail.1 附的卡，11-24 06:01Z）──\n要你決定：週三 02:00 停機要不要照排\n期限：11-24 12:00Z\n關鍵事實：影響 3 個站；細節 /tmp/plan.md\n建議：照排\n根據：流量最低\n說好之後：回 lynx、掛排程\n用 mailbox_decide 回')
  expect(t.endsWith('── 原信 ──\n週三 02:00 可以嗎？')).toBe(true)
  const t2 = msg(await callInboxTool('mailbox_open', { id: 2 }, d, false))
  expect(t2).toContain('分身 kot.reflex.2 放的件')
  expect(t2).toContain('已決定（11-24 06:20Z）：改成：改週四')
  expect(t2).not.toContain('原信')
})

test('mailbox_decide: the main only; the answer goes to BTCC once and its event to the router; lanes off says do it yourself', async () => {
  const decided = { id: 1, title: 'Lynx：維護時段', decision: 'as_recommended', note: null, lane: 'kot.mail.1', thread: 'kot#t-1', card: CARD, ref: null }
  const events: any[] = []
  const { d, seen } = deps({ 'POST /api/mesh/mail/1/decide': () => ({ status: 200, json: decided }),
    'POST /api/mesh/mail/9/decide': () => ({ status: 409, json: { detail: 'mail #9 was already decided (as_recommended, 11-24 06:20Z); once only' } }) },
    { mailEvent: async j => { events.push(j); return 'handed' } })
  const r = await callInboxTool('mailbox_decide', { id: 1, decision: 'as_recommended' }, d, false)
  expect(r.isError).toBeUndefined()
  expect(msg(r)).toBe('#1 記下決定：照建議。已交給 kot.mail.1（kot#t-1） 接著做完，它會向 Joey 回報。')
  expect(seen.at(-1)).toEqual({ method: 'POST', path: '/api/mesh/mail/1/decide', body: { decision: 'as_recommended' } })
  expect(events).toEqual([decided])
  const again = await callInboxTool('mailbox_decide', { id: 9, decision: 'declined' }, d, false)
  expect(again.isError).toBe(true); expect(msg(again)).toContain('once only')
  expect(events.length).toBe(1)
  const { d: q } = deps({ 'POST /api/mesh/mail/1/decide': () => ({ status: 200, json: { ...decided, decision: 'changed', note: '週四' } }) }, { mailEvent: async () => 'queued' })
  expect(msg(await callInboxTool('mailbox_decide', { id: 1, decision: 'changed', note: '週四' }, q, false))).toContain('分流器現在連不上，決定排著')
  const { d: off } = deps({ 'POST /api/mesh/mail/1/decide': () => ({ status: 200, json: decided }) })
  expect(msg(await callInboxTool('mailbox_decide', { id: 1, decision: 'as_recommended' }, off, false))).toContain('車道沒開：照這個決定自己做完')
  const { d: lane, seen: ls } = deps({}, { openBy: 'lane', lane: 'kot.mail.1' })
  const lr = await callInboxTool('mailbox_decide', { id: 1, decision: 'as_recommended' }, lane, false)
  expect(lr.isError).toBe(true); expect(msg(lr)).toContain('只有主線回決定'); expect(ls).toEqual([])
})

test('the lanes\' calls: decide_later → POST /lane-item?by=lane with the lane id; mailbox_card → POST /{id}/card?by=lane; the main cannot use them', async () => {
  const { d, seen } = deps({ 'POST /api/mesh/mail/lane-item?by=lane': () => ({ status: 200, json: { id: 77, deadline: '2026-11-24T07:00:00+00:00', ref: 'ev-1' } }),
    'POST /api/mesh/mail/5/card?by=lane': () => ({ status: 200, json: { id: 5, status: 'lane_read', deadline: '2026-11-24T12:00:00+00:00' } }),
    'POST /api/mesh/mail/6/card?by=lane': () => ({ status: 409, json: { detail: 'no card on mail #6: it already has a card (kot.mail.1, 11-24 06:01Z); one card per mail' } }) },
    { openBy: 'lane', lane: 'kot.reflex.2' })
  const r = await callInboxTool('decide_later', { title: 'Kot：重開 daemon', card: CARD, deadline: '2', ref: 'ev-1', thread: 'kot#t-9' }, d, false)
  expect(msg(r)).toContain('#77')
  expect(seen[0]).toEqual({ method: 'POST', path: '/api/mesh/mail/lane-item?by=lane',
    body: { lane: 'kot.reflex.2', thread: 'kot#t-9', title: 'Kot：重開 daemon', card: CARD, deadline: 2, ref: 'ev-1' } })
  expect(msg(await callInboxTool('mailbox_card', { id: 5, card: CARD }, d, false))).toContain('#5 附上決定卡了')
  expect(seen[1]).toEqual({ method: 'POST', path: '/api/mesh/mail/5/card?by=lane', body: { lane: 'kot.reflex.2', card: CARD } })
  const dup = await callInboxTool('mailbox_card', { id: 6, card: CARD }, d, false)
  expect(dup.isError).toBe(true); expect(msg(dup)).toContain('one card per mail')
  const noCard = await callInboxTool('decide_later', { title: 't' }, d, false)
  expect(noCard.isError).toBe(true)
  const { d: mainD, seen: ms } = deps({})
  const m = await callInboxTool('decide_later', { title: 't', card: CARD }, mainD, false)
  expect(m.isError).toBe(true); expect(ms).toEqual([])
})

test('tool shapes: the main\'s list is unchanged (mailbox_decide is added by server.ts only with lanes on); the card schema requires decide and recommend', () => {
  expect(INBOX_TOOLS.map(t => t.name)).not.toContain('mailbox_decide')
  expect(DECIDE_TOOL.inputSchema.properties.decision.enum).toEqual(['as_recommended', 'changed', 'declined'])
  expect(CARD_SCHEMA.required).toEqual(['decide', 'recommend'])
  expect(LANE_DECIDE_LATER_TOOL.inputSchema.required).toEqual(['title', 'card'])
  expect(MAILBOX_CARD_TOOL.inputSchema.required).toEqual(['id', 'card'])
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  expect(src).toContain("...(Lanes.LANES_ON ? [DECIDE_TOOL] : [])")
  expect(src).toContain("mailEvent: (decided: any) => mailEvents.emit(decisionEvent(decided))")
  expect(src).toContain("btccMail('GET', `/api/mesh/mail/due?within=${MAIL_DUE_WITHIN_S}`)")
  expect(src).toContain("{ ...fleetDeps, openBy: 'lane', lane }")
})
