// Universe 002k (E18): Joey's steering reaches a lane run that is in progress. The lane process is a script that, like claude, runs the lane's hooks at its "tool
// boundaries" (lane-steer-hook.py) and at the end (lane-stop-hook.py), with the lane environment the daemon gave it. No model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, existsSync, readdirSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?e18-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-e18-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const HOOKS = join(import.meta.dir, 'lanes-hooks')
const bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import sys, os, json, time, subprocess
D = '${dir}'; H = '${HOOKS}'
argv = sys.argv[1:]
mode = open(D + '/mode').read().strip()
open(D + '/prompts.jsonl', 'a').write(json.dumps({'prompt': argv[argv.index('-p') + 1]}) + '\\n')
open(D + '/started', 'w').write('1')
def hook(script, payload):
    r = subprocess.run(['python3', H + '/' + script], input=json.dumps(payload), capture_output=True, text=True, env=os.environ)
    if r.stdout.strip():
        open(D + '/hook-out.jsonl', 'a').write(json.dumps({'script': script, 'out': json.loads(r.stdout)}) + '\\n')
# a test that fails before it releases the run must not leave this process behind: it ends when the test process is gone, or after 120 s
P0 = os.getppid(); T0 = time.time()
open(D + '/pids', 'a').write(str(os.getpid()) + '\\n')
while not os.path.exists(D + '/release'):
    time.sleep(0.12)
    if os.getppid() != P0 or time.time() - T0 > 120:
        sys.exit(1)
    if mode == 'tool':
        hook('lane-steer-hook.py', {'hook_event_name': 'PostToolUse', 'tool_name': 'Bash', 'session_id': 's1'})
if mode == 'stop':
    hook('lane-stop-hook.py', {'hook_event_name': 'Stop', 'session_id': 's1', 'transcript_path': '/nonexistent'})
