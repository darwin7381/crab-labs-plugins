// Universe 002k (E12, prepared OFF; K3, shipped ON): the Agent tool is in the --tools list of worker and fork lanes only, from LANES_WORKER_AGENT_TOOL (default on; 0 = off).
// The lane process is a script that writes its argv. No network, no model.
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

// lanes-golive: on the fleet a lane starts no sub-agents (off unless LANES_WORKER_AGENT_TOOL=1); the lab's K3 tool is what these tests specify, with the switch on
test('E12 / K3: with the switch on (LANES_WORKER_AGENT_TOOL=1): worker and fork lanes, never reflex, synthesis or curator lanes; the other lists are the B1 lists', () => {
  process.env.LANES_WORKER_AGENT_TOOL = '1'
  expect(L.laneBuiltinTools('worker')).toBe('Bash,Read,Write,Edit,Agent,ToolSearch'); expect(L.laneBuiltinTools('fork')).toBe('Bash,Read,Write,Edit,Agent,ToolSearch')
  for (const k of ['reflex', 'synthesis', 'curator'] as const) expect(L.laneBuiltinTools(k)).not.toContain('Agent')
  expect(L.laneBuiltinTools('curator')).toBe('Bash,Read,Write,Edit,ToolSearch'); expect(L.laneBuiltinTools('reflex')).toBe('Bash,Read,ToolSearch'); expect(L.laneBuiltinTools('synthesis')).toBe('Bash,Read,ToolSearch')
  for (const k of ALL) expect(L.laneAgentOn(k)).toBe(k === 'worker' || k === 'fork')
})

test('E12 / K3: LANES_WORKER_AGENT_TOOL=0 (or unset, the fleet default) takes it away; only 1 gives it', () => {
  process.env.LANES_WORKER_AGENT_TOOL = '0'
  for (const k of ALL) { expect(L.laneBuiltinTools(k)).not.toContain('Agent'); expect(L.laneAgentOn(k)).toBe(false) }
  expect(L.laneBuiltinTools('worker')).toBe('Bash,Read,Write,Edit,ToolSearch')
  for (const v of ['true', '', ' 1']) { process.env.LANES_WORKER_AGENT_TOOL = v; expect(L.laneBuiltinTools('worker')).not.toContain('Agent') }
  process.env.LANES_WORKER_AGENT_TOOL = '1'; expect(L.laneBuiltinTools('worker')).toContain('Agent')
})

test('E12 / K3: the spawned worker process has Agent, the --agents definitions and no fork by default; with the switch at 0 none of them; a reflex lane never', async () => {
  const mk = (kind: 'worker' | 'reflex', i: number) => {
    const id = `adam.${kind}.${i}`, st = L.__lanesState()
    st.lanes[id] = { id, kind, n: i, session_id: `s${i}`, thread: `adam#t-e12${i}`, status: 'new', created: '', last: '', transcript: '', runs: 0, tokens_in: 0, tokens_out: 0 } as any
    st.threads[`adam#t-e12${i}`] = { id: `adam#t-e12${i}`, lane: id, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
    L.__putQueue({ ev: { id: `ev-e12-${i}`, source: 'mesh', from: 'main', text: 'x', meta: {}, notif: { method: '', params: {} }, synthetic: `[E12 ${id}]` }, lane: id, state: 'queued', lease_until: 0, attempts: 0, priority: 1, enqueued: '' })
  }
  const run = async (i: number, kind: 'worker' | 'reflex') => { const k = argvs().length; mk(kind, i); L.sweepQueue(); expect(await until(() => argvs().length > k)).toBe(true); return argvs().find(a => a[a.indexOf('-p') + 1].includes(`adam.${kind}.${i}`))! }
  const denied = (a: string[]): string[] => a.slice(a.indexOf('--disallowedTools') + 1)
  process.env.LANES_WORKER_AGENT_TOOL = '1'                                                 // lanes-golive: the switch on (the fleet default is off)
  const w = await run(1, 'worker')
  expect(tools(w)).toBe('Bash,Read,Write,Edit,Agent,ToolSearch')
  expect(Object.keys(JSON.parse(w[w.indexOf('--agents') + 1])).sort()).toEqual([...L.LANE_AGENT_TYPES].sort())
  expect(w.indexOf('--agents')).toBeLessThan(w.indexOf('--disallowedTools'))                // the variadic list must come last
  expect(denied(w)).toEqual(['AskUserQuestion', 'ExitPlanMode', 'Agent(fork)'])
  process.env.LANES_WORKER_AGENT_TOOL = '0'
  const off = await run(2, 'worker')
  expect(tools(off)).toBe('Bash,Read,Write,Edit,ToolSearch'); expect(off.includes('--agents')).toBe(false); expect(denied(off)).toEqual(['AskUserQuestion', 'ExitPlanMode'])
  delete process.env.LANES_WORKER_AGENT_TOOL
  const r = await run(3, 'reflex')
  expect(tools(r)).toBe('Bash,Read,ToolSearch'); expect(r.includes('--agents')).toBe(false); expect(denied(r)).toEqual(['AskUserQuestion', 'ExitPlanMode'])
})
