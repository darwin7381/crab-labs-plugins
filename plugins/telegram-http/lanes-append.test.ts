// WO-123 (Chiron's acceptance, points 1 to 6): a lane adds text at the END of a file the main declared (.lanes/appendable.txt) with append_file; what
// was there stays byte for byte; Write, Edit and shell writes to a declared file are refused for every lane kind; an undeclared file is refused as
// before; what is never declarable stays closed even when declared; two writers at once lose no line; no declaration = today's behaviour.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, chmodSync, copyFileSync } from 'fs'
import { spawn, spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { readDeclared, appendText, declaredFor, APPEND_MAX } from './lanes-append.ts'

const dir = mkdtempSync(join(tmpdir(), 'lanes-append-'))
const LD = join(dir, '.lanes'), MEM = join(dir, 'memory')
for (const d of [LD, MEM, join(dir, 'state'), join(dir, 'knowledge', 'lines'), join(dir, '.secrets'), join(dir, 'out')]) mkdirSync(d, { recursive: true })
writeFileSync(join(dir, 'state', 'situation.md'), '# 狀況\n第一行\n')
writeFileSync(join(dir, 'state', 'config.json'), '{}\n')
writeFileSync(join(dir, 'CLAUDE.md'), 'persona\n')
writeFileSync(join(dir, 'knowledge', 'plan.md'), 'anchor\n')
writeFileSync(join(dir, 'knowledge', 'journal.md'), 'j\n')
writeFileSync(join(dir, 'knowledge', 'REANCHOR.md'), '| 線 | 定錨檔 |\n|---|---|\n| x | `knowledge/plan.md` |\n')
writeFileSync(join(dir, 'notes.md'), 'n\n')
symlinkSync(join(dir, 'state', 'config.json'), join(dir, 'link.md'))
const setDeclared = (lines: string[]) => writeFileSync(join(LD, 'appendable.txt'), lines.join('\n') + '\n')
const HOOK = join(import.meta.dir, 'lanes-hooks', 'lane-guard-hook.py')
function guard(kind: string, input: Record<string, unknown>, laneId = 'adam.reflex.1'): string {
  const r = spawnSync('python3', [HOOK], { input: JSON.stringify({ ...input, cwd: dir }), encoding: 'utf8',
    env: { ...process.env, LANES_DIR: LD, LANES_MEMORY_DIR: MEM, LANES_WORKSPACE: dir, LANE_KIND: kind, LANE_ID: laneId, GENESIS_LOGOS_URL: '', LANES_LOGOS_URL: '' } })
  try { return String(JSON.parse(r.stdout || '{}')?.hookSpecificOutput?.permissionDecisionReason ?? '') } catch { return r.stdout }
}

test('the declaration: record-like workspace files are accepted; what is never declarable is refused whatever the file says (point 4)', () => {
  setDeclared(['# 車道可以加的檔', 'state/situation.md', 'knowledge/journal.md', 'state/new-log.txt', 'state/situation.md',
    'state/config.json', 'CLAUDE.md', 'knowledge/REANCHOR.md', 'knowledge/plan.md', 'knowledge/lines/x.md', '.lanes/focus.md', 'memory/MEMORY.md', '.secrets/a.txt', '/etc/hosts.txt', '../outside.md', 'link.md', 'state'])
  const { ok, refused } = readDeclared(dir, LD, MEM)
  expect(ok.map(d => d.rel)).toEqual(['state/situation.md', 'knowledge/journal.md', 'state/new-log.txt'])
  expect(refused.map(r => r.line)).toEqual(['state/config.json', 'CLAUDE.md', 'knowledge/REANCHOR.md', 'knowledge/plan.md', 'knowledge/lines/x.md', '.lanes/focus.md', 'memory/MEMORY.md', '.secrets/a.txt', '/etc/hosts.txt', '../outside.md', 'link.md', 'state'])
  expect(refused.find(r => r.line === 'knowledge/plan.md')!.why).toContain('REANCHOR')
  expect(declaredFor('state/situation.md', dir, ok)?.rel).toBe('state/situation.md')
  expect(declaredFor(join(dir, 'state', 'situation.md'), dir, ok)?.rel).toBe('state/situation.md')
  expect(declaredFor('notes.md', dir, ok)).toBeNull()
})

test('appendText: at the end, in one piece; what was there is byte-identical; line breaks are kept tidy (point 1)', () => {
  const f = join(dir, 'state', 'situation.md'), before = readFileSync(f)
  expect(appendText(f, '第二行')).toEqual({ bytes: Buffer.byteLength('第二行\n'), before: before.length })
  const after = readFileSync(f)
  expect(after.subarray(0, before.length).equals(before)).toBe(true)
  expect(after.toString('utf8')).toBe('# 狀況\n第一行\n第二行\n')
  writeFileSync(join(dir, 'state', 'nonl.txt'), 'no newline')
  appendText(join(dir, 'state', 'nonl.txt'), 'next\n')
  expect(readFileSync(join(dir, 'state', 'nonl.txt'), 'utf8')).toBe('no newline\nnext\n')
  appendText(join(dir, 'state', 'new-log.txt'), 'first')                       // not there yet: created
  expect(readFileSync(join(dir, 'state', 'new-log.txt'), 'utf8')).toBe('first\n')
})

test('two writers at once, 20 lines each (this process and 20 shells with >>): all 40 are there, whole (point 5)', async () => {
  const f = join(dir, 'state', 'race.log'); writeFileSync(f, '')
  const shells = Array.from({ length: 20 }, (_, i) => new Promise<void>(res => { const c = spawn('sh', ['-c', `printf 'main line ${i} ${'m'.repeat(200)}\\n' >> "${f}"`]); c.on('exit', () => res()) }))
  for (let i = 0; i < 20; i++) { appendText(f, `lane line ${i} ${'l'.repeat(200)}`); await new Promise(r => setTimeout(r, 1)) }
  await Promise.all(shells)
  const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean)
  expect(lines.length).toBe(40)
  for (let i = 0; i < 20; i++) { expect(lines).toContain(`lane line ${i} ${'l'.repeat(200)}`); expect(lines).toContain(`main line ${i} ${'m'.repeat(200)}`) }
})

