// Onsen step 3, the half Joey sees (WO-145): the three features' parts with fakes (no Telegram, no network, a fake clock where time matters).
//   switches; SeenReactor (✍ at the main's seen; never a lane's; never over the agent's own; REACTION_INVALID once); DeliveryFacts onSeen;
//   statusLine / pendingLine (the exact texts); SinceTracker; PendingTracker (Onsen's /pending from the spool's lines); StatusPin (send + pin silently once,
//   edit on a change ≥ 5 s apart, last value wins, unpinned / deleted → off with a marker file, a restart keeps the message);
//   rewriteFormLinks / withKey / formTitle (query, fragment, markdown, punctuation, timeout) and the record without the key (outboundRecord + redact);
//   formBodyText / formEchoText; FormInbox (deliver → echo → ack; delivered once across a restart; ack spooled; 404); the spool's form ack line.
import { test, expect, describe } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OnsenClient, outboundRecord, redactText, type SendCtx } from './onsen-client.ts'
import { DeliveryFacts, type StatusView } from './onsen-status.ts'
import { FormInbox, PendingTracker, SeenReactor, SinceTracker, StatusPin, clearStatusOff, formBodyText, formEchoText, formHosts, formTitle, pendingLine,
  rewriteFormLinks, statusLine, statusText, switchOn, tpe, withKey, type FormItem, type PinApi } from './onsen-visible.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const logs: string[] = []
const log = (_l: string, m: string) => { logs.push(m) }

describe('switches', () => {
  test('unset / empty = off; a list of agents; *', () => {
    expect(switchOn({}, 'ONSEN_REACT_SEEN', 'chiron')).toBe(false)
    expect(switchOn({ ONSEN_REACT_SEEN: '' }, 'ONSEN_REACT_SEEN', 'chiron')).toBe(false)
    expect(switchOn({ ONSEN_REACT_SEEN: ' , ' }, 'ONSEN_REACT_SEEN', 'chiron')).toBe(false)
    expect(switchOn({ ONSEN_STATUS_PIN: 'atlas, chiron' }, 'ONSEN_STATUS_PIN', 'chiron')).toBe(true)
    expect(switchOn({ ONSEN_STATUS_PIN: 'atlas,chironx' }, 'ONSEN_STATUS_PIN', 'chiron')).toBe(false)
    expect(switchOn({ ONSEN_FORM_LINKS: '*' }, 'ONSEN_FORM_LINKS', 'anyone')).toBe(true)
    expect(switchOn({ ONSEN_FORM_LINKS: 'chiron' }, 'ONSEN_STATUS_PIN', 'chiron')).toBe(false)     // each switch is its own
    expect([...formHosts({})]).toEqual(['rescue.tunnel.fud.city', 'ops.fud.city'])
    expect([...formHosts({ ONSEN_FORM_HOSTS: 'A.example.com , b.example.com' })]).toEqual(['a.example.com', 'b.example.com'])
  })
})

