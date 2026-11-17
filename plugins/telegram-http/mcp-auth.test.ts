import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { bearerMatches, ensureToken, makeGate, refusal, TOKEN_RE } from './mcp-auth.ts'

describe('loopback MCP token', () => {
  test('created once with 0600 in a 0700 dir, then reused across restarts', () => {
    const d = join(mkdtempSync(join(tmpdir(), 'mcptok-')), 'tokens')
    const a = ensureToken(17999, d)
    expect(TOKEN_RE.test(a)).toBe(true)
    expect(statSync(d).mode & 0o777).toBe(0o700)
    expect(statSync(join(d, '17999')).mode & 0o777).toBe(0o600)
    expect(ensureToken(17999, d)).toBe(a)
    expect(ensureToken(18000, d)).not.toBe(a)
  })

  test('a malformed file is replaced', () => {
    const d = mkdtempSync(join(tmpdir(), 'mcptok-'))
    writeFileSync(join(d, '17999'), 'short\n')
    const a = ensureToken(17999, d)
    expect(TOKEN_RE.test(a)).toBe(true)
    expect(readFileSync(join(d, '17999'), 'utf8').trim()).toBe(a)
  })

  test('bearer check', () => {
    const t = 'a'.repeat(43)
    expect(bearerMatches(`Bearer ${t}`, t)).toBe(true)
    expect(bearerMatches(`bearer ${t}`, t)).toBe(true)
    expect(bearerMatches(`Bearer ${t}x`, t)).toBe(false)
    expect(bearerMatches(undefined, t)).toBe(false)
    expect(bearerMatches(`Bearer ${t}`, '')).toBe(false)
  })

  test('report-first gate: allows, counts, logs at most once a minute', () => {
    const logs: string[] = []
    let clock = 1_000_000
    const g = makeGate('t'.repeat(43), false, m => logs.push(m), () => clock)
    expect(g.check(undefined, 'POST', 'claude-code/2')).toBe(true)
    expect(g.check('Bearer nope', 'GET', undefined)).toBe(true)
    expect(g.check(`Bearer ${'t'.repeat(43)}`, 'POST', undefined)).toBe(true)
    expect(g.stats.unauthenticated).toBe(2)
    expect(logs.length).toBe(1)
    clock += 61_000
    g.check(undefined, 'POST', undefined)
    expect(logs.length).toBe(2)
    expect(g.stats.last_unauth_ua).toBeNull()
  })

  test('required gate refuses without the token; no token at all refuses everything', () => {
    const g = makeGate('t'.repeat(43), true, () => {})
    expect(g.check(undefined, 'POST', undefined)).toBe(false)
    expect(g.check(`Bearer ${'t'.repeat(43)}`, 'POST', undefined)).toBe(true)
    const broken = makeGate('', true, () => {})
    expect(broken.check(`Bearer ${'t'.repeat(43)}`, 'POST', undefined)).toBe(false)
    expect(broken.stats.token_ready).toBe(false)
  })
})

// 2026-11-17: Claude Code caches "needs auth" machine-wide (by server name) on a 401/403 to a request
// WITHOUT an Authorization header; 33 sessions then skipped agent-inbox for 17 h. Never answer that with 401/403.
describe('refusal status', () => {
  test('no Authorization header → 503 with a JSON-RPC error (never cached, retried)', () => {
    for (const h of [undefined, '', '   ']) {
      const r = refusal(h)
      expect(r.status).toBe(503)
      const b = JSON.parse(r.body)
      expect(b.jsonrpc).toBe('2.0')
      expect(b.error.code).toBe(-32001)
    }
  })
  test('a header with the wrong token → 403 (client reports HEADERS_HELPER_AUTH_REJECTED, no cache write)', () => {
    expect(refusal('Bearer wrong').status).toBe(403)
    expect(refusal('Basic abc').status).toBe(403)
  })
  test('never 401', () => {
    for (const h of [undefined, '', 'Bearer x', 'junk']) expect(refusal(h).status).not.toBe(401)
  })
})
