// Universe 002k (G10): the main's commitment tool takes an optional due time; promiseTick rings Joey once when a commitment of the main is past due and not
// marked done (commitment_done). The reminder the main used to keep only in a session cron has a durable home. No network, no model.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?g10-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-g10-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const sent: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async (_c: string, t: string) => { sent.push(t); return 8000 + sent.length }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const st = L.__lanesState()
const rows = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const commit = (a: object) => L.callMainTool('commitment', a, 'mcp-main')
const done = (a: object) => L.callMainTool('commitment_done', a, 'mcp-main')
const idOf = (out: string): string => /id (cm-[0-9a-f]+)/.exec(out)![1]
const overdue = () => rows().filter(r => r.refs?.tier_rule === 'commitment-overdue')
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString()

test('G10: the main\'s commitment tool has an optional due; commitment_done exists; both are main-only', async () => {
  const c = L.mainToolDefs().find((t: any) => t.name === 'commitment')
  expect(Object.keys(c.inputSchema.properties)).toEqual(['who', 'what', 'by', 'due']); expect(c.inputSchema.required).toEqual(['who', 'what'])    // due is optional
  expect(L.mainToolDefs().map((t: any) => t.name)).toContain('commitment_done'); expect(L.isMainTool('commitment_done')).toBe(true)
  expect(L.LANE_TOOLS.find(t => t.name === 'commitment')!.inputSchema.properties).not.toHaveProperty('due')                                       // the lanes' tool is unchanged
  expect(await L.callMainTool('commitment_done', { commitment_id: 'x' }, 'some-other-session')).toStartWith('refused:')
})

test('G10: a commitment with a due time: the id comes back, the ledger line carries refs.id and refs.due, "by" is filled from the due time', async () => {
  // a due time that stays in the future: these commitments must not be past due when the later tests run promiseTick (a fixed 2026-11-15 went off on that day)
  const due = '2099-11-15T10:00:00+08:00'
  const out = await commit({ who: 'Joey', what: '10 點前提醒他查 mock-backup 的保留設定', due })
  const id = idOf(out)
  expect(out).toContain('commitment recorded'); expect(out).toContain('rung once'); expect(out).toContain(`commitment_done(${id})`)
  const r = rows().filter(x => x.kind === 'commitment').at(-1)
  expect(r).toMatchObject({ lane: 'main', notify_main: false, refs: { id, who: 'Joey', from: 'main-tool', due: '2099-11-15T02:00:00.000Z' } })
  expect(r.refs.by).toBe('2099-11-15 10:00 前'); expect(r.text).toContain('時限：2099-11-15 10:00 前')                    // the lab's local time (UTC+8)
  expect(st.main_commitments![id]).toMatchObject({ state: 'open', who: 'Joey', due: Date.parse(due) })
  expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).main_commitments[id].state).toBe('open')           // durable: in state.json
  const w = await commit({ who: 'Joey', what: '寫 runbook', by: '今天下班前', due })                                    // an explicit "by" is kept
  expect(rows().filter(x => x.kind === 'commitment').at(-1).refs.by).toBe('今天下班前'); expect(idOf(w)).not.toBe(id)
  await commit({ who: 'Joey', what: '一個沒有時區的時間', due: '2099-11-15T10:00:00' })                                   // no zone: the lab's local time
  expect(rows().filter(x => x.kind === 'commitment').at(-1).refs.due).toBe('2099-11-15T02:00:00.000Z')
})

