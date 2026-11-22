// 002w (B): what a turn of the main works on is ONE set (lanes-main turnWork): the items bound to the turn and their events, or, for a turn that took in
// nothing (a background task's notification opened it), the work the gen carries on. The Stop check's hold (now: a Joey line, a peer's answer, a receipt,
// the rule the lane stop applies), mark_no_reply, and what the main's reply and send_to_agent meet all read it. A handed peer answer is also met by a
// later send to that peer, and is due like a promised one. Each test names the path and the gap of DUTY-INVENTORY.md. No model, no network.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?w-b-test') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-w-b-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
const meshOut: any[] = []
L.__setMeshSend(async b => { meshOut.push(b); return { text: `sent to ${b.to}`, msgId: 62000 + meshOut.length, delivered: true } })
const open = new Set<string>(), sent: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'],
  notifySession: async (sid: string) => open.has(sid), streamOpen: (sid: string) => open.has(sid), toolsChanged: () => {},
  sendBot: async (_c: string, text: string) => { sent.push(text); return 4000 + sent.length }, joeyChatId: () => '1' } as any)
const procs: any[] = []
afterAll(() => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } delete process.env.LANES_FLOOD_CONTROL })
const M = () => L.__main(), E = () => L.__events()
let np = 0
const P = () => `pw-${++np}`
async function startMain() {
  const p = Bun.spawn(['sleep', '600']); procs.push(p)
  const sid = randomUUID(), mcp = `mcp-${p.pid}`
  writeFileSync(join(dir, 'main-expected'), sid); open.add(mcp); L.__noteMcpPid(mcp, p.pid)
  await L.__mainEvent({ event: 'SessionStart', pid: p.pid, session_id: sid, source: 'startup' }); await M().pump()
  return { pid: p.pid, sid }
}
const g = await startMain()
const hook = (event: string, o: object = {}) => L.__mainEvent({ event, pid: g.pid, session_id: g.sid, ...o } as any)
const ob = (ev: string, kind: string) => (E().get(ev)?.obligations ?? []).find((o: any) => o.kind === kind && (kind !== 'peer' || o.level === 'answer'))
async function joey(id: string, text: string) {
  const meta = { chat_id: '1', message_id: id, user: 'joey_lab' }
  await L.routeEvent({ id: `tg-1-${id}`, source: 'telegram', from: 'joey', text, meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: text, meta } } } as any)
  for (let i = 0; i < 50 && !M().items(r => r.event === `tg-1-${id}` && r.state === 'offered').length; i++) await new Promise(r => setTimeout(r, 10))   // the offer is written first
  return `tg-1-${id}`
}
async function eve(id: string, text: string) {         // the master switch is off: the router gives the peer's message to the main (toMain)
  await L.routeEvent({ id: `mesh-${id}`, source: 'mesh', from: 'eve', verified: true, text, btcc_msg_id: id, meta: { btcc_msg_id: id }, notif: { method: 'notifications/claude/channel', params: { content: text, meta: { btcc_msg_id: id } } } } as any)
  return `mesh-${id}`
}
/** a turn that takes in the items of these events; ended (its first Stop may be held once) */
async function turnWith(evs: string[]): Promise<string> {
  const p = P()
  await hook('UserPromptSubmit', { prompt_id: p, dids: M().items(r => r.state !== 'done' && evs.includes(String(r.event))).map(r => r.id) })
  return p
}
async function end(p: string) { let s = await hook('Stop', { prompt_id: p }); if (s.block) s = await hook('Stop', { prompt_id: p }); await hook('Stop', { prompt_id: p, phase: 'final' }); return s }

test('002w B, gap 8, path Stop hold of a turn that took in nothing: what the work it carries on still owes Joey holds it once (2a936a7: only the turn\'s own items were asked)', async () => {
  const ev = await joey('8101', '把第 1 到 20 頁抓完，給我 5xx 總數。')
  const p1 = await turnWith([ev])
  expect((await hook('Stop', { prompt_id: p1 })).block).toContain('Joey「把第 1 到 20 頁抓完，給我 5xx 總數。」')
  await end(p1)
  const p2 = P(); await hook('UserPromptSubmit', { prompt_id: p2 })                                  // a background task's notification: nothing bound
  const h = await hook('Stop', { prompt_id: p2 })
  expect(h.block).toContain('Joey「把第 1 到 20 頁抓完，給我 5xx 總數。」：回 Joey 一句')
  expect((await hook('Stop', { prompt_id: p2 })).block).toBeUndefined()                               // one hold per turn
  await hook('Stop', { prompt_id: p2, phase: 'final' })
})

