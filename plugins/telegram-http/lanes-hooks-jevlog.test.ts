// Universe 002k: the two main hooks' Jev calls: the error text is kept (main-summary-gate swallowed it), 'ms' is recorded in both hooks'
// jsonl, and each call is also a line in run/jev-calls.jsonl. The hooks are run as Claude Code runs them, against a local Jev stand-in.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SUMMARY = join(import.meta.dir, 'lanes-hooks', 'main-summary-gate.py')
const ANSWERED = join(import.meta.dir, 'lanes-hooks', 'main-answered-gate.py')
let server: any, mode: 'ok' | 'http403' | 'different' = 'ok'
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const body = await req.json() as any
    if (mode === 'http403') return new Response('<html>blocked</html>', { status: 403 })
    const answers: Record<string, unknown> = {}
    for (const [k, q] of Object.entries<any>(body.questions)) {
      if (k.includes('.')) answers[k] = { type: 'noul', noul: k.endsWith('reply_needed') ? 0.95 : 0.05 }       // answered gate: needs a reply, not answered
      else answers[k] = { type: 'choice', choice: mode === 'different' && q.instructions.entry.includes('A-1103') ? 'different' : 'stated', confidence: mode === 'different' && q.instructions.entry.includes('A-1103') ? 0.92 : 0.95 }
    }
    return Response.json({ model: 'jev-1.14.0', answers })
  } })
})
afterAll(() => server.stop(true))
const env = (extra: Record<string, string> = {}) => ({ ...process.env, TYPESAFE_BASE_URL: `http://127.0.0.1:${server.port}`, TYPESAFE_API_KEY: 'test-key', ...extra })
const jsonl = (p: string): any[] => existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
async function spawnHook(hook: string, payload: object, e: Record<string, string>): Promise<string> {
  const p = Bun.spawn(['python3', hook], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: e })
  p.stdin.write(JSON.stringify(payload)); p.stdin.end()
  const out = (await new Response(p.stdout).text()).trim(); await p.exited
  return out
}

// ------------------------------------------------------------------ main-summary-gate.py
const rec = (o: object) => JSON.stringify(o) + '\n'
const LIST = '活動清單（今天）\n• 11-13 10:03｜adam.reflex.1｜發生：Eve 問維護時段｜回覆每週三 02:00–03:00\n• 11-13 12:55｜adam.reflex.4｜發生：備份連續失敗 A-1103｜重跑一次仍 403，已升級\n• 11-13 09:00｜main｜事故偵測工具開工'
const MAIN_ONLY = '活動清單（今天）\n• 11-13 09:00｜main｜事故偵測工具開工'
const transcript = (list: string) => rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__plugin_telegram-http_telegram-http__ledger_query', input: {} }] } })
  + rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: list }] } })
async function summary(reply: string, e: Record<string, string> = {}, list = LIST, shim?: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 'sgate-jl-')); const run = join(d, '.lanes', 'run'); mkdirSync(run, { recursive: true })
  const tp = join(d, 't.jsonl'); writeFileSync(tp, transcript(list))
  await spawnHook(SUMMARY, { hook_event_name: 'PreToolUse', session_id: 's1', transcript_path: tp, cwd: d, tool_input: { text: reply } }, env({ LANES_DIR: join(d, '.lanes'), SUMMARY_GATE_JEV: '1', ...e, ...shim }))
  return { gate: jsonl(join(run, 'summary-gate.jsonl')), calls: jsonl(join(run, 'jev-calls.jsonl')) }
}
const GOOD = '10:03 回了 Eve 維護時段；12:55 備份連續失敗，重跑仍 403，已升級。'

