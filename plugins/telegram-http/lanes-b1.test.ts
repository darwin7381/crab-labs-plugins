// Universe 002k (B1): what a lane's claude process is started with. The lane process is a script that writes its argv and the one
// env var we care about to a file. (The sizes behind these flags were measured with real claude calls; see the commit message.)
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
const L = await import('./lanes.ts?b1-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-b1-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3\nimport sys, json, os\nopen('${dir}/argv.jsonl', 'a').write(json.dumps({'argv': sys.argv[1:], 'tool_search': os.environ.get('ENABLE_TOOL_SEARCH')}) + '\\n')\nprint('{"type":"result","subtype":"success","is_error":false,"result":"ok"}')\n`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => L.__setClaudeBin(restore))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const runs = (): any[] => { try { return readFileSync(join(dir, 'argv.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 6000) { while (ms > 0) { if (f()) return true; await sleep(30); ms -= 30 } return f() }

test('B1: a lane process starts without skills, with only the built-in tools lanes use, and with tool search off', async () => {
  const d = await L.routeEvent({ id: 'mesh-c1', source: 'mesh', from: 'eve', verified: true, text: 'mock-api 的逾時是多少？', meta: {}, notif: { method: '', params: {} } } as any)
  expect(d.target).toBe('lane')
  expect(await until(() => runs().length >= 1)).toBe(true)
  const { argv, tool_search } = runs()[0]
  expect(argv).toContain('--disable-slash-commands')
  expect(argv[argv.indexOf('--tools') + 1]).toBe('Bash,Read,ToolSearch')               // a reflex lane: no Write / Edit
  expect(tool_search).toBe('false')
  // what the lane needs is still there: the lane tools, the lane hooks, the card, the old denials
  expect(argv).toContain('--strict-mcp-config'); expect(argv).toContain('--mcp-config')
  expect(argv).toContain('--settings'); expect(argv).toContain('--append-system-prompt')
  expect(argv.slice(argv.indexOf('--disallowedTools'))).toEqual(['--disallowedTools', 'AskUserQuestion', 'ExitPlanMode'])   // last: it takes a list
})

test('B1: Write and Edit exactly for the kinds the guard hook can let write (worker, fork, curator)', () => {
  expect(L.laneBuiltinTools('reflex')).toBe('Bash,Read,ToolSearch')
  expect(L.laneBuiltinTools('synthesis')).toBe('Bash,Read,ToolSearch')
  for (const k of ['worker', 'fork', 'curator'] as const) expect(L.laneBuiltinTools(k)).toBe('Bash,Read,Write,Edit,ToolSearch')
  // cross-check against the hook itself: a workspace write by a reflex / synthesis lane is refused outright (no claim helps),
  // a worker / fork write is allowed once it holds the claim, the curator writes memory while it holds the right
  const hook = join(import.meta.dir, 'lanes-hooks', 'lane-guard-hook.py')
  const hd = join(dir, 'hook-env'), ld = join(hd, '.lanes')                          // the workspace and, inside it, the lanes directory (as in a real agent)
  const mem = join(hd, 'memory'); mkdirSync(mem, { recursive: true })
  const ws = join(hd, 'proj'); mkdirSync(ws, { recursive: true }); mkdirSync(join(ld, 'run'), { recursive: true })
  writeFileSync(join(ld, 'state.json'), JSON.stringify({ claims: { [join(ws, 'a.txt')]: { lane: 'adam.worker.1' }, [join(ws, 'b.txt')]: { lane: 'adam.fork.1' } } }))
  writeFileSync(join(ld, 'run', 'memory-writer'), 'adam.curator.1')
  const verdict = (kind: string, id: string, file: string) => {
    const r = spawnSync('python3', [hook], { input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file }, cwd: hd }),
      env: { ...process.env, LANES_DIR: ld, LANES_MEMORY_DIR: mem, LANE_KIND: kind, LANE_ID: id }, encoding: 'utf8' })
    return r.stdout.includes('"deny"') ? 'deny' : 'allow'
  }
  const canWrite = (kind: string, id: string, file: string) => verdict(kind, id, file) === 'allow'
  expect(canWrite('reflex', 'adam.reflex.1', join(ws, 'a.txt'))).toBe(false)
  expect(canWrite('synthesis', 'adam.synthesis.1', join(ws, 'a.txt'))).toBe(false)
  expect(canWrite('worker', 'adam.worker.1', join(ws, 'a.txt'))).toBe(true)
  expect(canWrite('fork', 'adam.fork.1', join(ws, 'b.txt'))).toBe(true)
  expect(canWrite('curator', 'adam.curator.1', join(mem, 'feedback.md'))).toBe(true)
  for (const k of ['reflex', 'synthesis']) expect(L.laneBuiltinTools(k as any)).not.toContain('Write')
  for (const k of ['worker', 'fork', 'curator']) expect(L.laneBuiltinTools(k as any)).toContain('Write')
})
