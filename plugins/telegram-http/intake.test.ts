// 1.28.0 — per-delivery intake and the sweep's decision table (liveness.ts).
// Record shapes are the ones claude 2.1.x writes, copied from a live fleet
// transcript on 2026-11-14 (the channel bot's own session: message 7235 became a
// prompt, message 7241 was absorbed in the middle of a turn) with the text cut.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  intakeNeedles, intakeInText, intakeIn, intakeTexts, deliveryVerdict,
  ARRIVE_GRACE_MS, STARTUP_WINDOW_MS, type Intake,
} from './liveness'

const tag = (id: string, extra = '') =>
  `<channel source="plugin:telegram-http:telegram-http" chat_id="1828173984" message_id="${id}" user="Advac777"${extra}>\nhello\n</channel>`
const notif = (id: string) => ({ method: 'notifications/claude/channel', params: { content: 'hello', meta: { chat_id: '1828173984', message_id: id, user: 'Advac777' } } })

const T0 = Date.parse('2026-11-14T06:27:18.000Z')
const at = (ms: number) => new Date(T0 + ms).toISOString()
const enqueue = (id: string, ms: number, extra = '') => ({ type: 'queue-operation', operation: 'enqueue', timestamp: at(ms), content: tag(id, extra) })
const absorbed = (id: string, ms: number) => ({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', timestamp: at(ms), content: tag(id) })
const queuedCommand = (id: string, ms: number) => ({ type: 'attachment', timestamp: at(ms), attachment: { type: 'queued_command', prompt: tag(id) } })
const prompt = (id: string, ms: number, extra = '') => ({ type: 'user', isMeta: true, timestamp: at(ms), message: { role: 'user', content: tag(id, extra) } })
const assistant = (ms: number) => ({ type: 'assistant', timestamp: at(ms), message: { model: 'claude-fable-5-2', content: [{ type: 'tool_use', name: 'Bash' }] } })
const text = (...recs: object[]) => recs.map(r => JSON.stringify(r)).join('\n') + '\n'
const needles = (id: string) => intakeNeedles(notif(id))!

// ── recognising a notification ──────────────────────────────────────────────
test('needles: telegram message = message_id + chat_id, each with its leading space', () => {
  expect(needles('7241')).toEqual([' message_id=\\"7241\\"', ' chat_id=\\"1828173984\\"'])
})
test('needles: mesh message = btcc_msg_id; scheduler wake-up = its run tag; nothing to go by = null', () => {
  expect(intakeNeedles({ params: { content: 'x', meta: { btcc_msg_id: '9371', user: 'pheme' } } })).toEqual([' btcc_msg_id=\\"9371\\"'])
  expect(intakeNeedles({ params: { content: '[scheduled][daily-report][run:5875] do the thing', meta: {} } })).toEqual(['[run:5875]'])
  expect(intakeNeedles({ params: { content: 'plain', meta: { user: 'x' } } })).toBeNull()
  expect(intakeNeedles({ params: undefined })).toBeNull()
})

test('002j: a delivery with no id of its own is recognised by the daemon\'s did', () => {
  const sys = { params: { content: '〔系統通知〕', meta: { user: 'lanes', kind: 'resume', did: 'm1abc-1' } } }
  expect(intakeNeedles(sys)).toEqual([' did=\\"m1abc-1\\"'])
  const tagged = '<channel source="plugin:telegram-http:telegram-http" user="lanes" kind="resume" did="m1abc-1">\n〔系統通知〕\n</channel>'
  const t = text({ type: 'queue-operation', operation: 'enqueue', timestamp: at(0), content: tagged }, { type: 'user', isMeta: true, timestamp: at(30), message: { role: 'user', content: tagged } })
  expect(intakeInText(t, intakeNeedles(sys)!, T0)).toMatchObject({ taken: true, queued: false })
  // a real id wins over did
  expect(intakeNeedles({ params: { content: 'x', meta: { message_id: '9', chat_id: '1', did: 'zz' } } })).toEqual([' message_id=\\"9\\"', ' chat_id=\\"1\\"'])
})

// ── what became of it ───────────────────────────────────────────────────────
test('became a prompt (enqueue + user record) = taken', () => {
  expect(intakeInText(text(enqueue('7235', 0), prompt('7235', 40)), needles('7235'), T0)).toMatchObject({ taken: true, queued: false })
})
test('absorbed mid-turn (enqueue + remove absorbed_mid_turn + queued_command attachment) = taken', () => {
  const t = text(enqueue('7241', 85), absorbed('7241', 2949), queuedCommand('7241', 84))
  expect(intakeInText(t, needles('7241'), T0)).toMatchObject({ taken: true, queued: false })
})
test('only the enqueue, while the turn keeps writing assistant records = queued, NOT taken', () => {
  // the 002g loss: the old rule read these assistant records as consumption
  const t = text(enqueue('7300', 0), assistant(4000), assistant(9000))
  expect(intakeInText(t, needles('7300'), T0)).toMatchObject({ taken: false, queued: true, takenAt: 0 })
})
test('no record at all = neither', () => {
  expect(intakeInText(text(assistant(1000)), needles('7300'), T0)).toMatchObject({ taken: false, queued: false, takenAt: 0 })
})
test('a later message that REPLIES to this one is not this one', () => {
  // reply_to_message_id="7300" contains message_id="7300" — the leading space tells them apart
  const t = text(enqueue('7300', 0), prompt('7301', 60_000, ' reply_to_message_id="7300"'))
  expect(intakeInText(t, needles('7300'), T0)).toMatchObject({ taken: false, queued: true, takenAt: 0 })
})
test('a tool result that prints the same tag is not the message being read', () => {
  const toolResult = { type: 'user', timestamp: at(30_000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: tag('7300') }] } }
  expect(intakeInText(text(enqueue('7300', 0), toolResult), needles('7300'), T0)).toMatchObject({ taken: false, queued: true, takenAt: 0 })
  // a prompt delivered as text blocks still counts
  const blocks = { type: 'user', timestamp: at(40), message: { role: 'user', content: [{ type: 'text', text: tag('7300') }] } }
  expect(intakeInText(text(enqueue('7300', 0), blocks), needles('7300'), T0)).toMatchObject({ taken: true, queued: false })
})
test('same message_id in another chat is not this one', () => {
  const other = { type: 'user', timestamp: at(50), message: { role: 'user', content: tag('7300').replace('1828173984', '-100777') } }
  expect(intakeInText(text(other), needles('7300'), T0)).toMatchObject({ taken: false, queued: false, takenAt: 0 })
})
test('records from before this delivery do not count (an earlier attempt, in a process that died)', () => {
  const t = text(enqueue('7300', -120_000), prompt('7300', -119_000))
  expect(intakeInText(t, needles('7300'), T0)).toMatchObject({ taken: false, queued: false, takenAt: 0 })
  // second delivery of the same message: only its own records count
  const t2 = text(enqueue('7300', -120_000), enqueue('7300', 50))
  expect(intakeInText(t2, needles('7300'), T0)).toMatchObject({ taken: false, queued: true, takenAt: 0 })
})
test('a torn or foreign line never throws', () => {
  const t = '{"type":"user","timestamp":"' + at(10) + '","message":{"content":"' + ' message_id=\\"7300\\" chat_id=\\"1828173984\\"' + '\n' + 'not json message_id=\\"7300\\" chat_id=\\"1828173984\\"\n'
  expect(intakeInText(t, needles('7300'), T0)).toMatchObject({ taken: false, queued: false, takenAt: 0 })
})

