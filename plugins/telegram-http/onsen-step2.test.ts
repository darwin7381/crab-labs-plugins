// Onsen step 2 (WO-142): Joey's /clear draws a restart line, his button lifts it, chat_history shows the line (Onsen and the local spool alike), and an
// edited message reaches the agent. A stand-in Onsen (a fake fetch) and fakes for the daemon; tmux on its own socket dir (never the machine's server).
import { test, expect, describe, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { OnsenClient, inboundItem, outboundRecord, withSender, sendCtx, liftData, idemLine, formatFull, restartHead, behindLine } from './onsen-client.ts'
import { editHeader, editorName, originalTime, rewriteQueued, deliverEdit, DeliveredIndex, carries, rewritten, JOEY_TG_ID } from './onsen-edit.ts'

const CRED = 'mesh_STEP2************************************'
const AGENT = 'adam'
const JOEY = '1828'
const T0 = 1764020000

/** a stand-in Onsen with restart lines: list / one / alias apply the newest unlifted line to the agent's own reads, as fleet-core 0.4.0 does */
function fakeOnsen() {
  const msgs: any[] = []
  const lines: any[] = []
  const events: any[] = []
  const calls: Array<{ method: string; path: string; body: any; at: number }> = []
  const st = { down: false, hang: false, hangDraw: false }
  let next = 1
  const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } })
  const active = (chat: string) => lines.filter(l => l.chat === chat && !l.lifted_at).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null
  const out = (l: any) => ({ id: l.id, at: l.at, chat: l.chat, by: l.by, lifted_at: l.lifted_at ?? null, lifted_by: l.lifted_by ?? null })
  const behind = (m: any): string | null => {
    const l = active(m.chat)
    if (!l || Date.parse(m.sent_at) > Date.parse(l.at)) return null
    const quoted = msgs.some(q => q.chat === m.chat && Date.parse(q.sent_at) > Date.parse(l.at) && q.reply_to_client_msg_id === m.client_msg_id)
    return quoted ? null : l.at
  }
  const f = (async (input: any, init?: any) => {
    const url = new URL(String(input)), path = url.pathname.replace(/^\/api\/onsen/, '')
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ method: init?.method ?? 'GET', path: path + url.search, body, at: Date.now() })
    const hangs = st.hang || (st.hangDraw && path === '/restart-lines' && init?.method === 'POST')
    if (hangs) return new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }))))
    if (st.down) throw new TypeError('fetch failed: connect ECONNREFUSED')
    if (init?.headers?.Authorization !== `Bearer ${CRED}`) return json(401, { error: 'no credential' })
    if (init?.method === 'POST' && path === '/messages/batch') return json(200, { results: body.items.map((it: any) => { msgs.push({ ...it, id: next }); return { id: next++, duplicate: false } }) })
    if (init?.method === 'POST' && path === '/events') { events.push(body); return json(200, { id: next++, duplicate: false }) }
    if (init?.method === 'POST' && path === '/restart-lines') {
      const had = lines.find(l => l.idem_key === body.idem_key)
      if (had) return json(200, { id: had.id, at: had.at, duplicate: true })
      const l = { ...body, id: next++ }; lines.push(l)
      return json(200, { id: l.id, at: l.at, duplicate: false })
    }
    if (init?.method === 'POST' && path === '/restart-lines/lift') {
      const l = body.line_id != null ? lines.find(x => x.id === body.line_id && x.chat === body.chat) : active(body.chat)
      if (!l) return json(404, { detail: `no restart line to lift for ${body.agent} in ${body.chat}` })
      if (l.lifted_at) return json(200, { ...out(l), duplicate: true, active: [] })
      l.lifted_at = body.at; l.lifted_by = body.by
      return json(200, { ...out(l), duplicate: false, active: lines.filter(x => x.chat === body.chat && !x.lifted_at).map(out) })
    }
    if (path === '/messages') {
      const chat = url.searchParams.get('chat') ?? JOEY
      const l = active(chat)
      const rows = msgs.filter(m => m.chat === chat && (!l || Date.parse(m.sent_at) > Date.parse(l.at))).sort((a, b) => b.id - a.id)
      return json(200, { messages: rows.map(m => ({ id: m.id, at: m.sent_at, direction: m.direction, sender: m.sender === `tg:${JOEY}` ? 'joey' : m.sender, kind: m.kind, body: m.body,
        truncated: false, edited: false, client_msg_id: m.client_msg_id, status: 'ok', chat: m.chat })), total: rows.length,
        restart_line: l ? out(l) : null, restart_lines: l ? [out(l)] : [], restart_line_applied: !!l })
    }
    const one = /^\/messages\/(\d+)$/.exec(path)
    if (one) {
      const m = msgs.find(x => x.id === Number(one[1]))
      if (!m) return json(404, { detail: 'no message' })
      const b = behind(m)
      return b ? json(404, { detail: { restart_line: b, message: m.id, why: 'before Joey\'s restart line' } }) : json(200, { ...m, at: m.sent_at, events: [] })
    }
    const alias = /^\/alias\/telegram\/([^/]+)\/([^/]+)\/(\d+)$/.exec(path)
    if (alias) {
      const m = msgs.find(x => x.chat === alias[2] && x.client_msg_id === alias[3])
      if (!m) return json(404, { detail: 'no alias' })
      const b = behind(m)
      return b ? json(404, { detail: { restart_line: b, message: m.id, why: 'before' } }) : json(200, { ...m, at: m.sent_at, events: [] })
    }
    return json(404, { error: 'no route' })
  }) as typeof fetch
  return { f, msgs, lines, events, calls, st }
}
const tmp = () => mkdtempSync(join(tmpdir(), 'onsen-step2-'))
function client(dir: string, f: typeof fetch, o: { record?: boolean; logs?: string[]; cred?: string | null } = {}) {
  const logs = o.logs ?? []
  return new OnsenClient({ dir, base: 'https://onsen.test/api/onsen', agent: AGENT, record: o.record ?? true, credential: () => o.cred === undefined ? CRED : o.cred,
    log: (l, m) => logs.push(`${l} ${m}`), fetch: f, intervalMs: 3_600_000, queryTimeoutMs: 300, joeyChat: () => JOEY })
}
const tgMsg = (id: number, text: string, extra: Record<string, any> = {}) => ({ message_id: id, date: T0 + id, chat: { id: Number(JOEY), type: 'private' },
  from: { id: Number(JOEY), is_bot: false, first_name: 'J', username: 'joey' }, text, ...extra })
