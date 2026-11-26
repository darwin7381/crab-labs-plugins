// roamer-sessions.test.ts: pins what the roamer's /roam list (listRoamableSessions) returns, so moving the session finder out of
// roamer-control.ts into session-finder.ts (board WO-183) is shown not to change it. The same file passes on the commit before the move
// (5c04c0d, where the finder still lived in roamer-control.ts) and after it.
//
// No real Claude Code, tmux or process table is touched: fake `claude`, `tmux` and `ps` go first on PATH for this file only, and print
// fixed listings. The fake tmux answers list-panes and has-session and records every call; anything else fails, and the test checks none came.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'roamer-pin-'))
const bin = join(dir, 'bin')
const home = homedir()
const saved = { PATH: process.env.PATH, ROAMER_REGISTRY_FILE: process.env.ROAMER_REGISTRY_FILE, TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE }
let listRoamableSessions: () => Promise<any[]>

// the machine as the fakes describe it
const agents = [
  { pid: 5101, cwd: '/srv/proj/alpha', kind: 'interactive', startedAt: 1, sessionId: 'aaaa-1', status: 'idle', name: 'alpha' },     // tmux alpha-tmux (via 5100)
  { pid: 5201, cwd: join(home, 'cc-workspaces', 'claude-x'), kind: 'interactive', startedAt: 2, sessionId: 'sys-1', status: 'idle' }, // an agent: not roamable
  { pid: 5301, cwd: '/tmp/naked', kind: 'interactive', startedAt: 3, sessionId: 'naked-1', status: 'busy' },                       // no tmux
  { pid: 5401, cwd: join(home, '.claude', 'workspace-telegram'), kind: 'interactive', startedAt: 4, sessionId: 'sys-2', status: 'idle' },
  { pid: 0, cwd: '/srv/nopid', kind: 'interactive', startedAt: 5, sessionId: 'nopid-1', status: 'idle' },                          // no pid: left out
  { pid: 5501, cwd: '/srv/bg', kind: 'background', startedAt: 6, sessionId: 'bg-1', status: 'busy' },                             // background: left out
  { pid: 5601, cwd: join(home, 'agy-workspaces', 'foo'), kind: 'interactive', startedAt: 7, sessionId: 'sys-3', status: 'idle' },
  { pid: 5701, cwd: '/srv/deep', kind: 'interactive', startedAt: 8, sessionId: 'deep-1', status: 'idle' },                         // beta (first pane it descends from)
  { pid: 5801, cwd: '/srv/claimed', kind: 'interactive', startedAt: 9, sessionId: 'claimed-1', status: 'idle' },                   // claimed by another TG roamer
  { pid: 5901, cwd: '/srv/dc', kind: 'interactive', startedAt: 10, sessionId: 'dc-1', status: 'busy' },                            // claimed by a Discord roamer: still listed
  { pid: 6001, kind: 'interactive', startedAt: 11, sessionId: 'nocwd-1', status: 'idle' },                                        // no cwd: left out
]
const panes = ['9999:zeta', '5100:alpha-tmux', '5699:beta', '5700:gamma', '5800:claimed-tmux', 'x:badpid', ':nopid', 'nosep']
const ps = ['  5101  5100', ' 5100     1', '5301 1', '5701 5700', '5700 5699', '5699 1', '5801 5800', '5800 1', '5901 1', '9999 1', '5201 1']

beforeAll(async () => {
  require('node:fs').mkdirSync(bin)
  writeFileSync(join(dir, 'agents.json'), JSON.stringify(agents))
  writeFileSync(join(dir, 'panes.txt'), panes.join('\n') + '\n')
  writeFileSync(join(dir, 'ps.txt'), ps.join('\n') + '\n')
  const script = (body: string) => `#!/bin/sh\nD='${dir}'\n${body}\n`
  writeFileSync(join(bin, 'claude'), script(`echo "claude $*" >> "$D/calls.log"\nif [ "$1" = agents ] && [ "$2" = --json ]; then cat "$D/agents.json"; exit 0; fi\nexit 1`))
  writeFileSync(join(bin, 'tmux'), script(`echo "tmux $*" >> "$D/calls.log"\ncase "$1" in\n  list-panes) cat "$D/panes.txt"; exit 0;;\n  has-session) exit 0;;\nesac\nexit 1`))
  writeFileSync(join(bin, 'ps'), script(`echo "ps $*" >> "$D/calls.log"\nif [ "$*" = "-o pid=,ppid= -A" ]; then cat "$D/ps.txt"; exit 0; fi\nexit 1`))
  for (const b of ['claude', 'tmux', 'ps']) chmodSync(join(bin, b), 0o755)
  // the registry: another TG roamer holds claimed-1, a Discord roamer holds dc-1, a dead TG roamer held aaaa-1 (dropped at read)
  const alive = { daemon_pid: process.ppid, claude_pid: process.pid, updated_at: 1 }
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({
    other_bot: { ...alive, tmux: 'claimed-tmux', session_id: 'claimed-1', cwd: '/srv/claimed', protocol: 'telegram' },
    dc_bot: { ...alive, tmux: 'dc-tmux', session_id: 'dc-1', cwd: '/srv/dc', protocol: 'discord' },
    dead_bot: { daemon_pid: 2 ** 22 + 12345, claude_pid: process.pid, updated_at: 1, tmux: 'x', session_id: 'aaaa-1', cwd: '/srv/proj/alpha', protocol: 'telegram' },
  }))
  process.env.PATH = `${bin}:${saved.PATH}`
  process.env.ROAMER_REGISTRY_FILE = join(dir, 'registry.json')
  delete process.env.TMUX
  delete process.env.TMUX_PANE
  ;({ listRoamableSessions } = await import('./roamer-control.ts'))
})

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  rmSync(dir, { recursive: true, force: true })
})

describe('the roamer\'s /roam list (WO-183 pin: the same before and after the move)', () => {
  test('listRoamableSessions returns exactly this', async () => {
    const got = await listRoamableSessions()
    expect(got).toEqual([
      { pid: 5901, cwd: '/srv/dc', projectName: 'dc', sessionId: 'dc-1', status: 'busy', tmuxName: null, claimedBy: null },
      { pid: 5701, cwd: '/srv/deep', projectName: 'deep', sessionId: 'deep-1', status: 'idle', tmuxName: 'beta', claimedBy: null },
      { pid: 5301, cwd: '/tmp/naked', projectName: 'naked', sessionId: 'naked-1', status: 'busy', tmuxName: null, claimedBy: null },
      { pid: 5101, cwd: '/srv/proj/alpha', projectName: 'alpha', sessionId: 'aaaa-1', status: 'idle', tmuxName: 'alpha-tmux', claimedBy: null },
      { pid: 5801, cwd: '/srv/claimed', projectName: 'claimed', sessionId: 'claimed-1', status: 'idle', tmuxName: 'claimed-tmux', claimedBy: 'other_bot' },
    ])
  })

  test('it only listed: claude agents, tmux list-panes and has-session, ps; the dead roamer dropped from the registry', () => {
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n')
    expect(calls.filter(c => !/^(claude agents --json|tmux list-panes -a -F .*|tmux has-session -t .*|ps -o pid=,ppid= -A)$/.test(c))).toEqual([])
    expect(calls.some(c => c.startsWith('tmux list-panes'))).toBe(true)
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'registry.json'), 'utf8'))).sort()).toEqual(['dc_bot', 'other_bot'])
  })
})
