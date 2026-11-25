// WO-147 (Onsen step 4a): every route record (a routing.jsonl line) becomes one wake row (onsen-wake.ts), behaviour unchanged.
//   part 1: the mapping, one test per acceptance source (Telegram, page form, peer call, mailbox ring, scheduled, alert, board, keep-warm, an external
//           program's no_reply notice) plus the other kinds, the target from the main's M2 record, the refs, the preview cut, the switch
//   part 2: the router in this process (lanes.ts, role tg): the tap sees each routing.jsonl line once, with the event; routing.jsonl's rule / target for the
//           same events is identical with the tap and without it; main_now / main_after_step / held:wall / held:offline from a stand-in main's hook events;
//           a tap that throws changes nothing
//   part 3: the spool (k 'w', POST /wake/batch): in order, resend = duplicates, Onsen down, a row refused, an Onsen without the route
import { test, expect, describe, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import * as W from './onsen-wake.ts'
import { OnsenClient, inboundItem } from './onsen-client.ts'

const ROSTER = () => ['eve', 'adam']
const AS = ['alert-dispatcher']
const ctx0 = { main: null, laneKind: null, alertSenders: AS, roster: ROSTER }
const o = { agent: 'adam', host: 'mini', at: '2026-11-25T10:00:00.000Z', idem: 'wake:adam:1:b:1', memberState: 'idle' }
const notif = (text: string, meta: Record<string, string> = {}) => ({ method: 'notifications/claude/channel', params: { content: text, meta } })
/** a mesh event as server.ts laneEventOf builds it from an /inject body (the agent-inbox daemon sends it to /lanes/route as is) */
function mesh(id: string, from: string, text: string, meta: Record<string, string> = {}, extra: Record<string, unknown> = {}): any {
  return { id, source: 'mesh', from, text, meta, notif: notif(text, meta), verified: meta.verified !== 'false', no_reply: meta.no_reply === 'true',
    ...(meta.btcc_msg_id ? { btcc_msg_id: meta.btcc_msg_id } : {}), line: meta.line ?? (meta.wake === 'mail' ? 'mail' : 'call'),
    ...(meta.wake ? { wake: meta.wake } : {}), ...extra }
}
const tg = (id: number, text: string, extra: Record<string, string> = {}): any => {
  const meta = { chat_id: '1828', message_id: String(id), user: 'joey', user_id: '1828', ...extra }
  return { id: `tg-1828-${id}${extra.edited_at ? `-edit-1-1` : ''}`, source: 'telegram', from: 'joey', text, meta, notif: notif(text, meta), verified: true }
}
const form = (): any => {
  const meta = { chat_id: '1828', message_id: 'form-9101', user: '1828', user_id: '1828', via: 'web-form', form_title: '排程', form_id: '601' }
  return { id: 'tg-1828-form-9101', source: 'telegram', from: '1828', text: '週四 10:00', meta, notif: notif('週四 10:00', meta), verified: true }
}
/** the route record routeRow writes for `ev` (the fields the router fills; text cut at 120 like routeRow) */
const rowOf = (ev: any, rule: string, target: string, x: Record<string, unknown> = {}) =>
  ({ event: ev.id, source: ev.source, from: ev.from, text: String(ev.text).slice(0, 120), rule, target, lane: null, thread: null, peer_thread: null, hop: null, note: null,
    class: null, base_tier: null, btcc_msg_id: ev.btcc_msg_id ?? null, tg_message_id: ev.meta?.message_id ?? null, ...x })

// ================================================================== part 1: the mapping
describe('part 1: one route record → one wake row', () => {
  test('1 Telegram (Joey): joey_tg, interrupt, the main by its M2 record; refs tg and event_id', () => {
    const ev = tg(7001, '幫我看一下 WO-147')
    const it = W.wakeItem(rowOf(ev, 'tg-main', 'main'), { ...ctx0, ev, main: { state: 'idle', offered: false }, did: 'm-x-1' }, o)
    expect(it).toEqual({ idem_key: o.idem, agent: 'adam', host: 'mini', at: o.at, source_kind: 'joey_tg', urgency: 'interrupt', target: 'main_now', rule: 'tg-main',
      member_state: 'idle', sender: 'joey', refs: { tg: '1828:7001', event_id: 'tg-1828-7001', did: 'm-x-1' }, preview: '幫我看一下 WO-147' })
    // an edit of his (Onsen step 2): its own kind
    const ed = tg(7001, '改過', { edited_at: '2026-11-25T10:00:00Z' })
    expect(W.wakeItem(rowOf(ed, 'tg-main', 'main'), { ...ctx0, ev: ed }, o)).toMatchObject({ source_kind: 'joey_edit', urgency: 'interrupt', target: 'held:offline' })
  })
  test('2 page form: joey_form, interrupt, rule web-form; refs form_id and tg (chat:form-<id>)', () => {
    const ev = form()
    expect(W.wakeItem(rowOf(ev, 'web-form', 'main', { note: 'a page answer (form 601): to the main' }), { ...ctx0, ev, main: { state: 'in_turn', offered: false } }, o))
      .toMatchObject({ source_kind: 'joey_form', urgency: 'interrupt', target: 'main_after_step', rule: 'web-form', note: 'a page answer (form 601): to the main',
        refs: { form_id: '601', tg: '1828:form-9101', event_id: 'tg-1828-form-9101' } })
  })
  test('3 peer call: peer_call, interrupt, a reflex lane; refs btcc_msg_id, thread', () => {
    const ev = mesh('mesh-501', 'eve', '維護幾點？', { btcc_msg_id: '501', line: 'call', verified: 'true' })
    expect(W.wakeItem(rowOf(ev, 'mesh-peer-call', 'lane', { lane: 'adam.reflex.3', thread: 'adam#t-abc' }), { ...ctx0, ev, laneKind: 'reflex' }, o))
      .toMatchObject({ source_kind: 'peer_call', urgency: 'interrupt', target: 'lane:reflex', rule: 'mesh-peer-call', sender: 'eve',
        refs: { btcc_msg_id: '501', event_id: 'mesh-501', thread: 'adam#t-abc' } })
    // a peer's mail pushed into the session (its mailbox not open): peer_mail, ordered, the mail lane
    const pm = mesh('mesh-502', 'eve', '週報', { btcc_msg_id: '502', line: 'mail', no_reply: 'true' })
    expect(W.wakeItem(rowOf(pm, 'mesh-mail', 'lane'), { ...ctx0, ev: pm, laneKind: 'mail' }, o)).toMatchObject({ source_kind: 'peer_mail', urgency: 'ordered', target: 'lane:mail' })
    // a peer's no_reply notice: silent (today's mesh-no-reply files it in the ledger)
    const nr = mesh('mesh-503', 'eve', '知會：備份好了', { btcc_msg_id: '503', no_reply: 'true' })
    expect(W.wakeItem(rowOf(nr, 'mesh-no-reply', 'ledger'), { ...ctx0, ev: nr }, o)).toMatchObject({ source_kind: 'peer_call', urgency: 'silent', target: 'ledger' })
  })
  test('4 mailbox ring (WO-141): mail_ring, ordered, the mail lane, rule wake-mail; the watchdog\'s reminder is wd_mail', () => {
    const ev = mesh('mesh-ring-1', 'mailbox', '讀信箱（2 封未讀，最舊的等了 3 分鐘）', { no_reply: 'true', ring: 'true', wake: 'mail', line: 'mail' })
    expect(W.wakeItem(rowOf(ev, 'wake-mail', 'lane', { wake: 'mail', lane: 'adam.mail.1' }), { ...ctx0, ev, laneKind: 'mail' }, o))
      .toMatchObject({ source_kind: 'mail_ring', urgency: 'ordered', target: 'lane:mail', rule: 'wake-mail', sender: 'mailbox' })
    const kw = mesh('mesh-kw-1', 'fleet-watchdog', '讀信箱（1 封未讀，最舊的等了 61 分鐘）', { no_reply: 'true', wake: 'mail' })
    expect(W.wakeItem(rowOf(kw, 'wake-mail', 'ledger', { wake: 'mail' }), { ...ctx0, ev: kw }, o)).toMatchObject({ source_kind: 'wd_mail', urgency: 'ordered', target: 'ledger' })
  })
  test('5 scheduled: scheduled, ordered, a reflex lane; run_id from the header (or the meta)', () => {
    const ev = mesh('mesh-sch-1', 'scheduler', '[scheduled][backup-check][run:61][P3][routine] 查備份', { verified: 'true' })
    expect(W.wakeItem(rowOf(ev, 'mesh-scheduled', 'lane'), { ...ctx0, ev, laneKind: 'reflex' }, o))
      .toMatchObject({ source_kind: 'scheduled', urgency: 'ordered', target: 'lane:reflex', rule: 'mesh-scheduled', refs: { run_id: '61', event_id: 'mesh-sch-1' } })
    const m = mesh('mesh-sch-2', 'scheduler', '[scheduled][x] 沒有 run 編號', { run_id: '77' })
    expect(W.wakeItem(rowOf(m, 'mesh-scheduled', 'lane'), { ...ctx0, ev: m, laneKind: 'reflex' }, o).refs.run_id).toBe('77')
  })
  test('6 alert (alert-dispatcher): alert, interrupt (a page), even when no_reply', () => {
    const ev = mesh('mesh-al-1', 'alert-dispatcher', '[P1] mock-api 全掛', { verified: 'true', no_reply: 'true' })
    expect(W.wakeItem(rowOf(ev, 'mesh-alert', 'lane'), { ...ctx0, ev, laneKind: 'reflex' }, o)).toMatchObject({ source_kind: 'alert', urgency: 'interrupt', target: 'lane:reflex', rule: 'mesh-alert' })
  })
  test('7 board ([board][WO-n]): board, interrupt (an urgent push), ticket ref; a worker lane or the main', () => {
    const ev = mesh('mesh-900', 'board', '[board][WO-150] 球到你手上：照第二案做', { btcc_msg_id: '900' })
    expect(W.wakeItem(rowOf(ev, 'mesh-board', 'main'), { ...ctx0, ev, main: { state: 'idle', offered: true } }, o))
      .toMatchObject({ source_kind: 'board', urgency: 'interrupt', target: 'main_after_step', rule: 'mesh-board', refs: { ticket: 'WO-150', btcc_msg_id: '900' } })
    const w = W.wakeItem(rowOf(ev, 'mesh-board', 'lane'), { ...ctx0, ev, laneKind: 'worker' }, o)
    expect(w.target).toBe('lane:worker')
  })
  test('8 watchdog keep-warm: wd_keepwarm, state, the main; stall / restart / resume each their own kind, all state', () => {
    const ev = mesh('mesh-kw-2', 'fleet-watchdog', '[保溫] 你閒了 50 分鐘，這一則只是為了不讓對話過期', { no_reply: 'true', wake: 'keepwarm' })
    expect(W.wakeItem(rowOf(ev, 'wake-keepwarm', 'main', { wake: 'keepwarm', note: 'fleet wake-up line (keepwarm): the main' }), { ...ctx0, ev, main: { state: 'idle', offered: false } }, o))
      .toMatchObject({ source_kind: 'wd_keepwarm', urgency: 'state', target: 'main_now', rule: 'wake-keepwarm', note: 'fleet wake-up line (keepwarm): the main', sender: 'fleet-watchdog' })
    for (const k of ['stall', 'restart', 'resume']) {
      const e = mesh(`mesh-${k}`, 'fleet-watchdog', `[fleet-watchdog] ${k}`, { no_reply: 'true', wake: k })
      expect(W.wakeItem(rowOf(e, `wake-${k}`, 'main', { wake: k }), { ...ctx0, ev: e, main: { state: 'walled', offered: false } }, o))
        .toMatchObject({ source_kind: `wd_${k}`, urgency: 'state', target: 'held:wall' })
    }
  })
  test('9 an external program\'s no_reply notice (sender not in the roster, e.g. iris-slack): external, silent, the ledger', () => {
    const ev = mesh('mesh-ext-1', 'iris-slack', 'Slack DM from 王小明：明天的會改到 3 點', { no_reply: 'true', verified: 'false' })
    expect(W.wakeItem(rowOf(ev, 'mesh-no-reply', 'ledger', { base_tier: 'ledger' }), { ...ctx0, ev }, o))
      .toMatchObject({ source_kind: 'external', urgency: 'silent', target: 'ledger', rule: 'mesh-no-reply', sender: 'iris-slack' })
    // the same program without no_reply: a push with no line is a call (today: default → the main)
    const call = mesh('mesh-ext-2', 'reply-watch', '回信了', {})
    expect(W.wakeItem(rowOf(call, 'default', 'main'), { ...ctx0, ev: call }, o)).toMatchObject({ source_kind: 'external', urgency: 'interrupt', target: 'held:offline' })
  })
  test('the other route records: the mailbox\'s events, the main\'s own tools, a follow-up, the digest, a /lanes command, a refused registration', () => {
    const me: any = { id: 'mail-decision-42', source: 'mail', from: 'mailbox', text: '決定：照做', meta: {}, notif: notif(''), kind: 'mail_decision', mail_id: 42 }
    expect(W.wakeItem(rowOf(me, 'mail-event', 'lane'), { ...ctx0, ev: me, laneKind: 'reflex' }, o)).toMatchObject({ source_kind: 'mail_event', urgency: 'ordered', refs: { mail_id: '42' } })
    const fork: any = mesh('ev-1-abc', 'main', 'fork task')
    expect(W.wakeItem({ event: fork.id, source: 'main', from: 'main', rule: 'fork', target: 'lane', lane: 'adam.fork.1' }, { ...ctx0, ev: fork, laneKind: 'fork' }, o))
      .toMatchObject({ source_kind: 'other', urgency: 'ordered', target: 'lane:fork', rule: 'fork', preview: 'fork task' })
    const fu = mesh('mesh-501', 'eve', '維護幾點？')
    expect(W.wakeItem({ event: 'mesh-501', source: 'followup', from: 'eve', rule: 'followup', target: 'lane', lane: 'adam.reflex.3' }, { ...ctx0, ev: fu, laneKind: 'reflex' }, o))
      .toMatchObject({ source_kind: 'other', urgency: 'ordered', target: 'lane:reflex' })
    expect(W.wakeItem({ event: 'digest-1', source: 'ledger', rule: 'digest', target: 'main', note: '2 event(s)' }, { ...ctx0, ev: null, main: { state: 'in_turn', offered: false } }, o))
      .toMatchObject({ source_kind: 'other', urgency: 'silent', target: 'main_after_step', refs: { event_id: 'digest-1' } })
    const cmd = W.wakeItem({ event: 'master-off-1', source: 'joey', rule: 'master-off', target: 'none', note: 'by joey' }, { ...ctx0, ev: null }, o)
    expect(cmd).toMatchObject({ source_kind: 'joey_tg', target: 'none', rule: 'master-off' }); expect(cmd.urgency).toBeUndefined()
    const reg = W.wakeItem({ event: 'register-main', rule: 'registration', target: 'refused', session: 's', pid: 1, reason: 'x', role: 'tg' }, { ...ctx0, ev: null }, o)
    expect(reg).toMatchObject({ source_kind: 'other', target: 'none', rule: 'registration' }); expect(reg.urgency).toBeUndefined(); expect(reg.preview).toBeUndefined()
    // the master switch off: the routing row of an event (not the command) keeps the event's kind
    const ev = tg(7002, '在嗎')
    expect(W.wakeItem(rowOf(ev, 'master-off', 'main'), { ...ctx0, ev }, o)).toMatchObject({ source_kind: 'joey_tg', urgency: 'interrupt', target: 'held:offline' })
  })
  test('target: the main by its M2 record; a lane by its kind; ledger; none', () => {
    const t = (target: string, main: any, laneKind: string | null = null) => W.targetOf({ target }, { main, laneKind })
    expect(t('main', { state: 'idle', offered: false })).toBe('main_now')
    expect(t('main', { state: 'idle', offered: true })).toBe('main_after_step')
    expect(t('main', { state: 'in_turn', offered: false })).toBe('main_after_step')
    expect(t('main', { state: 'walled', offered: false })).toBe('held:wall')
    expect(t('main', { state: 'starting', offered: false })).toBe('held:starting')
    expect(t('main', { state: 'gone', offered: false })).toBe('held:offline')
    expect(t('main', null)).toBe('held:offline')
    expect(t('lane', null, 'mail')).toBe('lane:mail'); expect(t('lane', null)).toBe('lane:unknown')
    expect(t('ledger', null)).toBe('ledger'); expect(t('refused', null)).toBe('none'); expect(t('none', null)).toBe('none')
  })
  test('member_state: the status view (walled when it carries a wall), else the M2 record', () => {
    expect(W.memberStateOf({ state: 'busy', detail: {} }, null)).toBe('busy')
    expect(W.memberStateOf({ state: 'idle', detail: { walled: { until: null } } }, null)).toBe('walled')
    expect(W.memberStateOf({ state: 'offline', detail: { walled: { until: null } } }, null)).toBe('offline')
    expect(W.memberStateOf({ state: 'stuck' }, { state: 'idle', offered: false })).toBe('stuck')
    expect(W.memberStateOf(null, { state: 'in_turn', offered: false })).toBe('busy')
    expect(W.memberStateOf(null, { state: 'walled', offered: false })).toBe('walled')
    expect(W.memberStateOf(null, null)).toBe('offline')
  })
  test('preview: 120 code points, never half a surrogate pair; a lone surrogate is made well formed (Postgres would refuse it)', () => {
    const emoji = '😀'.repeat(130)
    const ev = mesh('mesh-e', 'eve', emoji)
    const it = W.wakeItem({ event: 'mesh-e', source: 'mesh', from: 'eve', text: emoji.slice(0, 120), rule: 'default', target: 'main' }, { ...ctx0, ev }, o)
    expect(Array.from(it.preview!).length).toBe(60)                              // routeRow's .slice(0, 120) cut 120 UTF-16 units = 60 emoji
    expect(it.preview!.isWellFormed()).toBe(true)
    expect(W.cutPoints(emoji, 120)).toBe('😀'.repeat(120))
    expect(W.cutPoints('a\uD800b', 10).isWellFormed()).toBe(true)
    expect(JSON.stringify(W.wakeItem({ event: 'x', source: 'mesh', from: 'eve', text: 'x\uDC00', rule: 'r\uD800', note: 'n\uD800', target: 'main' }, { ...ctx0, ev: null }, o)))
      .not.toMatch(/\\ud[89a-f]/i)
  })
  test('idem_key: unique per decision, ≤ 300; the switch: a comma list or *, unset / empty = off', () => {
    expect(W.idemWake('adam', 'b00t', 7, 1764064800000)).toBe('wake:adam:1764064800000:b00t:7')
    expect(W.idemWake('x'.repeat(400), 'b', 1, 1).length).toBe(300)
    expect(W.wakeLogOn({ ONSEN_WAKE_LOG: 'chiron, adam' }, 'adam')).toBe(true)
    expect(W.wakeLogOn({ ONSEN_WAKE_LOG: '*' }, 'adam')).toBe(true)
    expect(W.wakeLogOn({ ONSEN_WAKE_LOG: 'chiron' }, 'adam')).toBe(false)
    expect(W.wakeLogOn({ ONSEN_WAKE_LOG: '' }, 'adam')).toBe(false)
    expect(W.wakeLogOn({}, 'adam')).toBe(false)
    expect(W.SOURCE_KINDS.length).toBe(21)
  })
})

// ================================================================== part 2: the router in this process
process.env.LANES_FLOOD_CONTROL = '0'
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const procs: any[] = []
afterAll(() => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } delete process.env.LANES_FLOOD_CONTROL })
const FLEET_ROUTER = join(import.meta.dir, 'lanes-router.fleet.json')
async function instance(tag: string) {
  const L = await import(`./lanes.ts?onsen-wake-${tag}`) as typeof import('./lanes.ts')
  const dir = mkdtempSync(join(tmpdir(), `onsen-wake-${tag}-`))
  process.env.LANES_DIR = dir
  copyFileSync(FLEET_ROUTER, join(dir, 'router.json'))
  const open = new Set<string>(), offers: any[] = []
  L.__setMeshSend(async b => ({ text: `sent to ${b.to}`, msgId: 1, delivered: true }))
  L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
    notifySession: async (sid: string, n: any) => { if (!open.has(sid)) return false; offers.push(n); return true }, streamOpen: (sid: string) => open.has(sid),
    sendBot: async () => 1, joeyChatId: () => '1828' } as any)
  const routing = (): any[] => { try { return readFileSync(join(dir, 'routing.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
  return { L, dir, open, offers, routing }
}
/** the 9 acceptance sources (fresh objects each time: the router writes marks on its events) */
const nine = (): any[] => [
  tg(7001, 'Joey：幫我看一下'),
  mesh('mesh-501', 'eve', '維護幾點？', { btcc_msg_id: '501', line: 'call', verified: 'true' }),
  mesh('mesh-ring-1', 'mailbox', '讀信箱（2 封未讀，最舊的等了 3 分鐘）', { no_reply: 'true', ring: 'true', wake: 'mail', line: 'mail' }),
  mesh('mesh-sch-1', 'scheduler', '[scheduled][backup-check][run:61][P3][routine] 查備份', { verified: 'true' }),
  mesh('mesh-al-1', 'alert-dispatcher', '[P1] mock-api 全掛', { verified: 'true' }),
  mesh('mesh-900', 'board', '[board][WO-150] 球到你手上', { btcc_msg_id: '900', verified: 'true' }),
  mesh('mesh-kw-2', 'fleet-watchdog', '[保溫] 你閒了 50 分鐘', { no_reply: 'true', wake: 'keepwarm' }),
  mesh('mesh-ext-1', 'iris-slack', 'Slack DM：明天的會改到 3 點', { no_reply: 'true', verified: 'false' }),
]

describe('part 2: the router (lanes.ts, role tg) with the tap', () => {
  test('one tap call per routing.jsonl line, with its event; rule / target identical with and without the tap; the 9 kinds', async () => {
    const on = await instance('on'), off = await instance('off')
    const seen: Array<{ row: any; ctx: any; did: string | null }> = []
    on.L.observeRoutes((row, ctx) => { const c = { ...ctx }; queueMicrotask(() => seen.push({ row, ctx: c, did: c.did() })) })
    for (const ev of nine()) await on.L.routeEvent(ev)
    on.L.toMainForm(form())
    for (const ev of nine()) await off.L.routeEvent(ev)
    off.L.toMainForm(form())
    await Bun.sleep(50)
    const ron = on.routing(), roff = off.routing()
    expect(seen.length).toBe(ron.length)                                          // every line, once
    expect(seen.map(s => s.row.event)).toEqual(ron.map(r => r.event))
    const key = (r: any) => `${r.event}|${r.rule}|${r.target}`
    expect(ron.map(key)).toEqual(roff.map(key))                                   // the tap changes no route
    const items = seen.map(s => W.wakeItem(s.row, { ...s.ctx, did: s.did }, o))
    const byEv = (id: string) => items.filter(i => i.refs.event_id === id)
    const want: Array<[string, string, string, string, string]> = [
      ['tg-1828-7001', 'joey_tg', 'interrupt', 'tg-main', 'held:offline'],
      ['mesh-501', 'peer_call', 'interrupt', 'mesh-peer-call', 'lane:reflex'],
      ['mesh-ring-1', 'mail_ring', 'ordered', 'wake-mail', 'lane:mail'],
      ['mesh-sch-1', 'scheduled', 'ordered', 'mesh-scheduled', 'lane:reflex'],
      ['mesh-al-1', 'alert', 'interrupt', 'mesh-alert', 'lane:reflex'],
      ['mesh-900', 'board', 'interrupt', 'mesh-board', 'held:offline'],              // no worker topic here: the main (L mesh-board → worker_for_ticket)
      ['mesh-kw-2', 'wd_keepwarm', 'state', 'wake-keepwarm', 'held:offline'],
      ['mesh-ext-1', 'external', 'silent', 'mesh-no-reply', 'ledger'],
      ['tg-1828-form-9101', 'joey_form', 'interrupt', 'web-form', 'held:offline'],
    ]
    for (const [id, kind, urg, rule, target] of want) {
      const r = byEv(id)
      expect(r.length).toBe(1)
      expect(r[0]).toMatchObject({ source_kind: kind, urgency: urg, rule, target })
      expect(ron.find(x => x.event === id)).toMatchObject({ rule })
    }
    expect(byEv('mesh-sch-1')[0]!.refs.run_id).toBe('61')
    expect(byEv('mesh-900')[0]!.refs.ticket).toBe('WO-150')
    expect(byEv('tg-1828-7001')[0]!.refs.did).toMatch(/^m-/)                          // the M1 item it got (toMain right after the row)
    expect(byEv('mesh-ext-1')[0]!.refs.did).toBeUndefined()                          // the ledger: no item
    expect(on.L.__journal().rows('msg', r => r.event === 'tg-1828-7001')[0]!.id).toBe(byEv('tg-1828-7001')[0]!.refs.did!)
    on.L.observeRoutes(null)
  })

  test('the target from a stand-in main\'s hook events: main_now, main_after_step (offered, in a turn), held:wall; a throwing tap changes nothing', async () => {
    const x = await instance('main')
    const seen: any[] = []
    x.L.observeRoutes((row, ctx) => { seen.push(W.wakeItem(row, { ...ctx, did: null }, o)) })
    const sid = randomUUID(), proc = Bun.spawn(['sleep', '600']); procs.push(proc)
    const mcp = `mcp-${proc.pid}`
    writeFileSync(join(x.dir, 'main-expected'), sid)
    x.open.add(mcp); x.L.__noteMcpPid(mcp, proc.pid)
    await x.L.__mainEvent({ event: 'SessionStart', pid: proc.pid, session_id: sid })
    const hook = (event: string, b: object = {}) => x.L.__mainEvent({ event, pid: proc.pid, session_id: sid, ...b })
    expect(x.L.__main().mainPhase()).toBe('idle')
    await x.L.routeEvent(tg(7101, '一'))
    expect(seen.at(-1)).toMatchObject({ refs: { event_id: 'tg-1828-7101' }, target: 'main_now' })
    await Bun.sleep(30)
    expect(x.L.__main().items(r => r.state === 'offered').length).toBe(1)             // M1 offered it: the main was woken now
    await x.L.routeEvent(tg(7102, '二'))
    expect(seen.at(-1)).toMatchObject({ refs: { event_id: 'tg-1828-7102' }, target: 'main_after_step' })   // an offer is out: one offer opens one turn
    await hook('UserPromptSubmit', { prompt_id: 'p1', dids: x.L.__main().items(r => r.state === 'offered').map(r => r.id) })
    expect(x.L.__main().mainPhase()).toBe('in_turn')
    await x.L.routeEvent(mesh('mesh-kw-9', 'fleet-watchdog', '[保溫] x', { no_reply: 'true', wake: 'keepwarm' }))
    expect(seen.at(-1)).toMatchObject({ source_kind: 'wd_keepwarm', target: 'main_after_step' })
    await hook('StopFailure', { prompt_id: 'p1', error: 'rate_limit', reason: '429' })
    expect(x.L.__main().mainPhase()).toBe('walled')
    await x.L.routeEvent(tg(7103, '三'))
    expect(seen.at(-1)).toMatchObject({ refs: { event_id: 'tg-1828-7103' }, target: 'held:wall' })
    // a tap that throws: the route and its record are unchanged
    const before = x.routing().length
    x.L.observeRoutes(() => { throw new Error('tap boom') })
    const d = await x.L.routeEvent(mesh('mesh-ext-9', 'iris-slack', 'x', { no_reply: 'true' }))
    expect(d).toMatchObject({ rule: 'mesh-no-reply', target: 'ledger' })
    expect(x.routing().length).toBe(before + 1)
    x.L.observeRoutes(null)
  })
})

// ================================================================== part 3: the spool (k 'w', POST /wake/batch)
describe('part 3: wake rows through the Onsen spool', () => {
  const CRED = 'mesh_WAKEspool**********************************'
  function fake() {
    const calls: Array<{ path: string; body: any }> = [], seen = new Map<string, number>()
    const st = { down: false, missing: false, refuse: null as null | ((it: any) => string | null) }
    let next = 1
    const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } })
    const one = (it: any) => { const was = seen.get(it.idem_key); if (was) return { id: was, duplicate: true }; const id = next++; seen.set(it.idem_key, id); return { id, duplicate: false } }
    const f = (async (input: any, init?: any) => {
      const path = new URL(String(input)).pathname.replace(/^\/api\/onsen/, ''), body = init?.body ? JSON.parse(init.body) : undefined
      if (st.down) throw new TypeError('fetch failed: connect ECONNREFUSED')
      calls.push({ path, body })
      if (path === '/messages/batch') return json(200, { results: body.items.map(one) })
      if (path === '/wake/batch' && st.missing) return json(404, { detail: 'Not Found' })
      if (path === '/wake/batch') return json(200, { results: body.items.map((it: any) => { const why = st.refuse?.(it); return why ? { error: why, status: 403 } : one(it) }) })
      return json(404, { error: 'no route' })
    }) as typeof fetch
    return { f, calls, st, seen }
  }
  const mk = (fo: ReturnType<typeof fake>) => {
    const dir = mkdtempSync(join(tmpdir(), 'onsen-wake-spool-')), logs: string[] = []
    return { dir, logs, c: new OnsenClient({ dir, base: 'https://core.test/api/onsen', agent: 'adam', record: true, credential: () => CRED, log: (_l, m) => logs.push(m), fetch: fo.f, intervalMs: 3_600_000 }) }
  }
  const row = (n: number) => W.wakeItem({ event: `mesh-${n}`, source: 'mesh', from: 'eve', text: `t${n}`, rule: 'mesh-peer-call', target: 'lane', lane: 'adam.reflex.1' },
    { ...ctx0, ev: mesh(`mesh-${n}`, 'eve', `t${n}`, { btcc_msg_id: String(n) }), laneKind: 'reflex' }, { ...o, idem: W.idemWake('adam', 'b00t01', n, 1764064800000 + n) })
  const joeyMsg = (id: number) => ({ message_id: id, date: 1764020000, chat: { id: 1828, type: 'private' }, from: { id: 1828, first_name: 'J' }, text: `hi ${id}` })

  test('in order behind the message they follow, one batch per run; a resend (crash before the cursor) is duplicates; /healthz wake_recorded', async () => {
    const fo = fake(), { c, dir } = mk(fo)
    c.recordMessage(inboundItem('adam', joeyMsg(1), 'hi 1'))
    expect(c.recordWake(row(1))).toBe(true); expect(c.recordWake(row(2))).toBe(true)
    c.recordMessage(inboundItem('adam', joeyMsg(2), 'hi 2'))
    c.recordWake(row(3))
    await c.syncNow(true)
    expect(fo.calls.map(x => x.path)).toEqual(['/messages/batch', '/wake/batch', '/messages/batch', '/wake/batch'])
    expect(fo.calls[1]!.body.items.map((x: any) => x.idem_key)).toEqual([row(1).idem_key, row(2).idem_key])
    expect(fo.calls[1]!.body.items[0]).toEqual(row(1))
    expect(c.pendingBytes()).toBe(0)
    expect(c.health()).toMatchObject({ wake_recorded: 3, posted: 5, rejected: 0 })
    writeFileSync(join(dir, 'cursor.json'), JSON.stringify({ offset: 0 }))
    await c.syncNow(true)
    expect(c.health()).toMatchObject({ duplicates: 5, rejected: 0 })
    expect(fo.seen.size).toBe(5)
  })
  test('Onsen down: kept, retried; one row refused (another agent\'s): rejected.jsonl, the rest sent; an Onsen without the route: rejected, nothing held', async () => {
    const fo = fake(), { c, dir, logs } = mk(fo)
    fo.st.down = true
    c.recordWake(row(1)); c.recordWake(row(2))
    await c.syncNow(true)
    expect(c.pendingBytes()).toBeGreaterThan(0)
    expect(c.health().last_error).toContain('/wake/batch unreachable')
    fo.st.down = false
    fo.st.refuse = it => it.idem_key === row(1).idem_key ? 'eve writes only its own decisions (agent=adam)' : null
    await c.syncNow(true)
    expect(c.pendingBytes()).toBe(0)
    expect(c.health()).toMatchObject({ posted: 1, rejected: 1 })
    expect(readFileSync(join(dir, 'rejected.jsonl'), 'utf8')).toContain('writes only its own decisions')
    fo.st.refuse = null; fo.st.missing = true
    c.recordWake(row(3)); c.recordWake(row(4)); c.recordMessage(inboundItem('adam', joeyMsg(9), 'after'))
    await c.syncNow(true)
    expect(c.pendingBytes()).toBe(0)
    expect(fo.calls.slice(-2).map(x => x.path)).toEqual(['/wake/batch', '/messages/batch'])
    expect(logs.filter(l => l.includes('rejected 2 line(s)')).length).toBe(1)
  })
})
