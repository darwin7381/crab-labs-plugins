// lanes-golive C4 / C5 / A4: the main is found by its session id, never as "the newest transcript": lane runs write theirs into the same project dir.
// One entry point (lanes-launch.ts) writes the main's hooks and main-expected and returns the claude arguments (--resume <id> / --session-id <id>, never
// --continue); every newest-transcript reader of the daemons reads the main's own file with lanes on.
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchMain, mainSettings, projectDirOf } from './lanes-launch.ts'
import { receiptLinesIn } from './receipt.ts'
import { LocalKeepwarm, POKE_TEXT } from './keepwarm-local.ts'

const home = mkdtempSync(join(tmpdir(), 'golive-c4-home-'))
const ws = mkdtempSync(join(tmpdir(), 'golive c4_ws-'))       // a space and an underscore: the 1.33.2 project-dir rule
const prev = { LANES_DIR: process.env.LANES_DIR, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
delete process.env.LANES_DIR; delete process.env.CLAUDE_CONFIG_DIR
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']
let k = 0
const newId = () => ids[k++]

test('projectDirOf: every character other than a letter or digit becomes "-" (fleet 1.33.2)', () => {
  expect(projectDirOf('/a/b c_d.e', '/h')).toBe('/h/.claude/projects/-a-b-c-d-e')
})

test('launchMain: no main yet → a new id with --session-id; main-settings.json (the main hooks, absolute plugin paths) and main-expected written; never --continue', () => {
  const r = launchMain({ workspace: ws, home, newId, agent: 'labtest' })
  expect(r.args).toEqual(['--settings', join(ws, '.lanes', 'main-settings.json'), '--session-id', ids[0]])
  expect(r.args).not.toContain('--continue')
  expect(readFileSync(join(ws, '.lanes', 'main-expected'), 'utf8').trim()).toBe(ids[0])
  const st = JSON.parse(readFileSync(r.settings, 'utf8'))
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'StopFailure', 'SessionEnd']) expect(st.hooks[ev][0].hooks[0].command).toMatch(/\/lanes-hooks\/main-hook\.py$/)
  expect(st.hooks.PostToolUse[1]).toMatchObject({ matcher: 'Write|Edit', hooks: [{ command: expect.stringMatching(/memory-commit-hook\.py$/) }] })
  expect(st.env).toEqual({ LANES_AGENT: 'labtest' })
})

test('launchMain: the registered main (main-expected) is resumed when its transcript exists, else started under the same id', () => {
  expect(launchMain({ workspace: ws, home, newId }).args.slice(2)).toEqual(['--session-id', ids[0]])          // no transcript yet: the same id
  const proj = projectDirOf(ws, home); mkdirSync(proj, { recursive: true }); writeFileSync(join(proj, `${ids[0]}.jsonl`), '{}\n')
  writeFileSync(join(proj, 'lane-newer.jsonl'), '{}\n')                                                         // a lane's newer transcript does not matter
  const r = launchMain({ workspace: ws, home, newId })
  expect(r.args.slice(2)).toEqual(['--resume', ids[0]]); expect(r.resume).toBe(true)
})

test('launchMain: /new (--fresh or the run/fresh marker, consumed) → a new id; /main renew → its id; an explicit --session wins over main-expected', () => {
  writeFileSync(join(ws, '.lanes', 'run', 'fresh'), '')
  const f = launchMain({ workspace: ws, home, newId })
  expect(f.session_id).toBe(ids[1]); expect(existsSync(join(ws, '.lanes', 'run', 'fresh'))).toBe(false)
  writeFileSync(join(ws, '.lanes', 'run', 'renew'), ids[2] + '\n')
  expect(launchMain({ workspace: ws, home, newId }).session_id).toBe(ids[2])
  expect(launchMain({ workspace: ws, home, newId, session: ids[0] }).args.slice(2)).toEqual(['--resume', ids[0]])
  expect(readFileSync(join(ws, '.lanes', 'main-expected'), 'utf8').trim()).toBe(ids[0])
})

