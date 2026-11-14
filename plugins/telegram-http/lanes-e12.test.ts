// Universe 002k (E12, prepared, not shipped): LANES_WORKER_AGENT_TOOL=1 adds the Agent tool to the --tools list of worker and fork lanes only.
// Default OFF. The lane process is a script that writes its argv. No network, no model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?e12-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-e12-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3\nimport sys, json\nopen('${dir}/argv.jsonl', 'a').write(json.dumps(sys.argv[1:]) + '\\n')\nprint('{"type":"result","subtype":"success","is_error":false,"result":"ok"}')\n`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => { L.__setClaudeBin(restore); delete process.env.LANES_WORKER_AGENT_TOOL })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const argvs = (): string[][] => { try { return readFileSync(join(dir, 'argv.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(30) } return f() }
const tools = (a: string[]): string => a[a.indexOf('--tools') + 1]
const ALL = ['reflex', 'worker', 'fork', 'curator', 'synthesis'] as const

test('E12: off by default: no lane kind has Agent, and the lists are the B1 lists', () => {
  delete process.env.LANES_WORKER_AGENT_TOOL
  for (const k of ALL) expect(L.laneBuiltinTools(k)).not.toContain('Agent')
  expect(L.laneBuiltinTools('worker')).toBe('Bash,Read,Write,Edit,ToolSearch'); expect(L.laneBuiltinTools('reflex')).toBe('Bash,Read,ToolSearch')
})

test('E12: LANES_WORKER_AGENT_TOOL=1 adds Agent to worker and fork lanes only; any other value does not', () => {
  process.env.LANES_WORKER_AGENT_TOOL = '1'
  expect(L.laneBuiltinTools('worker')).toBe('Bash,Read,Write,Edit,Agent,ToolSearch'); expect(L.laneBuiltinTools('fork')).toBe('Bash,Read,Write,Edit,Agent,ToolSearch')
  for (const k of ['reflex', 'synthesis', 'curator'] as const) expect(L.laneBuiltinTools(k)).not.toContain('Agent')
  expect(L.laneBuiltinTools('curator')).toBe('Bash,Read,Write,Edit,ToolSearch'); expect(L.laneBuiltinTools('reflex')).toBe('Bash,Read,ToolSearch')    // the others are as before
  for (const v of ['0', 'true', 'yes', '', ' 1']) { process.env.LANES_WORKER_AGENT_TOOL = v; expect(L.laneBuiltinTools('worker')).not.toContain('Agent') }
  delete process.env.LANES_WORKER_AGENT_TOOL
})

test('E12: the spawned worker process gets Agent in --tools only with the switch on; a reflex lane never does', async () => {
  const mk = (kind: 'worker' | 'reflex', i: number) => {
    const id = `adam.${kind}.${i}`, st = L.__lanesState()
    st.lanes[id] = { id, kind, n: i, session_id: `s${i}`, thread: `adam#t-e12${i}`, status: 'new', created: '', last: '', transcript: '', runs: 0, tokens_in: 0, tokens_out: 0 } as any
    st.threads[`adam#t-e12${i}`] = { id: `adam#t-e12${i}`, lane: id, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
    L.__putQueue({ ev: { id: `ev-e12-${i}`, source: 'mesh', from: 'main', text: 'x', meta: {}, notif: { method: '', params: {} }, synthetic: `[E12 ${id}]` }, lane: id, state: 'queued', lease_until: 0, attempts: 0, priority: 1, enqueued: new Date().toISOString() })
  }
  const run = async (i: number, kind: 'worker' | 'reflex') => { const k = argvs().length; mk(kind, i); L.sweepQueue(); expect(await until(() => argvs().length > k)).toBe(true); return argvs().find(a => a[a.indexOf('-p') + 1].includes(`[E12 adam.${kind}.${i}]`))! }
  expect(tools(await run(1, 'worker'))).toBe('Bash,Read,Write,Edit,ToolSearch')
  process.env.LANES_WORKER_AGENT_TOOL = '1'
  expect(tools(await run(2, 'worker'))).toBe('Bash,Read,Write,Edit,Agent,ToolSearch')
  expect(tools(await run(3, 'reflex'))).toBe('Bash,Read,ToolSearch')
  delete process.env.LANES_WORKER_AGENT_TOOL
})
