// Universe 002k (D1): the main's Stop hook holds the turn ONCE while a Joey-sourced memory proposal is undecided and older than one main turn.
// Run as Claude Code runs it (stdin payload, stdout decision). No network, no model.
// 002p: the gate reads neither the ledger, state.json nor the transcript. The daemon hands it the turn (prompt_id, started_at, prev_started_at),
// the open Joey-sourced proposals (decided and non-Joey ones are the daemon's to leave out) and whether a curator holds the write right.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const GATE = join(import.meta.dir, 'lanes-hooks', 'main-memory-gate.py')
const MAIN_HOOK = join(import.meta.dir, 'lanes-hooks', 'main-hook.py')        // the main's Stop hook: the memory gate, then the answered aid
const rec = (o: object) => JSON.stringify(o) + '\n'
const prompt = (ts: string, text = '<channel source="telegram" message_id="1">hi</channel>') => rec({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })
type Proposal = { id: string; ts: string; lane: string; text: string }
const proposal = (id: string, ts: string): Proposal => ({ id, ts, lane: 'adam.worker.1', text: '記住：mock 服務的例行排程一律 09:00。\n〔Jev 檢查：有依據〕' })
const T = (m: number) => `2026-11-13T02:${String(m).padStart(2, '0')}:00.000Z`
/** the daemon's turn: the starts of the main's turns so far, the last one is this turn */
const turnOf = (starts: string[]) => starts.length ? { prompt_id: `p-${starts.at(-1)}`, started_at: starts.at(-1)!, prev_started_at: starts.length > 1 ? starts.at(-2)! : null, items: [], calls: [] } : {}

type S = { d: string; ld: string; turn: object; proposals: Proposal[]; curator: boolean }
function setup(proposals: Proposal[], starts: string[], curator = false): S {
  const d = mkdtempSync(join(tmpdir(), 'mgate-')); const ld = join(d, '.lanes'); mkdirSync(join(ld, 'run'), { recursive: true })
  writeFileSync(join(d, 't.jsonl'), '')
  return { d, ld, turn: turnOf(starts), proposals, curator }
}
async function hook(script: string, s: S, extra: object = {}) {
  const p = Bun.spawn(['python3', script], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LANES_DIR: s.ld, TYPESAFE_API_KEY: '', TYPESAFE_KEY_FILE: '/nonexistent' } })
  p.stdin.write(JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', transcript_path: join(s.d, 't.jsonl'), cwd: s.d, turn: s.turn, proposals: s.proposals, curator: s.curator, ...extra })); p.stdin.end()
  const out = (await new Response(p.stdout).text()).trim(); await p.exited
  return out ? JSON.parse(out) : null
}
const OPEN = [proposal('mp-aaa111', T(5))]

test('D1 hook: a Joey-sourced proposal filed before the main\'s previous turn is held once; the same turn passes the second time; the next turn holds again', async () => {
  const s = setup(OPEN, [T(1), T(10), T(20)])                                           // filed 02:05; turns start 02:01, 02:10, 02:20: a whole turn (02:10) went by
  const r = await hook(GATE, s)
  expect(r.decision).toBe('block')
  expect(r.reason).toContain('mp-aaa111'); expect(r.reason).toContain('一律 09:00'); expect(r.reason).not.toContain('Jev 檢查'); expect(r.reason).toContain('memory_decide(proposal_id, accept|rewrite|veto, reason)')
  expect(await hook(GATE, s)).toBeNull()                                                // once per turn
  s.turn = turnOf([T(1), T(10), T(20), T(40)])
  expect((await hook(GATE, s)).decision).toBe('block')                                  // a new turn, still undecided: held once more
  expect(await hook(GATE, s)).toBeNull()
  expect(Object.keys(JSON.parse(readFileSync(join(s.ld, 'run', 'memory-gate.json'), 'utf8')))).toEqual([`s1:p-${T(20)}`, `s1:p-${T(40)}`])   // <session>:<prompt_id>
})

test('D1 hook: not older than one main turn: the turn it was filed in, and the next one, are not held; the turn after that is', async () => {
  expect(await hook(GATE, setup(OPEN, [T(1), T(10)]))).toBeNull()                      // filed 02:05, previous turn started 02:01: the main has not had a turn with it yet
  expect(await hook(GATE, setup(OPEN, [T(10)]))).toBeNull()                             // a first turn (prev_started_at null)
  expect(await hook(GATE, setup([proposal('mp-late', T(12))], [T(1), T(10)]))).toBeNull()   // filed during the current turn
  expect((await hook(GATE, setup(OPEN, [T(6), T(10)]))).decision).toBe('block')         // the previous turn (02:06) began after it was filed: a whole turn has gone by
  expect((await hook(GATE, setup(OPEN, [T(6), T(10), T(15)]))).decision).toBe('block')
})

