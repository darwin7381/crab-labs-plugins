// WO-165 A end to end: a real Telegram daemon (server.ts) with JEV_SCREEN on, its main's pane a tmux pane of a PRIVATE tmux server, a stand-in TypeSafe
// and a stand-in Onsen (local HTTP servers). What reaches Onsen is Jev's reading of that pane (judged_by: jev), and it follows the pane within the poll;
// every call is in <workspace>/.lanes/run/jev-calls.jsonl with its usage.
// The machine's own tmux server is never touched. 2026-11-25 19:02Z and 19:07Z the first version of this test killed the Mac mini's real server (every
// agent's session with it): it relied on TMUX_TMPDIR, but a shell inside tmux has TMUX set, and tmux without -S / -L uses $TMUX first. Now every tmux call
// of this test names its socket (-S, a file in the test's temp dir), runs without TMUX in its env, and the server is only ever killed through that socket.
// The daemon runs with an env that has no TMUX (startTgDaemon builds its env from scratch) and TMUX_TMPDIR pointing at the same private directory.
// WO-169: /healthz onsen.status is the record Onsen holds (state, since, at, detail, last_activity_at, field by field); screen_status.answer is the
// ScreenVerdict; run/screen-verdicts.jsonl gets one line per new screen. A second daemon (bea, lanes on, LANES_WAKE_DECIDE, ONSEN_WAKE_LOG): with a menu
// on its pane a colleague's call is decided by the record (waiting: held) and its wake row carries member_state waiting. A third (cyd, SCREEN_JUDGE=
// program): no judge, statusOf's view judged_by program, Jev never asked.
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, freePort, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const HAS_TMUX = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0
const JOEY = 1828
const CRED = 'mesh_SCREENDAEMONsecretSECRETsecret01234'
const R = '─'.repeat(60)
const IDLE = ['⏺ Done.', '', '✻ Worked for 17s · done 1:37 AM', '', R, '❯ ', R, '  Opus 5.5 · 7d 71%', '  ⏵⏵ bypass permissions on'].join('\n')
const MENU = ['   Select model', '     1. Default (recommended)', '   ❯ 2. Opus', '   Enter to set as default · Esc to cancel'].join('\n')
let api: BotApiMock, d: TgDaemon | null = null
let onsen: ReturnType<typeof Bun.serve> | null = null, jev: ReturnType<typeof Bun.serve> | null = null
const got: Array<{ item: any; at: number }> = []
const wakes: any[] = []
const asked: Array<{ body: any; at: number }> = []
let root = '', tmuxEnv: Record<string, string> = {}, sock = '', onsenPort = 0, jevPort = 0
/** this test's private tmux server only: an explicit socket under the temp dir, TMUX removed from the env */
const tmux = (...a: string[]) => {
  if (!sock || !sock.startsWith(root + '/') || !root.startsWith(tmpdir())) throw new Error('refusing to run tmux outside the test socket')
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...tmuxEnv }
  delete env.TMUX; delete env.TMUX_PANE
  return spawnSync('tmux', ['-S', sock, ...a], { encoding: 'utf8', env })
}
const show = (text: string) => { writeFileSync(join(root, 'screen.txt'), text); return tmux('respawn-pane', '-k', '-t', 'jevtest-adam', `cat ${join(root, 'screen.txt')}; exec sleep 3600`) }
const statuses = (agent = 'adam') => got.map(g => g.item).filter(i => i.agent === agent)
/** Onsen's member_status_now for an agent, as fleet-core onsen3.py keeps it from the reports it took: the latest report (by at; one at a time, an
 *  older one ignored), since = the at of the first report of its state, last_activity_at = the newest non-null one */
function onsenNow(agent: string): any {
  let now: any = null
  for (const it of statuses(agent)) {
    if (now && it.at < now.at) continue
    const changed = !now || now.state !== it.state
    now = { state: it.state, since: changed ? it.at : now.since, at: it.at, detail: it.detail ?? {}, last_activity_at: it.last_activity_at ?? now?.last_activity_at ?? null }
  }
  return now
}
/** a main registered in Claude Code's session registry of a daemon's HOME (a `sleep` stands for its process): statusOf finds it (offline not_connected
 *  while no stream of it is open here), so the record is no longer "starting" (WO-169, Chiron 00:29Z: no_registration with Claude Code in the pane) */
