// 1.53.1 (Mnemosyne #12058, Chiron #12069): a main whose SessionStart never reached the daemon is adopted on its next hook event when its session is
// the registered one (main-expected); a different session is not adopted, and a live gen of another process is not replaced by a non-SessionStart event.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
const L = await import('./lanes.ts?adopt-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-adopt-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const open = new Set<string>()
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  notifySession: async (sid: string) => open.has(sid), streamOpen: (sid: string) => open.has(sid), toolsChanged: () => {},
  sendBot: async () => 301, joeyChatId: () => '1' } as any)
const procs: any[] = []
afterAll(() => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } })
function proc(): number { const p = Bun.spawn(['sleep', '600']); procs.push(p); return p.pid }
const M = () => L.__main()

test('a registered session whose SessionStart was missed is adopted on its next hook event; another session is not; a live gen is not replaced', async () => {
  const sid = randomUUID(), pid = proc()
  writeFileSync(join(dir, 'main-expected'), sid)
  open.add(`mcp-${pid}`); L.__noteMcpPid(`mcp-${pid}`, pid)
  expect(M().currentGen()).toBeFalsy()
  // a stranger's event (another session id) adopts nothing
  const other = proc()
  await L.__mainEvent({ event: 'UserPromptSubmit', pid: other, session_id: randomUUID(), prompt_id: 'x1' })
  expect(M().currentGen()).toBeFalsy()
  // the registered session's first event after a missed SessionStart: adopted, and the event is handled (a turn opens)
  await L.__mainEvent({ event: 'UserPromptSubmit', pid, session_id: sid, prompt_id: 'p1' })
  const g = M().currentGen()
  expect(g && Number(g.pid)).toBe(pid)
  expect(g!.state).toBe('in_turn')
  // a later non-SessionStart event of another process with the same session id does not replace the live gen
  const pid3 = proc()
  await L.__mainEvent({ event: 'PreToolUse', pid: pid3, session_id: sid, tool_name: 'Bash' })
  expect(Number(M().currentGen()!.pid)).toBe(pid)
})
