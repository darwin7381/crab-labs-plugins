// WO-145, lanes on: a page answer (Onsen form) goes to the main as Joey's Telegram message would (lanes.ts toMainForm: the one builder, an M1 item of kind
// joey, its Joey line handed to the main), never to a lane, whatever the router's rules would say; route row rule web-form. Through the Onsen tap it gets
// the same facts as his message (seen by main at M1 bound, turn_end at the Stop), keyed form-<id>; the ✍ hook is told and leaves it (no Telegram message).
// A real lanes instance in a temp dir; no model, no network.
import { test, expect, afterAll } from 'bun:test'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { DeliveryFacts, LanesTap, type JoeyOf } from './onsen-status.ts'
import type { DeliveryFact } from './onsen-client.ts'
import { SeenReactor } from './onsen-visible.ts'

const L = await import('./lanes.ts?onsen-visible') as typeof import('./lanes.ts')
const JOEY = '1828'
const dir = mkdtempSync(join(tmpdir(), 'lanes-onsen-vis-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
const open = new Set<string>(), offers: any[] = []
const deps: any = { role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  notifySession: async (sid: string, n: any) => { if (!open.has(sid)) return false; offers.push(n); return true }, streamOpen: (sid: string) => open.has(sid),
  sendBot: async () => 100, joeyChatId: () => JOEY }
L.lanesInit(deps)
const facts: DeliveryFact[] = []
const reacted: string[] = []
const R = new SeenReactor({ log: () => {}, react: async (c, id) => { reacted.push(`${c}:${id}`) } })
const F = new DeliveryFacts({ agent: 'adam', sink: f => facts.push(f), settleMs: 40, onSeen: (c, id, by) => R.seen(c, id, by) })
// server.ts onsenJoeyOf: a page answer (via web-form, form-<n>) is Joey's message too
const joeyOf: JoeyOf = m => m && m.user_id === JOEY && m.chat_id && (/^\d+$/.test(String(m.message_id ?? '')) || ((m.via === 'web-form' || m.via === 'onsen') && /^form-\d+$/.test(String(m.message_id))))
  ? { chat: String(m.chat_id), id: String(m.message_id) } : null
const tap = new LanesTap({ facts: F, joey: joeyOf, gen: () => L.mainGenRow(), changed: () => {} })
L.observeLanes({ journal: (r, l) => tap.journal(r, l), mainEvent: b => tap.mainEvent(b) })
const procs: any[] = []
afterAll(() => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } })
const M = () => L.__main()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

