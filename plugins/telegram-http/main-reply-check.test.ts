// Universe 002k (C16): the main's Telegram reply is checked against the main's own tool results of the same turn (the A3 contradiction check applied to the main),
// in the summary gate's hook (lanes-hooks/main-summary-gate.py, PreToolUse on the reply tool). Local stand-in for Jev; no model.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const HOOK = join(import.meta.dir, 'lanes-hooks', 'main-summary-gate.py')
type Verdict = [string, number]
let server: any, calls: any[] = [], failAll = false
let verdict: (sentence: string) => Verdict = () => ['supports', 0.95]
let which: (results: any[]) => Verdict = () => ['R1', 0.9]
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const body = await req.json() as any
    calls.push(body)
    if (failAll) return new Response('<html>blocked</html>', { status: 403 })
    const answers: Record<string, unknown> = {}
    if (body.questions.I0 !== undefined) { for (const k of Object.keys(body.questions)) answers[k] = { type: 'choice', choice: 'not_mentioned', confidence: 0.97 } }      // the summary check's own question
    else if (body.questions.W) { const [c, conf] = which(body.state.tool_results); answers.W = { type: 'choice', choice: c, confidence: conf } }
    else for (const k of Object.keys(body.questions)) {
      const text = body.state.report.find((r: any) => r.id === k).text
      const [c, conf] = verdict(text); answers[k] = { type: 'choice', choice: c, confidence: conf }
    }
    return Response.json({ model: 'jev-1.14.0', answers })
  } })
})
afterAll(() => server.stop(true))

const rec = (o: object) => JSON.stringify(o) + '\n'
const SEND = 'mcp__plugin_agent-inbox_agent-inbox__send_to_agent'
const REPLY = 'mcp__plugin_telegram-http_telegram-http__reply'
const use = (id: string, name: string, input: object) => rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
const res = (id: string, content: string, is_error = false) => rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(is_error ? { is_error: true } : {}) }] } })
const endTurn = (uuid: string) => rec({ type: 'system', subtype: 'turn_duration', uuid })
const BLOCKED = use('t1', SEND, { to: 'eve', text: '10 月可用率下週給你' }) + res('t1', 'send blocked, nothing was sent', true)
const LIST = '活動清單（今天）\n• 11-13 10:03｜adam.reflex.1｜發生：Eve 問維護時段｜回覆每週三 02:00–03:00\n• 11-13 12:55｜adam.reflex.4｜發生：備份連續失敗 A-1103｜重跑一次仍 403，已升級'

function setup(transcript: string) {
  const d = mkdtempSync(join(tmpdir(), 'rcheck-')); mkdirSync(join(d, '.lanes', 'run'), { recursive: true })
  const tp = join(d, 't.jsonl'); writeFileSync(tp, transcript)
  return { d, tp, run: join(d, '.lanes', 'run') }
}
async function gate(s: { d: string; tp: string; run: string }, reply: string, env: Record<string, string> = {}, session = 's1') {
  const p = Bun.spawn(['python3', HOOK], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, LANES_DIR: join(s.d, '.lanes'), SUMMARY_GATE_JEV: '1', TYPESAFE_BASE_URL: `http://127.0.0.1:${server.port}`, TYPESAFE_API_KEY: 'test-key', ...env } })
  p.stdin.write(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: REPLY, session_id: session, transcript_path: s.tp, cwd: s.d, tool_input: { text: reply } })); p.stdin.end()
  const out = (await new Response(p.stdout).text()).trim(); await p.exited
  const o = out ? JSON.parse(out).hookSpecificOutput : null
  return { reason: o ? o.permissionDecisionReason as string : null, decision: o?.permissionDecision as string | undefined, event: o?.hookEventName as string | undefined }
}
const lines = (path: string): any[] => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
const reset = () => { calls = []; failAll = false; verdict = () => ['supports', 0.95]; which = () => ['R1', 0.9] }
const contradict = (needle: string) => (t: string): Verdict => t.includes(needle) ? ['contradicts', 0.93] : ['supports', 0.9]

