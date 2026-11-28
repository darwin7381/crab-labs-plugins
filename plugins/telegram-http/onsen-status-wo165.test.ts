// WO-165 B (Chiron; Joey TG chiron:2423 「狀態同步要多久？顆粒度如何等都要確保延遲不要太誇張影響使用或造成誤判」; status-latency-lab.md 「會判錯的」 9): `seen`
// is the moment Joey's message enters a turn, not the moment it is handed to the session. Chiron's lab: a message waited 13–17 s in Claude Code's queue
// while /pending's unseen was already empty. The hand-over moment is its own fact, in_session.
//   lanes off  in_session: the notification written into the main's stream; seen: the transcript shows it taken in. Claude Code 2.1.3xx writes, for a
//              message that arrives while the main is idle, queue-operation enqueue → dequeue → the user record (seen = that record's time); for one
//              that arrives mid-turn, enqueue … queue-operation remove (absorbed_mid_turn) at the next tool boundary, then an attachment
//              queued_command whose timestamp is the ENQUEUE time (seen = the newest own timestamp before it, not the attachment's)
//   lanes on   in_session: M1 offered it (or bound it at a boundary: a pull hands it over and binds it at once); seen: M1 bound it (onsen-step3 tests)
//   ✍ (ONSEN_REACT_SEEN) goes with seen (DeliveryFacts onSeen: the unit tests; 1.59.0: the daemon draws no ✍ on Telegram, the bridge does from the
//   receipt); a transcript tail read again at start writes seen (Onsen keeps the first) without ✍.
// Unit tests, the spool against an Onsen that does not list in_session yet, then a real daemon (server.ts, lanes off; a connector: Joey's messages come
// as the bridge hands them over) against a stand-in Onsen, a registry and a transcript the test writes, and an MCP client standing in for the main session.
import { test, expect, describe, afterAll, beforeAll } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { DeliveryFacts, TurnWatch, type JoeyOf } from './onsen-status.ts'
import { type DeliveryFact } from './onsen-client.ts'

const AGENT = 'adam'
const JOEY = 1828
const CHAT = String(JOEY)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const rec = (o: object) => JSON.stringify(o) + '\n'
const tag = (id: number | string) => `<channel source="plugin:telegram-http:telegram-http" chat_id="${CHAT}" message_id="${id}" user="joey" user_id="${CHAT}" ts="2026-11-25T18:00:00.000Z">`
const joeyOf: JoeyOf = m => m && m.user_id === CHAT ? { chat: String(m.chat_id), id: String(m.message_id) } : null
const at = (base: number, s: number) => new Date(base + s * 1000).toISOString()

