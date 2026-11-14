// Universe 002k (B8): isNone accepts a leading none-word followed by punctuation or a bracket; no false commitment is logged for it.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isNone, cleanReport, renderDigest } from './lanes-digest.ts'
import { commitmentFromReport } from './lanes-followup.ts'
const L = await import('./lanes.ts?b8-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-b8-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
const rows = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }

test('B8: a none-word followed by punctuation, a bracket or a space is none', () => {
  for (const s of ['無（只說…）', '無（只說了稍後回報，沒有答應時間）', '無。', '無，', '無 (nothing promised)', '沒有（這次只是知會）', '没有；已交給主線', '不需要：主線已接手', 'none (just said I would report)', 'None - nothing', 'nothing, really', 'N/A (no promise)', 'nil.', '無\n（只說…）']) expect(isNone(s)).toBe(true)
  // what was none before stays none
  for (const s of ['無', ' 無 ', '沒有。', 'none', 'No', 'n/a', '-', '—', '', undefined, null]) expect(isNone(s as any)).toBe(true)
})

test('B8: a promise is not none: the none-word that starts a longer word, a bare "no," or a dash bullet', () => {
  for (const s of ['無法連線，明天再試', '沒有人回覆，我答應 Eve 明天 10:00 前給結果', '無需求變更之外，我會在 15:00 前回', 'nonetheless I will send it by 15:00', 'nothingness', 'No, I will send it tomorrow', '- 明天給 Eve', '答應 Eve 明天 10:00 前回覆', '不用擔心，我 14:00 前給你']) expect(isNone(s)).toBe(false)
})

test('B8: no commitment is derived from "無（…）"; a real promise still is', () => {
  expect(commitmentFromReport('無（只說了稍後回報）', 'eve', 'eve')).toBeNull()
  expect(commitmentFromReport('答應 Eve 明天 10:00 前回覆逾時設定', 'eve', 'eve')).toMatchObject({ who: 'eve', by: expect.stringContaining('10:00') })
})

test('B8: a receipt with promised "無（…）" logs no commitment; the digest treats it as no promise', async () => {
  const st = L.__lanesState()
  st.lanes['adam.reflex.1'] = { id: 'adam.reflex.1', kind: 'reflex', n: 1, session_id: 's', thread: 'adam#t-b8', status: 'running', created: '', last: '', transcript: '', runs: 0, tokens_in: 0, tokens_out: 0 } as any
  st.threads['adam#t-b8'] = { id: 'adam#t-b8', lane: 'adam.reflex.1', peer: 'eve', hops: 1, tokens: 0, created: '', last: '' } as any
  const tok = { runId: 'adam.reflex.1.r1', lane: 'adam.reflex.1', evId: 'ev-b8', closers: [], critical: false, trigger: 'peer', cls: 'peer', escalated: false, pushed: false } as any
  await L.callLaneTool(tok, 'receipt', { outcome: 'done', happened: 'eve 問逾時', did: '回覆 eve：30 秒', promised: '無（只說了「有需要再問」，沒有約時間）', needs_main: '無（不需要主線）' })
  expect(rows().filter(r => r.kind === 'commitment').length).toBe(0)
  const d = renderDigest(rows() as any)!
  expect(d.text).toContain('例行')                                  // a routine line: nothing promised, nothing needed
  expect(d.text).not.toContain('承諾：無（')
})
