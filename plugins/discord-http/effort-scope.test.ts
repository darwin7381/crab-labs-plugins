// /effort session scope (1.14.4) — KEEP IN SYNC with telegram-http/effort-scope.test.ts
// (the picker tests there have no counterpart: Discord has no bare-/effort picker).
// claude's /effort writes the level into the GLOBAL
// ~/.claude/settings.json as modelSettings[<canonical model>].effortLevel (CLI 2.1.322:
// /effort → Gie → updateSettingsForSource("userSettings", {modelSettings: {[model]:
// {effortLevel}}}), merged with lodash mergeWith, where an undefined value deletes the key
// and leaves its parent object behind). The plugin snapshots the effort fields before
// typing and puts them back afterwards.
//
// Fixtures (test-fixtures/effort-scope/):
//  - settings-before.json: the Mac mini's settings.json on 2026-11-13, real key order and
//    real effort values; env / hooks / statusLine / plugin keys replaced by placeholders.
//  - settings-after-effort-high.json: the same file after the lab TUI (claude-haiku-5-5)
//    ran `/effort high` — the one change the live diff showed.
import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, lstatSync, statSync, readdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  effortSnapshotOf, restoreEffortFields, writeJsonAtomic, readGlobalEffortSnapshot, restoreGlobalEffort,
} from './channel-bot-control'

const fx = (n: string) => readFileSync(join(import.meta.dir, 'test-fixtures', 'effort-scope', n), 'utf8')
const parse = (s: string) => JSON.parse(s) as Record<string, any>
const dump = (j: unknown) => JSON.stringify(j, null, 2) + '\n'  // claude's own settings format

// ---- restore -----------------------------------------------------------------

test('restore: the lab /effort high write is undone byte for byte', () => {
  const before = fx('settings-before.json')
  const after = parse(fx('settings-after-effort-high.json'))
  expect(dump(after)).not.toBe(before)
  const changed = restoreEffortFields(after, effortSnapshotOf(parse(before)))
  expect(changed).toEqual(['modelSettings.claude-haiku-5-5.effortLevel → xhigh'])
  expect(dump(after)).toBe(before)
})

test('restore: nothing changed → no-op (no write needed)', () => {
  const j = parse(fx('settings-before.json'))
  expect(restoreEffortFields(j, effortSnapshotOf(parse(fx('settings-before.json'))))).toEqual([])
  expect(dump(j)).toBe(fx('settings-before.json'))
})

test('restore: modelSettings did not exist → removed again, not left as {}', () => {
  const before = { model: 'opus', effortLevel: 'xhigh', tui: 'fullscreen' }
  const snap = effortSnapshotOf(before)
  const cur: Record<string, any> = { ...before, modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } }
  expect(restoreEffortFields(cur, snap)).toEqual([
    'modelSettings.claude-opus-5-5.effortLevel → (移除)',
    'modelSettings.claude-opus-5-5 → (移除空項)',
    'modelSettings → (移除空項)',
  ])
  expect(dump(cur)).toBe(dump(before))
})

test('restore: a new entry is removed, the other entries are untouched', () => {
  const before = parse(fx('settings-before.json'))
  const snap = effortSnapshotOf(before)
  const cur = parse(fx('settings-before.json'))
  cur.modelSettings['claude-opus-4-8'] = { effortLevel: 'low' }
  restoreEffortFields(cur, snap)
  expect(dump(cur)).toBe(fx('settings-before.json'))
})

test('restore: an entry with other keys keeps them; only effortLevel is removed', () => {
  const before = { modelSettings: { 'claude-opus-5-5': { maxEffortLevel: 'high', autoCompactWindow: 400000 } } }
  const snap = effortSnapshotOf(before)
  const cur = structuredClone(before) as Record<string, any>
  cur.modelSettings['claude-opus-5-5'].effortLevel = 'medium'
  expect(restoreEffortFields(cur, snap)).toEqual(['modelSettings.claude-opus-5-5.effortLevel → (移除)'])
  expect(dump(cur)).toBe(dump(before))
})

