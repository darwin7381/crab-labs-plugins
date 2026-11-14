// Universe 002k (B15): the digest is short. 002j B08: 18 threads came as 16 entries and 48 lines against the design's 8.
// Caps 3 heavy + 5 routine (env), a heavy block is at most 3 lines, routine threads of one class are one line with a count; what is handed to the main,
// a critical alert's mark and a memory proposal from Joey are never cut. The caps are also checked against the stream B12's dedupe leaves.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { renderDigest, parseLedgerLine, DIGEST_MAX_HEAVY, DIGEST_MAX_ROUTINE, MUST_KNOW_MARK, type LedgerRec } from './lanes-digest.ts'
const L0 = await import('./lanes.ts?b15-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-b15-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3\nimport time\ntime.sleep(0.3)\nprint('{"type":"result","subtype":"success","is_error":false,"result":"ok"}')\n`)
chmodSync(bin, 0o755)
const restore = L0.__setClaudeBin(bin)
afterAll(() => { L0.__setClaudeBin(restore) })
L0.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L0.__setMainConnected('mcp-main')

const T0 = Date.parse('2026-11-13T03:00:00Z')
let tick = 0
const R = (o: Partial<LedgerRec> & { kind: string; text: string }): LedgerRec =>
  ({ ts: new Date(T0 + (tick++) * 1000).toISOString(), lane: 'adam.reflex.1', thread: 'adam#t-x', event: 'ev', notify_main: true, refs: null, detail: null, ...o })
/** one routine thread of a class: the lane's report with nothing for the main */
const routine = (n: number, cls: string | null, text = `mock-api p95 警報（第 ${n} 次偵測）：只有 11:02 起 3 分鐘超標，未重啟`) =>
  R({ lane: `adam.reflex.${n}`, thread: `adam#t-r${n}`, kind: 'receipt', text: 'run -: done', refs: { report: { happened: text, did: '查 health、metrics，未重啟', promised: '無', needs_main: '無' }, ...(cls ? { class: cls } : {}) } })
/** a thread that needs the main for something it does not wake it for (a promise) */
const heavy = (n: number, o: Partial<LedgerRec> = {}) =>
  R({ lane: `adam.reflex.${n}`, thread: `adam#t-h${n}`, kind: 'receipt', text: 'run -: done', refs: { report: { happened: `Eve 要第 ${n} 份報表`, did: `回覆 Eve：第 ${n} 份下週給`, promised: `對 Eve：第 ${n} 份下週三前給`, needs_main: `決定第 ${n} 份誰算` }, class: 'peer' }, ...o })
const escalationOf = (n: number) => R({ lane: `adam.reflex.${n}`, thread: `adam#t-e${n}`, kind: 'escalation', text: `備份 ${n} 失敗 403，請主線決定` })
const mustKnow = (n: number) => R({ lane: `adam.reflex.${n}`, thread: `adam#t-m${n}`, kind: 'notify', refs: { tier: 'ledger', tier_rule: 'critical-mark', must_know: true, class: 'alert-critical' }, text: `【主線必須知道】[ledger] 嚴重警報 ${n}：全部回 5xx` })
const joeyProposal = (n: number) => R({ lane: `adam.reflex.${n}`, thread: `adam#t-j${n}`, kind: 'memory_proposal', refs: { proposal_id: `mp-${n}`, joey: true, class: 'joey' }, text: `記下：Joey 說第 ${n} 件事` })
const lines = (d: { text: string }) => d.text.split('\n')
const bullets = (d: { text: string }) => lines(d).filter(l => l.startsWith('•') || l.startsWith('▸'))

test('B15: the caps are 3 heavy and 5 routine, and an env setting changes them', async () => {
  expect(DIGEST_MAX_HEAVY).toBe(3); expect(DIGEST_MAX_ROUTINE).toBe(5)
  process.env.LANES_DIGEST_MAX_HEAVY = '1'; process.env.LANES_DIGEST_MAX_ROUTINE = '2'
  const E = await import('./lanes-digest.ts?b15-env') as typeof import('./lanes-digest.ts')
  delete process.env.LANES_DIGEST_MAX_HEAVY; delete process.env.LANES_DIGEST_MAX_ROUTINE
  expect(E.DIGEST_MAX_HEAVY).toBe(1); expect(E.DIGEST_MAX_ROUTINE).toBe(2)
  const d = E.renderDigest([heavy(1), heavy(2), heavy(3), routine(4, 'a'), routine(5, 'b'), routine(6, 'c')])!
  expect(lines(d).filter(l => l.startsWith('▸')).length).toBe(1)
  expect(lines(d).filter(l => l.startsWith('•')).length).toBe(2)
  expect(d.text).toContain('另有 3 條線沒列出')                                         // 2 heavy threads + 1 routine class (1 thread) not listed
  process.env.LANES_DIGEST_MAX_HEAVY = 'oops'
  const bad = await import('./lanes-digest.ts?b15-env-bad') as typeof import('./lanes-digest.ts')
  delete process.env.LANES_DIGEST_MAX_HEAVY
  expect(bad.DIGEST_MAX_HEAVY).toBe(3)                                                  // not a number: the default
})

test('B15: routine threads of one class are ONE line with a count; a class of one thread keeps its own line; threads with no class are never merged', () => {
  const recs = [...Array.from({ length: 9 }, (_, i) => routine(10 + i, 'alert')), routine(30, 'peer'), routine(31, 'peer'), routine(32, 'scheduled'), routine(33, null), routine(34, null)]
  const d = renderDigest(recs)!
  const b = bullets(d)
  const alert = b.find(l => l.includes('例行 ×9'))!
  expect(alert).toBeDefined(); expect(alert).toContain('｜alert｜'); expect(alert).toContain('adam.reflex.10'); expect(alert).toContain('…')   // names the first four, then "…"
  expect(alert).toContain('例：mock-api p95 警報（第 10 次偵測）')                       // what the first one said
  expect(b.some(l => l.includes('例行 ×2') && l.includes('｜peer｜'))).toBe(true)
  expect(b.some(l => l.startsWith('• adam.reflex.32｜adam#t-r32｜例行：'))).toBe(true)   // a class of one thread: the line it always had
  expect(b.filter(l => l.includes('adam#t-r33') || l.includes('adam#t-r34')).length).toBe(2)   // no class: no merge
  expect(b.length).toBe(5)                                                              // alert, peer, scheduled + the 2 unknown = 5 lines, the cap
  expect(d.text.split('\n')[0]).toContain('14 條線有動靜')                                // the header still counts every thread
  expect(d.threads).toBe(14)
  expect(d.text).not.toContain('另有')
})

test('B15: more routine lines than the cap: the first five classes are shown, the threads of the others are counted in "另有"', () => {
  const classes = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  const recs = classes.flatMap((c, i) => [routine(40 + i * 2, c), routine(41 + i * 2, c)])
  const d = renderDigest(recs)!
  expect(bullets(d).length).toBe(DIGEST_MAX_ROUTINE)
  expect(bullets(d).every(l => l.includes('例行 ×2'))).toBe(true)
  expect(d.text).toContain('另有 4 條線沒列出')                                         // classes f and g: 4 threads
})

test('B15: a heavy block is at most three lines, however much it carries; a part that is "none" is left out', () => {
  const long = 'x'.repeat(900)
  const full = renderDigest([R({ lane: 'adam.reflex.50', thread: 'adam#t-l50', kind: 'receipt', text: 'r', refs: { report: { happened: long, did: long, promised: long, needs_main: long }, class: 'peer' } })])!
  const block = lines(full).slice(1, -1)
  expect(block.length).toBe(3)
  expect(block[0]).toMatch(/^▸ adam\.reflex\.50｜adam#t-l50｜11-13 \d\d:\d\d｜發生：/)
  expect(block[1]).toMatch(/^ {2}做了：.*｜承諾：/); expect(block[2]).toMatch(/^ {2}需主線：/)
  const one = renderDigest([R({ lane: 'adam.reflex.51', thread: 'adam#t-l51', kind: 'receipt', text: 'r', refs: { report: { happened: 'Eve 問維護時段', did: '無', promised: '對 Eve：週五前給', needs_main: '無' }, class: 'peer' } })])!
  expect(lines(one).slice(1, -1).length).toBe(2)                                        // header + 承諾 only
  expect(one.text).not.toContain('需主線'); expect(one.text).not.toContain('做了：無')
  // an escalation block: three lines too, its note on the 需主線 line
  const esc = renderDigest([escalationOf(52)])!
  expect(lines(esc).slice(1, -1).length).toBe(2); expect(esc.text).toContain('需主線：備份 52 失敗 403，請主線決定（這件事交給你了：車道沒有通知過 Joey，處理完由你回報他一次。）')
})

test('B15: what the caps never cut: escalations, critical marks and Joey-sourced proposals; the other heavy blocks fill what is left of the 3', () => {
  const recs = [...[1, 2, 3, 4, 5].map(escalationOf), ...[6, 7, 8, 9].map(mustKnow), ...[10, 11, 12].map(joeyProposal), ...[13, 14, 15, 16].map(n => heavy(n)), routine(20, 'alert')]
  const d = renderDigest(recs)!
  for (const n of [1, 2, 3, 4, 5]) expect(d.text).toContain(`adam#t-e${n}`)
  for (const n of [6, 7, 8, 9]) expect(d.text).toContain(`${MUST_KNOW_MARK}adam.reflex.${n}｜adam#t-m${n}`)
  for (const n of [10, 11, 12]) expect(d.text).toContain(`adam#t-j${n}`)
  for (const n of [13, 14, 15, 16]) expect(d.text).not.toContain(`adam#t-h${n}`)      // over the cap: the 3 are used up by the never-cut blocks
  expect(d.text).toContain('另有 4 條線沒列出')
  expect(d.text).toContain('adam#t-r20')
  // with room, the ordinary heavy blocks are shown up to the cap
  const roomy = renderDigest([escalationOf(1), ...[13, 14, 15, 16].map(n => heavy(n))])!
  expect(lines(roomy).filter(l => l.startsWith('▸')).length).toBe(DIGEST_MAX_HEAVY)    // 1 escalation + 2 of the 4
  expect(roomy.text).toContain('另有 2 條線沒列出')
  // the open Joey proposals (the reopen list) are listed every time, whatever else there is
  const reopen = [R({ lane: 'adam.reflex.60', kind: 'memory_proposal', refs: { proposal_id: 'mp-60', joey: true }, text: '記下：Joey 說的第 60 件事' })]
  const d2 = renderDigest([...[13, 14, 15, 16].map(n => heavy(n))], reopen)!
  expect(d2.text).toContain('mp-60'); expect(d2.text).toContain('記下：Joey 說的第 60 件事')
})

// ---- the stream B12's dedupe leaves
test('B15: the B08 mix, deduped by the router (twelve repeats of one alert = one lane + eleven repeat lines for nobody), fits the caps', async () => {
  const mk = (n: number) => ({ id: `mesh-d${n}`, source: 'mesh', from: 'alert-dispatcher', verified: true, text: `[P2][warning] mock-api p95 > 2s（第 ${n} 次偵測）`, meta: {}, notif: { method: '', params: {} } } as any)
  const decisions = []
  for (let n = 1; n <= 12; n++) decisions.push(await L0.routeEvent(mk(n)))
  expect(decisions[0].target).toBe('lane')
  expect(decisions.slice(1).every(d => d.rule === 'alert-repeat')).toBe(true)
  const thread = L0.__lanesState().lanes[decisions[0].lane!].thread
  const real = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(parseLedgerLine) as LedgerRec[]
  expect(real.filter(r => r.refs?.repeat).length).toBe(11)
  // what the rest of the day looked like in B08: the alert thread reports, two peers ask, backup fails and is handed up, a promise, a critical alert
  const day = [...real, routine(70, 'alert', 'mock-api p95 警報：11:02 起 3 分鐘超標'), routine(71, 'peer', 'Eve 問 payment 類工單幾張'), routine(72, 'peer', 'Eve 問明天維護'),
    escalationOf(73), heavy(74), mustKnow(75)]
  for (const r of real.filter(r => r.refs?.repeat)) expect(r.notify_main).toBe(false)
  // the alert thread's own report joins the thread the router opened
  day.push(R({ lane: decisions[0].lane!, thread, kind: 'receipt', text: 'run -: done', refs: { report: { happened: 'mock-api p95 警報（第 1 次偵測）：未達 5 分鐘', did: '查 health，未重啟', promised: '無', needs_main: '無' }, class: 'alert' } }))
  const d = renderDigest(day)!
  expect(d.threads).toBe(7)                                                             // alert thread, 2 peers, escalation, promise, critical (the 11 repeats are no threads)
  expect(bullets(d).filter(l => l.startsWith('•')).length).toBe(2)                      // 1 merged peer line + 1 alert line
  expect(lines(d).length).toBeLessThanOrEqual(1 + 1 + 3 + 3 + 1 + 3 + 1 + 1 + 1)        // header, escalation, separator, ≤3 per heavy block, routine lines, footer
  expect(lines(d).length).toBeLessThan(20)
  // the same day WITHOUT the dedupe: twelve alert threads (what B08 saw). The class merge keeps even that to one routine line for the alerts.
  const undeduped = [...Array.from({ length: 12 }, (_, i) => routine(80 + i, 'alert', `mock-api p95 警報（第 ${i + 1} 次偵測）`)), routine(71, 'peer', 'Eve 問 payment 類工單幾張'), routine(72, 'peer', 'Eve 問明天維護'), escalationOf(73), heavy(74), mustKnow(75)]
  const u = renderDigest(undeduped)!
  expect(bullets(u).filter(l => l.startsWith('•')).length).toBe(2)
  expect(bullets(u).find(l => l.includes('例行 ×12'))).toBeDefined()
})

// ---- the real B08 burst (the archived run), when it is on this machine
const B08 = '/archive/genesis/runs/u002j-V1-B-R63-r1-20261114-210726/lanes/ledger.jsonl'
test.skipIf(!existsSync(B08))('B15: the archived B08 ledger range that came as 18 threads / 48 lines now comes in far fewer lines and loses no escalation', () => {
  const all = readFileSync(B08, 'utf8').split('\n').filter(Boolean).map(parseLedgerLine).filter((r): r is LedgerRec => !!r)
  const from = Date.parse('2026-11-13T03:02:09.986Z'), to = Date.parse('2026-11-13T03:07:52.179Z')
  const range = all.filter(r => Date.parse(r.ts) > from && Date.parse(r.ts) <= to)
  const d = renderDigest(range)!
  const handedUp = new Set(range.filter(r => r.kind === 'escalation' && r.notify_main).map(r => r.thread))
  expect(d.threads).toBeGreaterThan(10)
  for (const t of handedUp) expect(d.text).toContain(String(t))                         // every thread that handed something to the main is there
  expect(lines(d).length).toBeLessThan(48)
  expect(Math.max(...lines(d).filter(l => l.startsWith('▸')).map(l => lines(d).indexOf(l)).slice(-1))).toBeGreaterThan(0)
})

test('B15: the receipt a lane files carries the class of its run, so the digest can merge by it', async () => {
  const st = L0.__lanesState()
  st.lanes['adam.reflex.90'] = { id: 'adam.reflex.90', kind: 'reflex', n: 90, session_id: 's', thread: 'adam#t-r90', status: 'running', created: '', last: '', transcript: '/x', runs: 0, tokens_in: 0, tokens_out: 0 } as any
  const tok = { runId: 'adam.reflex.90.r1', lane: 'adam.reflex.90', evId: 'ev-90', closers: [], critical: false, trigger: 'alert', cls: 'alert', escalated: false, pushed: false } as any
  expect(await L0.callLaneTool(tok, 'receipt', { outcome: 'done', happened: 'a', did: 'b', promised: '無', needs_main: '無' })).toContain('receipt recorded')
  const rec = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.lane === 'adam.reflex.90' && r.kind === 'receipt').pop()
  expect(rec.refs.class).toBe('alert'); expect(rec.refs.report.happened).toBe('a')
})
