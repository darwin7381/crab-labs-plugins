import { describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LocalKeepwarm, POKE_TEXT, decide, decideMail, isRealInput, remindText, scan, type KState, type MailCount,
} from './keepwarm-local.ts'
import { fakeItems } from './test-fixtures/onsen-items.ts'
import { TakeMode } from './onsen-take.ts'
import { OnsenClient } from './onsen-client.ts'
import { ItemReceiver } from './onsen-receive.ts'
import { Claims } from './onsen-claims.ts'
import { itemRef } from './onsen-items.ts'

const T0 = Date.parse('2026-11-16T08:00:00Z') / 1000
const iso = (t: number) => new Date(t * 1000).toISOString()
const req = (t: number) => ({ type: 'api-request', querySource: 'repl_main_thread', timestamp: iso(t) })
const answer = (t: number, usage: any = { input_tokens: 10, cache_read_input_tokens: 9000, cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 10 } }) =>
  ({ type: 'assistant', timestamp: iso(t), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage } })
const end = (t: number) => ({ type: 'system', subtype: 'turn_duration', timestamp: iso(t) })
const chan = (t: number, user: string, body: string, userId = 'local-inject') => ({
  type: 'user', timestamp: iso(t), isMeta: true, origin: { kind: 'channel' },
  message: { role: 'user', content: `<channel source="plugin:telegram-http:telegram-http" chat_id="1" user="${user}" user_id="${userId}">\n${body}\n</channel>` },
})
const joey = (t: number) => chan(t, 'Advac777', '做這個', '1828173984')
const poke = (t: number) => ({ type: 'user', timestamp: iso(t), isMeta: true, origin: { kind: 'channel' },
  message: { content: `<channel source="plugin:agent-inbox:agent-inbox" chat_id="local-inject" user="fleet-watchdog" user_id="local-inject" no_reply="true">\n${POKE_TEXT}\n</channel>` } })
const lines = (...recs: any[]) => recs.map(r => JSON.stringify(r)).join('\n') + '\n'
// a turn: Joey's message, the request, the answer, the turn end
const turnAt = (t: number) => [joey(t), req(t + 1), answer(t + 5), end(t + 6)]

describe('scan', () => {
  test('a member-written keepwarm does not restart the 24-hour real-work clock', () => {
    const rec = chan(T0 + 3000, 'lanes', POKE_TEXT)
    rec.message.content = rec.message.content.replace('user="lanes"', 'user="lanes" via="lanes" kind="keepwarm"')
    const s = scan(lines(...turnAt(T0), rec, req(T0 + 3001), answer(T0 + 3002), end(T0 + 3004)))
    expect(s.last_poke).toBe(T0 + 3000)
    expect(s.last_real).toBe(T0)
  })
  test('a channel message from Joey is real work; a fleet-watchdog line is not', () => {
    const s = scan(lines(...turnAt(T0), poke(T0 + 3000), req(T0 + 3001), answer(T0 + 3003), end(T0 + 3004)))
    expect(s.last_real).toBe(T0)
    expect(s.last_joey).toBe(T0)
    expect(s.last_req).toBe(T0 + 3001)
    expect(s.turn_open).toBe(false)
  })
  test('a message absorbed mid-turn (queued_command attachment) counts as real work and as Joey', () => {
    const q = { type: 'attachment', timestamp: iso(T0 + 100), attachment: { type: 'queued_command', origin: { kind: 'channel' },
      prompt: '<channel source="plugin:telegram-http:telegram-http" user="Advac777" user_id="1828173984">\n再加一個\n</channel>' } }
    const s = scan(lines(...turnAt(T0), q))
    expect(s.last_real).toBe(T0 + 100)
    expect(s.last_joey).toBe(T0 + 100)
  })
  test('a turn still running; a compaction; a usage wall', () => {
    expect(scan(lines(joey(T0), req(T0 + 1), answer(T0 + 5))).turn_open).toBe(true)
    expect(scan(lines(...turnAt(T0), { type: 'system', subtype: 'compact_boundary', timestamp: iso(T0 + 10) })).compact_after).toBe(true)
    const wall = { type: 'assistant', timestamp: iso(T0 + 5), error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: 'usage limit reached' }] } }
    expect(scan(lines(joey(T0), req(T0 + 1), wall, end(T0 + 6))).walled).toBe(true)
  })
  test('isRealInput: plumbing records are not work', () => {
    expect(isRealInput({ isMeta: true }, 'skill body')).toBe(false)
    expect(isRealInput({}, 'typed prompt')).toBe(true)
  })
})

