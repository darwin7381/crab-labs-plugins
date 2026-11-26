// WO-180 end to end: real Telegram daemons (server.ts) against Bot API stand-ins and one stand-in Onsen that takes PUT
// /api/onsen/v1/members/<agent>/observation (fleet-core onsen_v1_members.py put_observation's shape: the observation as the JSON body, the agent's own
// mesh credential; a 400 is {error:{code, message, retryable}}). Three daemons at once, temp dirs only; nothing reaches Telegram or Onsen:
//   adam  ONSEN_OBSERVATION=adam (env): the first one at start, with the credential /status/batch uses, the body the object /healthz shows (its ten fields);
//         unchanged, one every 15 s with a new reported_at; /healthz onsen.status.put; /status/batch goes on as before
//   bea   ONSEN_OBSERVATION=* (env), Onsen answers 400 invalid_request: rejected counted, one line of run/screen-exceptions.jsonl (observation_rejected),
//         the same one not sent again and again
//   cyd   the machine config's ONSEN_OBSERVATION does not list it: nothing sent; the line changed to list it: sent, without a restart (re-read as JEV_SCREEN)
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, freePort, sleep, type TgDaemon } from './test-fixtures/tg-daemon.ts'
import { checkObservation } from './test-fixtures/status-v1-check.ts'
import { changeKey } from './onsen-observation.ts'

