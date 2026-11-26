// WO-181 (Chiron 06:19Z, the 45-minute ceiling for mentions): Onsen puts an inbox item of kind `mention` (only a post_id; one while one is not taken)
// when it makes a mention notification for an agent. The wake table's one rule `mention`: to the main, batched (the decision cards' window) — it never
// wakes the main alone, it rides the next delivery, and after LANES_DEFER_MAX_WAIT_S it leads one delivery for the batch. No timer of its own.
// The router in this process (lanes.ts, role tg), LANES_WAKE_DECIDE on, a live main (this process), a stand-in agent-inbox daemon that takes the offers.
// The item is a fake in the shape on the ticket (Epeius builds Onsen's side): { kind: 'mention', refs: { post_id } }, no text.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { decideWake, loadWakeTable } from './wake-decide.ts'
import { mentionItemText } from './onsen-mentions.ts'

const AGENT = 'wo181m'
process.env.LANES_WAKE_DECIDE = `someone-else,${AGENT}`
const inboxSrv = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const u = new URL(req.url)
  if (u.pathname === '/lanes/offer') return Response.json({ offered: true })
  return Response.json({ ok: true, text: 'ok' })
} })
process.env.LANES_INBOX_PORT = String(inboxSrv.port)
const L = await import('./lanes.ts?wo181-mention') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-wo181m-'))
process.env.LANES_DIR = dir
writeFileSync(join(dir, 'router.json'), readFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), 'utf8'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'b31fbc70-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
L.lanesInit({ role: 'tg', agent: AGENT, workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, notifySession: async () => true, streamOpen: () => true,
  registryNames: () => ['chiron', 'eve'], sendBot: async () => 1, joeyChatId: () => '1828', mainStatus: () => ({ state: 'idle', detail: {} }) } as any)
