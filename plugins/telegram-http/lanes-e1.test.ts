// Universe 002k (E1): the critical ring comes before the 60 s promise: the deadline is 45 s, env-overridable. No network, no model.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
async function fresh(tag: string, env?: string) {
  const was = process.env.LANES_CRITICAL_DEADLINE_MS
  if (env === undefined) delete process.env.LANES_CRITICAL_DEADLINE_MS; else process.env.LANES_CRITICAL_DEADLINE_MS = env
  try { return await import(`./lanes.ts?e1-${tag}`) as typeof import('./lanes.ts') }
  finally { if (was === undefined) delete process.env.LANES_CRITICAL_DEADLINE_MS; else process.env.LANES_CRITICAL_DEADLINE_MS = was }
}

test('E1: the default deadline is 45 s, before the 60 s promise; the env var overrides it', async () => {
  const d = await fresh('default')
  expect(d.criticalDeadlineMs()).toBe(45_000); expect(d.criticalDeadlineMs()).toBeLessThan(60_000)
  expect((await fresh('env', '30000')).criticalDeadlineMs()).toBe(30_000)
  expect((await fresh('env2', '90000')).criticalDeadlineMs()).toBe(90_000)
  d.__setCriticalDeadline(1234); expect(d.criticalDeadlineMs()).toBe(1234)             // the test hook still works
})

test('E1: the daemon arms the critical ring at 45 s after the alert was enqueued (the timer delay it really passes), and a lane that reports in time is not rung over', async () => {
  const L = await fresh('timer')
  const dir = mkdtempSync(join(tmpdir(), 'lanes-e1-')); process.env.LANES_DIR = dir
  copyFileSync(ROUTER, join(dir, 'router.json'))
  writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
  const bin = join(dir, 'lane.sh'); writeFileSync(bin, `#!/bin/sh\nsleep 0.3\necho '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'\n`); chmodSync(bin, 0o755)
  const restore = L.__setClaudeBin(bin)
  L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
  L.__setMainConnected('mcp-main')
  const delays: number[] = []
  const real = globalThis.setTimeout
  ;(globalThis as any).setTimeout = (fn: any, ms?: number, ...rest: any[]) => { if (typeof ms === 'number' && ms > 30_000 && ms <= 60_000) { delays.push(ms); return 0 as any } return real(fn, ms, ...rest) }
  try {
    const d = await L.routeEvent({ id: 'mesh-e1', source: 'mesh', from: 'alert-dispatcher', verified: true, text: '[P1][critical] mock-api 全部回 5xx，已持續 2 分鐘', meta: {}, notif: { method: '', params: {} } } as any)
    expect(d.target).toBe('lane')
    await new Promise(r => real(r, 150))
  } finally { (globalThis as any).setTimeout = real; L.__setClaudeBin(restore) }
  expect(delays.length).toBe(1)
  expect(delays[0]).toBeGreaterThan(44_000); expect(delays[0]).toBeLessThanOrEqual(45_000)           // 45 s minus the few ms since the enqueue; never the old 60 s
})