const procs: Array<ReturnType<typeof Bun.spawn>> = []
function register(dir: string): void {
  const p = Bun.spawn(['sleep', '600']); procs.push(p)
  const lstart = String(spawnSync('ps', ['-o', 'lstart=', '-p', String(p.pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).stdout).trim()
  mkdirSync(join(dir, 'home', '.claude', 'sessions'), { recursive: true })
  writeFileSync(join(dir, 'home', '.claude', 'sessions', `${p.pid}.json`), JSON.stringify({ pid: p.pid, sessionId: crypto.randomUUID(), cwd: join(dir, 'ws'), startedAt: Date.now(),
    procStart: lstart, version: '2.1.322', kind: 'interactive', entrypoint: 'cli', status: 'idle', updatedAt: Date.now(), statusUpdatedAt: Date.now() }))
}
const lines = (f: string): any[] => { try { return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }

beforeAll(async () => {
  if (!HAS_TMUX) return
  root = mkdtempSync(join(tmpdir(), 'screen-daemon-'))
  // the daemon (no TMUX in its env) finds the server at $TMUX_TMPDIR/tmux-<uid>/default: the test's socket is that path
  tmuxEnv = { TMUX_TMPDIR: join(root, 'tmux') }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  mkdirSync(join(tmuxEnv.TMUX_TMPDIR!, `tmux-${uid}`), { recursive: true, mode: 0o700 })
  sock = join(tmuxEnv.TMUX_TMPDIR!, `tmux-${uid}`, 'default')
  writeFileSync(join(root, 'screen.txt'), IDLE)
  expect(tmux('new-session', '-d', '-s', 'jevtest-adam', '-x', '100', '-y', '30', `cat ${join(root, 'screen.txt')}; exec sleep 3600`).status).toBe(0)
  api = startBotApiMock({}, { pollHoldMs: 300 })
  onsenPort = await freePort(); jevPort = await freePort()
  onsen = Bun.serve({ port: onsenPort, hostname: '127.0.0.1', async fetch(req) {
    const path = new URL(req.url).pathname.replace(/^\/api\/onsen/, '')
    const body = req.method === 'POST' ? await req.json() : undefined
    if (path === '/status/batch') for (const it of body.items) got.push({ item: it, at: Date.now() })
    if (path === '/wake/batch') for (const it of body.items) wakes.push(it)
    return Response.json({ results: (body?.items ?? []).map(() => ({ id: 1, duplicate: false })) })
  } })
  jev = Bun.serve({ port: jevPort, hostname: '127.0.0.1', async fetch(req) {
    const body = await req.json()
    asked.push({ body, at: Date.now() })
    const menu = String(body.state?.screen_bottom ?? '').includes('Select model')
    const choice = (c: string, p = 0.9) => ({ type: 'choice', choice: c, confidence: p, probabilities: { [c]: p } })
    return Response.json({ model: 'jev-1.14.0', usage: { input_tokens: 2000, output_tokens: 30 },
      answers: { state: choice(menu ? 'waiting_for_human' : 'idle'), fits_any: { type: 'noul', noul: 0.9 }, menu: choice(menu ? 'model_picker' : 'none') } })
  } })
  const q = { version: 1, model: 'jev-1.14.0', setting: 'S', publish_when_state_probability_at_least: 0.6, questions: {
    state: { type: 'choice', instructions: 'x', criteria: { working: 'a', idle: 'b', waiting_for_human: 'c', other: 'd' } }, fits_any: { type: 'noul', instructions: 'y' },
    menu: { type: 'choice', instructions: 'z', criteria: { none: 'n', model_picker: 'm', other: 'o' } } } }
  writeFileSync(join(root, 'questions.json'), JSON.stringify(q))
  mkdirSync(join(root, 'cred'), { recursive: true }); writeFileSync(join(root, 'cred', 'mesh-credential'), CRED + '\n')
  // the duty officer off for every pane; the stand-in pane runs `sleep`, which counts as Claude Code here (its config's claude_cmds)
  mkdirSync(join(root, 'd', 'home', '.claude', 'duty-officer'), { recursive: true })
  writeFileSync(join(root, 'd', 'home', '.claude', 'duty-officer', 'config.json'), JSON.stringify({ enabled: [], claude_cmds: ['sleep'] }))
  d = await startTgDaemon(api, join(root, 'd'), JOEY, { GENESIS_LANES: '0', ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'mesh-credential'),
    ONSEN_PEER_LOOKUP: '0', ONSEN_REGISTRY_CLI: '0', CHANNEL_BOT_TMUX_SESSION: 'jevtest-adam', ...tmuxEnv, JEV_SCREEN: 'adam', JEV_SCREEN_QUESTIONS: join(root, 'questions.json'),
    TYPESAFE_API_KEY: 'test-key-not-real', TYPESAFE_KEY_FILE: '', TYPESAFE_BASE_URL: `http://127.0.0.1:${jevPort}` })
}, 40000)
afterAll(async () => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } await d?.stop(); api?.stop(); onsen?.stop(true); jev?.stop(true); if (HAS_TMUX && root) tmux('kill-server') })