const JOEY = 1828
const CRED = 'mesh_OBSERVATIONsecretSECRETsecretSECRET01'
const KEYS = ['presence', 'presence_reason', 'lifecycle', 'main_session_id', 'sessions', 'background', 'queue', 'last_activity_at', 'reported_at', 'evidence']
const REJECT = '觀測不合法：sessions[0].turn.trigger.message_id：帶起這個回合的那一則（Onsen 訊息 ID，或那一則的 client_msg_id）'
let apis: BotApiMock[] = [], onsen: ReturnType<typeof Bun.serve> | null = null, root = '', onsenPort = 0
const puts: Array<{ agent: string; auth: string | null; type: string; body: any; at: number }> = []
const status: Array<{ agent: string; at: number }> = []
const ds: TgDaemon[] = []
beforeAll(async () => {
  onsenPort = await freePort()
  onsen = Bun.serve({ port: onsenPort, hostname: '127.0.0.1', async fetch(req) {
    const path = new URL(req.url).pathname.replace(/^\/api\/onsen/, '')
    const m = path.match(/^\/v1\/members\/([^/]+)\/observation$/)
    if (m && req.method === 'PUT') {
      puts.push({ agent: m[1]!, auth: req.headers.get('authorization'), type: req.headers.get('content-type') ?? '', body: await req.json(), at: Date.now() })
      if (m[1] === 'bea') return Response.json({ error: { code: 'invalid_request', message: REJECT, retryable: false } }, { status: 400 })
      return Response.json({ api_version: '1', data: { name: m[1] } })
    }
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    if (path === '/status/batch') for (const it of body.items ?? []) status.push({ agent: it.agent, at: Date.now() })
    if (path === '/status') return Response.json({ agents: [] })
    return Response.json({ results: (body?.items ?? []).map(() => ({ id: 1, duplicate: false })) })
  } })
  root = mkdtempSync(join(tmpdir(), 'onsen-observation-daemon-'))
  mkdirSync(join(root, 'cred'), { recursive: true }); writeFileSync(join(root, 'cred', 'c'), CRED + '\n')
  apis = [0, 1, 2].map(() => startBotApiMock({}, { pollHoldMs: 300 }))
  mkdirSync(join(root, 'cyd'), { recursive: true })
  writeFileSync(join(root, 'cyd', 'no-machine-config'), 'ONSEN_OBSERVATION=someone-else\n')   // the fixture's machine config path for this root
}, 30000)
afterAll(async () => { for (const d of ds) await d.stop(); for (const a of apis) a.stop(); onsen?.stop(true) })
const env = (agent: string, o: Record<string, string> = {}) => ({ GENESIS_LANES: '0', LANES_AGENT: agent, AGENT_INBOX_SELF: agent, ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`,
  ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'c'), ONSEN_PEER_LOOKUP: '0', ONSEN_REGISTRY_CLI: '0', ...o })
const of = (agent: string) => puts.filter(p => p.agent === agent)
const health = async (d: TgDaemon): Promise<any> => (await fetch(`http://127.0.0.1:${d.port}/healthz`).then(r => r.json()) as any).onsen.status
const lines = (f: string): any[] => { try { return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }

test('ONSEN_OBSERVATION: the observation /healthz shows goes to Onsen at start, at a change and every 15 s; a 400 is written once; off sends nothing; the machine config line is re-read', async () => {
  const [adam, bea, cyd] = await Promise.all([
    startTgDaemon(apis[0]!, join(root, 'adam'), JOEY, env('adam', { ONSEN_OBSERVATION: 'adam' })),
    startTgDaemon(apis[1]!, join(root, 'bea'), JOEY, env('bea', { ONSEN_OBSERVATION: '*' })),
    startTgDaemon(apis[2]!, join(root, 'cyd'), JOEY, env('cyd')),
  ])
  ds.push(adam, bea, cyd)
  // adam: the first one, as the agent, with its credential, a JSON body of exactly the ten fields that passes the contract's checker
  expect(await until(() => of('adam').length >= 1, 8000)).toBe(true)
  const first = of('adam')[0]!
  expect({ auth: first.auth, type: first.type, keys: Object.keys(first.body) }).toEqual({ auth: `Bearer ${CRED}`, type: 'application/json', keys: KEYS })
  expect(checkObservation(first.body)).toEqual([])
  // the body is the object /healthz shows (reported_at aside: /healthz holds the one handed out last, every 2 s)
  let same = false
  for (let i = 0; i < 40 && !same; i++) { const h = await health(adam); same = !!h.observation && changeKey(h.observation) === changeKey(of('adam').at(-1)!.body); if (!same) await sleep(100) }
  expect(same).toBe(true)
  const h0 = await health(adam)
  expect(h0.put).toEqual({ on: true, sent: expect.any(Number), rejected: 0, last_ok_at: expect.any(String), last_status: 200, last_error: null })
  expect(h0.put.sent).toBeGreaterThanOrEqual(1)
  expect(status.some(s => s.agent === 'adam')).toBe(true)                                     // /status/batch as before
  expect(adam.log()).toContain('onsen: observation on for adam')
  // bea: 400 → rejected, one exception line, not sent again and again
  expect(await until(async () => (await health(bea)).put?.rejected >= 1, 8000)).toBe(true)
  const exc = join(bea.ws, '.lanes', 'run', 'screen-exceptions.jsonl')
  expect(lines(exc)).toEqual([{ ts: expect.any(String), agent: 'bea', kind: 'observation_rejected', kinds: ['observation_rejected'], status: 400, code: 'invalid_request',
    message: REJECT, observation: expect.objectContaining({ reported_at: expect.any(String) }) }])
  expect((await health(bea)).put).toMatchObject({ on: true, rejected: expect.any(Number), last_status: 400, last_ok_at: null, last_error: `invalid_request: ${REJECT}` })
  // cyd: its machine config does not list it: nothing sent
  await sleep(1500)
  expect(of('cyd')).toEqual([])
  expect((await health(cyd)).put).toEqual({ on: false, sent: 0, rejected: 0, last_ok_at: null, last_status: null, last_error: null })
  expect(status.some(s => s.agent === 'cyd')).toBe(true)
  writeFileSync(join(root, 'cyd', 'no-machine-config'), 'ONSEN_OBSERVATION=adam,cyd\n')          // listed now: taken at the next re-read (≤ 30 s), no restart
  // adam unchanged: one every 15 s, each with a new reported_at (the record computed again)
  const t0 = Date.now()
  expect(await until(() => {
    const a = of('adam'), i = a.findIndex((p, k) => k > 0 && p.at > t0 - 20_000 && changeKey(p.body) === changeKey(a[k - 1]!.body))
    return i > 0
  }, 40_000)).toBe(true)
  const a = of('adam')
  const pairs = a.map((p, k) => k > 0 && changeKey(p.body) === changeKey(a[k - 1]!.body) ? [a[k - 1]!, p] : null).filter(Boolean) as Array<[typeof a[0], typeof a[0]]>
  for (const [x, y] of pairs) {
    const gap = y.at - x.at, rep = Date.parse(y.body.reported_at) - Date.parse(x.body.reported_at)
    console.log(`adam unchanged: ${gap} ms between two, reported_at ${rep} ms apart`)
    expect(gap).toBeGreaterThanOrEqual(14_500); expect(gap).toBeLessThan(16_500)
    expect(Math.abs(rep - gap)).toBeLessThan(1_000)
  }
  // bea: one exception line, and its PUTs were the changes and the beats only (not a retry loop)
  expect(lines(exc)).toHaveLength(1)
  expect(of('bea').length).toBeLessThan(10)
  expect((await health(bea)).put.rejected).toBe(of('bea').length)
  // cyd: on without a restart
  expect(await until(() => of('cyd').length >= 1, 35_000)).toBe(true)
  expect(of('cyd')[0]!.auth).toBe(`Bearer ${CRED}`)
  expect(cyd.log()).toContain('onsen: observation on for cyd')
  expect((await health(cyd)).put).toMatchObject({ on: true, last_status: 200 })
}, 120_000)
