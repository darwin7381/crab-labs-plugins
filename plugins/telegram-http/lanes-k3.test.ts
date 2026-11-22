// Universe 002k (K3): a lane's sub-agents have no lane tools. The lane has the Agent tool by default (worker, fork); claude is started with --agents (every agent type it
// offers, redefined with the lane's MCP server in disallowedTools) and Agent(fork) denied; lane-agent-hook.py refuses the agent types plugins add.
// What claude 2.1.322 does with these arguments was checked once against a stand-in for the API (no model): a default sub-agent had mcp__lane__receipt, one started
// under these arguments did not; fork and a plugin's type were refused by the hook. These tests cover what the plugin hands to claude and what the hook says.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?k3-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-k3-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const HOOKS = join(import.meta.dir, 'lanes-hooks')
// the lane process records its argv and the server names of the MCP config it was given
const bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3\nimport sys, json\na = sys.argv[1:]\nopen('${dir}/argv.jsonl', 'a').write(json.dumps({'argv': a, 'mcp': sorted(json.load(open(a[a.index('--mcp-config') + 1]))['mcpServers'].keys())}) + '\\n')\nprint('{"type":"result","subtype":"success","is_error":false,"result":"ok"}')\n`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => { L.__setClaudeBin(restore); delete process.env.LANES_WORKER_AGENT_TOOL })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(30) } return f() }
const runs = (): Array<{ argv: string[]; mcp: string[] }> => { try { return readFileSync(join(dir, 'argv.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const defs = (): Record<string, any> => JSON.parse(L.laneAgentsJson())

test('K3: --agents redefines every agent type claude offers, each without the lane\'s MCP server; Explore and Plan stay read-only', () => {
  const d = defs()
  expect(Object.keys(d).sort()).toEqual(['Explore', 'Plan', 'claude', 'general-purpose', 'statusline-setup'])
  expect(Object.keys(d).sort()).toEqual([...L.LANE_AGENT_TYPES].sort())
  for (const [name, def] of Object.entries<any>(d)) {
    expect(typeof def.description).toBe('string'); expect(def.description.length).toBeGreaterThan(10)
    expect(typeof def.prompt).toBe('string'); expect(def.prompt).toContain('You are a helper of a lane')
    if (name !== 'statusline-setup') { expect(def.disallowedTools).toContain('mcp__lane'); expect(def.disallowedTools).toContain('mcp__lane__*') }
  }
  for (const n of ['Explore', 'Plan']) { for (const t of ['Agent', 'Edit', 'Write', 'NotebookEdit']) expect(d[n].disallowedTools).toContain(t); expect(d[n].prompt).toContain('do not edit or write files') }
  for (const n of ['general-purpose', 'claude']) { expect(d[n].disallowedTools).toEqual(['mcp__lane', 'mcp__lane__*']); expect(d[n].tools).toBeUndefined() }     // every other tool is inherited
  expect(d['statusline-setup'].tools).toEqual(['Read'])
  expect(L.laneAgentsJson()).toBe(L.laneAgentsJson())
})

test('K3: the spawned worker and fork get --agents and Agent(fork) denied; the server name in the deny spec is the one in their MCP config; others get nothing', async () => {
  delete process.env.LANES_WORKER_AGENT_TOOL
  const mk = (kind: 'worker' | 'fork' | 'reflex' | 'curator', i: number) => {
    const id = `adam.${kind}.${i}`, st = L.__lanesState()
    st.lanes[id] = { id, kind, n: i, session_id: `s${i}`, thread: `adam#t-k3${i}`, status: 'new', created: '', last: '', transcript: '', runs: 0, tokens_in: 0, tokens_out: 0 } as any
    st.threads[`adam#t-k3${i}`] = { id: `adam#t-k3${i}`, lane: id, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
    L.__putQueue({ ev: { id: `ev-k3-${i}`, source: 'mesh', from: 'main', text: 'x', meta: {}, notif: { method: '', params: {} }, synthetic: `[K3 ${id}]` }, lane: id, state: 'queued', lease_until: 0, attempts: 0, priority: 1, enqueued: '' })
  }
  const go = async (kind: 'worker' | 'fork' | 'reflex' | 'curator', i: number) => { const k = runs().length; mk(kind, i); L.sweepQueue(); expect(await until(() => runs().length > k)).toBe(true); return runs().find(r => r.argv[r.argv.indexOf('-p') + 1].includes(`adam.${kind}.${i}`))! }
  for (const [kind, i] of [['worker', 1], ['fork', 2]] as const) {
    const r = await go(kind, i)
    const a = JSON.parse(r.argv[r.argv.indexOf('--agents') + 1])
    expect(Object.keys(a).sort()).toEqual([...L.LANE_AGENT_TYPES].sort())
    expect(r.argv.slice(r.argv.indexOf('--disallowedTools') + 1)).toContain('Agent(fork)')
    expect(r.mcp).toEqual(['lane'])                                                         // `mcp__lane` in disallowedTools is that server
    for (const def of Object.values<any>(a)) if (def.disallowedTools) expect(def.disallowedTools).toContain(`mcp__${r.mcp[0]}`)
  }
  for (const [kind, i] of [['reflex', 3], ['curator', 4]] as const) {
    const r = await go(kind, i)
    expect(r.argv.includes('--agents')).toBe(false); expect(r.argv.join(' ')).not.toContain('Agent(fork)'); expect(r.argv[r.argv.indexOf('--tools') + 1]).not.toContain('Agent')
  }
  expect(L.laneAgentArgs('reflex')).toEqual({ agents: [], deny: [] })
})

