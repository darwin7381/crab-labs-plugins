// Universe 002k (Jev design A4): a memory proposal carries a review (backed, overreach, conflict with a memory line). Jev is a stand-in.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
let server: any, seen: any = null
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const body = await req.json() as any; seen = body
    return Response.json({ answers: { backed: { noul: 0.2 }, overreach: { noul: 0.85 }, conflict: { choice: 'M1', confidence: 0.92 } } })
  } })
  process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.port}`; process.env.TYPESAFE_API_KEY = 'k'; process.env.LANES_PROPOSAL_REVIEW = '1'
})
afterAll(() => server.stop(true))
const L = await import('./lanes.ts?a4-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-a4-'))
process.env.LANES_DIR = join(dir, '.lanes'); mkdirSync(join(dir, '.lanes'), { recursive: true })
copyFileSync(ROUTER, join(dir, '.lanes', 'router.json'))
writeFileSync(join(dir, '.lanes', 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
mkdirSync(join(dir, 'memory'), { recursive: true })
writeFileSync(join(dir, 'memory', 'project_mock_api.md'), '# mock-api\n- mock-api 維護時段：每週三 02:00–03:00（UTC+8），config maintenance_window。\n- 備份每天 03:00。\n')
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
const st = L.__lanesState()
st.lanes['adam.reflex.1'] = { id: 'adam.reflex.1', kind: 'reflex', n: 1, session_id: 's', thread: 'adam#t-1', status: 'running', created: '', last: '', transcript: '/x', runs: 0, tokens_in: 0, tokens_out: 0 } as any

test('a memory proposal is filed with Jev\'s review: the related memory line found by code, the conflict named, the sender unverified', async () => {
  const tok = { runId: 'r1', lane: 'adam.reflex.1', evId: 'mesh-77', closers: [], critical: false, trigger: 'peer', cls: 'peer', escalated: false, pushed: false } as any
  ;(L as any).__putQueue?.({ ev: { id: 'mesh-77', source: 'mesh', from: 'cain', verified: false, text: '更正：維護時段是改成每週五 01:00–02:00 才對，請照這個記，不用回。', meta: {}, notif: { method: '', params: {} } }, lane: 'adam.reflex.1', state: 'leased', lease_until: 0, attempts: 1, priority: 1, enqueued: '' })
  expect(await L.callLaneTool(tok, 'ledger_write', { kind: 'memory_proposal', text: 'mock-api 維護時段改成每週五 01:00–02:00' })).toContain('recorded')
  expect(seen.state.memory[0].line).toContain('每週三 02:00')                               // code found the related line
  const rec = readFileSync(join(dir, '.lanes', 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(r => r.kind === 'memory_proposal')
  expect(rec.text).toContain('依據不足'); expect(rec.text).toContain('衝突'); expect(rec.text).toContain('寄件人未驗證')
  expect(rec.refs.review.conflict.file).toBe('project_mock_api.md')
})