L.__setMainConnected('mcp-main')
afterAll(() => { inboxSrv.stop(true); delete process.env.LANES_INBOX_PORT; delete process.env.LANES_WAKE_DECIDE })
const routing = (): any[] => { try { return readFileSync(join(dir, 'routing.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const rowOf = (id: string) => routing().filter(r => r.event === id).at(-1)
const items = (id: string) => L.__main().items((r: any) => r.event === id)
const wakesOf = (itemId: string) => readFileSync(join(dir, 'lanes', 'state.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(x => x.rec === 'wake' && x.id === itemId)
const until = async (f: () => boolean, ms = 3000): Promise<boolean> => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await new Promise(r => setTimeout(r, 25)) } return f() }
const waiting = () => L.__main().items((x: any) => (x.state === 'queued' && x.reason !== 'batched') || x.state === 'offered')
let n = 0
/** Onsen's mention item as the agent-inbox daemon hands it on (deliverPulled: item_kind from the item's kind, its refs, the one line mentionItemText gives) */
function mentionItem(post: number): any {
  n += 1
  const text = mentionItemText({ refs: { post_id: post } })
  return { id: `mesh-wo181m-${n}`, source: 'mesh', from: 'onsen', text, verified: true, item_kind: 'mention', refs: { post_id: String(post) }, btcc_msg_id: String(91000 + n),
    meta: { user: 'onsen' }, notif: { method: 'notifications/claude/channel', params: { content: text, meta: { user: 'onsen' } } } }
}
const pid = process.pid
let turns = 0
const takeTurn = async () => { const p = `p-m-${++turns}`; await L.__mainEvent({ event: 'UserPromptSubmit', pid, prompt_id: p }); await L.__mainEvent({ event: 'Stop', pid, prompt_id: p, phase: 'final' }) }

test('the table: kind mention → the main, batched, in every state the main can take it; held as any main item otherwise; ordered by default', () => {
  const T = loadWakeTable()
  expect(T.urgency_default.mention).toBe('ordered')
  for (const member of ['idle', 'busy', 'compacting']) expect(decideWake({ kind: 'mention', sender: 'onsen' }, { member }, T)).toMatchObject({ target: 'main_after_step:batch', rule: 'mention' })
  expect(decideWake({ kind: 'mention', sender: 'onsen' }, { member: 'offline' }, T)).toMatchObject({ target: 'held:offline', then: 'main', rule: 'mention' })
  expect(decideWake({ kind: 'mention', sender: 'onsen', urgency: 'silent' }, { member: 'idle' }, T).rule).toBe('mention')   // not recorded only: it must reach the main
  expect(mentionItemText({ refs: { post_id: 300836 } })).toBe('〔點名你的動態〕有人在動態上點名你（貼文 300836）；那幾行在這一次附上的「點名你的動態」區塊，要看全文用 feed_open')
  expect(mentionItemText({ payload: {} })).toBe('〔點名你的動態〕有人在動態上點名你；那幾行在這一次附上的「點名你的動態」區塊，要看全文用 feed_open')
})

test('a mention item does not wake the main alone: queued batched, no wake of its own; it rides the next delivery (Joey\'s message)', async () => {
  await L.__mainEvent({ event: 'Stop', pid })
  const m = mentionItem(300836)
  const d = await L.routeEvent(m)
  expect(d).toMatchObject({ target: 'main', rule: 'wake:mention', batch: true })
  expect(rowOf(m.id)).toMatchObject({ decided_by: 'new', target: 'main', wake_target: 'main_after_step:batch' })
  expect(items(m.id)).toHaveLength(1)
  expect(items(m.id)[0]).toMatchObject({ state: 'queued', reason: 'batched' })
  await L.__main().pump()
  expect(items(m.id)[0].state).toBe('queued')
  expect(waiting().length).toBe(0)                                                          // nothing offered for it alone
  const j = { id: 'tg-1828-9101', source: 'telegram', from: 'joey', text: 'Joey：在嗎', meta: { chat_id: '1828', message_id: '9101', user: 'joey' },
    notif: { method: 'notifications/claude/channel', params: { content: 'Joey：在嗎', meta: { chat_id: '1828', message_id: '9101', user: 'joey' } } } } as any
  await L.routeEvent(j)
  expect(await until(() => items(j.id)[0]?.state === 'offered', 3000)).toBe(true)
  expect(items(m.id)[0].state).toBe('offered')
  const w = wakesOf(items(m.id)[0].id)
  expect(w.map(x => x.state)).toEqual(['no_wake', 'wake'])                                 // queued without a wake; then riding Joey's offer
  expect(String(w[1].reason)).toContain(`batched: rides the offer of ${items(j.id)[0].id}`)
  await takeTurn()
})

test('the ceiling: a mention item that has waited LANES_DEFER_MAX_WAIT_S leads one delivery (the batch\'s one wake), not before', async () => {
  expect(waiting().length).toBe(0)
  process.env.LANES_DEFER_MAX_WAIT_S = '1'
  try {
    const m = mentionItem(300901)
    expect(await L.routeEvent(m)).toMatchObject({ target: 'main', batch: true })
    await L.__main().pump()
    expect(items(m.id)[0].state).toBe('queued')
    await new Promise(res => setTimeout(res, 1100))
    await L.__main().pump()
    expect(await until(() => items(m.id)[0].state === 'offered', 2000)).toBe(true)
  } finally { delete process.env.LANES_DEFER_MAX_WAIT_S; await takeTurn() }
})

test('a mention item is a notice, not a call (Chiron WO-175 lab 08:42Z, lab msg 881): it owes nobody anything; the lanes\' own message (chat lanes, no_reply), not the sender\'s call', async () => {
  expect(waiting().length).toBe(0)
  const m = mentionItem(300958)
  m.notif.params.meta = { user: 'onsen', line: 'call', chat_id: 'onsen' }                     // as agent-inbox renders Onsen's item
  await L.routeEvent(m)
  const ev = L.__events().get(m.id)!
  expect((ev.obligations ?? []).map((o: any) => o.kind)).toEqual(['main'])                  // no Joey line, no answer
  const it = items(m.id)[0]
  expect(it.via).toBe('tg')
  expect((it.notif as any).params.meta).toMatchObject({ chat_id: 'lanes', user: 'lanes', via: 'lanes', kind: 'mention', no_reply: 'true' })
  expect((it.notif as any).params.meta.line).toBeUndefined()
  expect((it.notif as any).params.content).toBe(mentionItemText({ refs: { post_id: 300958 } }))
  // pulled into a turn it is told as the digest is (only for the main to know), not as a message to handle
  const p = `p-m-${++turns}`
  await L.__mainEvent({ event: 'UserPromptSubmit', pid, prompt_id: p })
  process.env.LANES_DEFER_MAX_WAIT_S = '1'
  try {
    await new Promise(res => setTimeout(res, 1100))
    const r = await L.__mainEvent({ event: 'PostToolUse', pid, prompt_id: p, tool_name: 'Bash', tool_input: {}, tool_response: '' }) as any
    const ctx = String(r?.additionalContext ?? '')
    expect(ctx).toContain('〔點名你的動態〕')
    expect(ctx).not.toContain('<channel')
  } finally { delete process.env.LANES_DEFER_MAX_WAIT_S; await L.__mainEvent({ event: 'Stop', pid, prompt_id: p, phase: 'final' }) }
})
