// Universe 002l (S0 item 2): the router never starts a lane run on a session id that is live in another process (the CLI has no lock; two resumes of one id
// fork its history silently). design/stability 「重啟時接錯 session」; docs/en/sessions 「同一個 session id 同時在兩個行程接回，紀錄會交錯，沒有鎖」. No model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'fs'
import { spawn } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_FLOOD_CONTROL = '0'
process.env.LANES_SESSION_BUSY_RETRY_MS = '200'
const L = await import('./lanes.ts?pl-s0lock-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-pls0-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.sh'); writeFileSync(bin, '#!/bin/sh\nsleep 0.6\nexit 0\n'); chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
const strays: any[] = []
afterAll(() => { L.__setClaudeBin(restore); for (const p of strays) { try { p.kill('SIGKILL') } catch {} } delete process.env.LANES_FLOOD_CONTROL; delete process.env.LANES_SESSION_BUSY_RETRY_MS })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const st = L.__lanesState()
const rows = (): any[] => { try { return readFileSync(join(dir, 'lanes.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(25) } return f() }
const ev = (id: string, extra: object = {}) => ({ id, source: 'mesh', from: 'eve', verified: true, text: `問題 ${id}`, meta: {}, notif: { method: '', params: {} }, ...extra } as any)

test('S0: while a lane process runs, its session id is locked; the lock goes with the process', async () => {
  const d = await L.routeEvent(ev('m-1'))
  const sid = st.lanes[d.lane!].session_id
  expect(await until(() => existsSync(join(dir, 'run', 'sid', `${sid}.pid`)))).toBe(true)
  expect(L.sessionHolder(sid)).toBeGreaterThan(0)
  expect(await until(() => rows().some(r => r.kind === 'exit' && r.event === 'm-1'))).toBe(true)
  expect(existsSync(join(dir, 'run', 'sid', `${sid}.pid`))).toBe(false)
  expect(L.sessionHolder(sid)).toBeNull()
})

test('S0: another process resuming the lane\'s session id (not started by this daemon) holds back the lane\'s next run until it is gone; nothing is lost', async () => {
  const lane = Object.values(st.lanes)[0]
  const fake = spawn('/bin/sh', ['-c', 'sleep 1.5', 'claude', '--resume', lane.session_id], { stdio: 'ignore' })   // argv carries "--resume <sid>"
  strays.push(fake)
  await sleep(100)
  expect(L.sessionHolder(lane.session_id)).toBe(fake.pid!)
  const n = rows().filter(r => r.kind === 'spawn' && r.lane === lane.id).length
  const d = await L.routeEvent(ev('m-2', { thread: lane.thread, hop: 2 }))
  expect(d.lane).toBe(lane.id)
  await sleep(500)
  expect(rows().filter(r => r.kind === 'spawn' && r.lane === lane.id).length).toBe(n)          // not started while the other process lives
  expect(rows().some(r => r.kind === 'session_busy' && r.session_id === lane.session_id && r.holder === fake.pid)).toBe(true)
  expect(await until(() => rows().some(r => r.kind === 'spawn' && r.event === 'm-2'), 6000)).toBe(true)   // started once it is gone
  const sp = rows().find(r => r.kind === 'spawn' && r.event === 'm-2')!
  expect(sp.resume).toBe(true)
  await until(() => rows().some(r => r.kind === 'exit' && r.event === 'm-2'))
})

test('S0: a fork of a live session is not held back (it is a new id)', () => {
  const lane = { id: 'adam.fork.1', kind: 'fork', n: 1, session_id: 'x', thread: 't', status: 'new', created: '', last: '', transcript: '/nope', runs: 0, tokens_in: 0, tokens_out: 0, fork_from: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed' } as any
  expect(L.sessionArgs(lane).args).toEqual(['--resume', 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', '--fork-session'])
})