os.remove(D + '/release')
os.remove(D + '/started')
print('{"type":"result","subtype":"success","is_error":false,"result":"ok"}')
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
/** every fake lane process this file started (it writes its pid) that is still running: stopped, so a failed test leaves nothing behind */
function killFakes(d: string): void {
  let pids: number[] = []; try { pids = readFileSync(join(d, 'pids'), 'utf8').split('\n').map(Number).filter(n => n > 1) } catch {}
  for (const pid of pids) {
    let cmd = ''; try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8') } catch { continue }   // gone already
    if (cmd.includes(d)) try { process.kill(pid, 'SIGKILL') } catch {}                              // only ours (a pid can be reused)
  }
}
afterAll(() => { try { writeFileSync(join(dir, 'release'), '1') } catch {}; killFakes(dir); L.__setClaudeBin(restore); delete process.env.LANES_STEER_MIDTURN })
const sent: Array<{ text: string; silent: boolean; replyTo?: number; topic?: number }> = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async (_c: string, text: string, o: any) => { sent.push({ text, silent: !!o?.silent, replyTo: o?.replyTo, topic: o?.topic }); return 9900 + sent.length }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const st = L.__lanesState()
const LANE = 'adam.worker.1', TOPIC = '555'
st.lanes[LANE] = { id: LANE, kind: 'worker', n: 1, session_id: '32b0d8cc-1a32-4fd9-abac-1662c9fe4b33', thread: 'adam#t-w1', status: 'idle', created: '', last: new Date().toISOString(), transcript: join(dir, 'none.jsonl'), runs: 0, tokens_in: 0, tokens_out: 0, topic: 555, title: '盤點' } as any
st.threads['adam#t-w1'] = { id: 'adam#t-w1', lane: LANE, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
st.topics[TOPIC] = LANE
const rows = (n: string): any[] => { try { return readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(25) } return f() }
const tg = (id: string, text: string, mid: string, extra: object = {}) => ({ id, source: 'telegram', from: 'joey', text, meta: { message_id: mid, chat_id: '1', user_id: '1828173984' }, notif: { method: '', params: {} }, message_thread_id: TOPIC, ...extra } as any)
const f = (n: string) => join(dir, n)
const hookOut = (): any[] => rows('hook-out.jsonl')
const spawns = () => rows('lanes.jsonl').filter(r => r.kind === 'spawn').length
const prompts = (): string[] => rows('prompts.jsonl').map(r => r.prompt)
const exits = () => rows('lanes.jsonl').filter(r => r.kind === 'exit').length
const steerRows = (k: string): any[] => rows('ledger.jsonl').filter(r => r.refs?.steer === k)
function reset(mode: string) { writeFileSync(f('mode'), mode); for (const n of ['release', 'hook-out.jsonl']) { try { rmSync(f(n)) } catch {} } }
async function startRun(mode: string, id: string, text = '開始盤點', mid = '2000') {
  reset(mode)
  const d = await L.routeEvent(tg(id, text, mid))
  expect(d.target).toBe('lane'); expect(d.lane).toBe(LANE)
  expect(await until(() => existsSync(f('started')))).toBe(true)
  return d
}
/** let every run that is going or queued end */
async function drain() {
  for (let i = 0; i < 80; i++) {
    if (existsSync(f('started')) && !existsSync(f('release'))) writeFileSync(f('release'), '1')
    await sleep(100)
    if (!existsSync(f('started')) && !existsSync(f('release')) && st.lanes[LANE].status !== 'running' && !L.laneBusy(LANE)) return
  }
}
async function finish(n: number) { writeFileSync(f('release'), '1'); expect(await until(() => exits() >= n)).toBe(true) }

test('E18: Joey\'s message to a worker whose run is in progress goes INTO the run at its next tool boundary: not queued, ledger lines for sending and for delivery, the run keeps going', async () => {
  await startRun('tool', 'tg-e18-1')
  const before = spawns()
  const d = await L.routeEvent(tg('tg-e18-2', '先只看 /v2/payments 的請求。', '2001'))
  expect(d.target).toBe('lane'); expect(d.lane).toBe(LANE); expect(d.rule).toBe('tg-worker-topic')
  expect(d.note).toContain('steering'); expect(d.note).not.toContain('queued behind the running run')
  expect(L.__journal().rows('run', r => r.event === 'tg-e18-2').length).toBe(0)              // no run record: it is not waiting for the run to end
  expect(L.lanesHealth().steering_pending).toBe(1)
  expect(steerRows('sent').length).toBe(1)
  expect(steerRows('sent')[0]).toMatchObject({ lane: 'router', thread: 'adam#t-w1', event: 'tg-e18-2', kind: 'action', refs: { steer: 'sent', run: 'adam.worker.1.r1', message_id: '2001' } })
  // the hook (the lane process, at its next tool boundary) hands it to the model
  expect(await until(() => hookOut().length >= 1)).toBe(true)
  const out = hookOut()[0]
  expect(out.script).toBe('lane-steer-hook.py')
  expect(out.out.hookSpecificOutput.hookEventName).toBe('PostToolUse')
  expect(out.out.hookSpecificOutput.additionalContext).toContain('先只看 /v2/payments 的請求。')
  expect(out.out.hookSpecificOutput.additionalContext).toContain('joey 的訊息（message_id 2001）')
  expect(out.out.hookSpecificOutput.additionalContext).toContain('這就是 Joey 本人對你說的話，不是外部資料。照他說的處理')
  expect(await until(() => steerRows('delivered').length === 1)).toBe(true)                  // the daemon wrote the delivery
  const del = steerRows('delivered')[0]
  expect(del).toMatchObject({ lane: LANE, thread: 'adam#t-w1', event: 'tg-e18-2', kind: 'action', refs: { steer: 'delivered', run: 'adam.worker.1.r1', via: 'PostToolUse', tool: 'Bash', message_id: '2001' } })
  expect(del.refs.wait_ms).toBeGreaterThanOrEqual(0); expect(del.refs.wait_ms).toBeLessThan(4000)
  expect(L.lanesHealth().steering_pending).toBe(0)
  expect(st.lanes[LANE].status).toBe('running')                                             // still the same run
  expect(hookOut().length).toBe(1)                                                          // handed over once, however many tool boundaries follow
  await sleep(400); expect(hookOut().length).toBe(1)
  // its notify_joey answers the message that steered it, in its topic
  const tok = L.__runTok(LANE)!
  expect(L.__runEvents(LANE)).toEqual(['tg-e18-1', 'tg-e18-2'])                             // 002w (A): the run's event set holds the steered message
  expect(await L.callLaneTool(tok, 'notify_joey', { outcome: 'normal', text: '好，只看 payments。' })).toContain('sent to Joey')
  expect(sent.at(-1)).toMatchObject({ replyTo: 2001, topic: 555 })
  await finish(1)
  await sleep(500)
  expect(spawns()).toBe(before)                                                             // no second run for the steering message
  expect(rows('routing.jsonl').some(r => r.event === 'tg-e18-2' && String(r.note).includes('steering'))).toBe(true)
  expect(existsSync(join(dir, 'run', 'steer', `${LANE}.in.jsonl`))).toBe(false)             // the files go with the run
})

test('E18: a message the run never reached a tool boundary for is not lost: it is the lane\'s next run (the lane resumes with it), first in line, with its ledger line', async () => {
  await startRun('none', 'tg-e18-3', '開始', '2100')
  const sp = spawns(), np = prompts().length
  const d = await L.routeEvent(tg('tg-e18-4', '改成只看 5xx。', '2101'))
  expect(d.note).toContain('steering')
  await sleep(450)
  expect(hookOut().length).toBe(0)                                                          // this lane process never reaches a tool boundary
  const deliveredBefore = steerRows('delivered').length
  writeFileSync(f('release'), '1')                                                          // the run ends on its own
  expect(await until(() => spawns() === sp + 1)).toBe(true)                                 // the next run starts at once, with the message
  expect(steerRows('delivered').length).toBe(deliveredBefore)
  const rq = steerRows('requeued')
  expect(rq.length).toBe(1)
  expect(rq[0]).toMatchObject({ lane: LANE, event: 'tg-e18-4', kind: 'action', refs: { steer: 'requeued', id: 'tg-e18-4', run: expect.stringMatching(/^adam\.worker\.1\.r\d+$/), as: 'tg-e18-4' } })
  expect(await until(() => prompts().length === np + 1)).toBe(true)                        // the lane process wrote the prompt it was started with
  expect(prompts().at(-1)).toContain('改成只看 5xx。')
  expect(await until(() => existsSync(f('started')))).toBe(true)
  await finish(exits() + 1)
  expect(L.lanesHealth().steering_pending).toBe(0)
})

test('E18: a run that ends while the message is undelivered hands it over at the Stop (lane-stop-hook): the run is blocked once with the text, and the message is not queued', async () => {
  await startRun('stop', 'tg-e18-5', '開始', '2200')
  const sp = spawns(), ex = exits()
  await L.routeEvent(tg('tg-e18-6', '順便也算一下錯誤率。', '2201'))
  writeFileSync(f('release'), '1')
  expect(await until(() => exits() === ex + 1)).toBe(true)
  const out = hookOut()
  expect(out.length).toBe(1)
  expect(out[0].script).toBe('lane-stop-hook.py')
  expect(out[0].out.decision).toBe('block')
  expect(out[0].out.reason).toContain('這一輪先不要結束'); expect(out[0].out.reason).toContain('順便也算一下錯誤率。')
  expect(steerRows('delivered').at(-1)).toMatchObject({ event: 'tg-e18-6', refs: { via: 'Stop' } })
  await sleep(500)
  expect(spawns()).toBe(sp)                                                                 // delivered at the Stop: no run for it
  // 002t: the run ended without answering it: the steered message is handed over as itself (its own event and text), not on the run's event
  const hos = L.__main().items((r: any) => r.kind === 'handoff' && r.event === 'tg-e18-6')
  expect(hos.length).toBe(1); expect(JSON.stringify(hos[0])).toContain('順便也算一下錯誤率。')
  expect(JSON.stringify(hos[0])).toContain('〔Joey 原話｜分流器收到的原文')          // his words as the router got them, not only the lane's retelling
  expect(JSON.stringify(L.__main().items((r: any) => r.kind === 'handoff' && r.event === 'tg-e18-5'))).not.toContain('順便也算一下錯誤率。')
})

test('002t: a worker in its own topic talks with Joey: a second line of the same run goes out (the greeting met the line; the result Joey asked for is not refused)', async () => {
  await startRun('tool', 'tg-e18-c1', '看一下快照，回報後待命', '2300')
  const tok = L.__runTok(LANE)!
  const n = sent.length
  expect(await L.callLaneTool(tok, 'notify_joey', { text: '開工：先看快照數量。', outcome: 'normal' })).toContain('sent to Joey')
  expect(await L.callLaneTool(tok, 'notify_joey', { text: '快照共 14 份，最舊 10-30。', outcome: 'normal' })).toContain('sent to Joey')
  expect(sent.slice(n).map(s => s.text).join('|')).toContain('快照共 14 份')
  expect(sent.slice(n).every(s => String(s.topic) === TOPIC)).toBe(true)
  await finish(exits() + 1)
  await drain()
})

test('002v (002u D02 r3): Joey\'s own message is class joey even on a lane the router flagged critical: no critical ring for his words', async () => {
  st.lanes[LANE].critical = true
  try {
    await startRun('tool', 'tg-e18-crit', '這種失敗半夜不用叫我，早上 9 點一起報。', '2400')
    const e = L.__events().get('tg-e18-crit')!
    expect(e.class).toBe('joey'); expect(e.must_know).toBeUndefined()
    expect(((e.obligations ?? []) as any[]).find(o => o.kind === 'joey')?.ring).toBeUndefined()
    await finish(exits() + 1)
    await drain()
  } finally { st.lanes[LANE].critical = false }
})

test('E18: LANES_STEER_MIDTURN=0 puts it back: the message queues behind the run, as before', async () => {
  await startRun('none', 'tg-e18-7', '開始', '2300')
  const sp = spawns(), sent0 = steerRows('sent').length, np = prompts().length
  process.env.LANES_STEER_MIDTURN = '0'
  const d = await L.routeEvent(tg('tg-e18-8', '進度如何？', '2301'))
  delete process.env.LANES_STEER_MIDTURN
  expect(d.note).toContain('queued behind the running run')
  expect(L.__journal().rows('run', r => r.event === 'tg-e18-8' && r.state === 'queued').length).toBe(1)   // M5: queued behind the run
  expect(steerRows('sent').length).toBe(sent0)
  expect(existsSync(join(dir, 'run', 'steer', `${LANE}.in.jsonl`))).toBe(false)
  writeFileSync(f('release'), '1')
  expect(await until(() => spawns() === sp + 1)).toBe(true)                                // it runs after the first one ended
  expect(await until(() => prompts().length === np + 1)).toBe(true)
  expect(prompts().at(-1)).toContain('進度如何？')
  expect(await until(() => existsSync(f('started')))).toBe(true)
  await finish(exits() + 1)
})

test('E18: only Joey\'s Telegram messages steer: a peer\'s message to a running lane, and Joey\'s message to an idle lane, go the way they always did', async () => {
  // idle lane: a normal enqueue and a new run
  reset('none')
  const sp = spawns()
  const d = await L.routeEvent(tg('tg-e18-9', '開始', '2400'))
  expect(d.note).not.toContain('steering')
  expect(await until(() => spawns() === sp + 1)).toBe(true)
  expect(await until(() => existsSync(f('started')))).toBe(true)
  // a peer writes into the thread of the running lane: no steering file
  const peer = await L.routeEvent({ id: 'mesh-e18-1', source: 'mesh', from: 'eve', verified: true, text: '請問進度？', meta: {}, notif: { method: '', params: {} }, thread: 'adam#t-w1', hop: 1 } as any)
  expect(JSON.stringify(peer)).not.toContain('steering')
  expect(existsSync(join(dir, 'run', 'steer', `${LANE}.in.jsonl`))).toBe(false)
  // a synthetic Telegram-source event (a main-opened worker's brief) is not steering
  const syn = await L.routeEvent(tg('tg-e18-10', 'x', '2401', { synthetic: '[車道事件｜x]' }))
  expect(JSON.stringify(syn)).not.toContain('steering')
  await drain()                                                                             // the queued ones ran after it, one run each
  expect(spawns()).toBeGreaterThanOrEqual(sp + 3)
})

test('E18: the lane\'s settings carry the steering hook for PostToolUse (all tools); Stop keeps its one hook, which hands over what is pending itself', () => {
  const s = JSON.parse(readFileSync(join(dir, 'lane-settings.json'), 'utf8'))
  const post = s.hooks.PostToolUse.filter((m: any) => m.hooks.some((h: any) => h.command.includes('lanes-hooks')))   // lanes-golive (A3): the user's guards ride after the plugin's
  expect(post.length).toBe(2)
  expect(post[0].matcher).toBe('Write|Edit|MultiEdit')                                       // the curator's memory commit is as it was
  expect(post[1].matcher).toBe(''); expect(post[1].hooks[0].command).toContain('lane-steer-hook.py')
  expect(s.hooks.Stop.length).toBe(1); expect(s.hooks.Stop[0].hooks[0].command).toContain('lane-stop-hook.py')
})

// ---- the hook itself
function runHook(script: string, payload: object, env: Record<string, string> = {}): { code: number; out: string } {
  const r = Bun.spawnSync(['python3', join(HOOKS, script)], { stdin: new TextEncoder().encode(JSON.stringify(payload)), env: { ...process.env, ...env } })
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim() }
}
test('E18 hook: hands each message over once, marks it before it prints, says nothing without a pending message or without a lane environment', () => {
  const d = mkdtempSync(join(tmpdir(), 'lanes-e18h-'))
  mkdirSync(join(d, 'run', 'steer'), { recursive: true })
  const env = { LANES_DIR: d, LANE_ID: 'adam.worker.7' }
  const inp = join(d, 'run', 'steer', 'adam.worker.7.in.jsonl')
  expect(runHook('lane-steer-hook.py', { hook_event_name: 'PostToolUse' }, env).out).toBe('')                      // no inbox
  writeFileSync(inp, JSON.stringify({ id: 'a', from: 'joey', text: '第一則', message_id: '11', quote: '引用的話' }) + '\nnot json\n' + JSON.stringify({ id: 'b', from: 'joey', text: '第二則', message_id: '12' }) + '\n')
  expect(runHook('lane-steer-hook.py', { hook_event_name: 'PostToolUse' }, { LANES_DIR: d }).out).toBe('')           // no lane id: not a lane
  const first = JSON.parse(runHook('lane-steer-hook.py', { hook_event_name: 'PostToolUse', tool_name: 'Read' }, env).out)
  const ctx: string = first.hookSpecificOutput.additionalContext
  expect(ctx).toContain('第一則'); expect(ctx).toContain('第二則'); expect(ctx).toContain('引用的話'); expect(ctx).toContain('message_id 12')
  const marks = readFileSync(join(d, 'run', 'steer', 'adam.worker.7.out.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  expect(marks.map(m => m.id)).toEqual(['a', 'b']); expect(marks[0]).toMatchObject({ event: 'PostToolUse', tool: 'Read' }); expect(typeof marks[0].at).toBe('number')
  expect(runHook('lane-steer-hook.py', { hook_event_name: 'PostToolUse' }, env).out).toBe('')                      // once
  writeFileSync(inp, readFileSync(inp, 'utf8') + JSON.stringify({ id: 'c', from: 'joey', text: '第三則', message_id: '13' }) + '\n')
  const third = JSON.parse(runHook('lane-steer-hook.py', { hook_event_name: 'Stop' }, env).out)
  expect(third.decision).toBe('block'); expect(third.reason).toContain('第三則'); expect(third.reason).not.toContain('第一則')
  // a message that cannot be marked is not handed over (it would repeat at every call)
  writeFileSync(inp, readFileSync(inp, 'utf8') + JSON.stringify({ id: 'd', from: 'joey', text: '第四則', message_id: '14' }) + '\n')
  rmSync(join(d, 'run', 'steer', 'adam.worker.7.out.jsonl')); mkdirSync(join(d, 'run', 'steer', 'adam.worker.7.out.jsonl'))     // a directory where the file should be
  expect(runHook('lane-steer-hook.py', { hook_event_name: 'PostToolUse' }, env).out).toBe('')
})

test('E18 hook: lane-stop-hook hands over a pending message first and otherwise behaves as before (no transcript: nothing)', () => {
  const d = mkdtempSync(join(tmpdir(), 'lanes-e18s-'))
  mkdirSync(join(d, 'run', 'steer'), { recursive: true })
  const env = { LANES_DIR: d, LANE_ID: 'adam.worker.8' }
  expect(runHook('lane-stop-hook.py', { hook_event_name: 'Stop', session_id: 's', transcript_path: '/nonexistent' }, env).out).toBe('')
  writeFileSync(join(d, 'run', 'steer', 'adam.worker.8.in.jsonl'), JSON.stringify({ id: 'z', from: 'joey', text: '等一下，先停', message_id: '21' }) + '\n')
  const b = JSON.parse(runHook('lane-stop-hook.py', { hook_event_name: 'Stop', session_id: 's', transcript_path: '/nonexistent' }, env).out)
  expect(b.decision).toBe('block'); expect(b.reason).toContain('等一下，先停')
  expect(runHook('lane-stop-hook.py', { hook_event_name: 'Stop', session_id: 's', transcript_path: '/nonexistent' }, env).out).toBe('')     // delivered: back to as before
})

// ---- a daemon restart with a message with the run
test('E18: a message that was with a run when the daemon stopped is the lane\'s next run after the restart (the run is gone), never dropped', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'lanes-e18r-'))
  copyFileSync(ROUTER, join(d2, 'router.json'))
  mkdirSync(join(d2, 'run', 'steer'), { recursive: true })
  const ev = tg('tg-e18-r1', '先停一下，改查 5xx。', '3000')
  const lane = { id: 'adam.worker.1', kind: 'worker', n: 1, session_id: 's-r', thread: 'adam#t-w1', status: 'running', created: '', last: new Date().toISOString(), transcript: join(d2, 'none.jsonl'), runs: 1, tokens_in: 0, tokens_out: 0, topic: 555 }
  writeFileSync(join(d2, 'state.json'), JSON.stringify({ lanes: { 'adam.worker.1': lane }, threads: { 'adam#t-w1': { id: 'adam#t-w1', lane: 'adam.worker.1', peer: null, hops: 0, tokens: 0, created: '', last: '' } }, topics: { '555': 'adam.worker.1' },
    steering: { 'adam.worker.1': [{ ev, sent: Date.now() - 5000, run: 'adam.worker.1.r1' }] } }))
  writeFileSync(join(d2, 'run', 'steer', 'adam.worker.1.in.jsonl'), JSON.stringify({ id: 'tg-e18-r1', text: ev.text }) + '\n')
  writeFileSync(join(d2, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(d2, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
  const saved = process.env.LANES_DIR
  process.env.LANES_DIR = d2
  const L2 = await import('./lanes.ts?e18-restart') as typeof import('./lanes.ts')
  const bin2 = join(d2, 'lane.sh'); writeFileSync(bin2, `#!/bin/sh\necho $$ >> '${d2}/pids'\nexec python3 -c 'import time; time.sleep(30)' '${d2}'\n`); chmodSync(bin2, 0o755)
  const was = L2.__setClaudeBin(bin2)
  try {
    L2.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: d2, transcriptDir: d2, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => [], sendBot: async () => 1, joeyChatId: () => '1' } as any)
    process.env.LANES_DIR = saved
    const q = L2.__journal().rows('run', r => r.event === 'tg-e18-r1')[0]                       // M5: the run record (the journal is the queue)
    expect(q).toMatchObject({ lane: 'adam.worker.1', priority: 0 }); expect(q.ev.text).toContain('改查 5xx')
    expect(L2.__lanesState().steering ?? {}).toEqual({})
    expect(existsSync(join(d2, 'run', 'steer', 'adam.worker.1.in.jsonl'))).toBe(false)
    const led = readFileSync(join(d2, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(led.find(r => r.refs?.steer === 'requeued')?.text).toContain('daemon restarted')
  } finally { L2.__setClaudeBin(was); killFakes(d2) }
})
