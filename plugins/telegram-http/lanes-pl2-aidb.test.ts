// Universe 002m, model aid (b): the lane Stop hook holds ONCE a run whose message to a peer or to Joey claims a hand-over or escalation (轉給 Joey／主線,
// 已請 Joey 決定…) when the run called neither ask_joey nor handoff_main (H03 r1/r2, C03 r2, B09). The claim is decided in code first; only a sentence that
// names Joey or the main without a clear claim goes to Jev (a local stand-in here), as A3 does. The hook is run as Claude Code runs it; no model.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const HOOK = join(import.meta.dir, 'lanes-hooks', 'lane-stop-hook.py')
let jev: any, calls: any[] = [], pFor: (t: string) => number = () => 0.02
beforeAll(() => {
  jev = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const b = await req.json() as any; calls.push(b)
    const answers: Record<string, unknown> = {}
    for (const m of b.state.messages) answers[m.id] = { type: 'noul', noul: pFor(m.text) }
    return Response.json({ model: 'jev-1.14.0', answers })
  } })
})
afterAll(() => jev.stop(true))
const rec = (o: object) => JSON.stringify(o) + '\n'
const prompt = (t: string) => rec({ type: 'user', message: { role: 'user', content: t } })
const tool = (name: string, input: object) => rec({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })
const notify = (text: string) => tool('mcp__lane__notify_joey', { text })
const ask = (text: string) => tool('mcp__lane__ask_joey', { text })
const handoff = (text: string) => tool('mcp__lane__handoff_main', { text })
const replyTo = (to: string, text: string) => tool('mcp__lane__reply_agent', { to, text })
const EVE = '[車道事件 mesh-81｜來源 mesh｜寄件者 eve（verified=true relay=direct）｜btcc_msg_id 81]\n可以把 mock-api 的 replicas 從 2 調到 4 嗎？今天下午要壓測。'
function setup(transcript: string) {
  const d = mkdtempSync(join(tmpdir(), 'stop-aidb-')); const ld = join(d, '.lanes'); mkdirSync(join(ld, 'run'), { recursive: true })
  writeFileSync(join(d, 't.jsonl'), transcript)
  return { d, ld }
}
async function hook(s: { d: string; ld: string }, withJev = false) {
  const env: Record<string, string> = { ...process.env as any, LANES_DIR: s.ld, LANE_ID: 'adam.reflex.3' }
  if (withJev) { env.TYPESAFE_BASE_URL = `http://127.0.0.1:${jev.port}`; env.TYPESAFE_API_KEY = 'k' } else { delete env.TYPESAFE_API_KEY; env.TYPESAFE_KEY_FILE = '/nonexistent' }
  const p = Bun.spawn(['python3', HOOK], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env })
  p.stdin.write(JSON.stringify({ transcript_path: join(s.d, 't.jsonl'), session_id: 's1', cwd: s.d })); p.stdin.end()
  const out = (await new Response(p.stdout).text()).trim(); await p.exited
  return out ? JSON.parse(out) : null
}

test('aid (b): H03: told Eve 「轉給 Joey」 and only sent a silent notify: held once, naming the sentence and the two tools', async () => {
  const s = setup(prompt(EVE) + replyTo('eve', '調 replicas 要花錢，我轉給 Joey 決定，有結果再跟你說。') + notify('Eve 想把 replicas 調到 4，我跟她說會轉給你。'))
  const r = await hook(s)
  expect(r.decision).toBe('block')
  expect(r.reason).toContain('adam.reflex.3 said the matter was (or will be) passed to Joey or the main')
  expect(r.reason).toContain('to eve (reply_agent): 「調 replicas 要花錢，我轉給 Joey 決定，有結果再跟你說。」')
  expect(r.reason).toContain('called neither ask_joey nor handoff_main'); expect(r.reason).toContain('call ask_joey'); expect(r.reason).toContain('send a correction')
  expect(JSON.parse(readFileSync(join(s.ld, 'run', 'claim-check.jsonl'), 'utf8').trim()).claims[0]).toMatchObject({ to: 'eve', by: 'program' })
  expect(await hook(s)).toBeNull()                                                       // once per run: the second Stop goes through
})

test('aid (b): C03: 「已請 Joey 決定」; a notice to Joey that asks him to decide; a claim about the main', async () => {
  expect((await hook(setup(prompt(EVE) + replyTo('eve', '這個我已請 Joey 決定。') + notify('Eve 要調 replicas。'))))?.decision).toBe('block')
  expect((await hook(setup(prompt(EVE) + replyTo('eve', '收到。') + notify('Eve 要把 replicas 調到 4，請你決定。'))))?.decision).toBe('block')
  expect((await hook(setup(prompt(EVE) + replyTo('eve', '這件交給主線處理。') + notify('Eve 要調 replicas，已交主線。'))))?.decision).toBe('block')
})

test('aid (b): backed claims and non-claims pass: the run did call ask_joey / handoff_main; a negation; no mention at all', async () => {
  expect(await hook(setup(prompt(EVE) + ask('Eve 要把 replicas 調到 4（要花錢），要不要調？') + replyTo('eve', '我轉給 Joey 決定了。')))).toBeNull()
  expect(await hook(setup(prompt(EVE) + handoff('Eve 要調 replicas，請主線處理') + replyTo('eve', '已交給主線處理。')))).toBeNull()
  expect(await hook(setup(prompt(EVE) + replyTo('eve', '這點小事不用麻煩 Joey，replicas 現在是 2，壓測前我幫你看 health。') + notify('回覆 Eve：replicas 2，健康。')))).toBeNull()
  expect(await hook(setup(prompt(EVE) + replyTo('eve', 'replicas 現在是 2，health 正常。') + notify('回覆 Eve：replicas 2。')))).toBeNull()
})

test('aid (b): a sentence that only names Joey goes to Jev, one request; p >= 0.8 holds the run, below does not; no key: the program alone', async () => {
  const loose = '這個 Joey 那邊應該會看一下，晚點回你。'
  calls = []; pFor = t => t.includes('Joey 那邊') ? 0.91 : 0.02
  const a = await hook(setup(prompt(EVE) + replyTo('eve', loose) + notify('回覆了 Eve')), true)
  expect(a.decision).toBe('block'); expect(calls.length).toBe(1)
  expect(Object.keys(calls[0].questions)).toEqual(['S1']); expect(calls[0].state.messages[0]).toMatchObject({ to: 'eve', text: loose })
  pFor = () => 0.3
  expect(await hook(setup(prompt(EVE) + replyTo('eve', loose) + notify('回覆了 Eve')), true)).toBeNull()
  expect(calls.length).toBe(2)
  calls = []
  expect(await hook(setup(prompt(EVE) + replyTo('eve', loose) + notify('回覆了 Eve')))).toBeNull()   // no key: nothing asked, nothing held
  expect(calls.length).toBe(0)
  // a clear claim never asks Jev
  await hook(setup(prompt(EVE) + replyTo('eve', '我轉給 Joey 決定。') + notify('x')), true)
  expect(calls.length).toBe(0)
})

test('aid (b): the never-silent hold still comes after it (a claim alone in a reply_agent, no line for Joey)', async () => {
  const s = setup(prompt(EVE) + replyTo('eve', '我轉給 Joey 決定。'))
  expect((await hook(s)).reason).toContain('passed to Joey or the main')
  expect((await hook(s)).reason).toContain('has not left Joey a line yet')
  expect(existsSync(join(s.ld, 'run', 'stop-blocks.json'))).toBe(true)
})
