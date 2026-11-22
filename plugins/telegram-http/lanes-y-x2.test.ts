// Universe 002y (X-2; 002x G05 r1-r3, e.g. u002x-G05-s6-r3-20261121-062509): a lane's restart was written to the ledger only when the restart command
// returned (002m L6B1). In G05 the lane ran `./bin/svc POST mock-api/restart`, the service restarted (Logos svc.call restart POST 200), God killed the
// lane before the tool result came back, and the re-run (same lane, attempt 2) asked ledger_query("restart") and found nothing: 「帳本沒有 restart 紀錄，
// 所以無法確認重啟是否執行」. The record exists from the moment the command is sent, and is settled when its result comes back, when the run ends
// without it, or when the daemon stopped with the run. One restart is one entry in ledger_query (runbook §4 counts them). The lane is a script
// printing stream-json; no model, no network.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?y-x2-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-y-x2-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'c40fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, time, sys
mode = open('${dir}/mode').read().strip()
if mode == 'after':
    print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True); sys.exit(0)
print(json.dumps({'type': 'assistant', 'message': {'id': 'm1', 'usage': {'input_tokens': 3, 'output_tokens': 4}, 'content': [{'type': 'tool_use', 'id': 'tu1', 'name': 'Bash', 'input': {'command': './bin/svc POST mock-api/restart'}}]}}), flush=True)
if mode == 'hang':
    time.sleep(30)
