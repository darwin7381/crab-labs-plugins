// WO-175 item 3 (Chiron's lab record, WO-174 第 7 條: Call 401, scheduler → nestor, run 7232, routed held:wall during the 11-26 06:57Z weekly limit; the
// clear 07:12Z by the account switch, probe_after_switch; still queued an hour later). nestor's own record (read-only, 1.58.12): M1 queued it 07:07:10Z
// (no_wake 「main walled」), usage_wall.py cleared the episode 07:12:21Z, the status record stayed walled (the screen's limit message, judged by Jev) until a
// /clear redrew the screen, and M1 offered it 07:25:31Z.
// Here, as in production: the router (LANES_WAKE_DECIDE, nestor's router: scheduled runs to the main), the usage-wall state file as usage_wall.py writes it
// read by the real WallReader, the status record composed as server.ts composes it (the program's wall, Jev's verdict on nestor's screen, the cleared
// limit text), the daemon's onWallChange handing the clear to the lanes (usageWallChanged), and the Call's moments (CallFacts through the journal tap).
//   an item the wall holds is not offered while the state says walled; at the clear (probe_after_switch) it is offered in the same step, with the limit
//   message still on the screen, and its Call goes on: accepted (main) → running (bound) → completed; a gen the wall walled (StopFailure) the same (WO-120)
import { test, expect, afterAll } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { publishView, regions, type ScreenVerdict } from './screen-status.ts'
import { CallFacts, DeliveryFacts, LanesTap, type StatusView } from './onsen-status.ts'
import { WallReader, clearedLimitTextOf, type WallState } from './usage-wall.ts'
import type { CallStateLine } from './onsen-client.ts'

const AGENT = 'wo175wall'
// the agent-inbox daemon as the Telegram daemon reaches it (LANES_INBOX_PORT): the main's inbox stream takes an offer (a mesh item goes out through it)
const offered: any[] = []
const inboxSrv = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const u = new URL(req.url)
  if (u.pathname === '/lanes/offer') { offered.push(await req.json().catch(() => ({}))); return Response.json({ offered: true }) }
  return Response.json({})
} })
process.env.LANES_INBOX_PORT = String(inboxSrv.port)
process.env.LANES_WAKE_DECIDE = AGENT
process.env.LANES_FLOOD_CONTROL = '0'
process.env.LANES_RECEIPT_STEPS = '0'
const L = await import('./lanes.ts?wo175wall') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-wo175wall-'))
process.env.LANES_DIR = dir
// nestor's router: the scheduled runs stay with the main (its .lanes/router.json, 「until Joey says lanes may take them」)
const router = JSON.parse(readFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), 'utf8'))
for (const r of router.rules) if (r.id === 'mesh-scheduled') r.to = 'main'
writeFileSync(join(dir, 'router.json'), JSON.stringify(router))
const bin = join(dir, 'lane.sh')
writeFileSync(bin, '#!/bin/sh\necho \'{"type":"result","subtype":"success","is_error":false,"result":"ok"}\'\n')
chmodSync(bin, 0o755)
const restoreBin = L.__setClaudeBin(bin)

// ---- the usage wall as usage_wall.py writes it (~/.claude/usage-wall/<tmux key>.json), read by the daemon's WallReader
const wallDir = join(dir, 'usage-wall'), TMUX = `claude-${AGENT}`
mkdirSync(wallDir, { recursive: true })
const LIMIT = "You've hit your weekly limit · resets Dec 2 at 3pm (Asia/Taipei)"
let episode = 0
const ep = () => `${AGENT}-wall-${episode}`
function writeWall(o: Record<string, unknown>): void {
  writeFileSync(join(wallDir, `${TMUX}.json`), JSON.stringify({ agent: AGENT, tmux: TMUX, session: 's1', in_wall: true, episode: ep(), since: new Date(Date.now() - 60_000).toISOString(),
    since_src: 'transcript', error: 'rate_limit', kind: 'weekly', resets_at: '2026-12-02T07:00:00Z', text: LIMIT, cleared_at: null, cleared_by: null,
    last_transcript_wall: new Date(Date.now() - 60_000).toISOString(), updated_at: new Date().toISOString(), ...o }))
}
const clears: Array<WallState | null> = []
// server.ts onWallChange, its lanes step: a clear (walled → not) goes to the lanes in the same step
const reader = new WallReader({ tmux: TMUX, agent: AGENT }, { dir: wallDir, cacheMs: 0, onChange: (prev, next) => {
  if (!prev?.walled || next?.walled) return
  clears.push(next)
  L.usageWallChanged(next ? { walled: next.walled, clearedMs: next.clearedMs, by: next.cleared_by } : null)
} })

