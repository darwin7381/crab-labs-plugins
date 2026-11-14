// Universe 002k: every lane turn leaves Joey a line (DC1) and critical alerts are marked must-know (RT4). No network, no model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
const L = await import('./lanes.ts?dc1-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-dc1-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
// a lane process that "answers Eve" without a line for Joey: it prints the stream records of a reply_agent and a receipt call
const bin = join(dir, 'lane.sh')
writeFileSync(bin, `#!/bin/sh\necho '{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","name":"mcp__lane__reply_agent","input":{"to":"eve","text":"今天 /v2/notifications 不在維護，14:00 可以用。"}},{"type":"tool_use","name":"mcp__lane__receipt","input":{"outcome":"done","did":"回覆 eve"}}],"usage":{}}}'\necho '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'\n`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => L.__setClaudeBin(restore))
const sent: Array<{ text: string; silent: boolean }> = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'],
  sendBot: async (_c: string, text: string, o: any) => { sent.push({ text, silent: !!o?.silent }); return 9300 + sent.length }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const rows = (n: string): any[] => { try { return readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(30) } return f() }
const ev = (id: string, from: string, text: string) => ({ id, source: 'mesh', from, verified: true, text, meta: {}, notif: { method: '', params: {} } } as any)

test('a lane that answered a peer with reply_agent alone: the daemon leaves Joey the line, at the class tier (silent for a peer)', async () => {
  await L.routeEvent(ev('mesh-81', 'eve', 'mock-api 的 /v2/notifications 今天會不會維護？'))
  expect(await until(() => sent.length === 1)).toBe(true)
  expect(sent[0].text).toContain('eve 的訊息我處理了'); expect(sent[0].text).toContain('14:00 可以用'); expect(sent[0].silent).toBe(true)
  expect(rows('ledger.jsonl').some(r => String(r.refs?.tier_rule ?? '').endsWith('never-silent-backstop'))).toBe(true)
})

test('a high-frequency routine that ends with the receipt alone stays quiet', async () => {
  writeFileSync(bin, `#!/bin/sh\necho '{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","name":"mcp__lane__receipt","input":{"outcome":"nothing-to-do","run_id":"47"}}],"usage":{}}}'\necho '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'\n`)
  const n = sent.length
  await L.routeEvent(ev('mesh-82', 'scheduler', '[scheduled][hourly-backup-check][run:47][normal][ops][high-frequency] 每小時備份檢查'))
  await sleep(1500)
  expect(sent.length).toBe(n)
})

test('the stop hook: reply_agent alone is not a line for Joey; a high-frequency receipt is', () => {
  const hook = join(import.meta.dir, 'lanes-hooks', 'lane-stop-hook.py')
  const t = join(dir, 'lane-t.jsonl')
  const run = (prompt: string, tools: string[]) => {
    writeFileSync(t, JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n'
      + JSON.stringify({ type: 'assistant', message: { content: tools.map(n => ({ type: 'tool_use', name: `mcp__lane__${n}`, input: {} })) } }) + '\n')
    const r = spawnSync('python3', [hook], { input: JSON.stringify({ transcript_path: t, session_id: `s-${Math.random()}` }), env: { ...process.env, LANES_DIR: dir }, encoding: 'utf8' })
    return r.stdout.includes('"block"') ? 'block' : 'end'
  }
  expect(run('[車道事件] eve 問維護', ['reply_agent', 'receipt'])).toBe('block')
  expect(run('[車道事件] eve 問維護', ['reply_agent', 'notify_joey', 'receipt'])).toBe('end')
  expect(run('[scheduled][hourly-backup-check][run:47][normal][ops][high-frequency] 檢查', ['receipt'])).toBe('end')
  expect(run('[scheduled][daily-ticket-digest][run:12][normal][ops] 工單摘要', ['receipt'])).toBe('block')
  expect(run('[車道事件] 交給主線', ['handoff_main', 'receipt'])).toBe('end')
})
