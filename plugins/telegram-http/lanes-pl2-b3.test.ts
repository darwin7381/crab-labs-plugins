// Universe 002m (L6B3, RV6 B06 #6: B r1 notify #1025 then ask #1026, B r2 ask #1028 then notify #1029, one scheduled run each): the at-most-one-message gate of
// a scheduled run counts ask_joey too. Card 「每個排程回合最多一次 notify_joey」; the gate's own words: "at most ONE message to Joey". No network, no model.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?pl2-b3-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-pl2-b3-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const sent: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async (_c: string, text: string) => { sent.push(text); return 9800 + sent.length }, joeyChatId: () => '1' } as any)
const st = L.__lanesState()
let n = 0
function run(trigger: string): any {
  n += 1
  const id = `adam.reflex.${n}`
  st.lanes[id] = { id, kind: 'reflex', n, session_id: 's', thread: `adam#t-b3${n}`, status: 'running', created: '', last: '', transcript: '/x', runs: 0, tokens_in: 0, tokens_out: 0 } as any
  st.threads[`adam#t-b3${n}`] = { id: `adam#t-b3${n}`, lane: id, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
  return { runId: `${id}.r1`, lane: id, evId: `ev-b3${n}`, closers: [], critical: false, trigger, cls: trigger, escalated: false, pushed: false }
}
const notifies = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.kind === 'notify') } catch { return [] } }

test('L6B3: notify_joey, then ask_joey in the same scheduled run: the ask is refused and says to hand it to the main or put it in the receipt', async () => {
  const tok = run('scheduled'), s0 = sent.length
  expect(await L.callLaneTool(tok, 'notify_joey', { text: '備份 11-13 失敗：403。' })).toContain('sent to Joey')
  await expect(L.callLaneTool(tok, 'ask_joey', { text: '要我重跑備份嗎？' })).rejects.toThrow(/ask_joey refused: a scheduled run sends at most ONE message to Joey .*handoff_main/)
  expect(sent.length - s0).toBe(1)
  expect(tok.asked).toBeFalsy()
})

test('L6B3: ask_joey, then notify_joey in the same scheduled run: the notify is refused', async () => {
  const tok = run('scheduled'), s0 = sent.length
  const out = await L.callLaneTool(tok, 'ask_joey', { text: '備份 11-13 失敗：403，要重跑嗎？' })
  expect(sent.length - s0).toBe(1); expect(out).not.toMatch(/refused/)
  await expect(L.callLaneTool(tok, 'notify_joey', { text: '備份失敗，已問 Joey。' })).rejects.toThrow(/at most ONE message to Joey and this run already sent it with ask_joey/)
  expect(sent.length - s0).toBe(1)
  expect(notifies().filter(r => r.event === tok.evId).length).toBe(1)
})

test('L6B3: a run that is not scheduled may still notify and then ask (the gate is the scheduled run\'s)', async () => {
  const tok = run('peer'), s0 = sent.length
  await L.callLaneTool(tok, 'notify_joey', { text: 'Eve 問維護時段，我先回她週五。' })
  const out = await L.callLaneTool(tok, 'ask_joey', { text: 'Eve 要改到週四，可以嗎？' })
  expect(out).not.toMatch(/refused/)
  expect(sent.length - s0).toBe(2)
})
