// Universe 002j: the main's end-of-turn check (lanes-hooks/main-answered-gate.py).
// The aid is run standalone (stdin payload with `lanes_turn`, stdout decision), as main-hook.py calls it at Stop with the items M1 bound to the turn and
// the turn's reply / send_to_agent calls; the fixtures are written in transcript record shapes and converted (asTurn). A local stand-in for Jev.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const HOOK = join(import.meta.dir, 'lanes-hooks', 'main-answered-gate.py')
let server: any, calls: any[] = [], mode: 'missed' | 'answered' | 'fail' | 'html' = 'missed', unsentP = 0.95

beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const body = await req.json() as any
    calls.push(body)
    if (mode === 'fail') return new Response('{"type":"error"}', { status: 500 })
    if (mode === 'html') return new Response('<html><body>Attention Required</body></html>', { status: 403, headers: { 'content-type': 'text/html' } })
    const answers: Record<string, unknown> = {}
    for (const k of Object.keys(body.questions)) {
      if (k === 'unsent') { answers[k] = { type: 'noul', noul: unsentP }; continue }
      const kind = k.split('.')[1]
      const p = mode === 'missed' ? { reply_needed: 0.95, answered: 0.05, deferred: 0.02 }[kind] : { reply_needed: 0.95, answered: 0.93, deferred: 0.02 }[kind]
      answers[k] = { type: 'noul', noul: p }
    }
    return Response.json({ model: 'jev-1.14.0', answers, usage: { input_tokens: 1, output_tokens: 1 } })
  } })
})
afterAll(() => server.stop(true))