test('restore: /effort auto deleted a level → put back in its original position', () => {
  const before = { modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh', maxEffortLevel: 'max' } }, tui: 'fullscreen' }
  const snap = effortSnapshotOf(before)
  const cur = structuredClone(before) as Record<string, any>
  delete cur.modelSettings['claude-opus-5-5'].effortLevel  // what mergeWith does with effortLevel: undefined
  expect(restoreEffortFields(cur, snap)).toEqual(['modelSettings.claude-opus-5-5.effortLevel → xhigh'])
  expect(dump(cur)).toBe(dump(before))
})

test('restore: /effort auto on a model with no entry → the {} it leaves is removed', () => {
  const before = parse(fx('settings-before.json'))
  const snap = effortSnapshotOf(before)
  const cur = parse(fx('settings-before.json'))
  cur.modelSettings['claude-sonnet-4-6'] = {}
  expect(restoreEffortFields(cur, snap)).toEqual(['modelSettings.claude-sonnet-4-6 → (移除空項)'])
  expect(dump(cur)).toBe(fx('settings-before.json'))
})

test('restore: top-level effortLevel (claude falls back to it for a prototype-named model)', () => {
  const before = parse(fx('settings-before.json'))
  const snap = effortSnapshotOf(before)
  const cur = parse(fx('settings-before.json'))
  cur.effortLevel = 'low'
  expect(restoreEffortFields(cur, snap)).toEqual(['effortLevel → xhigh'])
  expect(dump(cur)).toBe(fx('settings-before.json'))
  const noTop = { model: 'opus' }
  const cur2: Record<string, any> = { model: 'opus', effortLevel: 'low' }
  restoreEffortFields(cur2, effortSnapshotOf(noTop))
  expect(cur2).toEqual(noTop)
})

test('restore: keys other than effortLevel keep their CURRENT value (another writer in the window)', () => {
  const snap = effortSnapshotOf(parse(fx('settings-before.json')))
  const cur = parse(fx('settings-after-effort-high.json'))
  cur.model = 'claude-sonnet-5-5'                                   // someone's /model, global scope
  cur.modelSettings['claude-haiku-5-5'].autoCompactWindow = 300000   // a non-effort modelSettings key
  restoreEffortFields(cur, snap)
  expect(cur.model).toBe('claude-sonnet-5-5')
  expect(cur.modelSettings['claude-haiku-5-5']).toEqual({ effortLevel: 'xhigh', autoCompactWindow: 300000 })
})

test('restore: the snapshot is a copy — later mutation of the file object cannot change it', () => {
  const j = parse(fx('settings-before.json'))
  const snap = effortSnapshotOf(j)
  j.modelSettings['claude-haiku-5-5'].effortLevel = 'high'
  expect((snap.modelSettings as any)['claude-haiku-5-5'].effortLevel).toBe('xhigh')
})

// ---- atomic write --------------------------------------------------------------

test('writeJsonAtomic: same format as claude, keeps 0600, follows a symlink, leaves no temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'effort-scope-'))
  const real = join(dir, 'real-settings.json')
  const link = join(dir, 'settings.json')
  writeFileSync(real, fx('settings-after-effort-high.json'))
  chmodSync(real, 0o600)
  symlinkSync(real, link)
  writeJsonAtomic(link, parse(fx('settings-before.json')))
  expect(readFileSync(real, 'utf8')).toBe(fx('settings-before.json'))
  expect(lstatSync(link).isSymbolicLink()).toBe(true)
  expect(statSync(real).mode & 0o777).toBe(0o600)
  expect(readdirSync(dir).sort()).toEqual(['real-settings.json', 'settings.json'])
})

test('writeJsonAtomic: a failed write leaves the old file intact and no temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'effort-scope-'))
  const p = join(dir, 'settings.json')
  writeFileSync(p, fx('settings-before.json'))
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  expect(() => writeJsonAtomic(p, cyclic)).toThrow()
  expect(readFileSync(p, 'utf8')).toBe(fx('settings-before.json'))
  expect(readdirSync(dir)).toEqual(['settings.json'])
})

test('file round trip: snapshot → TUI write → restore gives the original bytes; a no-op does not write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'effort-scope-'))
  const p = join(dir, 'settings.json')
  writeFileSync(p, fx('settings-before.json'), { mode: 0o600 })
  const snap = readGlobalEffortSnapshot(p)!
  writeFileSync(p, fx('settings-after-effort-high.json'))           // what the TUI wrote
  expect(restoreGlobalEffort(snap, p)).toEqual({ ok: true, changed: ['modelSettings.claude-haiku-5-5.effortLevel → xhigh'] })
  expect(readFileSync(p, 'utf8')).toBe(fx('settings-before.json'))
  const mtime = statSync(p).mtimeMs
  expect(restoreGlobalEffort(snap, p)).toEqual({ ok: true, changed: [] })
  expect(statSync(p).mtimeMs).toBe(mtime)
})

test('file round trip: invalid JSON is reported and left untouched; a missing file snapshots as empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'effort-scope-'))
  const p = join(dir, 'settings.json')
  expect(readGlobalEffortSnapshot(p)).toEqual({ effortLevel: undefined, modelSettings: undefined, topKeys: [] })
  writeFileSync(p, '{ "modelSettings": ')
  expect(readGlobalEffortSnapshot(p)).toBeNull()
  const r = restoreGlobalEffort(effortSnapshotOf({}), p)
  expect(r.ok).toBe(false)
  expect(readFileSync(p, 'utf8')).toBe('{ "modelSettings": ')
})
