// WO-215 (Chiron 02:40Z): a /resume switch is reported done only when the main lanes knows is the session asked for. resumeSessionSwitch types
// `/resume <id>` into the own pane and waits (up to 15 s) for mainSessionId() to be that id: the tg daemon's registered main, else .lanes/main-expected,
// which the tg daemon rewrites after each accepted SessionStart. Not that id in time: ok:false with the main it is, and the reply says it did not take.
// A real tmux pane running `cat` (ignoring the switch's C-c) stands in for Claude Code (it receives the keys); main-expected stands in for the registration.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const OWN = `cbc-wo215-${process.pid}`
const sock = mkdtempSync('/tmp/w215-')                 // tmux's socket path must stay short (macOS: 104 bytes); the run's TMPDIR is too long
const ws = mkdtempSync('/tmp/w215ws-')
const cwd0 = process.cwd()
const env0 = { session: process.env.CHANNEL_BOT_TMUX_SESSION, tmux: process.env.TMUX, tmuxTmp: process.env.TMUX_TMPDIR }
process.env.CHANNEL_BOT_TMUX_SESSION = OWN
process.env.TMUX_TMPDIR = sock; delete process.env.TMUX
const C = await import('./channel-bot-control.ts?wo215') as typeof import('./channel-bot-control.ts')
const tm = (...a: string[]) => Bun.spawnSync(['tmux', ...a], { env: { ...process.env, TMUX_TMPDIR: sock } })
const expected = (sid: string) => writeFileSync(join(ws, '.lanes', 'main-expected'), sid)
afterAll(() => {
  tm('kill-server'); process.chdir(cwd0)
  for (const d of [sock, ws]) rmSync(d, { recursive: true, force: true })
  for (const [k, v] of [['CHANNEL_BOT_TMUX_SESSION', env0.session], ['TMUX', env0.tmux], ['TMUX_TMPDIR', env0.tmuxTmp]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

test('WO-215: a /resume switch that does not take answers 「沒切成」 with the main it is now; one that takes answers ok with the target', async () => {
  expect(tm('new-session', '-d', '-s', OWN, '-x', '120', '-y', '10', `sh -c 'trap "" INT; cat'`).exitCode).toBe(0)   // the switch sends C-c
  mkdirSync(join(ws, '.lanes'), { recursive: true }); process.chdir(ws)   // no lanes in this process: mainSessionId() reads ./.lanes/main-expected
  try {
    const now = randomUUID(), target = randomUUID()
    expected(now)
    const r = await C.resumeSessionSwitch(target)
    expect(r).toEqual({ ok: false, now })                                                  // the main never became the target: not reported as done
    expect(tm('capture-pane', '-p', '-t', OWN).stdout.toString()).toContain(`/resume ${target}`)   // by id, not by a row of the picker
    const line = C.resumeNotTaken(target, r.now)
    expect(line).toContain('沒切成'); expect(line).toContain(target.slice(0, 8)); expect(line).toContain(now.slice(0, 8))
    expect(C.resumeNotTaken(target, null)).toContain('還沒登記')

    const t2 = randomUUID()
    setTimeout(() => expected(t2), 1500)                                                   // the new session's SessionStart registers it
    expect(await C.resumeSessionSwitch(t2)).toEqual({ ok: true, now: t2 })
  } finally { process.chdir(cwd0) }
}, 40_000)
