// codex-runner (WO-184 part 2): Chiron's done criteria 2–6 as far as fakes allow, against a fake Onsen (Bun.serve) and a fake codex (fake-codex.ts).
// [2] a Call: accepted → running → completed, its attachment downloaded and handed to codex with -i, the picture codex made uploaded and on the
//     result, the answer sent back to the caller (reply_to_id) carrying the new session's thread (codex#t-…);
// [3] Chiron's ruling (mesh 12527): a session belongs to a thread: the caller's reply_to of that answer (its daemon fills in the thread) resumes it,
//     as does a Call sent with that thread; two items of one session wait for each other;
// [4] a failing command → failed with the stderr tail; the 30-minute limit (short here) → SIGTERM, SIGKILL, failed;
// [5] five Calls at once with no thread (one caller, one conversation) → five sessions: three running, two left queued (no PUT) until a slot frees;
// [6] status: idle, running 「codex exec」, idle again, offline at a clean stop (each one a valid observation);
// Joey on the page (forms inbox say): the answer recorded in his conversation with its files, the delivery facts; restart: a run that went on is
// followed, one that is gone is settled; what is not work is acked and left alone; the credential never goes off Onsen's origin.
// No tmux anywhere. Run: bun test codex-runner/codex-runner.test.ts
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { CodexRunner, configFromEnv, madeBy, readEvents, safeName, snapshot, type Cfg } from './codex-runner.ts'
import { checkObservation } from '../test-fixtures/status-v1-check.ts'

const FAKE = join(import.meta.dir, 'fake-codex.ts')
const TOKEN = 'mesh_test_codex_runner'
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex')