test('summary gate: a successful call has ms in its record and no error; the unified log has the question, the raw answers, p null', async () => {
  mode = 'ok'
  const r = await summary(GOOD)
  expect(r.gate.length).toBe(1)
  expect(typeof r.gate[0].ms).toBe('number'); expect(r.gate[0].ms).toBeGreaterThanOrEqual(0); expect(r.gate[0]).not.toHaveProperty('error'); expect(r.gate[0].jev).toBe(true)
  expect(r.calls.length).toBe(1)
  const c = r.calls[0]
  expect(Object.keys(c)).toEqual(['ts', 'sim', 'site', 'question', 'inputs', 'answer', 'p', 'ms', 'err'])
  expect(c.site).toBe('summary-gate'); expect(Object.keys(c.question)).toEqual(['I0', 'I1']); expect(c.question.I1.instructions.entry).toContain('A-1103')
  expect(c.inputs).toMatchObject({ session: 's1', items: 2 }); expect(c.inputs.reply).toContain('12:55')
  expect(c.answer.I0.choice).toBe('stated'); expect(c.p).toBeNull(); expect(c.err).toBeNull(); expect(c.ms).toBe(r.gate[0].ms)
})

test('summary gate: p is the highest confidence of a "different" relation', async () => {
  mode = 'different'
  const r = await summary('10:03 回了 Eve 維護時段；12:55 備份失敗，重跑後成功。')
  expect(r.calls[0].p).toBe(0.92); expect(r.gate[0].different).toEqual(['12:55'])
})

test('summary gate: a failed call keeps its error text (HTTP 403, no key) in the record; the fallback to the HH:MM test is unchanged', async () => {
  mode = 'http403'
  let r = await summary(GOOD)
  expect(r.gate[0].jev).toBe(false); expect(r.gate[0].error).toContain('HTTPError'); expect(r.gate[0].error).toContain('403'); expect(typeof r.gate[0].ms).toBe('number')
  expect(r.gate[0].missing).toEqual([])                                               // 10:03 and 12:55 are both in the reply: the HH:MM test passes it
  expect(r.calls[0]).toMatchObject({ site: 'summary-gate', answer: null, p: null }); expect(r.calls[0].err).toContain('403')
  mode = 'ok'
  r = await summary(GOOD, { TYPESAFE_API_KEY: '', TYPESAFE_KEY_FILE: '/nonexistent/typesafe.env' })
  expect(r.gate[0].jev).toBe(false); expect(r.gate[0].error).toBe('RuntimeError: no key'); expect(r.calls[0].err).toBe('RuntimeError: no key')
  r = await summary(GOOD, { TYPESAFE_BASE_URL: 'http://127.0.0.1:1' })               // nothing listens
  expect(r.gate[0].error).toContain('URLError'); expect(r.gate[0].jev).toBe(false)
})

test('summary gate: nothing to ask (no lane-handled lines): no call, ms null, no error, no line in the unified log', async () => {
  mode = 'ok'
  const r = await summary('今天我自己做了事故偵測工具。', {}, MAIN_ONLY)
  expect(r.gate.length).toBe(1); expect(r.gate[0].ms).toBeNull(); expect(r.gate[0]).not.toHaveProperty('error'); expect(r.gate[0].jev).toBe(false)
  expect(r.calls.length).toBe(0)
})

// ------------------------------------------------------------------ main-answered-gate.py
const tg = (id: string, text: string) => `<channel source="plugin:telegram-http:telegram-http" chat_id="990000001" message_id="${id}" user="joey_lab" ts="2026-11-14T02:03:02.000Z">\n${text}\n</channel>`
const prompt = (id: string, text: string) => rec({ type: 'user', isMeta: true, timestamp: 't', message: { role: 'user', content: tg(id, text) } })
const absorbed = (id: string, text: string) => rec({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', timestamp: 't', content: tg(id, text) })
const reply = (text: string, reply_to?: string) => rec({ type: 'assistant', timestamp: 't', message: { model: 'claude-haiku-5-5', content: [
  { type: 'tool_use', name: 'mcp__plugin_telegram-http_telegram-http__reply', input: { chat_id: '990000001', text, ...(reply_to ? { reply_to } : {}) } }] } })
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
async function answered(t: string, e: Record<string, string> = {}, shim?: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 'agate-jl-')); const run = join(d, '.lanes', 'run'); mkdirSync(run, { recursive: true })
  const tp = join(d, 't.jsonl'); writeFileSync(tp, t)
  await spawnHook(ANSWERED, { hook_event_name: 'Stop', session_id: 's1', transcript_path: tp, cwd: d, lanes_turn: asTurn(t) }, env({ LANES_DIR: join(d, '.lanes'), ...e, ...shim }))
  return { gate: jsonl(join(run, 'answered-gate.jsonl')), calls: jsonl(join(run, 'jev-calls.jsonl')) }
}
const TWO_UNANSWERED = prompt('100', '開始做報告') + absorbed('101', '發票 4471 付了嗎？') + reply('報告做完了', '100')

