// Universe 002k (Jev design A3): a lane's report is checked against its own tool results. Jev is a local stand-in.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
let server: any, mode: 'contra' | 'ok' | 'fail' = 'contra', calls = 0
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    calls++
    const body = await req.json() as any
    if (mode === 'fail') return new Response('x', { status: 500 })
    const answers: Record<string, unknown> = {}
    for (const k of Object.keys(body.questions)) answers[k] = { type: 'choice', choice: mode === 'contra' && k === 'S1' ? 'contradicts' : 'supports', confidence: 0.93 }
    return Response.json({ answers })
  } })
  process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.port}`; process.env.TYPESAFE_API_KEY = 'k'; process.env.LANES_REPORT_CHECK = '1'
})
afterAll(() => server.stop(true))
const L = await import('./lanes.ts?a3-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-a3-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const sent: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'], sendBot: async (_c: string, t: string) => { sent.push(t); return 9500 + sent.length }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const tr = join(dir, 'lane.jsonl')
writeFileSync(tr, [
  { type: 'user', message: { role: 'user', content: '[車道事件] mock-api p95 警報' } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: './bin/svc GET mock-api/health' } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"status":"degraded","p95_ms":2600,"error_rate":0.08}' }] } },
].map(r => JSON.stringify(r)).join('\n') + '\n')
const st = L.__lanesState()
st.lanes['adam.reflex.1'] = { id: 'adam.reflex.1', kind: 'reflex', n: 1, session_id: 's', thread: 'adam#t-1', status: 'running', created: '', last: '', transcript: tr, runs: 0, tokens_in: 0, tokens_out: 0 } as any
const tok = (run: string) => ({ runId: run, lane: 'adam.reflex.1', evId: 'ev-1', closers: [], critical: false, trigger: 'alert', cls: 'alert', escalated: false, pushed: false }) as any

test('a sentence the tool results contradict sends the report back once; the second attempt goes out', async () => {
  mode = 'contra'
  const r1 = await L.callLaneTool(tok('r1'), 'notify_joey', { text: 'mock-api 目前正常，p95 180ms。已確認。' })
  expect(r1).toContain('not sent'); expect(r1).toContain('mock-api 目前正常'); expect(sent.length).toBe(0)
  const r2 = await L.callLaneTool(tok('r1'), 'notify_joey', { text: 'mock-api 目前正常，p95 180ms。已確認。' })
  expect(r2).not.toContain('not sent'); expect(sent.length).toBe(1)
  const log = readFileSync(join(dir, 'run', 'report-check.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  expect(log[0].sent_back).toBe(true)
})

test('supported text goes out at once; a failed call sends the text as it is', async () => {
  mode = 'ok'
  expect(await L.callLaneTool(tok('r2'), 'notify_joey', { text: 'mock-api 目前 degraded，p95 2600ms。' })).not.toContain('not sent')
  mode = 'fail'
  expect(await L.callLaneTool(tok('r3'), 'notify_joey', { text: 'mock-api 目前正常，p95 180ms。' })).not.toContain('not sent')
  expect(sent.length).toBe(3)
})