test('C16: "I replied to Eve" one second after send_to_agent said "send blocked, nothing was sent": sent back once, with that tool result attached', async () => {
  reset(); verdict = contradict('回覆')
  const s = setup(BLOCKED)
  const r = await gate(s, '好，我已回覆 Eve，10 月可用率下週給她。另外 p95 目前正常。')
  expect(r.decision).toBe('deny'); expect(r.event).toBe('PreToolUse')
  expect(r.reason).toContain('我已回覆 Eve'); expect(r.reason).toContain('send blocked, nothing was sent'); expect(r.reason).toContain('send_to_agent')
  expect(r.reason).toContain('ERROR'); expect(r.reason).toContain('沒有成功的就寫沒有成功')
  expect(r.reason).not.toContain('p95 目前正常')                                           // only the contradicted sentence is named
  // the questions: one Choice per claim sentence; the results and the report are the state
  expect(calls.length).toBe(2)
  expect(Object.keys(calls[0].questions)).toEqual(['S1']); expect(Object.keys(calls[0].questions.S1.criteria)).toEqual(['supports', 'contradicts', 'says_nothing'])
  expect(calls[0].state.report).toEqual([{ id: 'S1', text: '好，我已回覆 Eve，10 月可用率下週給她。' }])
  expect(calls[0].state.tool_results[0].call).toContain('send_to_agent'); expect(calls[0].state.tool_results[0].result).toContain('ERROR: send blocked')
  expect(Object.keys(calls[1].questions.W.criteria)).toEqual(['R1', 'none']); expect(calls[1].state.claim).toContain('我已回覆 Eve')
  // the decision and both Jev calls are in the logs
  const l = lines(join(s.run, 'reply-check.jsonl'))
  expect(l.length).toBe(1); expect(l[0]).toMatchObject({ session: 's1', sent_back: true, tool_results: 1 }); expect(l[0].verdicts[0]).toMatchObject({ choice: 'contradicts', conf: 0.93 })
  expect(l[0].attached[0]).toContain('send_to_agent')
  expect(lines(join(s.run, 'jev-calls.jsonl')).map(x => x.site)).toEqual(['reply-check-C16', 'reply-check-C16-which'])
  // once: the same reply again, in the same turn, goes out as written
  const again = await gate(s, '好，我已回覆 Eve，10 月可用率下週給她。', {})
  expect(again.reason).toBeNull()
  expect(calls.length).toBe(2)                                                           // and Jev is not asked again
})

test('C16: a reply that matches its tool results goes out; so does one that says nothing the results address, or a doubtful contradiction', async () => {
  reset()
  const s = setup(use('t1', SEND, { to: 'eve', text: 'x' }) + res('t1', '{"ok":true,"sent":true,"msg_id":"btcc-1"}'))
  expect((await gate(s, '我已回覆 Eve（btcc-1）。')).reason).toBeNull()
  expect(calls.length).toBe(1)
  reset(); verdict = () => ['says_nothing', 0.9]
  expect((await gate(s, '我已經把報表做完了。')).reason).toBeNull()
  reset(); verdict = () => ['contradicts', 0.79]                                       // under 0.8
  expect((await gate(s, '我已回覆 Eve。')).reason).toBeNull()
  expect(calls.length).toBe(1)
  const l = lines(join(s.run, 'reply-check.jsonl'))
  expect(l.map(x => x.sent_back)).toEqual([false, false, false])
})

test('C16: nothing to compare means no Jev call: no claim sentence, no tool result in this turn, only the main\'s own Telegram tools, a result from an earlier turn', async () => {
  reset()
  const s = setup(BLOCKED)
  expect((await gate(s, 'p95 目前正常，備份已經恢復。Eve 問的事我晚點看。')).reason).toBeNull()      // no first-person claim of an action
  expect(calls.length).toBe(0)
  const none = setup(rec({ type: 'user', message: { content: 'Joey：回 Eve' } }))
  expect((await gate(none, '我已回覆 Eve。')).reason).toBeNull(); expect(calls.length).toBe(0)
  const own = setup(use('t1', REPLY, { chat_id: '1', text: '收到' }) + res('t1', 'sent (id: 9)'))
  expect((await gate(own, '我已回覆 Joey。')).reason).toBeNull(); expect(calls.length).toBe(0)       // its own reply is not evidence
  const older = setup(BLOCKED + endTurn('turn-1'))
  expect((await gate(older, '我已回覆 Eve。')).reason).toBeNull(); expect(calls.length).toBe(0)       // that was the turn before
})

test('C16: once per turn: a new turn is checked again, and the check is separate for each session', async () => {
  reset(); verdict = contradict('回覆')
  const s = setup(BLOCKED)
  expect((await gate(s, '我已回覆 Eve。')).decision).toBe('deny')
  expect((await gate(s, '我已回覆 Eve。')).reason).toBeNull()
  expect((await gate(s, '我已回覆 Eve。', {}, 'other-session')).decision).toBe('deny')
  writeFileSync(s.tp, BLOCKED + endTurn('turn-2') + use('t2', SEND, { to: 'cain', text: 'y' }) + res('t2', 'send blocked: cain is on hold', true))
  const r = await gate(s, '我已回覆 Cain 了。')
  expect(r.decision).toBe('deny'); expect(r.reason).toContain('cain is on hold'); expect(r.reason).not.toContain('eve')
})

test('C16: when the narrow question cannot name the result, the turn\'s last results are attached; a failed call, no key or a slow Jev lets the reply go as written', async () => {
  reset(); verdict = contradict('回覆'); which = () => ['none', 0.9]
  const two = BLOCKED + use('t2', 'Bash', { command: 'date' }) + res('t2', 'Fri Nov 13 11:05:00 UTC 2026')
  let r = await gate(setup(two), '我已回覆 Eve。')
  expect(r.decision).toBe('deny'); expect(r.reason).toContain('send blocked, nothing was sent'); expect(r.reason).toContain('Fri Nov 13')
  reset(); failAll = true
  const s = setup(BLOCKED)
  r = await gate(s, '我已回覆 Eve。')
  expect(r.reason).toBeNull()
  const l = lines(join(s.run, 'reply-check.jsonl'))
  expect(l[0].err).toContain('HTTPError'); expect(l[0].sent_back).toBe(false)
  expect(lines(join(s.run, 'jev-calls.jsonl'))[0].err).toContain('HTTPError')
  reset()
  r = await gate(setup(BLOCKED), '我已回覆 Eve。', { TYPESAFE_API_KEY: '', TYPESAFE_KEY_FILE: '/nonexistent' })
  expect(r.reason).toBeNull(); expect(calls.length).toBe(0)
  reset(); verdict = contradict('回覆')
  r = await gate(setup(BLOCKED), '我已回覆 Eve。', { TYPESAFE_BASE_URL: 'http://127.0.0.1:9' })     // nothing listens there
  expect(r.reason).toBeNull()
})

