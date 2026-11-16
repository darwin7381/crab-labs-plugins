// Universe 002l (D14 = RV2 N5, RV4 T2-R #6, RV2 T6-R #1 / T7-R #6): the lane's receipt tool does not complete a scheduler run the same lane run already
// completed (with the card's ./bin/btcc-receipt, or an earlier receipt call). design/stability 「每則訊息只租給一條線」; one owner per event. The lane is a
// script printing stream-json; the inbox daemon is a local stand-in that counts the completions.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const completes: any[] = []
const inbox = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { const b = await req.json() as any; if (new URL(req.url).pathname === '/lanes/scheduler') completes.push(b); return Response.json({ text: `run ${b.run_id} completed` }) } })
process.env.LANES_INBOX_PORT = String(inbox.port)                                      // read at import: this instance posts to the stand-in
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?pl-d14-test') as typeof import('./lanes.ts')
delete process.env.LANES_INBOX_PORT
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-pld14-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, time
mode = open('${dir}/mode').read().strip()
import os
rid = open('${dir}/rid').read().strip() if os.path.exists('${dir}/rid') else '51'
if mode in ('cli', 'cli-fail'):
    print(json.dumps({'type': 'assistant', 'message': {'id': 'm1', 'content': [{'type': 'tool_use', 'id': 'tu-r', 'name': 'Bash', 'input': {'command': './bin/btcc-receipt complete ' + rid + ' --outcome failed --note "p95 260"'}}], 'usage': {'input_tokens': 5, 'output_tokens': 5}}}), flush=True)
    res = {'type': 'tool_result', 'tool_use_id': 'tu-r', 'content': '{"run_id": ' + rid + ', "state": "completed", "outcome": "failed"}'} if mode == 'cli' else {'type': 'tool_result', 'tool_use_id': 'tu-r', 'is_error': True, 'content': 'btcc-receipt: scheduler unreachable'}
    print(json.dumps({'type': 'user', 'message': {'content': [res]}}), flush=True)
time.sleep(2)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => { L.__setClaudeBin(restore); inbox.stop(true); delete process.env.LANES_FLOOD_CONTROL })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const sched = (id: string, run: number) => ({ id, source: 'mesh', from: 'scheduler', verified: true, text: `[scheduled][health][run:${run}][P3][routine] 檢查 mock-api health`, meta: {}, notif: { method: '', params: {} } } as any)
const receipt = (tok: any, run: string) => L.callLaneTool(tok, 'receipt', { run_id: run, outcome: 'nothing-to-do', happened: 'health ok', did: 'GET health', promised: '無', needs_main: '無' })

test('D14: cliReceiptRun reads the card\'s CLI', () => {
  expect(L.cliReceiptRun('./bin/btcc-receipt complete 51 --outcome nothing-to-do --note "x"')).toBe('51')
  expect(L.cliReceiptRun('cd /w && ./bin/btcc-receipt complete 3 --outcome done')).toBe('3')
  expect(L.cliReceiptRun('./bin/btcc-receipt ack 51')).toBeNull()
  expect(L.cliReceiptRun('./bin/svc GET mock-api/health')).toBeNull()
})

test('D14: the lane completed run 51 with ./bin/btcc-receipt; its receipt(run_id 51) records the receipt and does NOT complete the run again', async () => {
  writeFileSync(join(dir, 'mode'), 'cli')
  const d = await L.routeEvent(sched('mesh-s51', 51))
  expect(await until(() => (L.__runTok(d.lane!)?.completedRuns ?? []).includes('51'))).toBe(true)
  const out = await receipt(L.__runTok(d.lane!)!, '51')
  expect(out).toContain('already completed'); expect(completes.length).toBe(0)
})

test('D14: without the CLI the receipt completes the run once; a second receipt for the same run does not', async () => {
  writeFileSync(join(dir, 'mode'), 'plain')
  const d = await L.routeEvent(sched('mesh-s52', 52))
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  const tok = L.__runTok(d.lane!)!
  expect(await receipt(tok, '52')).toContain('scheduler: run 52 completed')
  expect(await receipt(tok, '52')).toContain('already completed')
  expect(completes.filter(c => String(c.run_id) === '52').length).toBe(1)
})

test('D14: a CLI call that failed does not count: the receipt completes the run', async () => {
  writeFileSync(join(dir, 'mode'), 'cli-fail'); writeFileSync(join(dir, 'rid'), '54')      // 002m: its own run (51 was completed for real above)
  const d = await L.routeEvent(sched('mesh-s53', 54))
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  await sleep(300)
  expect(L.__runTok(d.lane!)!.completedRuns ?? []).toEqual([])
  await receipt(L.__runTok(d.lane!)!, '54')
  expect(completes.filter(c => String(c.run_id) === '54').length).toBe(1)
  await until(() => !L.__runTok(d.lane!), 5000)
  writeFileSync(join(dir, 'rid'), '51')
})

test('L6B4 (002m): a later lane run of the same thread (a follow-up) that files receipt(run_id) for a scheduled run completed earlier does not complete it again', async () => {
  writeFileSync(join(dir, 'mode'), 'plain')
  const d = await L.routeEvent(sched('mesh-s60', 60))
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  expect(await receipt(L.__runTok(d.lane!)!, '60')).toContain('scheduler: run 60 completed')
  const first = L.__runTok(d.lane!)!.runId
  expect(await until(() => !L.__runTok(d.lane!), 5000)).toBe(true)
  // the follow-up run: a new lane-run token, the same scheduled run
  const tok2 = { runId: `${d.lane}.r9`, lane: d.lane, evId: 'mesh-s60-fu', closers: [], critical: false, trigger: 'followup', cls: 'routine', escalated: false, pushed: false, followup: 'fu-1' } as any
  const out = await receipt(tok2, '60')
  expect(out).toContain(`already completed by ${first}`)
  expect(completes.filter(c => String(c.run_id) === '60').length).toBe(1)
  expect(L.__lanesState().sched_done?.['60']).toMatchObject({ run: first, by: 'receipt' })
  // a CLI completion is recorded the same way (run 51, test 2)
  expect(L.__lanesState().sched_done?.['51']).toMatchObject({ by: 'cli' })
})

test('D14: the card maps ./bin/btcc-receipt to receipt and says not to use both', () => {
  const card = L.identityCard({ kind: 'reflex' })
  expect(card).toContain('./bin/btcc-receipt 就是 receipt(run_id, outcome)'); expect(card).toContain('不要再跑 ./bin/btcc-receipt')
})
