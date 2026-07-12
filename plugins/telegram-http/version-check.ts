// version-check.ts — daemon version self-report + freshness check (1.15.1)
//
// Joey rule (2026-07-12, after the JL-machine stale-roamer incident): a daemon
// must never SILENTLY run stale code. The plist points at a file path; nothing
// ever verified that path was current — a months-old copy answered /model with
// 1.1.0-era behavior while origin/main was 14 minor versions ahead.
//
// Every boot this module:
//   1. resolves the running copy's version (top CHANGELOG entry) + git HEAD
//   2. fetches origin and counts how far HEAD is behind origin/main
//   3. exposes one line for the startup log, /healthz and /whoami — and a loud
//      ⚠️ prefix when the running copy is behind
//
// Fail-open by design: offline, no remote, or a non-git copy (old plugin cache
// dirs) degrades to "freshness unknown" — boot is never blocked, alerts only.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const pExecFile = promisify(execFile)
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

export interface VersionInfo {
  version: string        // top CHANGELOG entry, e.g. "1.15.1"
  commit: string         // short HEAD, or "no-git" for non-checkout copies
  behind: number | null  // commits behind origin/main; null = unknown
  dir: string            // the directory this daemon actually executes from
}

let cached: VersionInfo | null = null

export function changelogVersion(): string {
  try {
    const m = readFileSync(`${PLUGIN_DIR}/CHANGELOG.md`, 'utf8').match(/^##\s+v?([0-9][^\s(—]*)/m)
    return m ? m[1] : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function git(...args: string[]): Promise<string> {
  const { stdout } = await pExecFile('git', ['-C', PLUGIN_DIR, ...args], { timeout: 15_000 })
  return stdout.trim()
}

/** Resolve version + freshness once at boot (call fire-and-forget; result cached). */
export async function checkVersion(): Promise<VersionInfo> {
  const version = changelogVersion()
  let commit = 'no-git'
  let behind: number | null = null
  try {
    commit = await git('rev-parse', '--short', 'HEAD')
    try {
      await git('fetch', '--quiet', 'origin', 'main')
      const n = parseInt(await git('rev-list', '--count', 'HEAD..origin/main'), 10)
      behind = Number.isNaN(n) ? null : n
    } catch {
      /* offline or no origin — freshness unknown, not an error */
    }
  } catch {
    /* not a git checkout (e.g. old plugin-cache copy) */
  }
  cached = { version, commit, behind, dir: PLUGIN_DIR }
  return cached
}

/** Last check result without re-running git (null before checkVersion resolves). */
export function versionInfo(): VersionInfo | null {
  return cached
}

/** One human line for startup log / /whoami. Loud when stale. */
export function versionLine(): string {
  const v = cached
  if (!v) return `telegram-http v${changelogVersion()} (freshness check pending)`
  const base = `telegram-http v${v.version} @${v.commit} [${v.dir}]`
  if (v.commit === 'no-git') return `${base} — ⚠️ non-git copy, freshness unverifiable; run from the marketplace clone instead`
  if (v.behind === null) return `${base} (origin unreachable — freshness unknown)`
  if (v.behind === 0) return `${base} — up to date with origin/main`
  return `⚠️ ${base} — BEHIND origin/main by ${v.behind} commit(s). Fix: git -C ${v.dir} pull && restart this daemon (launchctl kickstart -k)`
}
