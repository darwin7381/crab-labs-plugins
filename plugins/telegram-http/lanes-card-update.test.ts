// 1.36.2: a resumed lane session gets a changed lane card. claude records a session's system prompt at its first request and replays it on every
// --resume, so the card in run/system-<kind>.md reached only sessions created after a release changed it (nestor.mail.1, session f2f6b18a: its
// prompt_snapshot of 11-23 16:01Z, a resume while its daemon ran 1.36.0, still had the 1.35.2 mail line 「再決定打開哪幾封」). Each lane keeps the hash of
// the card its session got; a resumed run whose session got another card (or none recorded: a lane from before 1.36.2) carries the current card once,
// inside its 〔車道資訊〕 block. The stand-in lane binary records the argv of every run.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?card-update') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-card-update-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
const GO = join(dir, 'go'), bin = join(dir, 'lane.py'), ARGV = join(dir, 'argv.jsonl')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, sys, time
with open('${ARGV}', 'a') as f: f.write(json.dumps(sys.argv[1:]) + '\\n')
t0 = time.time()
while time.time() - t0 < 30 and not os.path.exists('${GO}'): time.sleep(0.02)
try: os.remove('${GO}')
except OSError: pass
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
L.__setMailTool(async () => ({ text: '0 封未讀', isError: false }))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
afterAll(() => { try { writeFileSync(GO, 'ok') } catch {}; L.__setKindLinesForTest(null); L.__setClaudeBin(restore); L.__setMailTool(null); delete process.env.LANES_FLOOD_CONTROL })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
let n = 0
const reminder = () => { const text = '讀信箱（1 封未讀，最舊的等了 70 分鐘）：先用 mailbox_list'
  return { id: `mesh-cu-${++n}`, source: 'mesh', from: 'fleet-watchdog', verified: true, text, meta: { no_reply: 'true' }, no_reply: true, wake: 'mail', line: 'mail',
    notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any }
const argvs = (): string[][] => { try { return readFileSync(ARGV, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const spawns = (lane: string): any[] => readFileSync(join(dir, 'lanes.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.kind === 'spawn' && r.lane === lane)
const count = (s: string, sub: string) => s.split(sub).length - 1
/** one mail-lane run, start to end: its argv (the prompt follows -p) */
async function run(): Promise<{ lane: string; argv: string[]; prompt: string }> {
  const before = argvs().length
  const d = await L.routeEvent(reminder())
  expect(d).toMatchObject({ target: 'lane' })
  expect(await until(() => !!L.__runTok(d.lane!) && argvs().length > before)).toBe(true)
  const argv = argvs()[before]
  writeFileSync(GO, 'ok'); await until(() => !L.__runTok(d.lane!)); await sleep(30)
  return { lane: d.lane!, argv, prompt: argv[argv.indexOf('-p') + 1] }
}
const NEW_LINE = '- 測試：讀信線的新規則（1.36.2 的替身）'

test('1.36.2: a new session records the card hash and gets no update block; a resumed run of an unchanged card gets none either', async () => {
  const a = await run()
  expect(a.argv).toContain('--session-id')
  expect(a.prompt).not.toContain(L.CARD_UPDATED_HEAD)
  expect(L.__lanesState().lanes[a.lane].card_hash).toBe(L.cardHash('mail'))
  const b = await run()
  expect(b.lane).toBe(a.lane)
  expect(b.argv).toContain('--resume')
  expect(b.prompt).not.toContain(L.CARD_UPDATED_HEAD)
  expect(spawns(a.lane).some(s => 'card_update' in s)).toBe(false)
}, 20000)

test('1.36.2: the card changes: the next resumed run carries the current card once, inside 〔車道資訊〕; the run after it has none', async () => {
  const old = L.cardHash('mail')
  L.__setKindLinesForTest((k, lines) => k === 'mail' ? [...lines, NEW_LINE] : lines)
  try {
    expect(L.cardHash('mail')).not.toBe(old)
    expect(L.cardHash('reflex')).toBe(L.cardHash('reflex'))
    const c = await run()
    expect(c.argv).toContain('--resume')
    expect(count(c.prompt, L.CARD_UPDATED_HEAD)).toBe(1)
    expect(count(c.prompt, NEW_LINE)).toBe(1)
    expect(count(c.prompt, L.identityCard({ kind: 'mail' }))).toBe(1)                       // the whole current card, exactly
    expect(c.prompt.indexOf(L.CARD_UPDATED_HEAD)).toBeGreaterThan(c.prompt.indexOf('〔車道資訊｜'))
    expect(c.prompt.indexOf(NEW_LINE)).toBeLessThan(c.prompt.indexOf('〔車道資訊結束；下面是事件〕'))  // inside the system-written block, before the event
    expect(c.prompt).not.toContain('Contents of ')                                               // the card only, not the instruction files
    const sys = c.argv[c.argv.indexOf('--append-system-prompt-file') + 1]
    expect(readFileSync(sys, 'utf8')).toContain(NEW_LINE)                                         // the per-kind file is kept current as before
    expect(L.__lanesState().lanes[c.lane].card_hash).toBe(L.cardHash('mail'))
    expect(spawns(c.lane).at(-1)).toMatchObject({ card_update: L.cardHash('mail') })
    const d = await run()
    expect(d.lane).toBe(c.lane)
    expect(d.prompt).not.toContain(L.CARD_UPDATED_HEAD)
    expect(d.prompt).not.toContain(NEW_LINE)
  } finally { L.__setKindLinesForTest(null) }
}, 20000)

test('1.36.2: a lane from before the fix (no hash recorded) gets the current card once when it resumes, then none', async () => {
  const lane = L.__lanesState().lanes[L.__lanesState().mail_lane!]
  delete lane.card_hash
  const e = await run()
  expect(e.lane).toBe(lane.id)
  expect(e.argv).toContain('--resume')
  expect(count(e.prompt, L.CARD_UPDATED_HEAD)).toBe(1)
  expect(count(e.prompt, L.identityCard({ kind: 'mail' }))).toBe(1)
  expect(lane.card_hash).toBe(L.cardHash('mail'))
  const f = await run()
  expect(f.prompt).not.toContain(L.CARD_UPDATED_HEAD)
}, 20000)
