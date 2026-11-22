// Universe 002k (B20): lanes get a read-only ledger_query with the main's filters. No network, no model.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?b20-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-b20-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
const st = L.__lanesState()
st.lanes['adam.reflex.1'] = { id: 'adam.reflex.1', kind: 'reflex', n: 1, session_id: 's', thread: 'adam#t-b20', status: 'running', created: '', last: '', transcript: '/x', runs: 0, tokens_in: 0, tokens_out: 0 } as any
const tok = { runId: 'adam.reflex.1.r1', lane: 'adam.reflex.1', evId: 'ev-b20', closers: [], critical: false, trigger: 'alert', cls: 'alert', escalated: false, pushed: false } as any
const lines = (): string[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean) } catch { return [] } }
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()
writeFileSync(join(dir, 'ledger.jsonl'), [
  { ts: hoursAgo(30), lane: 'adam.reflex.7', thread: 'adam#t-old', event: 'e0', kind: 'action', text: '重啟 mock-api（30 小時前）', notify_main: false },
  { ts: hoursAgo(20), lane: 'adam.reflex.8', thread: 'adam#t-a', event: 'e1', kind: 'action', text: '重啟 mock-api（p95 過高）', notify_main: false },
  { ts: hoursAgo(9), lane: 'adam.reflex.9', thread: 'adam#t-b', event: 'e2', kind: 'action', text: '重啟 mock-api（5xx）', notify_main: false },
  { ts: hoursAgo(2), lane: 'adam.reflex.10', thread: 'adam#t-c', event: 'e3', kind: 'notify', text: '[silent] mock-api 已恢復', notify_main: true },
].map(r => JSON.stringify(r)).join('\n') + '\n')

test('B20: ledger_query is a lane tool with the same filters as the main\'s', () => {
  const t = L.LANE_TOOLS.find(x => x.name === 'ledger_query')!
  expect(t).toBeTruthy()
  expect(Object.keys((t.inputSchema as any).properties)).toEqual(['since', 'kind', 'text'])
  const m = L.mainToolDefs().find(x => x.name === 'ledger_query')
  expect(Object.keys(m.inputSchema.properties)).toEqual(Object.keys((t.inputSchema as any).properties))
  expect(t.description).toContain('read only'); expect(t.description.length).toBeLessThan(800)       // loaded in every call of every lane
  expect(L.isMainTool('ledger_query')).toBe(true)                                                       // the main keeps its own
})

test('B20: a lane counts the restarts of the last 24 hours itself, and the call writes nothing', async () => {
  const before = lines().join('\n')
  const out = await L.callLaneTool(tok, 'ledger_query', { since: '-24h', kind: 'action', text: '重啟 mock-api' })
  expect(out).toContain('符合 2 筆')                                         // the 30-hour-old restart is outside the window
  expect(out).toContain('p95 過高'); expect(out).toContain('5xx'); expect(out).not.toContain('30 小時前')
  expect(lines().join('\n')).toBe(before)                                      // read only: nothing was appended
  const all = await L.callLaneTool(tok, 'ledger_query', {})                    // no filter: the activity list
  expect(all).toContain('活動清單')
  expect(await L.callLaneTool(tok, 'ledger_query', { kind: 'notify' })).toContain('已恢復')
  expect(lines().join('\n')).toBe(before)
})
