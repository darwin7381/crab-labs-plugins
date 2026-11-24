// Universe 002k (C6): a follow-up chain stops by program: a run cap, and no next follow-up when a run found what the previous one found.
// The C02 case of 002j group C: a chain re-polled for 9 simulated hours while it waited for Joey (10 runs, 3.3M tokens). No network, no model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { outcomeFingerprint, sameOutcome, FOLLOWUP_CHAIN_MAX } from './lanes-followup.ts'
process.env.LANES_RECEIPT_STEPS = '0'                                       // 1.39.0 (WO-129) changes the scheduled receipt; this file's subject runs as 1.38.3 (lanes-wo129 tests it)
afterAll(() => { delete process.env.LANES_RECEIPT_STEPS })
const L = await import('./lanes.ts?c6-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-c6-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
const st = L.__lanesState()
const rows = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const ends = (thread: string) => rows().filter(r => r.thread === thread && r.refs?.followup_chain_ended)
let n = 0
/** a thread with its lane; run(evId, followup) = the token of one run on it */
function thread(): { id: string; lane: string; run: (ev: string, followup: boolean) => any } {
  n += 1
  const lane = `adam.reflex.${n}`, id = `adam#t-c6${n}`
  st.lanes[lane] = { id: lane, kind: 'reflex', n, session_id: 's', thread: id, status: 'running', created: '', last: '', transcript: '/x', runs: 0, tokens_in: 0, tokens_out: 0 } as any
  st.threads[id] = { id, lane, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
  // every run's event has its M3 record (the router opens it); this stands in for the router
  const rec = (ev: string) => { if (!L.__events().get(ev)) L.__events().open(ev, { class: 'scheduled', owner: lane, lane, thread: id, obligations: [] }); return ev }
  // PL3: a follow-up run is another run of the ORIGIN event (fire() names the follow-up); each run has its own run id
  let r = 0
  return { id, lane, run: (ev, followup) => { const f = ev.startsWith('fu:') ? st.followups[ev.slice(3)] : undefined
    return { runId: `${lane}.r${++r}`, lane, evId: rec(f ? f.event : ev), closers: [], critical: false, trigger: 'scheduled', cls: 'scheduled', escalated: false, pushed: false, followup, followupId: f?.id } } }
}
/** fire the pending follow-up of a thread as the router would: PL3, it is another run of its origin event (`fu:<id>` for run()) */
function fire(thr: string, _k: string): string {
  const f = Object.values(st.followups).find(x => x.thread === thr && x.state === 'pending')!
  f.state = 'fired'; f.fired_event = f.event
  return `fu:${f.id}`
}
const note = (i: number) => `重查 health：仍無 Joey 決定就不重啟（第 ${i} 輪）`

test('C6: the fingerprint blanks clock times, dates and ids, keeps measurements; sameOutcome needs the outcome word and near-equal text', () => {
  const a = outcomeFingerprint('nothing-to-do', { did: '19:15 查 health：error_rate 0.08，p95 2600ms，仍無 Joey 回覆（fu-c86f94）' })
  const b = outcomeFingerprint('nothing-to-do', { did: '21:40 查 health：error_rate 0.08，p95 2600ms，仍無 Joey 回覆（fu-903699）' })
  expect(sameOutcome(a, b)).toBe(true)
  expect(sameOutcome(a, outcomeFingerprint('nothing-to-do', { did: '21:40 查 health：error_rate 0.001，p95 180ms，已恢復' }))).toBe(false)     // it moved
  expect(sameOutcome(a, outcomeFingerprint('failed', { did: '19:15 查 health：error_rate 0.08，p95 2600ms，仍無 Joey 回覆（fu-c86f94）' }))).toBe(false)   // other outcome word
  expect(sameOutcome(outcomeFingerprint('done', {}), outcomeFingerprint('done', {}))).toBe(false)                                                  // no text: no evidence
  expect(outcomeFingerprint('done', { summary: 'x' })).toBe('done|x'); expect(outcomeFingerprint('done', { happened: 'h', did: '' })).toBe('done|h')
  expect(FOLLOWUP_CHAIN_MAX()).toBe(4)
})

test('C6: the chain cap: the ordinary run and four follow-up runs; the fifth follow-up is refused with a ledger line; the thread waits', async () => {
  const t = thread()
  let tok = t.run('mesh-c6a', false)
  for (let i = 1; i <= 4; i++) {
    const out = await L.callLaneTool(tok, 'followup', { after_minutes: 10, note: note(i) })
    expect(out).toContain('scheduled')
    expect(Object.values(st.followups).filter(f => f.thread === t.id).at(-1)!.chain).toBe(i)
    tok = t.run(fire(t.id, `a${i}`), true)                                              // the follow-up run: evId = the origin event (PL3)
  }
  const out = await L.callLaneTool(tok, 'followup', { after_minutes: 10, note: note(5) })
  expect(out).toContain('followup refused'); expect(out).toContain('cap 4'); expect(out).toContain('waits for a new event or for Joey')
  expect(Object.values(st.followups).filter(f => f.thread === t.id && f.state === 'pending').length).toBe(0)
  expect(Object.values(st.followups).filter(f => f.thread === t.id).length).toBe(4)       // five runs in all (1 + 4), never a sixth
  const e = ends(t.id)
  expect(e.length).toBe(1)
  expect(e[0]).toMatchObject({ kind: 'fyi', refs: { followup_chain_ended: 'cap', runs: 4, cap: 4 } })
  expect(L.__events().get(tok.evId)).toMatchObject({ chain_end: 'cap', chain_runs: 4 })          // PL1: the main reads it on the event's M3 record
  expect(e[0].text).toContain('到上限')
  await L.callLaneTool(tok, 'followup', { after_minutes: 10, note: note(6) })              // asked again in the same run: refused again, no second line
  expect(ends(t.id).length).toBe(1)
})

test('C6: the cap is an env setting', async () => {
  process.env.LANES_FOLLOWUP_CHAIN_MAX = '2'
  const t = thread()
  let tok = t.run('mesh-c6b', false)
  await L.callLaneTool(tok, 'followup', { after_minutes: 5, note: note(1) }); tok = t.run(fire(t.id, 'b1'), true)
  await L.callLaneTool(tok, 'followup', { after_minutes: 5, note: note(2) }); tok = t.run(fire(t.id, 'b2'), true)
  expect(await L.callLaneTool(tok, 'followup', { after_minutes: 5, note: note(3) })).toContain('cap 2')
  delete process.env.LANES_FOLLOWUP_CHAIN_MAX
})

test('C6: the no-change rule: a follow-up run that found what the run before found has the follow-up it scheduled cancelled, with a ledger line', async () => {
  const t = thread()
  const first = t.run('mesh-c6c', false)
  await L.callLaneTool(first, 'followup', { after_minutes: 10, note: note(1) })
  await L.callLaneTool(first, 'receipt', { outcome: 'nothing-to-do', happened: 'mock-api 5xx', did: '08:10 error_rate 0.08，等 Joey 決定重啟；已排 10 分鐘後再查', promised: '無', needs_main: '無' })
  const fu1 = t.run(fire(t.id, 'c1'), true)
  // follow-up 1 found something new: the chain goes on
  await L.callLaneTool(fu1, 'followup', { after_minutes: 20, note: note(2) })
  const r1 = await L.callLaneTool(fu1, 'receipt', { outcome: 'nothing-to-do', happened: '後續檢查', did: '08:20 error_rate 0.05，Eve 已回覆批次時間；仍等 Joey', promised: '無', needs_main: '無' })
  expect(r1).not.toContain('cancelled'); expect(ends(t.id).length).toBe(0)
  const pending = () => Object.values(st.followups).filter(f => f.thread === t.id && f.state === 'pending')
  expect(pending().length).toBe(1)
  const fu2 = t.run(fire(t.id, 'c2'), true)
  // follow-up 2 found the same as follow-up 1: its own next follow-up is cancelled
  await L.callLaneTool(fu2, 'followup', { after_minutes: 40, note: note(3) })
  expect(pending().length).toBe(1)
  const r2 = await L.callLaneTool(fu2, 'receipt', { outcome: 'nothing-to-do', happened: '後續檢查', did: '08:40 error_rate 0.05，Eve 已回覆批次時間；仍等 Joey', promised: '無', needs_main: '無' })
  expect(r2).toContain('cancelled'); expect(r2).toContain('waits for a new event or Joey')
  expect(pending().length).toBe(0)
  expect(Object.values(st.followups).filter(f => f.thread === t.id).at(-1)).toMatchObject({ state: 'ended', ended: 'no-change' })
  const e = ends(t.id)
  expect(e.length).toBe(1); expect(e[0].refs.followup_chain_ended).toBe('no-change'); expect(e[0]).toMatchObject({ kind: 'fyi' })
  expect(L.__events().get(fu2.evId)).toMatchObject({ chain_end: 'no-change' })                    // PL1: on the event's M3 record
  // and nothing fires: the cancelled one is not due-able
  for (const f of Object.values(st.followups)) if (f.thread === t.id) f.due = Date.now() - 1
  expect(Object.values(st.followups).filter(f => f.thread === t.id && f.state === 'pending').length).toBe(0)
})

test('C6: receipt first, then followup in the same run: the followup is refused (either order works)', async () => {
  const t = thread()
  const first = t.run('mesh-c6d', false)
  await L.callLaneTool(first, 'followup', { after_minutes: 10, note: note(1) })
  await L.callLaneTool(first, 'receipt', { outcome: 'done', happened: 'x', did: '仍在等 Joey，error_rate 0.08', promised: '無', needs_main: '無' })
  const fu1 = t.run(fire(t.id, 'd1'), true)
  await L.callLaneTool(fu1, 'receipt', { outcome: 'done', happened: 'x', did: '仍在等 Joey，error_rate 0.08', promised: '無', needs_main: '無' })   // same as the run before
  const out = await L.callLaneTool(fu1, 'followup', { after_minutes: 10, note: note(2) })
  expect(out).toContain('followup refused'); expect(out).toContain('same as the previous run')
  expect(Object.values(st.followups).filter(f => f.thread === t.id && f.state === 'pending').length).toBe(0)
  expect(ends(t.id).length).toBe(1)
})

test('C6: a new event on the thread starts a new chain; an ordinary run never trips the no-change rule', async () => {
  const t = thread()
  let tok = t.run('mesh-c6e', false)
  for (let i = 1; i <= 4; i++) { await L.callLaneTool(tok, 'followup', { after_minutes: 5, note: note(i) }); tok = t.run(fire(t.id, `e${i}`), true) }
  expect(await L.callLaneTool(tok, 'followup', { after_minutes: 5, note: note(5) })).toContain('refused')
  const fresh = t.run('mesh-c6e-new', false)                                               // Joey (or the peer) wrote again: an ordinary run
  await L.callLaneTool(fresh, 'receipt', { outcome: 'done', happened: 'x', did: '仍在等 Joey，error_rate 0.08', promised: '無', needs_main: '無' })
  await L.callLaneTool(fresh, 'receipt', { outcome: 'done', happened: 'x', did: '仍在等 Joey，error_rate 0.08', promised: '無', needs_main: '無' })   // same text twice, not a follow-up
  expect(await L.callLaneTool(fresh, 'followup', { after_minutes: 5, note: note(1) })).toContain('scheduled')
  expect(Object.values(st.followups).filter(f => f.thread === t.id).at(-1)!.chain).toBe(1)
})