describe('the ✍ reaction', () => {
  const mk = () => {
    const calls: Array<[string, number]> = []
    const st = { fail: null as null | string, hold: null as null | Promise<void> }
    const r = new SeenReactor({ log, react: async (c, id) => { calls.push([c, id]); if (st.hold) await st.hold; if (st.fail) throw new Error(st.fail) } })
    return { r, calls, st }
  }
  test('the main took it in: ✍ once; a lane: nothing; a page answer (form-<n>): nothing', async () => {
    const { r, calls } = mk()
    r.seen('1828', '501', 'lane-2')
    r.seen('1828', '501', 'main'); r.seen('1828', '501', 'main')
    r.seen('1828', 'form-12', 'main')
    await sleep(5)
    expect(calls).toEqual([['1828', 501]])
    expect(r.stats.reacted).toBe(1)
  })
  test('the agent reacted first: no ✍; the agent reacts while a ✍ is in flight: its reaction waits for it (lands last)', async () => {
    const { r, calls, st } = mk()
    r.agentReacted('1828', '502')
    r.seen('1828', '502', 'main')
    await sleep(5)
    expect(calls).toEqual([])
    let release!: () => void
    st.hold = new Promise(res => { release = res })
    r.seen('1828', '503', 'main')
    let settled = false
    const s = r.settle('1828', '503').then(() => { settled = true })
    await sleep(20)
    expect(settled).toBe(false)
    release(); await s
    expect(settled).toBe(true)
  })
  test('the 👀 still on its way: the ✍ goes after it; the agent reacts meanwhile: no ✍', async () => {
    const order: string[] = []
    const r = new SeenReactor({ log, react: async (_c, id) => { order.push(`✍ ${id}`) } })
    let done!: () => void
    const ack = new Promise<void>(res => { done = () => { order.push('👀 530'); res() } })
    r.ack('1828', 530, ack)
    r.seen('1828', '530', 'main')
    await sleep(20)
    expect(order).toEqual([])
    done(); await sleep(5)
    expect(order).toEqual(['👀 530', '✍ 530'])
    let done2!: () => void
    r.ack('1828', 531, new Promise<void>(res => { done2 = res }))
    r.seen('1828', '531', 'main')
    r.agentReacted('1828', 531)
    done2(); await sleep(5)
    expect(order).toEqual(['👀 530', '✍ 530'])
    expect(r.stats).toMatchObject({ reacted: 1, skipped_agent: 1 })
  })
  test('REACTION_INVALID: logged once, no ✍ after it; another failure: logged, the next message still tried', async () => {
    const { r, calls, st } = mk()
    st.fail = 'Call to setMessageReaction failed! (400: Bad Request: REACTION_INVALID)'
    logs.length = 0
    r.seen('1828', '510', 'main'); await sleep(5)
    r.seen('1828', '511', 'main'); await sleep(5)
    expect(calls.map(c => c[1])).toEqual([510])
    expect(logs.filter(l => l.includes('REACTION_INVALID')).length).toBe(1)
    expect(r.stats.refused).toBe(true)
    const b = mk()
    b.st.fail = 'Bad Request: message to react not found'
    b.r.seen('1828', '520', 'main'); await sleep(5)
    b.st.fail = null
    b.r.seen('1828', '521', 'main'); await sleep(5)
    expect(b.calls.map(c => c[1])).toEqual([520, 521])
  })
  test('DeliveryFacts onSeen: every seen report, each message of an album, the recipient named', () => {
    const got: string[] = []
    const f = new DeliveryFacts({ agent: 'adam', sink: () => {}, onSeen: (c, id, by) => got.push(`${c}:${id}:${by}`) })
    f.album('1828', [700, 701, 702])
    f.delivered('1828', 700)
    f.seen('1828', 700, 'main')
    f.seen('1828', 705, 'lane-1')
    expect(got).toEqual(['1828:700:main', '1828:701:main', '1828:702:main', '1828:705:lane-1'])
    const none = new DeliveryFacts({ agent: 'adam', sink: () => {} })        // switch off: no hook, as before
    expect(() => none.seen('1828', 1, 'main')).not.toThrow()
  })
})

