// 002w (D): every inbound message has its record from ONE builder (recordInbound + eventObligations + the M1 item: toMain), whatever its route: the
// Telegram router failing, the mesh router failing in the tg daemon, and an event the router gives the main keeps its own class (a scheduler's event is
// `scheduled` and owes its receipt). A receipt handed to the main is met when the main completes the run (its ./bin/btcc-receipt call, seen at
// PostToolUse). The tg daemon's /lanes/ routes run behind a real HTTP server; a stand-in main process. Each test names the path and the gap.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
process.env.LANES_FLOOD_CONTROL = '0'
let L: typeof import('./lanes.ts')
const srv = createServer((req, res) => { void L.handleLanesHttp(new URL(req.url ?? '/', 'http://127.0.0.1'), req, res).catch(() => { try { res.writeHead(500); res.end() } catch {} }) })
await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
L = await import('./lanes.ts?w-d-test') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-w-d-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
const open = new Set<string>()
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => true, registryNames: () => ['eve'],
  notifySession: async (sid: string) => open.has(sid), streamOpen: (sid: string) => open.has(sid), toolsChanged: () => {}, sendBot: async () => 1, joeyChatId: () => '1' } as any)
const procs: any[] = []
afterAll(() => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } srv.close(); delete process.env.LANES_FLOOD_CONTROL })
const M = () => L.__main(), E = () => L.__events()
const p = Bun.spawn(['sleep', '600']); procs.push(p)
const sid = randomUUID(); writeFileSync(join(dir, 'main-expected'), sid); open.add(`mcp-${p.pid}`); L.__noteMcpPid(`mcp-${p.pid}`, p.pid)
await L.__mainEvent({ event: 'SessionStart', pid: p.pid, session_id: sid, source: 'startup' })
const hook = (event: string, o: object = {}) => L.__mainEvent({ event, pid: p.pid, session_id: sid, ...o } as any)
const ob = (ev: string, kind: string) => (E().get(ev)?.obligations ?? []).find((o: any) => o.kind === kind)
let np = 0
async function turnWith(ev: string): Promise<string> {
  for (let i = 0; i < 50 && M().items(r => r.event === ev && r.state === 'queued' && r.via === 'tg').length; i++) await new Promise(r => setTimeout(r, 10))   // a tg offer is written first
  const pr = `pd-${++np}`
  await hook('UserPromptSubmit', { prompt_id: pr, dids: M().items(r => r.state !== 'done' && r.event === ev).map(r => r.id) })
  return pr
}
/** the first Stop check that pulls nothing (an item an earlier test left queued is pulled into the turn first: M1's own block) */
async function stopCheck(pr: string): Promise<any> { for (let i = 0; i < 10; i++) { const r = await hook('Stop', { prompt_id: pr }); if (!String(r.block ?? '').startsWith('這一輪先不要結束。')) return r } }
async function end(pr: string) { let s = await hook('Stop', { prompt_id: pr }); if (s.block) s = await hook('Stop', { prompt_id: pr }); await hook('Stop', { prompt_id: pr, phase: 'final' }) }

test('002w D, gap 10, path the Telegram router failing (toMainDirect): the event gets the one builder\'s record: Joey\'s line handed to the main, its item owed; the main\'s reply meets it (2a936a7: a direct-… record with a main obligation only)', async () => {
  const meta = { chat_id: '1', message_id: '9101', user: 'joey_lab' }
  L.toMainDirect({ id: 'tg-1-9101', source: 'telegram', from: 'joey', text: '路由器壞掉時的訊息', meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: '路由器壞掉時的訊息', meta } } } as any)
  const e = E().get('tg-1-9101')!
  expect(e).toMatchObject({ owner: 'main', class: 'joey' })
  expect(ob('tg-1-9101', 'joey')).toMatchObject({ state: 'handed' })
  expect(M().items(r => r.event === 'tg-1-9101').length).toBe(1)
  const pr = await turnWith('tg-1-9101')
  expect((await stopCheck(pr)).block).toContain('路由器壞掉時的訊息')                                  // the owed hold asks about it
  L.mainReplied(L.mainReplyTier({}), 9102)
  expect(ob('tg-1-9101', 'joey')).toMatchObject({ state: 'met', ref: '9102' })
  await end(pr)
  expect(E().get('tg-1-9101')!.state).toBe('closed')
})

test('a peer event cannot enter the lane router through the previous daemon hand-over', async () => {
  const r = await fetch('http://127.0.0.1:' + (srv.address() as AddressInfo).port + '/lanes/route', {
    method: 'POST', headers: { authorization: 'Bearer test' }, body: JSON.stringify({ id: 'mesh-9201', from: 'eve', source: 'mesh' }),
  })
  expect(r.status).toBe(404)
  expect(M().items(r => r.event === 'mesh-9201')).toHaveLength(0)
})

