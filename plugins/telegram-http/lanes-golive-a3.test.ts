// lanes-golive A3: lane sessions run with --setting-sources project,local, so the user's hooks never loaded in a lane: no secret scrubbing, no authority
// table, no alert-setup reminder. The lane settings now carry the user's guard hooks (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse) by
// default, without the main-only ones (the Telegram reply gates, the main's re-anchor) and without any turn-closing event.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const cfg = mkdtempSync(join(tmpdir(), 'golive-a3-cfg-'))
const H = (cmd: string, timeout = 5) => ({ type: 'command', command: cmd, timeout })
writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'not-a-real-token' }, hooks: {
  Stop: [{ hooks: [H('/u/.claude/hooks/check_tg_reply.py', 20), H('/u/.claude/hooks/check_scheduled_receipt.py', 20)] }],
  PostToolUse: [{ matcher: '*', hooks: [H('/u/py /u/Skills/tools/secret-scrub/redact_hook.py')] }],
  SessionStart: [{ hooks: [H('python3 /u/.claude/hooks/authority_hook.py'), H('python3 /u/.claude/hooks/reanchor_hook.py', 10)] }],
  PreToolUse: [{ matcher: '*', hooks: [H('python3 /u/.claude/hooks/authority_hook.py')] }, { matcher: 'Bash|Edit|Write|MultiEdit', hooks: [H('python3 /u/.claude/hooks/alert_setup_hook.py')] }],
  UserPromptSubmit: [{ hooks: [H('python3 /u/.claude/hooks/authority_hook.py')] }],
  PreCompact: [{ hooks: [H('python3 /u/.claude/hooks/reanchor_hook.py', 30)] }],
} }))
const was = { cfg: process.env.CLAUDE_CONFIG_DIR, guards: process.env.LANES_USER_GUARDS, skip: process.env.LANES_USER_HOOKS_SKIP }
process.env.CLAUDE_CONFIG_DIR = cfg
delete process.env.LANES_USER_GUARDS; delete process.env.LANES_USER_HOOKS_SKIP
const L = await import('./lanes.ts?golive-a3') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'golive-a3-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false } as any)
afterAll(() => {
  for (const [k, v] of [['CLAUDE_CONFIG_DIR', was.cfg], ['LANES_USER_GUARDS', was.guards], ['LANES_USER_HOOKS_SKIP', was.skip]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
})
const settings = () => JSON.parse(readFileSync(join(dir, 'lane-settings.json'), 'utf8'))
const cmds = (s: any, ev: string): string[] => (s.hooks[ev] ?? []).flatMap((m: any) => m.hooks.map((h: any) => h.command))

test('A3: by default the user\'s guard hooks ride in the lane settings beside the plugin\'s, event / matcher / timeout kept', () => {
  const s = settings()
  expect(cmds(s, 'PostToolUse')).toContain('/u/py /u/Skills/tools/secret-scrub/redact_hook.py')
  expect(s.hooks.PostToolUse.find((m: any) => m.hooks.some((h: any) => h.command.includes('redact_hook')))).toMatchObject({ matcher: '*', hooks: [{ timeout: 5 }] })
  expect(cmds(s, 'PreToolUse')).toEqual(expect.arrayContaining([expect.stringContaining('lane-guard-hook.py'), 'python3 /u/.claude/hooks/authority_hook.py', 'python3 /u/.claude/hooks/alert_setup_hook.py']))
  expect(s.hooks.PreToolUse.find((m: any) => m.hooks.some((h: any) => h.command.includes('alert_setup_hook'))).matcher).toBe('Bash|Edit|Write|MultiEdit')
  expect(cmds(s, 'SessionStart')).toEqual(['python3 /u/.claude/hooks/authority_hook.py'])
  expect(cmds(s, 'UserPromptSubmit')).toEqual(['python3 /u/.claude/hooks/authority_hook.py'])
})

test('A3: the main-only hooks stay out: the Telegram reply gates (Stop), the re-anchor (SessionStart, PreCompact); a lane\'s Stop is the plugin\'s alone', () => {
  const s = settings()
  expect(cmds(s, 'Stop')).toEqual([expect.stringContaining('lane-stop-hook.py')])
  expect(JSON.stringify(s)).not.toContain('check_tg_reply'); expect(JSON.stringify(s)).not.toContain('check_scheduled_receipt'); expect(JSON.stringify(s)).not.toContain('reanchor_hook')
  expect(s.hooks.PreCompact).toBeUndefined()
  expect(JSON.stringify(s)).not.toContain('not-a-real-token')            // the env (the login) never goes into a file
})