describe('the status texts', () => {
  const T0 = Date.parse('2026-11-25T06:05:00Z')                                    // 14:05 in Taipei
  const v = (state: StatusView['state'], detail: Record<string, unknown> = {}, last: string | null = null): StatusView => ({ state, detail: { queued_joey: 0, ...detail }, last_activity_at: last })
  test('Taipei HH:MM', () => {
    expect(tpe(T0)).toBe('14:05')
    expect(tpe(Date.parse('2026-11-25T16:30:00Z'))).toBe('00:30')
  })
  test('WO-200 pin uses the Taipei reset date and probe interval', () => {
    const line = (until: string | null) => statusLine(v('idle', { walled: { until } }), T0, T0)
    expect(line('2026-11-25T09:00:00Z')).toBe('🔴 撞上限，17:00 解除；每分鐘探測，通了自動放')
    expect(line('2026-11-25T16:05:00Z')).toBe('🔴 撞上限，11/26 00:05 解除；每分鐘探測，通了自動放')
    expect(line(null)).toBe('🔴 撞上限；每分鐘探測，通了自動放')
  })
  test('line 1, every state', () => {
    expect(statusLine(v('idle'), T0)).toBe('🟢 閒置（14:05 起）')
    expect(statusLine(v('idle', { background_shell: true }), T0)).toBe('🟢 閒置（14:05 起）')
    expect(statusLine(v('busy'), T0)).toBe('🟡 處理中（14:05 起）')
    expect(statusLine(v('busy', { tool: { name: 'Bash', since: 'x' }, subagents: 0 }), T0)).toBe('🟡 處理中（14:05 起）：Bash')
    expect(statusLine(v('busy', { tool: { name: 'Agent', since: 'x' }, subagents: 2 }), T0)).toBe('🟡 處理中（14:05 起）：等 2 隻子 agent')
    expect(statusLine(v('busy', { registry_status: 'thinking', tool: null, subagents: 0 }), T0)).toBe('🟡 處理中（14:05 起）')
    expect(statusLine(v('busy', { compacting: true, tool: { name: 'Bash' } }), T0)).toBe('🟡 處理中（14:05 起）：壓縮中')
    expect(statusLine(v('stuck', { threshold_s: 600, tool: { name: 'Bash' } }, new Date(T0 - 12.5 * 60_000).toISOString()), T0, T0)).toBe('🟡 處理中（14:05 起）：已經 12 分鐘沒動靜')
    expect(statusLine(v('stuck', { compacting: true }, new Date(T0 - 30 * 60_000).toISOString()), T0, T0)).toBe('🟡 處理中（14:05 起）：壓縮中')
    expect(statusLine(v('waiting', { waitingFor: 'permission prompt' }), T0)).toBe('🟠 等你按（14:05 起）：權限詢問')
    expect(statusLine(v('waiting', { waitingFor: 'dialog open' }), T0)).toBe('🟠 等你按（14:05 起）：選單')
    expect(statusLine(v('waiting', { waitingFor: 'input needed' }), T0)).toBe('🟠 等你按（14:05 起）：它問了問題')
    expect(statusLine(v('waiting', { waitingFor: 'plan approval' }), T0)).toBe('🟠 等你按（14:05 起）：plan approval')
    expect(statusLine(v('waiting', { waitingFor: null }), T0)).toBe('🟠 等你按（14:05 起）')
    expect(statusLine(v('offline', { reason: 'no_registration' }), T0)).toBe('⚫ 失連（14:05 起）：沒有 session')
    expect(statusLine(v('offline', { reason: 'pid_gone', walled: { until: null } }), T0)).toBe('⚫ 失連（14:05 起）：行程不在了')
    expect(statusLine(v('offline', { reason: 'pid_reused' }), T0)).toBe('⚫ 失連（14:05 起）：行程不在了')
    expect(statusLine(v('offline', { reason: 'not_connected' }), T0)).toBe('⚫ 失連（14:05 起）：連不上')
  })
  test('line 2 only when non-empty; a part that is 0 is left out', () => {
    expect(pendingLine({ unseen: 0, seenNoOut: 0 })).toBe('')
    expect(pendingLine({ unseen: 2, seenNoOut: 0 })).toBe('你傳的：2 則還沒進去')
    expect(pendingLine({ unseen: 0, seenNoOut: 1 })).toBe('你傳的：1 則看到了還沒回')
    expect(pendingLine({ unseen: 3, seenNoOut: 1 })).toBe('你傳的：3 則還沒進去、1 則看到了還沒回')
    expect(statusText(v('idle'), T0, { unseen: 0, seenNoOut: 0 })).toBe('🟢 閒置（14:05 起）')
    expect(statusText(v('busy', { tool: { name: 'Read' } }), T0, { unseen: 1, seenNoOut: 2 })).toBe('🟡 處理中（14:05 起）：Read\n你傳的：1 則還沒進去、2 則看到了還沒回')
  })
  test('since: when the state began; a restart within 2 min in the same state keeps it', () => {
    let now = T0
    let store: any = null
    const mk = () => new SinceTracker({ load: () => store, save: x => { store = x }, now: () => now })
    const a = mk()
    expect(a.track('idle')).toBe(T0)
    now += 60_000; expect(a.track('idle')).toBe(T0)
    now += 60_000; expect(a.track('busy')).toBe(T0 + 120_000)
    now += 30_000
    expect(mk().track('busy')).toBe(T0 + 120_000)                                   // restarted 30 s later, same state
    now += 10 * 60_000
    expect(mk().track('busy')).toBe(now)                                             // 10 min later: not carried
    expect(mk().track('idle')).toBe(now)                                             // another state: now
  })
})

describe('the pending counts (Onsen /pending, locally)', () => {
  const d = (id: string | number, state: 'delivered' | 'seen' | 'turn_end', at: number, chat = '1828') =>
    ({ k: 'd' as const, r: { idem_key: `k${id}${state}`, agent: 'adam', client: 'telegram' as const, chat, client_msg_id: String(id), state, at: new Date(at).toISOString(), ...(state !== 'delivered' ? { by: 'main' } : {}) } })
  const m = (dir: 'in' | 'out', sender: string, at: number, o: Record<string, unknown> = {}) =>
    ({ k: 'm' as const, r: { idem_key: `m${Math.random()}`, agent: 'adam', client: 'telegram' as const, chat: '1828', direction: dir, sender, body: 'x', kind: 'text' as const,
      sent_at: new Date(at).toISOString(), status: 'ok' as const, ...o } as any })
  test('delivered → not in yet; seen → seen not answered; the agent sends after: answered; system:* is not an answer; a command is not counted', () => {
    let now = Date.parse('2026-11-25T06:00:00Z')
    const p = new PendingTracker({ now: () => now })
    p.line(m('in', 'tg:1828', now, { client_msg_id: '1' })); p.line(d(1, 'delivered', now))
    p.line(m('in', 'tg:1828', now, { client_msg_id: '2' })); p.line(d(2, 'delivered', now))
    expect(p.counts('1828')).toEqual({ unseen: 2, seenNoOut: 0 })
    now += 1_000; p.line(d(1, 'seen', now))
    expect(p.counts('1828')).toEqual({ unseen: 1, seenNoOut: 1 })
    now += 1_000; p.line(m('out', 'system:status', now)); p.line(m('out', 'system:form-echo', now)); p.line(m('out', 'system:ack', now))
    expect(p.counts('1828')).toEqual({ unseen: 1, seenNoOut: 1 })
    now += 1_000; p.line(m('out', 'main', now))
    expect(p.counts('1828')).toEqual({ unseen: 1, seenNoOut: 0 })
    now += 1_000; p.line(d(2, 'seen', now))
    expect(p.counts('1828')).toEqual({ unseen: 0, seenNoOut: 1 })
    now += 1_000; p.line(m('out', 'lane-3', now))                                     // a lane's line answers too (Onsen: any sender but system:*)
    expect(p.counts('1828')).toEqual({ unseen: 0, seenNoOut: 0 })
    p.line(m('in', 'tg:1828', now, { client_msg_id: '3', kind: 'command' })); p.line(d(3, 'delivered', now))
    expect(p.counts('1828')).toEqual({ unseen: 0, seenNoOut: 0 })
    p.line(d('form-9', 'delivered', now))                                             // a page answer: counted (no inbound record of its own here)
    expect(p.counts('1828')).toEqual({ unseen: 1, seenNoOut: 0 })
    expect(p.counts('-100')).toEqual({ unseen: 0, seenNoOut: 0 })
    now += 49 * 3600_000                                                              // older than 48 h: gone
    expect(p.counts('1828')).toEqual({ unseen: 0, seenNoOut: 0 })
  })
  test('a restart reads the spool files', () => {
    const now = Date.now()
    const dir = mkdtempSync(join(tmpdir(), 'onsen-vis-pend-'))
    writeFileSync(join(dir, 'spool.1.jsonl'), [d(1, 'delivered', now - 5000), d(1, 'seen', now - 4000)].map(x => JSON.stringify(x)).join('\n') + '\n')
    writeFileSync(join(dir, 'spool.jsonl'), [d(2, 'delivered', now - 3000), { k: 's', r: { state: 'idle' } }, 'not json'].map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('\n') + '\n')
    const p = new PendingTracker()
    expect(p.load([join(dir, 'spool.1.jsonl'), join(dir, 'spool.jsonl'), join(dir, 'missing')])).toBe(3)
    expect(p.counts('1828')).toEqual({ unseen: 1, seenNoOut: 1 })
  })
})