test('G10: an unreadable due is refused and nothing is recorded; a commitment without a due behaves as before and is never rung for', async () => {
  const n = rows().length, k = Object.keys(st.main_commitments!).length
  const bad = await commit({ who: 'Joey', what: 'x', due: 'tomorrow morning' })
  expect(bad).toContain('commitment refused'); expect(bad).toContain('ISO time'); expect(rows().length).toBe(n); expect(Object.keys(st.main_commitments!).length).toBe(k)
  const out = await commit({ who: 'eve', what: '週五前補齊規格', by: '週五前' })
  expect(out).toContain('commitment recorded'); expect(out).not.toContain('rung once')
  const id = idOf(out)
  expect(st.main_commitments![id].due).toBeNull()
  st.main_commitments![id].created = new Date(Date.now() - 10 * 86_400_000).toISOString()
  L.promiseTick(); await sleep(30)
  expect(overdue().length).toBe(0)
})

test('G10: past due and not done: Joey is rung ONCE (push, not silent), a ledger line for the main\'s digest, nothing more at the next ticks', async () => {
  const k = sent.length
  const id = idOf(await commit({ who: 'Joey', what: '提醒他看一下 mock-api 的 p95 趨勢', due: inMs(150) }))
  L.promiseTick(); await sleep(30); expect(sent.length).toBe(k)                                                      // not due yet
  expect(st.main_commitments![id].state).toBe('open')
  await sleep(200)
  L.promiseTick(); await sleep(60)
  expect(sent.length).toBe(k + 1)
  expect(sent[k]).toContain('主線答應的事過了時限'); expect(sent[k]).toContain('答應 Joey：提醒他看一下 mock-api 的 p95 趨勢'); expect(sent[k]).toContain(id)
  const o = overdue().at(-1)
  expect(o).toMatchObject({ kind: 'notify', lane: 'router', notify_main: true, refs: { tier: 'push', escalated: true, commitment: id, who: 'Joey' } })
  expect(st.main_commitments![id]).toMatchObject({ state: 'overdue' })
  L.promiseTick(); L.promiseTick(); await sleep(60)
  expect(sent.length).toBe(k + 1); expect(overdue().filter(r => r.refs.commitment === id).length).toBe(1)             // once
})

test('G10: marked done before the due time: no ring. Marked done after the ring: recorded as late. Refusals: unknown id, done twice', async () => {
  const k = sent.length
  const a = idOf(await commit({ who: 'eve', what: '把規格給 eve', due: inMs(120) }))
  expect(await done({ commitment_id: a, note: '已寄出' })).toContain('marked done')
  const act = rows().filter(r => r.refs?.commitment_done === a).at(-1)
  expect(act).toMatchObject({ kind: 'action', lane: 'main', notify_main: false, refs: { late: false } }); expect(act.text).toContain('承諾完成'); expect(act.text).toContain('已寄出')
  await sleep(180); L.promiseTick(); await sleep(50)
  expect(sent.length).toBe(k)                                                                                        // done: never rung
  const b = idOf(await commit({ who: 'cain', what: '回覆 cain', due: inMs(60) }))
  await sleep(100); L.promiseTick(); await sleep(50)
  expect(sent.length).toBe(k + 1)
  expect(await done({ commitment_id: b })).toContain('past due')
  expect(rows().filter(r => r.refs?.commitment_done === b).at(-1)).toMatchObject({ refs: { late: true } }); expect(rows().filter(r => r.refs?.commitment_done === b).at(-1).text).toContain('過了時限才完成')
  expect(await done({ commitment_id: b })).toContain('already marked done'); expect(await done({ commitment_id: 'cm-nope' })).toContain('no commitment cm-nope'); expect(await done({})).toContain('no id given')
  expect(st.main_commitments![b].state).toBe('done')
})

test('G10: the existing promise ring still works next to it (the router\'s promise to a peer)', async () => {
  const k = sent.length
  st.promises['pr-g10'] = { id: 'pr-g10', peer: 'eve', thread: null, event: 'ev-x', what: '/v2/orders/bulk', created: Date.now() - 60_000, due: Date.now() - 1, state: 'open', handoff: 'h' } as any
  L.promiseTick(); await sleep(50)
  expect(sent.length).toBe(k + 1); expect(sent[k]).toContain('eve 在等主線回覆')
})
