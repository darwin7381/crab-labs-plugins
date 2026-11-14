// Universe 002k (D1): the main's Stop hook holds the turn ONCE while a Joey-sourced memory proposal is undecided and older than one main turn.
// Run as Claude Code runs it (stdin payload, stdout decision) against fixture ledgers and transcripts. No network, no model.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const GATE = join(import.meta.dir, 'lanes-hooks', 'main-memory-gate.py')
const ANSWERED = join(import.meta.dir, 'lanes-hooks', 'main-answered-gate.py')
const rec = (o: object) => JSON.stringify(o) + '\n'
const prompt = (ts: string, text = '<channel source="telegram" message_id="1">hi</channel>') => rec({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })
const toolResult = (ts: string) => rec({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } })
const feedback = (ts: string) => rec({ type: 'user', timestamp: ts, message: { role: 'user', content: 'Stop hook feedback:\n這一輪先不要結束…' } })
const proposal = (id: string, ts: string, joey = true) => rec({ ts, lane: 'adam.worker.1', thread: 'adam#t-1', event: 'e1', kind: 'memory_proposal', text: '記住：mock 服務的例行排程一律 09:00。\n〔Jev 檢查：有依據〕', notify_main: true, refs: { proposal_id: id, joey, source: joey ? 'telegram' : 'mesh' } })
const decision = (id: string) => rec({ ts: '2026-11-13T02:30:00.000Z', lane: 'main', thread: 'adam#t-1', kind: 'memory_decision', text: 'x', notify_main: false, refs: { proposal_id: id, decision: 'veto' } })
const T = (m: number) => `2026-11-13T02:${String(m).padStart(2, '0')}:00.000Z`

function setup(ledger: string, transcript: string, state?: object) {
  const d = mkdtempSync(join(tmpdir(), 'mgate-')); const ld = join(d, '.lanes'); mkdirSync(join(ld, 'run'), { recursive: true })
  writeFileSync(join(ld, 'ledger.jsonl'), ledger); writeFileSync(join(d, 't.jsonl'), transcript)
  if (state) writeFileSync(join(ld, 'state.json'), JSON.stringify(state))
  return { d, ld }
}
async function hook(script: string, s: { d: string; ld: string }, extra: object = {}) {
  const p = Bun.spawn(['python3', script], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LANES_DIR: s.ld, TYPESAFE_API_KEY: '', TYPESAFE_KEY_FILE: '/nonexistent' } })
  p.stdin.write(JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', transcript_path: join(s.d, 't.jsonl'), cwd: s.d, ...extra })); p.stdin.end()
  const out = (await new Response(p.stdout).text()).trim(); await p.exited
  return out ? JSON.parse(out) : null
}
const OPEN = proposal('mp-aaa111', T(5))

test('D1 hook: a Joey-sourced proposal filed before the main\'s previous turn is held once; the same turn passes the second time; the next turn holds again', async () => {
  const s = setup(OPEN, prompt(T(1)) + prompt(T(10)) + prompt(T(20)))                   // filed 02:05; turns start 02:01, 02:10, 02:20: a whole turn (02:10) went by
  const r = await hook(GATE, s)
  expect(r.decision).toBe('block')
  expect(r.reason).toContain('mp-aaa111'); expect(r.reason).toContain('一律 09:00'); expect(r.reason).not.toContain('Jev 檢查'); expect(r.reason).toContain('memory_decide(proposal_id, accept|rewrite|veto, reason)')
  expect(await hook(GATE, s)).toBeNull()                                                // once per turn
  writeFileSync(join(s.d, 't.jsonl'), prompt(T(1)) + prompt(T(10)) + prompt(T(20)) + prompt(T(40)))
  expect((await hook(GATE, s)).decision).toBe('block')                                  // a new turn, still undecided: held once more
  expect(await hook(GATE, s)).toBeNull()
})