// ---- the status record as server.ts composes it: the program's view (its wall from the reader), Jev's verdict on the screen, the cleared limit's text
const R = '─'.repeat(80)
const SCREEN = ['', '  ⎿  Skills restored (ego-browser, collab-board)', `  ⎿  ${LIMIT}`, '     /upgrade or /usage-credits to finish what you’re working on.', '',
  R, '❯ ', R, '  Fable 5.2', '  ⏵⏵ bypass permissions on', ''].join('\n')
const JEV: ScreenVerdict = { state: 'usage_limit', menu: 'none', p: 0.96, by: 'jev' }      // nestor 07:12:06–07:25:30Z: usage_limit, p 0.85–0.96
let records = 0
function record(): StatusView {
  records++
  const w = reader.state()
  const prog: StatusView = { state: 'idle', detail: { queued_joey: 0, ...(w?.walled ? { walled: { until: w.resets_at, kind: w.kind } } : {}) }, last_activity_at: new Date().toISOString() }
  return publishView(JEV, regions(SCREEN), prog, { cleared_limit_text: clearedLimitTextOf(w) })
}
// server.ts usageWall (M1's WO-120 probe): walled, or a clear since about when the gen's wall began
const usageWall = (sinceMs: number) => {
  const w = reader.state()
  if (!w) return null
  if (w.walled) return { walled: true, clearedMs: null }
  return w.clearedMs != null && w.clearedMs >= sinceMs - 60_000 ? { walled: false, clearedMs: w.clearedMs, by: w.cleared_by } : null
}
const mesh: any[] = []
L.__setMeshSend(async b => { mesh.push(b); return { text: 'sent', msgId: undefined, delivered: true } })
L.lanesInit({ role: 'tg', agent: AGENT, workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false,
  registryNames: () => ['chiron'], sendBot: async () => 700, joeyChatId: () => '1', mainStatus: record, usageWall,
  notifySession: async () => true, streamOpen: () => true } as any)
L.__setMainConnected('mcp-main')
const lines: CallStateLine[] = []
const calls = new CallFacts({ sink: l => lines.push(l) })
const tap = new LanesTap({ facts: new DeliveryFacts({ agent: AGENT, sink: () => {} }), joey: () => null, gen: () => L.mainGenRow(), changed: () => {}, calls, callOf: id => L.callOfEvent(id) })
L.observeLanes({ journal: (r, l) => tap.journal(r, l), mainEvent: b => tap.mainEvent(b), calls })
afterAll(() => { L.__setClaudeBin(restoreBin); L.__setMeshSend(null); inboxSrv.stop(true)
  for (const k of ['LANES_WAKE_DECIDE', 'LANES_FLOOD_CONTROL', 'LANES_RECEIPT_STEPS', 'LANES_INBOX_PORT']) delete process.env[k] })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const pid = process.pid