test('take keepwarm uses the member credential, replaces a stale warm window and survives loss of its POST reply', async () => {
  const f = fakeItems(), dir = mkdtempSync(join(tmpdir(), 'kw-take-')), file = join(dir, 'main.jsonl')
  const at = Math.floor(f.now() / 1000) + 0.789
  let lost = true, clock = at + 10, mail = 0, delivered = 0
  const client = new OnsenClient({ dir, agent: 'adam', base: f.base, record: true, credential: () => 'test-member', log: () => {},
    fetch: (async (url, init) => {
      const response = await fetch(url, init)
      if (init?.method === 'POST' && lost) { lost = false; throw Error('lost response') }
      return response
    }) as typeof fetch })
  const mode = new TakeMode('adam', client.request.bind(client), () => {}, () => {})
  const monitor = () => new LocalKeepwarm({ name: 'adam', take: { mode, write: w => client.recordItemWrite(w) }, stateDir: dir, projectsDir: () => dir, transcript: () => file,
    mode: () => 'live', mail: async () => { mail++; return null }, deliver: async () => { delivered++; return true }, log: () => {}, now: () => clock })
  const check = monitor()
  try {
    await mode.probe()
    writeFileSync(file, lines(...turnAt(at)))
    await check.run()
    expect(f.rows.size).toBe(0)
    await client.syncNow(true) // the POST lands but the spool loses its reply
    await monitor().run()
    await client.syncNow(true)
    expect(f.rows.size).toBe(1)
    const first = [...f.rows.values()][0]!
    expect(first).toMatchObject({ kind: 'keepwarm', from: 'adam', session_id: 'main', deadline: null,
      not_before: iso(at + 1 + 50 * 60), expires_at: iso(at + 1 + 60 * 60), state: 'waiting' })
    expect(check.matchesWindow(first.not_before!)).toBe(true)
    const dueSecond = Math.floor(Date.parse(first.not_before!) / 1000)
    first.not_before = iso(dueSecond)
    expect(check.matchesWindow(first.not_before)).toBe(true)
    expect(check.matchesWindow(iso(dueSecond + 1))).toBe(true)
    expect(check.matchesWindow(iso(dueSecond + 2))).toBe(false)
    await check.run(); await client.syncNow(true)
    expect(first.state).toBe('waiting')
    expect(f.rows.size).toBe(1)
    const count = f.calls.length
    for (const elapsed of [60, 120, 180]) {
      writeFileSync(file, lines(...turnAt(at), joey(at + 40), req(at + elapsed)))
      clock = at + elapsed + 1
      await monitor().run()
      expect(check.matchesWindow(iso(at + elapsed + 50 * 60))).toBe(false)
    }
    expect(f.calls.length).toBe(count)
    expect(first.state).toBe('waiting')
    const later = at + 900
    clock = at + 1 + 50 * 60
    writeFileSync(file, lines(...turnAt(later)))
    const receiver = new ItemReceiver(mode, new Claims(join(dir, 'claims.json'), client, () => {}, () => {}), () => {}, undefined,
      due => check.matchesWindow(due))
    const stale = await receiver.receive([itemRef(first)])
    expect([...stale.gone]).toEqual([first.id])
    expect(f.calls.some(c => c.path.endsWith('/take'))).toBe(false)
    await check.run()
    await client.syncNow(true)
    const second = [...f.rows.values()].at(-1)!
    expect(first).toMatchObject({ state: 'cancelled', reason: 'withdrawn' })
    expect(second.not_before).toBe(iso(later + 1 + 50 * 60))
    await check.run()
    expect(f.rows.size).toBe(2)
    clock = later + 1 + 60 * 60
    await check.run()
    expect([...f.rows.values()].filter(r => r.state === 'waiting')).toHaveLength(0)
    writeFileSync(file, lines(joey(at), req(at + 24 * 3600), answer(at + 24 * 3600 + 1), end(at + 24 * 3600 + 2)))
    clock = at + 24 * 3600 + 3
    await check.run()
    expect(f.rows.size).toBe(2)
    const raceAt = clock + 60
    const old = f.add('old-warm-window', 'keepwarm', { from: 'adam', session_id: 'main', not_before: iso(clock) })
    clock = raceAt + 15
    writeFileSync(file, lines(...turnAt(raceAt)))
    const request = mode.req
    const peek = spyOn(mode, 'req').mockImplementationOnce(async (...args) => {
      const response = await request(...args)
      writeFileSync(file, lines(...turnAt(raceAt), joey(clock), req(clock + 1)))
      return response
    })
    try { await check.run(); await client.syncNow(true) } finally { peek.mockRestore() }
    expect(old.state).toBe('waiting')
    expect(f.rows.size).toBe(3)
    // Onsen returns the new idle window at whole seconds. C1 can take it at that time.
    writeFileSync(file, lines(...turnAt(raceAt)))
    old.not_before = iso(Math.floor(raceAt + 1 + 50 * 60))
    f.advance(Date.parse(old.not_before) - f.now() + 1)
    clock = f.now() / 1000
    expect((await receiver.receive([itemRef(old)])).given.has(old.id)).toBe(true)
    expect([mail, delivered]).toEqual([0, 0])
  } finally { mode.stop(); f.stop(); client.stop(); rmSync(dir, { recursive: true, force: true }) }
})