type Put = { call: string; state: string; session_id?: string; result?: any; at: number }
class FakeOnsen {
  server: ReturnType<typeof Bun.serve>
  base: string
  inbox: any[] = []
  acked = 0
  forms: any[] = []
  formsAcked = new Set<number>()
  calls = new Map<string, { id: string; caller: string; state: string; number: number | null }>()
  puts: Put[] = []
  files = new Map<string, { name: string; mime: string; bytes: Buffer; by: string }>()
  idem = new Map<string, string>()
  sends: any[] = []
  records: any[] = []
  facts: any[] = []
  observations: any[] = []
  profiles: any[] = []
  unauthorized = 0
  messagesKnowAttachments = true
  fileSeq = 900
  constructor() {
    this.server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: req => this.handle(req) })
    this.base = `http://127.0.0.1:${this.server.port}/api/onsen`
  }
  stop(): void { this.server.stop(true) }
  call(id: string, caller: string, number: number | null): void { this.calls.set(id, { id, caller, state: 'queued', number }) }
  seq = 0
  push(item: Record<string, any>): void { this.inbox.push({ seq: ++this.seq, relay: null, kind: 'peer_call', refs: null, given: 1, ...item }) }
  file(id: string, name: string, bytes: Buffer, mime = 'image/png'): string { this.files.set(id, { name, mime, bytes, by: 'joey' }); return `${this.base}/v1/files/${id}` }
  statesOf(call: string): string[] { return this.puts.filter(p => p.call === call).map(p => p.state) }
  private j(status: number, body: unknown): Response { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }) }
  async handle(req: Request): Promise<Response> {
    const u = new URL(req.url), p = u.pathname.replace(/^\/api\/onsen/, ''), m = req.method
    if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) { this.unauthorized++; return this.j(401, { detail: 'a mesh credential is required' }) }
    if (m === 'GET' && p === '/inbox') {
      const after = Number(u.searchParams.get('after') ?? 0), wait = Number(u.searchParams.get('wait') ?? 0), lim = Number(u.searchParams.get('limit') ?? 100)
      const pick = () => this.inbox.filter(x => x.seq > after).slice(0, lim)
      let items = pick()
      if (!items.length && wait > 0) { await Bun.sleep(150); items = pick() }
      return this.j(200, { agent: 'codex', items, last_seq: this.seq, acked_seq: this.acked })
    }
    if (m === 'POST' && p === '/inbox/ack') { const b = await req.json() as any; this.acked = Math.max(this.acked, b.upto); return this.j(200, { acked: 1 }) }
    if (m === 'GET' && p === '/forms/inbox') {
      const pick = () => this.forms.filter(x => !this.formsAcked.has(x.id))
      let items = pick()
      if (!items.length) { await Bun.sleep(150); items = pick() }
      return this.j(200, { agent: 'codex', items })
    }
    if (m === 'POST' && p === '/forms/ack') { const b = await req.json() as any; for (const i of b.ids) this.formsAcked.add(i); return this.j(200, { acked: b.ids.length }) }
    let mm = /^\/v1\/calls\/([^/]+)$/.exec(p)
    if (m === 'GET' && mm) {
      const c = this.calls.get(mm[1]!)
      return c ? this.j(200, { data: { id: c.id, state: c.state, caller: c.caller, recipient: 'codex', number: c.number, conversation_id: `cv-${c.caller}` } }) : this.j(404, { error: { code: 'not_found' } })
    }
    if (m === 'GET' && p === '/v1/calls') {
      const n = u.searchParams.get('number'), caller = u.searchParams.get('caller')
      return this.j(200, { items: [...this.calls.values()].filter(c => (n == null || c.number === Number(n)) && (n != null || !caller || c.caller === caller))
        .map(c => ({ id: c.id, state: c.state, conversation_id: `cv-${c.caller}` })) })
    }
    mm = /^\/v1\/calls\/([^/]+)\/state$/.exec(p)
    if (m === 'PUT' && mm) {
      const c = this.calls.get(mm[1]!)
      if (!c) return this.j(404, { error: { code: 'not_found', message: 'no such call' } })
      const b = await req.json() as any
      const rank: Record<string, number> = { queued: 0, accepted: 1, running: 2, completed: 3, failed: 3, cancelled: 3 }
      if (b.state !== c.state && (rank[c.state]! >= 3 || rank[b.state]! < rank[c.state]!)) return this.j(400, { error: { code: 'invalid_request', message: `now ${c.state}` } })
      if (b.result?.attachment_file_ids?.some((id: string) => !this.files.has(id) || this.files.get(id)!.by !== 'codex')) return this.j(400, { error: { code: 'invalid_request', message: 'not yours' } })
      this.puts.push({ call: c.id, state: b.state, session_id: b.session_id, result: b.result, at: Date.now() })
      c.state = b.state
      return this.j(200, { data: { id: c.id, state: c.state } })
    }
    mm = /^\/v1\/messages\/([^/]+)$/.exec(p)
    if (m === 'GET' && mm) return this.j(200, { data: { id: mm[1], conversation_id: '4242' } })
    if (m === 'POST' && p === '/v1/files') {
      const key = req.headers.get('idempotency-key') ?? ''
      if (key && this.idem.has(key)) { const id = this.idem.get(key)!; return this.j(201, { data: { id, url: `${this.base}/v1/files/${id}` } }) }
      const id = String(++this.fileSeq)
      this.files.set(id, { name: decodeURIComponent(req.headers.get('x-file-name') ?? ''), mime: req.headers.get('content-type') ?? '', bytes: Buffer.from(await req.arrayBuffer()), by: 'codex' })
      if (key) this.idem.set(key, id)
      return this.j(201, { data: { id, url: `${this.base}/v1/files/${id}` } })
    }
    mm = /^\/v1\/files\/([^/]+)$/.exec(p)
    if (m === 'GET' && mm) { const f = this.files.get(mm[1]!); return f ? new Response(f.bytes, { headers: { 'Content-Type': f.mime } }) : this.j(404, {}) }
    if (m === 'POST' && p === '/send') { const b = await req.json() as any; this.sends.push(b); return this.j(200, { results: [{ to: b.to, seq: 1, duplicate: false, pulling: true }] }) }
    if (m === 'POST' && p === '/messages') {
      const b = await req.json() as any
      const dup = this.records.some(r => r.idem_key === b.idem_key)
      if (!dup) this.records.push(b)
      return this.j(200, { id: 5000 + this.records.length, duplicate: dup, ...(b.attachment_file_ids?.length && this.messagesKnowAttachments && !dup ? { attachments: b.attachment_file_ids.length } : {}) })
    }
    if (m === 'POST' && p === '/deliveries/batch') { const b = await req.json() as any; this.facts.push(...b.items); return this.j(200, { results: b.items.map((_: any, i: number) => ({ id: i })) }) }
    if (m === 'PUT' && p === '/v1/members/codex/observation') { this.observations.push(await req.json()); return this.j(200, { data: { name: 'codex' } }) }
    return this.j(404, { error: { code: 'not_found', message: `${m} ${p}` } })
  }
}

