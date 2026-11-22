// Universe 002y (X-5): lanes mode read every process fact from Linux /proc only (lanes.ts: /proc/net/tcp + /proc/<pid>/fd for an MCP request's process,
// stat for its parent, cmdline, exe; the session-id scan). The fleet is mostly macOS (Darwin, bun), where none of it exists: no MCP session was mapped to
// its claude pid, so the main could never be offered anything. lanes-proc.ts is one platform layer, a function per fact: Linux keeps /proc, macOS asks
// lsof and ps, and an unknown fact is not judged.
// The macOS half is verified ONLY against recorded output: the lsof / ps shapes below were captured on a fleet Mac (macOS, 2026-11-23; home paths
// redacted, pids as recorded, the tg daemon on 17631). The Linux half runs on this machine's real /proc. No model, no network beyond loopback.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer, type Socket } from 'net'
import { darwinFacts, linuxFacts, lsofPeerPid, psFirstLine, psRows, sessionPidsOf, procFactsFor, type Run } from './lanes-proc.ts'

// ---- recorded on a Mac: `lsof -nP -w -iTCP:60610 -sTCP:ESTABLISHED -Fpn` (the channel bot's claude → its tg daemon): both ends of the connection
const LSOF_60610 = 'p37551\nf17\nn127.0.0.1:60610->127.0.0.1:17631\np63212\nf11\nn127.0.0.1:17631->127.0.0.1:60610\n'
// the same shape for a hook's connection (python, a child of claude), and lsof's IPv6 form
const LSOF_60744 = 'p41001\nf3\nn127.0.0.1:60744->127.0.0.1:17631\np63212\nf12\nn127.0.0.1:17631->127.0.0.1:60744\n'
const LSOF_V6 = 'p462\nf52\nn[fe80:1a::c41e:b0b3:adaf:217b]:1024->[fe80:1a::a243:3bf2:8205:f2bd]:1024\np5120\nf9\nn[::1]:61002->[::1]:17631\n'
// `ps -axo pid=,command=` (head as recorded; the claude rows are the fleet's shapes: the TUI, a lane run on --resume, a fork of the main, --session-id=)
const PS_AXO = [
  '    1 /sbin/launchd',
  '   99 /usr/libexec/logd',
  '  101 /usr/libexec/smd',
  '20462 /Applications/Claude.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler --monitor-self',
  '37551 claude --channels plugin:telegram-http@crab-labs-plugins --channels plugin:discord-http@crab-labs-plugins --model claude-fable-5-2 --dangerously-skip-permissions --continue',
  '48211 /Users/REDACTED/.local/bin/claude -p --resume 0b8f7c1e-5a2d-4c44-9e0a-2f6d1b7c9a10 --output-format stream-json --verbose',
  '48302 /Users/REDACTED/.local/bin/claude -p --resume 5d7e2a90-1111-4c44-9e0a-2f6d1b7c9a10 --fork-session --output-format stream-json',
  '48377 /Users/REDACTED/.local/bin/claude -p --session-id=9c1d6e33-2222-4c44-9e0a-2f6d1b7c9a10 --output-format stream-json',
  '48410 claude -r 77aa0000-3333-4c44-9e0a-2f6d1b7c9a10',
  '',
].join('\n')
// `ps -o <field>= -p <pid>`: one value line (ps pads columns); a pid that is gone prints nothing
const PS: Record<string, string> = {
  'ppid 37551': '37361\n', 'comm 37551': 'claude\n',
  'command 37551': 'claude --channels plugin:telegram-http@crab-labs-plugins --model claude-fable-5-2 --dangerously-skip-permissions --continue\n',
  'ppid 41001': '37551\n', 'comm 41001': '/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python\n',
  'command 41001': '/usr/bin/python3 /Users/REDACTED/.claude/plugins/marketplaces/crab-labs-plugins/plugins/telegram-http/lanes-hooks/main-hook.py\n',
  'ppid 2119': ' 1665\n', 'comm 2119': '/Users/REDACTED/.vscode/extensions/anthropic.claude-code-2.1.312-darwin-arm64/resources/native-binary/claude\n',
  'command 2119': '/Users/REDACTED/.vscode/extensions/anthropic.claude-code-2.1.312-darwin-arm64/resources/native-binary/claude --output-format stream-json\n',
  'ppid 37361': '37360\n', 'comm 37361': '-zsh\n', 'command 37361': '-zsh\n',
}
const calls: string[] = []
let lsofDown = false
const fakeRun: Run = (cmd, args) => {
  calls.push(`${cmd} ${args.join(' ')}`)
  if (cmd === 'lsof') {
    if (lsofDown) return null                                                                   // lsof missing or killed by the timeout
    const port = args.find(a => a.startsWith('-iTCP:'))?.slice(6)
    return port === '60610' ? LSOF_60610 : port === '60744' ? LSOF_60744 : port === '61002' ? LSOF_V6 : ''   // nothing found: lsof prints nothing
  }
  if (cmd === 'ps' && args[0] === '-axo') return PS_AXO
  if (cmd === 'ps' && args[0] === '-o') return PS[`${args[1].replace('=', '')} ${args[3]}`] ?? ''
  return null
}

