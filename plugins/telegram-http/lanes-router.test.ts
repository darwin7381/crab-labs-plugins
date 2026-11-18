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
const meshOut: any[] = []
L.__setMeshSend(async b => { meshOut.push(b); return { text: `sent to ${b.to}`, msgId: 60000 + Math.floor(Math.random() * 1000), delivered: true } })
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
  // 002r (C04): the peer is told once that the exchange stopped, in the router's words, no_reply; the record has it as the router's own met line
  const stopId = `mesh-rt-${n}`
  await until(() => (L.__events().get(stopId)?.obligations ?? []).some((o: any) => o.level === 'stop-notice'))
  const told = meshOut.filter(m => m.to === 'eve' && m.no_reply === true)
  expect(told.length).toBe(1); expect(told[0]).toMatchObject({ thread: th, lane: 'router' }); expect(told[0].text).toContain('轉手次數'); expect(told[0].text).toContain('不用回')
  expect((L.__events().get(stopId)!.obligations as any[]).find(o => o.level === 'stop-notice')).toMatchObject({ kind: 'peer', to: 'eve', owner: 'router', state: 'met', by: 'router' })
  const later = await L.routeEvent(mk('eve', '還在嗎', { thread: th, hop: 8, reply_to_id: 'x' }))
  expect(routing().find(r => r.event === `mesh-rt-${n}`)).toMatchObject({ rule: 'thread-gate', thread: th }); expect(later.note).toContain('already stopped')
  await sleep(50); expect(meshOut.filter(m => m.to === 'eve' && m.no_reply === true).length).toBe(1)   // a message on a stopped thread is not told again
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

// 002p (A05, FXL's live smoke): Eve's e2/e3 quote her OWN e1 (reply_to = e1's btcc id). The router read only the ids of messages WE sent, so each opened a
// new reflex lane (three lanes, three answers to one question). A message that quotes the peer's own earlier message belongs to the conversation that
// message went into: its origin event's thread and that thread's owner; queued behind the running run, the two follow-ups are its next run together.
test('002p A05: follow-ups that quote the peer\'s own message go to its origin event\'s thread and lane (one owner); another peer quoting it does not', async () => {
  const e1 = mk('eve', 'mock-api 的 /v2/notifications 今天會不會維護？', { btcc_msg_id: '91001' })
  const d1 = await L.routeEvent(e1)
  expect(d1).toMatchObject({ rule: 'mesh-peer-new', target: 'lane' })
  const th = L.__lanesState().lanes[d1.lane!].thread
  expect(await until(() => !!L.__runTok(d1.lane!))).toBe(true)                               // e1's run is in progress
  const e2 = mk('eve', '補充：我 14:00 要用。', { btcc_msg_id: '91002', reply_to_id: '91001' })
  const e3 = mk('eve', '能不能延到 15:00 之後？', { btcc_msg_id: '91003', reply_to_id: '91001' })
  const d2 = await L.routeEvent(e2), d3 = await L.routeEvent(e3)
  for (const [d, e] of [[d2, e2], [d3, e3]] as const) {
    expect(d).toMatchObject({ rule: 'mesh-thread', target: 'lane', lane: d1.lane })
    expect(routing().find(r => r.event === e.id)).toMatchObject({ rule: 'mesh-thread', lane: d1.lane, thread: th })
    expect(L.__events().get(e.id)).toMatchObject({ owner: d1.lane, thread: th, class: 'peer' })
  }
  const c = await L.routeEvent(mk('cain', '我也想知道', { btcc_msg_id: '91004', reply_to_id: '91001' }))
  expect(c.rule).toBe('mesh-peer-new'); expect(c.lane).not.toBe(d1.lane)                    // only the thread's peer speaks in it
  writeFileSync(GO, 'ok'); await until(() => L.__runTok(d1.lane!)?.evId === e2.id)           // e1's run ends; the follow-ups are the lane's next run, together
  expect(L.__runTok(d1.lane!)?.evId).toBe(e2.id)
  expect(routing().find(r => r.event === e3.id && r.rule === 'coalesced')).toMatchObject({ into: e2.id, lane: d1.lane, thread: th })
  writeFileSync(GO, 'ok'); await until(() => !L.__runTok(d1.lane!))
  writeFileSync(GO, 'ok'); await until(() => !L.__runTok(c.lane!))
}, 30_000)
