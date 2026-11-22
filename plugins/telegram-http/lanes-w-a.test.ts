// 002w (A): ONE end of a lane run (runEnded). Whatever ended the run (normal, died, timeout, a cap, the budget, closed, a wall, a daemon restart, a refusal
// before it started, its lane gone), one function decides what follows over the run's event set (its event, what rides in it, Joey's messages steered into
// it, kept over re-runs): the re-run, the lanes' wall, a task lane's own duty (fan-out part, synthesis, curator) and the exit rule. Each test names the path
// and the gap of DUTY-INVENTORY.md it closes. The lane process is a script (it runs the lane's steer hook at its "tool boundaries"); no model, no network.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?w-a-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-w-a-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const HOOKS = join(import.meta.dir, 'lanes-hooks')
const bin = join(dir, 'lane.py')
// mode (read at start): tool = runs the steer hook at its tool boundaries until released; none = no tool boundary; called = like tool, after one model call;
// quick = ends at once. end (read when it ends): ok | die | wall
writeFileSync(bin, `#!/usr/bin/env python3
import sys, os, json, time, subprocess
D = '${dir}'; H = '${HOOKS}'
argv = sys.argv[1:]
mode = open(D + '/mode').read().strip()
open(D + '/prompts.jsonl', 'a').write(json.dumps({'prompt': argv[argv.index('-p') + 1]}) + '\\n')
open(D + '/pids', 'a').write(str(os.getpid()) + '\\n')
if mode == 'called':
    print(json.dumps({'type': 'assistant', 'message': {'id': 'msg-1', 'usage': {'input_tokens': 10, 'output_tokens': 5}, 'content': [{'type': 'text', 'text': 'looking'}]}}), flush=True)
if mode != 'quick':
    open(D + '/started', 'w').write('1')
    P0 = os.getppid(); T0 = time.time()
    while not os.path.exists(D + '/release'):
        time.sleep(0.1)
        if os.getppid() != P0 or time.time() - T0 > 120:
            sys.exit(1)
        if mode in ('tool', 'called'):
            subprocess.run(['python3', H + '/lane-steer-hook.py'], input=json.dumps({'hook_event_name': 'PostToolUse', 'tool_name': 'Bash', 'session_id': 's1'}), capture_output=True, text=True, env=os.environ)
    os.remove(D + '/release')
    os.remove(D + '/started')
end = open(D + '/end').read().strip() if os.path.exists(D + '/end') else 'ok'
if end == 'die':
    sys.exit(3)
if end == 'wall':
    print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': True, 'terminal_reason': 'api_error', 'api_error_status': 429, 'result': 'API Error: 429'}), flush=True)
    sys.exit(1)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'lane reached the end of its work'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
L.__setRetryBackoff(20)
function killFakes(d: string): void {
  let pids: number[] = []; try { pids = readFileSync(join(d, 'pids'), 'utf8').split('\n').map(Number).filter(n => n > 1) } catch {}
  for (const pid of pids) { let cmd = ''; try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8') } catch { continue }; if (cmd.includes(d)) try { process.kill(pid, 'SIGKILL') } catch {} }
}
afterAll(() => { try { writeFileSync(join(dir, 'release'), '1') } catch {}; killFakes(dir); L.__setClaudeBin(restore); L.__setRetryBackoff(5000); L.__setWallProbe(300_000); delete process.env.LANES_FLOOD_CONTROL })
const sent: Array<{ text: string; replyTo?: number }> = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async (_c: string, text: string, o: any) => { sent.push({ text, replyTo: o?.replyTo }); return 7700 + sent.length }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const st = L.__lanesState()
const LANE = 'adam.worker.1', TOPIC = '777'
st.lanes[LANE] = { id: LANE, kind: 'worker', n: 1, session_id: '32b0d8cc-1a32-4fd9-abac-1662c9fe4b44', thread: 'adam#t-wa', status: 'idle', created: '', last: new Date().toISOString(), transcript: join(dir, 'none.jsonl'), runs: 0, tokens_in: 0, tokens_out: 0, topic: Number(TOPIC) } as any
st.threads['adam#t-wa'] = { id: 'adam#t-wa', lane: LANE, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
st.topics[TOPIC] = LANE
const rows = (n: string, d = dir): any[] => { try { return readFileSync(join(d, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(25) } return f() }
const tg = (id: string, text: string, mid: string) => ({ id, source: 'telegram', from: 'joey', text, meta: { message_id: mid, chat_id: '1' }, notif: { method: '', params: {} }, message_thread_id: TOPIC } as any)
const f = (n: string) => join(dir, n)
const exits = (ev?: string) => rows('lanes.jsonl').filter(r => r.kind === 'exit' && (!ev || r.event === ev))
const runLines = (ev: string) => rows('lanes/state.jsonl').filter(l => l.rec === 'run' && l.event === ev)
const handoffs = (ev: string) => L.__main().items((r: any) => (r.kind === 'handoff' || r.kind === 'carry') && r.event === ev)
const joeyOb = (ev: string) => (L.__events().get(ev)?.obligations ?? []).find((o: any) => o.kind === 'joey')
function set(mode: string, end = 'ok') { writeFileSync(f('mode'), mode); writeFileSync(f('end'), end); try { rmSync(f('release')) } catch {} }
const release = () => writeFileSync(f('release'), '1')
async function startRun(mode: string, id: string, text: string, mid: string, end = 'ok') {
  set(mode, end)
  const d = await L.routeEvent(tg(id, text, mid))
  expect(d.lane).toBe(LANE)
  expect(await until(() => existsSync(f('started')))).toBe(true)
}
/** a lane files a memory proposal on its event's record (as lanes-dff does) */
async function propose(ev: string, text: string) {
  L.__events().open(ev, { class: 'peer', owner: LANE, lane: LANE, from: 'eve', text: 'x', obligations: [] })
  await L.callLaneTool({ runId: `${LANE}.rp`, lane: LANE, evId: ev, closers: [], critical: false, trigger: 'peer', cls: 'peer' } as any, 'ledger_write', { kind: 'memory_proposal', text })
}
async function idle() { expect(await until(() => !L.laneBusy(LANE) && !existsSync(f('started')), 10_000)).toBe(true) }

test('002w A, gap 2, path died → re-run: Joey\'s message steered into a run that dies is the re-run\'s (written on the run record): its line answers that message, its lane stop asks about the run\'s own event, the exit rule hands that one over', async () => {
  await startRun('tool', 'tg-wa-1', '盤點快照', '2100', 'die')
  await L.routeEvent(tg('tg-wa-2', '先只看最舊的那份。', '2101'))
  expect(await until(() => runLines('tg-wa-1').some(l => l.state === 'running' && (l.steered ?? []).some((e: any) => e.id === 'tg-wa-2')))).toBe(true)   // on the run's record
  release()
  expect(await until(() => exits('tg-wa-1').length === 1)).toBe(true)
  expect(exits('tg-wa-1')[0].reason).toBe('died')
  set('tool', 'ok')
  expect(await until(() => existsSync(f('started')) && L.__runTok(LANE) != null)).toBe(true)               // the re-run (backoff 20 ms)
  const tok = L.__runTok(LANE)!
  expect(L.__runEvents(LANE)).toEqual(['tg-wa-1', 'tg-wa-2'])
  // 2a936a7: the re-run's token had no steered message: this line met tg-wa-1 and quoted 2100, and tg-wa-2 stayed owed with nobody holding it
  expect(await L.callLaneTool(tok, 'notify_joey', { outcome: 'normal', text: '好，只看最舊的那份：10-30。' })).toContain('sent to Joey')
  expect(sent.at(-1)!.replyTo).toBe(2101)
  expect(joeyOb('tg-wa-2').state).toBe('met'); expect(joeyOb('tg-wa-1').state).toBe('open')
  expect(L.laneStop(tok)).toContain('lane-stop')                                                          // the run's own event is still owed
  release()
  expect(await until(() => handoffs('tg-wa-1').length === 1)).toBe(true)
  expect(handoffs('tg-wa-2').length).toBe(0)
  await idle()
})

test('002w A, gap 5, path wall: a walled run is queued again only while its event set still owes something (2a936a7 re-queued it unconditionally)', async () => {
  await startRun('tool', 'tg-wa-3', '看一下 p95', '2200', 'wall')
  expect(await L.callLaneTool(L.__runTok(LANE)!, 'notify_joey', { outcome: 'normal', text: 'p95 正常，120ms。' })).toContain('sent to Joey')
  expect(L.__events().get('tg-wa-3')!.state).toBe('closed')
  release()
  expect(await until(() => exits('tg-wa-3').length === 1)).toBe(true)
  expect(exits('tg-wa-3')[0].reason).toBe('wall:rate_limit')
  expect(L.wallActive()).toBe(true)                                                                       // the wall still goes up
  await sleep(100)
  expect(runLines('tg-wa-3').filter(l => l.state === 'queued').length).toBe(1)                             // not queued again: it owes nothing
  expect(rows('lanes/state.jsonl').some(l => l.rec === 'wake' && l.id === 'tg-wa-3' && l.state === 'no_wake' && String(l.reason).includes('owes nothing more'))).toBe(true)
  await L.__wallDown()
  await idle()
})

test('002w A, gap 12, path died: a run that reached the model and then died takes the lanes\' wall down (2a936a7: only a normal exit did, and pump stayed paused until the next backoff)', async () => {
  L.__setWallProbe(60_000)
  L.__wallUp('rate_limit', 'test wall')
  st.wall!.probe_at = 0                                                                                    // the next queued run is the probe
  await startRun('called', 'tg-wa-4', '查備份', '2300', 'die')
  expect(L.wallActive()).toBe(true)
  release()
  expect(await until(() => exits('tg-wa-4').length >= 1)).toBe(true)
  expect(exits('tg-wa-4')[0]).toMatchObject({ reason: 'died', calls: 1 })
  expect(await until(() => !L.wallActive())).toBe(true)
  expect(await until(() => existsSync(f('started')))).toBe(true)                                         // its re-run starts: the queue runs again
  set('tool', 'ok'); release()
  await idle()
})

test('002w A, gap 3, path normal with steering leftovers (extra): Joey\'s messages a run never reached ride in the next run; its exit rule hands over each one still owed (2a936a7: only the first)', async () => {
  await startRun('none', 'tg-wa-5', '開始', '2400')
  await L.routeEvent(tg('tg-wa-6', '改看 5xx。', '2401'))
  await L.routeEvent(tg('tg-wa-7', '順便看錯誤率。', '2402'))
  set('none', 'ok'); release()
  expect(await until(() => exits('tg-wa-5').length === 1 && existsSync(f('started')) && L.__runTok(LANE)?.evId === 'tg-wa-6')).toBe(true)
  expect(L.__runEvents(LANE)).toEqual(['tg-wa-6', 'tg-wa-7'])
  expect(L.laneStop(L.__runTok(LANE)!)).toContain('lane-stop')
  release()
  expect(await until(() => handoffs('tg-wa-6').length === 1 && handoffs('tg-wa-7').length === 1)).toBe(true)
  expect(JSON.stringify(handoffs('tg-wa-7')[0])).toContain('順便看錯誤率。')
  await idle()
})

test('002w A, gap 2, path restore: a run the daemon restart cut is run again while a Joey message steered into it still owes (on its run record); the re-run carries it and its exit rule hands it over', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'lanes-w-a-boot-'))
  copyFileSync(ROUTER, join(d2, 'router.json'))
  const OK = join(d2, 'ok.sh'); writeFileSync(OK, `#!/bin/sh\necho '{"type":"result","subtype":"success","is_error":false,"result":"done"}'\nexit 0\n`); chmodSync(OK, 0o755)
  writeFileSync(join(d2, 'state.json'), JSON.stringify({ counters: { worker: 1 }, lanes: { [LANE]: { id: LANE, kind: 'worker', n: 1, session_id: 's-wr', thread: 'adam#t-wr', status: 'running',
    created: '', last: '', transcript: join(d2, 'none.jsonl'), runs: 0, tokens_in: 0, tokens_out: 0 } }, threads: { 'adam#t-wr': { id: 'adam#t-wr', lane: LANE, peer: null, hops: 0, tokens: 0, created: '', last: '' } } }))
  mkdirSync(join(d2, 'lanes'), { recursive: true })
  const t = new Date().toISOString()
  const ev = (id: string, text: string) => ({ id, source: 'telegram', from: 'joey', text, meta: { message_id: id.slice(-4), chat_id: '1' }, notif: { method: '', params: {} } })
  writeFileSync(join(d2, 'lanes', 'state.jsonl'), [
    { ts: t, rec: 'event', id: 'tg-wr-1', state: 'closed', class: 'joey', owner: LANE, lane: LANE, from: 'joey', text: '盤點', obligations: [{ id: 'joey-1', kind: 'joey', level: 'line', state: 'met', ref: '9' }] },
    { ts: t, rec: 'event', id: 'tg-wr-2', state: 'open', class: 'joey', owner: LANE, lane: LANE, from: 'joey', text: '只看最舊的', obligations: [{ id: 'joey-2', kind: 'joey', level: 'line', state: 'open' }] },
    { ts: t, rec: 'run', id: 'tg-wr-1#1', state: 'queued', event: 'tg-wr-1', lane: LANE, attempt: 1, ev: ev('tg-wr-1', '盤點'), priority: 5, enqueued: t },
    { ts: t, rec: 'run', id: 'tg-wr-1#1', state: 'leased', event: 'tg-wr-1', lane: LANE, attempt: 1, run: `${LANE}.r1` },
    { ts: t, rec: 'run', id: 'tg-wr-1#1', state: 'running', event: 'tg-wr-1', lane: LANE, attempt: 1, run: `${LANE}.r1`, pid: 2_000_000_002 },
    { ts: t, rec: 'run', id: 'tg-wr-1#1', state: 'running', event: 'tg-wr-1', lane: LANE, attempt: 1, steered: [ev('tg-wr-2', '只看最舊的')] },
  ].map(x => JSON.stringify(x)).join('\n') + '\n')
  process.env.LANES_DIR = d2
  const B = await import('./lanes.ts?w-a-boot') as typeof import('./lanes.ts')
  B.__setClaudeBin(OK)
  B.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: d2, transcriptDir: d2, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => [] } as any)
  process.env.LANES_DIR = dir
  const runs = () => rows('lanes/state.jsonl', d2).filter(l => l.rec === 'run' && l.event === 'tg-wr-1')
  expect(runs().find(l => l.state === 'exited')).toMatchObject({ reason: 'died', signal: 'daemon-restart' })
  const again = runs().filter(l => l.state === 'queued' && l.attempt === 2)                               // 2a936a7: tg-wr-1 owes nothing: no_wake, and tg-wr-2 stayed open for ever
  expect(again.length).toBe(1); expect(again[0].steered.map((e: any) => e.id)).toEqual(['tg-wr-2'])
  expect(await until(() => B.__main().items((r: any) => r.kind === 'handoff' && r.event === 'tg-wr-2').length === 1)).toBe(true)
  expect(B.__main().items((r: any) => r.kind === 'handoff' && r.event === 'tg-wr-1').length).toBe(0)
})