test('002y X-5 (fixtures, macOS output): lsof -Fpn: the CLIENT end of the connection is the caller, never the server\'s end; IPv6; nothing listed = unknown', () => {
  expect(lsofPeerPid(LSOF_60610, 60610, 17631)).toBe(37551)
  expect(lsofPeerPid(LSOF_60610, 17631, 60610)).toBe(63212)                                    // the reverse direction is the daemon's own end
  expect(lsofPeerPid(LSOF_V6, 61002, 17631)).toBe(5120)
  expect(lsofPeerPid(LSOF_60610, 60611, 17631)).toBeNull()
  expect(lsofPeerPid('', 60610, 17631)).toBeNull()
  expect(psFirstLine(' 1665\n')).toBe('1665'); expect(psFirstLine('')).toBeNull(); expect(psFirstLine(null)).toBeNull()
  expect(psRows(PS_AXO).map(r => r.pid)).toEqual([1, 99, 101, 20462, 37551, 48211, 48302, 48377, 48410])
})

test('002y X-5 (fixtures, macOS output): each fact through lsof / ps; a gone pid, an empty answer or a missing lsof is unknown (null), never a guess', () => {
  calls.length = 0; lsofDown = false
  const P = darwinFacts(fakeRun)
  expect(P.platform).toBe('darwin')
  expect(P.peerPid(60610, 17631)).toBe(37551)
  expect(calls.at(-1)).toBe('lsof -nP -w -iTCP:60610 -sTCP:ESTABLISHED -Fpn')                // the port-filtered call: one connection, not the whole table
  expect(P.parentPid(41001)).toBe(37551); expect(P.parentPid(2119)).toBe(1665)
  expect(P.argv(37551)!.slice(0, 2)).toEqual(['claude', '--channels'])
  expect(P.exe(2119)).toBe('/Users/REDACTED/.vscode/extensions/anthropic.claude-code-2.1.312-darwin-arm64/resources/native-binary/claude')   // a path ps prints whole
  expect(calls.filter(c => c.startsWith('ps -o')).every(c => /^ps -o (ppid|command|comm)= -p \d+$/.test(c))).toBe(true)
  expect(P.parentPid(999999)).toBeNull(); expect(P.argv(999999)).toBeNull(); expect(P.exe(999999)).toBeNull()   // gone: ps prints nothing
  expect(P.parentPid(0)).toBeNull(); expect(P.peerPid(0, 17631)).toBeNull()
  lsofDown = true; expect(P.peerPid(60610, 17631)).toBeNull(); lsofDown = false
  const s = P.sessionPids()
  expect([...s.entries()].sort()).toEqual([['0b8f7c1e-5a2d-4c44-9e0a-2f6d1b7c9a10', 48211], ['77aa0000-3333-4c44-9e0a-2f6d1b7c9a10', 48410], ['9c1d6e33-2222-4c44-9e0a-2f6d1b7c9a10', 48377]])   // the fork holds none
  expect(darwinFacts(() => null).sessionPids().size).toBe(0)
  expect(sessionPidsOf([{ pid: process.pid, argv: ['claude', '--resume', 'x'] }]).size).toBe(0)     // this daemon is never a holder
  expect(procFactsFor('darwin').platform).toBe('darwin'); expect(procFactsFor('linux').platform).toBe('linux')
  const U = procFactsFor('win32'); expect([U.peerPid(1, 2), U.parentPid(1), U.argv(1), U.exe(1), U.sessionPids().size]).toEqual([null, null, null, null, 0])
})