describe('the pinned status message', () => {
  const mk = (dir = mkdtempSync(join(tmpdir(), 'onsen-vis-pin-')), clock = { t: 1_000_000 }) => {
    const calls: string[] = []
    const st = { pinned: new Map<string, number>(), deleted: new Set<number>(), sendFail: false, pinFail: false }
    let next = 900
    const api: PinApi = {
      send: async (c, text) => { if (st.sendFail) throw new Error('Forbidden: bot was blocked by the user'); const id = ++next; calls.push(`send ${c} ${id} ${text}`); return id },
      pin: async (c, id) => { calls.push(`pin ${c} ${id}`); if (st.pinFail) throw new Error('Bad Request: not enough rights'); st.pinned.set(c, id) },
      edit: async (c, id, text) => { calls.push(`edit ${c} ${id} ${text}`); if (st.deleted.has(id)) throw new Error('Call to editMessageText failed! (400: Bad Request: message to edit not found)'); if (text === 'SAME') throw new Error('Bad Request: message is not modified') },
      pinnedId: async c => { calls.push(`getChat ${c}`); return st.pinned.get(c) ?? null },
    }
    const pin = new StatusPin({ dir, api, log, now: () => clock.t, minEditMs: 5_000, pinCheckMs: 60_000 })
    return { pin, calls, st, dir, clock }
  }
  const flush = () => sleep(10)
  const mkReal = () => {
    const calls: string[] = [], at: number[] = []
    const note = (c: string) => { calls.push(c); at.push(Date.now()) }
    const api: PinApi = { send: async (c, t) => { note(`send ${c} 901 ${t}`); return 901 }, pin: async (c, id) => { note(`pin ${c} ${id}`) },
      edit: async (c, id, t) => { note(`edit ${c} ${id} ${t}`) }, pinnedId: async () => 901 }
    return { pin: new StatusPin({ dir: mkdtempSync(join(tmpdir(), 'onsen-vis-pinr-')), api, log, minEditMs: 300 }), calls, at }
  }
  test('WO-197: paused (the agent is a connector, the bridge draws the pin): nothing sent, edited, pinned or checked; what waited is dropped (lab: plutus refused every 5 s after the switch)', async () => {
    const calls: string[] = []; let paused = false
    const api: PinApi = { send: async (c, t) => { calls.push(`send ${c} ${t}`); return 901 }, pin: async (c, id) => { calls.push(`pin ${c} ${id}`) },
      edit: async (c, id, t) => { calls.push(`edit ${c} ${id} ${t}`) }, pinnedId: async c => { calls.push(`getChat ${c}`); return 901 } }
    const pin = new StatusPin({ dir: mkdtempSync(join(tmpdir(), 'onsen-vis-pinp-')), api, log, minEditMs: 300, paused: () => paused })
    pin.update('1828', 'A'); await sleep(50)
    const before = calls.length
    expect(calls.some(c => c.startsWith('send 1828'))).toBe(true)
    pin.update('1828', 'B')                 // inside minEditMs: it waits for the timer
    paused = true                           // the switch happens meanwhile
    await sleep(600)
    pin.update('1828', 'C'); await sleep(600)
    expect(calls.length).toBe(before)       // B never edited, C never edited, no pin check
    paused = false
    pin.update('1828', 'D'); await sleep(600)
    expect(calls.at(-1)).toBe('edit 1828 901 D')
  })
  test('1.48.2: the 「不要顯示這則」 button: dismiss deletes the message, writes the marker, and nothing is sent or edited there again (a restart too)', async () => {
    const { pin, calls, dir, clock } = mk()
    const dels: string[] = []
    ;(pin as any).o.api.del = async (c: string, id: number) => { dels.push(`${c}:${id}`) }
    pin.update('1828', 'A'); await flush()
    expect(await pin.dismiss('1828')).toBe(901)
    expect(dels).toEqual(['1828:901'])
    expect(pin.isOff('1828')).toBe(true)
    const n = calls.length
    clock.t += 10_000; pin.update('1828', 'B'); await flush()
    expect(calls.length).toBe(n)
    const again = new StatusPin({ dir, api: (pin as any).o.api, log, now: () => clock.t })
    again.update('1828', 'C'); await flush()
    expect(calls.length).toBe(n)
  })
  test('sent and pinned once; the same text: nothing; a change: one edit; changes within 5 s: coalesced, the last one wins', async () => {
    const { pin, calls, clock } = mk()
    pin.update('1828', 'A'); await flush()
    expect(calls).toEqual(['send 1828 901 A', 'pin 1828 901'])
    pin.update('1828', 'A'); await flush()
    expect(calls.length).toBe(2)
    clock.t += 6_000; pin.update('1828', 'B'); await flush()
    expect(calls.slice(2)).toEqual(['edit 1828 901 B'])
    clock.t += 1_000; pin.update('1828', 'C'); await flush()
    clock.t += 1_000; pin.update('1828', 'D'); await flush()
    expect(calls.length).toBe(3)                                                       // within 5 s of the last edit: waits
    // the wait itself, on the real clock (minEditMs 300): C and D inside it → one edit, D, ≥ 300 ms after the last
    const real = mkReal()
    real.pin.update('1828', 'A'); await flush()
    real.pin.update('1828', 'B'); await flush()
    real.pin.update('1828', 'C'); await sleep(50); real.pin.update('1828', 'D')
    expect(real.calls.length).toBe(2)
    await sleep(400)
    expect(real.calls.slice(2)).toEqual(['edit 1828 901 D'])
    expect(real.at[2]! - real.at[0]!).toBeGreaterThanOrEqual(290)
    expect(real.pin.view()['1828']).toEqual({ message_id: 901, pinned: true, text: 'D' })
  })
  test('deleted: the edit is refused "not found" → off for that chat (a marker file), nothing more; the marker deleted: a new message', async () => {
    const { pin, calls, st, dir, clock } = mk()
    pin.update('1828', 'A'); await flush()
    st.deleted.add(901)
    clock.t += 6_000; pin.update('1828', 'B'); await flush()
    expect(calls.at(-1)).toBe('edit 1828 901 B')
    expect(existsSync(pin.offFile('1828'))).toBe(true)
    expect(JSON.parse(readFileSync(pin.offFile('1828'), 'utf8'))).toMatchObject({ chat: '1828', why: 'deleted', message_id: 901 })
    const n = calls.length
    clock.t += 6_000; pin.update('1828', 'C'); await flush()
    expect(calls.length).toBe(n)
    // a restart: still off
    const again = new StatusPin({ dir, api: (pin as any).o.api, log, now: () => clock.t })
    again.update('1828', 'D'); await flush()
    expect(calls.length).toBe(n)
    clearStatusOff(dir, '1828')
    again.update('1828', 'E'); await flush()
    expect(calls.slice(n)).toEqual(['send 1828 902 E', 'pin 1828 902'])
  })
  test('unpinned: checked before an edit at most every 60 s (getChat pinned_message not ours) → off', async () => {
    const { pin, calls, st, clock } = mk()
    pin.update('1828', 'A'); await flush()
    clock.t += 6_000; pin.update('1828', 'B'); await flush()
    expect(calls.filter(c => c.startsWith('getChat')).length).toBe(0)                  // checked at the send: not again within 60 s
    clock.t += 61_000; pin.update('1828', 'C'); await flush()
    expect(calls.slice(-2)).toEqual(['getChat 1828', 'edit 1828 901 C'])
    st.pinned.delete('1828')                                                           // Joey unpins it
    clock.t += 30_000; pin.update('1828', 'D'); await flush()
    expect(calls.at(-1)).toBe('edit 1828 901 D')                                      // within 60 s of the last check: not checked yet
    clock.t += 61_000; pin.update('1828', 'E'); await flush()
    expect(calls.at(-1)).toBe('getChat 1828')                                          // checked: not ours → off, no edit
    expect(JSON.parse(readFileSync(pin.offFile('1828'), 'utf8'))).toMatchObject({ why: 'unpinned' })
    st.pinned.set('1828', 5)                                                           // another message pinned: still off
    clock.t += 61_000; pin.update('1828', 'F'); await flush()
    expect(calls.at(-1)).toBe('getChat 1828')
  })
  test('a restart keeps the message (edits it, checks the pin first); "not modified" is no failure; a failed pin is tried again', async () => {
    const a = mk()
    a.pin.update('1828', 'A'); await flush()
    const b = mk(a.dir, a.clock)
    b.st.pinned.set('1828', 901)
    b.clock.t += 6_000; b.pin.update('1828', 'B'); await flush()
    expect(b.calls).toEqual(['getChat 1828', 'edit 1828 901 B'])
    b.clock.t += 6_000; b.pin.update('1828', 'SAME'); await flush()
    expect(b.pin.view()['1828']!.text).toBe('SAME')
    const c = mk()
    c.st.pinFail = true
    c.pin.update('1828', 'A'); await flush()
    expect(c.pin.view()['1828']).toMatchObject({ message_id: 901, pinned: false })
    c.st.pinFail = false
    c.clock.t += 61_000; c.pin.update('1828', 'B'); await flush()
    expect(c.calls.slice(-3)).toEqual(['getChat 1828', 'pin 1828 901', 'edit 1828 901 B'])   // not pinned by us: never "unpinned"
    expect(c.pin.view()['1828']!.pinned).toBe(true)
  })
  test('the send fails (Joey never started the bot): tried again later, not every tick', async () => {
    const { pin, calls, st, clock } = mk()
    st.sendFail = true
    pin.update('1828', 'A'); await flush()
    pin.update('1828', 'B'); await flush()
    expect(calls).toEqual([])
    st.sendFail = false
    pin.update('1828', 'C'); await flush()
    expect(calls).toEqual([])                                                          // within the 10 min retry
    clock.t += 601_000; pin.update('1828', 'D'); await flush()
    expect(calls).toEqual(['send 1828 901 D', 'pin 1828 901'])
  })
})

