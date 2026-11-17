// The router's records (PL6, AUD P18/P19): one writer for a route record (routing.jsonl and its Logos mirror lane.route get the same row, for every
// rule), and the row carries the owner's thread (the conversation the event belongs to after routing; `peer_thread` is what the sender supplied).
// A Logos stand-in collects the mirror. No model, no network.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer } from 'http'
process.env.LANES_FLOOD_CONTROL = '0'
const mirror: any[] = []
const logosSrv = createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { mirror.push(JSON.parse(b)) } catch {} res.end('{}') }) })
await new Promise<void>(r => logosSrv.listen(0, '127.0.0.1', () => r()))
process.env.GENESIS_LOGOS_URL = `http://127.0.0.1:${(logosSrv.address() as any).port}`
const L = await import('./lanes.ts?router-test') as typeof import('./lanes.ts')
delete process.env.GENESIS_LOGOS_URL
const dir = mkdtempSync(join(tmpdir(), 'lanes-router-'))
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
L.__setMeshSend(async b => ({ text: `sent to ${b.to}`, msgId: 60000 + Math.floor(Math.random() * 1000), delivered: true }))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'],
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
afterAll(() => { try { writeFileSync(GO, 'ok') } catch {}; logosSrv.close(); L.__setClaudeBin(restore); delete process.env.LANES_FLOOD_CONTROL })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const routing = (): any[] => readFileSync(join(dir, 'routing.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
const routes = () => mirror.filter(r => r.kind === 'lane.route')
let n = 0
const mk = (from: string, text: string, extra: object = {}) => ({ id: `mesh-rt-${++n}`, source: 'mesh', from, verified: true, text, meta: {}, notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } }, ...extra } as any)

test('PL6 P18 (C04, H04): the thread-gate row carries the stopped (owner\'s) thread, and the peer\'s own thread separately; P19: the stopped event keeps its real class and owner', async () => {
  const d1 = await L.routeEvent(mk('eve', '一個問題'))
  const th = L.__lanesState().lanes[d1.lane!].thread
  expect(routing().find(r => r.event === `mesh-rt-${n}`)).toMatchObject({ rule: 'mesh-peer-new', lane: d1.lane, thread: th })
  L.__lanesState().threads[th].hops = 6
  const stop = await L.routeEvent(mk('eve', '再問一次', { thread: th, hop: 7, reply_to_id: 'x' }))
  expect(stop).toMatchObject({ rule: 'thread-gate', thread: th })
  const row = routing().find(r => r.event === `mesh-rt-${n}`)
  expect(row).toMatchObject({ rule: 'thread-gate', target: 'ledger', thread: th, peer_thread: th })     // 002o: thread null
  expect(L.__events().get(`mesh-rt-${n}`)).toMatchObject({ class: 'peer', owner: d1.lane, stop: { why: 'hop', thread: th } })   // not 'peer'/'main' hard-coded by a hand-over
  const later = await L.routeEvent(mk('eve', '還在嗎', { thread: th, hop: 8, reply_to_id: 'x' }))
  expect(routing().find(r => r.event === `mesh-rt-${n}`)).toMatchObject({ rule: 'thread-gate', thread: th }); expect(later.note).toContain('already stopped')
  writeFileSync(GO, 'ok'); await until(() => !L.__runTok(d1.lane!))
})

test('PL6: every route row is written by one function: routing.jsonl and lane.route carry the same rows, the follow-up, coalesced, drain, fan-out and digest rows included', async () => {
  // a follow-up row (the origin event, its follow-up id, the thread)
  const a = await L.routeEvent(mk('cain', '下午再確認一次備份'))
  expect(await until(() => !!L.__runTok(a.lane!))).toBe(true)
  const tok = L.__runTok(a.lane!)!
  await L.callLaneTool(tok, 'followup', { after_minutes: 5, note: '再看備份' })
  writeFileSync(GO, 'ok'); await until(() => !L.__runTok(a.lane!)); await sleep(30)
  const f = Object.values(L.__lanesState().followups).find(x => x.event === tok.evId)!
  f.due = Date.now() - 1; L.followupTick()
  expect(await until(() => !!L.__runTok(a.lane!))).toBe(true)
  writeFileSync(GO, 'ok'); await until(() => !L.__runTok(a.lane!))
  // a digest row
  L.__digest()
  await sleep(200)                                                                                       // the mirror is posted without waiting
  const rows = routing()
  for (const rule of ['mesh-peer-new', 'thread-gate', 'followup', 'digest']) expect(rows.some(r => r.rule === rule)).toBe(true)
  expect(rows.find(r => r.rule === 'followup')).toMatchObject({ event: tok.evId, followup: f.id, thread: L.__lanesState().lanes[a.lane!].thread })
  const key = (r: any) => `${r.event}|${r.rule}|${r.target}|${r.thread ?? ''}`
  expect(routes().map(key).sort()).toEqual(rows.map(key).sort())                                       // the mirror IS the record
})
