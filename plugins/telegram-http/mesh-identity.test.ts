import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { bearerIdentity, claimedIdentity, loadTable, parseTable, readOwnCredential, resolveInbound, sha256hex, verdictMeta, type MeshTable } from './mesh-identity.ts'

const A = 'mesh_' + 'a'.repeat(43)
const B = 'mesh_' + 'b'.repeat(43)
const BTCC = 'mesh_' + 'c'.repeat(43)
const table: MeshTable = {
  identities: { alice: { kind: 'agent', signing: true }, bob: { kind: 'agent', signing: false }, btcc: { kind: 'system', signing: true } },
  hashes: { [sha256hex(A)]: 'alice', [sha256hex(B)]: 'bob', [sha256hex(BTCC)]: 'btcc' },
}

describe('mesh identity', () => {
  test('a valid credential decides the sender, whatever the body claims', () => {
    expect(resolveInbound(`Bearer ${A}`, 'bob', undefined, table)).toEqual({ sender: 'alice', verified: true, relay: 'direct', forged: false })
  })

  test('a forwarder vouches with verified_from', () => {
    expect(resolveInbound(`Bearer ${BTCC}`, 'whatever', 'scheduler', table)).toEqual({ sender: 'scheduler', verified: true, relay: 'btcc', forged: false })
  })

  test('a forwarder without verified_from passes only an unverified claim', () => {
    expect(resolveInbound(`Bearer ${BTCC}`, 'alice', undefined, table)).toEqual({ sender: 'alice', verified: false, relay: 'btcc', forged: true })
    expect(resolveInbound(`Bearer ${BTCC}`, 'bob', undefined, table).forged).toBe(false)
  })

  test('only forwarders may use verified_from', () => {
    expect(resolveInbound(`Bearer ${A}`, 'x', 'joey', table).sender).toBe('alice')
  })

  test('no or unknown credential: delivered as an unverified claim; forged only for a signing identity', () => {
    expect(resolveInbound(undefined, 'bob', undefined, table)).toEqual({ sender: 'bob', verified: false, relay: 'none', forged: false })
    expect(resolveInbound('Bearer mesh_' + 'z'.repeat(43), 'alice', undefined, table)).toEqual({ sender: 'alice', verified: false, relay: 'none', forged: true })
    expect(resolveInbound(undefined, undefined, undefined, null)).toEqual({ sender: 'local-inject', verified: false, relay: 'none', forged: false })
  })

  test('labelled and case-variant claims of a signing identity are forged; a release is not', () => {
    expect(resolveInbound(undefined, '⚠️unverified:alice@203.0.113.9', undefined, table).forged).toBe(true)
    expect(resolveInbound(undefined, 'Alice', undefined, table).forged).toBe(true)
    expect(resolveInbound(`Bearer ${BTCC}`, '⚠️unverified:alice@relay', undefined, table).forged).toBe(true)
    expect(resolveInbound(`Bearer ${BTCC}`, '⚠️released#12', undefined, table).forged).toBe(false)
    expect(resolveInbound(undefined, '⚠️unverified:bob@1.2.3.4', undefined, table).forged).toBe(false)
    expect(claimedIdentity('⚠️unverified:daddy (mbp)@141.98.252.160')).toBe('daddy (mbp)')
    expect(claimedIdentity('⚠️unverified@1.2.3.4')).toBe('⚠️unverified@1.2.3.4')
  })

  test('malformed bearers never match', () => {
    expect(bearerIdentity('Bearer notmesh', table)).toBeNull()
    expect(bearerIdentity(`Basic ${A}`, table)).toBeNull()
  })

  test('meta attributes', () => {
    expect(verdictMeta({ sender: 'a', verified: false, relay: 'none', forged: true })).toEqual({ verified: 'false', relay: 'none', forged: 'true' })
    expect(verdictMeta({ sender: 'a', verified: true, relay: 'direct', forged: false })).toEqual({ verified: 'true', relay: 'direct' })
  })

  test('own credential file: valid, missing, malformed', () => {
    const d = mkdtempSync(join(tmpdir(), 'meshcred-'))
    expect(readOwnCredential(d)).toBeNull()
    writeFileSync(join(d, 'mesh-credential'), 'garbage\n')
    expect(readOwnCredential(d)).toBeNull()
    writeFileSync(join(d, 'mesh-credential'), A + '\n')
    expect(readOwnCredential(d)).toBe(A)
  })

  test('table file: parse, reload on change, keep last good on a bad rewrite', async () => {
    const d = mkdtempSync(join(tmpdir(), 'meshtable-'))
    const p = join(d, 'mesh-credentials.json')
    expect(loadTable(p)).toBeNull()
    writeFileSync(p, JSON.stringify({ version: 1, ...table }))
    expect(loadTable(p)?.hashes[sha256hex(A)]).toBe('alice')
    await Bun.sleep(15)
    writeFileSync(p, '{not json')
    expect(loadTable(p)?.hashes[sha256hex(A)]).toBe('alice')
    expect(parseTable('{"hashes":{}}')).toBeNull()
  })
})
