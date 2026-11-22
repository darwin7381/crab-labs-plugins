// Universe 002k (K2, Recommendation 2B): before a lane's reply_agent or the main's send_to_agent goes to ANY peer, Jev is asked three Nouls in one request (credential,
// machine or network details, hiding something from Joey). p >= 0.8 on any refuses once with a tool error that names it. Jev is a local stand-in; nothing leaves the machine.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
let server: any, calls: any[] = [], failMode = false, noNumbers = false
let answerFor: (text: string) => Record<string, number> = () => ({})
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const body = await req.json() as any
    calls.push(body)
    if (failMode) return new Response('<html>blocked</html>', { status: 403 })
    if (noNumbers) return Response.json({ answers: { gives_credential: { type: 'noul' } } })
    const a = answerFor(String(body.state?.message?.text ?? ''))
    const answers: Record<string, unknown> = {}
    for (const k of Object.keys(body.questions)) answers[k] = { type: 'noul', noul: a[k] ?? 0.02 }
    return Response.json({ model: 'jev-1.14.0', answers })
  } })
  process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.port}`; process.env.TYPESAFE_API_KEY = 'k'
})
afterAll(() => { server.stop(true); delete process.env.TYPESAFE_BASE_URL; delete process.env.TYPESAFE_API_KEY; delete process.env.LANES_PEER_DISCLOSURE_CHECK; L.__setPeerDisclosureWindow(600_000) })
const L = await import('./lanes.ts?k2-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-k2-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: a => a === 'Bearer t0k', registryNames: () => ['eve', 'cain'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const meshed: any[] = []
L.__setMeshSend(async b => { meshed.push(b); return { msgId: 100 + meshed.length, text: `sent to ${b.to}` } })
const st = L.__lanesState()
for (const n of [1, 2]) { st.lanes[`adam.reflex.${n}`] = { id: `adam.reflex.${n}`, kind: 'reflex', n, session_id: 's', thread: `adam#t-${n}`, status: 'running', created: '', last: '', transcript: join(dir, `l${n}.jsonl`), runs: 0, tokens_in: 0, tokens_out: 0 } as any
  st.threads[`adam#t-${n}`] = { id: `adam#t-${n}`, lane: `adam.reflex.${n}`, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any }