describe('page form links', () => {
  const hosts = formHosts({})
  const fake = (o: { slow?: number; fail?: boolean } = {}) => {
    const asked: Array<{ title: string; url: string }> = []
    let n = 0
    const create = async (title: string, url: string) => {
      asked.push({ title, url })
      if (o.slow) await sleep(o.slow)
      if (o.fail) throw new Error('Onsen /forms answered HTTP 500')
      n++
      return { id: 40 + n, key: `onsenform_KEY${n}-x_y`, expires_at: 'z' }
    }
    return { create, asked }
  }
  test('withKey: ?k= / &k=, the #fragment stays last', () => {
    expect(withKey('https://ops.fud.city/a', 'K')).toBe('https://ops.fud.city/a?k=K')
    expect(withKey('https://ops.fud.city/a?x=1', 'K')).toBe('https://ops.fud.city/a?x=1&k=K')
    expect(withKey('https://ops.fud.city/a#sec', 'K')).toBe('https://ops.fud.city/a?k=K#sec')
    expect(withKey('https://ops.fud.city/a?x=1&y=2#sec', 'K')).toBe('https://ops.fud.city/a?x=1&y=2&k=K#sec')
    expect(withKey('https://ops.fud.city/a?', 'K')).toBe('https://ops.fud.city/a?k=K')
  })
  test('our hosts only; markdown links, bare links, trailing punctuation; one key per distinct link; the record restores the text', async () => {
    const { create, asked } = fake()
    const text = '## 本週決定\n請選一個：https://rescue.tunnel.fud.city/messenger.html?v=2#order。\n\n[填表單](https://ops.fud.city/wo/145) 或 <https://ops.fud.city/wo/145>\n別的站 https://example.com/x 不動；已有 k 的 https://ops.fud.city/a?k=mine 不動'
    const r = await rewriteFormLinks(text, { hosts, chat: '1828', create })
    expect(asked).toEqual([{ title: '請選一個', url: 'https://rescue.tunnel.fud.city/messenger.html?v=2#order' }, { title: '填表單 或', url: 'https://ops.fud.city/wo/145' }])
    expect(r.text).toBe('## 本週決定\n請選一個：https://rescue.tunnel.fud.city/messenger.html?v=2&k=onsenform_KEY1-x_y#order。\n\n[填表單](https://ops.fud.city/wo/145?k=onsenform_KEY2-x_y) 或 <https://ops.fud.city/wo/145?k=onsenform_KEY2-x_y>\n別的站 https://example.com/x 不動；已有 k 的 https://ops.fud.city/a?k=mine 不動')
    expect(r.forms).toEqual([{ id: 41, url: 'https://rescue.tunnel.fud.city/messenger.html?v=2#order' }, { id: 42, url: 'https://ops.fud.city/wo/145' }])
    expect(r.missed).toBe(0)
    expect(redactText(r.text, r.redact)).toBe(text)
    // what Onsen records: the text without the keys (rich and plain, each chunk), whatever Telegram got
    const ctx: SendCtx = { sender: 'main', redact: r.redact }
    const rich = outboundRecord('adam', ctx, 'sendRichMessage', { chat_id: '1828', rich_message: { markdown: r.text } }, { message_id: 9, date: 1 })
    expect((rich as any).r.body).toBe(text)
    expect(JSON.stringify(rich)).not.toContain('onsenform_')
    const plain = outboundRecord('adam', ctx, 'sendMessage', { chat_id: '1828', text: r.text.slice(0, 120) }, { message_id: 10, date: 1 })
    expect(JSON.stringify(plain)).not.toContain('KEY1')
    const noCtx = outboundRecord('adam', { sender: 'main' }, 'sendMessage', { chat_id: '1828', text: 'https://ops.fud.city/a?k=x' }, { message_id: 11, date: 1 })
    expect((noCtx as any).r.body).toBe('https://ops.fud.city/a?k=x')                  // no redact: as before
  })
  test('no link to our pages: unchanged, nothing asked; Onsen silent past 3 s or failing: the link as written', async () => {
    const a = fake()
    const r0 = await rewriteFormLinks('沒有連結，或 https://example.com', { hosts, chat: '1', create: a.create })
    expect(r0).toEqual({ text: '沒有連結，或 https://example.com', redact: [], forms: [], missed: 0, why: [] })
    expect(a.asked.length).toBe(0)
    const slow = fake({ slow: 400 })
    const t0 = Date.now()
    const r1 = await rewriteFormLinks('看 https://ops.fud.city/x', { hosts, chat: '1', create: slow.create, timeoutMs: 100 })
    expect(Date.now() - t0).toBeLessThan(350)
    expect(r1.text).toBe('看 https://ops.fud.city/x')
    expect(r1.missed).toBe(1)
    const bad = fake({ fail: true })
    const r2 = await rewriteFormLinks('看 https://ops.fud.city/x', { hosts, chat: '1', create: bad.create })
    expect(r2.text).toBe('看 https://ops.fud.city/x')
    expect(r2.why[0]).toContain('HTTP 500')
  })
  test('the title: the link\'s own line, else the nearest non-empty line above, then below, else the path', () => {
    const t = '前言\n\n第一題：選方案\n\nhttps://ops.fud.city/q/1\n'
    expect(formTitle(t, t.indexOf('https'), 'https://ops.fud.city/q/1')).toBe('第一題：選方案')
    const b = 'https://ops.fud.city/q/2\n\n下面這行'
    expect(formTitle(b, 0, 'https://ops.fud.city/q/2')).toBe('下面這行')
    expect(formTitle('https://ops.fud.city/q/3', 0, 'https://ops.fud.city/q/3')).toBe('/q/3')
    expect(formTitle('- **[投票](https://ops.fud.city/v)**', 4, 'https://ops.fud.city/v')).toBe('投票')
  })
  test('a page answer as text; the echo', () => {
    expect(formBodyText('{"choice":"B","note":"快一點"}')).toBe('choice: B\nnote: 快一點')
    expect(formBodyText('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}')
    expect(formBodyText('"只是字"')).toBe('只是字')
    expect(formBodyText('B 方案')).toBe('B 方案')
    expect(formEchoText({ title: '選方案', body: '{"choice":"B"}' })).toBe('〔你在頁面送出的｜選方案〕\nchoice: B')
  })
})

describe('the forms inbox', () => {
  const item = (id: number, chat = '1828'): FormItem => ({ id, form_id: id + 1000, chat, title: `表單 ${id}`, body: `{"v":${id}}`, at: '2026-11-25T06:00:00Z' })
  const mk = (dir = mkdtempSync(join(tmpdir(), 'onsen-vis-inbox-'))) => {
    const st = { items: [] as FormItem[], acked: [] as number[], ackStatus: 200, status: 200, spooled: [] as number[][] }
    const order: string[] = []
    const inbox = new FormInbox({ dir, log, waitS: 0, sleep: async () => {},
      request: async (m, p, b) => {
        if (m === 'GET') { order.push(`GET ${p}`); return { status: st.status, json: { items: st.items.filter(x => !st.acked.includes(x.id)) } } }
        order.push(`POST ${p} ${JSON.stringify(b)}`)
        if (st.ackStatus !== 200) return { status: st.ackStatus, json: {} }
        st.acked.push(...(b as any).ids); return { status: 200, json: { acked: (b as any).ids.length } }
      },
      deliver: async it => { order.push(`deliver ${it.id}`); return it.chat !== '999' },
      echo: async it => { order.push(`echo ${it.id}`) },
      spoolAck: ids => { st.spooled.push(ids); return true },
    })
    return { inbox, st, order, dir }
  }
  test('each answer: delivered, echoed, then acked (in id order); a chat not allowlisted: acked and dropped', async () => {
    const { inbox, st, order } = mk()
    st.items = [item(8), item(7), item(9, '999')]
    expect(await inbox.pollOnce()).toMatchObject({ ok: true })
    expect(order).toEqual(['GET /forms/inbox?wait=0', 'deliver 7', 'echo 7', 'deliver 8', 'echo 8', 'deliver 9', 'POST /forms/ack {"ids":[7,8,9]}'])
    expect(inbox.stats).toMatchObject({ delivered: 2, dropped: 1, acked: 3 })
  })
  test('the ack lost: spooled; the answer comes back (after a restart too): not delivered again, acked again', async () => {
    const a = mk()
    a.st.items = [item(20)]
    a.st.ackStatus = 503
    await a.inbox.pollOnce()
    expect(a.st.spooled).toEqual([[20]])
    const b = mk(a.dir)                                                                // a restart: the same state dir
    b.st.items = [item(20), item(21)]
    await b.inbox.pollOnce()
    expect(b.order).toEqual(['GET /forms/inbox?wait=0', 'deliver 21', 'echo 21', 'POST /forms/ack {"ids":[20,21]}'])
  })
  test('Onsen without the route (404): asked again in a minute; an error: the backoff; a delivery that throws: not acked', async () => {
    const { inbox, st, order } = mk()
    st.status = 404
    expect(await inbox.pollOnce()).toMatchObject({ ok: false, wait: 60_000 })
    st.status = 502
    expect(await inbox.pollOnce()).toMatchObject({ ok: false, wait: 0 })
    const c = mk()
    c.st.items = [item(30)]
    ;(c.inbox as any).o.deliver = async () => { throw new Error('lanes not ready') }
    expect(await c.inbox.pollOnce()).toMatchObject({ ok: true, wait: 5_000 })
    expect(c.order).toEqual(['GET /forms/inbox?wait=0'])
    expect(order.length).toBe(2)
  })
})

describe('the spool: a form ack line, observe, request', () => {
  test('recordFormAck → POST /forms/ack in order; observe sees each appended line; request carries the credential', async () => {
    const CRED = 'mesh_VISIBLE**********************************'
    const posted: Array<{ path: string; body: any; auth: string }> = []
    const f = (async (input: any, init?: any) => {
      const path = new URL(String(input)).pathname.replace(/^\/api\/onsen/, '')
      posted.push({ path, body: init?.body ? JSON.parse(init.body) : null, auth: init?.headers?.Authorization })
      if (path === '/messages/batch') return Response.json({ results: JSON.parse(init.body).items.map((_: any, i: number) => ({ id: i + 1 })) })
      return Response.json({ acked: 1, items: [] })
    }) as typeof fetch
    const dir = mkdtempSync(join(tmpdir(), 'onsen-vis-spool-'))
    const c = new OnsenClient({ dir, base: 'http://onsen.test/api/onsen', agent: 'adam', record: true, credential: () => CRED, log, fetch: f })
    const seen: string[] = []
    c.observe(l => seen.push(l.k))
    c.recordMessage({ idem_key: 'a', agent: 'adam', client: 'telegram', chat: '1', direction: 'out', sender: 'main', body: 'x', kind: 'text', sent_at: new Date().toISOString(), status: 'ok' })
    expect(c.recordFormAck([5, 6])).toBe(true)
    expect(c.recordFormAck([])).toBe(false)
    expect(seen).toEqual(['m', 'a'])
    await c.syncNow(true)
    expect(posted.map(p => p.path)).toEqual(['/messages/batch', '/forms/ack'])
    expect(posted[1]!.body).toEqual({ ids: [5, 6] })
    expect(c.pendingBytes()).toBe(0)
    const r = await c.request('GET', '/forms/inbox?wait=0')
    expect(r?.status).toBe(200)
    expect(posted.at(-1)!.auth).toBe(`Bearer ${CRED}`)
    const none = new OnsenClient({ dir, base: 'http://onsen.test/api/onsen', agent: 'adam', record: true, credential: () => null, log, fetch: f })
    expect(await none.request('GET', '/x')).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})

test('1.48.1: an MCP tool shows its own name', async () => {
  const { statusLine } = await import('./onsen-visible.ts')
  const v: any = { state: 'busy', detail: { tool: { name: 'mcp__plugin_telegram-http_telegram-http__reply' }, subagents: 0 } }
  expect(statusLine(v, Date.parse('2026-11-25T05:00:00Z'))).toBe('🟡 處理中（13:00 起）：reply')
})

test('WO-159: the echo of a message Joey wrote in Onsen: 〔你在 Onsen 傳的〕 and the text as he typed it', () => {
  expect(formEchoText({ title: '', body: '{"a":1}', say: true })).toBe('〔你在 Onsen 傳的〕\n{"a":1}')
  expect(formEchoText({ title: '選方案', body: '{"a":1}' })).toBe('〔你在頁面送出的｜選方案〕\na: 1')
})
