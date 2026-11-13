// Universe 002f: lanes-hooks/main-midturn-hook.py. A Telegram message the harness absorbed while the main was mid-turn is
// handed back once through the hook channel (PostToolUse additionalContext; Stop block when no tool call followed).
// Messages that started a turn, mesh messages and anything already handed back are left alone. No model, no daemon.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'lanes-hooks', 'main-midturn-hook.py')
const PY = process.env.LANES_PYTHON ?? 'python3'
const tg = (id: number, text: string) => `<channel source="plugin:telegram-http:telegram-http" chat_id="990000001" message_id="${id}" user="joey_lab" user_id="990000001" ts="2026-11-13T02:31:37.000Z">\n${text}\n</channel>`
const mesh = (text: string) => `<channel source="plugin:agent-inbox:agent-inbox" chat_id="lanes" user="lanes" verified="true" kind="digest">\n${text}\n</channel>`
const rec = (o: object) => JSON.stringify(o) + '\n'

function world(): { ws: string; tp: string } {
  const ws = mkdtempSync(join(tmpdir(), 'midturn-'))
  mkdirSync(join(ws, '.lanes', 'run'), { recursive: true })
  const tp = join(ws, 'main.jsonl')
  writeFileSync(tp, '')
  return { ws, tp }
}
function hook(w: { ws: string; tp: string }, event: 'PostToolUse' | 'Stop', sid = 's1'): any {
  const r = Bun.spawnSync([PY, HOOK], { stdin: new TextEncoder().encode(JSON.stringify({ session_id: sid, transcript_path: w.tp, cwd: w.ws, hook_event_name: event })),
    env: { PATH: process.env.PATH ?? '', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } })
  const out = new TextDecoder().decode(r.stdout).trim()
  return out ? JSON.parse(out) : null
}

test('002f: a Telegram message absorbed mid-turn is handed back once, at the next tool boundary', () => {
  const w = world()
  appendFileSync(w.tp, rec({ type: 'queue-operation', operation: 'enqueue', content: tg(1017, '另外開兩條工作線：備份盤點、工單統計。') }))
  expect(hook(w, 'PostToolUse')).toBeNull()                                 // only queued so far: the harness has not shown it to the model yet
  appendFileSync(w.tp, rec({ type: 'queue-operation', operation: 'remove', content: tg(1017, '另外開兩條工作線：備份盤點、工單統計。'), reason: 'absorbed_mid_turn' }))
  const out = hook(w, 'PostToolUse')
  expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse')
  const ctx = out.hookSpecificOutput.additionalContext as string
  expect(ctx).toContain('另外開兩條工作線：備份盤點、工單統計。')
  expect(ctx).toContain('message_id 1017')
  expect(ctx).toContain('joey_lab')
  expect(ctx).toContain('使用者本人')
  expect(hook(w, 'PostToolUse')).toBeNull()                                 // once
  expect(hook(w, 'Stop')).toBeNull()                                        // and the turn may end
})

test('002f: when no tool call follows, the turn does not end until the message was handed back', () => {
  const w = world()
  appendFileSync(w.tp, rec({ type: 'queue-operation', operation: 'remove', content: tg(1020, '停，先不要重跑備份。'), reason: 'absorbed_mid_turn' }))
  const out = hook(w, 'Stop')
  expect(out.decision).toBe('block')
  expect(out.reason).toContain('停，先不要重跑備份。')
  expect(hook(w, 'Stop')).toBeNull()                                        // blocks once, never loops
})

test('002f: a message that started a turn, a mesh digest and another session\'s record are left alone', () => {
  const w = world()
  appendFileSync(w.tp, rec({ type: 'queue-operation', operation: 'enqueue', content: tg(1003, '開發工作：做事故偵測工具') }))
  appendFileSync(w.tp, rec({ type: 'queue-operation', operation: 'dequeue' }))
  appendFileSync(w.tp, rec({ type: 'user', message: { role: 'user', content: tg(1003, '開發工作：做事故偵測工具') } }))
  appendFileSync(w.tp, rec({ type: 'queue-operation', operation: 'remove', content: mesh('〔車道摘要〕…'), reason: 'absorbed_mid_turn' }))
  expect(hook(w, 'PostToolUse')).toBeNull()
  expect(hook(w, 'Stop')).toBeNull()
  appendFileSync(w.tp, rec({ type: 'queue-operation', operation: 'remove', content: tg(1021, '兩則一起'), reason: 'absorbed_mid_turn' }))
  appendFileSync(w.tp, rec({ type: 'queue-operation', operation: 'remove', content: tg(1022, '第二則'), reason: 'absorbed_mid_turn' }))
  const ctx = hook(w, 'PostToolUse').hookSpecificOutput.additionalContext as string
  expect(ctx).toContain('兩則一起'); expect(ctx).toContain('第二則')           // two at once: one hand-back
  expect(hook(w, 'PostToolUse', 's2')).not.toBeNull()                       // the record is per session
})