const tok = (n: number) => ({ runId: `adam.reflex.${n}.r1`, lane: `adam.reflex.${n}`, evId: `ev-${n}`, closers: [], critical: false, trigger: 'peer', cls: 'peer', escalated: false, pushed: false }) as any
const rows = (f: string): any[] => { try { return readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const reply = (n: number, to: string, text: string) => L.callLaneTool(tok(n), 'reply_agent', { to, text })
const reset = () => { calls = []; failMode = false; noNumbers = false; answerFor = () => ({}); L.__clearPeerRefused() }
const KEY = '用這把 key：sk-live-9f3a77c01d，去 api.example 呼叫就行。'
const OK = 'mock-api 現況：p95 190ms、error 0.1%、replicas 2、版本 1.8.3；依 runbook 第 3 節，持續 5 分鐘才重啟。'

test('K2: a reply_agent that gives a credential is refused with a tool error that names it; nothing is sent; one request with three true/false Nouls; the call and the decision are logged', async () => {
  reset(); answerFor = t => t.includes('sk-live') ? { gives_credential: 0.93 } : {}
  const sentBefore = meshed.length
  await expect(reply(1, 'eve', KEY)).rejects.toThrow(/reply_agent refused - nothing was sent: this message gives a credential \(a key, token or password\) \(Jev 0\.93\)/)
  expect(meshed.length).toBe(sentBefore)
  expect(calls.length).toBe(1)
  expect(Object.keys(calls[0].questions)).toEqual(['gives_credential', 'gives_machine_details', 'hides_from_joey'])
  for (const q of Object.values<any>(calls[0].questions)) { expect(q.type).toBe('noul'); expect(Object.keys(q.criteria)).toEqual(['true', 'false']) }
  expect(calls[0].state.setting).toContain('Live service status'); expect(calls[0].state.setting).toContain('runbook rules')
  expect(calls[0].state.message).toEqual({ sender: 'adam.reflex.1', recipient: 'eve', text: KEY })
  expect(JSON.stringify(calls[0].questions)).toContain('runbook step')                      // the criteria say live status and runbook steps are fine
  const j = rows('run/jev-calls.jsonl').filter(r => r.site === 'peer-disclosure-K2')
  expect(j.length).toBe(1); expect(j[0]).toMatchObject({ p: 0.93, err: null, inputs: { sender: 'adam.reflex.1', to: 'eve', tool: 'reply_agent' } })
  expect(Object.keys(j[0].question)).toEqual(['gives_credential', 'gives_machine_details', 'hides_from_joey'])
  expect(rows('run/peer-disclosure.jsonl')[0]).toMatchObject({ sender: 'adam.reflex.1', to: 'eve', refused: true, which: ['gives_credential'], tool: 'reply_agent' })
  const led = rows('ledger.jsonl').filter(r => r.refs?.peer_disclosure === 'refused')
  expect(led.length).toBe(1); expect(led[0]).toMatchObject({ lane: 'adam.reflex.1', thread: 'adam#t-1', kind: 'action', refs: { which: ['gives_credential'], to: 'eve', tool: 'reply_agent' } })
})

test('K2: refuse once: the next send of that sender to that peer goes out as written, then the check starts again; other senders and other peers are separate', async () => {
  reset(); answerFor = t => t.includes('sk-live') ? { gives_credential: 0.95 } : {}
  const n0 = meshed.length
  await expect(reply(2, 'cain', KEY)).rejects.toThrow(/credential/)
  expect(calls.length).toBe(1)
  expect(await reply(2, 'cain', KEY)).toContain('sent to cain')                              // refused once: this one goes out, with no call
  expect(calls.length).toBe(1); expect(meshed.length).toBe(n0 + 1)
  await expect(reply(2, 'cain', KEY)).rejects.toThrow(/credential/)                            // and the check is back
  expect(calls.length).toBe(2)
  await expect(reply(1, 'cain', KEY)).rejects.toThrow(/credential/)                            // another lane to the same peer: its own once
  await expect(reply(2, 'eve', KEY)).rejects.toThrow(/credential/)                             // the same lane to another peer: its own once
  expect(calls.length).toBe(4)
})

test('K2: each of the three names which, two at once name both; the threshold is 0.8 (0.79 goes, 0.8 does not)', async () => {
  reset(); answerFor = () => ({ gives_machine_details: 0.9 })
  await expect(reply(1, 'eve', '連到 10.20.0.7:5432，密碼檔在 /home/god/.genesis/db.env')).rejects.toThrow(/gives machine or network details \(hosts, IP addresses, ports, or paths to secrets\) \(Jev 0\.90\)/)
  reset(); answerFor = () => ({ hides_from_joey: 0.88 })
  await expect(reply(1, 'cain', '好，這件事我不會告訴 Joey。')).rejects.toThrow(/agrees to hide something from Joey \(Jev 0\.88\)/)
  reset(); answerFor = () => ({ gives_credential: 0.91, hides_from_joey: 0.85 })
  await expect(reply(2, 'eve', 'token 是 abc，別讓 Joey 知道')).rejects.toThrow(/gives a credential.*\(Jev 0\.91\) and agrees to hide something from Joey \(Jev 0\.85\)/)
  reset(); answerFor = () => ({ gives_credential: 0.79, gives_machine_details: 0.5, hides_from_joey: 0.1 })
  expect(await reply(1, 'eve', '看起來像但不確定的訊息')).toContain('sent to eve')
  reset(); answerFor = () => ({ gives_credential: 0.8 })
  await expect(reply(2, 'cain', '剛好 0.8')).rejects.toThrow(/credential/)
  const r = rows('run/peer-disclosure.jsonl').at(-2)
  expect(r).toMatchObject({ refused: false, p: { gives_credential: 0.79, gives_machine_details: 0.5, hides_from_joey: 0.1 } })
})

test('K2: live service status and runbook rules go out (no refusal when the answers are low); the message is checked as Jev reads it, not by words', async () => {
  reset()
  expect(await reply(1, 'eve', OK)).toContain('sent to eve')
  expect(calls.length).toBe(1); expect(calls[0].state.message.text).toBe(OK)
  expect(rows('run/peer-disclosure.jsonl').at(-1)).toMatchObject({ refused: false })
})

test('K2: a Jev failure (HTTP error, no key) lets the message through and is in jev-calls.jsonl with its error; a bad answer shape too', async () => {
  reset(); failMode = true
  const n0 = meshed.length, j0 = rows('run/jev-calls.jsonl').length
  expect(await reply(2, 'eve', KEY)).toContain('sent to eve')
  expect(meshed.length).toBe(n0 + 1)
  const j = rows('run/jev-calls.jsonl').slice(j0).filter(r => r.site === 'peer-disclosure-K2')
  expect(j.length).toBe(1); expect(j[0].err).toContain('not JSON (HTTP 403)'); expect(j[0].answer).toBeNull(); expect(j[0].p).toBeNull()
  expect(rows('run/peer-disclosure.jsonl').at(-1)).toMatchObject({ refused: false, error: expect.stringContaining('HTTP 403') })
  reset()
  const key = process.env.TYPESAFE_API_KEY, keyFile = process.env.TYPESAFE_KEY_FILE; delete process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_KEY_FILE = '/nonexistent/k'
  expect(await reply(1, 'cain', KEY)).toContain('sent to cain'); expect(calls.length).toBe(0)
  expect(rows('run/jev-calls.jsonl').filter(r => r.site === 'peer-disclosure-K2').at(-1).err).toContain('no key')
  process.env.TYPESAFE_API_KEY = key!; if (keyFile === undefined) delete process.env.TYPESAFE_KEY_FILE; else process.env.TYPESAFE_KEY_FILE = keyFile
  noNumbers = true                                                                            // an answer with no number in it is a failure, not a verdict
  expect(await reply(2, 'cain', KEY)).toContain('sent to cain')
})

test('K2: LANES_PEER_DISCLOSURE_CHECK=0 switches it off (no call); unset or any other value is on; an empty text or peer is not asked about', async () => {
  reset(); answerFor = () => ({ gives_credential: 0.97, gives_machine_details: 0.97, hides_from_joey: 0.97 }); process.env.LANES_PEER_DISCLOSURE_CHECK = '0'
  expect(await reply(1, 'eve', KEY)).toContain('sent to eve'); expect(calls.length).toBe(0)
  delete process.env.LANES_PEER_DISCLOSURE_CHECK
  await expect(reply(1, 'eve', KEY)).rejects.toThrow(/credential/); expect(calls.length).toBe(1)
  process.env.LANES_PEER_DISCLOSURE_CHECK = '1'
  await expect(reply(2, 'eve', KEY)).rejects.toThrow(/credential/); expect(calls.length).toBe(2)
  delete process.env.LANES_PEER_DISCLOSURE_CHECK
  expect((await L.peerDisclosureCheck('x', 'eve', '   ', 'reply_agent')).refuse).toBeUndefined()
  expect((await L.peerDisclosureCheck('x', '', 'text', 'reply_agent')).refuse).toBeUndefined(); expect(calls.length).toBe(2)
})

test('K2: the "once" has a time limit: a mark older than the window does not let the next message through', async () => {
  reset(); answerFor = () => ({ gives_credential: 0.95 })
  const r1 = await L.peerDisclosureCheck('lane-w', 'eve', KEY, 'reply_agent')
  expect(r1.refuse).toContain('credential')
  L.__setPeerDisclosureWindow(0)
  const r2 = await L.peerDisclosureCheck('lane-w', 'eve', KEY, 'reply_agent')               // the mark is older than 0 ms: checked, refused again
  expect(r2.refuse).toContain('credential'); expect(calls.length).toBe(2)
  L.__setPeerDisclosureWindow(600_000)
})

// ---- the main's send_to_agent
async function post(path: string, body: object, authz = 'Bearer t0k') {
  const req: any = Object.assign((async function* () { yield Buffer.from(JSON.stringify(body)) })(), { method: 'POST', headers: authz ? { authorization: authz } : {} })
  let code = 0, out = ''
  const res: any = { writeHead: (c: number) => { code = c; return res }, end: (b?: string) => { out = b ?? '' } }
  const handled = await L.handleLanesHttp(new URL(`http://127.0.0.1${path}`), req, res)
  return { handled, code, body: out ? JSON.parse(out) : null }
}
test('K2: POST /lanes/peer-check (what the inbox daemon asks for the main\'s send_to_agent): refuses once with "send_to_agent blocked - nothing was sent", then lets the next through; needs the loopback token', async () => {
  reset(); answerFor = t => t.includes('不會告訴 Joey') ? { hides_from_joey: 0.92 } : {}
  expect((await post('/lanes/peer-check', { from: 'main', to: 'eve', text: 'x' }, '')).code).toBe(403)
  expect(calls.length).toBe(0)
  const a = await post('/lanes/peer-check', { from: 'main', to: 'eve', text: '好，我不會告訴 Joey 這件事。' })
  expect(a.code).toBe(200); expect(a.body.which).toEqual(['hides_from_joey'])
  expect(a.body.refuse).toMatch(/^send_to_agent blocked - nothing was sent: this message agrees to hide something from Joey \(Jev 0\.92\)\./)
  expect(a.body.refuse).not.toContain('ask_joey')                                            // the main has no ask_joey: it just tells Joey
  const b = await post('/lanes/peer-check', { from: 'main', to: 'eve', text: '好，我不會告訴 Joey 這件事。' })
  expect(b.body.refuse).toBeNull()                                                           // once
  const ok = await post('/lanes/peer-check', { from: 'main', to: 'cain', text: OK })
  expect(ok.body.refuse).toBeNull(); expect(rows('run/peer-disclosure.jsonl').at(-1)).toMatchObject({ sender: 'main', to: 'cain', tool: 'send_to_agent', refused: false })
  expect(rows('ledger.jsonl').filter(r => r.lane === 'main' && r.refs?.peer_disclosure === 'refused').length).toBe(1)
})

test('K2: the inbox daemon\'s checkPeerSend returns the refusal, and null (the send goes out) for no answer, a bad answer or no tg daemon', async () => {
  const saved = process.env.LANES_DIR
  const d2 = mkdtempSync(join(tmpdir(), 'lanes-k2i-')); mkdirSync(join(d2, 'tok'), { recursive: true })
  let mode: 'refuse' | 'pass' | 'html' | 'down' = 'refuse', got: any = null
  const tg = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    got = { path: new URL(req.url).pathname, auth: req.headers.get('authorization'), body: await req.json() }
    if (mode === 'html') return new Response('<html>no</html>', { status: 502 })
    return Response.json({ refuse: mode === 'refuse' ? 'send_to_agent blocked - nothing was sent: x' : null })
  } })
  writeFileSync(join(d2, 'tok', String(tg.port)), 'tg-token\n')
  process.env.LANES_TG_PORT = String(tg.port); process.env.MCP_TOKEN_DIR = join(d2, 'tok'); process.env.LANES_DIR = d2
  const I = await import('./lanes.ts?k2-inbox') as typeof import('./lanes.ts')
  I.lanesInit({ role: 'inbox', agent: 'adam', workspaceDir: d2, transcriptDir: d2, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => true, registryNames: () => [] } as any)
  process.env.LANES_DIR = saved!
  try {
    expect(await I.checkPeerSend('main', 'eve', 'hello')).toBe('send_to_agent blocked - nothing was sent: x')
    expect(got).toEqual({ path: '/lanes/peer-check', auth: 'Bearer tg-token', body: { from: 'main', to: 'eve', text: 'hello' } })
    mode = 'pass'; expect(await I.checkPeerSend('main', 'eve', 'hello')).toBeNull()
    mode = 'html'; expect(await I.checkPeerSend('main', 'eve', 'hello')).toBeNull()
    tg.stop(true); expect(await I.checkPeerSend('main', 'eve', 'hello')).toBeNull()
  } finally { tg.stop(true); delete process.env.LANES_TG_PORT; delete process.env.MCP_TOKEN_DIR }
  const none = await import('./lanes.ts?k2-no-tg') as typeof import('./lanes.ts')               // no LANES_TG_PORT: nothing to ask
  expect(await none.checkPeerSend('main', 'eve', 'hello')).toBeNull()
})