test('K3: the lane settings carry the sub-agent type hook next to the guard, which is as it was', () => {
  const s = JSON.parse(readFileSync(join(dir, 'lane-settings.json'), 'utf8'))
  const pre = s.hooks.PreToolUse.filter((m: any) => m.hooks.some((h: any) => h.command.includes('lanes-hooks')))   // lanes-golive (A3): the user's guards ride after the plugin's
  expect(pre.length).toBe(2)
  expect(pre[0].matcher).toBe('Write|Edit|MultiEdit|NotebookEdit|Bash'); expect(pre[0].hooks[0].command).toContain('lane-guard-hook.py')
  expect(pre[1].matcher).toBe('Agent|Task'); expect(pre[1].hooks[0].command).toContain('lane-agent-hook.py')
})

function hook(payload: object | string): string {
  const r = Bun.spawnSync(['python3', join(HOOKS, 'lane-agent-hook.py')], { stdin: new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload)) })
  return new TextDecoder().decode(r.stdout).trim()
}
test('K3 hook: the redefined types and "no type" pass; fork, a plugin\'s type, a typo and a different case are refused with the allowed list in the message', () => {
  for (const t of L.LANE_AGENT_TYPES) expect(hook({ tool_name: 'Agent', tool_input: { subagent_type: t, prompt: 'x' } })).toBe('')
  expect(hook({ tool_name: 'Agent', tool_input: { prompt: 'x' } })).toBe('')                                // no type = general-purpose
  expect(hook({ tool_name: 'Agent', tool_input: { subagent_type: '', prompt: 'x' } })).toBe('')
  expect(hook({ tool_name: 'Task', tool_input: { subagent_type: 'Explore' } })).toBe('')                    // the old tool name
  for (const t of ['fork', 'feature-dev:code-explorer', 'pr-review-toolkit:code-reviewer', 'codex:codex-rescue', 'general-purpos', 'explore', 'PLAN']) {
    for (const tool of ['Agent', 'Task']) {
      const o = JSON.parse(hook({ tool_name: tool, tool_input: { subagent_type: t } })).hookSpecificOutput
      expect(o).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
      expect(o.permissionDecisionReason).toContain(t)
      for (const ok of L.LANE_AGENT_TYPES) expect(o.permissionDecisionReason).toContain(ok)
    }
  }
})
test('K3 hook: other tools and unreadable input are none of its business', () => {
  expect(hook({ tool_name: 'Bash', tool_input: { command: 'ls', subagent_type: 'fork' } })).toBe('')
  expect(hook({ tool_name: 'mcp__lane__receipt', tool_input: {} })).toBe('')
  expect(hook({})).toBe(''); expect(hook('not json')).toBe(''); expect(hook({ tool_name: 'Agent' })).toBe('')
})
test('K3 hook: its list of allowed types is the list the --agents definitions use', () => {
  const code = `import importlib.util, json\nspec = importlib.util.spec_from_file_location('h', ${JSON.stringify(join(HOOKS, 'lane-agent-hook.py'))})\nm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\nprint(json.dumps(list(m.ALLOWED)))`
  const r = Bun.spawnSync(['python3', '-c', code])
  expect(JSON.parse(new TextDecoder().decode(r.stdout)).sort()).toEqual([...L.LANE_AGENT_TYPES].sort())
})