test('the lanes module: mainTranscriptFile reads the main by its session id (main-expected in the inbox daemon), not the newest file', async () => {
  const L = await import('./lanes.ts?golive-c4') as typeof import('./lanes.ts')
  const dir = mkdtempSync(join(tmpdir(), 'golive-c4-lanes-'))
  process.env.LANES_DIR = join(dir, '.lanes')
  L.lanesInit({ role: 'inbox', agent: 'adam', workspaceDir: dir, transcriptDir: join(dir, 'proj'), httpPort: 0, log: () => {}, authOk: () => false } as any)
  expect(L.mainTranscriptFile(join(dir, 'proj'))).toBeNull()                                                    // nothing is guessed
  writeFileSync(join(dir, '.lanes', 'main-expected'), ids[0] + '\n')
  expect(L.mainSessionId()).toBe(ids[0])
  expect(L.mainTranscriptFile(join(dir, 'proj'))).toBe(join(dir, 'proj', `${ids[0]}.jsonl`))
  delete process.env.LANES_DIR
})

test('receiptLinesIn reads only the named transcripts', () => {
  const d = mkdtempSync(join(tmpdir(), 'golive-c4-rc-'))
  writeFileSync(join(d, 'main.jsonl'), 'x <channel ts=\\"A\\"> main\n'); writeFileSync(join(d, 'lane.jsonl'), 'x <channel ts=\\"B\\"> lane\n')
  expect(receiptLinesIn([join(d, 'main.jsonl')]).join('')).toContain('main')
  expect(receiptLinesIn([join(d, 'main.jsonl')]).join('')).not.toContain('lane')
})

test('keepwarm-local: with the main\'s transcript named it judges the main, not the newer lane file in the same directory', async () => {
  const d = mkdtempSync(join(tmpdir(), 'golive-c4-kw-'))
  const t0 = Date.now() / 1000 - 52 * 60
  const iso = (t: number) => new Date(t * 1000).toISOString()
  const rec = (t: number) => [{ type: 'user', timestamp: iso(t), message: { content: 'work' } }, { type: 'api-request', querySource: 'repl_main_thread', timestamp: iso(t + 1) },
    { type: 'assistant', timestamp: iso(t + 2), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage: { cache_creation: { ephemeral_1h_input_tokens: 5 } } } },
    { type: 'system', subtype: 'turn_duration', timestamp: iso(t + 3) }].map(r => JSON.stringify(r)).join('\n') + '\n'
  writeFileSync(join(d, 'main.jsonl'), rec(t0)); writeFileSync(join(d, 'lane.jsonl'), rec(Date.now() / 1000 - 60))
  const past = new Date(Date.now() - 3600_000); utimesSync(join(d, 'main.jsonl'), past, past)
  const sent: string[] = []
  const mk = (transcript?: () => string | null) => new LocalKeepwarm({ name: 'adam', stateDir: mkdtempSync(join(tmpdir(), 'golive-c4-kws-')), mode: () => 'dry', projectsDir: () => d,
    ...(transcript ? { transcript } : {}), mail: async () => ({ on: false, n: 0, oldestS: null }), deliver: async t => { sent.push(t); return true }, log: () => {} })
  expect((await mk().run()).join('\n')).not.toContain('KEEPWARM-DRY')                                           // newest = the lane's: "idle 1 min"
  expect((await mk(() => join(d, 'main.jsonl')).run()).join('\n')).toContain('KEEPWARM-DRY')                    // the main's: idle 52 min, poked
  expect(await mk(() => join(d, 'gone.jsonl')).run()).toEqual([])                                                // a main with no transcript yet: nothing
  expect(POKE_TEXT).toContain('[保溫]')
})

test('the mailbox daemon no longer starts the retired keepwarm delivery', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  expect(src).not.toContain('new LocalKeepwarm(')
  if (prev.LANES_DIR) process.env.LANES_DIR = prev.LANES_DIR
  if (prev.CLAUDE_CONFIG_DIR) process.env.CLAUDE_CONFIG_DIR = prev.CLAUDE_CONFIG_DIR
})
