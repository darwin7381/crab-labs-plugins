// Universe 002k (C2): a lane run triggered by a Joey message that sends reply_agent to a peer leaves a commitment (owner relay). No network, no model.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?c2-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-c2-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
const mesh: any[] = []
L.__setMeshSend(async b => { mesh.push(b); return { text: 'sent', msgId: 80000 + mesh.length, delivered: true } })
const st = L.__lanesState()
const rows = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
let n = 0
function run(trigger: string, source: 'telegram' | 'mesh' = 'mesh', cls = trigger): any {
  n += 1
  const id = `adam.reflex.${n}`, evId = `ev-c2-${n}`
  st.lanes[id] = { id, kind: 'reflex', n, session_id: 's', thread: `adam#t-c2${n}`, status: 'running', created: '', last: '', transcript: '/x', runs: 0, tokens_in: 0, tokens_out: 0 } as any
  st.threads[`adam#t-c2${n}`] = { id: `adam#t-c2${n}`, lane: id, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
  L.__putQueue({ ev: { id: evId, source, from: source === 'telegram' ? 'joey' : 'eve', text: 'x', meta: {}, notif: { method: '', params: {} } }, lane: id, state: 'leased', lease_until: 0, attempts: 1, priority: 1, enqueued: '' })
  return { runId: `${id}.r1`, lane: id, evId, closers: [], critical: false, trigger, cls, escalated: false, pushed: false }
}
const cms = () => rows().filter(r => r.kind === 'commitment')

test('C2: Joey said "tell Eve": reply_agent to Eve leaves a commitment (who = Eve, what = the sent text, owner-relay, auto)', async () => {
  const tok = run('joey', 'telegram')
  const text = '週五前會把 /v2/orders/bulk 做好，Joey 已經答應。'
  expect(await L.callLaneTool(tok, 'reply_agent', { line: 'call', because: 'test (the call line)', to: 'eve', text })).toBe('sent')
  expect(cms().length).toBe(1)
  expect(cms()[0]).toMatchObject({ kind: 'commitment', lane: tok.lane, thread: `adam#t-c2${n}`, event: tok.evId,
    refs: { who: 'eve', what: text, from: 'owner-relay', auto: true, btcc_msg_id: 80001 } })
  expect(cms()[0].refs.by).toContain('週五'); expect(cms()[0].text).toContain('答應 eve')
  expect(L.__events().get(tok.evId)!.promised).toMatchObject([{ text: cms()[0].text, by: tok.lane, to: 'eve', thread: `adam#t-c2${n}` }])   // PL1, 002x: the promise record on the event (the digest shows it)
})

test('C2: not when the lane already wrote a commitment in that run (its own call, or a receipt promise); not when the run was not Joey\'s', async () => {
  const own = run('joey', 'telegram')
  await L.callLaneTool(own, 'commitment', { who: 'eve', what: '週五前給規格', by: '週五前' })
  await L.callLaneTool(own, 'reply_agent', { line: 'call', because: 'test (the call line)', to: 'eve', text: '我週五前給你規格。' })
  expect(cms().filter(r => r.event === own.evId).length).toBe(1)                                // only the lane's own
  expect(cms().find(r => r.event === own.evId)!.refs.from).toBeUndefined()
  const peer = run('peer', 'mesh')
  await L.callLaneTool(peer, 'reply_agent', { line: 'call', because: 'test (the call line)', to: 'cain', text: '明天會給你。' })
  const sched = run('scheduled', 'mesh')
  await L.callLaneTool(sched, 'reply_agent', { line: 'call', because: 'test (the call line)', to: 'cain', text: '備份已完成。' })
  expect(cms().filter(r => r.event === peer.evId || r.event === sched.evId).length).toBe(0)
})

test('C2: a Joey-quoted or worker-topic run (trigger joey) counts; one relay is one commitment even with a second reply; the receipt does not add another', async () => {
  const tok = run('joey', 'telegram')
  await L.callLaneTool(tok, 'reply_agent', { line: 'call', because: 'test (the call line)', to: 'cain', text: '請你明天 10:00 前把樣本給我。' })
  await L.callLaneTool(tok, 'reply_agent', { line: 'call', because: 'test (the call line)', to: 'cain', text: '補充：格式用 csv。' })
  await L.callLaneTool(tok, 'receipt', { outcome: 'done', happened: 'Joey 要我轉達 cain', did: '已轉達 cain', promised: '明天 10:00 前收樣本', needs_main: '無' })
  expect(cms().filter(r => r.event === tok.evId).length).toBe(1)
  expect(cms().find(r => r.event === tok.evId)!.refs.who).toBe('cain')
})

test('C2: a send that failed leaves no commitment', async () => {
  L.__setMeshSend(async () => null as any)
  const tok = run('joey', 'telegram')
  expect(await L.callLaneTool(tok, 'reply_agent', { line: 'call', because: 'test (the call line)', to: 'eve', text: '週五給你。' })).toContain('send failed')
  expect(cms().filter(r => r.event === tok.evId).length).toBe(0)
})
