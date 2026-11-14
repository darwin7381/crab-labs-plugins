// Universe 002k (B12): alert dedupe. The B08 burst of 002j: twelve "（第 n 次偵測）" repeats of one alert opened twelve lanes.
// The lane process is a script that records its prompt and sleeps for the time in <dir>/sleep.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?b12-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-b12-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
writeFileSync(join(dir, 'sleep'), '1.2')
const bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3\nimport sys, json, time\nargv = sys.argv[1:]\nopen('${dir}/prompts.jsonl', 'a').write(json.dumps({'prompt': argv[argv.index('-p') + 1]}) + '\\n')\ntime.sleep(float(open('${dir}/sleep').read()))\nprint('{"type":"result","subtype":"success","is_error":false,"result":"ok"}')\n`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => { L.__setClaudeBin(restore); L.__setAlertRepeatMin(10) })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const rows = (n: string): any[] => { try { return readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(30) } return f() }
const alert = (id: string, text: string, from = 'alert-dispatcher') => ({ id, source: 'mesh', from, verified: true, text, meta: {}, notif: { method: '', params: {} } } as any)
const burst = (n: number) => `[P2][warning] mock-api p95 > 2s（第 ${n} 次偵測）`
const prompts = (): string[] => rows('prompts.jsonl').map(r => r.prompt)
const lanes = () => Object.values(L.__lanesState().lanes)
const exits = () => rows('lanes.jsonl').filter(r => r.kind === 'exit').length

test('B12: the fingerprint is the sender plus the text with the digits masked', () => {
  expect(L.alertFingerprint('alert-dispatcher', burst(1))).toBe(L.alertFingerprint('alert-dispatcher', burst(12)))
  expect(L.alertFingerprint('alert-dispatcher', burst(1))).not.toBe(L.alertFingerprint('other-sender', burst(1)))
  expect(L.alertFingerprint('alert-dispatcher', '[P2][warning] mock-api p95 > 2s')).not.toBe(L.alertFingerprint('alert-dispatcher', '[P2][warning] mock-api p99 > 2s 且錯誤率上升'))
  expect(L.alertFingerprint('a', 'x 12 y 3.5s')).toBe(L.alertFingerprint('a', 'x 7 y 9.1s'))
})

test('B12: the B08 burst of twelve repeats opens ONE lane; eleven "repeat n of <thread>" lines for nobody; no second run', async () => {
  const decisions: any[] = []
  for (let n = 1; n <= 12; n++) decisions.push(await L.routeEvent(alert(`mesh-b${n}`, burst(n))))
  expect(decisions[0].target).toBe('lane')
  for (const d of decisions.slice(1)) { expect(d.rule).toBe('alert-repeat'); expect(d.target).toBe('ledger'); expect(d.lane).toBe(decisions[0].lane) }
  expect(lanes().filter(l => l.kind === 'reflex').length).toBe(1)
  const thread = L.__lanesState().lanes[decisions[0].lane].thread
  const led = rows('ledger.jsonl').filter(r => r.refs?.fingerprint)
  expect(led.length).toBe(11)
  expect(led.map(r => r.text.split('：')[0])).toEqual(Array.from({ length: 11 }, (_, i) => `repeat ${i + 1} of ${thread}`))
  for (const r of led) { expect(r.notify_main).toBe(false); expect(r.thread).toBe(thread); expect(r.refs.fingerprint).toBe(L.alertFingerprint('alert-dispatcher', burst(1))) }
  expect(rows('routing.jsonl').filter(r => r.rule === 'alert-repeat').length).toBe(11)
  expect(await until(() => exits() >= 1)).toBe(true)
  await sleep(300)
  expect(rows('lanes.jsonl').filter(r => r.kind === 'spawn').length).toBe(1)          // one process for twelve alerts
  // the lane has ended, no follow-up: a repeat within the window is still a repeat (12th and beyond), no new lane
  const d13 = await L.routeEvent(alert('mesh-b13', burst(13)))
  expect(d13.rule).toBe('alert-repeat'); expect(lanes().filter(l => l.kind === 'reflex').length).toBe(1)
})

test('B12: the repeats start the thread\'s next run (a pending follow-up) together, through extra', async () => {
  const st = L.__lanesState()
  const lane = lanes().find(l => l.kind === 'reflex')!
  const tok = { runId: `${lane.id}.r1`, lane: lane.id, evId: 'mesh-b1', closers: [], critical: false, trigger: 'alert', cls: 'alert', escalated: false, pushed: false } as any
  const out = await L.callLaneTool(tok, 'followup', { after_minutes: 5, note: '再看 p95 是否恢復' })
  expect(out).toContain('scheduled')
  await L.routeEvent(alert('mesh-b14', burst(14)))                                    // a pending follow-up: still a repeat
  expect(lanes().filter(l => l.kind === 'reflex').length).toBe(1)
  const before = prompts().length
  const f = Object.values(st.followups).find(x => x.state === 'pending')!
  f.due = Date.now() - 1
  L.followupTick()
  expect(await until(() => prompts().length > before)).toBe(true)
  const p = prompts()[before]
  expect(p).toContain('後續檢查')                                                      // it is the follow-up run
  expect(p).toContain('同一個警報又來了 13 次')
  for (const n of [2, 6, 12, 13, 14]) expect(p).toContain(`（第 ${n} 次偵測）`)       // every repeat's text, in this one prompt
  expect(st.threads[lane.thread].repeats?.length ?? 0).toBe(0)                        // handed over once
  expect(await until(() => exits() >= 2)).toBe(true)
})

test('B12: a repeat that comes while the thread\'s next run is already queued rides in that queued run', async () => {
  const mk = (n: number) => `[P2][warning] queue-depth 超過 ${n}00 筆（第 ${n} 次）`
  const d1 = await L.routeEvent(alert('mesh-q1', mk(1)))
  expect(d1.target).toBe('lane')
  const lane = L.__lanesState().lanes[d1.lane!]
  const tok = { runId: `${lane.id}.r1`, lane: lane.id, evId: 'mesh-q1', closers: [], critical: false, trigger: 'alert', cls: 'alert', escalated: false, pushed: false } as any
  await L.callLaneTool(tok, 'followup', { after_minutes: 1, note: '再查一次 queue-depth' })
  const f = Object.values(L.__lanesState().followups).find(x => x.thread === lane.thread && x.state === 'pending')!
  f.due = Date.now() - 1
  L.followupTick()                                                                    // the lane is still running: the follow-up waits in the queue
  const before = prompts().length
  const d2 = await L.routeEvent(alert('mesh-q2', mk(2)))
  expect(d2.rule).toBe('alert-repeat')
  expect(await until(() => prompts().length >= before + 1 && exits() >= 4)).toBe(true)
  const second = prompts().find(p => p.includes('再查一次 queue-depth'))!
  expect(second).toContain('同一個警報又來了 1 次'); expect(second).toContain('（第 2 次）')
})

test('B12: a critical alert keeps its own run; so does a repeat whose severity changed; other text, other sender', async () => {
  const lanesBefore = lanes().length
  const crit = '[P1][critical] mock-api 全部回 5xx，已持續 2 分鐘'
  const c1 = await L.routeEvent(alert('mesh-c1', crit)), c2 = await L.routeEvent(alert('mesh-c2', crit))
  expect(c1.target).toBe('lane'); expect(c2.target).toBe('lane'); expect(c2.lane).not.toBe(c1.lane)      // critical: never a repeat
  const i1 = await L.routeEvent(alert('mesh-i1', '[P3][info] cache hit rate 低於 80%（第 1 次）'))
  const i2 = await L.routeEvent(alert('mesh-i2', '[P3][info] cache hit rate 低於 80%（第 2 次）'))
  expect(i1.target).toBe('lane'); expect(i2.rule).toBe('alert-repeat')
  const i3 = await L.routeEvent(alert('mesh-i3', '[P4][info] cache hit rate 低於 80%（第 3 次）'))   // same words, other P-level
  expect(i3.target).toBe('lane'); expect(i3.lane).not.toBe(i1.lane)
  const w = await L.routeEvent(alert('mesh-w1', '[P2][warning] mock-api p95 > 2s 而且 error rate 上升'))   // other text
  expect(w.target).toBe('lane')
  const e1 = await L.routeEvent(alert('mesh-e1', '請問 mock-api 的逾時是多少？', 'eve')), e2 = await L.routeEvent(alert('mesh-e2', '請問 mock-api 的逾時是多少？', 'eve'))
  expect(e1.target).toBe('lane'); expect(e2.rule).not.toBe('alert-repeat')                // a peer's message is not an alert
  expect(lanes().length).toBeGreaterThan(lanesBefore)
  expect(await until(() => exits() >= 9, 15000)).toBe(true)
})

test('B12: after the window (and with nothing queued, running or scheduled) the same alert opens a new lane', async () => {
  writeFileSync(join(dir, 'sleep'), '0.2')
  const text = '[P2][warning] disk /data 使用率 91%（第 1 次）'
  const a = await L.routeEvent(alert('mesh-t1', text))
  expect(a.target).toBe('lane')
  expect(await until(() => lanes().find(l => l.id === a.lane)?.status === 'idle' && (lanes().find(l => l.id === a.lane)?.runs ?? 0) > 0)).toBe(true)
  const b = await L.routeEvent(alert('mesh-t2', text.replace('第 1', '第 2')))        // within 10 minutes of its end: a repeat
  expect(b.rule).toBe('alert-repeat')
  L.__setAlertRepeatMin(0)                                                              // the window is over
  const c = await L.routeEvent(alert('mesh-t3', text.replace('第 1', '第 3')))
  expect(c.target).toBe('lane'); expect(c.lane).not.toBe(a.lane)
  L.__setAlertRepeatMin(10)
  const d = await L.routeEvent(alert('mesh-t4', text.replace('第 1', '第 4')))        // and the new lane is the owner of the fingerprint now
  expect(d.rule).toBe('alert-repeat'); expect(d.lane).toBe(c.lane)
})