// ── files ───────────────────────────────────────────────────────────────────
function dir(files: Record<string, { recs: object[]; mtime: number }>): string {
  const d = mkdtempSync(join(tmpdir(), 'intake-'))
  for (const [name, f] of Object.entries(files)) {
    const p = join(d, name)
    writeFileSync(p, text(...f.recs))
    utimesSync(p, f.mtime / 1000, f.mtime / 1000)
  }
  return d
}
test('intakeIn reads the newest transcript', () => {
  const d = dir({ 'a.jsonl': { recs: [enqueue('7241', 85), absorbed('7241', 2949)], mtime: T0 + 3000 } })
  expect(intakeIn(d, notif('7241'), T0)).toMatchObject({ taken: true, queued: false })
})
test('the session changed after the delivery: the previous transcript still counts', () => {
  const d = dir({
    'old.jsonl': { recs: [enqueue('7241', 85), prompt('7241', 120)], mtime: T0 + 5000 },
    'new.jsonl': { recs: [assistant(60_000)], mtime: T0 + 60_000 },
  })
  expect(intakeIn(d, notif('7241'), T0)).toMatchObject({ taken: true, queued: false })
})
test('a transcript last written before the delivery is not read', () => {
  const d = dir({
    'old.jsonl': { recs: [prompt('7241', 0)], mtime: T0 - 600_000 },
    'new.jsonl': { recs: [assistant(1000)], mtime: T0 + 1000 },
  })
  expect(intakeTexts(d, T0).length).toBe(1)
})
test('cannot tell = null: no key, or no transcript', () => {
  const d = dir({ 'a.jsonl': { recs: [assistant(10)], mtime: T0 + 10 } })
  expect(intakeIn(d, { params: { content: 'plain', meta: {} } }, T0)).toBeNull()
  expect(intakeIn(join(d, 'missing'), notif('1'), T0)).toBeNull()
})

