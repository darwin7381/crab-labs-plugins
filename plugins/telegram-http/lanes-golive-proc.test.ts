// lanes-golive, lab run 2026-11-23 on the Mac mini (sonn-lab): the main stayed 'starting' and was offered nothing. The daemon's PATH (every fleet
// launchd plist: ~/.bun/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin) has no /usr/sbin, where macOS keeps lsof: spawnSync('lsof') was ENOENT,
// so the main's MCP stream was never mapped to its pid. The runner now uses the tools' absolute paths.
import { test, expect } from 'bun:test'
import { resolveBin, runCmd } from './lanes-proc.ts'

test('lanes-golive (proc): a bare tool name resolves to the system directories first (/usr/sbin before PATH); a path is kept; unknown stays bare', () => {
  const have = new Set(['/usr/sbin/lsof', '/bin/ps'])
  expect(resolveBin('lsof', p => have.has(p))).toBe('/usr/sbin/lsof')
  expect(resolveBin('ps', p => have.has(p))).toBe('/bin/ps')
  expect(resolveBin('/opt/x/lsof', () => true)).toBe('/opt/x/lsof')
  expect(resolveBin('nosuchtool', () => false)).toBe('nosuchtool')
})

const onDarwin = process.platform === 'darwin' ? test : test.skip
onDarwin('lanes-golive (proc, this Mac): lsof runs with a launchd PATH that has no /usr/sbin', () => {
  const was = process.env.PATH
  process.env.PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin'
  try {
    expect(runCmd('lsof', ['-v'])).not.toBeNull()
    expect(runCmd('ps', ['-o', 'pid=', '-p', String(process.pid)])?.trim()).toBe(String(process.pid))
  } finally { process.env.PATH = was }
})