const spoolLines = (c: OnsenClient): any[] => existsSync(c.spool) ? readFileSync(c.spool, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []

describe('restart lines: draw and lift', () => {
  test('/clear draws directly: the body Onsen gets, the id kept in lines.json, the button data', async () => {
    const o = fakeOnsen(), c = client(tmp(), o.f)
    const r = await c.drawLine({ chat: JOEY, clientMsgId: 500, by: `tg:${JOEY}` })
    expect(r).toMatchObject({ spooled: false, idem_key: `tg:${AGENT}:${JOEY}:line:500` })
    expect(r!.id).toBeGreaterThan(0)
    const call = o.calls.find(x => x.path === '/restart-lines')!
    expect(call.method).toBe('POST')
    expect(call.body).toMatchObject({ agent: AGENT, client: 'telegram', chat: JOEY, idem_key: idemLine(AGENT, JOEY, 500), by: `tg:${JOEY}`, client_msg_id: '500' })
    expect(Number.isFinite(Date.parse(call.body.at))).toBe(true)
    expect(c.readLines()).toMatchObject([{ chat: JOEY, idem_key: idemLine(AGENT, JOEY, 500), id: r!.id, lifted_at: null }])
    expect(c.activeLine(JOEY)!.id).toBe(r!.id)
    expect(spoolLines(c)).toEqual([])                                                    // nothing queued: it is in Onsen
    expect(liftData(r!.id, 500)).toBe(`olift:${r!.id}:500`)
    expect(Buffer.byteLength(liftData(9_999_999_999, 9_999_999_999))).toBeLessThanOrEqual(64)
    expect(Buffer.byteLength(liftData(null, 2_147_483_647))).toBeLessThanOrEqual(64)
  })

  test('Onsen silent: the draw returns within its short timeout, goes into the spool, and is drawn once when Onsen answers; recording off draws nothing', async () => {
    const o = fakeOnsen(), logs: string[] = [], c = client(tmp(), o.f, { logs })
    o.st.hangDraw = true
    const t0 = Date.now()
    const r = await c.drawLine({ chat: JOEY, clientMsgId: 501, by: `tg:${JOEY}`, timeoutMs: 200 })
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(r).toMatchObject({ id: null, spooled: true })
    expect(spoolLines(c)).toMatchObject([{ k: 'l', r: { idem_key: idemLine(AGENT, JOEY, 501), chat: JOEY } }])
    expect(c.activeLine(JOEY)).toMatchObject({ id: null, idem_key: idemLine(AGENT, JOEY, 501) })   // locally the line holds at once
    expect(logs.join('\n')).toContain('not drawn directly')
    o.st.hangDraw = false
    await c.syncNow(true)
    expect(c.pendingBytes()).toBe(0)
    const id = c.activeLine(JOEY)!.id
    expect(id).toBeGreaterThan(0)
    expect(o.lines.filter(l => l.idem_key === idemLine(AGENT, JOEY, 501)).length).toBe(1)
    // the same draw again (a retried update) is one line: the idem key
    await c.drawLine({ chat: JOEY, clientMsgId: 501, by: `tg:${JOEY}` })
    expect(o.lines.filter(l => l.idem_key === idemLine(AGENT, JOEY, 501)).length).toBe(1)
    const off = client(tmp(), o.f, { record: false })
    expect(await off.drawLine({ chat: JOEY, clientMsgId: 502, by: `tg:${JOEY}` })).toBeNull()
    expect(existsSync(off.spool)).toBe(false); expect(off.readLines()).toEqual([])
  })

  test('the button lifts that line (line_id); pressed again: nothing to lift', async () => {
    const o = fakeOnsen(), c = client(tmp(), o.f)
    const a = await c.drawLine({ chat: JOEY, clientMsgId: 600, by: `tg:${JOEY}` })
    const b = await c.drawLine({ chat: JOEY, clientMsgId: 601, by: `tg:${JOEY}`, at: new Date(Date.now() + 1000).toISOString() })
    const r = await c.liftLine({ chat: JOEY, lineId: a!.id, clientMsgId: 600, by: `tg:${JOEY}` })
    expect(r).toEqual({ lifted: true, spooled: false, nothing: false })
    expect(o.calls.find(x => x.path === '/restart-lines/lift')!.body).toMatchObject({ agent: AGENT, client: 'telegram', chat: JOEY, line_id: a!.id, by: `tg:${JOEY}` })
    expect(o.lines.find(l => l.id === a!.id).lifted_at).toBeTruthy()
    expect(o.lines.find(l => l.id === b!.id).lifted_at).toBeFalsy()                       // the other line stays: the button names its own
    expect(c.readLines().find(l => l.id === a!.id)!.lifted_at).toBeTruthy()
    expect(c.activeLine(JOEY)!.id).toBe(b!.id)
    expect((await c.liftLine({ chat: JOEY, lineId: a!.id, clientMsgId: 600, by: `tg:${JOEY}` })).nothing).toBe(true)
    // a line Onsen never had (404): nothing to lift
    const o2 = fakeOnsen(), c2 = client(tmp(), o2.f)
    expect(await c2.liftLine({ chat: JOEY, lineId: 77, clientMsgId: 1, by: `tg:${JOEY}` })).toEqual({ lifted: false, spooled: false, nothing: true })
  })

  test('the draw still in the spool: the lift goes behind it and lifts THAT line once the spool reaches it (not the newest)', async () => {
    const o = fakeOnsen(), c = client(tmp(), o.f)
    o.st.down = true
    const a = await c.drawLine({ chat: JOEY, clientMsgId: 700, by: `tg:${JOEY}` })
    const b = await c.drawLine({ chat: JOEY, clientMsgId: 701, by: `tg:${JOEY}`, at: new Date(Date.now() + 1000).toISOString() })
    expect(a!.spooled && b!.spooled).toBe(true)
    const r = await c.liftLine({ chat: JOEY, lineId: null, clientMsgId: 700, by: `tg:${JOEY}` })
    expect(r).toEqual({ lifted: true, spooled: true, nothing: false })
    expect(spoolLines(c).map(l => l.k)).toEqual(['l', 'l', 'u'])
    expect(c.activeLine(JOEY)!.idem_key).toBe(idemLine(AGENT, JOEY, 701))                  // locally 700 is lifted already
    o.st.down = false
    await c.syncNow(true)
    expect(c.pendingBytes()).toBe(0)
    const la = o.lines.find(l => l.idem_key === idemLine(AGENT, JOEY, 700)), lb = o.lines.find(l => l.idem_key === idemLine(AGENT, JOEY, 701))
    expect(la.lifted_at).toBeTruthy(); expect(lb.lifted_at).toBeFalsy()
    const lift = o.calls.find(x => x.path === '/restart-lines/lift')!
    expect(lift.body.line_id).toBe(la.id); expect(lift.body.draw_idem).toBeUndefined()   // resolved to the draw's id; the local key never posted
  })
})

describe('chat_history shows the line', () => {
  async function seeded() {
    const o = fakeOnsen(), c = client(tmp(), o.f)
    c.recordMessage(inboundItem(AGENT, tgMsg(10, '線之前 Joey 說的'), '線之前 Joey 說的'))
    c.recordLine(withSender('main', () => outboundRecord(AGENT, sendCtx()!, 'sendMessage', { chat_id: JOEY, text: '線之前 main 回的' }, { message_id: 11, date: T0 + 11 })))
    c.recordMessage(inboundItem(AGENT, tgMsg(12, '/clear'), '/clear'))
    const line = await c.drawLine({ chat: JOEY, clientMsgId: 12, by: `tg:${JOEY}`, at: new Date((T0 + 12) * 1000 + 300).toISOString() })
    c.recordMessage(inboundItem(AGENT, tgMsg(20, '線之後 Joey 說的'), '線之後 Joey 說的'))
    c.recordMessage(inboundItem(AGENT, tgMsg(21, '回你線之前那則', { reply_to_message: { message_id: 10 } }), '回你線之前那則'))
    await c.syncNow(true)
    return { o, c, line }
  }
  test('Onsen: the line at the top, only what is after it; an id before it says so; the one Joey quotes still reads', async () => {
    const { c, line } = await seeded()
    const out = await c.queryHistory({})
    const ls = out.split('\n')
    expect(ls[0]).toBe(restartHead(new Date((T0 + 12) * 1000 + 300).toISOString()))
    expect(ls[0]).toMatch(/^Joey 在 \d\d-\d\d \d\d:\d\dZ 叫你重新開始：線之前的對話不顯示（他引用的那則照樣看得到）$/)
    expect(out).toContain('線之後 Joey 說的'); expect(out).not.toContain('線之前 main 回的'); expect(out).not.toContain('/clear')
    expect(ls.at(-1)).toBe('共 2 則，顯示 2 則')
    const [reason, hint] = (await c.queryHistory({ id: 'tg:11' })).split('\n')
    expect(reason).toBe(behindLine(new Date((T0 + 12) * 1000 + 300).toISOString()))
    expect(hint).toMatch(/message_id.*tg:N.*#N/)
    expect(await c.queryHistory({ id: 'tg:10' })).toContain('線之前 Joey 說的')         // quoted after the line
    // lifted: no line, everything back
    await c.liftLine({ chat: JOEY, lineId: line!.id, clientMsgId: 12, by: `tg:${JOEY}` })
    const back = await c.queryHistory({})
    expect(back.split('\n')[0]).not.toContain('叫你重新開始'); expect(back).toContain('線之前 main 回的')
  })
  test('the local spool (Onsen silent) respects the line this daemon drew the same way', async () => {
    const { o, c, line } = await seeded()
    o.st.down = true
    const out = await c.queryHistory({})
    const ls = out.split('\n')
    expect(ls[0]).toContain('本機暫存')
    expect(ls[1]).toBe(restartHead(new Date((T0 + 12) * 1000 + 300).toISOString()))
    expect(out).toContain('線之後 Joey 說的'); expect(out).toContain('回你線之前那則')
    expect(out).not.toContain('線之前 main 回的'); expect(out).not.toContain('｜/clear')
    expect(ls.at(-1)).toBe('共 2 則，顯示 2 則')
    const one = await c.queryHistory({ id: 'tg:11' })
    expect(one.split('\n')[1]).toBe(behindLine(new Date((T0 + 12) * 1000 + 300).toISOString()))
    expect(await c.queryHistory({ id: 'tg:10' })).toContain('線之前 Joey 說的')
    await c.liftLine({ chat: JOEY, lineId: line!.id, clientMsgId: 12, by: `tg:${JOEY}` })   // Onsen down: lifted locally at once (and queued)
    const back = await c.queryHistory({})
    expect(back).toContain('線之前 main 回的'); expect(back).not.toContain('叫你重新開始')
  })
})

describe('an edited message reaches the agent', () => {
  const edited = (o: Record<string, any> = {}) => ({ message_id: 2166, date: Date.UTC(2026, 10, 25, 3, 7, 30) / 1000, edit_date: Date.UTC(2026, 10, 25, 3, 9, 0) / 1000,
    chat: { id: 1828173984, type: 'private' }, from: { id: 1828173984, is_bot: false, first_name: 'Joey', username: 'Advac777' }, text: '改過的全文', ...o })

  test('the line in front: the person (Joey for 1828173984), the ORIGINAL time in UTC (date on an earlier day), the Telegram id', () => {
    expect(editHeader(edited())).toBe('〔Joey 改了他 03:07Z 那一則（tg:2166）〕')
    expect(editHeader(edited({ date: Date.UTC(2026, 10, 24, 23, 50) / 1000 }))).toBe('〔Joey 改了他 11-24 23:50Z 那一則（tg:2166）〕')
    expect(editorName({ id: 42, first_name: 'Rosie', last_name: 'L' })).toBe('Rosie L')
    expect(editorName({ id: 43, username: 'ann' })).toBe('@ann')
    expect(editorName({ id: Number(JOEY_TG_ID) })).toBe('Joey')
    expect(originalTime(0)).toBe('')
    expect(editHeader(edited({ date: undefined }))).toBe('〔Joey 改了那一則（tg:2166）〕')
  })

  test('already seen: a new inbound (header + full new text, meta edited, ts = the edit), the event edit_delivered replaced_in_queue false', async () => {
    const sent: any[] = [], rec: any[] = []
    const r = await deliverEdit(edited(), '改過的全文', { delivered: () => true, replaceQueued: () => false, dispatch: async (chat, n) => { sent.push({ chat, n }) },
      meta: m => ({ user: m.from.username, user_id: String(m.from.id) }), record: (...a) => rec.push(a), log: () => {} })
    expect(r).toBe('delivered')
    expect(sent).toHaveLength(1)
    expect(sent[0].chat).toBe('1828173984')
    expect(sent[0].n.params.content).toBe('〔Joey 改了他 03:07Z 那一則（tg:2166）〕\n改過的全文')
    expect(sent[0].n.params.meta).toEqual({ user: 'Advac777', user_id: '1828173984', chat_id: '1828173984', message_id: '2166', ts: '2026-11-25T03:09:00.000Z',
      edited: 'true', edited_at: '2026-11-25T03:09:00.000Z' })
    expect(rec).toEqual([['1828173984', '2166', Date.UTC(2026, 10, 25, 3, 9, 0) / 1000, false]])
  })

  test('still queued, unseen: its text replaced, nothing sent twice; never delivered (a command the daemon answered): recorded only', async () => {
    const sent: any[] = [], rec: any[] = []
    let got: any = null
    const deps = { replaceQueued: (_c: string, _i: string, rw: any) => { got = rw({ content: '原文', meta: { chat_id: '1828173984', message_id: '2166', ts: 'x' } }); return true },
      dispatch: async (chat: string, n: any) => { sent.push(n) }, meta: () => ({}), record: (...a: any[]) => rec.push(a), log: () => {} }
    expect(await deliverEdit(edited(), '改過的全文', { ...deps, delivered: () => true })).toBe('replaced')
    expect(sent).toEqual([])
    expect(got).toEqual({ content: '改過的全文', meta: { chat_id: '1828173984', message_id: '2166', ts: 'x', edited: 'true', edited_at: '2026-11-25T03:09:00.000Z' } })
    expect(rec[0][3]).toBe(true)
    expect(await deliverEdit(edited(), 'x', { ...deps, delivered: () => false })).toBe('not-delivered')
    expect(sent).toEqual([]); expect(rec).toHaveLength(1)
    // a queued EARLIER edit of the same message keeps its header with the newest text
    expect(rewriteQueued({ content: '〔…〕\n舊的改法', meta: { edited_at: 'y' } }, edited(), '新的改法').content).toBe('〔Joey 改了他 03:07Z 那一則（tg:2166）〕\n新的改法')
  })

  test('the queue helpers: what carries the message; a rewritten copy leaves the queued object as it was; the delivered index', () => {
    const n = { method: 'notifications/claude/channel', params: { content: '原文', meta: { chat_id: '1', message_id: '5' } } }
    expect(carries(n, '1', '5')).toBe(true); expect(carries(n, '1', '6')).toBe(false); expect(carries({ ...n, method: 'x' }, '1', '5')).toBe(false)
    const r = rewritten(n, edited(), '新') as any
    expect(r.params.content).toBe('新'); expect(r.params.meta.edited).toBe('true'); expect(n.params.content).toBe('原文')
    const ix = new DeliveredIndex(2)
    ix.note('1', 5); ix.note('1', 6); ix.note('1', 7)
    expect(ix.has('1', 5)).toBe(false); expect(ix.has('1', 7)).toBe(true); expect(ix.has('2', 7)).toBe(false)
  })

  test('Onsen gets edit_delivered on the message (data.replaced_in_queue); the spool finds the original `in` item after a restart', async () => {
    const o = fakeOnsen(), c = client(tmp(), o.f)
    c.recordMessage(inboundItem(AGENT, tgMsg(30, '原文'), '原文'))
    c.recordMessage(inboundItem(AGENT, tgMsg(31, '/clear'), '/clear'))
    c.recordEditDelivered(JOEY, 30, T0 + 99, false)
    await c.syncNow(true)
    expect(o.events).toMatchObject([{ kind: 'edit_delivered', target_client_msg_id: '30', chat: JOEY, actor: 'system:daemon', data: { replaced_in_queue: false },
      idem_key: `tg:${AGENT}:${JOEY}:edit_delivered:30:${T0 + 99}` }])
    expect(client(c.cfg.dir, o.f).findInbound(JOEY, 30)).toMatchObject({ body: '原文', kind: 'text' })
    expect(c.findInbound(JOEY, 31)!.kind).toBe('command')
    expect(c.findInbound(JOEY, 32)).toBeNull()
    expect(formatFull({ at: new Date(T0 * 1000).toISOString(), sender: 'joey', body: 'b', events: [{ kind: 'edit_delivered', at: new Date(T0 * 1000).toISOString(), data: { replaced_in_queue: true } }] }))
      .toContain('改過的內容交給了 agent（原訊息還在佇列裡，直接換掉）')
  })
})

describe('/clear: the line first, then the keys; the button on the reply', () => {
  // tmux on its own socket dir: the machine's tmux server (every agent's TUI) is never touched
  const sock = mkdtempSync(join(tmpdir(), 'onsen-tmux-'))
  const env = { ...process.env, TMUX_TMPDIR: sock } as Record<string, string>
  delete env.TMUX
  const tm = (...a: string[]) => spawnSync('tmux', a, { env, encoding: 'utf8' })
  const saved = { TMUX: process.env.TMUX, TMUX_TMPDIR: process.env.TMUX_TMPDIR }
  afterAll(() => { tm('kill-server'); process.env.TMUX_TMPDIR = saved.TMUX_TMPDIR ?? ''; if (saved.TMUX) process.env.TMUX = saved.TMUX; if (!saved.TMUX_TMPDIR) delete process.env.TMUX_TMPDIR })

  test('WO-185: /clear is typed first, then afterClear sends the reply (its button); false or a throw: the plain reply; a failed /clear: the failure only; no hooks: as before', async () => {
    process.env.TMUX_TMPDIR = sock; delete process.env.TMUX
    const { forwardSharedTuiSlash } = await import('./channel-bot-control.ts')
    const name = `onsen-step2-${process.pid}`
    const made = tm('new-session', '-d', '-s', name, '-x', '80', '-y', '10', 'cat')
    if (made.status !== 0) throw new Error(`tmux: ${made.stderr}`)
    const pane = () => tm('capture-pane', '-p', '-t', name).stdout
    const replies: Array<{ msg: string; opts?: any }> = []
    const reply = async (msg: string, opts?: any) => { replies.push({ msg, opts }) }
    const after: Array<{ ok: string; paneHadClear: boolean }> = []
    const hooks = { afterClear: async (ok: string) => { after.push({ ok, paneHadClear: pane().includes('/clear') }); return true } }
    expect(await forwardSharedTuiSlash('/clear', name, reply, undefined, hooks)).toBe(true)
    await Bun.sleep(200)
    expect(after).toEqual([{ ok: `✅ 已送 \`/clear\` 到 ${name}`, paneHadClear: true }])     // typed first, then the reply
    expect(replies).toEqual([])                                                               // the hook sent it
    // the hook could not send (false) or threw: the plain reply
    expect(await forwardSharedTuiSlash('/clear', name, reply, undefined, { afterClear: async () => false })).toBe(true)
    expect(replies.at(-1)).toEqual({ msg: `✅ 已送 \`/clear\` 到 ${name}`, opts: undefined })
    expect(await forwardSharedTuiSlash('/clear', name, reply, undefined, { afterClear: async () => { throw new Error('boom') } })).toBe(true)
    expect(replies.at(-1)!.msg).toStartWith('✅')
    // typing fails (no such pane): the failure line only, the hook never runs (no button)
    const n0 = after.length
    expect(await forwardSharedTuiSlash('/clear', `${name}-gone`, reply, undefined, hooks)).toBe(true)
    expect(after.length).toBe(n0)
    expect(replies.at(-1)!.msg).toStartWith('❌ /clear 失敗'); expect(replies.at(-1)!.opts).toBeUndefined()
    // no hooks (roamer, Onsen off) and other commands: exactly as before
    expect(await forwardSharedTuiSlash('/clear', name, reply)).toBe(true)
    expect(replies.at(-1)).toEqual({ msg: `✅ 已送 \`/clear\` 到 ${name}`, opts: undefined })
    expect(await forwardSharedTuiSlash('/compact', name, reply, undefined, hooks)).toBe(true)
    expect(after.length).toBe(n0)                                                              // only /clear
  }, 20000)
})