test('the guard: Write, Edit, > , >> , sed -i , rm on a declared file are refused for a reflex lane and for a worker holding a claim (point 2)', () => {
  setDeclared(['state/situation.md'])
  const f = join(dir, 'state', 'situation.md')
  writeFileSync(join(LD, 'state.json'), JSON.stringify({ lanes: { 'adam.worker.2': { kind: 'worker', status: 'open' } }, claims: { [f]: { lane: 'adam.worker.2', since: '2026-11-23T00:00:00Z', why: 't' } } }))
  for (const [kind, lane] of [['reflex', 'adam.reflex.1'], ['mail', 'adam.mail.1'], ['worker', 'adam.worker.2']] as const) {
    expect([kind, guard(kind, { tool_name: 'Write', tool_input: { file_path: f, content: 'x' } }, lane)]).toEqual([kind, expect.stringContaining('append_file')])
    expect([kind, guard(kind, { tool_name: 'Edit', tool_input: { file_path: 'state/situation.md', old_string: '第一行', new_string: '改掉' } }, lane)]).toEqual([kind, expect.stringContaining('append_file')])
    for (const cmd of [`echo x > state/situation.md`, `echo x >> state/situation.md`, `sed -i 's/第一行/改/' state/situation.md`, `rm state/situation.md`, `cp notes.md ${f}`, `rm -r state`])
      expect([kind, cmd, guard(kind, { tool_name: 'Bash', tool_input: { command: cmd } }, lane)]).toEqual([kind, cmd, expect.stringContaining('append_file')])
    // the BSD spelling (sed -i '' …): the guard reads the script as a target; refused all the same, whatever the words
    expect([kind, guard(kind, { tool_name: 'Bash', tool_input: { command: `sed -i '' 's/第一行/改/' state/situation.md` } }, lane)]).not.toEqual([kind, ''])
  }
  expect(readFileSync(f, 'utf8')).toBe('# 狀況\n第一行\n第二行\n')
})

