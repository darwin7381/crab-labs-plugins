// Universe 002k (D14): the A3 report check: a proposal is not a record. A sentence that says something was recorded is contradicted when the run
// only filed a memory proposal. Jev is a local stand-in (the program decides this one; Jev gets the proposals and writes of the run as evidence).
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
let server: any, calls: any[] = []
/** the report check's requests (002w F: a delivered line is also asked the one promise check, another request) */
const reportCalls = () => calls.filter(c => Array.isArray(c?.state?.tool_results))
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const body = await req.json() as any
    calls.push(body)
    const answers: Record<string, unknown> = {}
    for (const k of Object.keys(body.questions)) answers[k] = { type: 'choice', choice: 'says_nothing', confidence: 0.9 }
    return Response.json({ answers })
  } })
  process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.port}`; process.env.TYPESAFE_API_KEY = 'k'; process.env.LANES_REPORT_CHECK = '1'
})
afterAll(() => { server.stop(true); delete process.env.LANES_REPORT_CHECK })
const L = await import('./lanes.ts?d14-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-d14-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const sent: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async (_c: string, t: string) => { sent.push(t); return 9800 + sent.length }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const st = L.__lanesState()
const rows = (n: string): any[] => { try { return readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
let n = 0
function run(kind: 'worker' | 'curator' = 'worker'): any {
  n += 1
  const id = `adam.${kind}.${n}`, evId = `ev-d14-${n}`
  st.lanes[id] = { id, kind, n, session_id: 's', thread: `adam#t-d14${n}`, status: 'running', created: '', last: '', transcript: join(dir, `lane${n}.jsonl`), runs: 0, tokens_in: 0, tokens_out: 0 } as any
  st.threads[`adam#t-d14${n}`] = { id: `adam#t-d14${n}`, lane: id, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
  L.__putQueue({ ev: { id: evId, source: 'telegram', from: 'joey', text: 'x', meta: {}, notif: { method: '', params: {} } }, lane: id, state: 'leased', lease_until: 0, attempts: 1, priority: 1, enqueued: '' })
  return { runId: `${id}.r1`, lane: id, evId, closers: [], critical: false, trigger: 'joey', cls: 'joey', escalated: false, pushed: false }
}
const RULE = '記住：mock 服務的例行排程一律 09:00，不要再改。'
const CLAIM = '收到，已記下：mock 服務的例行排程一律 09:00，不再改。'
const propose = (tok: any) => L.callLaneTool(tok, 'ledger_write', { kind: 'memory_proposal', text: RULE })

test('D14: a worker that only filed a proposal and tells Joey 「已記下」: sent back once, naming the proposal; the second attempt goes out', async () => {
  const tok = run()
  const pid = /id (mp-[0-9a-f]+)/.exec(await propose(tok))![1]
  calls = []
  const r1 = await L.callLaneTool(tok, 'notify_joey', { outcome: 'normal', text: CLAIM })
  expect(r1).toStartWith('not sent:'); expect(r1).toContain(pid); expect(r1).toContain('a proposal is not a memory write and not a record'); expect(r1).toContain('「收到，已記下：mock 服務的例行排程一律 09:00，不再改。」')
  expect(sent.length).toBe(0); expect(reportCalls().length).toBe(0)                                  // decided by the program: Jev was not asked
  const log = rows('run/report-check.jsonl').at(-1)
  expect(log).toMatchObject({ by: 'program', relation: 'proposal-is-not-a-record', sent_back: true, tool: 'notify_joey' })
  const r2 = await L.callLaneTool(tok, 'notify_joey', { outcome: 'normal', text: CLAIM })
  expect(r2).toContain('sent to Joey'); expect(sent.length).toBe(1)                          // once: it goes out as written the second time
})

