// Universe 002k: the main stuck in one tool call (G03). No network, no model.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openToolCallFile } from './liveness.ts'
const L = await import('./lanes.ts?g03-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-g03-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const T = join(dir, 'main.jsonl')
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: T, claude_pid: 1, registered_at: new Date().toISOString() }))
const sent: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'],
  sendBot: async (_c: string, text: string) => { sent.push(text); return 8000 + sent.length }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const rec = (o: object) => JSON.stringify(o) + '\n'
const iso = (ms: number) => new Date(ms).toISOString()
const now = Date.now()
const prompt = (ms: number, text: string) => rec({ type: 'user', isMeta: true, timestamp: iso(ms), message: { role: 'user', content: text } })
const call = (ms: number, id: string, cmd: string) => rec({ type: 'assistant', timestamp: iso(ms), message: { model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: cmd } }] } })
const result = (ms: number, id: string) => rec({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
const enqueue = (ms: number) => rec({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(ms), content: '<channel ...>還在嗎？</channel>' })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 3000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }

test('the open tool call is read from the transcript; a finished call or a finished turn is not open', () => {
  const f = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, body); return p }
  expect(openToolCallFile(f('a.jsonl', prompt(now - 9000, '匯出') + call(now - 8000, 'tu1', './bin/svc GET mock-api/admin/export') + enqueue(now - 2000))))
    .toMatchObject({ id: 'tu1', tool: 'Bash', input: './bin/svc GET mock-api/admin/export', since: now - 8000, queued: 1 })
  expect(openToolCallFile(f('b.jsonl', prompt(now - 9000, 'x') + call(now - 8000, 'tu1', 'ls') + result(now - 7000, 'tu1')))).toBeNull()
  expect(openToolCallFile(f('c.jsonl', prompt(now - 9000, 'x') + call(now - 8000, 'tu1', 'ls') + rec({ type: 'system', subtype: 'turn_duration' })))).toBeNull()
})

test('past the threshold Joey is told once what the main is running and that messages wait; when the call ends, once that it is free', async () => {
  L.__setMainStuckMs(5_000)
  writeFileSync(T, prompt(now - 60_000, '把 /admin/export 的資料匯出來') + call(now - 50_000, 'tu9', './bin/svc GET mock-api/admin/export') + enqueue(now - 1000))
  L.mainStuckTick()
  expect(await until(() => sent.length === 1)).toBe(true)
  expect(sent[0]).toContain('主線卡住了'); expect(sent[0]).toContain('admin/export'); expect(sent[0]).toContain('1 則訊息排在它後面'); expect(sent[0]).toContain('/kill_stuck')
  expect(L.lanesHealth().main_stuck).toBe(true)
  L.mainStuckTick(); await sleep(40)
  expect(sent.length).toBe(1)                                          // once per stuck call
  appendFileSync(T, result(Date.now(), 'tu9'))
  L.mainStuckTick()
  expect(await until(() => sent.length === 2)).toBe(true)
  expect(sent[1]).toContain('指令結束了')
  expect(L.lanesHealth().main_stuck).toBe(false)
  const rules = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).refs?.tier_rule)
  expect(rules.filter(r => r === 'main-stuck').length).toBe(1); expect(rules.filter(r => r === 'main-unstuck').length).toBe(1)
})

test('below the threshold, nothing is said', async () => {
  L.__setMainStuckMs(600_000)
  writeFileSync(T, prompt(now - 60_000, 'x') + call(now - 50_000, 'tu10', 'make build'))
  L.mainStuckTick(); await sleep(40)
  expect(sent.length).toBe(2)
})
