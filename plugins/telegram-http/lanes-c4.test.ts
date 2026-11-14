// Universe 002k (C4): a message from the main to a peer closes only the promises it answers (thread, then reply_to, then Jev's choice
// over the open promise texts); the rest stay open and still ring at their due time. Jev is a local stand-in.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
let server: any, mode: 'bulk' | 'none' | 'weak' | 'fail' | 'off' = 'bulk', calls = 0, lastBody: any = null
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    calls++
    const body = await req.json() as any; lastBody = body
    if (mode === 'fail') return new Response('<html>blocked</html>', { status: 503 })
    const open: Array<{ id: string; text: string }> = body.state.open_requests
    const bulk = open.find(o => o.text.includes('bulk'))
    if (mode === 'none') return Response.json({ answers: { which: { type: 'choice', choice: 'none', confidence: 0.95 } } })
    if (mode === 'weak') return Response.json({ answers: { which: { type: 'choice', choice: bulk?.id ?? 'none', confidence: 0.4 } } })
    return Response.json({ answers: { which: { type: 'choice', choice: bulk?.id ?? 'none', confidence: 0.92 } } })
  } })
  process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.port}`; process.env.TYPESAFE_API_KEY = 'k'
})
afterAll(() => server.stop(true))
const L = await import('./lanes.ts?c4-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-c4-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const sent: string[] = [], logs: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: (_l: string, m: string) => { logs.push(m) },
  deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'], sendBot: async (_c: string, t: string) => { sent.push(t); return 1 }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const st = L.__lanesState()
const rows = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
// the three open promises to eve of the group-C run: three threads, three topics
function reset(): void {
  for (const k of Object.keys(st.promises)) delete st.promises[k]
  const mk = (id: string, thread: string, what: string, req: string, sentId: string) =>
    st.promises[id] = { id, peer: 'eve', thread, event: `ev-${id}`, what, created: Date.now(), due: Date.now() + 1_800_000, state: 'open', handoff: `h-${id}`, req, sent: sentId } as any
  mk('pr-maint', 'adam#t-maint', 'Eve 問 mock-api 維護時段與提前通知多久', '50010', '60001')
  mk('pr-bulk', 'adam#t-bulk', 'Eve 要在 mock-api 加 /v2/orders/bulk 端點，週五前', '50025', '60002')
  mk('pr-prev', 'adam#t-prev', 'Eve 問能不能多開一個 /preview 端點給她測', '50030', '60003')
  mode = 'bulk'; calls = 0
}
const state = (id: string) => st.promises[id].state
const BULK_TEXT = '/v2/orders/bulk 還沒有答應。這是 mock-api 的程式變更，要 Joey 決定做不做、誰做、哪個週五。'

test('C4: by thread: only the promise on that thread is closed', async () => {
  reset()
  await L.mainSentTo('eve', 'adam#t-bulk', null, '隨便一段話')
  expect(state('pr-bulk')).toBe('kept'); expect(st.promises['pr-bulk'].matched).toBe('thread')
  expect(state('pr-maint')).toBe('open'); expect(state('pr-prev')).toBe('open'); expect(calls).toBe(0)       // no Jev needed
})

test('C4: by reply_to: quoting the peer\'s request, or the router\'s interim message, closes that one only', async () => {
  reset()
  await L.mainSentTo('eve', null, '50030', '好')
  expect(state('pr-prev')).toBe('kept'); expect(st.promises['pr-prev'].matched).toBe('reply_to'); expect(state('pr-maint')).toBe('open'); expect(state('pr-bulk')).toBe('open')
  await L.mainSentTo('eve', null, 60001, '好')
  expect(state('pr-maint')).toBe('kept'); expect(state('pr-bulk')).toBe('open'); expect(calls).toBe(0)
})

test('C4: the group-C case: one message to Eve about another topic closes none of the two other threads', async () => {
  reset()
  await L.mainSentTo('eve', null, null, BULK_TEXT)                                   // neither thread nor reply_to: Jev chooses among the open promise texts
  expect(calls).toBe(1)
  expect(lastBody.state.open_requests.map((o: any) => o.id)).toEqual(['pr-maint', 'pr-bulk', 'pr-prev'])
  expect(lastBody.questions.which.criteria).toHaveProperty('none')                  // "none" is an allowed answer
  expect(state('pr-bulk')).toBe('kept'); expect(st.promises['pr-bulk'].matched).toBe('jev')
  expect(state('pr-maint')).toBe('open'); expect(state('pr-prev')).toBe('open')
  expect(rows().filter(r => r.refs?.matched === 'jev').length).toBe(1)
  mode = 'none'; reset(); mode = 'none'
  await L.mainSentTo('eve', null, null, '另一個話題：週三的值班表我晚點給你。')
  expect(['pr-maint', 'pr-bulk', 'pr-prev'].map(state)).toEqual(['open', 'open', 'open'])        // none of them
  mode = 'weak'; reset(); mode = 'weak'
  await L.mainSentTo('eve', null, null, BULK_TEXT)
  expect(['pr-maint', 'pr-bulk', 'pr-prev'].map(state)).toEqual(['open', 'open', 'open'])        // below 0.7
})

test('C4: a Jev failure is an error, never an answer: nothing closes, it is logged; no text, no question', async () => {
  reset(); mode = 'fail'
  const w = logs.length
  await L.mainSentTo('eve', null, null, BULK_TEXT)
  expect(['pr-maint', 'pr-bulk', 'pr-prev'].map(state)).toEqual(['open', 'open', 'open'])
  expect(logs.slice(w).some(m => m.includes('promise match') && m.includes('nothing closed'))).toBe(true)
  const rec = readFileSync(join(dir, 'run', 'promise-match.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).pop()
  expect(rec.error).toBeTruthy()
  reset(); const c = calls
  await L.mainSentTo('eve', null, null, ''); await L.mainSentTo('eve', null, null)
  expect(calls).toBe(c); expect(['pr-maint', 'pr-bulk', 'pr-prev'].map(state)).toEqual(['open', 'open', 'open'])
  await L.mainSentTo('cain', 'adam#t-bulk', null, 'x')                                  // another peer: nothing of eve's closes
  expect(['pr-maint', 'pr-bulk', 'pr-prev'].map(state)).toEqual(['open', 'open', 'open'])
})

test('C4: what stays open still rings at its due time; what was closed does not', async () => {
  reset()
  await L.mainSentTo('eve', 'adam#t-bulk', null, BULK_TEXT)
  for (const p of Object.values(st.promises)) p.due = Date.now() - 1
  L.promiseTick(); await sleep(60)
  const over = rows().filter(r => r.refs?.tier_rule === 'promise-overdue')
  expect(over.length).toBe(2); expect(over.map(r => r.refs.promise).sort()).toEqual(['pr-maint', 'pr-prev'])
  expect(sent.length).toBe(2)
  expect(state('pr-maint')).toBe('overdue'); expect(state('pr-bulk')).toBe('kept')
  await L.mainSentTo('eve', 'adam#t-maint', null, '維護時段是每週三 02:00–03:00')           // a late answer is still recorded as late
  expect(rows().some(r => r.kind === 'fyi' && String(r.text).includes('過了時間才回') && r.refs.promise === 'pr-maint')).toBe(true)
})