test('D14: the claim words: 記下 / 已記 / recorded / remembered; a negation, or a sentence that says it was only proposed, is not a claim', async () => {
  for (const c of ['已記，之後照這個。', 'I recorded your rule: 09:00 for every routine.', 'Got it, I remembered it.', '我記下了。']) {
    const tok = run(); await propose(tok)
    expect(await L.callLaneTool(tok, 'notify_joey', { outcome: 'normal', text: c })).toStartWith('not sent:')
  }
  for (const c of ['還沒記下，我把它交給主線決定。', '已把這句記成提案，主線決定後才會寫進記憶。', 'I have proposed it to the main; it is not recorded yet.', '收到，主線會看。', 'Nothing was recorded.']) {
    const tok = run(); await propose(tok)
    expect(await L.callLaneTool(tok, 'notify_joey', { outcome: 'normal', text: c })).toContain('sent to Joey')
  }
})

test('D14: a record of the run\'s own (ledger_write action / commitment, the commitment tool) or a memory write for the proposal means the claim stands', async () => {
  const a = run(); await propose(a); await L.callLaneTool(a, 'ledger_write', { kind: 'action', text: '已把 Joey 的 09:00 規則寫進 runbook 草稿' })
  expect(await L.callLaneTool(a, 'notify_joey', { outcome: 'normal', text: CLAIM })).toContain('sent to Joey')
  const b = run(); await propose(b); await L.callLaneTool(b, 'commitment', { who: 'joey', what: '09:00 規則', by: '今天' })
  expect(await L.callLaneTool(b, 'notify_joey', { outcome: 'normal', text: CLAIM })).toContain('sent to Joey')
  const c = run(); const pid = /id (mp-[0-9a-f]+)/.exec(await propose(c))![1]
  expect(await L.callMainTool('memory_decide', { proposal_id: pid, decision: 'accept', reason: 'Joey 明說' }, 'mcp-main')).toContain('accepted')   // the main wrote it
  expect(await L.callLaneTool(c, 'notify_joey', { outcome: 'normal', text: CLAIM })).toContain('sent to Joey')
  const d = run(); const dpid = /id (mp-[0-9a-f]+)/.exec(await propose(d))![1]; await L.callMainTool('memory_decide', { proposal_id: dpid, decision: 'veto', reason: '不記' }, 'mcp-main')
  expect(await L.callLaneTool(d, 'notify_joey', { outcome: 'normal', text: CLAIM })).toStartWith('not sent:')   // a veto is not a write
})

test('D14: no proposal in the run (nothing for this relation), a curator lane (it writes memory itself) and the flag off are not touched', async () => {
  const none = run()
  expect(await L.callLaneTool(none, 'notify_joey', { outcome: 'normal', text: CLAIM })).toContain('sent to Joey')          // the existing check (Jev, tool results) is what applies
  const cur = run('curator'); await propose(cur)
  expect(await L.callLaneTool(cur, 'notify_joey', { outcome: 'normal', text: '已記下整理好的提案。' })).toContain('sent to Joey')
  process.env.LANES_REPORT_CHECK = '0'
  const off = run(); await propose(off)
  expect(await L.callLaneTool(off, 'notify_joey', { outcome: 'normal', text: CLAIM })).toContain('sent to Joey')
  process.env.LANES_REPORT_CHECK = '1'
})

test('D14: the proposals and writes of the run reach Jev as evidence for the per-sentence check', async () => {
  const tok = run()
  const pid = /id (mp-[0-9a-f]+)/.exec(await propose(tok))![1]
  calls = []
  expect(await L.callLaneTool(tok, 'notify_joey', { outcome: 'normal', text: 'mock 服務的排程目前是 07:30 和 02:00，已交給主線決定。' })).toContain('sent to Joey')
  expect(reportCalls().length).toBe(1)
  const ev = reportCalls()[0].state.tool_results.find((r: any) => r.call === 'ledger (this run)')
  expect(ev.result).toContain(pid); expect(ev.result).toContain('A proposal is NOT a memory write'); expect(ev.result).toContain('Memory writes by this run: none'); expect(ev.result).toContain('Ledger records written by this run: none')
})
