import { fakeItems } from '../test-fixtures/onsen-items.ts'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { CodexRunner, cleanConfig, codexHomeReady, configFromEnv, madeBy, readEvents, safeName, setupCodexHome, snapshot, type Cfg } from './codex-runner.ts'
import { checkObservation } from '../test-fixtures/status-v1-check.ts'

const FAKE = join(import.meta.dir, 'fake-codex.ts')
const TOKEN = 'mesh_test_codex_runner'
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex')


class FakeOnsen {
  items = fakeItems('codex', TOKEN, req => this.handle(req))
  base = this.items.base
  files = new Map<string, { name: string; mime: string; bytes: Buffer; by: string }>()
  idem = new Map<string, string>()
  sends: any[] = []
  records: any[] = []
  profiles: any[] = []
  profileStatus: number[] = []
  newStyleStatus: number[] = []
  replyMessageId: string | null = 'cm500'
  personWithoutId = false
  fileSeq = 900
  paths: string[] = []
  get observations() { return this.items.calls.filter(c => c.path.endsWith('/observation')).map(c => c.body) }
  stop() { return this.items.stop() }
  push(input: Record<string, any>) {
    const { sender, payload, call_id, refs = {}, attachments, dedupe } = input
    const id = call_id ?? dedupe
    if (call_id) this.items.scheduleCalls.set(call_id, { id: call_id, run: '', result: null })
    return this.items.add(id, 'call', { from: sender, call_id: call_id ?? null,
      refs: Object.entries(refs).map(([kind, value]) => ({ kind, value: String(value) })),
      payload: { conversation_id: 'cv-' + sender, attachments, ...payload } })
  }
  pushPerson(p: Record<string, any>) {
    return this.items.add('pm:' + p.message_id, 'message', { from: p.from, message_id: String(p.message_id), payload: p })
  }
  statesOf(id: string) { return this.items.history.filter(line => line.item_id === id).map(line => line.body.outcome) }
  reply(id: string) { return this.sends.find(r => r.refs.call === id) }
  file(id: string, name: string, bytes: Buffer, mime = 'image/png'): string { this.files.set(id, { name, mime, bytes, by: 'joey' }); return `${this.base}/v1/files/${id}` }
  private j(status: number, body: unknown): Response { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }) }
  async handle(req: Request): Promise<Response | null> {
    const p = new URL(req.url).pathname, m = req.method
    this.paths.push(p)
    let mm
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
    if (m === 'POST' && p === '/send') {
      const b = await req.json() as any
      if (!this.sends.some(send => send.dedupe === b.dedupe)) this.sends.push(b)
      return this.j(200, { results: [{ to: b.to, seq: this.sends.length, message_id: this.replyMessageId }] })
    }
    if (m === 'POST' && p === '/v1/messages') {
      const b = await req.json() as any
      const st = this.newStyleStatus.shift() ?? 200
      if (st !== 200) return this.j(st, {})
      let i = this.records.findIndex(r => r.idem_key === b.idem_key)
      if (i < 0) i = this.records.push(b) - 1
      return this.j(200, this.personWithoutId ? { duplicate: i >= 0 } : { id: 5001 + i })
    }
    if (m === 'PUT' && p === '/v1/members/codex/profile') { this.profiles.push(await req.json()); const st = this.profileStatus.shift() ?? 200; return this.j(st, st === 200 ? { data: { name: 'codex' } } : { error: { code: 'not_found' } }) }
    return null
  }
}
const tmps: string[] = []
const runners: CodexRunner[] = []
const onsens: FakeOnsen[] = []
afterEach(async () => {
  for (const r of runners.splice(0)) await r.stop({ offline: false })
  for (const o of onsens.splice(0)) {
    await o.stop()
    expect(o.paths.filter(path => /^\/(?:inbox|forms|deliveries)(?:\/|$)/.test(path))).toEqual([])
    for (const call of o.items.calls.filter(c => c.path.endsWith('/state'))) expect(Object.keys(call.body)).toEqual(['result'])
  }
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
  process.env.FAKE_CODEX_LOG = join(dir, 'codex.log')
  process.env.FAKE_CODEX_LIVE = join(dir, 'live')
  const log: string[] = []
  const cfg: Cfg = { ...configFromEnv({ HOME: dir }), base: onsen.base, credentialFile: join(dir, 'cred'), host: 'macmini', root: join(dir, 'onsen-codex'),
    stateDir: join(dir, 'onsen-codex', '.runner'), logFile: join(dir, 'runner.log'), codexBin: FAKE, waitS: 1, retryMs: 150, adoptPollMs: 100,
    codexHome: null, childHome: null, heartbeatMs: 300, declareRetryMs: 100, log: (l, m) => { log.push(`${l} ${m}`) }, ...over }
  const codexLog = (): any[] => { try { return readFileSync(join(dir, 'codex.log'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
  return { onsen, cfg, dir, log, codexLog }
}
function runner(cfg: Cfg): CodexRunner { const r = new CodexRunner(cfg); r.onsen.token = () => TOKEN; runners.push(r); return r }
async function until(cond: () => boolean, ms = 10_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await Bun.sleep(20) }
}
const done = (o: FakeOnsen, id: string) => () => o.statesOf(id).some(outcome => ['completed', 'cut', 'error'].includes(outcome))

describe('#dev items (Chiron mesh 13257)', () => {
  const g = (cwd: string, ...args: string[]): string => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return (r.stdout ?? '').trim()
  }
  const repos = (): { local: string; bare: string } => {
    const d = mkdtempSync(join(tmpdir(), 'codex-dev-'))
    tmps.push(d)
    const bare = join(d, 'origin.git'), local = join(d, 'local')
    g(d, 'init', '-q', '--bare', '-b', 'main', bare)
    g(d, 'clone', '-q', bare, local)
    writeFileSync(join(local, 'README.md'), 'hi\n')
    g(local, 'add', 'README.md'); g(local, 'commit', '-q', '-m', 'first'); g(local, 'push', '-q', 'origin', 'HEAD:main')
    g(local, 'remote', 'set-head', 'origin', 'main')
    return { local, bare }
  }
  test('the runner clones, branches, opens the sandbox to 127.0.0.1, gives the brief; Codex commits; the runner pushes that branch', async () => {
    const { local, bare } = repos()
    const { onsen, cfg, codexLog, log } = setup()
    onsen.push({ sender: 'chiron', payload: { text: `#dev repo=${local}\n加一個檔 COMMIT:hello.txt`, msg_id: 9960 }, dedupe: 'msg:9960', call_id: '9960' })
    const r = runner(cfg)
    await r.start()
    await until(() => done(onsen, '9960')() && onsen.sends.length === 1, 20_000, 'Call 9960 and its reply')
    expect(onsen.items.rows.get('9960')!.state).toBe('completed')
    const start = codexLog().find(x => x.ev === 'start')!
    expect((start.argv as string[]).join(' ')).toContain('-c sandbox_workspace_write.network_access=true')
    expect(start.text).toContain('開發任務（codex-runner 已經準備好：./repo')
    expect(start.text).toContain('不開任何憑證檔')
    expect(start.text).toContain('postgresql://postgres@127.0.0.1:55432')
    const clone = join(start.dir, 'repo')
    expect(g(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('codex/call-9960')
    expect(g(bare, 'ls-tree', '--name-only', 'codex/call-9960')).toContain('hello.txt')     // pushed: that branch only
    expect(g(bare, 'ls-tree', '--name-only', 'main')).not.toContain('hello.txt')
    const t = onsen.sends.at(-1)!.payload.text as string
    expect(t).toContain('**開發任務**')
    expect(t).toContain('分支：codex/call-9960')
    expect(t).toContain('推上去了')
    expect(t).toContain('add hello.txt')
    expect(onsen.sends.at(-1)!.attachment_file_ids ?? []).toHaveLength(0)            // the clone's files are not attached
    expect(log.some(l => /#dev push codex\/call-9960: ok/.test(l))).toBe(true)
  }, 40_000)
  test('branch= is used, #dev found after the mesh\'s 因為 line; a repo nobody knows fails the item with the reason', async () => {
    const { local, bare } = repos()
    const { onsen, cfg } = setup()
    onsen.push({ sender: 'chiron', payload: { text: `因為：Joey 在等\n\n#dev repo=${local} branch=feat/x\nCOMMIT:a.txt`, msg_id: 9961 }, dedupe: 'msg:9961', call_id: '9961' })   // a Call's because line first (Call 774)
    onsen.push({ sender: 'chiron', payload: { text: '#dev repo=nosuchrepo\n做事', msg_id: 9962 }, dedupe: 'msg:9962', call_id: '9962' })
    const r = runner(cfg)
    await r.start()
    await until(() => done(onsen, '9961')() && done(onsen, '9962')(), 20_000, 'both')
    expect(g(bare, 'ls-tree', '--name-only', 'feat/x')).toContain('a.txt')
    expect(onsen.statesOf('9962')).toEqual(['in_session', 'completed'])
    expect(onsen.items.scheduleCalls.get('9962')?.result.outcome).toBe('failed')
    expect(onsen.reply('9962').payload.text).toContain('不認得這個名字')
  }, 40_000)
  test('a ./repo the runner did not make is moved aside, never reused; the base is origin\'s default branch', async () => {
    const { local } = repos()
    const { onsen, cfg, codexLog } = setup()
    const pre = join(cfg.root, 'cv-chiron', 'call-9964', 'repo')
    mkdirSync(pre, { recursive: true }); writeFileSync(join(pre, 'work.txt'), 'codex made this before #dev')
    onsen.push({ sender: 'chiron', payload: { text: `#dev repo=${local}\nCOMMIT:b.txt`, msg_id: 9964 }, dedupe: 'msg:9964', call_id: '9964' })
    const r = runner(cfg)
    await r.start()
    await until(() => done(onsen, '9964')(), 20_000, 'Call 9964')
    const dir = join(cfg.root, 'cv-chiron', 'call-9964')
    const aside = readdirSync(dir).find(n => n.startsWith('repo-before-'))!
    expect(readFileSync(join(dir, aside, 'work.txt'), 'utf8')).toBe('codex made this before #dev')
    expect(existsSync(join(dir, 'repo', '.git'))).toBe(true)
    expect(codexLog().find(x => x.ev === 'start')!.text).toContain(`已經移到 ${aside}`)
    expect(onsen.sends.at(-1)!.payload.text).toContain('從 origin/main 開')
  }, 40_000)
  test('a shallow local copy (the live plugin checkout): cloned from origin without --reference, and it still works', async () => {
    const { local, bare } = repos()
    const d = mkdtempSync(join(tmpdir(), 'codex-shallow-'))
    tmps.push(d)
    const shallow = join(d, 'shallow')
    g(d, 'clone', '-q', '--depth', '1', `file://${bare}`, shallow)
    expect(g(shallow, 'rev-parse', '--is-shallow-repository')).toBe('true')
    const { onsen, cfg } = setup()
    onsen.push({ sender: 'chiron', payload: { text: `#dev repo=${shallow}\nCOMMIT:c.txt`, msg_id: 9965 }, dedupe: 'msg:9965', call_id: '9965' })
    const r = runner(cfg)
    await r.start()
    await until(() => done(onsen, '9965')(), 20_000, 'Call 9965')
    expect(onsen.items.rows.get('9965')!.state).toBe('completed')
    expect(g(bare, 'ls-tree', '--name-only', 'codex/call-9965')).toContain('c.txt')
    void local
  }, 40_000)
  test('stopped at its limit: it goes on once in the same session instead of failing', async () => {
    const { local } = repos()
    const { onsen, cfg, codexLog, log } = setup({ devTimeoutMs: 1200, killGraceMs: 300 })
    process.env.FAKE_CODEX_RESUME_SLEEP = '0.8'             // the continuation outlives the first run's SIGKILL timer: it must not be its target
    onsen.push({ sender: 'chiron', payload: { text: `#dev repo=${local}\n慢慢做 SLEEP:4`, msg_id: 9963 }, dedupe: 'msg:9963', call_id: '9963' })
    const r = runner(cfg)
    await r.start()
    try { await until(() => done(onsen, '9963')(), 30_000, 'Call 9963') } finally { delete process.env.FAKE_CODEX_RESUME_SLEEP }
    expect(onsen.items.rows.get('9963')!.state).toBe('completed')
    const starts = codexLog().filter(x => x.ev === 'start')
    expect(starts.length).toBe(2)
    expect(starts[1].resume).toBeTruthy()
    expect(starts[1].text).toContain('時間到了')
    expect(log.some(l => /going on once in the same session/.test(l))).toBe(true)
  }, 40_000)
})

describe('the model is the runner\'s own (Chiron mesh 13227)', () => {
  test('CODEX_RUNNER_MODEL / _EFFORT: every run gets -m and the effort; --setup writes them, never the personal config\'s model', async () => {
    const env = { HOME: '/tmp/x', CODEX_RUNNER_MODEL: 'gpt-6.2-astra', CODEX_RUNNER_EFFORT: 'high' }
    const c = configFromEnv(env)
    expect(c.model).toBe('gpt-6.2-astra'); expect(c.effort).toBe('high')
    expect(configFromEnv({ HOME: '/tmp/x', CODEX_RUNNER_MODEL: 'bad model; rm', CODEX_RUNNER_EFFORT: 'max' }).model).toBeNull()
    expect(cleanConfig('model = "personal-one"\nmodel_reasoning_effort = "low"\n', { model: 'gpt-6.2-astra', effort: 'high' }))
      .toContain('model = "gpt-6.2-astra"\nmodel_reasoning_effort = "high"')
    expect(cleanConfig('model = "kept"\n')).toContain('model = "kept"')        // no own setting: this home's own line stays
    const { onsen, cfg, codexLog } = setup({ model: 'gpt-6.2-astra', effort: 'high' })
    onsen.push({ sender: 'chiron', payload: { text: '做一件事', msg_id: 9950 }, dedupe: 'msg:9950', call_id: '9950' })
    const r = runner(cfg)
    await r.start()
    await until(done(onsen, '9950'), 10_000, 'Call 9950')
    const args = (codexLog().find(x => x.ev === 'start' || x.argv)?.argv ?? codexLog()[0]?.argv ?? []) as string[]
    expect(args.join(' ')).toContain('-m gpt-6.2-astra -c model_reasoning_effort="high"')
  }, 30_000)
})

describe('#dev thinks at max (Chiron #200750)', () => {
  test('a #dev item runs at CODEX_RUNNER_DEV_EFFORT (default max), an ordinary one at CODEX_RUNNER_EFFORT; max and ultra are accepted, a word the CLI does not list is not', () => {
    expect(configFromEnv({ HOME: '/tmp/x', CODEX_RUNNER_EFFORT: 'high' }).devEffort).toBe('max')
    expect(configFromEnv({ HOME: '/tmp/x', CODEX_RUNNER_EFFORT: 'max' }).effort).toBe('max')
    expect(configFromEnv({ HOME: '/tmp/x', CODEX_RUNNER_DEV_EFFORT: 'ultra' }).devEffort).toBe('ultra')
    expect(configFromEnv({ HOME: '/tmp/x', CODEX_RUNNER_DEV_EFFORT: 'turbo; rm' }).devEffort).toBe('max')
    expect(configFromEnv({ HOME: '/tmp/x', CODEX_RUNNER_EFFORT: 'extreme' }).effort).toBeNull()
    const { cfg } = setup({ model: 'gpt-6.2-astra', effort: 'high' })
    const r = runner(cfg)
    const job = (dev: boolean): any => ({ id: 'j1', call_id: '9960', n: 1, dir: '/tmp/x/j1', text: '做一件事', attachments: [], images: [],
      ...(dev ? { dev: { repo: 'fleet-core', branch: 'codex/call-9960', base: 'origin/main' } } : {}) })
    expect(r.argv(job(true)).join(' ')).toContain('-m gpt-6.2-astra -c model_reasoning_effort="max"')
    expect(r.argv(job(false)).join(' ')).toContain('-m gpt-6.2-astra -c model_reasoning_effort="high"')
  })
})

describe('a long answer (Chiron mesh 13227: over 4000, the Call never completed and the caller got nothing)', () => {
  for (const n of [5000, 15000]) test(`${n} characters: the Call completes with a body within 4000, the whole answer attached; the reply goes back`, async () => {
    const { onsen, cfg } = setup()
    process.env.FAKE_CODEX_ANSWER = 'x'.repeat(n)
    onsen.push({ sender: 'chiron', payload: { text: `寫一份很長的 ${n}`, msg_id: 9000 + n }, dedupe: `msg:${9000 + n}`, call_id: `9${n}` })
    const r = runner(cfg)
    await r.start()
    try {
      await until(() => done(onsen, `9${n}`)() && onsen.sends.length === 1, 15_000, `Call 9${n} and its reply`)
    } finally { delete process.env.FAKE_CODEX_ANSWER }
    expect(onsen.items.rows.get(`9${n}`)!.state).toBe('completed')
    const fin = onsen.sends.at(-1)!
    expect((fin.payload.text as string).length).toBeLessThanOrEqual(4000)
    expect(onsen.files.get(fin.attachment_file_ids[0])!.bytes.toString()).toContain('x'.repeat(n))
    expect(fin.attachment_file_ids?.length).toBeGreaterThanOrEqual(1)
    expect(String(onsen.sends[0].payload.text).length).toBeLessThanOrEqual(4000)
  }, 30_000)
  test('199 files left out (call 752): the answer keeps its room; the list is cut to a few lines and a count', async () => {
    const { onsen, cfg } = setup({ maxFiles: 2 })
    process.env.FAKE_CODEX_ANSWER = 'z'.repeat(3000)
    onsen.push({ sender: 'chiron', payload: { text: '改很多檔 MANY:60', msg_id: 9900 }, dedupe: 'msg:9900', call_id: '9900' })
    const r = runner(cfg)
    await r.start()
    try {
      await until(() => done(onsen, '9900')() && onsen.sends.length === 1, 15_000, 'Call 9900 and its reply')
    } finally { delete process.env.FAKE_CODEX_ANSWER }
    const t = onsen.sends.at(-1)!.payload.text as string
    expect(t.length).toBeLessThanOrEqual(4000)
    expect(t).toContain('z'.repeat(2000))
    expect(t).toMatch(/- …另外 \d+ 個沒有附上/)
    const rt = String(onsen.sends[0].payload.text)
    expect(rt.length).toBeLessThanOrEqual(4000)
    expect(rt).toContain('z'.repeat(2000))
  }, 30_000)
})

describe('a Call', () => {
  test('[2] accepted → running → completed: the attachment in, the picture out, the answer back to the caller', async () => {
    const { onsen, cfg, codexLog } = setup()
    onsen.replyMessageId = 'cm98765'
    const ref = onsen.file('11', 'ref.png', PNG)
    onsen.push({ sender: 'chiron', payload: { text: '生一張 1024x1024 的圖：水豚泡溫泉 IMG:capy.png', msg_id: 501 }, dedupe: 'msg:501', call_id: '71',
      attachments: [{ kind: 'photo', name: 'ref.png', mime: 'image/png', bytes: PNG.length, url: ref }] })
    const r = runner(cfg)
    await r.start()
    await until(done(onsen, '71'), 10_000, 'Call 71')
    expect(onsen.statesOf('71')).toEqual(['in_session', 'completed'])
    expect(onsen.items.rows.get('71')!.response_message_ids).toEqual(['cm98765'])
    expect(onsen.items.history[0]!.body.session_id).toBe('main')
    const fin = onsen.sends.at(-1)!
    expect(fin.payload.text).toContain('answer to: 生一張 1024x1024 的圖')
    expect(fin.attachment_file_ids).toHaveLength(1)
    const up = onsen.files.get(fin.attachment_file_ids[0])!
    expect(up.name).toBe('capy.png')
    expect(up.mime).toBe('image/png')
    expect(Buffer.compare(up.bytes, PNG)).toBe(0)
    // the folder: ~/onsen-codex/<Onsen conversation id>/call-<id>/ (a session this Call started), the attachment downloaded into it and handed
    // over with -i, stdin /dev/null
    const [start] = codexLog().filter(x => x.ev === 'start')
    const folder = join(cfg.root, 'cv-chiron', 'call-71')
    expect(start.dir).toBe(folder)
    // the process's cwd is the resolved path: macOS's tmpdir /var/folders is a link to /private/var/folders (Sonn #200387)
    expect(realpathSync(start.cwd)).toBe(realpathSync(folder))
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
    expect(s.payload.no_reply).toBe(true)                                   // the answer owes the caller nothing (Chiron mesh 12558)
    expect(s.payload.text).toContain('answer to:')
    expect(s.payload.text).toContain(join(folder, 'capy.png'))
    expect(s.attachment_file_ids).toEqual(fin.attachment_file_ids)
    expect(s.dedupe).toBe('codex-reply:71')
    expect(onsen.items.scheduleCalls.get('71')?.result).toMatchObject({ outcome: 'ok', attachment_file_ids: s.attachment_file_ids,
      body: { format: 'markdown', text: expect.stringContaining('answer to:') } })
    // the session's thread: on the reply (what the caller's daemon fills in when it reply_to's it) and named in the result
    expect(s.payload.thread).toMatch(/^codex#t-[0-9a-f]{12}$/)
    expect(s.refs).toEqual({ call: '71', thread: s.payload.thread })
    expect(s.payload.hop).toBe(1)
    expect(fin.payload.text).toContain(`Codex 對話串 ${s.payload.thread}`)
    expect(s.payload.text).toContain(`thread=${s.payload.thread}`)
  })

  test('[3] a session belongs to a thread: the reply_to of its answer resumes it, a Call with its thread too; one item of a session at a time', async () => {
    const { onsen, cfg, codexLog } = setup()
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
    expect(f.payload.no_reply).toBe(true)                                   // the answer owes the caller nothing (Chiron mesh 12558)
    expect(f.payload.thread).toBe(T)
    expect(f.payload.hop).toBe(2)
    expect(f.payload.text).toContain('resumed=yes')
    expect(f.attachment_file_ids).toHaveLength(1)                              // capy.png changed in place: this run's file too
    // a Call sent with the thread resumes it too; two of them at once: the second waits for the first
    onsen.push({ sender: 'chiron', payload: { text: 'SLEEP:0.4 again', msg_id: 603, thread: T }, refs: { thread: T }, dedupe: 'msg:603', call_id: '83' })
    onsen.push({ sender: 'chiron', payload: { text: 'and again', msg_id: 604 }, refs: { thread: T }, dedupe: 'msg:604', call_id: '84' })
    await until(() => done(onsen, '83')() && done(onsen, '84')(), 10_000, 'Calls 83 and 84')
    starts = codexLog().filter(x => x.ev === 'start')
    const ends = codexLog().filter(x => x.ev === 'end')
    expect(starts.slice(2).map(x => x.resume)).toEqual([first, first])
    expect(starts.slice(2).every(x => x.dir === folder)).toBe(true)
    expect(starts[3].at).toBeGreaterThanOrEqual(ends[2].at)                   // one session: never two at once
    expect(onsen.statesOf('83')).toEqual(['in_session', 'completed'])
    expect(onsen.items.rows.get('83')!.response_message_ids).toEqual(['cm500'])
    expect(onsen.statesOf('84')).toEqual(['in_session', 'completed'])
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
  })

  test('[4] a failing command: failed, the last lines of stderr in result.body; the caller is told', async () => {
    const { onsen, cfg } = setup()
    onsen.push({ sender: 'athena', payload: { text: 'FAIL please', msg_id: 701 }, dedupe: 'msg:701', call_id: '91' })
    const r = runner(cfg)
    await r.start()
    await until(done(onsen, '91'), 10_000, 'Call 91')
    expect(onsen.statesOf('91')).toEqual(['in_session', 'completed'])
    expect(onsen.items.scheduleCalls.get('91')?.result).toMatchObject({ outcome: 'failed', body: { text: expect.stringContaining('boom line 40') } })
    const t = onsen.sends.at(-1)!.payload.text as string
    expect(t).toContain('codex 結束碼 3')
    expect(t).toContain('the model said no')
    expect(t).toContain('boom line 40')
    expect(t).toContain('boom line 11')
    expect(t).not.toContain('boom line 10\n')                                 // the last 30 lines only
    await until(() => onsen.sends.length === 1, 5_000, 'the reply')
    expect(onsen.sends[0].payload.text).toContain('沒做完')
    onsen.items.advance(6 * 60_000)
    const row = onsen.items.rows.get('91')!
    row.state = 'waiting'; onsen.items.change(row, 'restored')
    await until(() => onsen.statesOf('91').length === 3)
    expect(onsen.statesOf('91')).toEqual(['in_session', 'completed', 'completed'])
    expect(row.response_message_ids).toEqual(['cm500'])
    expect(r.stats.runs).toBe(1)
    expect(onsen.paths.filter(p => p === '/send')).toHaveLength(1)
  })

  test('[4] the time limit: SIGTERM, then SIGKILL for a codex that ignores it; failed', async () => {
    const { onsen, cfg, codexLog } = setup({ timeoutMs: 800, killGraceMs: 300 })
    onsen.push({ sender: 'athena', payload: { text: 'HANGHARD', msg_id: 705 }, dedupe: 'msg:705', call_id: '95' })
    const r = runner(cfg)
    await r.start()
    await until(done(onsen, '95'), 10_000, 'Call 95')
    expect(onsen.statesOf('95')).toEqual(['in_session', 'completed'])
    expect(onsen.items.scheduleCalls.get('95')?.result.outcome).toBe('failed')
    expect(onsen.sends.at(-1)!.payload.text).toContain('超過 1 秒沒結束，已停止')
    const pid = codexLog().find(x => x.ev === 'start').pid
    let gone = false
    try { process.kill(pid, 0) } catch { gone = true }
    expect(gone).toBe(true)
  })

  test('[5] five Calls at once with no thread, one caller: five sessions, three running, the rest queued (no PUT) until a slot frees; all done', async () => {
    const { onsen, cfg, codexLog, dir } = setup()
    const callers = ['chiron', 'chiron', 'chiron', 'chiron', 'chiron']
    callers.forEach((c, i) => { onsen.push({ sender: c, payload: { text: `WAIT_FOR_RELEASE avatar ${i}`, msg_id: 800 + i }, dedupe: `msg:${800 + i}`, call_id: `10${i}` }) })
    const r = runner(cfg)
    await r.start()
    await until(() => onsen.statesOf('100').includes('in_session') && onsen.statesOf('101').includes('in_session') && onsen.statesOf('102').includes('in_session'), 5_000, 'three running')
    expect(onsen.statesOf('103')).toEqual([])                                 // still queued in Onsen: no PUT for it yet
    expect(onsen.statesOf('104')).toEqual([])
    const mid = r.observation()
    expect(mid.queue.pending).toBe(0)
    expect(onsen.items.rows.get('103')!.state).toBe('waiting')
    expect(onsen.items.rows.get('104')!.state).toBe('waiting')
    expect(mid.background!.tasks).toBe(3)
    await until(() => codexLog().filter(x => x.ev === 'start').length === 3, 5_000, 'three worker processes')
    writeFileSync(join(dir, 'release-workers'), '')
    await until(() => callers.every((_, i) => done(onsen, `10${i}`)()), 15_000, 'all five')
    expect(Math.max(...codexLog().filter(x => x.ev === 'start').map(x => x.live))).toBe(3)
    callers.forEach((_, i) => expect(onsen.statesOf(`10${i}`)).toEqual(['in_session', 'completed']))
    // five sessions, five folders, no resume: two sessions running at once never see each other's new files
    const starts = codexLog().filter(x => x.ev === 'start')
    expect(new Set(starts.map(x => x.dir)).size).toBe(5)
    expect(starts.every(x => x.resume === null && x.dir.startsWith(join(cfg.root, 'cv-chiron', 'call-10')))).toBe(true)
    expect(new Set(onsen.sends.map(x => x.payload.thread)).size).toBe(5)
  })
})

describe('answers, follow-ups and the process group (Chiron 08:49Z)', () => {
  test('no_reply on the item keeps nothing back: the answer goes to the caller', async () => {
    const { onsen, cfg } = setup()
    onsen.push({ sender: 'chiron', payload: { text: 'do it', msg_id: 1601, no_reply: true }, no_reply: true, dedupe: 'msg:1601', call_id: '121' })
    const r = runner(cfg)
    await r.start()
    await until(() => done(onsen, '121')() && onsen.sends.length === 1, 10_000, 'the Call and its reply')
    expect(onsen.sends[0]).toMatchObject({ to: 'chiron', payload: { reply_to_id: 1601 } })
  })

  test('criterion 3: a reply_to of the answer that Onsen made a Call (0.29.2): its moments, the same session, the file back to the caller', async () => {
    const { onsen, cfg, codexLog } = setup()
    onsen.push({ sender: 'chiron', payload: { text: '生一張圖 IMG:capy.png', msg_id: 1701 }, dedupe: 'msg:1701', call_id: '131' })
    const r = runner(cfg)
    await r.start()
    await until(() => done(onsen, '131')() && onsen.sends.length === 1, 10_000, 'item 2')
    const T = onsen.sends[0].payload.thread
    // Chiron's reply_to (his daemon: no_reply, the thread filled in): Onsen 0.29.2 makes it Call 132
    onsen.push({ sender: 'chiron', payload: { text: '把剛才那張的水改成晚上 IMG:capy-night.png', msg_id: 1702, reply_to_id: 12535, thread: T, hop: 2, no_reply: true },
      refs: { btcc_msg_id: 1702, thread: T }, no_reply: true, dedupe: 'msg:1702', call_id: '132' })
    await until(() => done(onsen, '132')() && onsen.sends.length === 2, 10_000, 'the follow-up')
    expect(onsen.statesOf('132')).toEqual(['in_session', 'completed'])
    const fin = onsen.reply('132')
    expect(fin.attachment_file_ids.map((id: string) => onsen.files.get(id)!.name)).toEqual(['capy-night.png'])
    const starts = codexLog().filter(x => x.ev === 'start')
    expect(starts[1].resume).toBe(readEvents(join(starts[0].dir, '.codex-runner', 'run-1.jsonl')).session)
    expect(starts[1].dir).toBe(starts[0].dir)
    const back = onsen.sends[1]
    expect(back).toMatchObject({ to: 'chiron', payload: { reply_to_id: 1702, thread: T }, refs: { thread: T }, no_reply: true })
    expect(back.attachment_file_ids).toEqual(fin.attachment_file_ids)
  })

  test('what codex started dies with it when it ends on its own', async () => {
    const { onsen, cfg, codexLog } = setup({ killGraceMs: 300 })
    onsen.push({ sender: 'chiron', payload: { text: 'KID then done', msg_id: 1801 }, dedupe: 'msg:1801', call_id: '141' })
    const r = runner(cfg)
    await r.start()
    await until(done(onsen, '141'), 10_000, 'Call 141')
    const kid = codexLog().find(x => x.ev === 'kid').kid
    const gone = (): boolean => { try { process.kill(kid, 0); return false } catch { return true } }
    await until(gone, 3_000, 'the sleep it left')
    expect(onsen.statesOf('141')).toEqual(['in_session', 'completed'])
  })
})

describe('Codex\'s own home (Chiron 08:49Z note 2)', () => {
  test('codex runs with its configured homes and drops runner settings', () => {
    const { cfg } = setup({ codexHome: '/own/codex', childHome: '/own/home' })
    process.env.CODEX_RUNNER_TEST_ONLY = 'x'; process.env.ONSEN_TEST_ONLY = 'y'
    try {
      const env = runner(cfg).childEnv()
      expect(env.CODEX_HOME).toBe(cfg.codexHome)
      expect(env.HOME).toBe(cfg.childHome)
      expect(env.CODEX_RUNNER_TEST_ONLY).toBeUndefined()
      expect(env.ONSEN_TEST_ONLY).toBeUndefined()
    } finally { delete process.env.CODEX_RUNNER_TEST_ONLY; delete process.env.ONSEN_TEST_ONLY }
  })

  test('not set up: the item fails with the note, nothing runs', async () => {
    const { onsen, cfg, codexLog, dir } = setup({ codexHome: '', childHome: '' } as any)
    cfg.codexHome = join(dir, 'empty-home'); cfg.childHome = join(dir, 'empty-home', 'home')
    expect(codexHomeReady(cfg)).toContain('--setup')
    onsen.push({ sender: 'chiron', payload: { text: 'x', msg_id: 2001 }, dedupe: 'msg:2001', call_id: '161' })
    const r = runner(cfg)
    await r.start()
    await until(done(onsen, '161'), 10_000, 'Call 161')
    expect(onsen.statesOf('161')).toEqual(['in_session', 'completed'])
    expect(onsen.sends.at(-1)!.payload.text).toContain('Codex 的專用設定還沒建好')
    expect(codexLog()).toEqual([])
  })

  test('--setup: a config with none of the personal setup, the model the runner\'s own (never the personal one), the login linked (never copied), the sessions carried over', () => {
    const d = mkdtempSync(join(tmpdir(), 'codex-runner-setup-'))
    tmps.push(d)
    const personal = join(d, 'personal')
    mkdirSync(join(personal, 'sessions', '2026', '11', '26'), { recursive: true })
    writeFileSync(join(personal, 'config.toml'), ['personality = "pragmatic"', 'model = "gpt-6.1-sol"', 'model_reasoning_effort = "medium"', 'notify = ["x"]',
      '[mcp_servers.node_repl]', 'command = "node"', '[plugins."context7@claude-plugins-official"]', 'enabled = true', ''].join('\n'))
    writeFileSync(join(personal, 'auth.json'), '{"tokens": "SECRET-NOT-PRINTED"}', { mode: 0o600 })
    writeFileSync(join(personal, 'sessions', '2026', '11', '26', 'rollout-2026-11-26T08-00-00-sess-aaa.jsonl'), '{"a":1}\n')
    writeFileSync(join(personal, 'sessions', '2026', '11', '26', 'rollout-2026-11-26T08-00-00-sess-zzz.jsonl'), '{"z":1}\n')
    const cfg: Cfg = { ...configFromEnv({ HOME: d, CODEX_RUNNER_AUTH_FROM: personal, CODEX_RUNNER_MODEL: 'gpt-6.2-astra', CODEX_RUNNER_EFFORT: 'high' }) }
    mkdirSync(cfg.stateDir, { recursive: true })
    writeFileSync(join(cfg.stateDir, 'state.json'), JSON.stringify({ v: 1, sessions: { 't:codex#t-1': { session_id: 'sess-aaa' } } }))
    const out = setupCodexHome(cfg)
    expect(out.join('\n')).not.toContain('SECRET')
    const conf = readFileSync(join(cfg.codexHome!, 'config.toml'), 'utf8')
    expect(conf).toContain('model = "gpt-6.2-astra"')
    expect(conf).toContain('model_reasoning_effort = "high"')
    expect(conf).not.toContain('gpt-6.1-sol')                                 // the personal config's model is never copied (Chiron mesh 13227)
    for (const no of ['mcp_servers', 'context7', 'personality', 'notify', 'node']) expect(conf).not.toContain(no)
    for (const yes of ['plugins = false', 'apps = false', 'hooks = false', 'memories = false', '[skills.bundled]', 'enabled = false', 'image_generation = true']) expect(conf).toContain(yes)
    expect(lstatSync(join(cfg.codexHome!, 'auth.json')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(cfg.codexHome!, 'auth.json'))).toBe(join(personal, 'auth.json'))
    expect(readlinkSync(join(cfg.codexHome!, 'auth.lock'))).toBe(join(personal, 'auth.lock'))
    expect(existsSync(join(cfg.childHome!))).toBe(true)
    expect(existsSync(join(cfg.codexHome!, 'sessions', '2026', '11', '26', 'rollout-2026-11-26T08-00-00-sess-aaa.jsonl'))).toBe(true)
    expect(existsSync(join(cfg.codexHome!, 'sessions', '2026', '11', '26', 'rollout-2026-11-26T08-00-00-sess-zzz.jsonl'))).toBe(false)
    expect(codexHomeReady(cfg)).toBeNull()
    const again = setupCodexHome(cfg)                                          // a second run keeps everything
    expect(again.filter(l => l.startsWith('kept'))).toHaveLength(3)
    expect(configFromEnv({ HOME: d, CODEX_RUNNER_CODEX_HOME: 'inherit' })).toMatchObject({ codexHome: null, childHome: null })
  })

  test('takes_work is declared at start; a member not there yet is asked again', async () => {
    const { onsen, cfg } = setup()
    onsen.profileStatus.push(404)
    const r = runner(cfg)
    await r.start()
    await until(() => onsen.profiles.length === 2, 5_000, 'two profile PUTs')
    expect(onsen.profiles).toEqual([{ takes_work: true }, { takes_work: true }])
    await Bun.sleep(300)
    expect(onsen.profiles).toHaveLength(2)
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
    onsen.push({ sender: 'chiron', payload: { text: 'SLEEP:0.8 work', msg_id: 901 }, dedupe: 'msg:901', call_id: '201' })
    await until(() => onsen.observations.some(o => o.sessions[0].activity === 'running'), 5_000, 'running')
    const run = onsen.observations.find(o => o.sessions[0].activity === 'running')
    expect(run.sessions[0].doing).toEqual({ kind: 'tool', tool: 'codex exec', since: run.sessions[0].turn.started_at })
    expect(run.sessions[0].turn.trigger).toEqual({ kind: 'other' })
    expect(run.main_session_id).toBe('main')
    expect(checkObservation(run)).toEqual([])
    // the Call's running is no earlier than the turn that holds it (Onsen's live evidence: a turn begun no later than the Call's start)
    await until(() => onsen.statesOf('201').includes('in_session'))
    const runPut = onsen.items.history.find(h => h.item_id === '201')!.body
    expect(Date.parse(run.sessions[0].turn.started_at)).toBeLessThanOrEqual(Date.parse(runPut.at))
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

const pm = (mid: number, over: Record<string, any> = {}): Record<string, any> => ({ message_id: String(mid), conversation_id: '7001', from: 'joey', via: 'telegram',
  text: 'hello', kind: 'text', sent_at: new Date().toISOString(), attachments: [],
  client: { name: 'telegram', chat: '1828173984', msg_id: String(mid - 7000), user: 'Advac777', user_id: '1828173984' }, reply_to: null, ...over })
const NEW_STYLE_KEYS = ['attachment_file_ids', 'body', 'conversation_id', 'idem_key', 'reply_to_message_id', 'sender', 'sent_at', 'turn_id']

describe('a person\'s message (person_message, WO-196 stage one)', () => {
  test('from Telegram with a photo: run in its conversation\'s folder, answered new-style into the conversation, the facts on its Telegram numbers', async () => {
    const { onsen, cfg, codexLog } = setup()
    const photo = onsen.file('31', 'photo.png', PNG)
    const row = onsen.pushPerson(pm(8001, { text: '照這張改 IMG:out.png', kind: 'photo',
      attachments: [{ kind: 'photo', name: 'photo.png', mime: 'image/png', bytes: PNG.length, url: photo, client_ref: 'AgACAgUAAx0' }],
      client: { name: 'telegram', chat: '1828173984', msg_id: '4711', user: 'Advac777', user_id: '1828173984' },
      reply_to: { message_id: '7990', client_msg_id: '4700', from: 'codex', text: 'the earlier picture' }, reply_quote: 'the water' }))
    row.call_id = 'photo-call'
    onsen.items.scheduleCalls.set(row.call_id, { id: row.call_id, run: '', result: null })
    const r = runner(cfg)
    await r.start()
    await until(() => onsen.statesOf('pm:8001').includes('completed') && r.state.jobs[0]?.state === 'done', 10_000, 'turn_end')
    const folder = join(cfg.root, '7001', 'dm')
    const start = codexLog().find(x => x.ev === 'start')
    expect(start.dir).toBe(folder)
    expect(start.images).toEqual([join(folder, 'photo.png')])
    expect(start.text).toContain('照這張改')
    expect(start.text).toContain('（這一則回覆 codex 的一則訊息：「the earlier picture」）')
    expect(start.text).toContain('（引用其中這一段：「the water」）')
    // the answer: new-style into the conversation (Onsen 0.35.0), none of the old record's fields
    expect(onsen.records).toHaveLength(1)
    const rec = onsen.records[0]
    expect(Object.keys(rec).sort()).toEqual(NEW_STYLE_KEYS)
    expect(rec).toMatchObject({ conversation_id: '7001', reply_to_message_id: '8001', sender: 'main' })
    expect(rec.idem_key).toBe('codex:out:item:pm:8001')
    expect(rec.turn_id).toBe('codex-j1')
    expect(Number.isNaN(Date.parse(rec.sent_at))).toBe(false)
    expect(rec.body).toContain('answer to: 照這張改')
    expect(rec.attachment_file_ids.map((id: string) => onsen.files.get(id)!.name)).toEqual(['out.png'])
    expect(onsen.items.scheduleCalls.get('photo-call')!.result).toMatchObject({ outcome: 'ok', attachment_file_ids: rec.attachment_file_ids })
    expect(onsen.items.rows.get('pm:8001')!.response_message_ids).toEqual(['5001'])
    expect(onsen.sends).toEqual([])
    expect(onsen.observations.some(o => o.sessions[0].turn?.trigger?.kind === 'message' && o.sessions[0].turn.trigger.message_id === '8001'
      && o.sessions[0].turn.trigger.conversation_id === '7001')).toBe(true)
    expect(r.state.jobs[0]).toMatchObject({ source: 'person', key: 'say:1828173984' })
  })

  test('no text: a photo with a url is handed over, one only Telegram has (url null) is named as not available; neither is dropped', async () => {
    const { onsen, cfg, codexLog } = setup()
    const photo = onsen.file('32', 'cat.png', PNG)
    onsen.pushPerson(pm(8101, { text: '', kind: 'photo', attachments: [{ kind: 'photo', name: 'cat.png', mime: 'image/png', bytes: PNG.length, url: photo, client_ref: 'AgAC1' }] }))
    onsen.pushPerson(pm(8102, { text: '', kind: 'photo', attachments: [{ kind: 'photo', name: null, mime: null, bytes: null, url: null, client_ref: 'AgAC2' }] }))
    const r = runner(cfg)
    await r.start()
    await until(() => onsen.records.length === 2 && r.state.jobs.every(j => j.state === 'done'), 10_000, 'two answers')
    const starts = codexLog().filter(x => x.ev === 'start')
    expect(starts).toHaveLength(2)
    const folder = join(cfg.root, '7001', 'dm')
    expect(starts[0].images).toEqual([join(folder, 'cat.png')])
    expect(starts[0].text.split('\n')[0]).toBe('（只有附件）')
    expect(starts[1].images).toEqual([])
    expect(starts[1].text).toContain('（附件 一個沒有檔名的 photo 拿不到：沒有網址，Onsen 沒存那個檔，只在 telegram 上）')
    expect(starts[1].resume).toBe(readEvents(join(folder, '.codex-runner', 'run-1.jsonl')).session)   // one conversation, one session
    expect(onsen.records.every(x => x.conversation_id === '7001' && !('chat' in x) && !('client' in x))).toBe(true)
  })

  test('Onsen not taking the new-style write for a moment: written again later, once; given twice, one job', async () => {
    const { onsen, cfg, codexLog } = setup()
    onsen.newStyleStatus.push(503)
    onsen.pushPerson(pm(8401, { text: 'again' }))
    onsen.pushPerson(pm(8401, { text: 'again' }))
    const r = runner(cfg)
    await r.start()
    await until(() => onsen.records.length === 1 && r.state.jobs[0]?.state === 'done', 10_000, 'written')
    await Bun.sleep(300)
    expect(onsen.records).toHaveLength(1)
    expect(r.state.jobs).toHaveLength(1)
    expect(codexLog().filter(x => x.ev === 'start')).toHaveLength(1)
    expect(r.stats.reports_retried).toBeGreaterThanOrEqual(1)
  })
})

describe('restart', () => {
  test('a run that went on through a restart is followed to its end; reported once', async () => {
    const { onsen, cfg } = setup()
    onsen.push({ sender: 'chiron', payload: { text: 'SLEEP:1.5 IMG:later.png', msg_id: 1001 }, dedupe: 'msg:1001', call_id: '301' })
    const a = runner(cfg)
    await a.start()
    await until(() => onsen.statesOf('301').includes('in_session'), 5_000, 'running')
    runners.splice(runners.indexOf(a), 1)
    await a.stop()                                                            // a clean stop: offline; codex goes on
    expect(onsen.items.rows.get('301')!.state).toBe('claimed')
    const b = runner(cfg)
    await b.start()
    await until(done(onsen, '301'), 10_000, 'Call 301')
    expect(onsen.statesOf('301')).toEqual(['in_session', 'completed'])
    const fin = onsen.sends.at(-1)!
    expect(fin.attachment_file_ids).toHaveLength(1)
    await until(() => onsen.sends.length >= 1, 5_000, 'the reply')            // the reply goes after the Call's state
    await Bun.sleep(300)
    expect(onsen.sends).toHaveLength(1)                                       // once: the stopped runner sent nothing
  })

  test('legacy open jobs block cutover before any HTTP request; terminal history and sessions survive', async () => {
    const { onsen, cfg } = setup()
    const old = { v: 1, seq: 1, jobs: [{ id: 'j1', state: 'finishing' }], sessions: { 't:old': { runs: 1 } } }
    mkdirSync(cfg.stateDir, { recursive: true })
    const file = join(cfg.stateDir, 'state.json')
    writeFileSync(file, JSON.stringify(old))
    await expect(runner(cfg).start()).rejects.toThrow('Drain unfinished jobs')
    expect(onsen.paths).toEqual([])
    old.jobs[0]!.state = 'done'
    writeFileSync(file, JSON.stringify(old))
    const next = runner(cfg)
    await next.start()
    expect(next.state.sessions['t:old']!.runs).toBe(1)
  })
})

for (const recording of [true, false]) test('a Codex intake outage alerts the owner and is visible over /healthz, recording=' + recording, async () => {
  const { cfg, onsen, log } = setup({ record: recording, owner: 'test-ops' })
  onsen.items.mode(409)
  onsen.items.add('unclaimed')
  const r = runner(cfg)
  await r.start()
  const reason = recording ? 'not_take_member' : 'recording_off'
  await until(() => onsen.records.length > 0)
  expect(log.some(line => line.includes(reason))).toBe(true)
  const port = readFileSync(join(cfg.stateDir, 'health-port'), 'utf8')
  const health = await (await fetch('http://127.0.0.1:' + port + '/healthz')).json()
  expect(health.take).toEqual({ state: recording ? 'pull-refused' : 'off', active: false, reason, held: [] })
  expect(onsen.records).toEqual([expect.objectContaining({ to: 'test-ops', sender: 'system:alert', body: expect.stringContaining(reason) })])
  expect(onsen.paths.filter(p => p.endsWith('/items'))).toHaveLength(recording ? 1 : 0)
  expect(onsen.items.rows.get('unclaimed')!.state).toBe('waiting')
})

test('a pending terminal report survives restart and precedes the next take', async () => {
  const { cfg, onsen, codexLog } = setup({ max: 1 })
  const row = onsen.pushPerson(pm(42, { text: 'SLEEP:0.4 first', via: 'web' }))
  const a = runner(cfg)
  await a.start()
  await until(() => !!row.in_session_at)
  onsen.items.holdReports(true)
  await until(() => a.state.jobs[0]?.state === 'done')
  expect(onsen.records).toHaveLength(1)
  await a.stop({ offline: false })
  onsen.pushPerson(pm(43, { text: 'second' }))
  onsen.items.holdReports(false)
  const b = runner(cfg)
  await b.start()
  await until(() => onsen.statesOf('pm:43').includes('completed'))
  const history = onsen.items.history.map(h => h.item_id + '/' + h.body.outcome)
  expect(history).toEqual(['pm:42/in_session', 'pm:42/completed', 'pm:43/in_session', 'pm:43/completed'])
  expect(row.response_message_ids).toEqual(['5001'])
  expect(row.claim).toBeNull()
  expect(onsen.records).toHaveLength(2)
  expect(codexLog().filter(x => x.ev === 'start')).toHaveLength(2)
  expect(onsen.observations.some(o => o.connector === 'macmini/codex' && o.held_item_ids.includes(row.id))).toBe(true)
  expect(onsen.items.calls.filter(c => c.path.endsWith('/report')).every(c => c.body.claim_id && c.key)).toBe(true)
})

test('an unsupported control and a silent bell settle without starting codex', async () => {
  const { cfg, onsen, codexLog } = setup()
  const control = onsen.items.add('press', 'control')
  const bell = onsen.items.add('silent', 'mail', { payload: { urgency: 'silent' } })
  await runner(cfg).start()
  await until(() => control.state === 'cancelled' && bell.state === 'completed')
  expect(onsen.statesOf('press')).toEqual(['not_applied'])
  expect(codexLog()).toEqual([])
})

test('alerts and schedules complete with their Call result and no peer reply', async () => {
  const { cfg, onsen } = setup()
  for (const kind of ['alert', 'schedule']) {
    const call = 'c-' + kind
    onsen.items.scheduleCalls.set(call, { id: call, run: kind === 'schedule' ? '700' : '', result: null })
    onsen.items.add(kind, kind, { call_id: kind === 'alert' ? call : null, refs: [{ kind: 'run', value: '700' }],
      payload: { text: kind === 'alert' ? 'FAIL alert' : 'schedule work' } })
  }
  await runner(cfg).start()
  await until(() => ['alert', 'schedule'].every(id => onsen.statesOf(id).includes('completed')))
  expect(onsen.items.scheduleCalls.get('c-alert')!.result.outcome).toBe('failed')
  expect(onsen.items.scheduleCalls.get('c-schedule')!.result.outcome).toBe('ok')
  expect(onsen.sends).toHaveLength(0)
  expect(onsen.records).toHaveLength(0)
})

test('acceptance binds before downloads and a paused probe keeps renewing the held claim', async () => {
  const { cfg, onsen, codexLog } = setup({ heartbeatMs: 75, now: () => Date.now() + 21_000 })
  const row = onsen.push({ sender: 'eve', call_id: 'slow', payload: { text: 'check', msg_id: 71 },
    attachments: [{ name: 'slow.txt', url: onsen.base + '/v1/files/slow' }] })
  let release!: () => void
  const downloading = new Promise<void>(resolve => release = resolve)
  const r = runner(cfg)
  r.onsen.download = async () => { await downloading; return { ok: false, why: 'no file' } }
  await r.start()
  try {
    await until(() => !!row.in_session_at)
    expect(codexLog()).toEqual([])
    onsen.items.mode(409); onsen.items.add('wake-peek', 'mail')
    await until(() => !(r.health().take as any).active)
    for (let n = 0; n < 2; n++) {
      const before = row.claim!.expires_at
      onsen.items.advance(25_000)
      await until(() => row.claim?.expires_at !== before)
    }
    expect(row.state).toBe('claimed')
    expect(onsen.observations.at(-1).held_item_ids).toContain(row.id)
  } finally { release() }
  await until(done(onsen, 'slow'))
  expect(onsen.statesOf('slow')).toEqual(['in_session', 'completed'])
})

for (const person of [true, false]) test('2xx missing the reply ID is bounded across restart and releases the worker, person=' + person, async () => {
  const { cfg, onsen, codexLog } = setup({ max: 1, retryMs: 200 })
  onsen.personWithoutId = person
  onsen.replyMessageId = null
  const first = person ? onsen.pushPerson(pm(62, { text: 'first' }))
    : onsen.push({ sender: 'eve', call_id: 'bad-ack', payload: { text: 'first', msg_id: 62 } })
  const a = runner(cfg)
  await a.start()
  await until(() => a.state.jobs[0]?.missing_reply_ids === 1)
  await a.stop({ offline: false })
  onsen.items.add('next', 'alert', { payload: { text: 'next job' } })
  const b = runner(cfg)
  await b.start()
  await until(() => onsen.statesOf('next').includes('completed'))
  expect(onsen.statesOf(first.id)).toEqual(['in_session', 'completed'])
  expect(onsen.items.history.find(h => h.item_id === first.id && h.body.outcome === 'completed')?.body)
    .toMatchObject({ response_message_ids: [], note: expect.stringContaining('no valid reply message ID') })
  expect(onsen.paths.filter(p => p === (person ? '/v1/messages' : '/send'))).toHaveLength(3)
  expect(person ? onsen.records : onsen.sends).toHaveLength(1)
  expect(codexLog().filter(l => l.ev === 'start')).toHaveLength(2)
  expect(b.busy()).toHaveLength(0)
})

test('a file upload returning 2xx without a file ID is retried three times and listed in the answer', async () => {
  const { cfg, onsen } = setup()
  onsen.push({ sender: 'eve', call_id: 'file-ack', payload: { text: 'IMG:output.png', msg_id: 74 } })
  const r = runner(cfg)
  let uploads = 0
  r.onsen.upload = async () => { uploads++; return { status: 201, json: {} } }
  await r.start()
  await until(done(onsen, 'file-ack'))
  expect(uploads).toBe(3)
  expect(onsen.reply('file-ack').payload.text).toContain('output.png（Onsen 未回傳檔案 ID）')
  expect(r.busy()).toHaveLength(0)
})

test('the same item given twice is one job; an attachment off Onsen\'s origin is not fetched with the credential', async () => {
  const { onsen, cfg, codexLog } = setup()
  let leaked = 0
  const other = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: req => { if (req.headers.get('authorization')) leaked++; return new Response(PNG) } })
  try {
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

describe('the folder', () => {
  test('what a run made: new and changed files, not hidden ones, not last-<n>.txt; at most 20, each within the limit', async () => {
    const { onsen, cfg } = setup({ maxFileBytes: 1000 })
    process.env.FAKE_CODEX_BIG = '5000'
    onsen.push({ sender: 'chiron', payload: { text: 'MANY:22 BIG:huge.bin', msg_id: 1401 }, dedupe: 'msg:1401', call_id: '701' })
    const r = runner(cfg)
    await r.start()
    await until(done(onsen, '701'), 10_000, 'Call 701')
    const fin = onsen.sends.at(-1)!
    expect(fin.attachment_file_ids).toHaveLength(20)
    expect(fin.payload.text).toContain('huge.bin（超過 1000 bytes，沒有附上）')
    expect(fin.payload.text).toContain('（超過 20 個，沒有附上）')
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

  test('ops alerts use the configured owner or a mapped, allowlisted ops recipient', () => {
    const { dir } = setup()
    writeFileSync(join(dir, 'access.json'), JSON.stringify({ allowFrom: ['1828173984', '6736970916'], alertTo: ['6736970916'] }))
    const env = { HOME: dir, TELEGRAM_STATE_DIR: dir }
    expect(configFromEnv(env).owner).toBe('joey-test')
    expect(configFromEnv({ ...env, ONSEN_OWNER: 'test-ops' }).owner).toBe('test-ops')
  })
})