describe('decide (keep-warm)', () => {
  const s = (over: any = {}) => ({ ...scan(lines(...turnAt(T0))), ...over })
  test('poke at 50 min, not before, once per idle stretch', () => {
    expect(decide(s(), {}, T0 + 1 + 49 * 60)[0]).toBe('skip')
    expect(decide(s(), {}, T0 + 1 + 51 * 60)[0]).toBe('poke')
    expect(decide(s(), { poked_for: T0 + 1 }, T0 + 1 + 51 * 60)[0]).toBe('skip')
  })
  test('already cold, compacted, walled, 5-minute cache, 24 h, cold stop: noted, not poked', () => {
    expect(decide(s(), {}, T0 + 1 + 61 * 60)[0]).toBe('note')
    expect(decide(s({ compact_after: true }), {}, T0 + 1 + 51 * 60)[0]).toBe('note')
    expect(decide(s({ walled: true }), {}, T0 + 1 + 51 * 60)[0]).toBe('note')
    expect(decide(s({ after_req_usage: { cache_creation: { ephemeral_5m_input_tokens: 5 } } }), {}, T0 + 1 + 51 * 60)[0]).toBe('note')
    const old = s({ last_real: T0 - 25 * 3600 })
    expect(decide(old, { last_real: T0 - 25 * 3600 }, T0 + 1 + 51 * 60)[0]).toBe('note')
    expect(decide(s(), { cold_stop: T0 + 10 }, T0 + 1 + 51 * 60)[0]).toBe('note')
  })
  test('a turn running: skip', () => {
    expect(decide(s({ turn_open: true }), {}, T0 + 1 + 51 * 60)[0]).toBe('skip')
  })
})