const onLinux = process.platform === 'linux' ? test : test.skip
onLinux('002y X-5 (Linux, this machine\'s /proc): the same facts as before: a loopback client\'s pid, its parent, argv, exe; a --resume holder', async () => {
  const P = linuxFacts()
  let remote = 0
  const srv = createServer((s: Socket) => { remote = s.remotePort ?? 0 })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as any).port as number
  const sid = '6a1f0b2c-4444-4c44-9e0a-2f6d1b7c9a10'
  const child = Bun.spawn(['python3', '-c', `import socket,time; s=socket.create_connection(('127.0.0.1', ${port})); time.sleep(20)`, '--resume', sid])
  try {
    const t0 = Date.now(); while (!remote && Date.now() - t0 < 4000) await new Promise(r => setTimeout(r, 20))
    expect(remote).toBeGreaterThan(0)
    expect(P.peerPid(remote, port)).toBe(child.pid)
    expect(P.peerPid(port, remote)).toBe(process.pid)                                        // the server's own end
    expect(P.parentPid(child.pid)).toBe(process.pid)
    expect(P.argv(child.pid)!.filter(Boolean).slice(-2)).toEqual(['--resume', sid])
    expect(P.exe(child.pid)).toMatch(/python/)
    expect(P.sessionPids().get(sid)).toBe(child.pid)
    expect(P.argv(2 ** 22 + 7)).toBeNull(); expect(P.parentPid(2 ** 22 + 7)).toBeNull()
  } finally { child.kill('SIGKILL'); srv.close() }
})

// ---- the wiring: lanes on a Mac (the platform layer swapped for the darwin one over the recorded output)
const L = await import('./lanes.ts?y-x5-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-y-x5-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const logs: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 17631, log: (_l: string, m: string) => logs.push(m), authOk: () => false, registryNames: () => [],
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
const was = L.__setProcFacts(darwinFacts(fakeRun))
const sleeper = Bun.spawn(['sleep', '30'])
afterAll(() => { L.__setProcFacts(was); sleeper.kill('SIGKILL') })

test('002y X-5 (fixtures, macOS output): an MCP session is mapped to its claude process (a hook\'s python walks up to it), once per connection; unknown is asked again', () => {
  calls.length = 0; lsofDown = false
  const sockA = { remotePort: 60744 }, sockB = { remotePort: 60610 }
  L.noteMcpSocket('mcp-mac-a', { socket: sockA } as any)
  expect(logs.at(-1)).toBe('lanes: MCP session mcp-mac-a owned by claude pid 37551')            // python 41001 → its parent, the claude TUI
  const n = calls.length
  L.forgetMcpSession('mcp-mac-a')
  L.noteMcpSocket('mcp-mac-a2', { socket: sockA } as any)                                       // another request on the same connection
  expect(logs.at(-1)).toBe('lanes: MCP session mcp-mac-a2 owned by claude pid 37551')
  expect(calls.length).toBe(n)                                                                  // no lsof, no ps: cached on the connection
  lsofDown = true
  L.noteMcpSocket('mcp-mac-b', { socket: sockB } as any)
  expect(logs.at(-1)).toBe('lanes: MCP session mcp-mac-b owned by claude pid ?')               // lsof failed: not known, not judged
  expect(L.sessionNotMain('mcp-mac-b')).toBe(false)
  lsofDown = false
  L.noteMcpSocket('mcp-mac-b2', { socket: sockB } as any)
  expect(logs.at(-1)).toBe('lanes: MCP session mcp-mac-b2 owned by claude pid 37551')          // asked again, found
})

test('002y X-5 (fixtures, macOS output): a session id named by a live process\'s argv is held (ps -axo), a fork is not; with ps unavailable nothing is known to hold it', () => {
  const sid = '0b8f7c1e-5a2d-4c44-9e0a-2f6d1b7c9a10'
  const rows = PS_AXO.replace('48211 ', `${sleeper.pid} `)                                     // the recorded row, on a live pid of this machine
  const P = darwinFacts((cmd, args) => cmd === 'ps' && args[0] === '-axo' ? rows : fakeRun(cmd, args))
  L.__setProcFacts(P)
  expect(L.sessionHolder(sid)).toBe(sleeper.pid)
  expect(L.sessionHolder('5d7e2a90-1111-4c44-9e0a-2f6d1b7c9a10')).toBeNull()                   // a fork's --resume holds nothing
  L.__setProcFacts(darwinFacts(() => null))
  expect(L.sessionHolder(sid)).toBeNull()                                                       // ps unavailable: nothing known holds it
  L.__setProcFacts(darwinFacts(fakeRun))
})