test.skipIf(!HAS_TMUX)("JEV_SCREEN on: Onsen gets Jev's reading of the pane, it follows the pane within the poll, and every call is logged", async () => {
  // no registration (no session file under the daemon's HOME): statusOf says offline no_registration, Claude Code runs in the pane → asked; WO-169
  // (Chiron 00:29Z): the process is there and not registered yet: starting, before anything the screen says
  expect(await until(() => statuses().some(s => s.detail?.judged_by === 'jev'), 15000)).toBe(true)
  const first = statuses().find(s => s.detail?.judged_by === 'jev')
  expect(first).toMatchObject({ agent: 'adam', state: 'starting', detail: { judged_by: 'jev', judge_p: 0.9, program_offline: 'no_registration' } })
  // the main registers (not connected: no stream of it here): Jev's idle, with the reason statusOf has
  register(join(root, 'd'))
  expect(await until(() => statuses().at(-1)?.state === 'idle' && statuses().at(-1)?.detail?.program_offline === 'not_connected', 10000)).toBe(true)
  expect(asked[0]!.body).toMatchObject({ model: 'jev-1.14.0', state: { setting: 'S', has_input_box: true, claude_process_alive: true, counted_by_program: { running_agents: 0, shells: 0, monitors: 0 } } })
  expect(Object.keys(asked[0]!.body.questions).sort()).toEqual(['fits_any', 'menu', 'state'])
  // the screen unchanged: no new call
  const n = asked.length
  await new Promise(r => setTimeout(r, 2500))
  expect(asked.length).toBe(n)
  // a menu opens: no event of statusOf's (it stays offline), only the poll sees it
  const t0 = Date.now()
  expect(show(MENU).status).toBe(0)
  expect(await until(() => statuses().some(s => s.state === 'waiting' && s.detail?.waitingFor === 'model_picker'), 8000)).toBe(true)
  const ms = got.find(g => g.item.state === 'waiting')!.at - t0
  console.log(`pane change → status at the stand-in Onsen, no event (ms): ${ms}`)
  expect(ms).toBeLessThan(2000)
  const calls = readFileSync(join(d!.ws, '.lanes', 'run', 'jev-calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(c => c.site === 'screen-status')
  expect(calls.length).toBe(asked.length)
  expect(calls[0]).toMatchObject({ usage: { input_tokens: 2000 }, model: 'jev-1.14.0', err: null, question: { version: 1 } })
  expect(d!.log()).toContain('screen-status: ON for adam (judge jev')
  const h = await fetch(`http://127.0.0.1:${d!.port}/healthz`).then(r => r.json()) as any
  expect(h.onsen?.status?.screen_status).toMatchObject({ on: true, poll_ms: 1000, judge: 'jev' })
  // WO-169: the verdict in use as its four fields (Jev's raw answer stays in jev-calls.jsonl)
  expect(h.onsen.status.screen_status.answer).toEqual({ state: 'waiting_for_human', menu: 'model_picker', p: 0.9, by: 'jev' })
  // WO-169: onsen.status is the record Onsen holds, field by field, once nothing is in flight (the spool has sent the last report)
  let same = false, hz: any = null
  for (let i = 0; i < 40 && !same; i++) {
    hz = (await fetch(`http://127.0.0.1:${d!.port}/healthz`).then(r => r.json()) as any).onsen.status
    const o = onsenNow('adam')
    same = !!o && ['state', 'since', 'at', 'last_activity_at'].every(k => hz[k] === o[k]) && JSON.stringify(hz.detail) === JSON.stringify(o.detail)
    if (!same) await new Promise(r => setTimeout(r, 250))
  }
  expect({ state: hz.state, since: hz.since, at: hz.at, detail: hz.detail, last_activity_at: hz.last_activity_at }).toEqual(onsenNow('adam'))
  expect(hz).toMatchObject({ state: 'waiting', detail: { waitingFor: 'model_picker', judged_by: 'jev' } })
  // WO-169: the question bank: the idle screen and the menu, one line each, and the screens shown again add none
  const bank = () => lines(join(d!.ws, '.lanes', 'run', 'screen-verdicts.jsonl'))
  expect(bank().map(b => b.verdict.state).sort()).toEqual(['idle', 'waiting_for_human'])
  expect(show(IDLE).status).toBe(0)
  expect(await until(() => statuses().at(-1)?.state === 'idle', 8000)).toBe(true)
  expect(show(MENU).status).toBe(0)
  expect(await until(() => statuses().at(-1)?.state === 'waiting', 8000)).toBe(true)
  expect(bank()).toHaveLength(2)
  expect(bank()[1]).toMatchObject({ agent: 'adam', has_input_box: false, verdict: { state: 'waiting_for_human', menu: 'model_picker', p: 0.9, by: 'jev' } })
  expect(bank()[1].screen.screen_bottom).toContain('Select model')
}, 40000)

test.skipIf(!HAS_TMUX)("lanes on (LANES_WAKE_DECIDE, ONSEN_WAKE_LOG): a menu on the pane → a colleague's call is decided by the record (waiting) and its wake row says member_state waiting", async () => {
  writeFileSync(join(root, 'bea-screen.txt'), MENU)
  expect(tmux('new-session', '-d', '-s', 'jevtest-bea', '-x', '100', '-y', '30', `cat ${join(root, 'bea-screen.txt')}; exec sleep 3600`).status).toBe(0)
  const api2 = startBotApiMock({}, { pollHoldMs: 300 })
  mkdirSync(join(root, 'bea', 'home', '.claude', 'duty-officer'), { recursive: true })                 // `sleep` counts as Claude Code here, as for adam
  writeFileSync(join(root, 'bea', 'home', '.claude', 'duty-officer', 'config.json'), JSON.stringify({ enabled: [], claude_cmds: ['sleep'] }))
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ eve: { url: 'http://127.0.0.1:9' }, bea: { url: 'http://127.0.0.1:9' } }))   // eve is a colleague here
  register(join(root, 'bea'))                                                        // registered (not connected): past "starting"
  const b = await startTgDaemon(api2, join(root, 'bea'), JOEY, { GENESIS_LANES: '1', LANES_AGENT: 'bea', AGENT_INBOX_SELF: 'bea', LANES_WAKE_DECIDE: 'bea', ONSEN_WAKE_LOG: 'bea',
    AGENT_INBOX_REGISTRY: join(root, 'registry.json'),
    ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'mesh-credential'), ONSEN_PEER_LOOKUP: '0', ONSEN_REGISTRY_CLI: '0',
    CHANNEL_BOT_TMUX_SESSION: 'jevtest-bea', ...tmuxEnv, JEV_SCREEN: 'bea', JEV_SCREEN_QUESTIONS: join(root, 'questions.json'),
    TYPESAFE_API_KEY: 'test-key-not-real', TYPESAFE_KEY_FILE: '', TYPESAFE_BASE_URL: `http://127.0.0.1:${jevPort}` }).catch(e => { api2.stop(); throw e })
  try {
    expect(await until(() => statuses('bea').some(s => s.state === 'waiting' && s.detail?.waitingFor === 'model_picker'), 15000)).toBe(true)
    const tok = await (async () => { for (let i = 0; i < 100; i++) { try { const t = readFileSync(join(root, 'bea', 'tok', String(b.port)), 'utf8').trim(); if (t) return t } catch {} await new Promise(r => setTimeout(r, 100)) } return '' })()
    const route = (ev: any) => fetch(`http://127.0.0.1:${b.port}/lanes/route`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(ev) }).then(r => r.json())
    const mesh = (id: string, from: string, text: string, verified: boolean) => ({ id, source: 'mesh', from, text, meta: { user: from }, verified, line: 'call', btcc_msg_id: id.slice(5),
      notif: { method: 'notifications/claude/channel', params: { content: text, meta: { user: from } } } })
    await route(mesh('mesh-61001', 'eve', '維護幾點？', false))
    await route(mesh('mesh-61002', 'eve', '週報那件事你知道嗎？', true))
    const routing = () => lines(join(b.ws, '.lanes', 'routing.jsonl'))
    expect(await until(() => routing().some(r => r.event === 'mesh-61001') && routing().some(r => r.event === 'mesh-61002'), 8000)).toBe(true)
    expect(routing().find(r => r.event === 'mesh-61001')).toMatchObject({ rule: 'wake:unverified', decided_by: 'new', wake_target: 'held:waiting' })
    expect(await until(() => wakes.filter(w => w.agent === 'bea' && w.source_kind === 'peer_call').length >= 2, 15000)).toBe(true)
    for (const w of wakes.filter(w => w.agent === 'bea' && w.source_kind === 'peer_call')) expect(w.member_state).toBe('waiting')
    expect(onsenNow('bea')).toMatchObject({ state: 'waiting' })
  } finally { await b.stop(); api2.stop() }
}, 60000)

