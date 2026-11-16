// Universe 002m, model aid (a): the routine-notice length gate. B01 (002l 0/3): a reflex lane's notice for a 「一句話」 report ran to 5-7 lines. A reflex lane's
// routine notify_joey (not Joey's own conversation, not critical, not a failure report, not a scheduled run: that one has its own gate) longer than one line is
// sent back ONCE asking for one line; the same text again goes out. design/routing 「每個回合都要回報一句」. No network, no model.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?pl2-aida-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-pl2-aida-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const sent: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async (_c: string, t: string) => { sent.push(t); return 500 + sent.length }, joeyChatId: () => '1' } as any)
const st = L.__lanesState()
let n = 0
function run(trigger: string, kind = 'reflex', extra: object = {}): any {
  n += 1
  const id = `adam.${kind}.${n}`
  st.lanes[id] = { id, kind, n, session_id: 's', thread: `adam#t-a${n}`, status: 'running', created: '', last: '', transcript: '/x', runs: 0, tokens_in: 0, tokens_out: 0 } as any
  st.threads[`adam#t-a${n}`] = { id: `adam#t-a${n}`, lane: id, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
  return { runId: `${id}.r1`, lane: id, evId: `ev-a${n}`, closers: [], critical: false, trigger, cls: trigger === 'alert' ? 'alert' : trigger, escalated: false, pushed: false, ...extra }
}
const B01 = ['【mock-api 回應變慢】', '- 警報：p95 2.1s，持續 5 分鐘（門檻 2s）', '- 查了 health：degraded，p95 2100ms，error rate 1%', '- 依 runbook 重啟了一次', '- 重啟後 p95 190ms，已恢復', '- 不需要你處理'].join('\n')
const ONE = 'mock-api p95 2.1s 超標 5 分鐘，依 runbook 重啟一次後回到 190ms，已恢復，不需要你處理。'

test('aid (a): B01\'s six-line notice for an alert is sent back once for one line; the one line goes out', async () => {
  const tok = run('alert'), s0 = sent.length
  await expect(L.callLaneTool(tok, 'notify_joey', { text: B01 })).rejects.toThrow(/notify_joey not sent: a routine notice to Joey is ONE line.*Yours is 6 lines/)
  expect(sent.length).toBe(s0)
  expect(await L.callLaneTool(tok, 'notify_joey', { text: ONE })).toContain('sent to Joey')
  expect(sent.length).toBe(s0 + 1)
})

test('aid (a): once only: the full notice sent again goes out (a change or a failure the gate did not see)', async () => {
  const tok = run('alert')
  await expect(L.callLaneTool(tok, 'notify_joey', { text: B01 })).rejects.toThrow(/ONE line/)
  expect(await L.callLaneTool(tok, 'notify_joey', { text: B01 })).toContain('sent to Joey')
})

test('aid (a): one very long line is sent back too; a short line is never', async () => {
  await expect(L.callLaneTool(run('alert'), 'notify_joey', { text: 'x'.repeat(L.ROUTINE_NOTICE_MAX_CHARS + 1) })).rejects.toThrow(/characters on one line/)
  expect(await L.callLaneTool(run('alert'), 'notify_joey', { text: ONE })).toContain('sent to Joey')
})

test('aid (a): not gated: a failure report, a critical run, a run in Joey\'s conversation, a worker lane', async () => {
  const fail = B01.replace('- 依 runbook 重啟了一次', '- 重啟失敗：503')
  expect(await L.callLaneTool(run('alert'), 'notify_joey', { text: fail })).toContain('sent to Joey')
  expect(await L.callLaneTool(run('alert', 'reflex', { critical: true }), 'notify_joey', { text: B01 })).toContain('sent to Joey')
  expect(await L.callLaneTool(run('joey'), 'notify_joey', { text: B01 })).toContain('sent to Joey')
  expect(await L.callLaneTool(run('peer', 'worker'), 'notify_joey', { text: B01 })).toContain('sent to Joey')
})

test('aid (a): a scheduled run keeps its own gate (two lines allowed there), not this one', async () => {
  const two = '備份檢查完成：最新備份 11-14 03:00，12.4 GB。\n下一次 11-15 03:00。'
  expect(await L.callLaneTool(run('scheduled'), 'notify_joey', { text: two })).toContain('sent to Joey')
})

test('aid (a) with L6B2\'s reading: a rate named in words with its value (error rate 1%, 錯誤率 0.5%) is a metric, not a failure', () => {
  for (const t of ['error rate 1%', 'error-rate: 0.4 %', '錯誤率 0.5%', 'failure rate 2%']) expect([t, L.failureSaid(t)]).toEqual([t, false])
  for (const t of ['error rate 上升到 9%，失敗', 'error rate is high']) expect([t, L.failureSaid(t)]).toEqual([t, true])
})
