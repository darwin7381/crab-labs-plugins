// Mesh sender identity (access design v1.1 §5.2–5.3; contract with the BTCC credential
// module, WO-22).
//
// Every sender has its own credential (`mesh_…`). The server side keeps only sha256
// hashes and publishes them, with each identity's kind and whether it signs yet, as a
// small table synced to every machine. This module:
//   - reads THIS daemon's own credential (`<STATE_DIR>/mesh-credential`) so outbound
//     calls can carry `Authorization: Bearer …`;
//   - resolves an inbound /inject to a verdict — who really sent it — from the presented
//     bearer, never from the body's `from` alone.
//
// No table or no credential is never an error: delivery continues and the message is
// marked verified=false (dual track — nothing is dropped while senders migrate).

import { readFileSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'

/** Hops that may vouch for the original sender (`verified_from`). Anyone else's message
 *  is attributed to the caller's own identity. */
export const FORWARDERS = new Set(['btcc', 'oncall-receiver'])

export type MeshTable = {
  identities: Record<string, { kind?: string; signing?: boolean; first_signed_at?: string | null }>
  hashes: Record<string, string>
}

export type Verdict = {
  sender: string
  verified: boolean
  relay: 'btcc' | 'oncall-receiver' | 'direct' | 'none'
  /** Claims an identity that already signs, yet arrived unsigned — treat as forged. */
  forged: boolean
}

export const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex')

const CRED_RE = /^mesh_[A-Za-z0-9_-]{20,}$/

/** This daemon's own credential, or null (missing / malformed → unsigned, as before). */
export function readOwnCredential(stateDir: string): string | null {
  try {
    const v = readFileSync(join(stateDir, 'mesh-credential'), 'utf8').trim()
    return CRED_RE.test(v) ? v : null
  } catch {
    return null
  }
}

export function tablePath(): string {
  return process.env.MESH_CREDENTIALS_TABLE ?? join(homedir(), '.claude', 'agent-inbox', 'mesh-credentials.json')
}

export function parseTable(text: string): MeshTable | null {
  try {
    const j = JSON.parse(text) as Partial<MeshTable>
    if (!j || typeof j.hashes !== 'object' || typeof j.identities !== 'object' || !j.hashes || !j.identities) return null
    return { identities: j.identities, hashes: j.hashes }
  } catch {
    return null
  }
}

let cached: { path: string; mtimeMs: number; table: MeshTable | null } | null = null

/** The synced table, re-read when the file changes. A bad rewrite keeps the last good one. */
export function loadTable(path: string = tablePath()): MeshTable | null {
  let mtimeMs: number
  try { mtimeMs = statSync(path).mtimeMs } catch { return cached?.path === path ? cached.table : null }
  if (cached && cached.path === path && cached.mtimeMs === mtimeMs) return cached.table
  let table: MeshTable | null = null
  try { table = parseTable(readFileSync(path, 'utf8')) } catch {}
  if (!table && cached?.path === path) table = cached.table
  cached = { path, mtimeMs, table }
  return table
}

/** Identity behind `Authorization: Bearer mesh_…`, or null. */
export function bearerIdentity(authorization: string | undefined, table: MeshTable | null): string | null {
  if (!table || !authorization) return null
  const m = authorization.match(/^Bearer\s+(\S+)$/i)
  if (!m || !CRED_RE.test(m[1])) return null
  return table.hashes[sha256hex(m[1])] ?? null
}

/** The identity a claim names, case-insensitively. A BTCC/receiver label
 *  ("⚠️unverified:<name>@<source>") still names <name>, so a relabelled forgery is caught
 *  too. "⚠️released#<id>" (a message Joey released from the mailbox) names no identity. */
export function claimedIdentity(claim: string): string {
  const m = claim.match(/^⚠️unverified:(.+)@[^@]*$/u)
  return (m ? m[1] : claim).trim().toLowerCase()
}

const isSigning = (name: string, table: MeshTable | null) => !!table?.identities[claimedIdentity(name)]?.signing

/** Who sent this /inject. Body `from` is only ever a claim; the bearer decides. */
export function resolveInbound(
  authorization: string | undefined,
  bodyFrom: string | undefined,
  bodyVerifiedFrom: string | undefined,
  table: MeshTable | null,
): Verdict {
  const claimed = (bodyFrom || 'local-inject').slice(0, 64)
  const caller = bearerIdentity(authorization, table)
  if (caller && FORWARDERS.has(caller)) {
    if (bodyVerifiedFrom) return { sender: bodyVerifiedFrom.slice(0, 64), verified: true, relay: caller as Verdict['relay'], forged: false }
    // A forwarder relaying an origin it could not verify: still just a claim.
    return { sender: claimed, verified: false, relay: caller as Verdict['relay'], forged: isSigning(claimed, table) }
  }
  if (caller) return { sender: caller, verified: true, relay: 'direct', forged: false }
  return { sender: claimed, verified: false, relay: 'none', forged: isSigning(claimed, table) }
}

/** Channel meta attributes for a verdict. */
export function verdictMeta(v: Verdict): Record<string, string> {
  return { verified: String(v.verified), relay: v.relay, ...(v.forged ? { forged: 'true' } : {}) }
}