test('an undeclared workspace file is refused as before; with no declaration nothing mentions append_file (points 3 and 6)', () => {
  setDeclared(['state/situation.md'])
  const undeclared = guard('reflex', { tool_name: 'Write', tool_input: { file_path: join(dir, 'notes.md'), content: 'x' } })
  expect(undeclared).toContain('does not edit workspace files'); expect(undeclared).not.toContain('append_file')
  expect(guard('reflex', { tool_name: 'Write', tool_input: { file_path: join(dir, 'out', 'scratch.txt'), content: 'x' } })).toBe('')          // out/ still open
  const before = ['Write', 'Bash'].map(t => guard('reflex', t === 'Write' ? { tool_name: 'Write', tool_input: { file_path: join(dir, 'state', 'situation.md'), content: 'x' } } : { tool_name: 'Bash', tool_input: { command: 'echo x >> state/situation.md' } }))
  spawnSync('rm', [join(LD, 'appendable.txt')])
  const without = ['Write', 'Bash'].map(t => guard('reflex', t === 'Write' ? { tool_name: 'Write', tool_input: { file_path: join(dir, 'state', 'situation.md'), content: 'x' } } : { tool_name: 'Bash', tool_input: { command: 'echo x >> state/situation.md' } }))
  expect(before.every(s => s.includes('append_file'))).toBe(true)
  expect(without.every(s => s !== '' && !s.includes('append_file'))).toBe(true)       // refused by the rules that were there before WO-123
  expect(existsSync(join(LD, 'appendable.txt'))).toBe(false)
  expect(readDeclared(dir, LD, MEM)).toEqual({ ok: [], refused: [] })
})

// ---- through the lanes: the tool, its ledger line, the refusals (points 1, 3, 4)
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?append') as typeof import('./lanes.ts')
const ldir = mkdtempSync(join(tmpdir(), 'lanes-append-run-'))
process.env.LANES_DIR = join(ldir, '.lanes'); mkdirSync(join(ldir, '.lanes'), { recursive: true }); mkdirSync(join(ldir, 'state'), { recursive: true })
copyFileSync(process.env.LANES_TEST_ROUTER ?? join(import.meta.dir, 'lanes-router.fleet.json'), join(ldir, '.lanes', 'router.json'))
const GO = join(ldir, 'go'), bin = join(ldir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, time
t0 = time.time()
while time.time() - t0 < 30 and not os.path.exists('${GO}'): time.sleep(0.02)
try: os.remove('${GO}')
except OSError: pass
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: ldir, transcriptDir: ldir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
afterAll(() => { try { writeFileSync(GO, 'ok') } catch {}; L.__setClaudeBin(restore); delete process.env.LANES_FLOOD_CONTROL })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }

test('a reflex lane: append_file adds to a declared file and writes the ledger; an undeclared or never-declarable path is refused with nothing written', async () => {
  writeFileSync(join(ldir, 'state', 'situation.md'), '既有\n'); writeFileSync(join(ldir, 'CLAUDE.md'), 'persona\n'); writeFileSync(join(ldir, 'other.md'), 'o\n')
  writeFileSync(join(ldir, '.lanes', 'appendable.txt'), 'state/situation.md\nCLAUDE.md\n')
  expect(L.laneToolsFor('reflex').map((t: any) => t.name)).toContain('append_file')
  expect(L.mainToolDefs().map((t: any) => t.name)).toContain('append_file')
  expect(L.isMainTool('append_file')).toBe(true)
  const text = '心跳 6857：一切正常'
  const ev: any = { id: 'mesh-ap-1', source: 'mesh', from: 'eve', verified: true, text: '補一行狀態', meta: {}, line: 'call', notif: { method: 'notifications/claude/channel', params: { content: '補一行狀態', meta: {} } } }
  const d = await L.routeEvent(ev)
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  const tok = L.__runTok(d.lane!)!
  expect(await L.callLaneTool(tok, 'append_file', { path: 'state/situation.md', text })).toContain('added')
  expect(readFileSync(join(ldir, 'state', 'situation.md'), 'utf8')).toBe(`既有\n${text}\n`)
  expect(await L.callLaneTool(tok, 'append_file', { path: 'other.md', text })).toContain('refused: other.md is not a file the main declared')
  expect(await L.callLaneTool(tok, 'append_file', { path: 'CLAUDE.md', text })).toContain('refused')
  expect(await L.callLaneTool(tok, 'append_file', { path: 'state/situation.md', text: 'x'.repeat(APPEND_MAX + 1) })).toContain('at most')
  expect(readFileSync(join(ldir, 'CLAUDE.md'), 'utf8')).toBe('persona\n'); expect(readFileSync(join(ldir, 'other.md'), 'utf8')).toBe('o\n')
  const led = readFileSync(join(ldir, '.lanes', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  expect(led.filter(r => r.kind === 'action' && String(r.text).startsWith('append_file state/situation.md')).length).toBe(1)
  writeFileSync(GO, 'ok'); await until(() => !L.__runTok(d.lane!))
})
