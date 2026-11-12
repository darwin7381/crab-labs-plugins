// /effort session scope (1.27.8). claude's /effort writes the level into the GLOBAL
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
//  - lab-transcript-2026-11-12.jsonl: real records from the 1.27.7 lab session (assistant
//    entries reduced to type/timestamp/effort/model): a reply at xhigh, `/model opus`,
//    `/effort high`.
import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, lstatSync, statSync, readdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  effortSnapshotOf, restoreEffortFields, writeJsonAtomic, readGlobalEffortSnapshot, restoreGlobalEffort,
  effortFromCommandOutput, sessionEffortFromTranscript, globalEffortFor, transcriptConfirmsSwitch,
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

// ---- picker: what effort is this session on ----------------------------------

const lab = () => fx('lab-transcript-2026-11-12.jsonl').trim().split('\n').map(l => JSON.parse(l))
const cmdRec = (ts: string, cmd: string, args: string) => ({
  type: 'user', timestamp: ts,
  message: { role: 'user', content: `<command-name>${cmd}</command-name>\n            <command-message>${cmd.slice(1)}</command-message>\n            <command-args>${args}</command-args>` },
})
const outRec = (ts: string, out: string) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: `<local-command-stdout>${out}</local-command-stdout>` } })
const reply = (ts: string, effort: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'assistant', timestamp: ts, effort, perTurnEffort: effort, message: { role: 'assistant', model: 'claude-opus-5-5' }, ...extra })

test('transcript (real lab records): /effort high after /model opus → high, from /effort', () => {
  expect(sessionEffortFromTranscript(lab())).toEqual({ level: 'high', source: '本 session 的 /effort' })
  // the switch itself is still confirmed the 1.27.7 way
  expect(transcriptConfirmsSwitch(lab(), '/effort', 'high', Date.parse('2026-11-12T10:15:40Z'))).toMatch(/^Set effort level to high/)
})

test('transcript: a reply newer than /effort shows the level the API call sent', () => {
  expect(sessionEffortFromTranscript([...lab(), reply('2026-11-12T10:16:30.000Z', 'high')]))
    .toEqual({ level: 'high', source: '本 session 最近回覆實際使用' })
  expect(sessionEffortFromTranscript(lab().slice(0, 1))).toEqual({ level: 'xhigh', source: '本 session 最近回覆實際使用' })
})

test('transcript: /model after the last evidence → cannot tell (claude drops a picked level on a model change)', () => {
  const recs = [...lab(), cmdRec('2026-11-12T10:17:00.000Z', '/model', 'claude-sonnet-5-5'), outRec('2026-11-12T10:17:00.000Z', 'Set model to `Sonnet 5.5` and saved as your default for new sessions')]
  expect(sessionEffortFromTranscript(recs)).toEqual({ level: null, source: '/model 切換後還沒有回覆，無法確認（切換前是 `high`）' })
  // …until the next reply says what was sent
  expect(sessionEffortFromTranscript([...recs, reply('2026-11-12T10:17:30.000Z', 'xhigh')])?.level).toBe('xhigh')
})

test('transcript: a /model that did not switch (Kept model as …) does not void the evidence', () => {
  const recs = [...lab(), cmdRec('2026-11-12T10:17:00.000Z', '/model', 'opus'), outRec('2026-11-12T10:17:00.000Z', 'Kept model as Opus 5.5')]
  expect(sessionEffortFromTranscript(recs)?.level).toBe('high')
})

test('transcript: an /effort that changed nothing (env override) is not evidence', () => {
  const recs = [reply('2026-11-12T10:00:00.000Z', 'xhigh'), cmdRec('2026-11-12T10:01:00.000Z', '/effort', 'low'),
    outRec('2026-11-12T10:01:00.000Z', 'Not applied: CLAUDE_CODE_EFFORT_LEVEL=xhigh overrides effort this session, and low is session-only (nothing saved)')]
  expect(sessionEffortFromTranscript(recs)?.level).toBe('xhigh')
})

test('transcript: subagent (sidechain) replies and API-error records are ignored', () => {
  const recs = [reply('2026-11-12T10:00:00.000Z', 'high'), reply('2026-11-12T10:01:00.000Z', 'low', { isSidechain: true }),
    reply('2026-11-12T10:02:00.000Z', 'medium', { isApiErrorMessage: true })]
  expect(sessionEffortFromTranscript(recs)?.level).toBe('high')
})

test('transcript: no evidence → null (caller falls back to settings.json, labelled)', () => {
  expect(sessionEffortFromTranscript([])).toBeNull()
  expect(sessionEffortFromTranscript([cmdRec('2026-11-12T10:00:00.000Z', '/model', 'opus'), outRec('2026-11-12T10:00:00.000Z', 'Set model to `Opus 5.5`')])).toBeNull()
})

test('effortFromCommandOutput: the CLI 2.1.322 strings', () => {
  expect(effortFromCommandOutput('<local-command-stdout>Set effort level to max (this session only): Maximum capability</local-command-stdout>')).toBe('max')
  expect(effortFromCommandOutput("Effort 'max' exceeds the cap for claude-opus-5-5 set by your settings or organization; set to 'xhigh' instead (this session only): …")).toBe('xhigh')
  expect(effortFromCommandOutput('Effort level set to auto')).toBe('auto')
  expect(effortFromCommandOutput('Current effort level: medium (Balanced approach …)')).toBe('medium')
  expect(effortFromCommandOutput('Effort level: auto (currently xhigh)')).toBe('xhigh')
  expect(effortFromCommandOutput('Invalid argument: hgih. Valid options are: low, medium, high, xhigh, max, auto')).toBeNull()
  expect(effortFromCommandOutput('Ultracode on (this session only): dynamic workflows on every task. Effort stays high.')).toBeNull()
})

test('globalEffortFor: modelSettings entry for the model, else top-level effortLevel', () => {
  const s = parse(fx('settings-before.json'))
  s.modelSettings['claude-opus-5-5'].effortLevel = 'medium'
  s.modelSettings['claude-haiku-4-5'] = { effortLevel: 'low' }
  expect(globalEffortFor(s, 'claude-opus-5-5')).toEqual({ level: 'medium', key: 'modelSettings.claude-opus-5-5.effortLevel' })
  expect(globalEffortFor(s, 'claude-opus-5-5[1m]')?.level).toBe('medium')
  expect(globalEffortFor(s, 'claude-haiku-4-5-20251001')).toEqual({ level: 'low', key: 'modelSettings.claude-haiku-4-5.effortLevel' })
  expect(globalEffortFor(s, 'opus')).toEqual({ level: 'xhigh', key: 'effortLevel' })  // alias: no entry to match
  expect(globalEffortFor({ model: 'opus' }, 'opus')).toBeNull()
})
