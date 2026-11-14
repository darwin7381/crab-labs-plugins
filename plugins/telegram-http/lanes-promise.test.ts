// Universe 002j, problem 24: a request only the main can agree to.
// The lane hands it to the main; the ROUTER tells the waiting agent, in fixed words, who decides and by when; the lane sends
// that agent nothing more about it; the time is kept as a promise (kept when the main sends that agent a message, told to
// Joey once when it runs out). No network, no daemon, no lane process.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?promise-test') as typeof import('./lanes.ts')

const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-promise-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const sent: string[] = [], mesh: any[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'],
  sendBot: async (_c: string, text: string) => { sent.push(text); return 5000 + sent.length }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
L.__setMeshSend(async b => { mesh.push(b); return { text: 'sent', msgId: 60000 + mesh.length, delivered: true } })
const rows = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
let n = 0
function run(from: string, cls: string, text: string, btcc?: string): any {
  n += 1
  const id = `adam.reflex.${n}`, evId = `ev-p${n}`
  L.__lanesState().lanes[id] = { id, kind: 'reflex', n, session_id: 's', thread: `adam#t-p${n}`, status: 'running', created: '', last: '', transcript: '/x', runs: 0, tokens_in: 0, tokens_out: 0 } as any
  L.__putQueue({ ev: { id: evId, source: 'mesh', from, text, meta: {}, notif: { method: '', params: {} }, btcc_msg_id: btcc }, lane: id, state: 'leased', lease_until: 0, attempts: 1, priority: 1, enqueued: '' })
  return { runId: `${id}.r1`, lane: id, evId, closers: [], critical: false, trigger: cls, cls, escalated: false, pushed: false }
}
const ASK = '可以答應我明天中午前給我上週的工單分類統計嗎？我要排進週報，需要你明確答應或拒絕。'

test('a peer\'s request handed to the main: the router tells the peer who decides and by when, in fixed words, as a reply to its message', async () => {
  const tok = run('eve', 'peer', ASK, '50008')
  const out = await L.callLaneTool(tok, 'handoff_main', { text: 'Eve（mesh 50008）要我們答應明天中午前給上週工單分類統計；我不能代表 adam 答應。' })
  expect(out).toContain('handed to the main'); expect(out).toContain('The router told eve'); expect(out).toContain('nothing more')
  expect(mesh.length).toBe(1)
  expect(mesh[0]).toMatchObject({ to: 'eve', reply_to: '50008', thread: 'adam#t-p1', lane: 'adam.reflex.1' })
  expect(mesh[0].text).toContain('要 adam 的主線決定'); expect(mesh[0].text).toContain('不能代為答應或拒絕'); expect(mesh[0].text).toMatch(/主線會在 .+ 前直接回你/)
  const pr = Object.values(L.__lanesState().promises)
  expect(pr.length).toBe(1); expect(pr[0]).toMatchObject({ peer: 'eve', state: 'open', event: 'ev-p1' })
  expect(Math.round((pr[0].due - pr[0].created) / 60_000)).toBe(30)
  const c = rows().find(r => r.kind === 'commitment')!
  expect(c.refs).toMatchObject({ who: 'eve', from: 'handoff-interim', promise: pr[0].id, btcc_msg_id: 60001 })
  expect(c.notify_main).toBe(true)                                                       // the main reads the deadline in the digest that wakes it
  expect(c.text).toContain('分流器已經替車道回覆 eve'); expect(c.text).toContain('主線會在')            // and what the other agent was already told
  expect(sent.length).toBe(0)                                                            // Joey hears nothing: the main owns it
  // the lane's own second message to the same agent is not sent; another agent is unaffected
  expect(await L.callLaneTool(tok, 'reply_agent', { to: 'eve', text: '我再看看能不能幫你問' })).toContain('not sent')
  expect(mesh.length).toBe(1)
  expect(await L.callLaneTool(tok, 'reply_agent', { to: 'cain', text: '上週工單分類你那邊有現成的嗎？' })).toBe('sent')
  expect(mesh.length).toBe(2)
})

test('nobody is waiting for a scheduled run or a no-reply message: no interim message, no promise', async () => {
  const before = mesh.length
  const out = await L.callLaneTool(run('scheduler', 'scheduler', '[scheduled][daily-ticket-digest][run:12][normal][ops] 每日工單摘要'), 'handoff_main', { text: '摘要要主線手上的脈絡' })
  expect(out).toContain('handed to the main'); expect(out).not.toContain('The router told')
  const tok = run('eve', 'peer', '只是讓你知道，不用回', '50020'); (L as any).__putQueue({ ...{ ev: { id: tok.evId, source: 'mesh', from: 'eve', text: 'x', meta: {}, notif: { method: '', params: {} }, btcc_msg_id: '50020', no_reply: true }, lane: tok.lane, state: 'leased', lease_until: 0, attempts: 1, priority: 1, enqueued: '' } })
  expect(await L.callLaneTool(tok, 'handoff_main', { text: 'FYI 但要主線看' })).not.toContain('The router told')
  expect(mesh.length).toBe(before)
  expect(Object.values(L.__lanesState().promises).length).toBe(1)
})

test('the promise is kept when the main sends that agent a message', () => {
  L.promiseTick()
  expect(sent.length).toBe(0)                                                            // not due yet
  L.mainSentTo('eve', 'adam#t-p1')
  const pr = Object.values(L.__lanesState().promises)[0]
  expect(pr).toMatchObject({ state: 'kept', matched: 'thread' })
  expect(rows().some(r => r.kind === 'fyi' && String(r.text).includes('主線已回覆 eve'))).toBe(true)
  pr.due = Date.now() - 1; L.promiseTick()
  expect(sent.length).toBe(0)                                                            // a kept promise never rings
})

test('when the time comes and the main has sent nothing: Joey is told once, the main sees it in its digest; a late answer is recorded as late', async () => {
  L.__setPromiseMin(0)
  const tok = run('cain', 'peer', '可以答應我週五前把 mock-api 的維護時段改到週日嗎？', '50031')
  await L.callLaneTool(tok, 'handoff_main', { text: 'Cain（mesh 50031）要我們答應把維護時段改到週日；這是 adam 要決定的事。' })
  await sleep(5)
  L.promiseTick(); await sleep(30)
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('cain 在等主線回覆'); expect(sent[0]).toContain('主線還沒有回 cain'); expect(sent[0]).toContain('維護時段')
  const over = rows().filter(r => r.refs?.tier_rule === 'promise-overdue')
  expect(over.length).toBe(1); expect(over[0].notify_main).toBe(true)
  L.promiseTick(); await sleep(30)
  expect(sent.length).toBe(1)                                                            // once
  const pr = Object.values(L.__lanesState().promises).find(p => p.peer === 'cain')!
  await L.mainSentTo('CAIN', null)                                                       // 002k (C4): no thread, no reply_to, no text: it answers nothing in particular
  expect(pr.state).toBe('overdue')
  await L.mainSentTo('CAIN', pr.thread)
  expect(pr).toMatchObject({ state: 'kept', matched: 'thread' })
  expect(rows().some(r => r.kind === 'fyi' && String(r.text).includes('過了時間才回'))).toBe(true)
  L.__setPromiseMin(30)
})