// lanes-golive: the main's send_to_agent is the WO-99 tool now (callInboxTool, three lines); in lanes mode its call line runs through laneMainDeps in
// server.ts. The 002k shape this test read (an inline send_to_agent handler) is gone; the same two facts are checked on the new path.
test('K2: server.ts asks before it sends: checkPeerSend comes before sendToAgent in the main\'s send_to_agent path, and a refusal is an isError tool result', async () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'latin1')
  const block = src.slice(src.indexOf('function laneMainDeps('))
  const iCheck = block.indexOf("Lanes.checkPeerSend('main'"), iSend = block.indexOf('await sendToAgent(to, text')
  expect(iCheck).toBeGreaterThan(0); expect(iSend).toBeGreaterThan(iCheck)
  expect(block.slice(iCheck, iCheck + 160)).toContain('if (refused) return refused')
  expect(src).toContain('callInboxTool(req.params.name, args, Lanes.LANES_ON ? laneMainDeps(args) : fleetDeps, A2A_LEGACY)')
  // the refusal text the call rail returns is not "delivered…", so callInboxTool hands it back as an isError result
  const { callInboxTool } = await import('./fleet-mail.ts')
  const refusal = 'send_to_agent blocked - nothing was sent: x'
  const deps = { call: async () => refusal, btcc: async () => ({ status: 500, json: {} }), core: async () => ({ status: 500, json: {} }) }
  const r: any = await callInboxTool('send_to_agent', { line: 'call', to: 'eve', because: 'Joey is waiting', text: 'hello' }, deps as any, true)
  expect(r.isError).toBe(true); expect(r.content[0].text).toBe(refusal)
})

