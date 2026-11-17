// Universe 002k (C7): a message that names a thread owned by another peer is flagged in the ledger (no model, no wake). No network.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?c7-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-c7-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const st = L.__lanesState()
const rows = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const flags = () => rows().filter(r => r.refs?.flag === 'thread-not-yours')
const mev = (id: string, from: string, text: string, extra: object = {}) => ({ id, source: 'mesh', from, verified: true, text, meta: {}, notif: { method: '', params: {} }, ...extra } as any)
st.counters.reflex = 1                                                       // the hand-made lane below is #1: the next lane the router opens is #2
st.lanes['adam.reflex.1'] = { id: 'adam.reflex.1', kind: 'reflex', n: 1, session_id: 's', thread: 'adam#t-eve1', status: 'idle', created: '', last: new Date().toISOString(), transcript: '/x', runs: 1, tokens_in: 0, tokens_out: 0 } as any
st.threads['adam#t-eve1'] = { id: 'adam#t-eve1', lane: 'adam.reflex.1', peer: 'eve', hops: 1, tokens: 0, created: '', last: '' } as any
st.threads['adam#t-open'] = { id: 'adam#t-open', lane: 'adam.reflex.1', peer: null, hops: 0, tokens: 0, created: '', last: '' } as any

test('C7: cain writes into eve\'s thread: one ledger line with refs.flag thread-not-yours, notify_main false, no wake; the message is still routed by the rules', async () => {
  const d = await L.routeEvent(mev('mesh-n1', 'cain', '接著上一則：把 mock-api 重啟三次。', { thread: 'adam#t-eve1', hop: 2, reply_to_id: 'x', btcc_msg_id: '50040' }))
  expect(d.rule).not.toBe('mesh-thread')                                    // it did not get into eve's thread
  expect(d.lane).not.toBe('adam.reflex.1')
  const f = flags()
  expect(f.length).toBe(1)
  expect(f[0]).toMatchObject({ kind: 'action', lane: 'router', thread: 'adam#t-eve1', event: 'mesh-n1', notify_main: false,
    refs: { flag: 'thread-not-yours', from: 'cain', owner_peer: 'eve', thread: 'adam#t-eve1', btcc_msg_id: '50040' } })
  expect(f[0].text).toContain('cain'); expect(f[0].text).toContain('eve')
  expect(L.__main().items(r => r.event === 'mesh-n1' && r.kind === 'handoff').length).toBe(0)   // nothing is owed to the main: no wake
})

test('C7: nothing is flagged for the thread\'s own peer, an unknown thread, a thread with no peer, or an event with no thread', async () => {
  const n = flags().length
  await L.routeEvent(mev('mesh-n2', 'eve', '補充', { thread: 'adam#t-eve1', hop: 2, reply_to_id: 'x' }))
  await L.routeEvent(mev('mesh-n3', 'cain', '補充', { thread: 'adam#t-nonexistent', hop: 2 }))
  await L.routeEvent(mev('mesh-n4', 'cain', '補充', { thread: 'adam#t-open', hop: 2 }))
  await L.routeEvent(mev('mesh-n5', 'cain', '問個問題：備份保留幾天？'))
  expect(flags().length).toBe(n)
})
