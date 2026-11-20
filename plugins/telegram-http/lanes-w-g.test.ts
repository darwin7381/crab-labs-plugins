// 002w (G): boundaries. The not-the-main check is one function for both daemons (the inbox daemon asks the tg daemon, the keeper of M2), so a refused
// second session gets no send_to_agent; a subagent of the main is denied the Telegram reply tool; the curator's memory writes are new files and Edits
// that keep the old text; and at the main's final Stop everything changed under the memory dir is committed, whatever tool wrote it. Each test names its
// path and the gap of DUTY-INVENTORY.md. Hooks run as the processes they are; no model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
let L: typeof import('./lanes.ts')
const srv = createServer((req, res) => { void L.handleLanesHttp(new URL(req.url ?? '/', 'http://127.0.0.1'), req, res) })
await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
process.env.LANES_TG_PORT = String((srv.address() as AddressInfo).port)
L = await import('./lanes.ts?w-g-test') as typeof import('./lanes.ts')
const I = await import('./lanes.ts?w-g-inbox') as typeof import('./lanes.ts')
delete process.env.LANES_TG_PORT
const dir = mkdtempSync(join(tmpdir(), 'lanes-w-g-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => true, registryNames: () => ['eve'], toolsChanged: () => {} } as any)
const idir = mkdtempSync(join(tmpdir(), 'lanes-w-g-inbox-'))
process.env.LANES_DIR = idir
I.lanesInit({ role: 'inbox', agent: 'adam', workspaceDir: idir, transcriptDir: idir, httpPort: 0, log: () => {}, authOk: () => true, registryNames: () => ['eve'] } as any)
process.env.LANES_DIR = dir
const procs: any[] = []
afterAll(() => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } srv.close() })
const HOOKS = join(import.meta.dir, 'lanes-hooks')
const sh = (cmd: string[], cwd: string) => spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: 'utf8' })

test('002w G, gap 19, path the inbox daemon\'s not-the-main check: a session of a process that is not the main is judged so by asking the tg daemon (2a936a7: the inbox daemon judged nobody: send_to_agent stayed, its sends were filed as the main\'s)', async () => {
  const mainProc = Bun.spawn(['sleep', '600'], { stdout: 'ignore' }), other = Bun.spawn(['sleep', '600'], { stdout: 'ignore' }); procs.push(mainProc, other)
  writeFileSync(join(dir, 'main-expected'), '00000000-0000-4000-8000-000000000071')
  await L.__mainEvent({ event: 'SessionStart', pid: mainProc.pid, session_id: '00000000-0000-4000-8000-000000000071' })
  expect((await L.__mainEvent({ event: 'SessionStart', pid: other.pid, session_id: '00000000-0000-4000-8000-000000000072' })).accepted).toBe(false)
  I.__noteMcpPid('inbox-main', mainProc.pid); I.__noteMcpPid('inbox-other', other.pid)               // what the inbox daemon learns from each socket
  expect(await I.notMainSession('inbox-other')).toBe(true)
  expect(await I.notMainSession('inbox-main')).toBe(false)
  expect(await I.notMainSession('inbox-unknown')).toBe(false)                                         // a process it cannot tell: not judged
  L.__noteMcpPid('tg-other', other.pid)
  expect(await L.notMainSession('tg-other')).toBe(true)                                               // the tg daemon: the same rule, its own
})

test('002w G, gap 19, path a subagent of the main (PreToolUse with agent_id): the Telegram reply tool is denied; its other tools are not (2a936a7: it printed nothing)', () => {
  const run = (tool: string) => spawnSync('python3', [join(HOOKS, 'main-hook.py')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', agent_id: 'a-1', session_id: 's', tool_name: tool, tool_input: { text: 'x' } }),
    encoding: 'utf8', env: { ...process.env, TELEGRAM_HTTP_PORT: '' } }).stdout
  expect(run('mcp__plugin_telegram-http_telegram-http__reply')).toContain('"deny"')
  expect(run('Bash')).toBe('')
})

test('002w G, gap 20, path the lane guard on the curator\'s memory writes: a new file and an Edit that keeps the old text pass; a Write over a file, an Edit that removes text, a notebook edit are refused (2a936a7: any write passed)', () => {
  const mem = join(dir, 'memory'); mkdirSync(mem, { recursive: true }); writeFileSync(join(mem, 'feedback.md'), '- Joey 喜歡 08:00 收報告\n')
  mkdirSync(join(dir, 'run'), { recursive: true }); writeFileSync(join(dir, 'run', 'memory-writer'), 'adam.curator.1')
  const run = (tool: string, input: object) => spawnSync('python3', [join(HOOKS, 'lane-guard-hook.py')], { input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: dir }),
    env: { ...process.env, LANES_DIR: dir, LANES_MEMORY_DIR: mem, LANE_KIND: 'curator', LANE_ID: 'adam.curator.1' }, encoding: 'utf8' }).stdout.includes('"deny"') ? 'deny' : 'allow'
  const f = join(mem, 'feedback.md')
  expect(run('Write', { file_path: join(mem, 'maintenance.md'), content: '週三 14:00 維護' })).toBe('allow')
  expect(run('Write', { file_path: f, content: '全部重寫' })).toBe('deny')
  expect(run('Edit', { file_path: f, old_string: '- Joey 喜歡 08:00 收報告', new_string: '- Joey 喜歡 08:00 收報告（建議刪除：已改 09:00）' })).toBe('allow')
  expect(run('Edit', { file_path: f, old_string: '- Joey 喜歡 08:00 收報告', new_string: '- Joey 喜歡 09:00 收報告' })).toBe('deny')
  expect(run('MultiEdit', { file_path: f, edits: [{ old_string: '08:00', new_string: '08:00 ✓' }, { old_string: '收報告', new_string: '' }] })).toBe('deny')
  expect(run('NotebookEdit', { notebook_path: join(mem, 'n.ipynb'), new_source: 'x' })).toBe('deny')
  writeFileSync(join(dir, 'run', 'memory-writer'), '')
})

test('002w G, gap 21, path the main\'s final Stop: what the turn wrote in memory by any tool (here a shell write) is committed (2a936a7: only Write/Edit/MultiEdit were)', () => {
  const mem = mkdtempSync(join(tmpdir(), 'lanes-w-g-mem-'))
  sh(['git', 'init', '-q'], mem); writeFileSync(join(mem, 'MEMORY.md'), '# memory\n'); sh(['git', 'add', '-A'], mem)
  sh(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], mem)
  writeFileSync(join(mem, 'from-bash.md'), 'echo 寫的記憶\n')                                          // what a Bash call left there
  const r = spawnSync('python3', [join(HOOKS, 'main-hook.py')], { input: JSON.stringify({ hook_event_name: 'Stop', session_id: 's-g', prompt_id: 'p-g', cwd: dir }),
    encoding: 'utf8', env: { ...process.env, TELEGRAM_HTTP_PORT: '', LANES_MEMORY_DIR: mem, LANES_AGENT: 'adam' } })
  expect(r.stdout).toBe('')                                                                           // nothing holds the turn
  const log = sh(['git', 'log', '-1', '--name-only', '--format=%an %s'], mem).stdout
  expect(log).toContain('adam.main memory: from-bash.md'); expect(log).toContain('from-bash.md')
  expect(sh(['git', 'status', '--porcelain'], mem).stdout).toBe('')
})
