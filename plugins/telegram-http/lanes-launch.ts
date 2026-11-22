// lanes-launch.ts — the ONE entry point a fleet launcher calls to start a lanes main (lanes-golive C4 / C5 / A4).
//
// A lanes main is found by its session id, never as "the newest transcript in the workspace": lane runs (`claude -p`, cwd = the workspace) write
// their transcripts into the same project directory, so `claude --continue` and every "newest .jsonl" reader can land on a lane's conversation. The
// launcher therefore never uses --continue for a lanes main. Before each start it runs:
//
//   bun <plugin>/lanes-launch.ts --workspace <dir> [--agent <name>] [--fresh] [--session <id>] [--json]
//
// which (1) writes <dir>/.lanes/main-settings.json (the main's hooks, absolute plugin paths), (2) chooses the session id and writes it to
// <dir>/.lanes/main-expected (the daemon accepts the SessionStart of that id; it keeps the file current itself after each accepted start, e.g. a
// /clear), and (3) prints the extra claude arguments, one line:
//   --settings <dir>/.lanes/main-settings.json --resume <id>        the chosen id has a transcript
//   --settings <dir>/.lanes/main-settings.json --session-id <id>    a new conversation (or an id that has none yet)
// --json prints {"args": [...], "session_id", "resume", "why", "settings", "expected"} instead.
//
// The id, in this order (the lab keeper's order, minus its lab-only fork file):
//   --fresh, or the marker <dir>/.lanes/run/fresh (consumed)    → a new uuid (the /new path)
//   --session <id>                                             → that id (an explicit `--resume <id>` of the launcher's override file)
//   <dir>/.lanes/run/renew  (written by /main renew)           → that id (the daemon removes the file once the new main registered)
//   <dir>/.lanes/main-expected                                 → that id: --resume when its transcript exists, else --session-id
//   nothing                                                    → a new uuid
// The transcript dir is Claude Code's: ~/.claude/projects/<the workspace path, every non-alphanumeric character as '-'> (fleet 1.33.2's rule).
// Nothing here starts, stops or signals any process.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'

export const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Claude Code's project directory for a workspace (fleet 1.33.2: every character other than a letter or digit becomes '-') */
export function projectDirOf(workspace: string, home = homedir()): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects', resolve(workspace).replace(/[^a-zA-Z0-9]/g, '-'))
}

/** the main's hooks (lanes-hooks/main-hook.py on every event; memory commits after Write / Edit). The main keeps the user's own settings: --settings adds. */
export function mainSettings(python = process.env.LANES_PYTHON || 'python3', pluginDir = PLUGIN_DIR, agent?: string): Record<string, unknown> {
  const hook = (script: string, timeout: number) => ({ type: 'command', command: `${python} ${join(pluginDir, 'lanes-hooks', script)}`, timeout })
  const main = (timeout: number) => [{ matcher: '', hooks: [hook('main-hook.py', timeout)] }]
  return {
    // the hooks' own names for the agent (memory commits are signed with it); the session's env is otherwise the launcher's
    ...(agent ? { env: { LANES_AGENT: agent } } : {}),
    hooks: {
      SessionStart: main(15),
      UserPromptSubmit: main(15),
      PreToolUse: main(30),
      PostToolUse: [...main(15), { matcher: 'Write|Edit', hooks: [hook('memory-commit-hook.py', 15)] }],
      Stop: main(30),
      StopFailure: main(15),
      SessionEnd: main(2),
      PreCompact: main(5),          // a compaction: the main-only rules go with the next prompt again
    },
  }
}

export type LaunchOpts = { workspace: string; fresh?: boolean; session?: string; agent?: string; home?: string; python?: string; pluginDir?: string; newId?: () => string }
export type Launch = { args: string[]; session_id: string; resume: boolean; why: string; settings: string; expected: string }

function readTrim(p: string): string { try { return readFileSync(p, 'utf8').trim() } catch { return '' } }

/** writes main-settings.json and main-expected, returns the arguments (see the header) */
export function launchMain(o: LaunchOpts): Launch {
  const ws = resolve(o.workspace)
  const lanesDir = process.env.LANES_DIR ?? join(ws, '.lanes')
  mkdirSync(join(lanesDir, 'run'), { recursive: true, mode: 0o700 })
  const settings = join(lanesDir, 'main-settings.json')
  const text = JSON.stringify(mainSettings(o.python, o.pluginDir, o.agent), null, 2) + '\n'
  if (readTrim(settings) !== text.trim()) { writeFileSync(`${settings}.tmp`, text, { mode: 0o644 }); renameSync(`${settings}.tmp`, settings) }
  const proj = projectDirOf(ws, o.home)
  const newId = o.newId ?? randomUUID
  const freshMarker = join(lanesDir, 'run', 'fresh')
  let sid = '', why = ''
  if (o.fresh || existsSync(freshMarker)) {
    try { rmSync(freshMarker) } catch {}
    sid = newId(); why = 'fresh start asked (/new)'
  } else if (o.session && UUID.test(o.session)) {
    sid = o.session; why = 'the launcher named this session'
  } else if (UUID.test(readTrim(join(lanesDir, 'run', 'renew')))) {
    sid = readTrim(join(lanesDir, 'run', 'renew')); why = '/main renew: the new main'
  } else if (UUID.test(readTrim(join(lanesDir, 'main-expected')))) {
    sid = readTrim(join(lanesDir, 'main-expected')); why = 'the registered main (main-expected)'
  } else {
    sid = newId(); why = 'no main yet: a new session'
  }
  const resume = existsSync(join(proj, `${sid}.jsonl`))
  if (!resume && why === 'the registered main (main-expected)') why += ', no transcript yet: started under the same id'
  const expected = join(lanesDir, 'main-expected')
  writeFileSync(`${expected}.tmp`, sid + '\n', { mode: 0o600 }); renameSync(`${expected}.tmp`, expected)
  return { args: ['--settings', settings, resume ? '--resume' : '--session-id', sid], session_id: sid, resume, why, settings, expected }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const val = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const ws = val('--workspace') ?? process.cwd()
  try {
    const r = launchMain({ workspace: ws, fresh: argv.includes('--fresh'), session: val('--session'), agent: val('--agent') })
    process.stderr.write(`lanes-launch: ${r.resume ? 'resume' : 'new'} ${r.session_id} (${r.why})\n`)
    process.stdout.write(argv.includes('--json') ? JSON.stringify(r) + '\n' : r.args.join(' ') + '\n')
  } catch (e) {
    process.stderr.write(`lanes-launch: failed: ${e instanceof Error ? e.message : e}\n`)
    process.exit(1)
  }
}
