// Universe 002j: the model wall (usage limit, overload).
//   - a lane run that ends with the API's limit error is not a failed attempt: the event goes back to the queue untouched
//   - with the wall up nothing is dispatched, Joey is told once, one event is tried again as a probe at an interval
//   - the first run that gets through takes the wall down, Joey is told once, the queue runs
//   - a critical alert that arrives behind the wall is rung through at once
// The "lane process" is a shell script that prints the result record claude prints (stream-json): no model, no network.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { lanesInit, routeEvent, walledResult, wallActive, __lanesState, __setMainConnected, __setRetryBackoff, __setClaudeBin, __setWallProbe } from './lanes.ts'

const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-wall-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const sent: string[] = []
const script = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p }
const WALLED = script('walled.sh', `sleep 0.1\necho '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You have hit your weekly limit · resets 5:48pm (Asia/Taipei)"}'\nexit 1`)
const OK = script('ok.sh', `sleep 0.1\necho '{"type":"result","subtype":"success","is_error":false,"result":"done"}'\nexit 0`)
const restore = __setClaudeBin(WALLED)
__setRetryBackoff(20); __setWallProbe(400)
afterAll(() => { __setClaudeBin(restore); __setRetryBackoff(5000); __setWallProbe(300_000) })
lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'],
  sendBot: async (_c: string, text: string) => { sent.push(text); return 3000 + sent.length }, joeyChatId: () => '1' } as any)
__setMainConnected('mcp-main')
const rows = (name: string): any[] => { try { return readFileSync(join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const ev = (id: string, text: string) => ({ id, source: 'mesh', from: 'scheduler', verified: true, text, meta: {}, notif: { method: 'notifications/claude/channel', params: { content: 'x', meta: {} } } } as any)

test('the wall is read from the run\'s own result record', () => {
  expect(walledResult({ type: 'result', is_error: true, api_error_status: 429, result: "You've hit your weekly limit · resets 5pm" })).toEqual({ kind: 'usage', text: "You've hit your weekly limit · resets 5pm" })
  expect(walledResult({ type: 'result', is_error: true, api_error_status: 529, result: 'Overloaded' })?.kind).toBe('overload')
  expect(walledResult({ type: 'result', is_error: true, api_error_status: 500, result: 'API Error' })?.kind).toBe('error')
  expect(walledResult({ type: 'result', is_error: false, result: 'done' })).toBeNull()
  expect(walledResult({ type: 'result', is_error: true, result: 'the tool failed' })).toBeNull()        // an ordinary failed run is not a wall
})

test('a walled run is not an attempt; nothing else is dispatched; Joey is told once; a probe runs at the interval', async () => {
  await routeEvent(ev('mesh-w1', '[scheduled][hourly-backup-check][run:47][normal][ops] 查備份'))
  await routeEvent(ev('mesh-w2', '[scheduled][daily-ticket-digest][run:12][normal][ops] 工單摘要'))
  expect(await until(() => wallActive())).toBe(true)
  await sleep(150)
  const spawns = () => rows('lanes.jsonl').filter(r => r.kind === 'spawn')
  expect(rows('lanes.jsonl').filter(r => r.kind === 'walled').length).toBeGreaterThanOrEqual(1)
  expect(sent.filter(t => t.includes('額度')).length).toBe(1)                                   // told once
  expect(sent[0]).toContain('一件都沒有丟'); expect(sent[0]).toContain('weekly limit')
  expect(rows('ledger.jsonl').some(r => r.kind === 'escalation')).toBe(false)                    // nothing handed to the main as "failed three times"
  const before = spawns().length
  expect(await until(() => spawns().length > before, 2000)).toBe(true)                           // the probe
  await sleep(200)
  expect(spawns().length).toBe(before + 1)                                                       // exactly one run per probe
  expect(sent.filter(t => t.includes('額度')).length).toBe(1)                                   // still told once
})

test('a critical alert behind the wall is rung through at once', async () => {
  const n = sent.length
  await routeEvent({ id: 'mesh-w3', source: 'mesh', from: 'alert-dispatcher', verified: true, text: '[P1][critical] mock-backup 連續兩次失敗（alert A-1103）', meta: {},
    notif: { method: 'notifications/claude/channel', params: { content: 'x', meta: {} } } } as any)
  expect(await until(() => sent.length > n, 1500)).toBe(true)
  expect(sent[sent.length - 1]).toContain('嚴重警報'); expect(sent[sent.length - 1]).toContain('A-1103'); expect(sent[sent.length - 1]).toContain('沒有車道能查證')
})

test('the first run that gets through takes the wall down; Joey is told once; the queue runs', async () => {
  __setClaudeBin(OK)
  expect(await until(() => !wallActive(), 4000)).toBe(true)
  expect(await until(() => sent.some(t => t.includes('模型恢復了')))).toBe(true)
  expect(sent.filter(t => t.includes('模型恢復了')).length).toBe(1)
  expect(await until(() => ['mesh-w1', 'mesh-w2', 'mesh-w3'].every(id => rows('lanes.jsonl').some(r => r.kind === 'exit' && r.event === id && r.exit_code === 0)), 5000)).toBe(true)
  const st = __lanesState()
  expect(st.wall).toBeUndefined()
  expect(rows('ledger.jsonl').some(r => r.kind === 'escalation' && String(r.text).includes("次沒處理完"))).toBe(false)   // no event was written off as failed three times
})
