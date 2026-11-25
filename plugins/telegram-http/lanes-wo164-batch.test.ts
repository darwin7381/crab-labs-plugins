// WO-164 phase 1, Chiron's acceptance 2: a mail on a thread the main owns. The wake row's target is the main, batched (main_after_step:batch): it is queued for
// the main, rides the next delivery and never wakes the main alone; after LANES_DEFER_MAX_WAIT_S it leads one delivery itself (one wake for the batch).
// The router in this process (lanes.ts, role tg), LANES_WAKE_DECIDE on, a live main (this process), a stand-in agent-inbox daemon that takes the offers.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const AGENT = 'wo164b'
process.env.LANES_WAKE_DECIDE = `someone-else,${AGENT}`
const inboxSrv = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const u = new URL(req.url)
  if (u.pathname === '/lanes/offer') return Response.json({ offered: true })
  return Response.json({ ok: true, text: 'ok' })
} })
process.env.LANES_INBOX_PORT = String(inboxSrv.port)
const L = await import('./lanes.ts?wo164-batch') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-wo164b-'))
process.env.LANES_DIR = dir
writeFileSync(join(dir, 'router.json'), readFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), 'utf8'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const member = 'idle'
L.lanesInit({ role: 'tg', agent: AGENT, workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, notifySession: async () => true, streamOpen: () => true,
  registryNames: () => ['chiron', 'eve'], sendBot: async () => 1, joeyChatId: () => '1828', mainStatus: () => ({ state: member, detail: {} }) } as any)
L.__setMainConnected('mcp-main')
afterAll(() => { inboxSrv.stop(true); delete process.env.LANES_INBOX_PORT; delete process.env.LANES_WAKE_DECIDE })
const routing = (): any[] => { try { return readFileSync(join(dir, 'routing.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const rowOf = (id: string) => routing().filter(r => r.event === id).at(-1)
const items = (id: string) => L.__main().items((r: any) => r.event === id)
const until = async (f: () => boolean, ms = 3000): Promise<boolean> => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await new Promise(r => setTimeout(r, 25)) } return f() }
const waiting = () => L.__main().items((x: any) => (x.state === 'queued' && x.reason !== 'batched') || x.state === 'offered')
let n = 0
function mesh(from: string, text: string, o: Record<string, unknown> = {}): any {
  n += 1
  return { id: `mesh-wo164b-${n}`, source: 'mesh', from, text, verified: true, meta: { user: from }, notif: { method: 'notifications/claude/channel', params: { content: text, meta: { user: from } } },
    line: 'call', btcc_msg_id: String(81000 + n), ...o }
}
const pid = process.pid
let turns = 0
/** the main takes what it was offered in a turn and ends it (its final Stop) */
const takeTurn = async () => { const p = `p-b-${++turns}`; await L.__mainEvent({ event: 'UserPromptSubmit', pid, prompt_id: p }); await L.__mainEvent({ event: 'Stop', pid, prompt_id: p, phase: 'final' }) }

test('acceptance 2: a mail on a thread the main owns — the wake row\'s target is the main, batched; it does not wake the main alone, it rides the next delivery', async () => {
  await L.__mainEvent({ event: 'Stop', pid })
  // the main mailed eve (the agent-inbox daemon tells the tg daemon: /lanes/outbound, line mail): the conversation mail:200500 is the main's
  L.__mainMailThread('200500')
  const t0 = L.__threadByKey('mail', '200500')
  expect(t0).toMatchObject({ lane: 'main', key_kind: 'mail' })
  const r = mesh('eve', '【信】Re: 報表\n可以，週五前', { item_kind: 'peer_mail', line: 'mail', refs: { conversation: '200500' }, btcc_msg_id: '200501' })
  const d = await L.routeEvent(r)
  expect(d).toMatchObject({ target: 'main', rule: 'wake:owner-mail-main', batch: true })
  expect(rowOf(r.id)).toMatchObject({ decided_by: 'new', target: 'main', wake_target: 'main_after_step:batch', thread: t0!.id })
  const it = items(r.id)
  expect(it.length).toBe(1)
  expect(it[0]).toMatchObject({ state: 'queued', reason: 'batched' })                      // not offered: the main is idle and not woken for it
  await L.__main().pump()
  expect(items(r.id)[0].state).toBe('queued')
  // a reply quoting the main's mail (no conversation field: the structured link) is on the same thread
  const r2 = mesh('eve', '【信】Re: 報表\n附檔', { item_kind: 'peer_mail', line: 'mail', reply_to_id: '200500', btcc_msg_id: '200502' })
  expect(await L.routeEvent(r2)).toMatchObject({ target: 'main', batch: true })
  expect(rowOf(r2.id).thread).toBe(t0!.id)
  expect(items(r2.id)[0]).toMatchObject({ state: 'queued', reason: 'batched' })
  expect(waiting().length).toBe(0)                                                          // nothing else waits: no offer was made for the two alone
  // the next delivery (Joey's message) carries both
  const j = { id: 'tg-1828-9001', source: 'telegram', from: 'joey', text: 'Joey：在嗎', meta: { chat_id: '1828', message_id: '9001', user: 'joey' }, notif: { method: 'notifications/claude/channel', params: { content: 'Joey：在嗎', meta: { chat_id: '1828', message_id: '9001' } } } } as any
  await L.routeEvent(j)
  expect(await until(() => items(j.id)[0]?.state === 'offered', 3000)).toBe(true)
  expect(items(r.id)[0].state).toBe('offered')
  expect(items(r2.id)[0].state).toBe('offered')
  const wakes = readFileSync(join(dir, 'lanes', 'state.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(x => x.rec === 'wake' && x.id === items(r.id)[0].id)
  expect(wakes.map(x => x.state)).toEqual(['no_wake', 'wake'])                            // queued without a wake; then riding Joey's offer
  expect(String(wakes[0].reason)).toContain('batched: rides the next delivery to the main and never wakes it alone')
  expect(String(wakes[1].reason)).toContain(`batched: rides the offer of ${items(j.id)[0].id}`)
  // Joey's message is on his chat's thread, the main's
  expect(L.__threadByKey('tg', 'tg:1828')).toMatchObject({ lane: 'main' })
  await takeTurn()
})
test('acceptance 2: batched items lead one delivery once they have waited LANES_DEFER_MAX_WAIT_S (one wake for the batch)', async () => {
  expect(waiting().length).toBe(0)
  process.env.LANES_DEFER_MAX_WAIT_S = '1'
  try {
    const t0 = L.__threadByKey('mail', '200500')!
    const r = mesh('eve', '【信】Re: 報表\n再補一句', { item_kind: 'peer_mail', line: 'mail', refs: { conversation: '200500' }, btcc_msg_id: '200503' })
    expect(await L.routeEvent(r)).toMatchObject({ target: 'main', batch: true })
    expect(items(r.id)[0].state).toBe('queued')
    expect(waiting().length).toBe(0)
    await new Promise(res => setTimeout(res, 1100))
    await L.__main().pump()
    expect(await until(() => items(r.id)[0].state === 'offered', 2000)).toBe(true)
    expect(rowOf(r.id).thread).toBe(t0.id)
  } finally { delete process.env.LANES_DEFER_MAX_WAIT_S; await takeTurn() }
})
