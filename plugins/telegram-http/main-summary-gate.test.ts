// Universe 002h: lanes-hooks/main-summary-gate.py. When the main took the full activity list in this turn, a reply that leaves
// lane-handled lines of it out is refused once, with the missing lines named. Lookups, complete replies and lists from an
// earlier turn pass. No model, no daemon. 002p: the gate reads no transcript; the turn (its calls with their results) comes from the daemon.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'lanes-hooks', 'main-summary-gate.py')
const PY = process.env.LANES_PYTHON ?? 'python3'
const rec = (o: object) => JSON.stringify(o) + '\n'
const LIST = ['活動清單：5 件事，每件一行（舊→新，時間為 UTC+8）。since=- kind=- text=-',
  '• 11-13 10:02｜adam.reflex.1｜發生：backup/status 03:00 那次 failed，upload，HTTP 403。｜做了：查一次，無變化只回執。｜沒有通知 Joey',
  '• 11-13 10:50｜adam.reflex.3｜發生：mock-api health degraded：p95 2400ms。｜做了：10:56 滾動重啟一次，恢復。｜已通知 Joey（靜默）',
  '• 11-13 11:35｜adam.reflex.4｜發生：排程 daily-ticket-digest run 12：昨天新進工單數。｜做了：計數得 31 張。｜已通知 Joey（靜默）',
  '• 11-13 13:40｜分流器｜發生：eve：週五的貼文我排好了（P-201），只是讓你知道。｜沒有通知 Joey',
  '• 11-13 14:26｜main｜發生：send_to_agent → eve：10 月可用率來源不完整。｜沒有通知 Joey',
  '（每一行都是這隻 agent 經手的事。）'].join('\n')

type Turn = { prompt_id: string; started_at: string; prev_started_at: string | null; items: any[]; calls: any[] }
type World = { ws: string; tp: string; turn: Turn }
function world(): World {
  const ws = mkdtempSync(join(tmpdir(), 'sumgate-'))
  mkdirSync(join(ws, '.lanes', 'run'), { recursive: true })
  return { ws, tp: join(ws, 'main.jsonl'), turn: { prompt_id: 'p1', started_at: '2026-11-13T06:00:00.000Z', prev_started_at: null,
    items: [{ id: 'j1', kind: 'joey', content: '今天收工前一次整理給我', user: 'joey' }], calls: [] } }
}
function took(w: World, id: string, input: object, result: string): void {
  w.turn.calls.push({ name: 'mcp__plugin_telegram-http_telegram-http__ledger_query', input, result, error: false })
}
function nextTurn(w: World, joey: string): void {                  // the daemon's next turn: its own prompt_id, none of the earlier turn's calls
  w.turn = { prompt_id: 'p2', started_at: '2026-11-13T07:00:00.000Z', prev_started_at: w.turn.started_at, items: [{ id: 'j2', kind: 'joey', content: joey, user: 'joey' }], calls: [] }
}
function gate(w: World, text: string, extra: object = {}): any {
  const r = Bun.spawnSync([PY, HOOK], { stdin: new TextEncoder().encode(JSON.stringify({ session_id: 's1', transcript_path: w.tp, cwd: w.ws, turn: w.turn,
    hook_event_name: 'PreToolUse', tool_name: 'mcp__plugin_telegram-http_telegram-http__reply', tool_input: { chat_id: '1', text }, ...extra })),
    env: { PATH: process.env.PATH ?? '', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } })
  const out = new TextDecoder().decode(r.stdout).trim()
  return out ? JSON.parse(out) : null
}

test('002h: a day summary that leaves lane-handled events out is refused once, and the missing ones are named', () => {
  const w = world()
  took(w, 'tu1', {}, LIST)
  const partial = '今天：10:50 mock-api 延遲，10:56 重啟後恢復。事故偵測工具完成。'
  const out = gate(w, partial)
  expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  const why = out.hookSpecificOutput.permissionDecisionReason as string
  expect(why).toContain('3 件')
  for (const t of ['10:02', '11:35', '13:40']) expect(why).toContain(t)
  expect(why).not.toContain('10:50')                               // it is in the reply
  expect(why).not.toContain('14:26')                               // the main's own send: it knows that one
  expect(why).toContain('daily-ticket-digest')
  expect(gate(w, partial)).toBeNull()                              // once: the next reply passes, whatever it says
})

