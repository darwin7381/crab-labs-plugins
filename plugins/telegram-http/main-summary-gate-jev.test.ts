// Universe 002j: the day-summary check with Jev (lanes-hooks/main-summary-gate.py, SUMMARY_GATE_JEV=1).
// The HH:MM test stays the program's first pass; Jev reads each lane-handled line against the reply. Local stand-in for Jev.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const HOOK = join(import.meta.dir, 'lanes-hooks', 'main-summary-gate.py')
let server: any, calls: any[] = [], answer: (entry: string) => [string, number] = () => ['stated', 0.95], fail = false
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const body = await req.json() as any
    calls.push(body)
    if (fail) return new Response('<html>blocked</html>', { status: 403 })
    const answers: Record<string, unknown> = {}
    for (const [k, q] of Object.entries<any>(body.questions)) { const [c, conf] = answer(q.instructions.entry); answers[k] = { type: 'choice', choice: c, confidence: conf } }
    return Response.json({ model: 'jev-1.14.0', answers })
  } })
})
afterAll(() => server.stop(true))

const rec = (o: object) => JSON.stringify(o) + '\n'
const LIST = '活動清單（今天）\n• 11-13 10:03｜adam.reflex.1｜發生：Eve 問維護時段｜回覆每週三 02:00–03:00\n• 11-13 12:55｜adam.reflex.4｜發生：備份連續失敗 A-1103｜重跑一次仍 403，已升級\n• 11-13 09:00｜main｜事故偵測工具開工'
const transcript = rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__plugin_telegram-http_telegram-http__ledger_query', input: {} }] } })
  + rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: LIST }] } })

async function run(reply: string, env: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'sgate-')); mkdirSync(join(d, '.lanes', 'run'), { recursive: true })
  const tp = join(d, 't.jsonl'); writeFileSync(tp, transcript)
  const p = Bun.spawn(['python3', HOOK], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, LANES_DIR: join(d, '.lanes'), SUMMARY_GATE_JEV: '1', TYPESAFE_BASE_URL: `http://127.0.0.1:${server.port}`, TYPESAFE_API_KEY: 'test-key', ...env } })
  p.stdin.write(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', transcript_path: tp, cwd: d, tool_input: { text: reply } })); p.stdin.end()
  const out = (await new Response(p.stdout).text()).trim(); await p.exited
  const lp = join(d, '.lanes', 'run', 'summary-gate.jsonl')
  return { reason: out ? JSON.parse(out).hookSpecificOutput.permissionDecisionReason as string : null, log: existsSync(lp) ? JSON.parse(readFileSync(lp, 'utf8').trim().split('\n')[0]) : null }
}

test('the line travels in the question, the reply is the state, and the main\'s own line is not asked about', async () => {
  calls = []; fail = false; answer = () => ['stated', 0.95]
  const r = await run('10:03 回了 Eve 維護時段；12:55 備份連續失敗，重跑仍 403，已升級。')
  expect(r.reason).toBeNull(); expect(calls.length).toBe(1)
  expect(Object.keys(calls[0].questions)).toEqual(['I0', 'I1']); expect(calls[0].state).toEqual({ reply: '10:03 回了 Eve 維護時段；12:55 備份連續失敗，重跑仍 403，已升級。' })
  expect(calls[0].questions.I1.instructions.entry).toContain('A-1103')
})

test('an event described without its HH:MM is accepted when Jev says the reply states it', async () => {
  fail = false; answer = () => ['stated', 0.9]
  const r = await run('今天回了 Eve 維護時段是每週三 02:00–03:00；中午備份連續失敗，重跑一次還是 403，已升級。')
  expect(r.reason).toBeNull(); expect(r.log.missing).toEqual([])
})

test('a line the reply does not mention is still refused, and named', async () => {
  fail = false; answer = e => e.includes('A-1103') ? ['not_mentioned', 0.97] : ['stated', 0.9]
  const r = await run('今天回了 Eve 維護時段是每週三 02:00–03:00。')
  expect(r.reason).toContain('1 件沒有出現'); expect(r.reason).toContain('12:55'); expect(r.reason).not.toContain('10:03')
})

test('a line stated with a different fact is named as inconsistent, even though its HH:MM is there', async () => {
  fail = false; answer = e => e.includes('A-1103') ? ['different', 0.92] : ['stated', 0.9]
  const r = await run('10:03 回了 Eve 維護時段；12:55 備份失敗，重跑後成功。')
  expect(r.reason).toContain('1 件你寫的跟清單不一致'); expect(r.reason).toContain('A-1103'); expect(r.reason).not.toContain('沒有出現')
})

test('an unsure answer leaves the HH:MM test standing; a failed call falls back to it entirely', async () => {
  fail = false; answer = () => ['stated', 0.4]                       // not confident enough to accept a line with no time
  let r = await run('今天回了 Eve，也處理了備份。'); expect(r.reason).toContain('2 件沒有出現')
  fail = true
  r = await run('今天回了 Eve，也處理了備份。'); expect(r.reason).toContain('2 件沒有出現'); expect(r.log.jev).toBe(false)
  r = await run('10:03 回了 Eve；12:55 備份失敗已升級。'); expect(r.reason).toBeNull()
})
