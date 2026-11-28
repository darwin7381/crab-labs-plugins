// Universe 002p: lanes-hooks/main-hook.py hands the model aids the turn the daemon answers (no aid reads a transcript). A tiny local stand-in for the
// daemon's /lanes/main-event: what the hook posts (every tool's input and result at PostToolUse), and what it prints from the daemon's turn
// (the summary gate's deny at the reply's PreToolUse, the memory gate's block at Stop). No model, no network beyond loopback.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const HOOK = join(import.meta.dir, 'lanes-hooks', 'main-hook.py')
const REPLY = 'mcp__plugin_telegram-http_telegram-http__reply'
const LIST = ['活動清單：3 件事，每件一行（舊→新，時間為 UTC+8）。since=- kind=- text=-',
  '• 11-13 10:02｜adam.reflex.1｜發生：backup/status 03:00 那次 failed，upload，HTTP 403。｜做了：查一次，無變化只回執。｜沒有通知 Joey',
  '• 11-13 11:35｜adam.reflex.4｜發生：排程 daily-ticket-digest run 12：昨天新進工單數。｜做了：計數得 31 張。｜已通知 Joey（靜默）',
  '• 11-13 14:26｜main｜發生：send_to_agent → eve：10 月可用率來源不完整。｜沒有通知 Joey'].join('\n')
let server: any, posted: any[] = [], answer: (body: any) => object = () => ({}), auth: string[] = []
const tok = mkdtempSync(join(tmpdir(), 'mhook-tok-'))
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    if (new URL(req.url).pathname !== '/lanes/main-event') return new Response('no', { status: 404 })
    auth.push(req.headers.get('authorization') ?? '')
    const body = await req.json(); posted.push(body)
    return Response.json(answer(body))
  } })
  writeFileSync(join(tok, String(server.port)), 'tok-123\n')
})
afterAll(() => server.stop(true))

function world() {
  const d = mkdtempSync(join(tmpdir(), 'mhook-')); const ld = join(d, '.lanes'); mkdirSync(join(ld, 'run'), { recursive: true })
  writeFileSync(join(d, 't.jsonl'), '')
  return { d, ld }
}
async function hook(w: { d: string; ld: string }, payload: object) {
  const p = Bun.spawn(['python3', HOOK], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', LANES_DIR: w.ld, TELEGRAM_HTTP_PORT: String(server.port), MCP_TOKEN_DIR: tok, TYPESAFE_API_KEY: '', TYPESAFE_KEY_FILE: '/nonexistent', PYTHONDONTWRITEBYTECODE: '1' } })
  p.stdin.write(JSON.stringify({ session_id: 's1', prompt_id: 'p1', transcript_path: join(w.d, 't.jsonl'), cwd: w.d, ...payload })); p.stdin.end()
  const out = (await new Response(p.stdout).text()).trim(); expect(await p.exited).toBe(0)
  return out ? JSON.parse(out) : null
}
const fresh = (a: (body: any) => object = () => ({})) => { posted = []; auth = []; answer = a }

test('a background-task notification identifies its origin without forwarding its output as delivery evidence', async () => {
  const w = world(), notice = '<task-notification>\n<task-id>t1</task-id>\n<result>old did="other"</result>\n</task-notification>'
  fresh()
  await hook(w, { hook_event_name: 'UserPromptSubmit', prompt: notice })
  expect(posted[0]).toMatchObject({ source: 'task-notification', dids: ['other'], channel_dids: [] })
  expect(posted[0]).not.toHaveProperty('prompt')
  fresh()
  await hook(w, { hook_event_name: 'UserPromptSubmit', prompt: '<channel did="real">someone quoted ' + notice + '</channel>' })
  expect(posted[0].source).not.toBe('task-notification')
  expect(posted[0].channel_dids).toEqual(['real'])
})

test('PostToolUse: every tool\'s input (strings cut to 3000) and result (text, cut to 20000) and its error flag go to the daemon', async () => {
  const w = world()
  fresh()
  expect(await hook(w, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'x'.repeat(5000), timeout: 30 },
    tool_response: { content: [{ type: 'text', text: 'part one, ' }, { type: 'text', text: 'part two' }], is_error: true } })).toBeNull()
  expect(posted.length).toBe(1); expect(auth[0]).toBe('Bearer tok-123')
  expect(posted[0]).toMatchObject({ event: 'PostToolUse', session_id: 's1', prompt_id: 'p1', tool_name: 'Bash', tool_response: 'part one, part two', tool_error: true })
  expect(posted[0].tool_input.command.length).toBe(3000); expect(posted[0].tool_input.timeout).toBe(30)
  fresh()
  await hook(w, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/a' }, tool_response: 'y'.repeat(25000) })
  expect(posted[0].tool_response.length).toBe(20000); expect(posted[0].tool_error).toBe(false)
  fresh()
  await hook(w, { hook_event_name: 'PostToolUse', tool_name: 'Glob', tool_input: {}, tool_response: { filenames: ['a', 'b'], numFiles: 2 } })
  expect(JSON.parse(posted[0].tool_response)).toEqual({ filenames: ['a', 'b'], numFiles: 2 }); expect(posted[0].tool_error).toBe(false)
  fresh(() => ({ additionalContext: 'one item reached you' }))                // the reply tool keeps the keys the daemon reads (to, reply_to, text)
  const r = await hook(w, { hook_event_name: 'PostToolUse', tool_name: REPLY, tool_input: { chat_id: '1', reply_to: '9', text: '好' }, tool_response: { content: [{ type: 'text', text: 'sent (id: 10)' }] } })
  expect(posted[0].tool_input).toEqual({ chat_id: '1', reply_to: '9', text: '好' }); expect(posted[0].tool_response).toBe('sent (id: 10)')
  expect(r.hookSpecificOutput).toEqual({ hookEventName: 'PostToolUse', additionalContext: 'one item reached you' })
})

