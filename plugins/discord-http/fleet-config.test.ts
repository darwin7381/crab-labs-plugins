import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyFleetConfig, parseFleetConfig } from './fleet-config.ts'

describe('fleet config', () => {
  test('parses KEY=VALUE, skips comments, blanks and bad keys, strips matching quotes', () => {
    expect(parseFleetConfig([
      '# comment',
      '',
      'API_BASE=https://control.example.com',
      "LABEL='com.example.wrapper'",
      'QUOTED="a=b"',
      'lower=ignored',
      'NOEQUALS',
      '  SPACED  =  v  ',
    ].join('\n'))).toEqual({
      API_BASE: 'https://control.example.com',
      LABEL: 'com.example.wrapper',
      QUOTED: 'a=b',
      SPACED: 'v',
    })
  })

  test('never overrides a variable the daemon already has', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleetcfg-'))
    const p = join(dir, 'env')
    writeFileSync(p, 'A=from-file\nB=from-file\n')
    const env: Record<string, string | undefined> = { A: 'from-plist' }
    expect(applyFleetConfig(p, env)).toEqual(['B'])
    expect(env).toEqual({ A: 'from-plist', B: 'from-file' })
  })

  test('missing file applies nothing', () => {
    const env: Record<string, string | undefined> = {}
    expect(applyFleetConfig('/nonexistent/crab-labs-plugins/env', env)).toEqual([])
    expect(env).toEqual({})
  })
})
