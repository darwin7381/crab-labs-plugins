// Loopback MCP token (Epeius btcc 5964, from Hephaestus's WO-22 confused-deputy point).
//
// The daemon binds 127.0.0.1, but on a shared host that is no boundary: another local uid,
// or a container in the host's network namespace, could open /mcp and have this daemon act
// as its agent — send_to_agent signed with the agent's mesh credential, replies as its bot.
// Each daemon therefore keeps a token in <dir>/<port> (dir 0700, file 0600; kept across
// restarts so live clients reconnect), and the TUI presents it through the plugin's
// headersHelper (mcp-auth-header.sh), which reads the same file. Same-uid processes can read
// the file too — the boundary is the uid, which is the point.
//
// MCP_REQUIRE_TOKEN=1 refuses /mcp without it. Unset = report-first: allowed, counted in
// /healthz (mcp_auth) and logged, so the switch is flipped only once every client presents it.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { randomBytes, timingSafeEqual } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'

export const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/

export function tokenDir(): string {
  return process.env.MCP_TOKEN_DIR ?? join(homedir(), '.claude', 'agent-inbox', 'mcp-tokens')
}

/** This port's token: the existing one if well-formed, else a fresh one written atomically. */
export function ensureToken(port: number, dir: string = tokenDir()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { chmodSync(dir, 0o700) } catch {}
  const f = join(dir, String(port))
  try {
    const v = readFileSync(f, 'utf8').trim()
    if (TOKEN_RE.test(v)) {
      try { chmodSync(f, 0o600) } catch {}
      return v
    }
  } catch {}
  const v = randomBytes(32).toString('base64url')
  const tmp = `${f}.tmp-${process.pid}`
  writeFileSync(tmp, v + '\n', { mode: 0o600 })
  renameSync(tmp, f)
  return v
}

/** Constant-time check of `Authorization: Bearer <token>`. */
export function bearerMatches(authorization: string | undefined, token: string): boolean {
  if (!token) return false
  const m = (authorization ?? '').match(/^Bearer\s+(\S+)$/i)
  if (!m) return false
  const a = Buffer.from(m[1])
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export type McpAuthStats = {
  required: boolean
  token_ready: boolean
  unauthenticated: number
  last_unauth_at: string | null
  last_unauth_ua: string | null
}

/** The /mcp gate: true = let the request through. Counts and (rate-limited) logs every
 *  request without the token; refuses it only when `required`. */
export function makeGate(token: string, required: boolean, log: (msg: string) => void, now = () => Date.now()) {
  const stats: McpAuthStats = { required, token_ready: !!token, unauthenticated: 0, last_unauth_at: null, last_unauth_ua: null }
  let lastLog = -Infinity
  function check(authorization: string | undefined, method: string, userAgent: string | undefined): boolean {
    if (bearerMatches(authorization, token)) return true
    stats.unauthenticated++
    stats.last_unauth_at = new Date(now()).toISOString()
    stats.last_unauth_ua = (userAgent ?? '').slice(0, 80) || null
    if (now() - lastLog > 60_000) {
      lastLog = now()
      log(`/mcp ${method} without the loopback token (ua=${stats.last_unauth_ua ?? '-'}) — ` +
        (required ? 'REFUSED' : 'allowed: report-first, set MCP_REQUIRE_TOKEN=1 once every client presents it') +
        `; ${stats.unauthenticated} so far`)
    }
    return !required
  }
  return { check, stats }
}