test('PreToolUse of the reply tool: the summary gate runs on the daemon\'s turn; a reply that misses lines of the turn\'s activity list is denied (once)', async () => {
  const w = world()
  const turn = { prompt_id: 'p1', started_at: '2026-11-13T06:00:00.000Z', prev_started_at: '2026-11-13T05:00:00.000Z',
    items: [{ id: 'j1', kind: 'joey', content: '今天整理給我', user: 'joey' }],
    calls: [{ name: 'mcp__plugin_telegram-http_telegram-http__ledger_query', input: {}, result: LIST, error: false }] }
  fresh(() => ({ turn }))
  const r = await hook(w, { hook_event_name: 'PreToolUse', tool_name: REPLY, tool_input: { chat_id: '1', text: '今天 10:02 備份 403。' } })
  expect(posted.length).toBe(1); expect(posted[0]).toMatchObject({ event: 'PreToolUse', tool_name: REPLY })
  expect(r.hookSpecificOutput.hookEventName).toBe('PreToolUse'); expect(r.hookSpecificOutput.permissionDecision).toBe('deny')
  expect(r.hookSpecificOutput.permissionDecisionReason).toContain('11:35'); expect(r.hookSpecificOutput.permissionDecisionReason).not.toContain('10:02')
  expect(await hook(w, { hook_event_name: 'PreToolUse', tool_name: REPLY, tool_input: { chat_id: '1', text: '今天 10:02 備份 403。' } })).toBeNull()
  // not the reply tool, or no turn in the answer: nothing
  fresh(() => ({ turn }))
  expect(await hook(world(), { hook_event_name: 'PreToolUse', tool_name: 'mcp__plugin_telegram-http_telegram-http__react', tool_input: { text: '今天 10:02' } })).toBeNull()
  fresh(() => ({}))
  expect(await hook(world(), { hook_event_name: 'PreToolUse', tool_name: REPLY, tool_input: { chat_id: '1', text: '今天 10:02 備份 403。' } })).toBeNull()
})

