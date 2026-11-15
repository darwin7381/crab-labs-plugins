// Universe 002l (N2, RV2 D05 #0): the memory directory is versioned AND the main can see the history and undo a change with a real revert commit; the
// commit hook tells the main the commit and how to undo it. design/memory 「改壞了能退回」「主線隨時可以…退回任何一次改動」. No model.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?pl-n2-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-pln2-'))
process.env.LANES_DIR = join(dir, '.lanes')
mkdirSync(join(dir, '.lanes'), { recursive: true })
copyFileSync(ROUTER, join(dir, '.lanes', 'router.json'))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const mem = L.memoryDir()
const hook = (file: string, env: Record<string, string> = {}) => spawnSync('python3', [join(import.meta.dir, 'lanes-hooks', 'memory-commit-hook.py')], {
  input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(mem, file) }, session_id: 's1', cwd: dir }), encoding: 'utf8',
  env: { ...process.env, LANES_MEMORY_DIR: mem, LANES_AGENT: 'adam', GIT_CONFIG_GLOBAL: '/dev/null', ...env } }).stdout
const main = (name: string, a: object) => L.callMainTool(name, a, 'mcp-main')
let sha = ''

test('N2: the main\'s memory write is committed and the hook tells the main the commit and how to undo it', () => {
  mkdirSync(mem, { recursive: true })
  writeFileSync(join(mem, 'feedback_backup.md'), '備份失敗兩次就停\n'); hook('feedback_backup.md')
  writeFileSync(join(mem, 'feedback_backup.md'), '備份失敗一次就停（錯的改法）\n')
  const out = JSON.parse(hook('feedback_backup.md'))
  const ctx = out.hookSpecificOutput.additionalContext as string
  sha = ctx.match(/已提交 ([0-9a-f]+)/)![1]
  expect(ctx).toContain('memory_revert(sha="'); expect(ctx).toContain('memory_history')
  expect(hook('feedback_backup.md', { LANE_ID: 'adam.curator.1' }).trim()).toBe('')          // a curator lane's commit says nothing (memory_revert is the main's)
})

test('N2: memory_history lists who changed what; memory_revert makes a real revert commit in the main\'s name and records it', async () => {
  const h = await main('memory_history', {})
  expect(h).toContain(sha); expect(h).toContain('adam.main'); expect(h).toContain('feedback_backup.md')
  const r = await main('memory_revert', { sha, reason: 'Joey 說退回剛才那次' })
  expect(r).toContain(`reverted ${sha}`)
  expect(readFileSync(join(mem, 'feedback_backup.md'), 'utf8')).toBe('備份失敗兩次就停\n')
  const last = spawnSync('git', ['-C', mem, 'log', '-1', '--format=%an|%s|%b'], { encoding: 'utf8' }).stdout
  expect(last).toContain('adam.main|memory: revert'); expect(last).toContain(`reverts=${sha}`)
  const led = readFileSync(join(dir, '.lanes', 'ledger.jsonl'), 'utf8')
  expect(led).toContain('"memory_revert"')
})

test('N2: memory_revert refuses an unknown sha, a missing reason, and while the curator holds the write right', async () => {
  expect(await main('memory_revert', { sha: 'deadbeef', reason: 'x' })).toContain('no commit deadbeef')
  expect(await main('memory_revert', { sha, reason: '' })).toContain('reason is required')
  L.__lanesState().curator = { lane: 'adam.curator.1', since: '', from_line: 0 }
  expect(await main('memory_revert', { sha, reason: 'x' })).toContain('curator lane')
  delete L.__lanesState().curator
  expect(L.isMainTool('memory_history')).toBe(true); expect(L.isMainTool('memory_revert')).toBe(true)
  expect(L.mainToolDefs().map((t: any) => t.name)).toEqual(expect.arrayContaining(['memory_history', 'memory_revert']))
})