test('002w A, gap 22, path lane gone: a queued run whose lane no longer exists ends through the exit rule: what its event owes goes to the main (2a936a7: dropped silently)', async () => {
  L.__setWallProbe(60_000); L.__wallUp('rate_limit', 'hold the queue')                                    // queued, not started
  st.lanes['adam.reflex.99'] = { id: 'adam.reflex.99', kind: 'reflex', n: 99, session_id: 's-r99', thread: 'adam#t-r99', status: 'idle', created: '', last: new Date().toISOString(), transcript: join(dir, 'r99.jsonl'), runs: 0, tokens_in: 0, tokens_out: 0 } as any
  st.threads['adam#t-r99'] = { id: 'adam#t-r99', lane: 'adam.reflex.99', peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
  L.__putQueue({ ev: tg('tg-wa-8', '查一下 mock-api', '2500'), lane: 'adam.reflex.99', state: 'queued', priority: 5, enqueued: new Date().toISOString() })
  delete st.lanes['adam.reflex.99']
  set('quick', 'ok')
  await L.__wallDown()
  expect(await until(() => handoffs('tg-wa-8').length === 1)).toBe(true)
  expect(runLines('tg-wa-8').find(l => l.state === 'exited')).toMatchObject({ reason: 'died', why: 'lane gone' })
})

test('002w A, gap 6, path normal without report_result: each fan-out part reports what it reached, so the synthesis starts; path normal without deliver_synthesis: the synthesis hands what it reached to the main', async () => {
  set('quick', 'ok')
  expect(await L.callMainTool('fan_out', { tasks: ['查 mock-api', '查 mock-backup'], conclusion: '各一行' }, 'mcp-main')).toContain('fan-out')
  const fo = Object.values(st.fanouts!).at(-1)!
  expect(await until(() => fo.members.every(m => fo.results[m] != null))).toBe(true)                      // 2a936a7: no result, no synthesis, the main never told
  for (const m of fo.members) { expect(fo.results[m]).toContain('沒有用 report_result 交回'); expect(fo.results[m]).toContain('lane reached the end of its work') }
  expect(fo.synthesis).toBeTruthy()
  const synEv = () => L.__events().rows((e: any) => e.lane === fo.synthesis)[0]
  expect(await until(() => !!synEv() && handoffs(synEv().id).length === 1)).toBe(true)
  const c = handoffs(synEv().id)[0]
  expect(c.kind).toBe('carry'); expect(String(c.notif.params.content)).toContain(`〔扇出結果｜${fo.id}〕`)
  expect(String(c.notif.params.content)).toContain('沒有用 deliver_synthesis 交回結論'); expect(String(c.notif.params.content)).toContain('lane reached the end of its work')
  expect(fo.done).toBeTruthy()
})

test('002w A, gap 6, paths closed before start and budget before start: a fan-out part refused before it ran reports 沒有結果, so the synthesis still starts', async () => {
  L.__setWallProbe(60_000); L.__wallUp('rate_limit', 'hold the queue')
  set('quick', 'ok')
  await L.callMainTool('fan_out', { tasks: ['查 A', '查 B', '查 C'], conclusion: '一句' }, 'mcp-main')
  const fo = Object.values(st.fanouts!).at(-1)!
  const [a, b] = fo.members
  expect(await L.callMainTool('lane_close', { lane_id: a }, 'mcp-main')).toContain('closed')
  st.threads[st.lanes[b].thread].fresh = 1e12                                                             // b's thread budget is spent before it starts
  await L.__wallDown()
  expect(await until(() => fo.members.every(m => fo.results[m] != null) && !!fo.synthesis)).toBe(true)    // 2a936a7: a and b never reported; no synthesis
  expect(fo.results[a]).toContain('車道被關閉'); expect(fo.results[a]).toContain('沒有結果')
  expect(fo.results[b]).toContain('對話線的 token 預算用完')
})

test('002w A, gap 7, path normal without curator_done: the curator\'s run ends, the write right returns to the main and the main is told once (2a936a7: S.curator stayed set; memory_decide and memory_revert refused)', async () => {
  set('quick', 'ok')
  await propose('ev-wa-p', '週三 14:00 維護窗口')
  expect(await L.callMainTool('curate_memory', {}, 'mcp-main')).toContain('holds the memory write right')
  const cur = st.curator!.lane, ev = st.curator!.event!
  expect(await until(() => st.curator === undefined)).toBe(true)
  expect(existsSync(join(dir, 'run', 'memory-writer'))).toBe(false)
  expect(await until(() => handoffs(ev).length === 1)).toBe(true)
  expect(JSON.stringify(handoffs(ev)[0])).toContain(`整理線 ${cur} 沒有用 curator_done 交回記憶寫入權就結束了`)
  expect(rows('lanes.jsonl').some(r => r.kind === 'write_right' && r.lane === cur && r.how === 'ended')).toBe(true)
})

test('002w A, gap 7, path lane_close of a curator with no run going: the write right returns at once and the main is told once (2a936a7: closeLane never touched it)', async () => {
  L.__setWallProbe(60_000); L.__wallUp('rate_limit', 'hold the queue')
  await propose('ev-wa-q', '備份在週日')
  expect(await L.callMainTool('curate_memory', {}, 'mcp-main')).toContain('holds the memory write right')
  const cur = st.curator!.lane, ev = st.curator!.event!
  expect(await L.callMainTool('lane_close', { lane_id: cur }, 'mcp-main')).toContain('closed')
  expect(st.curator).toBeUndefined()
  expect(handoffs(ev).length).toBe(1)
  await L.__wallDown()
  await sleep(300)
  expect(handoffs(ev).length).toBe(1)                                                                     // its queued run, refused (closed), tells the main nothing more
})