describe('decideMail', () => {
  const s = scan(lines(...turnAt(T0)))
  const idle51 = T0 + 1 + 51 * 60
  test('idle with unread mail: remind; with none: hand over to keep-warm', () => {
    expect(decideMail(s, {}, idle51, 2, 600, false)[0]).toBe('remind')
    expect(decideMail(s, {}, idle51, 0, null, false)[0]).toBe('keepwarm')
  })
  test('Joey spoke within the hour: no reminder', () => {
    expect(decideMail(s, {}, idle51, 2, 600, true)[0]).toBe('keepwarm')
  })
  test('busy: one line once mail has waited an hour, at most one an hour', () => {
    const busy = { ...s, turn_open: true }
    expect(decideMail(busy, {}, T0 + 600, 1, 3700, false)[0]).toBe('busy-line')
    expect(decideMail(busy, { busy_line_at: T0 + 300 }, T0 + 600, 1, 3700, false)[0]).toBe('skip')
    expect(decideMail(busy, {}, T0 + 600, 1, 1200, false)[0]).toBe('skip')
  })
  test('a reminder that produced no turn is sent again after an hour', () => {
    const st: KState = { poked_for: T0 + 1, poked_at: idle51, poked_kind: 'mail' }
    expect(decideMail(s, st, idle51 + 1800, 1, 4000, false)[0]).toBe('skip')
    expect(decideMail(s, st, idle51 + 3700, 1, 7000, false)[0]).toBe('remind')
  })
  test('the reminder text names the first step', () => {
    expect(remindText(1, 2400)).toBe('讀信箱（1 封未讀，最舊的等了 40 分鐘）：先用 mailbox_list（mcp__plugin_agent-inbox_agent-inbox__mailbox_list）看清單')
    expect(remindText(3, 7500)).toContain('2 小時 5 分')
  })
})