describe('lanes off: seen from the transcript (Claude Code 2.1.3xx shapes)', () => {
  test('mid-turn: written into the stream = in_session only; absorbed at the tool boundary = seen at the remove, not at the attachment\'s enqueue time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wo165-tx-'))
    const f = join(dir, `${randomUUID()}.jsonl`)
    const T0 = Date.now() - 120_000                                                  // the turn began 2 min ago (inside the 10 min floor)
    writeFileSync(f, rec({ type: 'system', subtype: 'turn_duration', timestamp: at(T0, -5) }))
    const out: DeliveryFact[] = [], reacted: string[] = []
    const F = new DeliveryFacts({ agent: AGENT, sink: x => out.push(x), onSeen: (c, id, by) => reacted.push(`${c}:${id}:${by}`) })
    const W = new TurnWatch({ dir: () => dir, facts: F, joey: joeyOf, changed: () => {}, now: () => T0 - 1_000 })   // this watch began before the turn
    W.tick()
    // Joey's first message, the main idle: enqueue → dequeue → the user record starts the turn; then a 60 s Bash
    F.delivered(CHAT, 1); F.inSession(CHAT, 1, 'main')
    appendFileSync(f, rec({ type: 'queue-operation', operation: 'enqueue', timestamp: at(T0, 0), content: `${tag(1)}\n開始\n</channel>` }))
    appendFileSync(f, rec({ type: 'queue-operation', operation: 'dequeue', timestamp: at(T0, 0.02) }))
    appendFileSync(f, rec({ type: 'user', isMeta: true, promptId: 'p1', origin: { kind: 'channel' }, message: { role: 'user', content: `${tag(1)}\n開始\n</channel>` }, timestamp: at(T0, 0.04) }))
    appendFileSync(f, rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'x', timeout: 120000 } }] }, timestamp: at(T0, 1) }))
    W.tick()
    expect(out.filter(x => x.state === 'seen').map(x => [x.client_msg_id, x.at])).toEqual([['1', at(T0, 0.04)]])   // the prompt's own record
    expect(reacted).toEqual([`${CHAT}:1:main`])
    // two more while the Bash runs: handed to the session (Claude Code queues them); in_session, not seen, no ✍; queued 2
    for (const [id, s] of [[2, 10], [3, 11]] as const) {
      F.delivered(CHAT, id); F.inSession(CHAT, id, 'main', at(T0, s))
      appendFileSync(f, rec({ type: 'queue-operation', operation: 'enqueue', timestamp: at(T0, s), content: `${tag(id)}\n第 ${id} 則\n</channel>` }))
    }
    W.tick()
    expect(out.filter(x => x.state === 'in_session').map(x => [x.client_msg_id, x.by])).toEqual([['1', 'main'], ['2', 'main'], ['3', 'main']])
    expect(out.filter(x => x.state === 'seen').map(x => x.client_msg_id)).toEqual(['1'])
    expect(F.queued('seen')).toBe(2)
    expect(reacted.length).toBe(1)
    // the Bash ends at 61 s; at that boundary Claude Code absorbs both (remove … then the attachments, timestamped with their enqueue time)
    appendFileSync(f, rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'done' }] }, timestamp: at(T0, 61) }))
    appendFileSync(f, rec({ type: 'attachment', attachment: { type: 'prompt_snapshot' }, timestamp: at(T0, 61.001) }))
    for (const id of [2, 3]) appendFileSync(f, rec({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', deliveryId: `d${id}`, timestamp: at(T0, 61.1), content: `${tag(id)}\n</channel>` }))
    appendFileSync(f, rec({ type: 'api-request-shape' }))                             // no timestamp of its own: not a clock
    for (const [id, s] of [[2, 10], [3, 11]] as const) {
      appendFileSync(f, rec({ type: 'attachment', attachment: { type: 'queued_command', prompt: `${tag(id)}\n第 ${id} 則\n</channel>`, delivery_id: `d${id}`, timestamp: at(T0, s) }, timestamp: at(T0, s) }))
    }
    W.tick()
    const seen = out.filter(x => x.state === 'seen')
    expect(seen.map(x => [x.client_msg_id, x.at])).toEqual([['1', at(T0, 0.04)], ['2', at(T0, 61.1)], ['3', at(T0, 61.1)]])
    for (const x of seen.slice(1)) expect(Date.parse(x.at)).toBeGreaterThanOrEqual(Date.parse(at(T0, 61)))   // ≥ the boundary that took them in
    expect(F.queued('seen')).toBe(0)
    expect(reacted).toEqual([`${CHAT}:1:main`, `${CHAT}:2:main`, `${CHAT}:3:main`])
    // the turn ends: turn_end for all three
    appendFileSync(f, rec({ type: 'system', subtype: 'turn_duration', durationMs: 70_000, timestamp: at(T0, 70) }))
    W.tick()
    expect(out.filter(x => x.state === 'turn_end').map(x => x.client_msg_id)).toEqual(['1', '2', '3'])
    // the order of each message's facts, as the spool sends them
    for (const id of ['2', '3']) expect(out.filter(x => x.client_msg_id === id).map(x => x.state)).toEqual(['delivered', 'in_session', 'seen', 'turn_end'])
  })

  test('in_session never calls onSeen (the ✍ waits for the turn); seen does, once per message in the reactor', () => {
    const calls: string[] = []
    const F = new DeliveryFacts({ agent: AGENT, sink: () => {}, onSeen: (c, id, by) => calls.push(`${id}:${by}`) })
    F.album(CHAT, ['7', '8'])
    F.delivered(CHAT, 7); F.delivered(CHAT, 8)
    F.inSession(CHAT, 7, 'main')
    expect(calls).toEqual([])
    F.seen(CHAT, 7, 'main')
    expect(calls).toEqual(['7:main', '8:main'])
    F.seen(CHAT, 9, 'main', undefined, true)                                           // quiet: the fact only
    expect(calls).toEqual(['7:main', '8:main'])
  })

  test('a transcript read again at start: a message taken in before this daemon began is seen again (Onsen keeps the first), without ✍; one older than 10 min not at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wo165-tail-'))
    const f = join(dir, `${randomUUID()}.jsonl`)
    const now = Date.now()
    writeFileSync(f, rec({ type: 'user', message: { content: `${tag(40)}\n很久以前\n</channel>` }, timestamp: at(now, -3600) })
      + rec({ type: 'system', subtype: 'turn_duration', timestamp: at(now, -3590) })
      + rec({ type: 'user', message: { content: `${tag(41)}\n剛才（上一個 daemon）\n</channel>` }, timestamp: at(now, -30) }))
    const out: DeliveryFact[] = [], reacted: string[] = []
    const F = new DeliveryFacts({ agent: AGENT, sink: x => out.push(x), onSeen: (_c, id) => reacted.push(id) })
    const W = new TurnWatch({ dir: () => dir, facts: F, joey: joeyOf, changed: () => {} })
    W.tick()
    expect(out.map(x => `${x.client_msg_id}:${x.state}:${x.at}`)).toEqual([`41:seen:${at(now, -30)}`])
    expect(reacted).toEqual([])
    // the same turn takes another one in after this daemon began: ✍
    appendFileSync(f, rec({ type: 'attachment', attachment: { type: 'queued_command', prompt: `${tag(42)}\n新的\n</channel>` }, timestamp: at(now, 1) }))
    W.tick()
    expect(out.map(x => `${x.client_msg_id}:${x.state}`)).toEqual(['41:seen', '42:seen'])
    expect(reacted).toEqual(['42'])
  })
})