test('D1 hook: nothing is held with no open proposal (the daemon leaves decided and non-Joey ones out), a curator holding the write right, or a non-Stop event', async () => {
  const turns = [T(1), T(10), T(20)]
  expect(await hook(GATE, setup([], turns))).toBeNull()
  expect(await hook(GATE, setup(OPEN, turns, true))).toBeNull()
  expect(await hook(GATE, setup(OPEN, turns), { hook_event_name: 'PostToolUse' })).toBeNull()
  expect(await hook(GATE, setup(OPEN, []))).toBeNull()                                  // no turn handed in: the hook says nothing
  expect(await hook(GATE, { d: mkdtempSync(join(tmpdir(), 'mgate-')), ld: '/nonexistent/.lanes', turn: turnOf(turns), proposals: [], curator: false })).toBeNull()
})

test('D1 hook: every open proposal handed in that is old enough is listed, in the order given', async () => {
  const r = await hook(GATE, setup([proposal('mp-one', T(5)), proposal('mp-two', T(6)), proposal('mp-new', T(15))], [T(1), T(10), T(20)]))
  expect(r.reason).toContain('mp-one'); expect(r.reason).toContain('mp-two'); expect(r.reason).not.toContain('mp-new')
  expect(r.reason.indexOf('mp-one')).toBeLessThan(r.reason.indexOf('mp-two'))
})

test('D1 / 002p: the gate reads no transcript and no ledger: only `turn` and `proposals` decide; standalone without `turn` it does nothing', async () => {
  const ledgerLine = rec({ ts: T(5), lane: 'adam.worker.1', kind: 'memory_proposal', text: '記住：x', notify_main: true, refs: { proposal_id: 'mp-ledger', joey: true } })
  const s = setup(OPEN, [T(10)])                                                        // the turn: a first turn; the transcript: three turns
  writeFileSync(join(s.d, 't.jsonl'), prompt(T(1)) + prompt(T(10)) + prompt(T(20)) + rec({ type: 'system', subtype: 'turn_duration', uuid: 'u1' }))
  writeFileSync(join(s.ld, 'ledger.jsonl'), ledgerLine)
  expect(await hook(GATE, s)).toBeNull()
  const t = setup([], [T(1), T(10), T(20)])                                              // the ledger holds an open Joey proposal; the daemon handed none
  writeFileSync(join(t.d, 't.jsonl'), prompt(T(1)) + prompt(T(10)) + prompt(T(20)))
  writeFileSync(join(t.ld, 'ledger.jsonl'), ledgerLine)
  expect(await hook(GATE, t)).toBeNull()
  const u = setup(OPEN, [T(1), T(10), T(20)])                                            // the transcript: one prompt; the turn: the third one
  writeFileSync(join(u.d, 't.jsonl'), prompt(T(20)))
  expect((await hook(GATE, u)).decision).toBe('block')
  const v = setup(OPEN, [T(1), T(10), T(20)])                                            // the old standalone registration: no `turn` on stdin
  writeFileSync(join(v.d, 't.jsonl'), prompt(T(1)) + prompt(T(10)) + prompt(T(20)))
  writeFileSync(join(v.ld, 'ledger.jsonl'), ledgerLine)
  const p = Bun.spawn(['python3', GATE], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LANES_DIR: v.ld } })
  p.stdin.write(JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', transcript_path: join(v.d, 't.jsonl'), cwd: v.d })); p.stdin.end()
  expect((await new Response(p.stdout).text()).trim()).toBe(''); await p.exited
})

test('D1 hook: main-hook.py (the main\'s one Stop hook) holds the turn the same way from the daemon\'s answer, ahead of the answered check', async () => {
  let answer: object = {}
  const posted: any[] = []
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { posted.push(await req.json()); return Response.json(answer) } })
  try {
    const tok = mkdtempSync(join(tmpdir(), 'mgate-tok-')); writeFileSync(join(tok, String(server.port)), 'tkn')
    const main = async (s: S) => {
      const p = Bun.spawn(['python3', MAIN_HOOK], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, LANES_DIR: s.ld, TELEGRAM_HTTP_PORT: String(server.port), MCP_TOKEN_DIR: tok, TYPESAFE_API_KEY: '', TYPESAFE_KEY_FILE: '/nonexistent' } })
      p.stdin.write(JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', transcript_path: join(s.d, 't.jsonl'), cwd: s.d })); p.stdin.end()
      const out = (await new Response(p.stdout).text()).trim(); await p.exited
      return out ? JSON.parse(out) : null
    }
    const s = setup(OPEN, [T(1), T(10), T(20)])
    answer = { turn: s.turn, proposals: s.proposals, curator: false }
    const r = await main(s)
    expect(r.decision).toBe('block'); expect(r.reason).toContain('mp-aaa111')
    expect(await main(s)).toBeNull()                                                     // held once; its own check has nothing to add (no item in the turn)
    const quiet = setup([], [T(1), T(10), T(20)])
    answer = { turn: quiet.turn, proposals: [], curator: false }
    expect(await main(quiet)).toBeNull()                                                 // without an open proposal it behaves as before
    expect(existsSync(join(s.ld, 'run', 'memory-gate.json'))).toBe(true)
    answer = {}
    expect(await main(setup(OPEN, [T(1), T(10), T(20)]))).toBeNull()                     // no daemon answer: nothing handed in, nothing held
  } finally { server.stop(true) }
})