const tmps: string[] = []
const runners: CodexRunner[] = []
const onsens: FakeOnsen[] = []
afterEach(async () => {
  for (const r of runners.splice(0)) await r.stop({ offline: false })
  for (const o of onsens.splice(0)) o.stop()
  for (const d of tmps.splice(0)) {
    for (const f of [join(d, 'live')]) if (existsSync(f)) for (const pid of readdirSync(f)) { try { process.kill(Number(pid), 'SIGKILL') } catch {} }
    rmSync(d, { recursive: true, force: true })
  }
})
function setup(over: Partial<Cfg> = {}, o?: FakeOnsen): { onsen: FakeOnsen; cfg: Cfg; dir: string; log: string[]; codexLog: () => any[] } {
  const dir = mkdtempSync(join(tmpdir(), 'codex-runner-test-'))
  tmps.push(dir)
  const onsen = o ?? new FakeOnsen()
  if (!o) onsens.push(onsen)
  writeFileSync(join(dir, 'cred'), TOKEN + '\n', { mode: 0o600 })
  process.env.FAKE_CODEX_LOG = join(dir, 'codex.log')
  process.env.FAKE_CODEX_LIVE = join(dir, 'live')
  const log: string[] = []
  const cfg: Cfg = { ...configFromEnv({ HOME: dir }), base: onsen.base, credentialFile: join(dir, 'cred'), host: 'macmini', root: join(dir, 'onsen-codex'),
    stateDir: join(dir, 'onsen-codex', '.runner'), logFile: join(dir, 'runner.log'), codexBin: FAKE, waitS: 1, retryMs: 150, adoptPollMs: 100,
    lookupDelayMs: 200, heartbeatMs: 300, log: (l, m) => { log.push(`${l} ${m}`) }, ...over }
  const codexLog = (): any[] => { try { return readFileSync(join(dir, 'codex.log'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
  return { onsen, cfg, dir, log, codexLog }
}
function runner(cfg: Cfg): CodexRunner { const r = new CodexRunner(cfg); runners.push(r); return r }
async function until(cond: () => boolean, ms = 10_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await Bun.sleep(20) }
}
const done = (o: FakeOnsen, id: string) => () => ['completed', 'failed'].includes(o.calls.get(id)?.state ?? '')

describe('a Call', () => {
  test('[2] accepted → running → completed: the attachment in, the picture out, the answer back to the caller', async () => {
    const { onsen, cfg, codexLog } = setup()
    const ref = onsen.file('11', 'ref.png', PNG)
    onsen.call('71', 'chiron', 501)
    onsen.push({ sender: 'chiron', payload: { text: '生一張 1024x1024 的圖：水豚泡溫泉 IMG:capy.png', msg_id: 501 }, dedupe: 'msg:501', call_id: '71',
      attachments: [{ kind: 'photo', name: 'ref.png', mime: 'image/png', bytes: PNG.length, url: ref }] })
    const r = runner(cfg)
    await r.start()
    await until(done(onsen, '71'), 10_000, 'Call 71')
    expect(onsen.statesOf('71')).toEqual(['accepted', 'running', 'completed'])
    expect(onsen.puts.every(p => p.session_id === 'main')).toBe(true)
    const fin = onsen.puts.at(-1)!
    expect(fin.result.body.format).toBe('markdown')
    expect(fin.result.body.text).toContain('answer to: 生一張 1024x1024 的圖')
    expect(fin.result.attachment_file_ids).toHaveLength(1)
    const up = onsen.files.get(fin.result.attachment_file_ids[0])!
    expect(up.name).toBe('capy.png')
    expect(up.mime).toBe('image/png')
    expect(Buffer.compare(up.bytes, PNG)).toBe(0)
    // the folder: ~/onsen-codex/<Onsen conversation id>/call-<id>/ (a session this Call started), the attachment downloaded into it and handed
    // over with -i, stdin /dev/null
    const [start] = codexLog().filter(x => x.ev === 'start')
    const folder = join(cfg.root, 'cv-chiron', 'call-71')
    expect(start.dir).toBe(folder)
    expect(start.cwd).toBe(folder)
    expect(start.stdin_null).toBe(true)
    expect(start.argv.slice(0, 11)).toEqual(['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', folder, '--json', '-o', join(folder, 'last-1.txt'), '-i', join(folder, 'ref.png')])
    expect(start.argv.at(-2)).toBe('--')
    expect(start.resume).toBeNull()
    expect(readFileSync(join(folder, 'ref.png')).equals(PNG)).toBe(true)
    expect(existsSync(join(folder, 'capy.png'))).toBe(true)
    // the answer reaches the caller as every Call's answer does: a reply in its inbox, the file attached
    await until(() => onsen.sends.length === 1, 5_000, 'the reply')
    const s = onsen.sends[0]
    expect(s.to).toBe('chiron')
    expect(s.kind).toBe('peer_call')
    expect(s.payload.reply_to_id).toBe(501)
    expect(s.payload.text).toContain('answer to:')
    expect(s.payload.text).toContain(join(folder, 'capy.png'))
    expect(s.attachment_file_ids).toEqual(fin.result.attachment_file_ids)
    expect(s.dedupe).toBe('codex-reply:71')
    // the session's thread: on the reply (what the caller's daemon fills in when it reply_to's it) and named in the result
    expect(s.payload.thread).toMatch(/^codex#t-[0-9a-f]{12}$/)
    expect(s.refs).toEqual({ thread: s.payload.thread })
    expect(s.payload.hop).toBe(1)
    expect(fin.result.body.text).toContain(`Codex 對話串 ${s.payload.thread}`)
    expect(s.payload.text).toContain(`thread=${s.payload.thread}`)
    await until(() => onsen.acked >= 1, 3_000, 'the ack')
    expect(onsen.unauthorized).toBe(0)
  })

  test('[3] a session belongs to a thread: the reply_to of its answer resumes it, a Call with its thread too; one item of a session at a time', async () => {
    const { onsen, cfg, codexLog } = setup()
    onsen.call('81', 'chiron', 601)
    onsen.push({ sender: 'chiron', payload: { text: '生一張圖 IMG:capy.png', msg_id: 601 }, dedupe: 'msg:601', call_id: '81' })
    const r = runner(cfg)
    await r.start()
    await until(() => done(onsen, '81')() && onsen.sends.length === 1, 10_000, 'Call 81 and its reply')
    const T = onsen.sends[0].payload.thread as string
    const folder = join(cfg.root, 'cv-chiron', 'call-81')
    // the caller reply_to's the answer: no Call in Onsen (it answers none of Codex's), its daemon filled in the thread
    onsen.push({ sender: 'chiron', payload: { text: '把剛才那張的水改成晚上 IMG:capy.png', msg_id: 602, reply_to_id: 4711, thread: T, hop: 1 }, dedupe: 'msg:602' })
    await until(() => onsen.sends.length === 2, 10_000, 'the follow-up\'s reply')
    let starts = codexLog().filter(x => x.ev === 'start')
    const first = readEvents(join(folder, '.codex-runner', 'run-1.jsonl')).session
    expect(first).toMatch(/^sess-/)
    expect(starts[1].resume).toBe(first)
    expect(starts[1].argv.slice(0, 12)).toEqual(['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', folder, 'resume', first, '--json', '-o',
      join(folder, 'last-2.txt'), '--'])                                       // -s / -C before resume; --json, -o after it
    expect(starts[1].dir).toBe(folder)
    const f = onsen.sends[1]
    expect(f.payload.reply_to_id).toBe(602)                                    // the follow-up's own number
    expect(f.payload.thread).toBe(T)
    expect(f.payload.hop).toBe(2)
    expect(f.payload.text).toContain('resumed=yes')
    expect(f.attachment_file_ids).toHaveLength(1)                              // capy.png changed in place: this run's file too
    expect(onsen.puts.filter(p => p.call !== '81')).toEqual([])                // no Call, no state
    // a Call sent with the thread resumes it too; two of them at once: the second waits for the first
    onsen.call('83', 'chiron', 603); onsen.call('84', 'chiron', 604)
    onsen.push({ sender: 'chiron', payload: { text: 'SLEEP:0.4 again', msg_id: 603, thread: T }, refs: { thread: T }, dedupe: 'msg:603', call_id: '83' })
    onsen.push({ sender: 'chiron', payload: { text: 'and again', msg_id: 604 }, refs: { thread: T }, dedupe: 'msg:604', call_id: '84' })
    await until(() => done(onsen, '83')() && done(onsen, '84')(), 10_000, 'Calls 83 and 84')
    starts = codexLog().filter(x => x.ev === 'start')
    const ends = codexLog().filter(x => x.ev === 'end')
    expect(starts.slice(2).map(x => x.resume)).toEqual([first, first])
    expect(starts.slice(2).every(x => x.dir === folder)).toBe(true)
    expect(starts[3].at).toBeGreaterThanOrEqual(ends[2].at)                   // one session: never two at once
    expect(onsen.statesOf('83')).toEqual(['accepted', 'running', 'completed'])
    expect(onsen.statesOf('84')).toEqual(['accepted', 'running', 'completed'])
    expect(Object.keys(r.state.sessions)).toEqual([`t:${T}`])
  })

  test('a reply with no thread its daemon could fill in: a new session, answered with its own number', async () => {
    const { onsen, cfg, codexLog } = setup()
    onsen.push({ sender: 'athena', payload: { text: 'about your last answer', msg_id: 1501, reply_to_id: 4712 }, dedupe: 'msg:1501' })
    const r = runner(cfg)
    await r.start()
    await until(() => onsen.sends.length === 1, 10_000, 'the reply')
    expect(codexLog().find(x => x.ev === 'start').resume).toBeNull()
    expect(onsen.sends[0].payload.reply_to_id).toBe(1501)
    expect(onsen.sends[0].payload.thread).toMatch(/^codex#t-[0-9a-f]{12}$/)
    expect(onsen.puts).toEqual([])
  })

  test('[4] a failing command: failed, the last lines of stderr in result.body; the caller is told', async () => {
    const { onsen, cfg } = setup()
    onsen.call('91', 'athena', 701)
    onsen.push({ sender: 'athena', payload: { text: 'FAIL please', msg_id: 701 }, dedupe: 'msg:701', call_id: '91' })
    const r = runner(cfg)
    await r.start()
    await until(done(onsen, '91'), 10_000, 'Call 91')
    expect(onsen.statesOf('91')).toEqual(['accepted', 'running', 'failed'])
    const t = onsen.puts.at(-1)!.result.body.text as string
    expect(t).toContain('codex 結束碼 3')
    expect(t).toContain('the model said no')
    expect(t).toContain('boom line 40')
    expect(t).toContain('boom line 11')
    expect(t).not.toContain('boom line 10\n')                                 // the last 30 lines only
    await until(() => onsen.sends.length === 1, 5_000, 'the reply')
    expect(onsen.sends[0].payload.text).toContain('沒做完')
  })

  test('[4] the time limit: SIGTERM, then SIGKILL for a codex that ignores it; failed', async () => {
    const { onsen, cfg, codexLog } = setup({ timeoutMs: 800, killGraceMs: 300 })
    onsen.call('95', 'athena', 705)
    onsen.push({ sender: 'athena', payload: { text: 'HANGHARD', msg_id: 705 }, dedupe: 'msg:705', call_id: '95' })
    const r = runner(cfg)
    await r.start()
    await until(done(onsen, '95'), 10_000, 'Call 95')
    expect(onsen.statesOf('95')).toEqual(['accepted', 'running', 'failed'])
    expect(onsen.puts.at(-1)!.result.body.text).toContain('超過 1 秒沒結束，已停止')
    const pid = codexLog().find(x => x.ev === 'start').pid
    let gone = false
    try { process.kill(pid, 0) } catch { gone = true }
    expect(gone).toBe(true)
  })

  test('[5] five Calls at once with no thread, one caller: five sessions, three running, the rest queued (no PUT) until a slot frees; all done', async () => {
    const { onsen, cfg, codexLog } = setup()
    const callers = ['chiron', 'chiron', 'chiron', 'chiron', 'chiron']
    callers.forEach((c, i) => { onsen.call(`10${i}`, c, 800 + i); onsen.push({ sender: c, payload: { text: `SLEEP:0.6 avatar ${i}`, msg_id: 800 + i }, dedupe: `msg:${800 + i}`, call_id: `10${i}` }) })
    const r = runner(cfg)
    await r.start()
    await until(() => onsen.statesOf('100').includes('running') && onsen.statesOf('101').includes('running') && onsen.statesOf('102').includes('running'), 5_000, 'three running')
    expect(onsen.statesOf('103')).toEqual([])                                 // still queued in Onsen: no PUT for it yet
    expect(onsen.statesOf('104')).toEqual([])
    const mid = r.observation()
    expect(mid.queue.pending).toBe(2)
    expect(mid.background!.tasks).toBe(3)
    await until(() => callers.every((_, i) => done(onsen, `10${i}`)()), 15_000, 'all five')
    expect(Math.max(...codexLog().filter(x => x.ev === 'start').map(x => x.live))).toBe(3)
    callers.forEach((_, i) => expect(onsen.statesOf(`10${i}`)).toEqual(['accepted', 'running', 'completed']))
    // five sessions, five folders, no resume: two sessions running at once never see each other's new files
    const starts = codexLog().filter(x => x.ev === 'start')
    expect(new Set(starts.map(x => x.dir)).size).toBe(5)
    expect(starts.every(x => x.resume === null && x.dir.startsWith(join(cfg.root, 'cv-chiron', 'call-10')))).toBe(true)
    expect(new Set(onsen.sends.map(x => x.payload.thread)).size).toBe(5)
    // at no moment were more than three Calls between accepted and their end
    const ev = onsen.puts.map(p => ({ at: p.at, d: p.state === 'accepted' ? 1 : p.state === 'running' ? 0 : -1 })).sort((a, b) => a.at - b.at || a.d - b.d)
    let open = 0, most = 0
    for (const e of ev) { open += e.d; most = Math.max(most, open) }
    expect(most).toBeLessThanOrEqual(3)
  })
})

describe('status', () => {
  test('[6] idle, running 「codex exec」, idle again, offline at a clean stop: each a valid observation', async () => {
    const { onsen, cfg } = setup()
    const r = runner(cfg)
    await r.start()
    await until(() => onsen.observations.length >= 1, 3_000, 'the first observation')
    const idle = onsen.observations[0]
    expect(idle.presence).toBe('online')
    expect(idle.sessions[0].activity).toBe('idle')
    expect(idle.sessions[0].doing).toBeNull()
    expect(checkObservation(idle)).toEqual([])
    onsen.call('201', 'chiron', 901)
    onsen.push({ sender: 'chiron', payload: { text: 'SLEEP:0.8 work', msg_id: 901 }, dedupe: 'msg:901', call_id: '201' })
    await until(() => onsen.observations.some(o => o.sessions[0].activity === 'running'), 5_000, 'running')
    const run = onsen.observations.find(o => o.sessions[0].activity === 'running')
    expect(run.sessions[0].doing).toEqual({ kind: 'tool', tool: 'codex exec', since: run.sessions[0].turn.started_at })
    expect(run.sessions[0].turn.trigger).toEqual({ kind: 'other' })
    expect(run.main_session_id).toBe('main')
    expect(checkObservation(run)).toEqual([])
    // the Call's running is no earlier than the turn that holds it (Onsen's live evidence: a turn begun no later than the Call's start)
    const runPut = onsen.puts.find(p => p.call === '201' && p.state === 'running')!
    expect(Date.parse(run.sessions[0].turn.started_at)).toBeLessThanOrEqual(runPut.at)
    await until(done(onsen, '201'), 10_000, 'Call 201')
    await until(() => onsen.observations.at(-1).sessions[0].activity === 'idle', 3_000, 'idle again')
    const after = onsen.observations.at(-1)
    expect(after.sessions[0].last_turn).toMatchObject({ id: run.sessions[0].turn.id, outcome: 'done' })
    expect(checkObservation(after)).toEqual([])
    // the beat: unchanged, it is sent again (reported_at new)
    const n = onsen.observations.length
    await until(() => onsen.observations.length > n, 3_000, 'a heartbeat')
    runners.splice(runners.indexOf(r), 1)
    await r.stop()
    const off = onsen.observations.at(-1)
    expect(off.presence).toBe('offline')
    expect(off.presence_reason).toBe('disconnected')
    expect(off.sessions[0].activity).toBe('unknown')
    expect(checkObservation(off)).toEqual([])
  })
})

describe('Joey on the page', () => {
  test('a message with a picture: run in his conversation\'s folder, the answer recorded there with its file, the delivery facts', async () => {
    const { onsen, cfg, codexLog } = setup()
    const cat = onsen.file('12', 'cat.png', PNG)
    onsen.forms.push({ id: 801, form_id: 3, chat: '1828173984', title: '', body: '照這張畫 IMG:capy.png\n〔圖片 cat.png〕', at: new Date().toISOString(), say: true,
      attachments: [{ kind: 'photo', name: 'cat.png', mime: 'image/png', bytes: PNG.length, url: cat }] })
    const r = runner(cfg)
    await r.start()
    await until(() => onsen.facts.some(f => f.state === 'turn_end'), 10_000, 'turn_end')
    expect(onsen.formsAcked.has(801)).toBe(true)
    const start = codexLog().find(x => x.ev === 'start')
    expect(start.dir).toBe(join(cfg.root, '4242', 'dm'))
    expect(start.images).toEqual([join(cfg.root, '4242', 'dm', 'cat.png')])
    expect(onsen.records).toHaveLength(1)
    const rec = onsen.records[0]
    expect(rec).toMatchObject({ agent: 'codex', client: 'telegram', chat: '1828173984', direction: 'out', sender: 'main' })
    expect(rec.body).toContain('answer to: 照這張畫')
    expect(rec.attachment_file_ids).toHaveLength(1)
    expect(onsen.files.get(rec.attachment_file_ids[0])!.name).toBe('capy.png')
    const job = rec.turn_id
    expect(job).toMatch(/^codex-j\d+$/)
    const byState = Object.fromEntries(onsen.facts.map(f => [f.state, f]))
    expect(Object.keys(byState).sort()).toEqual(['delivered', 'in_session', 'seen', 'turn_end'])
    expect(byState.seen).toMatchObject({ client_msg_id: 'form-801', chat: '1828173984', by: 'main', turn_id: job })
    expect(byState.turn_end).toMatchObject({ outcome: 'done', bound: ['form-801'], turn_id: job })
    expect(Date.parse(byState.delivered.at)).toBeLessThanOrEqual(Date.parse(byState.seen.at))
    expect(Date.parse(byState.seen.at)).toBeLessThanOrEqual(Date.parse(byState.turn_end.at))
    // its turn on the main session names the message
    expect(onsen.observations.some(o => o.sessions[0].turn?.trigger?.kind === 'message' && o.sessions[0].turn.trigger.message_id === '801'
      && o.sessions[0].turn.trigger.conversation_id === '4242')).toBe(true)
  })

  test('an Onsen that does not take the answer\'s files yet: the files are said, not lost', async () => {
    const { onsen, cfg } = setup()
    onsen.messagesKnowAttachments = false
    onsen.forms.push({ id: 802, form_id: 4, chat: '1828173984', title: '', body: 'IMG:a.png', at: new Date().toISOString(), say: true })
    const r = runner(cfg)
    await r.start()
    await until(() => onsen.records.length === 2, 10_000, 'two records')
    expect(onsen.records[1].body).toContain('沒能附上')
    expect(onsen.records[1].body).toContain('a.png')
  })
})

describe('restart', () => {
  test('a run that went on through a restart is followed to its end; reported once', async () => {
    const { onsen, cfg } = setup()
    onsen.call('301', 'chiron', 1001)
    onsen.push({ sender: 'chiron', payload: { text: 'SLEEP:1.5 IMG:later.png', msg_id: 1001 }, dedupe: 'msg:1001', call_id: '301' })
    const a = runner(cfg)
    await a.start()
    await until(() => onsen.statesOf('301').includes('running'), 5_000, 'running')
    runners.splice(runners.indexOf(a), 1)
    await a.stop()                                                            // a clean stop: offline; codex goes on
    expect(onsen.calls.get('301')!.state).toBe('running')
    const b = runner(cfg)
    await b.start()
    await until(done(onsen, '301'), 10_000, 'Call 301')
    expect(onsen.statesOf('301')).toEqual(['accepted', 'running', 'completed'])
    const fin = onsen.puts.at(-1)!
    expect(fin.result.attachment_file_ids).toHaveLength(1)
    await until(() => onsen.sends.length >= 1, 5_000, 'the reply')            // the reply goes after the Call's state
    await Bun.sleep(300)
    expect(onsen.sends).toHaveLength(1)                                       // once: the stopped runner sent nothing
  })

  test('a run whose process is gone: completed when its events show it finished, else failed with a note', async () => {
    const { onsen, cfg } = setup()
    onsen.call('401', 'chiron', 1101); onsen.call('402', 'athena', 1102)
    onsen.calls.get('401')!.state = 'running'; onsen.calls.get('402')!.state = 'running'
    const dead = spawnSync('true').pid                                        // a pid that has ended
    const d1 = join(cfg.root, 'c1'), d2 = join(cfg.root, 'c2')
    for (const d of [d1, d2]) mkdirSync(join(d, '.codex-runner'), { recursive: true })
    writeFileSync(join(d1, '.codex-runner', 'run-1.jsonl'), '{"type":"thread.started","thread_id":"s-1"}\n{"type":"turn.completed"}\n')
    writeFileSync(join(d1, 'last-1.txt'), 'finished while the runner was down')
    writeFileSync(join(d2, '.codex-runner', 'run-1.jsonl'), '{"type":"thread.started","thread_id":"s-2"}\n')
    writeFileSync(join(d2, '.codex-runner', 'run-1.stderr'), 'killed somewhere\n')
    mkdirSync(cfg.stateDir, { recursive: true })
    const t = new Date(Date.now() - 5000).toISOString()
    const job = (id: string, call: string, thread: string, caller: string, dir: string, n: number) => ({ id, source: 'call', key: `t:${thread}`, thread, text: 'x',
      attachments: [], state: 'running', received_at: t, call_id: call, number: n, caller, kind: 'peer_call', dir, n: 1, started_at: t, pid: dead, before: {} })
    const sess = (dir: string, thread: string, n: number) => ({ dir, conversation_id: 'c', session_id: null, runs: 1, thread, first_number: n })
    writeFileSync(join(cfg.stateDir, 'state.json'), JSON.stringify({ v: 1, seq: 2,
      jobs: [job('j1', '401', 'codex#t-000000000001', 'chiron', d1, 1101), job('j2', '402', 'codex#t-000000000002', 'athena', d2, 1102)],
      sessions: { 't:codex#t-000000000001': sess(d1, 'codex#t-000000000001', 1101), 't:codex#t-000000000002': sess(d2, 'codex#t-000000000002', 1102) },
      says: [], span: { id: 'codex-turn-1', started_at: t, trigger: { kind: 'other' } }, last_turn: null, idle_since: null, last_activity_at: t }))
    const r = runner(cfg)
    await r.start()
    await until(() => done(onsen, '401')() && done(onsen, '402')(), 10_000, 'both settled')
    expect(onsen.statesOf('401')).toEqual(['completed'])
    expect(onsen.puts.find(p => p.call === '401')!.result.body.text).toBe('finished while the runner was down\n\n（Codex 對話串 codex#t-000000000001：要它在同一段接著做，reply_to 這一則，或送的時候帶 thread=codex#t-000000000001；不帶的是新的一段）')
    expect(onsen.statesOf('402')).toEqual(['failed'])
    expect(onsen.puts.find(p => p.call === '402')!.result.body.text).toContain('codex-runner 重新啟動時，這一件的 codex 程序已經不在')
    expect(r.state.sessions['t:codex#t-000000000001']!.session_id).toBe('s-1')
    await until(() => onsen.observations.at(-1)?.sessions[0].activity === 'idle', 3_000, 'idle')
  })
})

describe('what is not work, and what is not Onsen', () => {
  test('a mail bell, a silent notice, a poke with no Call, a press: acked, nothing run', async () => {
    const { onsen, cfg, codexLog } = setup()
    onsen.push({ sender: 'board', kind: 'peer_mail', payload: { text: 'you have mail', msg_id: 1 }, dedupe: 'msg:1' })
    onsen.push({ sender: 'chiron', payload: { text: 'interim', msg_id: 3, urgency: 'silent' }, dedupe: 'msg:3' })
    onsen.push({ sender: 'watchdog', payload: { text: '保溫', msg_id: 4 }, dedupe: 'msg:4' })       // a peer_call with a number, no Call
    onsen.push({ sender: 'onsen', kind: 'action_control', payload: { action_id: '1' }, dedupe: 'ac:1' })
    const r = runner(cfg)
    await r.start()
    await until(() => onsen.acked >= 4, 5_000, 'acked')
    await until(() => r.state.jobs.every(j => j.state === 'skipped'), 3_000, 'the poke looked up')
    expect(r.state.jobs).toHaveLength(1)
    expect(codexLog()).toEqual([])
    expect(onsen.puts).toEqual([])
    expect(onsen.sends).toEqual([])
  })

  test('a peer_call that came without its Call id: looked up by its number, then run', async () => {
    const { onsen, cfg } = setup()
    onsen.call('501', 'chiron', 1201)
    onsen.push({ sender: 'chiron', payload: { text: 'late id', msg_id: 1201 }, dedupe: 'msg:1201' })
    const r = runner(cfg)
    await r.start()
    await until(done(onsen, '501'), 10_000, 'Call 501')
    expect(onsen.statesOf('501')).toEqual(['accepted', 'running', 'completed'])
  })

  test('the same item given twice is one job; an attachment off Onsen\'s origin is not fetched with the credential', async () => {
    const { onsen, cfg, codexLog } = setup()
    let leaked = 0
    const other = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: req => { if (req.headers.get('authorization')) leaked++; return new Response(PNG) } })
    try {
      onsen.call('601', 'chiron', 1301)
      const it = { sender: 'chiron', payload: { text: 'look', msg_id: 1301 }, dedupe: 'msg:1301', call_id: '601',
        attachments: [{ kind: 'photo', name: 'x.png', mime: 'image/png', url: `http://127.0.0.1:${other.port}/x.png` }] }
      onsen.push(it); onsen.push(it)
      const r = runner(cfg)
      await r.start()
      await until(done(onsen, '601'), 10_000, 'Call 601')
      expect(r.state.jobs.filter(j => j.call_id === '601')).toHaveLength(1)
      expect(leaked).toBe(0)
      const start = codexLog().find(x => x.ev === 'start')
      expect(start.images).toEqual([])
      expect(start.text).toContain('沒下載到')
    } finally { other.stop(true) }
  })
})

describe('the folder', () => {
  test('what a run made: new and changed files, not hidden ones, not last-<n>.txt; at most 20, each within the limit', async () => {
    const { onsen, cfg } = setup({ maxFileBytes: 1000 })
    process.env.FAKE_CODEX_BIG = '5000'
    onsen.call('701', 'chiron', 1401)
    onsen.push({ sender: 'chiron', payload: { text: 'MANY:22 BIG:huge.bin', msg_id: 1401 }, dedupe: 'msg:1401', call_id: '701' })
    const r = runner(cfg)
    await r.start()
    await until(done(onsen, '701'), 10_000, 'Call 701')
    const fin = onsen.puts.at(-1)!
    expect(fin.state).toBe('completed')
    expect(fin.result.attachment_file_ids).toHaveLength(20)
    expect(fin.result.body.text).toContain('huge.bin（超過 1000 bytes，沒有附上）')
    expect(fin.result.body.text).toContain('（超過 20 個，沒有附上）')
    delete process.env.FAKE_CODEX_BIG
  })

  test('snapshot / madeBy / safeName', () => {
    const d = mkdtempSync(join(tmpdir(), 'codex-runner-snap-'))
    tmps.push(d)
    writeFileSync(join(d, 'old.txt'), 'a')
    mkdirSync(join(d, '.codex-runner')); writeFileSync(join(d, '.codex-runner', 'run-1.jsonl'), '{}')
    const before = snapshot(d)
    expect(Object.keys(before)).toEqual(['old.txt'])
    writeFileSync(join(d, 'last-1.txt'), 'answer')
    mkdirSync(join(d, 'out')); writeFileSync(join(d, 'out', 'new.png'), 'p')
    writeFileSync(join(d, '.hidden'), 'h')
    expect(madeBy(d, before)).toEqual(['out/new.png'])
    expect(safeName('../../etc/passwd', 'f')).toBe('passwd')
    expect(safeName('.bashrc', 'f')).toBe('bashrc')
    expect(safeName('last-3.txt', 'f')).toBe('f')
    expect(safeName(null, 'f')).toBe('f')
  })

  test('configuration from the environment: the defaults', () => {
    const c = configFromEnv({ HOME: '/h', ONSEN_HOST: 'macmini' })
    expect(c).toMatchObject({ agent: 'codex', base: 'https://core.kbro.ai/api/onsen', credentialFile: '/h/.config/mesh/codex.credential', host: 'macmini',
      root: '/h/onsen-codex', stateDir: '/h/onsen-codex/.runner', max: 3, timeoutMs: 1_800_000, killGraceMs: 10_000, sandbox: 'workspace-write', codexBin: 'codex' })
    const d = configFromEnv({ HOME: '/h', CODEX_RUNNER_MAX: '2', CODEX_RUNNER_TIMEOUT_S: '60', ONSEN_BASE: 'http://x/api/onsen/', CODEX_RUNNER_CREDENTIAL_FILE: '/c' })
    expect(d).toMatchObject({ max: 2, timeoutMs: 60_000, base: 'http://x/api/onsen', credentialFile: '/c' })
  })
})
