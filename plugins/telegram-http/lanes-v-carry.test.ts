// 002v (002s round 2): two duties the model was left to remember, now the daemon's. G02 (u002s-G02-s2-r2-20261119-221622): a turn that takes in nothing
// (a background task's notification opened it) carries on the work of the last turn that took messages in; the Stop check hands that work to the
// last-words check as `context`. C04 (u002s-C04-s2-r2-20261119-215937): the turn that took in the last message of a conversation the thread gate stopped
// answers that peer with no_reply set by the router (PreToolUse mark_no_reply). A fake lane binary and a mesh stub; no model, no network.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?v-carry-test') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-v-carry-'))
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
L.__setMeshSend(async b => { meshOut.push(b); return { text: `sent to ${b.to}`, msgId: 61000 + meshOut.length, delivered: true } })
const open = new Set<string>()
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'],
  notifySession: async (sid: string) => open.has(sid), streamOpen: (sid: string) => open.has(sid), toolsChanged: () => {},
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
const procs: any[] = []
afterAll(() => { try { writeFileSync(GO, 'ok') } catch {}; for (const p of procs) { try { p.kill('SIGKILL') } catch {} } L.__setClaudeBin(restore); delete process.env.LANES_FLOOD_CONTROL })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const M = () => L.__main()
let n = 0, np = 0
const P = () => `pv-${++np}`
const mk = (from: string, text: string, extra: object = {}) => ({ id: `mesh-vc-${++n}`, source: 'mesh', from, verified: true, text, meta: {}, notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } }, ...extra } as any)
async function startMain() {
  const p = Bun.spawn(['sleep', '600']); procs.push(p)
  const sid = randomUUID(), mcp = `mcp-${p.pid}`
  writeFileSync(join(dir, 'main-expected'), sid); open.add(mcp); L.__noteMcpPid(mcp, p.pid)
  await L.__mainEvent({ event: 'SessionStart', pid: p.pid, session_id: sid, source: 'startup' }); await M().pump()
  return { pid: p.pid, sid }
}
const hook = (g: { pid: number; sid: string }, event: string, o: object = {}) => L.__mainEvent({ event, pid: g.pid, session_id: g.sid, ...o } as any)
async function stop(g: { pid: number; sid: string }, p: string) { let s = await hook(g, 'Stop', { prompt_id: p }); if (s.block) s = await hook(g, 'Stop', { prompt_id: p }); return s }
const REPLY = 'mcp__plugin_telegram-http_telegram-http__reply', SEND = 'mcp__plugin_agent-inbox_agent-inbox__send_to_agent'

test('002v G02: a turn that takes in nothing gets the work it carries on (the last turn with items, and every output since); a turn with items gets none', async () => {
  const g = await startMain()
  const meta = { chat_id: '1', message_id: '9001', user: 'joey_lab' }
  await L.routeEvent({ id: 'tg-1-9001', source: 'telegram', from: 'joey', text: '把日誌第 1 頁到第 20 頁抓完，給我 5xx 總數。', meta, verified: true,
    notif: { method: 'notifications/claude/channel', params: { content: '把日誌第 1 頁到第 20 頁抓完，給我 5xx 總數。', meta } } } as any)
  await M().pump()
  const item = M().items(r => r.event === 'tg-1-9001')[0].id
  const p1 = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p1, dids: [item] })
  await hook(g, 'PostToolUse', { prompt_id: p1, tool_name: REPLY, tool_input: { text: '收到，抓完回你總數。' } })
  await hook(g, 'PostToolUse', { prompt_id: p1, tool_name: 'Bash', tool_input: { command: 'loop pages', run_in_background: true } })
  const s1 = await stop(g, p1)
  expect(s1.items.map((x: any) => x.body)).toContain('把日誌第 1 頁到第 20 頁抓完，給我 5xx 總數。'); expect(s1.context).toBeUndefined()
  await hook(g, 'Stop', { prompt_id: p1, phase: 'final' })
  const p2 = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p2 })          // the background task's notification: nothing bound
  await hook(g, 'PostToolUse', { prompt_id: p2, tool_name: 'Bash', tool_input: { command: 'refetch 1-3' } })
  const s2 = await stop(g, p2)
  expect(s2.items).toEqual([])
  expect(s2.context.items.map((x: any) => x.body)).toEqual(['把日誌第 1 頁到第 20 頁抓完，給我 5xx 總數。'])
  expect(s2.context.outputs).toEqual([{ to: 'Joey', reply_to: '', text: '收到，抓完回你總數。' }])
  await hook(g, 'PostToolUse', { prompt_id: p2, tool_name: REPLY, tool_input: { text: '5xx 總數 194。' } })
  await hook(g, 'Stop', { prompt_id: p2, phase: 'final' })
  const p3 = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p3 })          // another such turn: the work now has both outputs
  const s3 = await stop(g, p3)
  expect(s3.context.outputs.map((o: any) => o.text)).toEqual(['收到，抓完回你總數。', '5xx 總數 194。'])
  await hook(g, 'Stop', { prompt_id: p3, phase: 'final' })
})

