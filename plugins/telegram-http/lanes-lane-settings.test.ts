// A lane is the plugin's session, not the user's (RBU2). The user's settings carry the fleet's check_tg_reply.py Stop hook, which blocks every Stop that
// sent no Telegram reply: in a lane (live u002o-T1-a-r1-20261117-215910, lane transcripts) it fights the design, where routine work is a silent line or a
// receipt and lane-stop-hook.py owns what is still owed. A lane runs with --setting-sources project,local and the plugin's lane settings; it takes from the
// user's settings only their env (the login) and the guards LANES_USER_GUARDS names. A script stands in for `claude -p`. No model, no network.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_FLOOD_CONTROL = '0'
const dir = mkdtempSync(join(tmpdir(), 'lanes-ls-'))
const cfg = join(dir, 'user-claude')
mkdirSync(cfg)
writeFileSync(join(cfg, 'settings.json'), JSON.stringify({
  env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-login', DISABLE_AUTOUPDATER: '1' },
  model: 'claude-opus-5-5',
  enabledPlugins: { 'codex@openai-codex': true },
  hooks: {
    Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/home/u/.claude/hooks/check_tg_reply.py' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'python3 /home/u/.claude/hooks/authority_hook.py' }] }],
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'python3 /home/u/.claude/hooks/authority_hook.py' }] },
      { matcher: 'Bash|WebFetch|WebSearch', hooks: [{ type: 'command', command: 'python3 /home/u/.claude/hooks/eden_guard.py' }] }],
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'python3 /home/u/.claude/hooks/secret-scrub/redact_hook.py', timeout: 5 }] }],
  },
}))
const was = { cfg: process.env.CLAUDE_CONFIG_DIR, guards: process.env.LANES_USER_GUARDS }
process.env.CLAUDE_CONFIG_DIR = cfg
process.env.LANES_USER_GUARDS = 'eden_guard.py,redact_hook.py,not_installed.py'
const L = await import('./lanes.ts?ls-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const ARGS = join(dir, 'args.json')
const bin = join(dir, 'claude.sh')
writeFileSync(bin, `#!/bin/sh\npython3 -c 'import json,os,sys; json.dump({"argv": sys.argv[1:], "login": os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"), "autoupd": os.environ.get("DISABLE_AUTOUPDATER")}, open("${ARGS}", "w"))' "$@"\necho '{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","result":"done"}'\n`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
const logs: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: (_l: string, m: string) => { logs.push(m) }, authOk: () => false,
  registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
afterAll(() => {
  L.__setClaudeBin(restore); delete process.env.LANES_FLOOD_CONTROL
  if (was.cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = was.cfg
  if (was.guards === undefined) delete process.env.LANES_USER_GUARDS; else process.env.LANES_USER_GUARDS = was.guards
})
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const settings = () => JSON.parse(readFileSync(join(dir, 'lane-settings.json'), 'utf8'))
const commands = (ev: string): string[] => (settings().hooks[ev] ?? []).flatMap((m: any) => m.hooks.map((h: any) => h.command))

test('the lane settings: the plugin\'s barrier, guard and stop hooks, plus the user guards LANES_USER_GUARDS names (event, matcher, timeout kept); no other user hook', () => {
  expect(commands('Stop').length).toBe(1); expect(commands('Stop')[0]).toContain('lane-stop-hook.py')         // check_tg_reply.py is not a lane's
  expect(commands('Stop').join(' ')).not.toContain('check_tg_reply')
  expect(settings().hooks.SessionStart).toBeUndefined()                                                        // authority_hook.py: context, not a guard
  expect(JSON.stringify(settings())).not.toContain('authority_hook')
  expect(commands('PreToolUse').some(c => c.includes('lane-guard-hook.py'))).toBe(true)
  expect(settings().hooks.PreToolUse.find((m: any) => m.hooks[0].command.includes('eden_guard.py'))).toEqual(
    { matcher: 'Bash|WebFetch|WebSearch', hooks: [{ type: 'command', command: 'python3 /home/u/.claude/hooks/eden_guard.py' }] })
  expect(settings().hooks.PostToolUse.find((m: any) => m.hooks[0].command.includes('redact_hook.py'))).toEqual(
    { matcher: '*', hooks: [{ type: 'command', command: 'python3 /home/u/.claude/hooks/secret-scrub/redact_hook.py', timeout: 5 }] })
  expect(JSON.stringify(settings())).not.toContain('test-login')                                               // the login is never written to a file
  expect(logs.some(l => l.includes('not_installed.py'))).toBe(true)                                            // a named guard that is not there is said
})

test('a lane run: --setting-sources project,local (the user\'s settings, their hooks and the plugins they enable do not load); their env (the login) is in its environment', async () => {
  const ev = { id: 'mesh-ls-1', source: 'mesh', from: 'scheduler', verified: true, text: '[scheduled][backup-check][run:901][P3][routine] backup-check', meta: {},
    notif: { method: 'notifications/claude/channel', params: { content: 'backup-check', meta: {} } } } as any
  await L.routeEvent(ev)
  for (let i = 0; i < 300 && !existsSync(ARGS); i++) await sleep(20)
  const got = JSON.parse(readFileSync(ARGS, 'utf8'))
  const a: string[] = got.argv
  expect(a[a.indexOf('--setting-sources') + 1]).toBe('project,local')
  expect(a[a.indexOf('--settings') + 1]).toBe(join(dir, 'lane-settings.json'))
  expect(got.login).toBe('test-login'); expect(got.autoupd).toBe('1')
})