test('Stop: the memory gate runs on the daemon\'s proposals and turn; a held turn is not reported final; curator holds nothing', async () => {
  const w = world()
  const turn = { prompt_id: 'p3', started_at: '2026-11-13T02:20:00.000Z', prev_started_at: '2026-11-13T02:10:00.000Z', items: [], calls: [] }
  const proposals = [{ id: 'mp-aaa111', ts: '2026-11-13T02:05:00.000Z', lane: 'adam.worker.1', text: '記住：例行排程一律 09:00。', shown: true }]   // 002v: the main was shown it
  fresh(() => ({ turn, proposals, curator: false }))
  const r = await hook(w, { hook_event_name: 'Stop' })
  expect(r.decision).toBe('block'); expect(r.reason).toContain('mp-aaa111'); expect(r.reason).toContain('memory_decide')
  expect(posted.map(b => b.phase)).toEqual(['check'])                       // held: no 'final'
  fresh(() => ({ turn, proposals, curator: false }))
  expect(await hook(w, { hook_event_name: 'Stop' })).toBeNull()             // once per turn
  expect(posted.map(b => b.phase)).toEqual(['check', 'final'])
  fresh(() => ({ turn, proposals, curator: true }))
  expect(await hook(world(), { hook_event_name: 'Stop' })).toBeNull()
})

// ---- 002r (universe 002q, G02): the whole path of the last-words hold. The hook posts the Stop check, the daemon answers the turn (its items, its
// outputs, its calls), the answered gate reads the Stop payload's last_assistant_message and asks Jev (a local stand-in); a hold is printed and the
// daemon is not told the turn ended.
test('002r G02: Stop with an answer left on the main\'s own screen after its last reply is held once, end to end; the next Stop of the turn ends it', async () => {
  let jevCalls: any[] = []
  const jev = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { const b = await req.json() as any; jevCalls.push(b); return Response.json({ answers: { unsent: { type: 'noul', noul: 0.97 } } }) } })
  try {
    const w = world()
    const run = async () => {
      const p = Bun.spawn(['python3', HOOK], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
        env: { PATH: process.env.PATH ?? '', LANES_DIR: w.ld, TELEGRAM_HTTP_PORT: String(server.port), MCP_TOKEN_DIR: tok, TYPESAFE_API_KEY: 'test-key',
          TYPESAFE_BASE_URL: `http://127.0.0.1:${jev.port}`, PYTHONDONTWRITEBYTECODE: '1' } })
      p.stdin.write(JSON.stringify({ session_id: 's1', prompt_id: 'p1', transcript_path: join(w.d, 't.jsonl'), cwd: w.d, hook_event_name: 'Stop',
        last_assistant_message: '5xx 總行數是 194 行，來自 4,769 行存取日誌（1–20 頁，每頁 250 行，第 20 頁 19 行）。' })); p.stdin.end()
      const out = (await new Response(p.stdout).text()).trim(); expect(await p.exited).toBe(0)
      return out ? JSON.parse(out) : null
    }
    const turn = { prompt_id: 'p1', started_at: null, prev_started_at: null, items: [],
      calls: [{ name: REPLY, input: { text: '收到，抓完回你總數。' }, result: 'sent (id: 2004)', error: false }, { name: 'Bash', input: {}, result: 'page 20 ok', error: false }] }
    fresh(b => b.phase === 'check' ? { items: [{ mid: '2003', kind: 'tg', user: 'joey_lab', no_reply: false, system: false, body: '數每一頁有幾行 5xx，給我總數。' }],
      outputs: [{ to: 'Joey', reply_to: '', text: '收到，抓完回你總數。' }], turn, proposals: [], curator: false } : {})
    const held = await run()
    expect(held.decision).toBe('block'); expect(held.reason).toContain('只出現在你自己的畫面上')
    expect(posted.map(b => b.phase)).toEqual(['check'])                                  // held: the daemon is not told the turn ended
    expect(jevCalls.length).toBe(1); expect(jevCalls[0].state.final_text).toContain('194'); expect(jevCalls[0].state.outputs).toEqual([{ to: 'Joey', text: '收到，抓完回你總數。' }])
    posted = []
    expect(await run()).toBeNull()                                                       // the same turn's next Stop: not asked again, the turn ends
    expect(posted.map(b => b.phase)).toEqual(['check', 'final']); expect(jevCalls.length).toBe(1)
  } finally { jev.stop(true) }
})

