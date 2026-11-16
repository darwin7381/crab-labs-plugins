// Universe 002m (L6B6, RV6 B r1: closers notify_joey, ask_joey, receipt, cut by --max-turns 12; the stop woke the main and it sent #1027, the same question
// as ask #1026): a run cut by its cap after it already asked Joey (or handed the event to the main) does not wake the main again; the stop still reaches its
// next digest. DC1, one report per event. The lane is a script printing stream-json; no model, no network.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?pl2-b6-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-pl2-b6-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, sys
tools = json.loads(open('${dir}/tools').read())
for i, t in enumerate(tools):
    print(json.dumps({'type': 'assistant', 'message': {'id': 'm%d' % i, 'usage': {'input_tokens': 1, 'output_tokens': 1}, 'content': [{'type': 'tool_use', 'id': 't%d' % i, 'name': t, 'input': {'text': 'x'}}]}}), flush=True)
print(json.dumps({'type': 'result', 'subtype': 'error_max_turns', 'is_error': True, 'num_turns': 12}), flush=True)
sys.exit(1)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => { L.__setClaudeBin(restore); delete process.env.LANES_FLOOD_CONTROL })
const sent: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async (_c: string, t: string) => { sent.push(t); return 100 + sent.length }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const rows = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const sched = (id: string, run: number, what: string) => ({ id, source: 'mesh', from: 'scheduler', verified: true, text: `[scheduled][${what}][run:${run}][P3][routine] ${what}`, meta: {}, notif: { method: '', params: {} } } as any)
const lineOf = () => readFileSync(join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).length

test('L6B6: cut by --max-turns after ask_joey: the stop is in the digest, marked wake false, and wakes nobody; no capped notice to Joey', async () => {
  writeFileSync(join(dir, 'tools'), JSON.stringify(['mcp__lane__receipt', 'mcp__lane__notify_joey', 'mcp__lane__ask_joey', 'mcp__lane__receipt']))
  writeFileSync(join(dir, 'digest.json'), JSON.stringify({ line: rows().length }))
  const s0 = sent.length
  await L.routeEvent(sched('mesh-b6a', 32, 'backup-check'))
  expect(await until(() => rows().some(r => r.kind === 'stop' && r.event === 'mesh-b6a'))).toBe(true)
  const stop = rows().find(r => r.kind === 'stop' && r.event === 'mesh-b6a')
  expect(stop.notify_main).toBe(true)
  expect(stop.refs).toMatchObject({ capped: 'turns', wake: false, owned_by: 'ask_joey' })
  expect(stop.text).toContain('已經用 ask_joey 問過 Joey')
  expect(L.takePendingDigest(true, 'wake')).toBeNull()                        // nothing wakes the main
  const d = L.takePendingDigest(false, 'piggyback')!
  expect(d.text).toContain('mesh-b6a')                                         // it rides in the next digest
  await sleep(100)
  expect(sent.length).toBe(s0)                                                 // and Joey hears nothing more from the router
})

test('L6B6: cut after handoff_main: no second wake either', async () => {
  writeFileSync(join(dir, 'tools'), JSON.stringify(['mcp__lane__handoff_main']))
  writeFileSync(join(dir, 'digest.json'), JSON.stringify({ line: lineOf() }))
  await L.routeEvent(sched('mesh-b6b', 33, 'ticket-digest'))
  expect(await until(() => rows().some(r => r.kind === 'stop' && r.event === 'mesh-b6b'))).toBe(true)
  expect(rows().find(r => r.kind === 'stop' && r.event === 'mesh-b6b').refs).toMatchObject({ wake: false, owned_by: 'handoff_main' })
})

test('L6B6: cut after only a notify_joey: the main is woken to take over, as before', async () => {
  writeFileSync(join(dir, 'tools'), JSON.stringify(['mcp__lane__notify_joey']))
  writeFileSync(join(dir, 'digest.json'), JSON.stringify({ line: lineOf() }))
  await L.routeEvent(sched('mesh-b6c', 34, 'health-sweep'))
  expect(await until(() => rows().some(r => r.kind === 'stop' && r.event === 'mesh-b6c'))).toBe(true)
  const stop = rows().find(r => r.kind === 'stop' && r.event === 'mesh-b6c')
  expect(stop.refs.wake).toBeUndefined()
  const w = L.takePendingDigest(true, 'wake')
  expect(w).not.toBeNull(); expect(w!.wake).toBe(true)
})