test('C16: the switches: on with SUMMARY_GATE_JEV=1 or MAIN_REPLY_CHECK=1, off with MAIN_REPLY_CHECK=0; the threshold is MAIN_REPLY_CONTRA', async () => {
  reset(); verdict = contradict('回覆')
  expect((await gate(setup(BLOCKED), '我已回覆 Eve。', { MAIN_REPLY_CHECK: '0' })).reason).toBeNull(); expect(calls.length).toBe(0)
  expect((await gate(setup(BLOCKED), '我已回覆 Eve。', { SUMMARY_GATE_JEV: '0' })).reason).toBeNull(); expect(calls.length).toBe(0)
  expect((await gate(setup(BLOCKED), '我已回覆 Eve。', { SUMMARY_GATE_JEV: '0', MAIN_REPLY_CHECK: '1' })).decision).toBe('deny')
  reset(); verdict = () => ['contradicts', 0.85]
  expect((await gate(setup(BLOCKED), '我已回覆 Eve。', { MAIN_REPLY_CONTRA: '0.9' })).reason).toBeNull()
  expect((await gate(setup(BLOCKED), '我已回覆 Eve。', { MAIN_REPLY_CONTRA: '0.8' })).decision).toBe('deny')
})

test('C16: the Jev calls of one run share a time budget below the hook\'s own 20 s limit: with none left the reply goes out as written, without a call', async () => {
  reset(); verdict = contradict('回覆')
  const s = setup(BLOCKED)
  const r = await gate(s, '我已回覆 Eve。', { SUMMARY_GATE_BUDGET_S: '1' })
  expect(r.reason).toBeNull(); expect(calls.length).toBe(0)
  expect(lines(join(s.run, 'reply-check.jsonl'))[0].err).toContain('time budget used')
})

test('C16: the summary check still works next to it: contradiction first, then (the next attempt) the missing activity lines, then it goes out', async () => {
  reset(); verdict = contradict('回覆')
  const t = use('t0', 'mcp__plugin_telegram-http_telegram-http__ledger_query', {}) + res('t0', LIST) + BLOCKED
  const s = setup(t)
  const reply = '我已回覆 Eve。今天沒別的事。'
  let r = await gate(s, reply); expect(r.reason).toContain('跟你這一輪自己工具回傳的結果對不上')
  r = await gate(s, reply); expect(r.reason).toContain('這則整理先不送'); expect(r.reason).toContain('10:03')
  r = await gate(s, reply); expect(r.reason).toBeNull()
})

// ---- which sentences are claims
function claims(texts: string[]): string[][] {
  const code = `import importlib.util, json, sys\nspec = importlib.util.spec_from_file_location('g', ${JSON.stringify(HOOK)})\nm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\nprint(json.dumps([m.claim_sentences(t) for t in json.loads(sys.stdin.read())], ensure_ascii=False))`
  const r = Bun.spawnSync(['python3', '-c', code], { stdin: new TextEncoder().encode(JSON.stringify(texts)) })
  return JSON.parse(new TextDecoder().decode(r.stdout))
}
test('C16: a claim sentence is a first-person claim that something was done (Chinese and English); plain status, plans and questions are not', () => {
  const yes = ['我已回覆 Eve', '我已經把工單開好了', '我剛剛重啟了 api-2', '我回了 Eve，說下週給', '我也通知了 Joey', '我們已經處理好了', '我跟 Cain 說過了',
    'I replied to Eve', 'I sent it to Cain.', "I've restarted api-2", 'I have already notified Joey', 'I just forwarded the report', "I'm done with the export", 'I did it']
  const no = ['p95 目前正常', '備份已經恢復', 'Eve 問 10 月可用率', '我晚點看', '要我回覆 Eve 嗎？', '下週三前會給報表', '12:55 備份失敗，已升級', 'Replied: no', 'The export is done', 'Should I reply to Eve?', '好', '收到']
  const out = claims([...yes, ...no])
  yes.forEach((t, i) => expect({ t, n: out[i].length }).toEqual({ t, n: 1 }))
  no.forEach((t, i) => expect({ t, n: out[yes.length + i].length }).toEqual({ t, n: 0 }))
  const many = claims(['我已回覆 Eve。我已通知 Joey！\n我剛重啟了 api。p95 正常。'])[0]
  expect(many).toEqual(['我已回覆 Eve。', '我已通知 Joey！', '我剛重啟了 api。'])
})