// ── the decision table ──────────────────────────────────────────────────────
const base = { holderAlive: true as boolean | null, ageMs: 40_000, sinceOpenMs: 600_000 as number | null, regiven: false, retainMs: 1_800_000, newestAssistantAt: T0 + 9000 }
const TAKEN: Intake = { taken: true, queued: false, takenAt: T0 + 3000 }, QUEUED: Intake = { taken: false, queued: true, takenAt: 0 }, NONE: Intake = { taken: false, queued: false, takenAt: 0 }

test('cannot tell → old rule', () => { expect(deliveryVerdict({ ...base, intake: null })).toBe('old-rule') })
test('taken, and a genuine assistant record after that → consumed, whatever else is true', () => {
  expect(deliveryVerdict({ ...base, intake: TAKEN })).toBe('consumed')
  expect(deliveryVerdict({ ...base, intake: TAKEN, holderAlive: false, regiven: true })).toBe('consumed')
})
test('taken, but no genuine answer since → unanswered, NOT consumed (the usage-limit wall)', () => {
  // Plutus 2026-11-04: every hourly wake-up became a prompt and was answered by a synthetic API-error record.
  // newestGenuineAssistantAtIn skips that record, so the newest genuine one is from before the message.
  expect(deliveryVerdict({ ...base, intake: TAKEN, newestAssistantAt: T0 - 60_000 })).toBe('unanswered')
  expect(deliveryVerdict({ ...base, intake: TAKEN, newestAssistantAt: 0 })).toBe('unanswered')
  // an assistant record written while the message was still queued is not an answer to it
  expect(deliveryVerdict({ ...base, intake: TAKEN, newestAssistantAt: TAKEN.takenAt - 1 })).toBe('unanswered')
})
test('taken, never answered, and that process died → give it again (the lab control run, 2026-11-14)', () => {
  // absorbed mid-turn at T; the assistant records are all from before T; the process was killed 11 s later
  const cut = { ...base, intake: TAKEN, newestAssistantAt: TAKEN.takenAt - 552, holderAlive: false as boolean | null }
  expect(deliveryVerdict(cut)).toBe('regive')
  expect(deliveryVerdict({ ...cut, regiven: true })).toBe('wait')
  expect(deliveryVerdict({ ...cut, holderAlive: true })).toBe('unanswered')
  expect(deliveryVerdict({ ...cut, holderAlive: null })).toBe('unanswered')
})
test('takenAt is when the model got it: the prompt record, or the absorbed_mid_turn record (not the enqueue)', () => {
  expect(intakeInText(text(enqueue('7235', 0), prompt('7235', 40)), needles('7235'), T0).takenAt).toBe(T0 + 40)
  expect(intakeInText(text(enqueue('7241', 85), absorbed('7241', 2949), queuedCommand('7241', 84)), needles('7241'), T0).takenAt).toBe(T0 + 2949)
})
test('queued in a live client → wait (the old rule would have acked it)', () => {
  expect(deliveryVerdict({ ...base, intake: QUEUED })).toBe('wait')
  expect(deliveryVerdict({ ...base, intake: QUEUED, holderAlive: null })).toBe('wait')
})
test('queued, and the client process is gone → give it again', () => {
  expect(deliveryVerdict({ ...base, intake: QUEUED, holderAlive: false })).toBe('regive')
})
test('no trace, and the client process is gone → give it again', () => {
  expect(deliveryVerdict({ ...base, intake: NONE, holderAlive: false })).toBe('regive')
})
test('given again already → wait: the old rule may never retract the parked copy', () => {
  expect(deliveryVerdict({ ...base, intake: QUEUED, holderAlive: false, regiven: true })).toBe('wait')
  expect(deliveryVerdict({ ...base, intake: NONE, holderAlive: false, regiven: true, ageMs: 3_600_000 })).toBe('wait')
})
test('queued in a live client longer than retain → old rule (never worse than before)', () => {
  expect(deliveryVerdict({ ...base, intake: QUEUED, ageMs: 1_800_001 })).toBe('old-rule')
})
test('no trace, written into a starting client: give it again once the arrive grace has passed', () => {
  const starting = { ...base, intake: NONE, sinceOpenMs: 50 }
  expect(deliveryVerdict({ ...starting, ageMs: ARRIVE_GRACE_MS - 1 })).toBe('old-rule')
  expect(deliveryVerdict({ ...starting, ageMs: ARRIVE_GRACE_MS + 1 })).toBe('regive')
  expect(deliveryVerdict({ ...starting, ageMs: ARRIVE_GRACE_MS + 1, regiven: true })).toBe('wait')
})
test('no trace in a client that has been open for a while → old rule (not enough to act on)', () => {
  expect(deliveryVerdict({ ...base, intake: NONE, sinceOpenMs: STARTUP_WINDOW_MS + 1 })).toBe('old-rule')
  expect(deliveryVerdict({ ...base, intake: NONE, sinceOpenMs: null })).toBe('old-rule')
})