test('002r H05, 002w G: a hook event that carries agent_id (a subagent\'s tool call) is posted as sub and prints nothing, whatever the daemon would answer; its Telegram reply is denied', async () => {
  const w = world()
  fresh(() => ({ additionalContext: 'one item reached you', block: 'x', turn: { calls: [] } }))
  expect(await hook(w, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/a' }, tool_response: 'x', agent_id: 'a7730af99049a14de', agent_type: 'general-purpose' })).toBeNull()
  expect((await hook(w, { hook_event_name: 'PreToolUse', tool_name: REPLY, tool_input: { text: 'x' }, agent_id: 'a7730af99049a14de' }))!.hookSpecificOutput.permissionDecision).toBe('deny')   // 002w G: the reply tool is the main's
  expect(posted.length).toBe(2); expect(posted.every(b => b.sub === true && b.session_id === 's1' && b.tool_name === undefined && b.prompt_id === undefined)).toBe(true)
  fresh(() => ({ additionalContext: 'one item reached you' }))                // the same call by the main itself: pulled as before
  expect((await hook(w, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_response: 'x' })).hookSpecificOutput.additionalContext).toBe('one item reached you')
  expect(posted[0].sub).toBeUndefined()
})

// 002v (002s r2 C04, u002s-C04-s2-r2-20261119-215937): the daemon answers a send_to_agent PreToolUse with mark_no_reply (the turn took in a stopped
// conversation's last message and the send goes to that peer): the hook runs the main's own input with no_reply set (updatedInput replaces the whole
// input). The daemon is told only who it goes to and whether no_reply is set; another peer, or another tool: nothing.
test('002v C04: PreToolUse of send_to_agent marked by the daemon runs with no_reply set, the rest of the input unchanged; unmarked or another tool: nothing', async () => {
  const w = world(), SEND = 'mcp__plugin_agent-inbox_agent-inbox__send_to_agent'
  const input = { to: 'eve', text: '維護時段是每週三 02:00–03:00（UTC+8）。', line: 'mail', ask: '無' }
  fresh(b => b.tool_name === SEND && b.tool_input?.to === 'eve' ? { mark_no_reply: 'stopped' } : {})
  const o = await hook(w, { hook_event_name: 'PreToolUse', tool_name: SEND, tool_input: input })
  expect(o).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, no_reply: true } } })
  expect(posted.at(-1).tool_input).toEqual({ line: 'mail', to: 'eve', reply_to: null, no_reply: null })   // lanes-golive (A5): the line decides the mark
  expect(await hook(w, { hook_event_name: 'PreToolUse', tool_name: SEND, tool_input: { ...input, to: 'cain' } })).toBeNull()
  fresh(() => ({ mark_no_reply: 'stopped' }))
  expect(await hook(w, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })).toBeNull()
})

// 002w (D; 002v r3 T3-R): the daemon refuses a second completion of a scheduler run at the main's PreToolUse of Bash; the hook hands it the command only
// when it carries btcc-receipt, and prints the daemon's deny.
test('002w D: PreToolUse of a Bash that carries btcc-receipt posts the command and prints the daemon\'s deny; any other Bash posts no command', async () => {
  const w = world()
  fresh(b => b.tool_input?.command?.includes('complete 62') ? { deny: '排程 run 62 已經回執過了' } : {})
  const o = await hook(w, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: './bin/btcc-receipt complete 62 --outcome done' } })
  expect(o).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '排程 run 62 已經回執過了' } })
  expect(posted.at(-1).tool_input).toEqual({ command: './bin/btcc-receipt complete 62 --outcome done' })
  expect(await hook(w, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la' } })).toBeNull()
  expect(posted.at(-1).tool_input).toBeUndefined()
})

