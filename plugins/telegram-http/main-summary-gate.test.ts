// Universe 002h: lanes-hooks/main-summary-gate.py. When the main took the full activity list in this turn, a reply that leaves
// lane-handled lines of it out is refused once, with the missing lines named. Lookups, complete replies and lists from an
// earlier turn pass. No model, no daemon.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync } from 'fs'
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

function world(): { ws: string; tp: string } {
  const ws = mkdtempSync(join(tmpdir(), 'sumgate-'))
  mkdirSync(join(ws, '.lanes', 'run'), { recursive: true })
  const tp = join(ws, 'main.jsonl')
  writeFileSync(tp, rec({ type: 'system', subtype: 'turn_duration' }) + rec({ type: 'user', message: { content: '今天收工前一次整理給我' } }))
  return { ws, tp }
}
function took(w: { tp: string }, id: string, input: object, result: string): void {
  appendFileSync(w.tp, rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__plugin_telegram-http_telegram-http__ledger_query', input }] } })
    + rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: result }] }] } }))
}
function gate(w: { ws: string; tp: string }, text: string): any {
  const r = Bun.spawnSync([PY, HOOK], { stdin: new TextEncoder().encode(JSON.stringify({ session_id: 's1', transcript_path: w.tp, cwd: w.ws,
    hook_event_name: 'PreToolUse', tool_name: 'mcp__plugin_telegram-http_telegram-http__reply', tool_input: { chat_id: '1', text } })),
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
  appendFileSync(w3.tp, rec({ type: 'system', subtype: 'turn_duration' }) + rec({ type: 'user', message: { content: '另一個問題' } }))
  expect(gate(w3, '好。')).toBeNull()                               // the list belongs to a turn that is over
  expect(gate(world(), '沒有查清單的一般回覆')).toBeNull()
})