const tg = (id: string, text: string) => `<channel source="plugin:telegram-http:telegram-http" chat_id="990000001" message_id="${id}" user="joey_lab" ts="2026-11-14T02:03:02.000Z">\n${text}\n</channel>`
const rec = (o: object) => JSON.stringify(o) + '\n'
const prompt = (id: string, text: string) => rec({ type: 'user', isMeta: true, timestamp: 't', message: { role: 'user', content: tg(id, text) } })
const absorbed = (id: string, text: string) => rec({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', timestamp: 't', content: tg(id, text) })
const reply = (text: string, reply_to?: string) => rec({ type: 'assistant', timestamp: 't', message: { model: 'claude-haiku-5-5', content: [
  { type: 'tool_use', name: 'mcp__plugin_telegram-http_telegram-http__reply', input: { chat_id: '990000001', text, ...(reply_to ? { reply_to } : {}) } }] } })
const turnEnd = rec({ type: 'system', subtype: 'turn_duration' })
/** the turn as main-hook.py hands it to the aid: the items M1 bound to the prompt and the reply / send_to_agent calls of the turn. The fixtures
 *  are written in the record shapes of a transcript (prompt, a message pulled into the turn, a reply); this turns them into those two lists. */
function asTurn(t: string): { items: any[]; outputs: any[] } {
  let items: any[] = [], outputs: any[] = []
  for (const l of t.split('\n').filter(Boolean)) {
    const j = JSON.parse(l)
    if (j.type === 'system' && j.subtype === 'turn_duration') { items = []; outputs = []; continue }
    const content = j.type === 'user' ? String(j.message?.content ?? '') : j.type === 'queue-operation' ? String(j.content ?? '') : ''
    for (const m of content.matchAll(/<channel ([^>]*)>\n?([\s\S]*?)\n?<\/channel>/g)) {
      const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(x => [x[1], x[2]]))
      items.push({ mid: a.message_id || a.btcc_msg_id || a.did, kind: a.message_id ? 'tg' : a.btcc_msg_id ? 'mesh' : 'sys', user: a.user ?? '', no_reply: a.no_reply === 'true',
        system: a.user === 'lanes' || !!a.kind, body: m[2].trim() })
    }
    for (const c of (j.type === 'assistant' ? j.message?.content ?? [] : [])) if (c?.type === 'tool_use' && /(__reply|__send_to_agent)$/.test(c.name) && c.input?.text)
      outputs.push({ to: String(c.input.to ?? (String(c.name).endsWith('__reply') ? 'Joey' : '')), reply_to: String(c.input.reply_to ?? ''), text: String(c.input.text) })
  }
  return { items, outputs }
}

async function run(transcript: string, env: Record<string, string> = {}, dir?: string) {
  const d = dir ?? mkdtempSync(join(tmpdir(), 'gate-'))
  mkdirSync(join(d, '.lanes', 'run'), { recursive: true })
  const tp = join(d, 't.jsonl'); writeFileSync(tp, transcript)
  const p = Bun.spawn(['python3', HOOK], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, LANES_DIR: join(d, '.lanes'), TYPESAFE_BASE_URL: `http://127.0.0.1:${server.port}`, TYPESAFE_API_KEY: 'test-key', ...env } })
  p.stdin.write(JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', transcript_path: tp, cwd: d, lanes_turn: asTurn(transcript) })); p.stdin.end()
  const out = (await new Response(p.stdout).text()).trim(); await p.exited
  const logp = join(d, '.lanes', 'run', 'answered-gate.jsonl')
  return { out: out ? JSON.parse(out) : null, dir: d, log: existsSync(logp) ? readFileSync(logp, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [] }
}

test('a turn that took in one message is not checked, and Jev is not called', async () => {
  calls = []; mode = 'missed'
  const r = await run(prompt('100', '開始做報告') + reply('報告做完了'))
  expect(r.out).toBeNull(); expect(calls.length).toBe(0)
})

test('a second message that an output replies to BY ID is answered in code: no question asked', async () => {
  calls = []; mode = 'missed'
  const r = await run(prompt('100', '開始做報告') + absorbed('101', '發票 4471 付了嗎？') + reply('發票 4471 在 11-02 付了', '101') + reply('報告做完了', '100'))
  expect(r.out).toBeNull(); expect(calls.length).toBe(0)
  expect(r.log[0].messages.map((m: any) => m.verdict)).toEqual(['answered (by id)', 'answered (by id)'])
})

test('a second message nobody answered is listed back to the model, once', async () => {
  calls = []; mode = 'missed'
  const t = prompt('100', '開始做報告') + absorbed('101', '發票 4471 付了嗎？') + reply('報告做完了', '100')
  const r = await run(t)
  expect(r.out.decision).toBe('block'); expect(r.out.reason).toContain('發票 4471 付了嗎'); expect(r.out.reason).toContain('101'); expect(r.out.reason).not.toContain('開始做報告')
  expect(calls.length).toBe(1)
  expect(Object.keys(calls[0].questions).sort()).toEqual(['M1.answered', 'M1.deferred', 'M1.reply_needed'])   // only the message code could not settle
  expect(calls[0].state.messages).toEqual([{ id: 'M1', from: 'joey_lab', text: '發票 4471 付了嗎？' }])
  const again = await run(t, {}, r.dir)                    // the model tries to end the turn again without answering
  expect(again.out).toBeNull()                             // once per message: the gate is a nudge, not a wall
})

test('when Jev says an output does address it, the turn ends', async () => {
  calls = []; mode = 'answered'
  const r = await run(prompt('100', '開始做報告') + absorbed('101', '發票 4471 付了嗎？') + reply('報告做完了；另外發票 4471 已在 11-02 付款', '100'))
  expect(r.out).toBeNull(); expect(r.log[0].messages[1].verdict).toBe('answered')
})

test('a failed call or an HTML block page is an error, never a verdict: the hook says nothing', async () => {
  const t = prompt('100', '開始做報告') + absorbed('101', '發票 4471 付了嗎？') + reply('報告做完了', '100')
  mode = 'fail'; let r = await run(t); expect(r.out).toBeNull(); expect(r.log[0].error).toBeTruthy()
  mode = 'html'; r = await run(t); expect(r.out).toBeNull(); expect(r.log[0].error).toBeTruthy()
  mode = 'missed'; r = await run(t, { TYPESAFE_API_KEY: '', TYPESAFE_KEY_FILE: '/nonexistent' }); expect(r.out).toBeNull(); expect(r.log[0].error).toContain('no key')
})

test('shadow mode records what it would have done and never blocks', async () => {
  calls = []; mode = 'missed'
  const r = await run(prompt('100', '開始做報告') + absorbed('101', '發票 4471 付了嗎？') + reply('報告做完了', '100'), { ANSWERED_GATE_MODE: 'shadow' })
  expect(r.out).toBeNull(); expect(r.log[0].mode).toBe('shadow'); expect(r.log[0].messages[1].verdict).toBe('not_addressed'); expect(r.log[0].blocked).toEqual([])
})

test('a message marked no_reply, and a system notice, never need a reply', async () => {
  calls = []; mode = 'missed'
  const fyi = `<channel source="plugin:agent-inbox:agent-inbox" user="eve" btcc_msg_id="50007" no_reply="true">\n只是讓你知道\n</channel>`
  const sys = `<channel source="plugin:telegram-http:telegram-http" user="lanes" kind="resume" did="m1-1">\n〔系統通知〕\n</channel>`
  const r = await run(prompt('100', '開始做報告') + rec({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', timestamp: 't', content: fyi })
    + rec({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', timestamp: 't', content: sys }) + reply('報告做完了', '100'))
  expect(r.out).toBeNull(); expect(calls.length).toBe(0)
})

// ---- 002r (universe 002q, G02): the turn's last words reached nobody
const call = (name: string, error = false) => ({ name, input: {}, result: error ? 'failed' : 'ok', error })
const REPLY = 'mcp__plugin_telegram-http_telegram-http__reply'
const ACK = '收到，開始一頁一頁抓，抓完回你總數。', FINAL = '5xx 總行數是 194 行，來自 4,769 行存取日誌（1–20 頁，每頁 250 行，第 20 頁 19 行）。'
async function runLast(o: { final?: string; calls?: any[]; outputs?: any[]; items?: any[]; prompt?: string; env?: Record<string, string>; dir?: string; context?: any }) {
  const d = o.dir ?? mkdtempSync(join(tmpdir(), 'gate-'))
  mkdirSync(join(d, '.lanes', 'run'), { recursive: true })
  const p = Bun.spawn(['python3', HOOK], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, LANES_DIR: join(d, '.lanes'), TYPESAFE_BASE_URL: `http://127.0.0.1:${server.port}`, TYPESAFE_API_KEY: 'test-key', ...(o.env ?? {}) } })
  p.stdin.write(JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', cwd: d, last_assistant_message: o.final ?? FINAL, lanes_turn: {
    items: o.items ?? [{ mid: '2003', kind: 'tg', user: 'joey_lab', no_reply: false, system: false, body: '把日誌第 1 頁到第 20 頁一頁一頁抓，數每一頁有幾行 5xx，給我總數。' }],
    outputs: o.outputs ?? [{ to: 'Joey', reply_to: '', text: ACK }],
    turn: { prompt_id: o.prompt ?? 'p1', calls: o.calls ?? [call(REPLY), call('Bash'), call('Bash')] }, ...(o.context ? { context: o.context } : {}) } })); p.stdin.end()
  const out = (await new Response(p.stdout).text()).trim(); await p.exited
  const logp = join(d, '.lanes', 'run', 'answered-gate.jsonl')
  return { out: out ? JSON.parse(out) : null, dir: d, log: existsSync(logp) ? readFileSync(logp, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [] }
}

test('002r G02: an answer written after the last reply, on the main\'s own screen, holds the turn once; the next Stop of that turn ends it', async () => {
  calls = []; mode = 'answered'; unsentP = 0.97
  const r = await runLast({})
  expect(r.out.decision).toBe('block'); expect(r.out.reason).toContain('只出現在你自己的畫面上'); expect(r.out.reason).toContain('reply')
  expect(calls.length).toBe(1); expect(Object.keys(calls[0].questions)).toEqual(['unsent'])     // one message, one question: the per-message check is not asked
  expect(calls[0].state.final_text).toContain('194'); expect(calls[0].state.outputs).toEqual([{ to: 'Joey', text: ACK }])
  expect(calls[0].state.messages[0]).toMatchObject({ from: 'joey_lab' })
  expect(r.log.at(-1)).toMatchObject({ blocked: ['unsent'], unsent: { calls_after: 2, p: 0.97 } })
  const again = await runLast({ dir: r.dir })
  expect(again.out).toBeNull(); expect(calls.length).toBe(1)                                    // once per turn, and Jev is not asked again
  const next = await runLast({ dir: r.dir, prompt: 'p2' })                                      // another turn of the same session is its own
  expect(next.out.decision).toBe('block')
})

test('002r: a recap after the reply (Jev: nothing new), a turn with no call after its last output, a short closing line and a turn with no output are not held', async () => {
  calls = []; mode = 'answered'; unsentP = 0.08
  const recap = await runLast({ final: 'I sent Joey the 24-hour error breakdown on Telegram (message 2008) and logged the open items in notes.', calls: [call('Bash'), call(REPLY), call('Bash')] })
  expect(recap.out).toBeNull(); expect(calls.length).toBe(1); expect(recap.log.at(-1)).toMatchObject({ blocked: [], unsent: { calls_after: 1, p: 0.08 } })
  calls = []; unsentP = 0.97
  expect((await runLast({ calls: [call('Bash'), call(REPLY)] })).out).toBeNull()                 // the reply was the turn's last call
  expect((await runLast({ final: '已回覆。' })).out).toBeNull()                                   // nothing of substance
  expect((await runLast({ outputs: [], calls: [call('Bash')] })).out).toBeNull()                 // no output at all: the owed-line hold's case, not this one
  expect((await runLast({ calls: [call(REPLY, true), call('Bash')], outputs: [] })).out).toBeNull()   // a reply that failed delivered nothing
  expect(calls.length).toBe(0)
})

test('002r: a failed Jev call holds nothing; shadow mode records and never holds; a send_to_agent counts as an output', async () => {
  calls = []; unsentP = 0.97
  mode = 'fail'; let r = await runLast({}); expect(r.out).toBeNull(); expect(r.log.at(-1).error).toBeTruthy()
  mode = 'answered'; r = await runLast({ env: { ANSWERED_GATE_MODE: 'shadow' } }); expect(r.out).toBeNull(); expect(r.log.at(-1)).toMatchObject({ mode: 'shadow', blocked: [], unsent: { p: 0.97 } })
  r = await runLast({ calls: [call(REPLY), call('Bash'), call('mcp__plugin_agent-inbox_agent-inbox__send_to_agent')] }); expect(r.out).toBeNull()   // the send was the last call
})

// 002v (002s r2 G02, u002s-G02-s2-r2-20261119-221622): the main's turn opened by its own background task's notification took in nothing and ended on
// "the total is **194**", never sent. The daemon hands such a turn the work it carries on (`context`: the last turn's items, every output since).
test('002v G02: a turn that took in nothing is asked over the work it carries on; the answer written after a background task, never sent, holds it once', async () => {
  calls = []; mode = 'answered'; unsentP = 0.97
  const ctx = { items: [{ mid: '2003', kind: 'tg', user: 'joey_lab', no_reply: false, system: false, body: '把日誌第 1 頁到第 20 頁一頁一頁抓，數每一頁有幾行 5xx，給我總數。' }],
    outputs: [{ to: 'Joey', reply_to: '', text: ACK }] }
  const r = await runLast({ items: [], outputs: [], context: ctx, calls: [call('Bash')] })
  expect(r.out.decision).toBe('block'); expect(r.out.reason).toContain('只出現在你自己的畫面上')
  expect(calls[0].state.outputs).toEqual([{ to: 'Joey', text: ACK }]); expect(calls[0].state.messages[0]).toMatchObject({ from: 'joey_lab' })
  expect(r.log.at(-1)).toMatchObject({ blocked: ['unsent'], unsent: { carried: true, calls_after: 1, p: 0.97 } })
  expect((await runLast({ items: [], outputs: [], context: ctx, calls: [] })).out.decision).toBe('block')   // no call at all: all of the turn came after the last output
  calls = []; unsentP = 0.08
  expect((await runLast({ items: [], outputs: [], context: ctx, calls: [call('Bash')] })).out).toBeNull(); expect(calls.length).toBe(1)   // Jev: nothing new
  calls = []; unsentP = 0.97
  expect((await runLast({ items: [], outputs: [], calls: [call('Bash')] })).out).toBeNull(); expect(calls.length).toBe(0)    // no work handed: not asked, as before
  expect((await runLast({ items: [], outputs: [], context: { items: [], outputs: [] }, calls: [call('Bash')] })).out).toBeNull(); expect(calls.length).toBe(0)
})
