// lanes-golive (Chiron, knowledge/line8-delivery-20261122/report.md): a SessionStart hook's context reached the conversation in only 25 of 334 resumes
// (startup, clear and compact do get it). A lanes main is started with --resume <id>, so its main-only rules (mainContext) go with the session's first
// prompt instead (UserPromptSubmit: a typed prompt or a delivered item), once per session, and again after a compaction. Registration stays at SessionStart.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { mainSettings } from './lanes-launch.ts'
const L = await import('./lanes.ts?golive-rules') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-golive-rules-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, sendBot: async () => 1, joeyChatId: () => '1' } as any)
const procs: any[] = []
afterAll(() => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } })
const RULES = '你是 adam 的主線'
async function main(source: string) {
  const proc = Bun.spawn(['sleep', '600']); procs.push(proc)
  const sid = randomUUID(); writeFileSync(join(dir, 'main-expected'), sid)
  const r = await L.__mainEvent({ event: 'SessionStart', pid: proc.pid, session_id: sid, source })
  return { r, ev: (event: string, o: object = {}) => L.__mainEvent({ event, pid: proc.pid, session_id: sid, ...o }) }
}

test('a resumed main: SessionStart registers it (no context, it would be lost); its first prompt carries the main-only rules, the next one not', async () => {
  const m = await main('resume')
  expect(m.r.accepted).toBe(true); expect(m.r.additionalContext).toBeUndefined()
  expect((await m.ev('UserPromptSubmit', { prompt_id: 'p1' })).additionalContext).toContain(RULES)
  await m.ev('Stop', { prompt_id: 'p1', phase: 'final' })
  expect((await m.ev('UserPromptSubmit', { prompt_id: 'p2' })).additionalContext).toBeUndefined()
})

test('a compaction: the next prompt carries the rules again (PreCompact clears the mark); a compact SessionStart that carries them is not repeated', async () => {
  const m = await main('startup')
  expect(m.r.additionalContext).toContain(RULES)                                        // startup: the SessionStart context does arrive
  expect((await m.ev('UserPromptSubmit', { prompt_id: 'q1' })).additionalContext).toBeUndefined()
  await m.ev('Stop', { prompt_id: 'q1', phase: 'final' })
  await m.ev('PreCompact', {})
  expect((await m.ev('UserPromptSubmit', { prompt_id: 'q2' })).additionalContext).toContain(RULES)
  await m.ev('Stop', { prompt_id: 'q2', phase: 'final' })
  await m.ev('PreCompact', {})
  const c = await m.ev('SessionStart', { source: 'compact' })
  expect(c.additionalContext).toContain(RULES)
  expect((await m.ev('UserPromptSubmit', { prompt_id: 'q3' })).additionalContext).toBeUndefined()
})

test('the main settings carry PreCompact to the main hook; the hook prints a UserPromptSubmit context', async () => {
  expect(JSON.stringify((mainSettings() as any).hooks.PreCompact)).toContain('main-hook.py')
  const tok = mkdtempSync(join(tmpdir(), 'golive-rules-tok-'))
  const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async () => Response.json({ additionalContext: 'RULES-TEXT' }) })
  writeFileSync(join(tok, String(srv.port)), 'tok')
  const p = Bun.spawn(['python3', join(import.meta.dir, 'lanes-hooks', 'main-hook.py')], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', LANES_DIR: dir, TELEGRAM_HTTP_PORT: String(srv.port), MCP_TOKEN_DIR: tok, CLAUDE_PID: '4242' } })
  p.stdin.write(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt_id: 'p', prompt: 'hi' })); p.stdin.end()
  const out = JSON.parse((await new Response(p.stdout).text()).trim()); await p.exited; srv.stop(true)
  expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'RULES-TEXT' } })
})
