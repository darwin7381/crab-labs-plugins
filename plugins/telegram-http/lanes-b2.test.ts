// Universe 002k (B2): a critical alert is marked 【主線必須知道】 in the ledger when its lane is started (not at the deadline or at the
// lane's report); the deadline ring and the lane's own report stay but do not mark the event again; the digest shows one mark.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?b2-test') as typeof import('./lanes.ts')
const { renderDigest, isWakeEntry, queryLedger } = await import('./lanes-digest.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-b2-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.sh')
writeFileSync(bin, `#!/bin/sh\nsleep 1.2\necho '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'\n`); chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => L.__setClaudeBin(restore))
const sent: Array<{ text: string; silent: boolean }> = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'],
  sendBot: async (_c: string, text: string, o: any) => { sent.push({ text, silent: !!o?.silent }); return 9400 + sent.length }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const rows = (n: string): any[] => { try { return readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(30) } return f() }
const ev = (id: string, text: string) => ({ id, source: 'mesh', from: 'alert-dispatcher', verified: true, text, meta: {}, notif: { method: '', params: {} } } as any)
const marks = (event: string) => rows('ledger.jsonl').filter(r => r.event === event && r.refs?.must_know === true)

test('B2: the must-know line is written when the critical lane starts: notify, notify_main, no push, no wake', async () => {
  L.__setCriticalDeadline(700)
  const t0 = Date.now()
  const d = await L.routeEvent(ev('mesh-m1', '[P1][critical] mock-api 全部回 5xx，已持續 2 分鐘'))
  expect(d.target).toBe('lane')
  const m = marks('mesh-m1')
  expect(m.length).toBe(1)                                                  // at once: the lane has not reported, the deadline has not passed
  expect(Date.now() - t0).toBeLessThan(500)
  expect(m[0]).toMatchObject({ kind: 'notify', notify_main: true, lane: d.lane, refs: { must_know: true, tier_rule: 'critical-mark' } })
  expect(m[0].text.startsWith('【主線必須知道】')).toBe(true)
  expect(m[0].text).toContain('全部回 5xx')
  expect(sent.length).toBe(0)                                               // no push
  expect(isWakeEntry(m[0])).toBe(false)                                     // no wake
  expect(m[0].refs.tier).toBe('ledger')
})

test('B2: the deadline ring still rings and the lane\'s own report still goes out, neither marks the event a second time', async () => {
  expect(await until(() => sent.length >= 1)).toBe(true)                    // the ring at the (shortened) deadline
  expect(sent[0].text).toContain('嚴重警報已收到'); expect(sent[0].silent).toBe(false)
  const ring = rows('ledger.jsonl').find(r => r.event === 'mesh-m1' && r.refs?.tier_rule === 'critical-deadline')!
  expect(ring).toBeTruthy(); expect(ring.refs.tier).toBe('push')
  expect(ring.refs.must_know).toBeUndefined(); expect(ring.text.startsWith('【主線必須知道】')).toBe(false)
  // the lane reports (its token is the critical lane's own run)
  const lane = Object.values(L.__lanesState().lanes).find(l => (l as any).critical)!
  const tok = { runId: `${lane.id}.r1`, lane: lane.id, evId: 'mesh-m1', closers: [], critical: true, trigger: 'alert-critical', cls: 'alert-critical', escalated: false, pushed: false } as any
  const out = await L.callLaneTool(tok, 'notify_joey', { text: 'mock-api 已重啟，5xx 消失，p95 180ms。' })
  expect(out).toContain('sent to Joey')
  const rep = rows('ledger.jsonl').filter(r => r.event === 'mesh-m1' && r.kind === 'notify' && r.text.includes('已重啟'))
  expect(rep.length).toBe(1); expect(rep[0].text.startsWith('【主線必須知道】')).toBe(false); expect(rep[0].refs.must_know).toBeUndefined()
  expect(marks('mesh-m1').length).toBe(1)                                   // still the one from dispatch
})

test('B2: the digest carries the mark once, heads the digest, and shows the lane\'s report, not the dispatch line', async () => {
  await L.callLaneTool({ runId: 'x', lane: Object.values(L.__lanesState().lanes).find(l => (l as any).critical)!.id, evId: 'mesh-m1', closers: [], critical: true, trigger: 'alert-critical', cls: 'alert-critical', escalated: false, pushed: false } as any,
    'receipt', { outcome: 'done', happened: '[P1] mock-api 全部回 5xx', did: '重啟 mock-api，5xx 消失', promised: '無', needs_main: '無' })
  // a routine thread first in the ledger, so the ordering means something
  const all = rows('ledger.jsonl')
  const routine = { ts: new Date(Date.parse(all[0].ts) - 1000).toISOString(), lane: 'adam.reflex.99', thread: 'adam#t-r99', event: 'ev-r99', kind: 'receipt', text: 'run -: done', notify_main: true, refs: { report: { happened: '每小時備份正常', did: '無', promised: '無', needs_main: '無' } } }
  const d = renderDigest([routine as any, ...all])!
  expect(d.text.split('【主線必須知道】').length - 1).toBe(1)                // one mark
  expect(d.wake).toBe(false)
  expect(d.text).toContain('重啟 mock-api，5xx 消失')
  expect(d.text.indexOf('【主線必須知道】')).toBeLessThan(d.text.indexOf('每小時備份正常'))   // heads the digest
  // before the lane has reported, the mark line is what the thread says
  const early = renderDigest(all.filter(r => r.kind === 'notify' && r.refs?.tier_rule === 'critical-mark'))!
  expect(early.text).toContain('【主線必須知道】'); expect(early.text).toContain('全部回 5xx'); expect(early.text).not.toContain('（沒有文字）')
  expect(queryLedger(all.map(r => JSON.stringify(r)).join('\n'), {}, Date.now())).toContain('全部回 5xx')
})

test('B2: a non-critical alert is not marked', async () => {
  await L.routeEvent(ev('mesh-m2', '[P2][warning] mock-api p95 回應時間 2.1s，持續 5 分鐘'))
  await sleep(100)
  expect(marks('mesh-m2').length).toBe(0)
})