test('answered gate: ms in the record of a call, and one line in the unified log with the questions, the raw answers and the ids', async () => {
  mode = 'ok'
  const r = await answered(TWO_UNANSWERED)
  expect(r.gate.length).toBe(1); expect(typeof r.gate[0].ms).toBe('number'); expect(r.gate[0]).not.toHaveProperty('error')
  expect(r.calls.length).toBe(1)
  const c = r.calls[0]
  expect(c).toMatchObject({ site: 'answered-gate', p: null, err: null, inputs: { session: 's1', messages: ['100', '101'], outputs: 1 } }); expect(c.ms).toBe(r.gate[0].ms)
  expect(Object.keys(c.question)).toEqual(['M1.reply_needed', 'M1.answered', 'M1.deferred'])      // message 100 was answered by id: only 101 was asked about
  expect(c.question['M1.reply_needed'].instructions).toContain('needs an answer back'); expect(c.answer['M1.reply_needed'].noul).toBe(0.95)
})

test('answered gate: a failed call keeps the error and gets ms in its record, and is in the unified log with answer null', async () => {
  mode = 'http403'
  const r = await answered(TWO_UNANSWERED)
  expect(r.gate[0].error).toContain('403'); expect(typeof r.gate[0].ms).toBe('number')
  expect(r.calls[0]).toMatchObject({ site: 'answered-gate', answer: null, p: null }); expect(r.calls[0].err).toContain('403'); expect(r.calls[0].ms).toBe(r.gate[0].ms)
  mode = 'ok'
  const k = await answered(TWO_UNANSWERED, { TYPESAFE_API_KEY: '', TYPESAFE_KEY_FILE: '/nonexistent/typesafe.env' })
  expect(k.gate[0].error).toBe('RuntimeError: no key'); expect(k.calls[0].err).toBe('RuntimeError: no key')
})

test('answered gate: every message answered by id: no Jev call, ms null, no line in the unified log', async () => {
  mode = 'ok'
  const r = await answered(prompt('100', '開始做報告') + absorbed('101', '發票 4471 付了嗎？') + reply('發票 4471 在 11-02 付了', '101') + reply('報告做完了', '100'))
  expect(r.gate[0].ms).toBeNull(); expect(r.calls.length).toBe(0)
})

// ------------------------------------------------------------------ the real time, under the lab's clock shim
const SHIM = '/home/god/genesis/clock/libgenesis_clock.so'
const shim = { LD_PRELOAD: SHIM, GENESIS_CLOCK_OFFSET: '3600', GENESIS_CLOCK_FILE: '/nonexistent' }
test('both hooks: ts of the unified log is the time now', async () => {
  mode = 'ok'
  for (const c of [(await summary(GOOD)).calls[0], (await answered(TWO_UNANSWERED)).calls[0]]) {
    expect(Math.abs(Date.parse(c.ts) - Date.now())).toBeLessThan(3000); expect(Math.abs(Date.parse(c.sim) - Date.now())).toBeLessThan(3000)
  }
})
test.skipIf(!existsSync(SHIM))('both hooks under the clock shim at +3600 s: ts is the real time, sim the shifted one', async () => {
  mode = 'ok'
  for (const c of [(await summary(GOOD, {}, LIST, shim)).calls[0], (await answered(TWO_UNANSWERED, {}, shim)).calls[0]]) {
    expect(Math.abs(Date.parse(c.ts) - Date.now())).toBeLessThan(5000)
    const gap = Date.parse(c.sim) - Date.parse(c.ts)
    expect(gap).toBeGreaterThan(3_590_000); expect(gap).toBeLessThan(3_610_000)
  }
})