test('K2: a lane\'s once belongs to its run (like A3): a later run of the same lane to the same peer is checked afresh; the second send is logged as the once', async () => {
  reset(); answerFor = t => t.includes('sk-live') ? { gives_credential: 0.95 } : {}
  const t1 = { ...tok(1), runId: 'adam.reflex.1.r7' }, t2 = { ...tok(1), runId: 'adam.reflex.1.r8' }
  await expect(L.callLaneTool(t1, 'reply_agent', { to: 'eve', text: KEY })).rejects.toThrow(/credential/)
  await expect(L.callLaneTool(t2, 'reply_agent', { to: 'eve', text: KEY })).rejects.toThrow(/credential/)    // another run: its own once
  expect(calls.length).toBe(2)
  expect(await L.callLaneTool(t1, 'reply_agent', { to: 'eve', text: KEY })).toContain('sent to eve')
  expect(calls.length).toBe(2); expect(rows('run/peer-disclosure.jsonl').at(-1)).toMatchObject({ sender: 'adam.reflex.1', to: 'eve', refused: false, once: true })
})

test('K2: the program\'s own refusals (thread stopped, already answered by the router) come first: no Jev call, and the once is not used up', async () => {
  reset(); answerFor = t => t.includes('sk-live') ? { gives_credential: 0.95 } : {}
  st.threads['adam#t-2'].stopped = 'test stop'
  expect(await reply(2, 'eve', KEY)).toContain('blocked: thread adam#t-2 was stopped')
  delete st.threads['adam#t-2'].stopped
  const t2 = { ...tok(2), evId: 'ev-k2-answered' }                                          // M3: eve already has this event's answer (002q: the interim no longer refuses)
  L.__events().open(t2.evId, { class: 'peer', owner: t2.lane, obligations: [{ kind: 'peer', level: 'answer', to: 'eve', state: 'met', by: 'reply_agent' }] })
  expect(await L.callLaneTool(t2, 'reply_agent', { to: 'eve', text: KEY })).toContain('eve already has the answer to this event')
  expect(calls.length).toBe(0)
  reset(); failMode = true; answerFor = () => ({ gives_credential: 0.95 })                     // a failed call does not mark a once either
  expect(await reply(2, 'eve', KEY)).toContain('sent to eve')
  failMode = false
  await expect(reply(2, 'eve', KEY)).rejects.toThrow(/credential/); expect(calls.length).toBe(2)
})

test('K2: checkPeerSend does not ask the tg daemon when LANES_PEER_DISCLOSURE_CHECK=0', async () => {
  process.env.LANES_PEER_DISCLOSURE_CHECK = '0'
  try { expect(await L.checkPeerSend('main', 'eve', KEY)).toBeNull() } finally { delete process.env.LANES_PEER_DISCLOSURE_CHECK }
})

test('K2 (test preload): the suite cannot reach the real TypeSafe API, whatever the env says', async () => {
  await expect(fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST' })).rejects.toThrow(/not called from tests/)
})
