// lanes-golive (1.34.2): every Jev check reads the key through the one reader (lanes-triage.ts jevKey). Chiron / Aegis 2026-11-23: proposalReview
// and reportCheck in lanes.ts read TYPESAFE_KEY_FILE or the lab's ~/.genesis/typesafe.env themselves, so on the fleet (key in the agent's
// <workspace>/.secrets/typesafe.env) both never had a key and always passed.
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { jevKey, jevKeyFile, setJevKeyDefault } from './lanes-triage.ts'

test('the fleet key place is read by the one reader', () => {
  const ws = mkdtempSync(join(tmpdir(), 'jevkey-'))
  mkdirSync(join(ws, '.secrets'))
  writeFileSync(join(ws, '.secrets', 'typesafe.env'), 'TYPESAFE_API_KEY="k-fleet-123"\n')
  const keep = { k: process.env.TYPESAFE_API_KEY, f: process.env.TYPESAFE_KEY_FILE }
  delete process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_KEY_FILE
  try {
    setJevKeyDefault(join(ws, '.secrets', 'typesafe.env'))
    expect(jevKeyFile()).toBe(join(ws, '.secrets', 'typesafe.env'))
    expect(jevKey()).toBe('k-fleet-123')
    process.env.TYPESAFE_API_KEY = 'k-env'
    expect(jevKey()).toBe('k-env')                       // the env var still wins
  } finally {
    if (keep.k == null) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = keep.k
    if (keep.f == null) delete process.env.TYPESAFE_KEY_FILE; else process.env.TYPESAFE_KEY_FILE = keep.f
  }
})

test('no check in lanes.ts reads a key file by itself', () => {
  const src = readFileSync(join(import.meta.dir, 'lanes.ts'), 'utf8')
  expect(src.includes(".genesis', 'typesafe.env'")).toBe(false)
  expect(/readFileSync\(process\.env\.TYPESAFE_KEY_FILE/.test(src)).toBe(false)
  expect((src.match(/jevKey\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2)
})
