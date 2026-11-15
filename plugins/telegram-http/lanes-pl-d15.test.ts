// Universe 002l (D15, RV4; S0 item 1): lanes of one kind share the cached prefix up to and including the card and the CLAUDE.md context: the instruction
// files and the memory index are in a per-kind system prompt file, claude's own CLAUDE.md discovery and auto-memory are off for lanes, the per-run text is
// only in -p; the memory index exists before the first lane starts. design/overview 「同資料夾的平行 session 還會共用前段的快取」. No model: the lane is a script.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?pl-d15-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const root = mkdtempSync(join(tmpdir(), 'lanes-pld15-'))
const home = join(root, 'home'), ws = join(root, 'ws', 'adam'), proj = join(root, 'proj')
mkdirSync(join(home, '.claude'), { recursive: true }); mkdirSync(join(ws, '.lanes'), { recursive: true }); mkdirSync(proj, { recursive: true })
writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# fleet rules\nUSER-RULE-1\n')
writeFileSync(join(ws, 'CLAUDE.md'), '# Adam\nPERSONA-ADAM\n')
process.env.LANES_DIR = join(ws, '.lanes')
copyFileSync(ROUTER, join(ws, '.lanes', 'router.json'))
writeFileSync(join(ws, '.lanes', 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(proj, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(root, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import sys, os, json
open('${root}/runs.jsonl', 'a').write(json.dumps({'argv': sys.argv[1:], 'env': {k: os.environ.get(k) for k in ('CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'HOME')}}) + '\\n')
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
const realHome = process.env.HOME
afterAll(() => { L.__setClaudeBin(restore); delete process.env.LANES_FLOOD_CONTROL; process.env.HOME = realHome })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: ws, transcriptDir: proj, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const runs = (): any[] => { try { return readFileSync(join(root, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const after = (a: string[], f: string) => a[a.indexOf(f) + 1]
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const ev = (id: string, from: string, text: string) => ({ id, source: 'mesh', from, verified: true, text, meta: {}, notif: { method: '', params: {} } } as any)
const withHome = async <T>(f: () => Promise<T>): Promise<T> => { process.env.HOME = home; try { return await f() } finally { process.env.HOME = realHome } }

test('S0: the memory index is created (empty) before the first lane starts, and an existing one is never overwritten', async () => {
  expect(existsSync(join(proj, 'memory', 'MEMORY.md'))).toBe(false)
  await withHome(() => L.routeEvent(ev('mesh-1', 'eve', 'QUESTION-ONE 逾時是多少？')))
  expect(await until(() => runs().length === 1)).toBe(true)
  expect(readFileSync(join(proj, 'memory', 'MEMORY.md'), 'utf8')).toBe('')
  writeFileSync(join(proj, 'memory', 'MEMORY.md'), '- [Backup rule](feedback_backup.md) — MEMORY-LINE-1\n')
  L.ensureMemoryIndex()
  expect(readFileSync(join(proj, 'memory', 'MEMORY.md'), 'utf8')).toContain('MEMORY-LINE-1')
})

test('D15: two reflex lanes get the same system prompt file: user CLAUDE.md, project CLAUDE.md, the memory index, then the card; no per-run text in it', async () => {
  writeFileSync(join(ws, '.lanes', 'focus.md'), '焦點：FOCUS-CARD-X')
  const a = await withHome(() => L.routeEvent(ev('mesh-2', 'eve', 'QUESTION-TWO')))
  const b = await withHome(() => L.routeEvent(ev('mesh-3', 'cain', 'QUESTION-THREE')))
  expect(await until(() => runs().length === 3)).toBe(true)
  const [ra, rb] = runs().slice(1)
  const fa = after(ra.argv, '--append-system-prompt-file'), fb = after(rb.argv, '--append-system-prompt-file')
  expect(fa).toBe(fb)
  expect(ra.argv).not.toContain('--append-system-prompt')
  const sp = readFileSync(fa, 'utf8')
  const iu = sp.indexOf('USER-RULE-1'), ip = sp.indexOf('PERSONA-ADAM'), im = sp.indexOf('MEMORY-LINE-1'), ic = sp.indexOf('# 你的身分')
  expect(iu).toBeGreaterThan(0); expect(ip).toBeGreaterThan(iu); expect(im).toBeGreaterThan(ip); expect(ic).toBeGreaterThan(im)
  expect(sp).toContain(`Contents of ${join(ws, 'CLAUDE.md')} (project instructions, checked into the codebase):`)
  for (const per of [a.lane!, b.lane!, 'FOCUS-CARD-X', 'QUESTION-TWO', 'QUESTION-THREE', st().lanes[a.lane!].thread]) expect(sp).not.toContain(per)
  for (const r of [ra, rb]) { const p = after(r.argv, '-p'); expect(p).toContain('FOCUS-CARD-X'); expect(p).not.toContain('PERSONA-ADAM') }   // per-run text only in -p
  expect(ra.env).toMatchObject({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' })
  expect(JSON.parse(readFileSync(join(ws, '.lanes', 'lane-settings.json'), 'utf8')).autoMemoryEnabled).toBe(false)
  expect(readFileSync(L.laneSystemPromptFile('worker'), 'utf8')).not.toBe(sp)        // kinds differ (their cards), lanes of a kind do not
})

test('D15 / S0: the switches: LANES_STABLE_PREFIX=0 gives back claude\'s own CLAUDE.md loading (the file keeps the memory index while lane auto-memory is off); LANES_LANE_AUTO_MEMORY=1 as well: the card alone, as in 002k', async () => {
  process.env.LANES_STABLE_PREFIX = '0'
  try {
    await withHome(() => L.routeEvent(ev('mesh-4', 'eve', 'QUESTION-FOUR')))
    expect(await until(() => runs().length === 4)).toBe(true)
    const r = runs()[3]
    expect(r.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBeNull(); expect(r.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1')
    const sp = readFileSync(after(r.argv, '--append-system-prompt-file'), 'utf8')
    expect(sp).not.toContain('PERSONA-ADAM'); expect(sp).toContain('MEMORY-LINE-1')
    process.env.LANES_LANE_AUTO_MEMORY = '1'
    expect(L.laneSystemPrompt('reflex')).toBe(L.identityCard({ kind: 'reflex' }))
  } finally { delete process.env.LANES_STABLE_PREFIX; delete process.env.LANES_LANE_AUTO_MEMORY }
})
const st = () => L.__lanesState()
