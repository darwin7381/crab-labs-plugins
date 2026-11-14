// Universe 002j: the main's end-of-turn check (lanes-hooks/main-answered-gate.py).
// The hook is run as Claude Code runs it (stdin payload, stdout decision) against fixture transcripts in the record shapes
// claude 2.1.x writes, with a local stand-in for the Jev endpoint. No network, no model.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const HOOK = join(import.meta.dir, 'lanes-hooks', 'main-answered-gate.py')
let server: any, calls: any[] = [], mode: 'missed' | 'answered' | 'fail' | 'html' = 'missed'

beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const body = await req.json() as any
    calls.push(body)
    if (mode === 'fail') return new Response('{"type":"error"}', { status: 500 })
    if (mode === 'html') return new Response('<html><body>Attention Required</body></html>', { status: 403, headers: { 'content-type': 'text/html' } })
    const answers: Record<string, unknown> = {}
    for (const k of Object.keys(body.questions)) {
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

async function run(transcript: string, env: Record<string, string> = {}, dir?: string) {
  const d = dir ?? mkdtempSync(join(tmpdir(), 'gate-'))
  mkdirSync(join(d, '.lanes', 'run'), { recursive: true })
  const tp = join(d, 't.jsonl'); writeFileSync(tp, transcript)
  const p = Bun.spawn(['python3', HOOK], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, LANES_DIR: join(d, '.lanes'), TYPESAFE_BASE_URL: `http://127.0.0.1:${server.port}`, TYPESAFE_API_KEY: 'test-key', ...env } })
  p.stdin.write(JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', transcript_path: tp, cwd: d })); p.stdin.end()
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

test('only the current turn counts: messages before the last end-of-turn record are not checked again', async () => {
  calls = []; mode = 'missed'
  const r = await run(prompt('90', '舊的問題') + absorbed('91', '舊的第二則') + reply('答了', '90') + turnEnd + prompt('100', '開始做報告') + reply('報告做完了'))
  expect(r.out).toBeNull(); expect(calls.length).toBe(0)
})

test('a message marked no_reply, and a system notice, never need a reply', async () => {
  calls = []; mode = 'missed'
  const fyi = `<channel source="plugin:agent-inbox:agent-inbox" user="eve" btcc_msg_id="50007" no_reply="true">\n只是讓你知道\n</channel>`
  const sys = `<channel source="plugin:telegram-http:telegram-http" user="lanes" kind="resume" did="m1-1">\n〔系統通知〕\n</channel>`
  const r = await run(prompt('100', '開始做報告') + rec({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', timestamp: 't', content: fyi })
    + rec({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', timestamp: 't', content: sys }) + reply('報告做完了', '100'))
  expect(r.out).toBeNull(); expect(calls.length).toBe(0)
})