test('D1 hook: not older than one main turn: the turn it was filed in, and the next one, are not held; the turn after that is', async () => {
  expect(await hook(GATE, setup(OPEN, prompt(T(1)) + prompt(T(10))))).toBeNull()        // filed 02:05, previous turn started 02:01: the main has not had a turn with it yet
  expect(await hook(GATE, setup(OPEN, prompt(T(10))))).toBeNull()                       // a first turn
  expect(await hook(GATE, setup(proposal('mp-late', T(12)), prompt(T(1)) + prompt(T(10))))).toBeNull()   // filed during the current turn
  expect((await hook(GATE, setup(OPEN, prompt(T(6)) + prompt(T(10))))).decision).toBe('block')           // the previous turn (02:06) began after it was filed: a whole turn has gone by
  expect((await hook(GATE, setup(OPEN, prompt(T(6)) + prompt(T(10)) + prompt(T(15))))).decision).toBe('block')
})

test('D1 hook: tool results and a hook\'s own feedback are not turns', async () => {
  const s = setup(OPEN, prompt(T(1)) + toolResult(T(2)) + prompt(T(10)) + toolResult(T(11)) + feedback(T(12)) + toolResult(T(13)))
  expect(await hook(GATE, s)).toBeNull()                                                // two prompts: 02:01 and 02:10; the proposal (02:05) is not older than 02:01
  const s2 = setup(OPEN, prompt(T(1)) + toolResult(T(2)) + prompt(T(10)) + feedback(T(12)) + prompt(T(20)) + toolResult(T(21)))
  expect((await hook(GATE, s2)).decision).toBe('block')                                 // three prompts: 02:01, 02:10, 02:20
})

test('D1 hook: nothing is held for a decided proposal, a proposal that did not come from Joey, a curator holding the write right, or a non-Stop event', async () => {
  const turns = prompt(T(1)) + prompt(T(10)) + prompt(T(20))
  expect(await hook(GATE, setup(OPEN + decision('mp-aaa111'), turns))).toBeNull()
  expect(await hook(GATE, setup(proposal('mp-eve001', T(5), false), turns))).toBeNull()
  expect(await hook(GATE, setup(OPEN, turns, { curator: { lane: 'adam.curator.1' } }))).toBeNull()
  expect(await hook(GATE, setup(OPEN, turns), { hook_event_name: 'PostToolUse' })).toBeNull()
  expect(await hook(GATE, setup('', turns))).toBeNull()                                 // no ledger at all
  expect(await hook(GATE, { d: mkdtempSync(join(tmpdir(), 'mgate-')), ld: '/nonexistent/.lanes' })).toBeNull()   // nothing readable: the hook says nothing
})

test('D1 hook: only the undecided ones are listed, oldest first; a decision for one leaves the other', async () => {
  const s = setup(proposal('mp-one', T(5)) + proposal('mp-two', T(6)) + decision('mp-one'), prompt(T(1)) + prompt(T(10)) + prompt(T(20)))
  const r = await hook(GATE, s)
  expect(r.reason).toContain('mp-two'); expect(r.reason).not.toContain('mp-one')
})

test('D1 hook: main-answered-gate.py (the Stop hook the lab wires for the main) holds the turn the same way, ahead of its own check', async () => {
  const s = setup(OPEN, prompt(T(1)) + prompt(T(10)) + prompt(T(20)))
  const r = await hook(ANSWERED, s)
  expect(r.decision).toBe('block'); expect(r.reason).toContain('mp-aaa111')
  expect(await hook(ANSWERED, s)).toBeNull()                                            // held once; its own check has nothing to add (one message in the turn)
  const quiet = setup('', prompt(T(1)) + prompt(T(10)) + prompt(T(20)))
  expect(await hook(ANSWERED, quiet)).toBeNull()                                        // without an open proposal it behaves as before
  expect(existsSync(join(s.ld, 'run', 'memory-gate.json'))).toBe(true)
})
