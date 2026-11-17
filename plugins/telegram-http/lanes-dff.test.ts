// Universe 002k: file claims (F04), fan-out with a synthesis lane (F05), curator lane with the memory write right (D04).
// Lane processes are a shell script that sleeps (no model); tool calls are made directly with run tokens, as other lanes tests do.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
const L = await import('./lanes.ts?dff-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-dff-'))
process.env.LANES_DIR = join(dir, '.lanes')
mkdirSync(join(dir, '.lanes'), { recursive: true })
copyFileSync(ROUTER, join(dir, '.lanes', 'router.json'))
writeFileSync(join(dir, '.lanes', 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'slow.sh'); writeFileSync(bin, '#!/bin/sh\nsleep 20\n'); chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
const sent: string[] = [], delivered: Array<{ content: string; meta: any }> = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'],
  sendBot: async (_c: string, text: string) => { sent.push(text); return 9100 + sent.length }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
afterAll(() => { L.__setClaudeBin(restore); spawnSync('pkill', ['-f', bin]) })
const st = L.__lanesState()
const led = (): any[] => { try { return readFileSync(join(dir, '.lanes', 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const tok = (lane: string, extra: object = {}) => ({ runId: `${lane}.r1`, lane, evId: `ev-${lane}`, closers: [], critical: false, trigger: 'peer', cls: 'peer', escalated: false, pushed: false, ...extra }) as any
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
function mkLane(id: string, kind: string, n: number) { st.lanes[id] = { id, kind, n, session_id: 's', thread: `adam#t-${id}`, status: 'running', created: '', last: '', transcript: '/x', runs: 0, tokens_in: 0, tokens_out: 0 } as any }

test('claim_file: the first lane gets the file, a second lane is told who holds it; the intent is in the ledger', async () => {
  mkLane('adam.worker.1', 'worker', 1); mkLane('adam.worker.2', 'worker', 2)
  expect(await L.callLaneTool(tok('adam.worker.1'), 'claim_file', { path: 'mock-api/config.yaml', why: 'WO-70 逾時改 5 秒' })).toContain('claimed')
  ;(L as any).__markRunning?.('adam.worker.1')
  const out = await L.callLaneTool(tok('adam.worker.2'), 'claim_file', { path: './mock-api/config.yaml', why: 'WO-71 重試改 3 次' })
  expect(out === undefined).toBe(false)
  const intents = led().filter(r => r.kind === 'intent')
  expect(intents.length).toBeGreaterThanOrEqual(1)
  expect(intents[0].text).toContain('mock-api/config.yaml')
  expect(Object.values(st.claims ?? {})[0].lane).toBe('adam.worker.1')
})

test('guard hook: a reflex lane cannot edit workspace files; a worker needs its claim; the curator writes memory only while it holds the right', () => {
  const hook = join(import.meta.dir, 'lanes-hooks', 'lane-guard-hook.py')
  const mem = join(dir, 'memory'); mkdirSync(mem, { recursive: true })
  const run = (env: Record<string, string>, file: string) => {
    const r = spawnSync('python3', [hook], { input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file }, cwd: dir }),
      env: { ...process.env, LANES_DIR: join(dir, '.lanes'), LANES_MEMORY_DIR: mem, ...env }, encoding: 'utf8' })
    return r.stdout.includes('"deny"') ? 'deny' : 'allow'
  }
  const cfg = join(dir, 'mock-api', 'config.yaml')
  expect(run({ LANE_KIND: 'reflex', LANE_ID: 'adam.reflex.1' }, cfg)).toBe('deny')
  expect(run({ LANE_KIND: 'reflex', LANE_ID: 'adam.reflex.1' }, '/tmp/scratch.txt')).toBe('allow')
  expect(run({ LANE_KIND: 'worker', LANE_ID: 'adam.worker.1' }, cfg)).toBe('allow')        // it holds the claim
  expect(run({ LANE_KIND: 'worker', LANE_ID: 'adam.worker.2' }, cfg)).toBe('deny')         // it does not
  expect(run({ LANE_KIND: 'curator', LANE_ID: 'adam.curator.1' }, join(mem, 'feedback.md'))).toBe('deny')   // no right yet
  mkdirSync(join(dir, '.lanes', 'run'), { recursive: true }); writeFileSync(join(dir, '.lanes', 'run', 'memory-writer'), 'adam.curator.1')
  expect(run({ LANE_KIND: 'curator', LANE_ID: 'adam.curator.1' }, join(mem, 'feedback.md'))).toBe('allow')
  expect(run({ LANE_KIND: 'reflex', LANE_ID: 'adam.reflex.1' }, join(mem, 'feedback.md'))).toBe('deny')
  writeFileSync(join(dir, '.lanes', 'run', 'memory-writer'), '')
})

test('fan_out: one lane per part, results go to a synthesis lane, ONE conclusion reaches the main', async () => {
  const out = await L.callMainTool('fan_out', { tasks: ['查 mock-api 最近 24 小時', '查 mock-backup 最近 24 小時', '查 mock-tickets 最近 24 小時'], conclusion: '三個服務各一行狀態加整體判斷' }, 'mcp-main')
  expect(out).toContain('3 lanes started')
  const fo = Object.values(st.fanouts!)[0]
  expect(fo.members.length).toBe(3)
  expect(await L.callLaneTool(tok(fo.members[0]), 'report_result', { text: 'x' })).toContain('refused')      // only a fan-out member run may
  for (const [i, m] of fo.members.entries()) await L.callLaneTool(tok(m, { fanout: fo.id }), 'report_result', { text: `第 ${i + 1} 塊：正常` })
  expect(fo.synthesis).toBeTruthy()
  expect(st.lanes[fo.synthesis!].kind).toBe('synthesis')
  const r = await L.callLaneTool(tok(fo.synthesis!, { synthesis: fo.id }), 'deliver_synthesis', { text: 'mock-api 兩次延遲；mock-backup 一次失敗已重跑成功；mock-tickets 正常。整體：可接受。' })
  expect(r).toContain('queued for the main')
  const carry = L.__main().items(x => x.kind === 'carry')                              // M1: one item for the main, offered when it is idle
  expect(carry.length).toBe(1); expect(carry[0].notif.params.meta.kind).toBe('synthesis'); expect(carry[0].notif.params.content).toContain('mock-backup')
  expect(sent.length).toBe(0)                                                          // nothing to Joey from the lanes
})

test('curate_memory: the curator holds the right, finishes with curator_done; curate_stop takes it back; proposals stay in the ledger', async () => {
  expect(await L.callMainTool('curate_memory', {}, 'mcp-main')).toContain('no memory proposals')
  L.ledgerAppendForTest?.({ lane: 'adam.reflex.5', kind: 'memory_proposal', text: 'Joey 喜歡 08:00 收報告', notify_main: true })
  writeFileSync(join(dir, '.lanes', 'ledger.jsonl'), readFileSync(join(dir, '.lanes', 'ledger.jsonl'), 'utf8') + JSON.stringify({ ts: new Date().toISOString(), lane: 'adam.reflex.5', kind: 'memory_proposal', text: 'Joey 喜歡 08:00 收報告', notify_main: true }) + '\n')
  const out = await L.callMainTool('curate_memory', { note: '有空整理一下' }, 'mcp-main')
  expect(out).toContain('holds the memory write right')
  const cur = st.curator!.lane
  expect(readFileSync(join(dir, '.lanes', 'run', 'memory-writer'), 'utf8')).toBe(cur)
  expect(await L.callLaneTool(tok(cur), 'curator_done', { summary: '寫入 1 筆' })).toContain('returned')
  expect(st.curator).toBeUndefined(); expect(existsSync(join(dir, '.lanes', 'run', 'memory-writer'))).toBe(false)
  expect(await L.callMainTool('curate_memory', {}, 'mcp-main')).toContain('no memory proposals')            // already curated up to here
  writeFileSync(join(dir, '.lanes', 'ledger.jsonl'), readFileSync(join(dir, '.lanes', 'ledger.jsonl'), 'utf8') + JSON.stringify({ ts: new Date().toISOString(), lane: 'adam.reflex.6', kind: 'memory_proposal', text: '快照保留 30 天', notify_main: true }) + '\n')
  await L.callMainTool('curate_memory', {}, 'mcp-main')
  expect(await L.callMainTool('curate_stop', {}, 'mcp-main')).toContain('taken back')
  expect(existsSync(join(dir, '.lanes', 'run', 'memory-writer'))).toBe(false)
  expect(led().some(r => String(r.text).includes('主線收回記憶寫入權'))).toBe(true)
})