test('002v C04, 002w B (gap 8, path mark_no_reply of a turn that took in nothing): the turn that took in a stopped conversation\'s last message, or a turn that took in nothing and carries it on, answers that peer with no_reply set by the router; another peer, a later turn with items of its own, a send already no_reply: untouched', async () => {
  const g = M().currentGen()!; const gg = { pid: Number(g.pid), sid: String(g.session_id) }
  const d1 = await L.routeEvent(mk('eve', '週三 14:00 維護，確定嗎？'))
  const th = L.__lanesState().lanes[d1.lane!].thread
  L.__lanesState().threads[th].hops = 6
  const stopped = await L.routeEvent(mk('eve', '再確認一次（第 3 次）', { thread: th, hop: 7, reply_to_id: 'x' }))
  expect(stopped).toMatchObject({ rule: 'thread-gate', thread: th })
  const stopId = `mesh-vc-${n}`
  await until(() => M().items(r => r.event === stopId).length > 0)
  const ho = M().items(r => r.event === stopId)[0]
  expect(ho.content ?? JSON.stringify(ho.notif)).toContain('分流器會標成「不用回」')
  const p = P(); await hook(gg, 'UserPromptSubmit', { prompt_id: p, dids: [ho.id] })
  expect((await hook(gg, 'PreToolUse', { prompt_id: p, tool_name: SEND, tool_input: { to: 'eve', no_reply: null } })).mark_no_reply).toContain('eve')
  expect((await hook(gg, 'PreToolUse', { prompt_id: p, tool_name: SEND, tool_input: { to: 'Eve' } })).mark_no_reply).toBeTruthy()      // the name as the model wrote it
  expect((await hook(gg, 'PreToolUse', { prompt_id: p, tool_name: SEND, tool_input: { to: 'cain' } })).mark_no_reply).toBeUndefined()   // another peer
  expect((await hook(gg, 'PreToolUse', { prompt_id: p, tool_name: SEND, tool_input: { to: 'eve', no_reply: true } })).mark_no_reply).toBeUndefined()
  await stop(gg, p); await hook(gg, 'Stop', { prompt_id: p, phase: 'final' })
  // 002w (B, gap 8): a later turn that took in nothing carries on that work (turnWork): its answer to eve still ends the stopped conversation
  const p2 = P(); await hook(gg, 'UserPromptSubmit', { prompt_id: p2 })
  expect((await hook(gg, 'PreToolUse', { prompt_id: p2, tool_name: SEND, tool_input: { to: 'eve' } })).mark_no_reply).toContain('eve')
  await stop(gg, p2); await hook(gg, 'Stop', { prompt_id: p2, phase: 'final' })
  // a later turn with items of its own: a new conversation is the main's to open
  const meta = { chat_id: '1', message_id: '9002', user: 'joey_lab' }
  await L.routeEvent({ id: 'tg-1-9002', source: 'telegram', from: 'joey', text: '跟 eve 另開一件事。', meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: '跟 eve 另開一件事。', meta } } } as any)
  await until(() => M().items(r => r.event === 'tg-1-9002' && r.state === 'offered').length === 1)      // the offer is written before the prompt binds it
  const p3 = P(); await hook(gg, 'UserPromptSubmit', { prompt_id: p3, dids: M().items(r => r.event === 'tg-1-9002').map(r => r.id) })
  expect((await hook(gg, 'PreToolUse', { prompt_id: p3, tool_name: SEND, tool_input: { to: 'eve' } })).mark_no_reply).toBeUndefined()
  await stop(gg, p3); await hook(gg, 'Stop', { prompt_id: p3, phase: 'final' })
  writeFileSync(GO, 'ok'); await until(() => !L.__runTok(d1.lane!))
})