test('002w D, gap 17, path an event the router gives the main (master switch off, toMain): a scheduler\'s event keeps class scheduled and owes its receipt (2a936a7: class peer, no receipt)', async () => {
  await L.lanesCommand('/lanes off', 'joey')
  await L.routeEvent({ id: 'mesh-9301', source: 'mesh', from: 'scheduler', verified: true, text: '[scheduled][backup-check][run:9301][P3][routine] 檢查備份', btcc_msg_id: '9301',
    meta: { run_id: '9301' }, notif: { method: 'notifications/claude/channel', params: { content: '檢查備份', meta: { run_id: '9301' } } } } as any)
  await L.lanesCommand('/lanes on', 'joey')
  expect(E().get('mesh-9301')).toMatchObject({ owner: 'main', class: 'scheduled' })
  expect(ob('mesh-9301', 'receipt')).toMatchObject({ state: 'handed', run_id: '9301' })
})

test('002w D, gap 17, path the main\'s ./bin/btcc-receipt complete N (PostToolUse): the receipt handed to the main is met and the event closes; until then the turn is asked about it and the event stays open (2a936a7: never met)', async () => {
  const pr = await turnWith('mesh-9301')
  L.mainReplied(L.mainReplyTier({}), 9302)                                                            // Joey got his line
  expect(E().get('mesh-9301')!.state).toBe('open')                                                    // the receipt is still owed
  expect((await stopCheck(pr)).block).toContain('排程 run 9301 的回執')
  const RC = { prompt_id: pr, tool_name: 'Bash', tool_input: { command: 'cd /w && ./bin/btcc-receipt complete 9301 --outcome done' } }
  expect((await hook('PreToolUse', RC)).deny).toBeUndefined()                                        // 002w (T3-R): the main holds this receipt: its completion goes through
  await hook('PostToolUse', { prompt_id: pr, tool_name: 'Bash', tool_input: { command: 'cd /w && ./bin/btcc-receipt complete 9301 --outcome done' }, tool_response: 'completed run 9301', tool_error: false })
  await new Promise(r => setTimeout(r, 20))
  expect(ob('mesh-9301', 'receipt')).toMatchObject({ state: 'met', by: 'main (btcc-receipt)' })
  await hook('PostToolUse', { prompt_id: pr, tool_name: 'Bash', tool_input: { command: './bin/btcc-receipt ack 9301' }, tool_response: 'ok', tool_error: false })   // an ack is not a completion
  expect((await hook('PreToolUse', RC)).deny).toContain('已經回執過了')                               // 002w (T3-R): a second completion of the run is refused before it runs
  expect((await hook('PreToolUse', { prompt_id: pr, tool_name: 'Bash', tool_input: { command: './bin/btcc-receipt complete 424242 --outcome done' } })).deny).toBeUndefined()   // a run no event carries: not ours
  expect((await hook('PreToolUse', { prompt_id: pr, tool_name: 'Bash', tool_input: { command: 'ls' } })).deny).toBeUndefined()
  await end(pr)
  expect(E().get('mesh-9301')!.state).toBe('closed')                                                 // the turn's item done, the line and the receipt met
})

// 002v r3 T3-R (u002v-T3-a-r3-20261120-081010): hourly-backup-check run 62 went to a reflex lane, which completed it through the daemon; 9 s later the main
// completed run 62 again with the CLI, and the scheduler got two receipts. A run a lane holds is the lane's to complete; one a lane met is done.
test('002w D, path the main\'s ./bin/btcc-receipt for a run a LANE holds or has met (PreToolUse): refused before it runs (2a936a7: the CLI ran, a second receipt reached the scheduler)', async () => {
  E().open('mesh-9401', { class: 'scheduled', owner: 'adam.reflex.9', from: 'scheduler', text: '[scheduled][run:9401] 每小時備份檢查', obligations: [{ kind: 'receipt', level: 'run', run_id: '9401' }] })
  const pr = `pd-${++np}`; await hook('UserPromptSubmit', { prompt_id: pr })
  const call = { prompt_id: pr, tool_name: 'Bash', tool_input: { command: './bin/btcc-receipt complete 9401 --outcome done --note x' } }
  expect((await hook('PreToolUse', call)).deny).toContain('adam.reflex.9 在處理')                    // the lane still holds it
  const v = E().request('mesh-9401', 'receipt', { kind: 'receipt', level: 'run', run_id: '9401' }); E().result('mesh-9401', v.ob?.id, true, { ref: 'completed' })   // the lane's receipt
  expect((await hook('PreToolUse', call)).deny).toContain('已經回執過了')
  await end(pr)
})