res = '{"error": "mock-api restart failed: 503"}' if mode == 'fail' else '{"ok": true, "restarted": "mock-api"}'
print(json.dumps({'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': 'tu1', 'content': res}]}}), flush=True)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const mode = (m: string) => writeFileSync(join(dir, 'mode'), m)
mode('ok')
const restore = L.__setClaudeBin(bin)
L.__setRetryBackoff(20)
afterAll(() => { mode('after'); L.__setClaudeBin(restore); L.__setRetryBackoff(5000); delete process.env.LANES_FLOOD_CONTROL })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const rows = (d = dir): any[] => { try { return readFileSync(join(d, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const lanesLog = (): any[] => readFileSync(join(dir, 'lanes.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
let n = 0
const alert = (text: string) => ({ id: `mesh-x2-${++n}`, source: 'mesh', from: 'alert-dispatcher', verified: true, text, meta: {}, notif: { method: '', params: {} } } as any)
const exitsOf = (ev: string) => lanesLog().filter(r => r.kind === 'exit' && r.event === ev)
const tok = () => ({ runId: 'q.r1', lane: Object.keys(L.__lanesState().lanes)[0], evId: 'q', closers: [], critical: false, trigger: 'alert', cls: 'alert', escalated: false, pushed: false } as any)
/** what a lane's ledger_query(text="restart mock-api") lists: its action lines */
const listed = async (): Promise<string[]> => (await L.callLaneTool(tok(), 'ledger_query', { since: '-1h', text: 'restart mock-api' })).split('\n').filter(l => l.includes('｜action｜') && l.includes('restart mock-api'))

test('002y X-2 (G05): the lane is killed after it sent the restart and before the result: the record is there from the send, the kill settles it 「結果不明」, the re-run finds exactly one', async () => {
  mode('hang')
  const ev = alert('[P1][critical] mock-api 錯誤率 8%、p95 2.6s（alert A-1301）')
  await L.routeEvent(ev)
  expect(await until(() => rows().some(r => r.event === ev.id && r.refs?.restart === 'mock-api'))).toBe(true)
  const sentRow = rows().find(r => r.event === ev.id && r.refs?.restart === 'mock-api')
  expect(exitsOf(ev.id).length).toBe(0)                                                        // the run is still going: the record exists from the send
  expect(sentRow).toMatchObject({ kind: 'action', refs: { restart: 'mock-api', state: 'sent', cmd: './bin/svc POST mock-api/restart' } })
  expect(sentRow.text).toMatch(/^restart mock-api（已送出，結果還沒回來）/)
  expect(await listed()).toEqual([expect.stringContaining('已送出，結果還沒回來')])
  mode('after')                                                                                // the re-run (attempt 2) does nothing more
  const pid = lanesLog().filter(r => r.kind === 'spawn' && r.event === ev.id).at(-1).pid
  process.kill(pid, 'SIGKILL')                                                                 // God's kill-lane
  expect(await until(() => exitsOf(ev.id).length >= 2)).toBe(true)                             // died, then the re-run
  expect(exitsOf(ev.id)[0]).toMatchObject({ reason: 'died', signal: 'SIGKILL' })
  const mine = rows().filter(r => r.event === ev.id && r.refs?.restart === 'mock-api')
  expect(mine.length).toBe(2)                                                                  // sent, settled
  expect(mine[1].refs).toMatchObject({ settles: sentRow.refs.record, state: 'unknown', ok: null })
  expect(mine[1].text).toContain('結果不明'); expect(mine[1].text).toContain('SIGKILL')
  const l = await listed()
  expect(l.length).toBe(1)                                                                     // one restart, one entry, as it ended
  expect(l[0]).toContain('結果不明'); expect(l[0]).not.toContain('結果還沒回來')
})

test('002y X-2: a restart whose result comes back is one entry with its outcome (ok, or 沒有成功); runbook §4 counts each restart once', async () => {
  mode('ok'); const a = alert('[P2][warning] mock-api p95 偏高（早上）'); await L.routeEvent(a); expect(await until(() => exitsOf(a.id).length >= 1)).toBe(true)
  mode('fail'); const b = alert('[P2][warning] mock-api p95 偏高（中午）'); await L.routeEvent(b); expect(await until(() => exitsOf(b.id).length >= 1)).toBe(true)
  const of = (ev: string) => rows().filter(r => r.event === ev && r.refs?.restart === 'mock-api')
  expect(of(a.id).map(r => r.refs.state)).toEqual(['sent', 'ok']); expect(of(a.id)[1].refs).toMatchObject({ settles: of(a.id)[0].refs.record, ok: true })
  expect(of(b.id).map(r => r.refs.state)).toEqual(['sent', 'failed']); expect(of(b.id)[1].refs.ok).toBe(false)
  const l = await listed()
  expect(l.length).toBe(3)                                                                     // the killed one, the ok one, the failed one
  expect(l[1]).toMatch(/restart mock-api：adam\.reflex\.\d+ 執行 \.\/bin\/svc POST mock-api\/restart/)
  expect(l[2]).toContain('restart mock-api（沒有成功）')
})

test('002y X-2: the daemon stopped while a restart was out: at boot the run\'s pending restart is settled 「結果不明」 with the run', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'lanes-y-x2r-'))
  copyFileSync(ROUTER, join(d2, 'router.json'))
  writeFileSync(join(d2, 'main.json'), JSON.stringify({ session_id: 'c40fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(d2, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
  const lane = { id: 'adam.reflex.1', kind: 'reflex', n: 1, session_id: 's-x2', thread: 'adam#t-x2', status: 'running', created: '', last: new Date().toISOString(), transcript: join(d2, 'none.jsonl'), runs: 0, tokens_in: 0, tokens_out: 0 }
  writeFileSync(join(d2, 'state.json'), JSON.stringify({ lanes: { [lane.id]: lane }, threads: { [lane.thread]: { id: lane.thread, lane: lane.id, peer: null, hops: 0, tokens: 0, created: '', last: '' } } }))
  // the run record as the previous daemon left it: running, with the restart it had sent (the line written at the send)
  const ev = { id: 'mesh-x2-boot', source: 'mesh', from: 'alert-dispatcher', verified: true, text: '[P1][critical] mock-api 5xx', meta: {}, notif: { method: '', params: {} } }
  const t = new Date().toISOString()
  mkdirSync(join(d2, 'lanes'), { recursive: true })
  writeFileSync(join(d2, 'lanes', 'state.jsonl'), [
    { ts: t, rec: 'run', id: 'mesh-x2-boot#1', state: 'queued', event: ev.id, lane: lane.id, attempt: 1, ev, priority: 1, enqueued: t },
    { ts: t, rec: 'run', id: 'mesh-x2-boot#1', state: 'running', event: ev.id, lane: lane.id, attempt: 1, run: 'adam.reflex.1.r1', pid: 0,
      restarts: [{ record: 'rst-x2boot', svc: 'mock-api', cmd: './bin/svc POST mock-api/restart' }] },
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
  writeFileSync(join(d2, 'ledger.jsonl'), JSON.stringify({ ts: t, lane: lane.id, thread: lane.thread, event: ev.id, kind: 'action', text: 'restart mock-api（已送出，結果還沒回來）：adam.reflex.1 執行 ./bin/svc POST mock-api/restart',
    refs: { restart: 'mock-api', ok: null, state: 'sent', cmd: './bin/svc POST mock-api/restart', run: 'adam.reflex.1.r1', record: 'rst-x2boot' }, detail: null }) + '\n')
  const saved = process.env.LANES_DIR
  process.env.LANES_DIR = d2
  const L2 = await import('./lanes.ts?y-x2-boot') as typeof import('./lanes.ts')
  const was = L2.__setClaudeBin(join(import.meta.dir, 'test-fixtures', 'no-claude.sh'))
  try {
    L2.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: d2, transcriptDir: d2, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => [], sendBot: async () => 1, joeyChatId: () => '1' } as any)
    process.env.LANES_DIR = saved
    const settle = rows(d2).find(r => r.refs?.settles === 'rst-x2boot')
    expect(settle).toMatchObject({ kind: 'action', event: ev.id, refs: { restart: 'mock-api', state: 'unknown', ok: null } })
    expect(settle.text).toContain('結果不明'); expect(settle.text).toContain('daemon 重啟')
  } finally { L2.__setClaudeBin(was); process.env.LANES_DIR = saved }
})
