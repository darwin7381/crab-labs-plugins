// session-finder.test.ts (board WO-183): the shared session finder. The listings are faked through the runner, except the last test,
// which starts a tmux server of its own on a private socket (-S, TMUX unset) and lists it; it never touches the user's tmux server, and
// is skipped where tmux is missing or TMUX is set.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claudeAgents, descendsFrom, findTmuxForPid, isReadOnlyListing, listAgents, listPanes, listSessions, processParents, runReadOnly,
  type RunResult, type Runner, tmuxForPid,
} from './session-finder.ts'

const AGENTS = [
  { pid: 101, cwd: '/w/a', kind: 'interactive', startedAt: 1, sessionId: 's-a', status: 'idle' },
  { pid: 201, cwd: '/w/b', kind: 'background', startedAt: 2, sessionId: 's-b', status: 'busy' },
  { pid: 0, cwd: '/w/c', kind: 'interactive', startedAt: 3, sessionId: 's-c', status: 'idle' },
  { cwd: '/w/d', kind: 'interactive', startedAt: 4, sessionId: 's-d', status: 'idle' },
  { pid: 301, kind: 'interactive', startedAt: 5, sessionId: 's-e', status: 'idle' },
  { pid: 401, cwd: '/w/f', kind: 'interactive', startedAt: 6, status: 'idle' },
  null,
]
const PANES = 'one\t100\ntwo\t300\nthree\t999\n'
const PS = '101 100\n100 1\n201 1\n301 300\n300 1\n'

/** a runner answering the three listings from fixtures, recording every argv */
function fake(o: { agents?: string; agentsExit?: number; panes?: string; panesExit?: number; ps?: string; psExit?: number } = {}) {
  const calls: string[][] = []
  const run: Runner = async argv => {
    calls.push(argv)
    const r = (stdout: string, exitCode = 0): RunResult => ({ exitCode, stdout, stderr: '' })
    if (argv[1] === 'agents') return r(o.agents ?? JSON.stringify(AGENTS), o.agentsExit ?? 0)
    if (argv[0] === 'tmux') return r(o.panes ?? PANES, o.panesExit ?? 0)
    if (argv[0] === 'ps') return r(o.ps ?? PS, o.psExit ?? 0)
    return r('', 127)
  }
  return { run, calls }
}

describe('read-only listings', () => {
  test('the listings it may run', () => {
    expect(isReadOnlyListing(['claude', 'agents', '--json'])).toBe(true)
    expect(isReadOnlyListing(['/home/x/.local/bin/claude', 'agents', '--json'])).toBe(true)
    expect(isReadOnlyListing(['tmux', 'list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}'])).toBe(true)
    expect(isReadOnlyListing(['tmux', '-S', '/tmp/s', 'list-panes', '-a'])).toBe(true)
    expect(isReadOnlyListing(['tmux', 'list-sessions'])).toBe(true)
    expect(isReadOnlyListing(['ps', '-o', 'pid=,ppid=', '-A'])).toBe(true)
  })
  test('anything else is refused and never started', async () => {
    for (const argv of [['tmux', 'send-keys', '-t', 'x', 'Enter'], ['tmux', 'kill-server'], ['tmux', '-S', '/tmp/s', 'kill-session', '-t', 'x'],
      ['tmux', 'respawn-pane', '-k'], ['tmux', '-S'], ['kill', '-9', '1'], ['claude', '--resume', 'x'], ['claude', 'agents'], ['ps', 'aux'],
      ['sh', '-c', 'claude agents --json'], ['claude', 'agents', '--json', '--x'], []]) {
      expect(isReadOnlyListing(argv)).toBe(false)
      const r = await runReadOnly(argv, 1000)
      expect(r.exitCode).toBe(126)
      expect(r.stderr).toContain('refused')
    }
  })
  test('a listing runs (ps, the real one)', async () => {
    const r = await runReadOnly(['ps', '-o', 'pid=,ppid=', '-A'], 5000)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain(String(process.pid))
  })
})

describe('the listings', () => {
  test('claudeAgents, as roamer-control.ts had it: a null entry makes the filter throw, and the whole list is []', async () => {
    expect(await claudeAgents({ run: fake().run })).toEqual([])
  })
  test('claudeAgents with a well-formed list', async () => {
    const ok = AGENTS.filter(a => a !== null)
    expect((await claudeAgents({ run: fake({ agents: JSON.stringify(ok) }).run })).map(a => a.sessionId)).toEqual(['s-a'])
    expect(await claudeAgents({ run: fake({ agentsExit: 1 }).run })).toEqual([])
    expect(await claudeAgents({ run: fake({ agents: 'not json' }).run })).toEqual([])
    expect(await claudeAgents({ run: fake({ agents: '{}' }).run })).toEqual([])
  })
  test('listAgents keeps every entry with a session id (any kind, any folder, no pid); null on failure', async () => {
    expect((await listAgents({ run: fake().run }))!.map(a => a.sessionId)).toEqual(['s-a', 's-b', 's-c', 's-d', 's-e'])
    expect(await listAgents({ run: fake({ agentsExit: 1 }).run })).toBeNull()
    expect(await listAgents({ run: fake({ agents: '{"x":1}' }).run })).toBeNull()
    expect(await listAgents({ run: fake({ agents: '[]' }).run })).toEqual([])
    const f = fake()
    await listAgents({ run: f.run, claudeBin: '/opt/claude' })
    expect(f.calls[0]).toEqual(['/opt/claude', 'agents', '--json'])
  })
  test('listPanes: tmux order, a pane without a numeric pid left out; null when tmux fails; the private socket goes first', async () => {
    expect(await listPanes({ run: fake({ panes: 'a\t1\nb\tx\nc\t\nno tab\n\t5\n' }).run })).toEqual([{ session: 'a', panePid: 1 }, { session: '', panePid: 5 }])
    expect(await listPanes({ run: fake({ panesExit: 1 }).run })).toBeNull()
    const f = fake()
    await listPanes({ run: f.run, tmuxArgs: ['-S', '/tmp/sock'] })
    expect(f.calls[0].slice(0, 4)).toEqual(['tmux', '-S', '/tmp/sock', 'list-panes'])
  })
  test('processParents; empty when ps fails', async () => {
    expect([...(await processParents({ run: fake().run })).entries()]).toEqual([[101, 100], [100, 1], [201, 1], [301, 300], [300, 1]])
    expect((await processParents({ run: fake({ psExit: 1 }).run })).size).toBe(0)
  })
})

