// lanes-golive: the global ~/.claude/CLAUDE.md (in every lane's system prompt, laneInstructionFiles) tells sessions to keep anchor files under knowledge/
// (listed in knowledge/REANCHOR.md) and to use sub-agents. Those are the main's habits: the lane card says a lane writes no anchor or knowledge/ file and
// starts no sub-agent (its record is its receipt and the ledger), the guard hook refuses writes under knowledge/, and lanes get no Agent tool by default.
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
const L = await import('./lanes.ts?golive-knowledge') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-golive-knowledge-'))
process.env.LANES_DIR = join(dir, '.lanes')
L.lanesInit({ role: 'inbox', agent: 'adam', workspaceDir: dir, transcriptDir: join(dir, 'proj'), httpPort: 0, log: () => {}, authOk: () => false } as any)
const HOOK = join(import.meta.dir, 'lanes-hooks', 'lane-guard-hook.py')
function guard(kind: string, input: Record<string, unknown>): string {
  const ws = mkdtempSync(join(tmpdir(), 'golive-knowledge-ws-')); mkdirSync(join(ws, 'knowledge')); mkdirSync(join(ws, '.lanes', 'run'), { recursive: true })
  const r = spawnSync('python3', [HOOK], { input: JSON.stringify({ ...input, cwd: ws }), encoding: 'utf8',
    env: { ...process.env, LANES_DIR: join(ws, '.lanes'), LANES_MEMORY_DIR: join(ws, 'memory'), LANES_WORKSPACE: ws, LANE_KIND: kind, LANE_ID: `adam.${kind}.1`, GENESIS_LOGOS_URL: '', LANES_LOGOS_URL: '' } })
  return r.stdout
}

test('the card of every kind: no anchor files, nothing under knowledge/, no sub-agents; the record is the receipt and the ledger', () => {
  for (const kind of ['reflex', 'worker', 'fork', 'curator', 'synthesis', 'mail'] as const) {
    const card = L.identityCard({ kind })
    expect(card).toContain('你不寫定錨檔、不碰 knowledge/ 底下任何檔（包括 knowledge/REANCHOR.md），也不開子 agent')
    expect(card).toContain('你的紀錄就是 receipt 和帳本')
  }
})

test('the guard refuses a write under knowledge/ for every kind (Write, Edit, shell), whatever claim', () => {
  for (const kind of ['reflex', 'worker', 'fork', 'mail']) {
    expect(guard(kind, { tool_name: 'Write', tool_input: { file_path: 'knowledge/REANCHOR.md', content: 'x' } })).toContain('lanes do not write knowledge/')
    expect(guard(kind, { tool_name: 'Edit', tool_input: { file_path: 'knowledge/lanes-golive.md', old_string: 'a', new_string: 'b' } })).toContain('lanes do not write knowledge/')
    expect(guard(kind, { tool_name: 'Bash', tool_input: { command: 'echo hi > knowledge/notes.md' } })).toContain('lanes do not write knowledge/')
  }
  expect(guard('worker', { tool_name: 'Bash', tool_input: { command: 'cat knowledge/REANCHOR.md' } })).toBe('')         // reading is fine
  expect(guard('mail', { tool_name: 'Bash', tool_input: { command: 'echo x > notes.md' } })).toContain('does not write workspace files')   // the mail lane: out/ only
})

test('no Agent tool for any lane by default; LANES_WORKER_AGENT_TOOL=1 gives worker and fork lanes their K3 tool again', () => {
  const was = process.env.LANES_WORKER_AGENT_TOOL
  delete process.env.LANES_WORKER_AGENT_TOOL
  for (const kind of ['reflex', 'worker', 'fork', 'mail'] as const) { expect(L.laneAgentOn(kind)).toBe(false); expect(L.laneBuiltinTools(kind)).not.toContain('Agent') }
  process.env.LANES_WORKER_AGENT_TOOL = '1'
  expect(L.laneAgentOn('worker')).toBe(true); expect(L.laneAgentOn('reflex')).toBe(false)
  if (was === undefined) delete process.env.LANES_WORKER_AGENT_TOOL; else process.env.LANES_WORKER_AGENT_TOOL = was
})