test('002w B, gap 8, path reply in a turn that took in nothing (mainReplied / replyTargets): the reply meets the Joey line of the work it carries on (2a936a7: it met nothing)', async () => {
  const p3 = P(); await hook('UserPromptSubmit', { prompt_id: p3 })
  L.mainReplied(L.mainReplyTier({}), 8102)
  expect(ob('tg-1-8101', 'joey')).toMatchObject({ state: 'met', by: 'main', ref: '8102' })
  expect((await hook('Stop', { prompt_id: p3 })).block).toBeUndefined()
  await hook('Stop', { prompt_id: p3, phase: 'final' })
})

test('002w B, gap 9, path Stop hold: an answer to a peer handed to the main holds the turn once, naming it (2a936a7 asked Joey lines only)', async () => {
  await L.lanesCommand('/lanes off', 'joey')
  const ev = await eve('8201', '週三 14:00 維護窗口可以嗎？')
  expect(ob(ev, 'peer')).toMatchObject({ state: 'handed', to: 'eve', req: '8201' })
  const p = await turnWith([ev])
  L.mainReplied(L.mainReplyTier({}), 8202)                                                            // Joey got his line
  expect(ob(ev, 'joey').state).toBe('met')
  const h = await hook('Stop', { prompt_id: p })
  expect(h.block).toContain('eve「週三 14:00 維護窗口可以嗎？」：回 eve')
  await end(p)
})

test('002w B, gap 8, path send_to_agent in a turn that took in nothing (mainSentInTurn): a delivered send meets the peer answer of the work it carries on (2a936a7: it answered nothing)', async () => {
  const p = P(); await hook('UserPromptSubmit', { prompt_id: p })
  await L.mainSentTo('eve', null, null, '可以，週三 14:00。', '8203', true)
  expect(ob('mesh-8201', 'peer')).toMatchObject({ state: 'met', by: 'main', ref: '8203' })
  await end(p)
})

test('002w B, gap 9, path a send in a later turn (mainSentTo): an answer handed to the main is met by a send that quotes the peer\'s message (2a936a7 matched only answers the router had promised)', async () => {
  const ev = await eve('8301', 'd-90 報告能提前到週四嗎？')
  const p1 = await turnWith([ev]); await end(p1)
  const p2 = await turnWith([await joey('8302', '今天還有什麼？')])                                   // a turn of its own items: eve's event is not in it
  await L.mainSentTo('eve', null, '8301', '週四可以給。', '8303', true)
  expect(ob(ev, 'peer')).toMatchObject({ state: 'met', by: 'main (reply_to)', ref: '8303' })
  await end(p2)
})

test('002w B, gap 9, path due sweep: an answer handed to the main gets a due time; past it Joey is told once (2a936a7: no due time, the event stayed open for ever)', async () => {
  const ev = await eve('8401', '備份保留天數要改嗎？')
  const due = Number(ob(ev, 'peer').due_at)
  expect(due).toBeGreaterThan(Date.now())
  const k = sent.length
  L.dueTick(due + 1)
  await new Promise(r => setTimeout(r, 50))
  expect(sent.slice(k).filter(t => t.includes('eve 在等主線回覆：「備份保留天數要改嗎？」')).length).toBe(1)
  L.dueTick(due + 2)
  await new Promise(r => setTimeout(r, 50))
  expect(sent.slice(k).filter(t => t.includes('備份保留天數要改嗎？')).length).toBe(1)
  const p = await turnWith([ev]); await end(p)
  await L.lanesCommand('/lanes on', 'joey')
})

test('002w B, 24a, path SessionStart source clear: the work carried before /clear is dropped: a turn after it that took in nothing carries nothing (2a936a7 carried it)', async () => {
  const ev = await joey('8501', '查一下 mock-api')
  const p1 = await turnWith([ev]); await end(p1)
  const p0 = P(); await hook('UserPromptSubmit', { prompt_id: p0 })
  expect((await hook('Stop', { prompt_id: p0 })).block).toContain('查一下 mock-api')                 // before /clear: the work is carried
  await end(p0)
  await L.__mainEvent({ event: 'SessionEnd', pid: g.pid, session_id: g.sid, reason: 'clear' })
  await L.__mainEvent({ event: 'SessionStart', pid: g.pid, session_id: randomUUID(), source: 'clear' })
  const p2 = P(); await L.__mainEvent({ event: 'UserPromptSubmit', pid: g.pid, prompt_id: p2 })
  const s = await L.__mainEvent({ event: 'Stop', pid: g.pid, prompt_id: p2 })
  expect(s.block).toBeUndefined(); expect(s.context).toBeUndefined(); expect(s.items).toEqual([])
  await L.__mainEvent({ event: 'Stop', pid: g.pid, prompt_id: p2, phase: 'final' })
})
