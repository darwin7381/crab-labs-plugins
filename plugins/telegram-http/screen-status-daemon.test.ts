// WO-165 A end to end: a real Telegram daemon (server.ts) with JEV_SCREEN on, its main's pane a tmux pane of a PRIVATE tmux server, a stand-in TypeSafe
// and a stand-in Onsen (local HTTP servers). What reaches Onsen is Jev's reading of that pane (judged_by: jev), and it follows the pane within the poll;
// every call is in <workspace>/.lanes/run/jev-calls.jsonl with its usage.
// The machine's own tmux server is never touched. 2026-11-25 19:02Z and 19:07Z the first version of this test killed the Mac mini's real server (every
// agent's session with it): it relied on TMUX_TMPDIR, but a shell inside tmux has TMUX set, and tmux without -S / -L uses $TMUX first. Now every tmux call
// of this test names its socket (-S, a file in the test's temp dir), runs without TMUX in its env, and the server is only ever killed through that socket.
// The daemon runs with an env that has no TMUX (startTgDaemon builds its env from scratch) and TMUX_TMPDIR pointing at the same private directory.
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
const asked: Array<{ body: any; at: number }> = []
let root = '', tmuxEnv: Record<string, string> = {}, sock = ''
/** this test's private tmux server only: an explicit socket under the temp dir, TMUX removed from the env */
const tmux = (...a: string[]) => {
  if (!sock || !sock.startsWith(root + '/') || !root.startsWith(tmpdir())) throw new Error('refusing to run tmux outside the test socket')
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...tmuxEnv }
  delete env.TMUX; delete env.TMUX_PANE
  return spawnSync('tmux', ['-S', sock, ...a], { encoding: 'utf8', env })
}
const show = (text: string) => { writeFileSync(join(root, 'screen.txt'), text); return tmux('respawn-pane', '-k', '-t', 'jevtest-adam', `cat ${join(root, 'screen.txt')}; exec sleep 3600`) }
const statuses = () => got.map(g => g.item)

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
  const onsenPort = await freePort(), jevPort = await freePort()
  onsen = Bun.serve({ port: onsenPort, hostname: '127.0.0.1', async fetch(req) {
    const path = new URL(req.url).pathname.replace(/^\/api\/onsen/, '')
    const body = req.method === 'POST' ? await req.json() : undefined
    if (path === '/status/batch') for (const it of body.items) got.push({ item: it, at: Date.now() })
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
afterAll(async () => { await d?.stop(); api?.stop(); onsen?.stop(true); jev?.stop(true); if (HAS_TMUX && root) tmux('kill-server') })

test.skipIf(!HAS_TMUX)("JEV_SCREEN on: Onsen gets Jev's reading of the pane, it follows the pane within the poll, and every call is logged", async () => {
  // no registration (no session file under the daemon's HOME): statusOf says offline no_registration, Claude Code runs in the pane → asked
  expect(await until(() => statuses().some(s => s.detail?.judged_by === 'jev'), 15000)).toBe(true)
  const first = statuses().find(s => s.detail?.judged_by === 'jev')
  expect(first).toMatchObject({ agent: 'adam', state: 'idle', detail: { judged_by: 'jev', judge_p: 0.9, program_offline: 'no_registration' } })
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
  expect(d!.log()).toContain('screen-status: ON for adam')
  const h = await fetch(`http://127.0.0.1:${d!.port}/healthz`).then(r => r.json()) as any
  expect(h.onsen?.status?.screen_status).toMatchObject({ on: true, poll_ms: 1000 })
}, 40000)
