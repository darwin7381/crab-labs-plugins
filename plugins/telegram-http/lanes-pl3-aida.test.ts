// Universe 002n: aid (a) of 002m did not reach B01 r1. Its three 4-6-line routine notices said 「error 1%」, 「error 0.001」 and 「performance/api-error 類」,
// and failureSaid read them as failure reports, which the one-line gate lets through (B01 bot_message_to_joey FAIL as in 002l). A failure word with a
// percentage or a fraction is a measured rate, and a word inside a path or a slash list is a name; a count still says something failed.
// design/routing 「每個回合都要回報一句」; B01 「回報一句話講清楚」. No network, no model.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?pl3-aida-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-pl3-aida-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const sent: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async (_c: string, t: string) => { sent.push(t); return 700 + sent.length }, joeyChatId: () => '1' } as any)
const st = L.__lanesState()
let n = 0
function run(): any {
  n += 1
  const id = `adam.reflex.${n}`
  st.lanes[id] = { id, kind: 'reflex', n, session_id: 's', thread: `adam#t-c${n}`, status: 'running', created: '', last: '', transcript: '/x', runs: 0, tokens_in: 0, tokens_out: 0 } as any
  st.threads[`adam#t-c${n}`] = { id: `adam#t-c${n}`, lane: id, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
  return { runId: `${id}.r1`, lane: id, evId: `ev-c${n}`, closers: [], critical: false, trigger: 'alert', cls: 'alert', escalated: false, pushed: false }
}
// B01 r1 (002m), message #1005 and #1006, as the lane wrote them (shortened)
const M1005 = ['mock-api p95 警報（mesh-50001，P2）查證結果，UTC+8 10:02：', '- 現況：health p95 2100ms、error_rate 1%（10:02:11 查）。',
  '- metrics 最近 10 分鐘：10:01、10:02 才超過 2000ms。', '- tickets 總數 435、open 18（stats，未翻頁查 performance/api-error 類）。', '- 處理：暫不重啟。已排 4 分鐘後複查。'].join('\n')
const M1006 = ['mock-api p95 警報（mesh-50001）後續，UTC+8 10:06：', '- 複查時條件成立：metrics 顯示 10:01–10:06 連續六分鐘 p95 2107–2128ms、error 1%。',
  '- 依 runbook 第 4 節做一次滾動重啟，10:06:52 完成。', '- 重啟後 health：ok、p95 190ms、error 0.001。'].join('\n')

test('aid (a) on B01: a measured rate (error 1%, error 0.001, 錯誤 1%) and a slash name (performance/api-error) are not failure words', () => {
  for (const t of [M1005, M1006, 'error 1%', 'error 0.001', '錯誤 1%', 'performance/api-error 類', 'GET /v2/errors 回 200']) expect(L.failureSaid(t)).toBe(false)
})

test('aid (a) on B01: a count, a failed step, an error message and a failure word still say something failed', () => {
  for (const t of ['errors=3', '3 errors', 'error 12', 'error: timeout', 'backup failed: 403', '上傳失敗', 'failed_step=upload', 'state=failed']) expect(L.failureSaid(t)).toBe(true)
})

test('aid (a) on B01: #1005 and #1006 are sent back once for one line; the one line goes out', async () => {
  for (const m of [M1005, M1006]) {
    const tok = run(), s0 = sent.length
    await expect(L.callLaneTool(tok, 'notify_joey', { text: m })).rejects.toThrow(/a routine notice to Joey is ONE line/)
    expect(sent.length).toBe(s0)
    expect(await L.callLaneTool(tok, 'notify_joey', { text: 'mock-api p95 超標 6 分鐘，依 runbook 重啟一次後回到 190ms，已恢復，不需要你處理。' })).toContain('sent to Joey')
  }
})
