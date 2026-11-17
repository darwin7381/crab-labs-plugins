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
  const proposals = [{ id: 'mp-aaa111', ts: '2026-11-13T02:05:00.000Z', lane: 'adam.worker.1', text: '記住：例行排程一律 09:00。' }]
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
