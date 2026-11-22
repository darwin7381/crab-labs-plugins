// lanes-golive, lab run 2026-11-23 (sonn-lab, G1): Joey asked the worker lane in its topic to write a file; the lane was refused (knowledge/) and handed his
// message to the main. The main wrote it and answered with reply_to = Joey's message id. replyTargets matched reply_to only against the turn's ITEMS
// (the hand-over item carries the lane's text, not Joey's message), so the Joey line stayed owed: the Stop check held the turn and the main sent Joey
// the same answer again without reply_to. A reply that quotes the event's own Telegram message meets that event's Joey line.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?golive-replyto') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-golive-replyto-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
const GO = join(dir, 'go'), bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, time
t0 = time.time()
while time.time() - t0 < 30 and not os.path.exists('${GO}'): time.sleep(0.02)
try: os.remove('${GO}')
except OSError: pass
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async () => 1, joeyChatId: () => '1', createTopic: async () => 7001 } as any)
afterAll(() => { try { writeFileSync(GO, 'ok') } catch {}; L.__setClaudeBin(restore); delete process.env.LANES_FLOOD_CONTROL })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const joeyOb = (id: string) => ((L.__events().get(id)?.obligations ?? []) as any[]).find(o => o.kind === 'joey')

test('the main quotes Joey\'s own message (reply_to) while its turn carries the lane\'s hand-over of it: that event\'s Joey line is met, once', async () => {
  const wo = '[board][WO-501] 請 adam 整理清單'
  const b = await L.routeEvent({ id: 'mesh-rt-1', source: 'mesh', from: 'board', verified: true, text: wo, meta: {}, line: 'call', notif: { method: 'notifications/claude/channel', params: { content: wo, meta: {} } } } as any)
  expect(b).toMatchObject({ rule: 'mesh-board', target: 'lane' })
  expect(await until(() => !!L.__runTok(b.lane!))).toBe(true)
  writeFileSync(GO, 'ok'); expect(await until(() => !L.__runTok(b.lane!))).toBe(true); await sleep(40)
  // Joey, in the worker's topic: his own message (Telegram id 578) reaches the worker
  const meta = { chat_id: '1', message_id: '578', user: 'joey', message_thread_id: '7001' }
  const id = 'tg-1-578'
  const j = await L.routeEvent({ id, source: 'telegram', from: 'joey', text: 'G1：把清單寫成 knowledge/x.md', meta, verified: true, message_thread_id: '7001',
    notif: { method: 'notifications/claude/channel', params: { content: 'G1：把清單寫成 knowledge/x.md', meta } } } as any)
  expect(j).toMatchObject({ rule: 'tg-worker-topic', lane: b.lane })
  expect(await until(() => !!L.__runTok(b.lane!))).toBe(true)
  expect(await L.callLaneTool(L.__runTok(b.lane!)!, 'handoff_main', { text: 'Joey 要寫 knowledge/x.md，我被擋，請主線寫並回他' })).toContain('handed to the main')
  writeFileSync(GO, 'ok'); expect(await until(() => !L.__runTok(b.lane!))).toBe(true); await sleep(40)
  expect(joeyOb(id).state).toBe('handed')
  // a main whose turn has the hand-over item bound (not Joey's message)
  const proc = Bun.spawn(['sleep', '600'])
  const sid = `00000000-0000-4000-8000-${String(proc.pid).padStart(12, '0')}`
  writeFileSync(join(dir, 'main-expected'), sid)
  await L.__mainEvent({ event: 'SessionStart', pid: proc.pid, session_id: sid })
  const prompt = 'p-rt-1'
  const dids = L.__main().items(r => r.state !== 'done' && r.kind !== 'digest' && String(r.event) === id).map(r => r.id)
  expect(dids.length).toBe(1)
  expect(L.__main().items(r => r.id === dids[0])[0].kind).toBe('handoff')
  await L.__mainEvent({ event: 'UserPromptSubmit', pid: proc.pid, prompt_id: prompt, dids })
  try {
    expect(L.mainReplyTier({ reply_to: '578' })).toBeNull()                                     // quoting Joey: an ordinary (ringing) answer
    L.mainReplied(null, 579, '578', '寫好了')
    expect(joeyOb(id)).toMatchObject({ state: 'met', by: 'main', ref: '579' })
    const r = await L.__mainEvent({ event: 'Stop', pid: proc.pid, prompt_id: prompt })
    expect(String(r.block ?? '')).not.toContain('還欠事沒交代')                                  // nothing owed: no hold, no second answer
  } finally {
    await L.__mainEvent({ event: 'Stop', pid: proc.pid, prompt_id: prompt, phase: 'final' }); await L.__mainEvent({ event: 'SessionEnd', pid: proc.pid }); proc.kill('SIGKILL')
  }
}, 30000)