test.skipIf(!HAS_TMUX)('SCREEN_JUDGE=program: no judge; the record is statusOf\'s, judged_by program; Jev never asked; the screen not read', async () => {
  expect(tmux('new-session', '-d', '-s', 'jevtest-cyd', '-x', '100', '-y', '30', `cat ${join(root, 'screen.txt')}; exec sleep 3600`).status).toBe(0)
  const api3 = startBotApiMock({}, { pollHoldMs: 300 })
  mkdirSync(join(root, 'cyd', 'home', '.claude', 'duty-officer'), { recursive: true })                 // the pane counts as Claude Code: still not read
  writeFileSync(join(root, 'cyd', 'home', '.claude', 'duty-officer', 'config.json'), JSON.stringify({ enabled: [], claude_cmds: ['sleep'] }))
  const n0 = asked.length
  const c = await startTgDaemon(api3, join(root, 'cyd'), JOEY, { GENESIS_LANES: '0', LANES_AGENT: 'cyd', AGENT_INBOX_SELF: 'cyd', SCREEN_JUDGE: 'program',
    ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'mesh-credential'), ONSEN_PEER_LOOKUP: '0', ONSEN_REGISTRY_CLI: '0',
    CHANNEL_BOT_TMUX_SESSION: 'jevtest-cyd', ...tmuxEnv, JEV_SCREEN: 'cyd', JEV_SCREEN_QUESTIONS: join(root, 'questions.json'),
    TYPESAFE_API_KEY: 'test-key-not-real', TYPESAFE_KEY_FILE: '', TYPESAFE_BASE_URL: `http://127.0.0.1:${jevPort}` }).catch(e => { api3.stop(); throw e })
  try {
    expect(await until(() => statuses('cyd').some(s => s.detail?.judged_by === 'program'), 15000)).toBe(true)
    await new Promise(r => setTimeout(r, 6000))                          // past the first look's jitter (5 s)
    expect(statuses('cyd').every(s => s.detail?.judged_by === 'program')).toBe(true)
    expect(asked.length).toBe(n0)
    const h = await fetch(`http://127.0.0.1:${c.port}/healthz`).then(r => r.json()) as any
    expect(h.onsen.status.screen_status).toMatchObject({ on: false, judge: null, looks: 0, answer: null })
    expect(String(h.onsen.status.screen_status.why)).toContain('SCREEN_JUDGE=program')
    expect(c.log()).toContain('screen-status: off for cyd (SCREEN_JUDGE=program: no screen judge)')
  } finally { await c.stop(); api3.stop() }
}, 60000)
