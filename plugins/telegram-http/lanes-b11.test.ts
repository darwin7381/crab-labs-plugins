// Universe 002k (B11): a scheduled run with no change leaves ONE line; at most one notify_joey per scheduled run. The program behind the
// card's one sentence. No network, no model.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?b11-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-b11-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const sent: Array<{ text: string; silent: boolean }> = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async (_c: string, text: string, o: any) => { sent.push({ text, silent: !!o?.silent }); return 9700 + sent.length }, joeyChatId: () => '1' } as any)
const st = L.__lanesState()
let n = 0
function run(trigger: string, extra: object = {}): any {
  n += 1
  const id = `adam.reflex.${n}`
  st.lanes[id] = { id, kind: 'reflex', n, session_id: 's', thread: `adam#t-b11${n}`, status: 'running', created: '', last: '', transcript: '/x', runs: 0, tokens_in: 0, tokens_out: 0 } as any
  st.threads[`adam#t-b11${n}`] = { id: `adam#t-b11${n}`, lane: id, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
  return { runId: `${id}.r1`, lane: id, evId: `ev-b11${n}`, closers: [], critical: false, trigger, cls: trigger, escalated: false, pushed: false, ...extra }
}
const rows = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const SIX = ['備份檢查完成。', '- 目標：s3://bt-backup/daily', '- 最新備份：2026-11-14 03:00', '- 大小：12.4 GB', '- 與昨天差異：+0.1 GB', '- 結論：一切正常'].join('\n')

test('B11: the card has the one sentence about scheduled runs, once', () => {
  const card = L.identityCard({ kind: 'reflex' })
  expect(card.split('排程回合（[scheduled]）沒有變化就只留一行').length - 1).toBe(1)
  expect(card).toContain('每個排程回合最多一次 notify_joey')
})

test('B11: six lines for a healthy scheduled run: sent back once asking for one line; the one line goes out; a second notify is refused', async () => {
  const tok = run('scheduled')
  await expect(L.callLaneTool(tok, 'notify_joey', { text: SIX })).rejects.toThrow(/ONE line/)
  expect(sent.length).toBe(0); expect(rows().filter(r => r.kind === 'notify').length).toBe(0)            // nothing was sent or recorded
  expect(await L.callLaneTool(tok, 'notify_joey', { text: '備份檢查完成：最新備份 2026-11-14 03:00，12.4 GB，正常。' })).toContain('sent to Joey')
  expect(sent.length).toBe(1)
  await expect(L.callLaneTool(tok, 'notify_joey', { text: '另外補充一點。' })).rejects.toThrow(/at most ONE message/)
  await expect(L.callLaneTool(tok, 'notify_joey', { text: '再補充。' })).rejects.toThrow(/at most ONE/)
  expect(sent.length).toBe(1)                                                                              // 4 attempts, 1 message
})

test('B11: a change or a failure gets the full report: failure words pass at once; a resend after the nudge passes; still only one', async () => {
  const bad = run('scheduled')
  const full = ['備份失敗：s3 回 403', '- 最近成功：2026-11-13 03:00', '- 已重試 1 次，仍 403', '- 需要平台組修 bucket policy'].join('\n')
  const n0 = sent.length
  expect(await L.callLaneTool(bad, 'notify_joey', { text: full })).toContain('sent to Joey')
  expect(sent.length).toBe(n0 + 1)
  await expect(L.callLaneTool(bad, 'notify_joey', { text: '補充' })).rejects.toThrow(/at most ONE/)
  const changed = run('scheduled')
  await expect(L.callLaneTool(changed, 'notify_joey', { text: SIX.replace('+0.1 GB', '+4.2 GB（備份策略改成每 6 小時）') })).rejects.toThrow(/ONE line/)
  expect(await L.callLaneTool(changed, 'notify_joey', { text: SIX.replace('+0.1 GB', '+4.2 GB（備份策略改成每 6 小時）') })).toContain('sent to Joey')   // it did change: full report
  for (const w of ['error 5', 'Failed to connect', '異常延遲']) {
    const t = run('scheduled'); const k = sent.length
    expect(await L.callLaneTool(t, 'notify_joey', { text: `排程檢查\n結果：${w}\n細節：略` })).toContain('sent to Joey'); expect(sent.length).toBe(k + 1)
  }
})

test('B11: a receipt that already says failed lets the full report through; two lines and a one-liner are never nudged', async () => {
  const t = run('scheduled')
  await L.callLaneTool(t, 'receipt', { outcome: 'failed', happened: '備份沒有完成', did: '重試一次', promised: '無', needs_main: '無' })
  expect(await L.callLaneTool(t, 'notify_joey', { text: SIX })).toContain('sent to Joey')
  const two = run('scheduled'), k = sent.length
  expect(await L.callLaneTool(two, 'notify_joey', { text: '備份檢查完成。\n最新備份 03:00，正常。' })).toContain('sent to Joey'); expect(sent.length).toBe(k + 1)
})

test('B11: a follow-up of a scheduled routine is a scheduled run too; a peer\'s run and an ask_joey are not limited', async () => {
  const f = run('scheduled', { followup: true })
  await expect(L.callLaneTool(f, 'notify_joey', { text: SIX })).rejects.toThrow(/ONE line/)
  const peer = run('peer'), k = sent.length
  await L.callLaneTool(peer, 'notify_joey', { text: SIX }); await L.callLaneTool(peer, 'notify_joey', { text: SIX + '\n（補充）' })
  expect(sent.length).toBe(k + 2)
  const s = run('scheduled'); await L.callLaneTool(s, 'notify_joey', { text: '一行。' })
  expect(await L.callLaneTool(s, 'ask_joey', { text: '備份連續失敗，要你決定。' })).toContain('sent to Joey')
})
