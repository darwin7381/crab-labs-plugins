// Universe 002k: a peer's messages that queue for a busy lane are handled in one run (finding I1). The lane process is a script.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?coal-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-coal-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.sh'); writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$2" >> ${dir}/prompts.log\nsleep 0.6\necho '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'\n`); chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => L.__setClaudeBin(restore))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const rows = (n: string): any[] => { try { return readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(30) } return f() }
const ev = (id: string, from: string, text: string, extra: object = {}) => ({ id, source: 'mesh', from, verified: true, text, meta: {}, notif: { method: '', params: {} }, ...extra } as any)

test('two follow-ups from the same peer that arrive while the lane runs are handled together in its next run', async () => {
  const d1 = await L.routeEvent(ev('mesh-61', 'eve', 'mock-api 的 /v2/notifications 今天會不會維護？'))
  expect(d1.target).toBe('lane')
  const th = Object.values(L.__lanesState().threads).find(t => t.lane === d1.lane)!.id
  await sleep(100)
  await L.routeEvent(ev('mesh-62', 'eve', '補充：我 14:00 要用。', { thread: th, hop: 2, reply_to_id: 'x' }))
  await L.routeEvent(ev('mesh-63', 'eve', '如果會維護，能不能延到 15:00 之後？', { thread: th, hop: 3, reply_to_id: 'x' }))
  expect(await until(() => rows('lanes.jsonl').filter(r => r.kind === 'exit').length >= 2)).toBe(true)
  await sleep(300)
  const spawns = rows('lanes.jsonl').filter(r => r.kind === 'spawn' && r.lane === d1.lane)
  expect(spawns.length).toBe(2)                                                        // two runs for three messages
  expect(rows('routing.jsonl').filter(r => r.rule === 'coalesced').map(r => r.event)).toEqual(['mesh-63'])
  const prompts = readFileSync(join(dir, 'prompts.log'), 'utf8')
  expect(prompts).toContain('又來了 1 則'); expect(prompts).toContain('15:00')
})

test('a scheduled run or an alert for the same lane is never merged', async () => {
  const st = L.__lanesState()
  const before = rows('routing.jsonl').filter(r => r.rule === 'coalesced').length
  const d = await L.routeEvent(ev('mesh-71', 'scheduler', '[scheduled][hourly-backup-check][run:1][normal][ops] 查備份', { verified: true }))
  expect(d.target).toBe('lane')
  await L.routeEvent(ev('mesh-72', 'scheduler', '[scheduled][hourly-backup-check][run:2][normal][ops] 查備份', { verified: true }))
  await sleep(2500)
  expect(rows('routing.jsonl').filter(r => r.rule === 'coalesced').length).toBe(before)
  expect(Object.keys(st.lanes).length).toBeGreaterThan(0)
})
