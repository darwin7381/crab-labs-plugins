// Universe 002n (B06 r1 of 002m): aid (b)'s hold told a scheduled run that had already sent Joey its one message to call ask_joey; L6B3 refused the
// ask (card 「每個排程回合最多一次 notify_joey」), the run handed the matter to the main and wrote a second receipt for the same scheduled run
// (B06 ledger_has receipt count 2; card 「排程回執只送一次」). The hold now tells such a run the way that works: handoff_main, and its receipt is
// already recorded. Other runs keep the 002m text. The hook is run as Claude Code runs it; no model.
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const HOOK = join(import.meta.dir, 'lanes-hooks', 'lane-stop-hook.py')
const rec = (o: object) => JSON.stringify(o) + '\n'
const prompt = (t: string) => rec({ type: 'user', message: { role: 'user', content: t } })
let n = 0
const call = (name: string, input: object, error = false) => {
  const id = `tu-${++n}`
  return rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
    + rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: error ? 'refused' : 'ok', ...(error ? { is_error: true } : {}) }] } })
}
const SCHED = '[車道事件 mesh-50013｜來源 mesh｜寄件者 scheduler（verified=true relay=btcc）｜btcc_msg_id 50013]\n[daily-backup-review run:31] 檢查昨晚的備份。'
const EVE = '[車道事件 mesh-81｜來源 mesh｜寄件者 eve（verified=true relay=direct）｜btcc_msg_id 81]\n可以把 mock-api 的 replicas 調到 4 嗎？'
const LONG = '[daily-backup-review run:31] 昨晚備份成功。\n- 快照 15 份\n- 要不要 prune 請 Joey 決定。'
const ONE = '[daily-backup-review run:31] 昨晚備份成功；快照 15 份，比保留 14 份多 1，未刪除，需要 prune 請 Joey 決定。'
async function hook(transcript: string) {
  const d = mkdtempSync(join(tmpdir(), 'stop-b06-')); const ld = join(d, '.lanes'); mkdirSync(join(ld, 'run'), { recursive: true })
  writeFileSync(join(d, 't.jsonl'), transcript)
  const env: Record<string, string> = { ...process.env as any, LANES_DIR: ld, LANE_ID: 'adam.reflex.7' }
  delete env.TYPESAFE_API_KEY; env.TYPESAFE_KEY_FILE = '/nonexistent'
  const p = Bun.spawn(['python3', HOOK], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env })
  p.stdin.write(JSON.stringify({ transcript_path: join(d, 't.jsonl'), session_id: 's1', cwd: d })); p.stdin.end()
  const out = (await new Response(p.stdout).text()).trim(); await p.exited
  return out ? JSON.parse(out) : null
}

test('B06: a scheduled run that already notified Joey and filed its receipt is told handoff_main (ask_joey would be refused) and not to send another receipt', async () => {
  const r = await hook(prompt(SCHED) + call('mcp__lane__notify_joey', { text: LONG }, true) + call('mcp__lane__receipt', { run_id: '31', outcome: 'done' })
    + call('mcp__lane__notify_joey', { text: ONE }))
  expect(r.decision).toBe('block')
  expect(r.reason).toContain('需要 prune 請 Joey 決定')
  expect(r.reason).toContain('ask_joey will be refused'); expect(r.reason).toContain('call handoff_main')
  expect(r.reason).toContain('do not send another receipt')
  expect(r.reason).not.toContain('call ask_joey (one message; it rings)')
})

test('B06: the same scheduled run before its receipt: handoff_main, no word about the receipt; a scheduled run whose only notice was refused may still ask_joey', async () => {
  const a = await hook(prompt(SCHED) + call('mcp__lane__notify_joey', { text: ONE }))
  expect(a.reason).toContain('call handoff_main'); expect(a.reason).not.toContain('receipt')
  const b = await hook(prompt(SCHED) + call('mcp__lane__notify_joey', { text: ONE }, true))
  expect(b.reason).toContain('call ask_joey (one message; it rings)')
})

test('B06: a run that is not scheduled keeps the 002m text', async () => {
  const r = await hook(prompt(EVE) + call('mcp__lane__reply_agent', { to: 'eve', text: '這個我已請 Joey 決定。' }) + call('mcp__lane__notify_joey', { text: 'Eve 要調 replicas。' }))
  expect(r.decision).toBe('block')
  expect(r.reason).toContain('call ask_joey (one message; it rings)'); expect(r.reason).toContain('send a correction')
})
