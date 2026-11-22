// 002w (found while building E): offerNext awaits the offer, and the main can take the item in meanwhile (its UserPromptSubmit names it, did, and binds
// it). 2a936a7 then wrote `offered` over `bound`, and a taken item could be offered again (stuck_unbound): a second delivery. Only an item still queued
// becomes offered now. A stand-in main whose stream takes the offer and submits its prompt before the offer call returns.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?w-race-test') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-w-race-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
const open = new Set<string>()
let g: { pid: number; sid: string } | null = null
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  notifySession: async (sid: string, n: any) => {
    if (!open.has(sid)) return false
    const did = String(n?.params?.meta?.did ?? '')
    if (g && did) await L.__mainEvent({ event: 'UserPromptSubmit', pid: g.pid, session_id: g.sid, prompt_id: 'pr-1', dids: [did] } as any)   // taken in before the offer returns
    return true
  }, streamOpen: (sid: string) => open.has(sid), toolsChanged: () => {},
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
const procs: any[] = []
afterAll(() => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } delete process.env.LANES_FLOOD_CONTROL })
const M = () => L.__main()

test('002w M1 race: an item the main took in while its offer was awaited stays bound; it is never written back to offered', async () => {
  const proc = Bun.spawn(['sleep', '600']); procs.push(proc)
  const sid = randomUUID(), mcp = `mcp-${proc.pid}`
  writeFileSync(join(dir, 'main-expected'), sid); open.add(mcp); L.__noteMcpPid(mcp, proc.pid)
  await L.__mainEvent({ event: 'SessionStart', pid: proc.pid, session_id: sid, source: 'startup' } as any)
  g = { pid: proc.pid, sid }
  const meta = { chat_id: '1', message_id: '9901', user: 'joey_lab' }
  await L.routeEvent({ id: 'tg-1-9901', source: 'telegram', from: 'joey', text: '現在怎樣？', meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: '現在怎樣？', meta } } } as any)
  await M().pump()
  await new Promise(r => setTimeout(r, 150))                         // the offer routeEvent started is awaited to its end
  const it = M().items(r => r.event === 'tg-1-9901' && r.kind !== 'digest')[0]
  expect(it.state).toBe('bound'); expect(it.prompt_id).toBe('pr-1')
  expect(M().items(r => r.state === 'offered').length).toBe(0)
})
