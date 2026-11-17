// Universe 002k (B21): tag markup in receipt fields is refused with a tool error; stripped as the fallback. No network, no model.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { cleanReport, reportMarkup, stripMarkup, MARKUP_RE } from './lanes-digest.ts'
const L = await import('./lanes.ts?b21-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-b21-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
const st = L.__lanesState()
let n = 0
function run(): any {
  n += 1
  const id = `adam.reflex.${n}`
  st.lanes[id] = { id, kind: 'reflex', n, session_id: 's', thread: `adam#t-b21${n}`, status: 'running', created: '', last: '', transcript: '/x', runs: 0, tokens_in: 0, tokens_out: 0 } as any
  st.threads[`adam#t-b21${n}`] = { id: `adam#t-b21${n}`, lane: id, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
  return { runId: `${id}.r1`, lane: id, evId: `ev-b21${n}`, closers: [], critical: false, trigger: 'peer', cls: 'peer', escalated: false, pushed: false }
}
const rows = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const BAD = '回覆 eve：30 秒</parameter>\n<parameter name="promised">無</parameter>\n<parameter name="needs_main">無'

test('B21: what counts as markup, and what does not', () => {
  for (const s of ['x</parameter>', '<parameter name="a">', '<b>粗體</b>', '</invoke>', '<br>', 'a <PARAMETER x']) expect(MARKUP_RE.test(s)).toBe(true)
  for (const s of ['p95 < 2s 且 error > 5%', '3 < 5 > 2', '改用 a<b 的判斷', 'x <- y', '<3 個', '無（沒有）']) expect(MARKUP_RE.test(s)).toBe(false)
  expect(reportMarkup({ happened: 'ok', did: BAD, promised: '無' })).toEqual(['did'])
  expect(reportMarkup({ happened: 'ok', did: '正常', summary: '<parameter name="x">' })).toEqual(['summary'])
})

test('B21: cleanReport strips the markup (the fallback); text around it stays', () => {
  const r = cleanReport({ happened: 'eve 問逾時', did: BAD, promised: '無', needs_main: '無' })!
  expect(r.did).not.toMatch(MARKUP_RE); expect(r.did).not.toContain('<'); expect(r.did).toContain('回覆 eve：30 秒')
  expect(stripMarkup('a<b>c</b> d <parameter name="x" ')).toBe('a c d')
  expect(cleanReport({ happened: '<b></b>' })?.happened ?? '').toBe('')
})