test('002h: a complete summary, a lookup and a list from an earlier turn all pass', () => {
  const w = world()
  took(w, 'tu1', {}, LIST)
  expect(gate(w, '10:02 備份 403 無變化；10:50 延遲、重啟；11:35 昨天新進 31 張；13:40 Eve 的貼文 P-201 已排。')).toBeNull()
  const w2 = world()
  took(w2, 'tu1', { text: '403' }, '帳本查詢：符合 2 筆（舊→新，時間為 UTC+8）。\n11-13 10:02｜receipt｜adam.reflex.1｜…')
  expect(gate(w2, '備份是 upload 403。')).toBeNull()                 // a filtered query is a lookup, not a summary
  const w3 = world()
  took(w3, 'tu1', {}, LIST)
  nextTurn(w3, '另一個問題')
  expect(gate(w3, '好。')).toBeNull()                               // the list belongs to a turn that is over
  expect(gate(world(), '沒有查清單的一般回覆')).toBeNull()
})

test('002p: the gate reads no transcript: the decision follows `turn`, and a payload with no `turn` is a no-op', () => {
  const partial = '今天：10:50 mock-api 延遲，10:56 重啟後恢復。'
  const w = world()                                                // the transcript says: this turn took the list (and no turn_duration after it)
  writeFileSync(w.tp, rec({ type: 'system', subtype: 'turn_duration', uuid: 'u0' })
    + rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tuX', name: 'mcp__plugin_telegram-http_telegram-http__ledger_query', input: {} }] } })
    + rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tuX', content: [{ type: 'text', text: LIST }] }] } }))
  expect(gate(w, partial)).toBeNull()                              // turn.calls is empty: nothing to check
  const w2 = world()                                               // the transcript says the list belongs to a finished turn; `turn` says it is this one
  took(w2, 'tu1', {}, LIST)
  writeFileSync(w2.tp, rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tuX', name: 'mcp__plugin_telegram-http_telegram-http__ledger_query', input: {} }] } })
    + rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tuX', content: [{ type: 'text', text: LIST }] }] } })
    + rec({ type: 'system', subtype: 'turn_duration', uuid: 'u9' }))
  expect(gate(w2, partial).hookSpecificOutput.permissionDecision).toBe('deny')
  const w3 = world()                                               // the old standalone registration: no `turn` on stdin = nothing, whatever the transcript holds
  took(w3, 'tu1', {}, LIST)
  writeFileSync(w3.tp, rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tuX', name: 'mcp__plugin_telegram-http_telegram-http__ledger_query', input: {} }] } })
    + rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tuX', content: [{ type: 'text', text: LIST }] }] } }))
  const r = Bun.spawnSync([PY, HOOK], { stdin: new TextEncoder().encode(JSON.stringify({ session_id: 's1', transcript_path: w3.tp, cwd: w3.ws,
    hook_event_name: 'PreToolUse', tool_name: 'mcp__plugin_telegram-http_telegram-http__reply', tool_input: { chat_id: '1', text: partial } })),
    env: { PATH: process.env.PATH ?? '', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } })
  expect(new TextDecoder().decode(r.stdout).trim()).toBe('')
})

test('002p: the once-per-list key is the turn and the call\'s index: a new list in a new turn is checked again', () => {
  const partial = '今天：10:50 mock-api 延遲，10:56 重啟後恢復。'
  const w = world()
  took(w, 'tu1', {}, LIST)
  expect(gate(w, partial).hookSpecificOutput.permissionDecision).toBe('deny')
  expect(gate(w, partial)).toBeNull()
  nextTurn(w, '再整理一次'); took(w, 'tu2', {}, LIST)
  expect(gate(w, partial).hookSpecificOutput.permissionDecision).toBe('deny')
})