test('a page answer: to the main (rule web-form, M1 item kind joey), seen by main at bound, turn_end after the Stop; no ✍ (form-<n> is no Telegram message)', async () => {
  const proc = Bun.spawn(['sleep', '600']); procs.push(proc)
  const sid = randomUUID()
  writeFileSync(join(dir, 'main-expected'), sid)
  open.add(`mcp-${proc.pid}`); L.__noteMcpPid(`mcp-${proc.pid}`, proc.pid)
  expect((await L.__mainEvent({ event: 'SessionStart', pid: proc.pid, session_id: sid, source: 'startup' })).accepted).toBe(true)
  await M().pump()
  const meta = { chat_id: JOEY, message_id: 'form-77', user: JOEY, user_id: JOEY, ts: new Date().toISOString(), via: 'web-form', form_title: '選方案', form_id: '1077',
    // a quote of a lane's message would send Joey's Telegram message to that lane: a page answer is not routed at all
    reply_to_message_id: '4242' }
  const notif = { method: 'notifications/claude/channel', params: { content: 'choice: B', meta } }
  const d = L.toMainForm({ id: `tg-${JOEY}-form-77`, source: 'telegram', from: JOEY, text: 'choice: B', meta, notif, verified: true } as any)
  expect(d).toMatchObject({ rule: 'web-form', target: 'main' })
  const route = readFileSync(join(dir, 'routing.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.event === `tg-${JOEY}-form-77`)
  expect(route).toEqual([expect.objectContaining({ rule: 'web-form', target: 'main', lane: null, tg_message_id: 'form-77' })])
  await M().pump(); await sleep(30)                                                // the offer is awaited in the pump enqueue started
  const it = M().items(r => r.event === `tg-${JOEY}-form-77`)[0]
  expect(it).toMatchObject({ kind: 'joey', state: 'offered' })
  expect(offers.at(-1).params.meta).toMatchObject({ via: 'web-form', message_id: 'form-77', form_title: '選方案' })
  expect(L.mainQueuedJoey()).toBe(1)
  await L.__mainEvent({ event: 'UserPromptSubmit', pid: proc.pid, session_id: sid, prompt_id: 'p1', dids: [it.id] })
  expect(facts.map(f => `${f.client_msg_id}:${f.state}:${f.by}`)).toEqual(['form-77:seen:main'])
  await L.__mainEvent({ event: 'Stop', pid: proc.pid, session_id: sid, prompt_id: 'p1', phase: 'final' })
  await sleep(120)
  expect(facts.map(f => `${f.client_msg_id}:${f.state}:${f.by}`)).toEqual(['form-77:seen:main', 'form-77:turn_end:main'])
  expect(reacted).toEqual([])
})

test('WO-159: a message Joey wrote in Onsen (via onsen): to the main (rule onsen), M1 item kind joey, seen by main; only via differs from his message', async () => {
  const proc = Bun.spawn(['sleep', '600']); procs.push(proc)
  const sid = randomUUID()
  writeFileSync(join(dir, 'main-expected'), sid)
  open.add(`mcp-${proc.pid}`); L.__noteMcpPid(`mcp-${proc.pid}`, proc.pid)
  expect((await L.__mainEvent({ event: 'SessionStart', pid: proc.pid, session_id: sid, source: 'startup' })).accepted).toBe(true)
  await M().pump()
  const meta = { chat_id: JOEY, message_id: 'form-88', user: JOEY, user_id: JOEY, ts: new Date().toISOString(), via: 'onsen' }
  const notif = { method: 'notifications/claude/channel', params: { content: '今天先把 Onsen 的輸入框上線', meta } }
  const d = L.toMainForm({ id: `tg-${JOEY}-form-88`, source: 'telegram', from: JOEY, text: '今天先把 Onsen 的輸入框上線', meta, notif, verified: true } as any)
  expect(d).toMatchObject({ rule: 'onsen', target: 'main' })
  const route = readFileSync(join(dir, 'routing.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.event === `tg-${JOEY}-form-88`)
  expect(route).toEqual([expect.objectContaining({ source: 'telegram', from: JOEY, rule: 'onsen', target: 'main', lane: null, tg_message_id: 'form-88' })])
  await M().pump(); await sleep(30)
  const it = M().items(r => r.event === `tg-${JOEY}-form-88`)[0]
  expect(it).toMatchObject({ kind: 'joey', state: 'offered' })
  const m = offers.at(-1).params
  expect(m.content).toBe('今天先把 Onsen 的輸入框上線')
  expect(m.meta).toMatchObject(meta)
  expect(m.meta.form_title).toBeUndefined()
  await L.__mainEvent({ event: 'UserPromptSubmit', pid: proc.pid, session_id: sid, prompt_id: 'p9', dids: [it.id] })
  expect(facts.map(f => `${f.client_msg_id}:${f.state}:${f.by}`)).toContain('form-88:seen:main')
  await L.__mainEvent({ event: 'Stop', pid: proc.pid, session_id: sid, prompt_id: 'p9', phase: 'final' })
  await sleep(120)
})

test('Joey\'s Telegram message: ✍ at the moment M1 binds it to the main\'s turn (not when it is only offered)', async () => {
  const g = L.mainGenRow()!
  const meta = { chat_id: JOEY, message_id: '301', user: 'joey_lab', user_id: JOEY }
  await L.routeEvent({ id: `tg-${JOEY}-301`, source: 'telegram', from: 'joey', text: '看一下', meta, verified: true,
    notif: { method: 'notifications/claude/channel', params: { content: '看一下', meta } } } as any)
  await M().pump(); await sleep(30)
  const it = M().items(r => r.event === `tg-${JOEY}-301`)[0]
  expect(it.state).toBe('offered')
  await sleep(10)
  expect(reacted).toEqual([])                                                        // offered is not taken in
  await L.__mainEvent({ event: 'UserPromptSubmit', pid: Number(g.pid), session_id: String(g.session_id), prompt_id: 'p2', dids: [it.id] })
  await sleep(10)
  expect(reacted).toEqual([`${JOEY}:301`])
  expect(facts.filter(f => f.client_msg_id === '301').map(f => `${f.state}:${f.by}`)).toEqual(['seen:main'])
})

test('not the Telegram daemon\'s lanes: null (server.ts then delivers it as with lanes off)', async () => {
  const L2 = await import('./lanes.ts?onsen-visible-2') as typeof import('./lanes.ts')
  expect(L2.toMainForm({ id: 'x', source: 'telegram', from: JOEY, text: 'x', meta: {}, notif: { method: 'm', params: {} }, verified: true } as any)).toBe(null)
})