describe('lanes off: the transcript read follows the main\'s session (the registry\'s session id)', () => {
  test('a new session\'s file is read the moment it exists (not at the next 10 s rescan); while it is read, a newer file of another session does not take over', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wo165-sid-'))
    let t = Date.now(), sid: string | null = 'old-session'
    writeFileSync(join(dir, 'old-session.jsonl'), rec({ type: 'system', subtype: 'turn_duration', timestamp: at(t, -60) }))
    const out: DeliveryFact[] = []
    const F = new DeliveryFacts({ agent: AGENT, sink: x => out.push(x) })
    const W = new TurnWatch({ dir: () => dir, facts: F, joey: joeyOf, changed: () => {}, now: () => t, session: () => sid })
    W.tick()
    expect(W.watching()).toBe(join(dir, 'old-session.jsonl'))
    // /clear or a restart: the registry names a new session; its file appears with Joey's message as its first prompt, 1 s later (no rescan due)
    sid = 'new-session'; t += 1_000
    W.tick()
    expect(W.watching()).toBe(join(dir, 'old-session.jsonl'))                       // not there yet: the file it has
    writeFileSync(join(dir, 'new-session.jsonl'), rec({ type: 'user', message: { content: `${tag(60)}\n第一則\n</channel>` }, timestamp: at(t, 0) }))
    t += 250
    W.tick()
    expect(W.watching()).toBe(join(dir, 'new-session.jsonl'))
    expect(out.map(x => `${x.client_msg_id}:${x.state}`)).toEqual(['60:seen'])
    // another claude in the same folder (a `claude -p`) writes a newer file: the main's file stays the one read, rescan or not
    writeFileSync(join(dir, 'other.jsonl'), rec({ type: 'user', message: { content: `${tag(61)}\n不是主線\n</channel>` }, timestamp: at(t, 1) }))
    t += 20_000
    W.tick()
    expect(W.watching()).toBe(join(dir, 'new-session.jsonl'))
    expect(out.map(x => x.client_msg_id)).toEqual(['60'])
    // no session id known (no registration): the newest file, as before
    sid = null; t += 20_000
    W.tick()
    expect(W.watching()).toBe(join(dir, 'other.jsonl'))
  })
})