describe('which tmux', () => {
  const parents = new Map([[5, 4], [4, 3], [3, 1], [7, 7], [8, 9], [9, 8]])
  test('descendsFrom', () => {
    expect(descendsFrom(5, 5, parents)).toBe(true)
    expect(descendsFrom(5, 3, parents)).toBe(true)
    expect(descendsFrom(5, 1, parents)).toBe(false)          // init ends the walk
    expect(descendsFrom(7, 3, parents)).toBe(false)          // its own parent
    expect(descendsFrom(8, 3, parents)).toBe(false)          // a loop ends after 50 steps
    expect(descendsFrom(42, 3, parents)).toBe(false)         // unknown
  })
  test('tmuxForPid: the first pane in tmux\'s order', () => {
    expect(tmuxForPid(5, [{ session: 'x', panePid: 9 }, { session: 'outer', panePid: 3 }, { session: 'inner', panePid: 4 }], parents)).toBe('outer')
    expect(tmuxForPid(5, [], parents)).toBeNull()
  })
  test('findTmuxForPid: one list-panes, one ps; null without panes or tmux', async () => {
    const f = fake()
    expect(await findTmuxForPid(101, { run: f.run })).toBe('one')
    expect(f.calls.map(c => c[0])).toEqual(['tmux', 'ps'])
    expect(await findTmuxForPid(201, { run: fake().run })).toBeNull()
    expect(await findTmuxForPid(101, { run: fake({ panesExit: 1 }).run })).toBeNull()
    const g = fake({ panes: '' })
    expect(await findTmuxForPid(101, { run: g.run })).toBeNull()
    expect(g.calls.map(c => c[0])).toEqual(['tmux'])
    expect(await findTmuxForPid(100, { run: fake({ psExit: 1 }).run })).toBe('one')   // the pane's own process, without ps
  })
  test('listSessions: every session with its tmux, three commands in all; null when claude agents fails', async () => {
    const f = fake()
    const s = await listSessions({ run: f.run })
    expect(s!.map(x => [x.sessionId, x.tmux])).toEqual([['s-a', 'one'], ['s-b', null], ['s-c', null], ['s-d', null], ['s-e', 'two']])
    expect(f.calls.map(c => c[0])).toEqual(['claude', 'tmux', 'ps'])
    expect(await listSessions({ run: fake({ agentsExit: 1 }).run })).toBeNull()
    expect((await listSessions({ run: fake({ panesExit: 1 }).run }))!.every(x => x.tmux === null)).toBe(true)
    const e = fake({ agents: '[]' })
    expect(await listSessions({ run: e.run })).toEqual([])
    expect(e.calls.length).toBe(1)
  })
})

const tmuxOk = !process.env.TMUX && spawnSync('tmux', ['-V']).status === 0
describe('a private tmux server (txmonster; -S, TMUX unset)', () => {
  test.skipIf(!tmuxOk)('listPanes and listSessions find a process in its pane', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'finder-tmux-'))
    const sock = join(dir, 's')
    const env = { ...process.env }
    delete env.TMUX
    delete env.TMUX_PANE
    const tm = (...a: string[]) => spawnSync('tmux', ['-S', sock, '-f', '/dev/null', ...a], { env, encoding: 'utf8' })
    try {
      expect(tm('new-session', '-d', '-s', 'wo183-finder', 'sleep 60').status).toBe(0)
      const panes = await listPanes({ tmuxArgs: ['-S', sock] })
      expect(panes!.length).toBe(1)
      expect(panes![0].session).toBe('wo183-finder')
      const pid = panes![0].panePid
      const run: Runner = (argv, ms) => argv[1] === 'agents'
        ? Promise.resolve({ exitCode: 0, stdout: JSON.stringify([{ pid, cwd: dir, kind: 'interactive', sessionId: 'priv-1', status: 'idle' }]), stderr: '' })
        : runReadOnly(argv, ms)
      const s = await listSessions({ tmuxArgs: ['-S', sock], run })
      expect(s).toEqual([{ pid, cwd: dir, kind: 'interactive', sessionId: 'priv-1', status: 'idle', tmux: 'wo183-finder' }])
    } finally {
      tm('kill-server')                                 // this test's own server, on its own socket
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