let p = 0, run = 7231
const of = (ev: string) => lines.filter(l => l.event === ev).map(l => `${l.body.state}:${l.body.session_id ?? '-'}`)
const itemOf = (ev: string) => L.__main().items((r: any) => r.event === ev).at(-1)!
const jsonl = (f: string): any[] => { try { return readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
function scheduled(callId: string): any {
  const r = String(++run), text = `[scheduled][desk-watch][run:${r}][P2][ops-check][high-frequency] 交易台巡視。`
  const meta = { user: 'scheduler', run_id: r, btcc_msg_id: String(12490 + run - 7231) }
  return { id: `mesh-${meta.btcc_msg_id}`, source: 'mesh', from: 'scheduler', verified: true, text, item_kind: 'scheduled', call_id: callId, btcc_msg_id: meta.btcc_msg_id,
    meta, refs: { run_id: r, schedule: '64' }, notif: { method: 'notifications/claude/channel', params: { content: text, meta } } }
}
/** what nothing but the clear may release: the 5 s tick and the record's 2 s publish are not run here between the checks */
async function stillHeld(ev: any): Promise<void> {
  for (let i = 0; i < 3; i++) { reader.state(); await L.__main().tick(); await L.__main().pump(); await sleep(30) }
  expect(itemOf(ev.id).state).toBe('queued')
}

test('Call 401\'s path: held while the wall is up; at the clear (probe_after_switch) offered in that step, the limit message still on the screen; its Call goes on to running and completed', async () => {
  episode++
  writeWall({})
  expect(reader.state()?.walled).toBe(true)
  expect(record()).toMatchObject({ state: 'walled' })
  const ev = scheduled('401')
  const d = await L.routeEvent(ev)
  expect(d.target).toBe('main')
  expect(jsonl('routing.jsonl').filter(r => r.event === ev.id).at(-1)).toMatchObject({ wake_target: 'held:wall' })
  expect(itemOf(ev.id).state).toBe('queued')
  expect(of(ev.id)).toEqual(['accepted:main'])                                             // given to the main's queue at the routing (Chiron 02:58Z: ack is running)
  await stillHeld(ev)                                                                       // not before the clear
  // the account switch: usage_wall.py's probe got a model call through; the transcript's limit message is still the latest output on the screen
  const n0 = records
  writeWall({ in_wall: false, cleared_at: new Date().toISOString(), cleared_by: 'probe_after_switch' })
  reader.state()                                                                            // the daemon's next read of the state (its onWallChange)
  expect(clears.length).toBe(1)
  await sleep(20)
  expect(itemOf(ev.id).state).toBe('offered')                                               // in the clear's step: no tick, no publish of the record between
  expect(records).toBeGreaterThan(n0)
  expect(record()).toMatchObject({ state: 'idle', detail: { cleared_limit_on_screen: true } })
  await L.__mainEvent({ event: 'UserPromptSubmit', pid, prompt_id: `p175w-${++p}`, dids: [itemOf(ev.id).id] })
  expect(of(ev.id)).toEqual(['accepted:main', 'running:main'])
  await L.__mainEvent({ event: 'Stop', pid, prompt_id: `p175w-${p}` }); await L.__mainEvent({ event: 'Stop', pid, prompt_id: `p175w-${p}`, phase: 'final' })
  calls.statusRecord('idle')
  expect(of(ev.id)).toEqual(['accepted:main', 'running:main', 'completed:main'])
})

test('a main the wall walled (its StopFailure): held while the state says walled; the clear sends its one offer in that step (WO-120), not at its retry or the next tick', async () => {
  episode++
  writeWall({})
  reader.state()
  // the main's turn hits the limit: M2 walls the gen (its own record of the wall), its retry far away
  const pre = `p175w-${++p}`
  await L.__mainEvent({ event: 'UserPromptSubmit', pid, prompt_id: pre, dids: [] })
  await L.__mainEvent({ event: 'StopFailure', pid, prompt_id: pre, error: 'rate_limit', reason: '429' })
  expect(L.__main().mainPhase()).toBe('walled')
  const ev = scheduled('402')
  expect((await L.routeEvent(ev)).target).toBe('main')
  await stillHeld(ev)
  writeWall({ in_wall: false, cleared_at: new Date().toISOString(), cleared_by: 'probe_after_switch' })
  reader.state()
  expect(clears.length).toBe(2)
  await sleep(20)
  expect(itemOf(ev.id).state).toBe('offered')
  await L.__mainEvent({ event: 'UserPromptSubmit', pid, prompt_id: `p175w-${++p}`, dids: [itemOf(ev.id).id] })
  expect(of(ev.id)).toEqual(['accepted:main', 'running:main'])
  expect(L.__main().mainPhase()).toBe('in_turn')
  await L.__mainEvent({ event: 'Stop', pid, prompt_id: `p175w-${p}`, phase: 'final' })
})