function rig(opts: { mode?: 'live' | 'dry' | 'off'; mail?: MailCount; recs?: any[]; wall?: () => boolean | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kwl-'))
  const proj = join(dir, 'proj')
  mkdirSync(proj)
  writeFileSync(join(proj, 's.jsonl'), lines(...(opts.recs ?? turnAt(T0))))
  let clock = T0
  let mail: MailCount = opts.mail === undefined ? { on: true, n: 0, oldestS: null } : opts.mail
  const delivered: string[] = []
  const kw = new LocalKeepwarm({
    name: 'mbp', stateDir: dir, mode: () => opts.mode ?? 'live', projectsDir: () => proj,
    mail: async () => mail, deliver: async t => { delivered.push(t); return true }, log: () => {}, now: () => clock,
    wall: opts.wall,
  })
  return { kw, dir, proj, delivered, at: (t: number) => { clock = t }, setMail: (m: MailCount) => { mail = m },
    log: () => { try { return readFileSync(join(dir, 'keepwarm-local.log'), 'utf8') } catch { return '' } } }
}

describe('LocalKeepwarm pass', () => {
  test('off: nothing at all', async () => {
    const r = rig({ mode: 'off' })
    r.at(T0 + 1 + 51 * 60)
    expect(await r.kw.run()).toEqual([])
    expect(r.delivered).toEqual([])
  })
  test('idle 50 min with nothing to read: one keep-warm poke, then nothing for the same stretch', async () => {
    const r = rig()
    r.at(T0 + 1 + 49 * 60)
    await r.kw.run()
    expect(r.delivered).toEqual([])
    r.at(T0 + 1 + 51 * 60)
    await r.kw.run()
    expect(r.delivered).toEqual([POKE_TEXT])
    r.at(T0 + 1 + 52 * 60)
    await r.kw.run()
    expect(r.delivered.length).toBe(1)
    expect(r.log()).toContain('KEEPWARM mbp: idle 51.0m')
  })
  test('idle with unread mail: the 讀信箱 line instead of the poke', async () => {
    // the turn came from a peer, not Joey (Joey within the hour holds reminders back: next test)
    const r = rig({ mail: { on: true, n: 2, oldestS: 1800 }, recs: [chan(T0, 'chiron', '看一下'), req(T0 + 1), answer(T0 + 5), end(T0 + 6)] })
    r.at(T0 + 1 + 51 * 60)
    await r.kw.run()
    expect(r.delivered).toEqual([remindText(2, 1800)])
    expect(r.log()).toContain('REMIND mbp: idle 51.0m; 2 open')
  })
  test('the mailbox query fails: nobody is woken, said once', async () => {
    const r = rig({ mail: null })
    r.at(T0 + 1 + 51 * 60)
    await r.kw.run()
    await r.kw.run()
    expect(r.delivered).toEqual([])
    expect(r.log().match(/MAILBOX-QUERY-FAILED/g)?.length).toBe(1)
    r.setMail({ on: true, n: 0, oldestS: null })
    await r.kw.run()
    expect(r.log()).toContain('MAILBOX-QUERY-OK')
    expect(r.delivered).toEqual([POKE_TEXT])
  })
  test('mailbox not open: keep-warm only', async () => {
    const r = rig({ mail: { on: false, n: 0, oldestS: null } })
    r.at(T0 + 1 + 51 * 60)
    await r.kw.run()
    expect(r.delivered).toEqual([POKE_TEXT])
  })
  test('Joey spoke within the hour: the reminder is held and that is logged', async () => {
    const r = rig({ mail: { on: true, n: 1, oldestS: 600 }, recs: [...turnAt(T0), joey(T0 + 3000)] })
    r.at(T0 + 1 + 51 * 60)
    await r.kw.run()
    expect(r.delivered).not.toContain(remindText(1, 600))
    expect(r.log()).toContain('REMIND-HELD mbp')
  })
  test('dry: logged, not delivered', async () => {
    const r = rig({ mode: 'dry' })
    r.at(T0 + 1 + 51 * 60)
    await r.kw.run()
    expect(r.delivered).toEqual([])
    expect(r.log()).toContain('KEEPWARM-DRY mbp')
  })
  test('no transcript: nothing, no error', async () => {
    const r = rig()
    writeFileSync(join(r.proj, 's.jsonl'), '')
    r.at(T0 + 1 + 51 * 60)
    await r.kw.run()
    expect(r.delivered).toEqual([])
    expect(r.log()).not.toContain('KEEPWARM-ERROR')
  })
})

// WO-120: a fresh usage-wall state decides "walled" instead of the transcript scan.
describe('LocalKeepwarm with the usage-wall state', () => {
  const wallRec = (t: number) => ({ type: 'assistant', timestamp: iso(t), error: 'rate_limit', isApiErrorMessage: true,
    message: { model: '<synthetic>', content: [{ type: 'text', text: 'usage limit reached' }] } })
  test('state walled (the scan sees a normal answer): keep-warm noted, 讀信箱 skipped', async () => {
    const r = rig({ wall: () => true, mail: { on: false, n: 0, oldestS: null } })
    r.at(T0 + 1 + 51 * 60)
    await r.kw.run()
    expect(r.delivered).toEqual([])
    expect(r.log()).toContain('KEEPWARM-SKIP mbp: usage wall')
    const m = rig({ wall: () => true, mail: { on: true, n: 2, oldestS: 1800 }, recs: [chan(T0, 'chiron', '看一下'), req(T0 + 1), answer(T0 + 5), end(T0 + 6)] })
    m.at(T0 + 1 + 51 * 60)
    await m.kw.run()
    expect(m.delivered).toEqual([])
  })
  test('state cleared (the scan still ends on the limit answer): keep-warm goes', async () => {
    const recs = [...turnAt(T0 - 600), joey(T0), req(T0 + 1), wallRec(T0 + 2), end(T0 + 3)]
    const before = rig({ recs })
    before.at(T0 + 1 + 51 * 60)
    await before.kw.run()
    expect(before.delivered).toEqual([])                 // no state: the scan says walled, as before
    const r = rig({ recs, wall: () => false })
    r.at(T0 + 1 + 51 * 60)
    await r.kw.run()
    expect(r.delivered).toEqual([POKE_TEXT])
  })
  test('state unknown (null): the scan decides, as before', async () => {
    const r = rig({ wall: () => null })
    r.at(T0 + 1 + 51 * 60)
    await r.kw.run()
    expect(r.delivered).toEqual([POKE_TEXT])
  })
})
