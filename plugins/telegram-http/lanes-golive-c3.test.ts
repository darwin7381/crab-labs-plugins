// lanes-golive C3: one entrance into the main. With lanes on the router is the only path that writes into the main session (hub sync, which handed its
// rows to the router, was removed in 1.52.0, WO-158); parked deliveries go back through the router; the main's taking an item (M1 bound) is the one
// delivery count, and for a scheduler run it sends the start receipt once.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
const L = await import('./lanes.ts?golive-c3') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-golive-c3-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
const open = new Set<string>(), offers: any[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  notifySession: async (sid: string, notif: any) => { if (!open.has(sid)) return false; offers.push({ sid, notif }); return true },
  streamOpen: (sid: string) => open.has(sid), sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setWallProbe(3_600_000)
const acks: string[] = []
L.__setAckHook(r => acks.push(r))
const procs: any[] = []
afterAll(() => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } L.__setAckHook(null); L.__setWallProbe(300_000) })
const M = () => L.__main()

test('C3: a scheduler run the router gives the main gets its start receipt when the main\'s turn takes it (M1 bound), once', async () => {
  const proc = Bun.spawn(['sleep', '600']); procs.push(proc)
  const sid = randomUUID()
  writeFileSync(join(dir, 'main-expected'), sid)
  open.add('mcp-main'); L.__noteMcpPid('mcp-main', proc.pid)
  expect((await L.__mainEvent({ event: 'SessionStart', pid: proc.pid, session_id: sid, source: 'startup' })).accepted).toBe(true)
  await M().pump()
  await L.lanesCommand('/lanes off', 'test')                         // the master switch: everything to the main (so the scheduled run is the main's)
  const text = '[scheduled][daily-check][run:4242] 每日檢查'
  const d = await L.routeEvent({ id: 'mesh-sched-1', source: 'mesh', from: 'scheduler', verified: true, text, meta: { run_id: '4242' },
    notif: { method: 'notifications/claude/channel', params: { content: text, meta: { run_id: '4242' } } } } as any)
  expect(d.target).toBe('main')
  await M().pump()
  const item = M().items(r => r.event === 'mesh-sched-1')[0]
  expect(item.via).toBe('inbox')                                      // a mesh item goes out on the agent-inbox stream (no inbox daemon here: it stays queued)
  expect(acks).toEqual([])                                            // queued or offered is not taken
  await L.__mainEvent({ event: 'UserPromptSubmit', pid: proc.pid, session_id: sid, prompt_id: 'p-1', dids: [item.id] })
  expect(M().items(r => r.id === item.id)[0].state).toBe('bound')
  expect(acks).toEqual(['4242'])
  await L.__mainEvent({ event: 'Stop', pid: proc.pid, session_id: sid, prompt_id: 'p-1', phase: 'final' })
  await L.__mainEvent({ event: 'UserPromptSubmit', pid: proc.pid, session_id: sid, prompt_id: 'p-2', dids: [item.id] })
  expect(acks).toEqual(['4242'])                                      // once per run
  await L.lanesCommand('/lanes on', 'test')
})

test('C3 server.ts: the lanes /inject branch goes to the router (no hub doorbell since 1.52.0), parked deliveries go back through the router', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  // WO-141 phase 2: the fleet-path fallback stays on for everything but the mailbox's ring (mail-ring.test.ts)
  expect(src).toContain('const d = await laneDeliverMesh(notification, verdict.verified, !ring)')
  expect(src).toContain('if (!(await laneRedeliver(notif))) break')
  // WO-158: hub sync is gone (no 30 s sync, no doorbell); an older process's parked doorbells are handed on once at start
  for (const gone of ['HubSync', 'hubSyncMode', 'laneHubPush', 'rememberHubMeta', 'hub.doorbell', "hub?.kick(", '/api/mesh/inbox/pending']) expect(src).not.toContain(gone)
  expect(src).toContain('void drainLeftoverDoorbells(STATE_DIR, (chatId, n) => dispatchInbound(chatId, n), log)')
  const doc = readFileSync(join(import.meta.dir, 'docs', 'state-journal.md'), 'utf8')
  expect(doc).toContain('## lanes-golive: who owns what on the fleet (one entrance into the main)')
})
