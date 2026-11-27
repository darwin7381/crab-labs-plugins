// lanes-topics item 4: a work topic's life. open_worker returns the topic's link and the plain-text name actually stored (the server drops emoji from a
// name, measured 11-23, so they are dropped first and the stored name is the shown one). When the worker lane is closed (the main's lane_close, Joey's
// /lanes close, or, when a run was going, at that run's end) its topic gets the ✅ icon and one closing line; it is never deleted. A message typed later
// in the finished topic goes to the main, and the main's answer lands in that topic.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { plainTopicName, stripEmoji, topicLink } from './lanes-topics.ts'
import { startBotApiMock, dm, ICON_CHECK } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until as untilA } from './test-fixtures/tg-daemon.ts'
process.env.LANES_FLOOD_CONTROL = '0'
process.env.LANES_CLOSE_GRACE_MS = '30000'
process.env.LANES_TOPIC_SWEEP_MS = '50'
const L = await import('./lanes.ts?topics-lifecycle') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-topics-lifecycle-'))
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
let nextTopic = 7400
const created: string[] = [], sent: any[] = [], done: Array<{ chat: string; thread: number }> = []
const deps = { role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async (chat: string, text: string, o: any) => { sent.push({ chat, text, ...o }); return 9000 + sent.length }, joeyChatId: () => '1', botUsername: () => 'lab_test_bot',
  createTopic: async (_c: string, name: string) => { created.push(name); return ++nextTopic },
  topicDone: async (chat: string, thread: number) => { done.push({ chat, thread }); return 'the icon was set to ✅' } } as any
L.lanesInit(deps)
L.__setMainConnected('mcp-main')
const procs: any[] = []
afterAll(() => { try { writeFileSync(GO, 'ok') } catch {}; L.__setClaudeBin(restore); for (const p of procs) try { p.kill('SIGKILL') } catch {}
  for (const k of ['LANES_FLOOD_CONTROL', 'LANES_CLOSE_GRACE_MS', 'LANES_TOPIC_SWEEP_MS']) delete process.env[k] })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const laneOf = (topic: number) => Object.values(L.__lanesState().lanes).find(l => l.topic === topic)!
const release = async (id: string) => { writeFileSync(GO, 'ok'); expect(await until(() => !L.__runTok(id))).toBe(true); await sleep(40) }

test('names: emoji dropped (the server drops them), whitespace folded, a fallback when nothing is left; the link', () => {
  expect(plainTopicName('✅ 工作：示範', 'x')).toBe('工作：示範')
  expect(plainTopicName(' 🚀 查  報表 🇹🇼 ', 'x')).toBe('查 報表')
  expect(plainTopicName('🚀🚀', '工作線 3')).toBe('工作線 3')
  expect([...plainTopicName('長'.repeat(300), 'x')].length).toBe(120)
  expect(stripEmoji('a👍🏽b')).toBe('ab')
  expect(topicLink('lab_test_bot', 7401)).toBe('https://t.me/lab_test_bot/7401'); expect(topicLink('@lab_test_bot', 1)).toBe('https://t.me/lab_test_bot/1'); expect(topicLink('', 1)).toBeNull()
})

test('open_worker: the topic is created under the plain name; the result gives the link and that name; the name is what the main and lanes see', async () => {
  const r = await L.callMainTool('open_worker', { title: '🚀 整理月報 ✅', brief: '整理完貼結論' }, 'mcp-main')
  expect(created.at(-1)).toBe('整理月報')
  expect(r).toContain('opened in topic #7401 「整理月報」 (https://t.me/lab_test_bot/7401)')
  expect(r).toContain('lane_close')
  expect(laneOf(7401)).toMatchObject({ title: '🚀 整理月報 ✅', topic_name: '整理月報' })
  expect(L.topicName(7401)).toBe('整理月報')
  await release(laneOf(7401).id)
})

test('the main closes a worker that is not running: ✅ icon on its topic, one silent closing line IN the topic, nothing deleted; once', async () => {
  const lane = laneOf(7401)
  expect(await L.callMainTool('lane_close', { lane_id: lane.id }, 'mcp-main')).toBe(`closed ${lane.id}`)
  await L.__topicFinishing()
  expect(done).toEqual([{ chat: '1', thread: 7401 }])
  const line = sent.find(s => String(s.text).includes('這條工作線結束了'))
  expect(line).toMatchObject({ chat: '1', topic: 7401, silent: true })
  expect(line.text).toContain('主線用 lane_close'); expect(line.text).toContain('不會刪')
  expect(L.__lanesState().lanes[lane.id]).toMatchObject({ status: 'closed', topic: 7401 }); expect(L.__lanesState().lanes[lane.id].topic_done).toBeTruthy()
  expect(L.__lanesState().topics['7401']).toBeUndefined()
  expect(L.__lanesState().topic_names?.['7401']).toBe('整理月報')                              // the topic stays, by name
  expect(await L.callMainTool('lane_close', { lane_id: lane.id }, 'mcp-main')).toContain('already closed')
  await L.__topicFinishing(); expect(done.length).toBe(1)
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8') + readFileSync(join(import.meta.dir, 'lanes.ts'), 'utf8')
  expect(src).not.toMatch(/deleteForumTopic\(/)
})

test('Joey types in the finished topic later: it goes to the main, and the main\'s answer (quoting him, or not) lands in that topic', async () => {
  const meta = { chat_id: '1', message_id: '880', user: 'joey', topic: '7401' }
  const d = await L.routeEvent({ id: 'tg-1-880', source: 'telegram', from: 'joey', text: '這份月報還要加圖表', meta, verified: true, message_thread_id: '7401',
    notif: { method: 'notifications/claude/channel', params: { content: '這份月報還要加圖表', meta } } } as any)
  expect(d.target).toBe('main')
  expect(L.targetTopic({ chat: '1', replyTo: '880', turn: true })).toBe(7401)
  const proc = Bun.spawn(['sleep', '600']); procs.push(proc)
  const sid = `00000000-0000-4000-8000-${String(proc.pid).padStart(12, '0')}`
  writeFileSync(join(dir, 'main-expected'), sid)
  await L.__mainEvent({ event: 'SessionStart', pid: proc.pid, session_id: sid })
  const dids = L.__main().items(r => String(r.event) === 'tg-1-880').map(r => r.id)
  await L.__mainEvent({ event: 'UserPromptSubmit', pid: proc.pid, prompt_id: 'p-late', dids })
  try { expect(L.targetTopic({ chat: '1', turn: true })).toBe(7401) }
  finally { await L.__mainEvent({ event: 'Stop', pid: proc.pid, prompt_id: 'p-late', phase: 'final' }); await L.__mainEvent({ event: 'SessionEnd', pid: proc.pid }); proc.kill('SIGKILL') }
  L.__setMainConnected('mcp-main')
}, 20000)

test('Joey closes a RUNNING worker with /lanes close: the topic is finished when that run has ended, after the run\'s own line', async () => {
  const r = await L.callMainTool('open_worker', { title: '查 CDN', brief: '查完回報' }, 'mcp-main')
  expect(r).toContain('#7402')
  const lane = laneOf(7402)
  expect(await until(() => !!L.__runTok(lane.id))).toBe(true)
  const n = done.length
  const said = await L.lanesCommand(`/lanes close ${lane.id}`, 'joey')
  expect(said).toBeTruthy()
  await sleep(100); await L.__topicFinishing()
  expect(done.length).toBe(n)                                                                    // still running: not yet
  expect(L.__lanesState().lanes[lane.id].topic_close).toBe('pending')
  await release(lane.id)
  expect(await until(() => done.length === n + 1)).toBe(true)
  await L.__topicFinishing()
  expect(done.at(-1)).toEqual({ chat: '1', thread: 7402 })
  expect(sent.filter(s => String(s.text).includes('這條工作線結束了') && s.topic === 7402).length).toBe(1)
  expect(sent.find(s => s.topic === 7402 && String(s.text).includes('這條工作線結束了')).text).toContain('Joey 用 /lanes close')
}, 30000)

test('a close a daemon restart cut off is finished at boot; a lane closed before this version (no pending mark) is left alone', async () => {
  const st = L.__lanesState()
  const a = await L.callMainTool('open_worker', { title: '甲', brief: 'x' }, 'mcp-main'), b = await L.callMainTool('open_worker', { title: '乙', brief: 'x' }, 'mcp-main')
  expect(a).toContain('#7403'); expect(b).toContain('#7404')
  await release(laneOf(7403).id); await release(laneOf(7404).id)
  Object.assign(st.lanes[laneOf(7403).id], { status: 'closed', topic_close: 'pending' })              // closed, the daemon stopped before the finish
  Object.assign(st.lanes[laneOf(7404).id], { status: 'closed' })                                       // closed by an older version
  writeFileSync(join(dir, 'state.json'), JSON.stringify(st))
  const done2: number[] = [], sent2: any[] = []
  const L2 = await import('./lanes.ts?topics-lifecycle-2') as typeof import('./lanes.ts')
  L2.lanesInit({ ...deps, topicDone: async (_c: string, t: number) => { done2.push(t); return 'ok' }, sendBot: async (c: string, text: string, o: any) => { sent2.push({ text, ...o }); return 1 } })
  expect(await until(() => done2.length === 1)).toBe(true)
  await sleep(150); await L2.__topicFinishing()
  expect(done2).toEqual([7403])
  expect(sent2.filter(s => s.topic === 7403).length).toBe(1)
}, 30000)

// ---- the daemon: the real Bot API calls (a board work order opens the worker; Joey closes it with /lanes close; then he types in the topic)
test('daemon: createForumTopic with the plain name; the close looks the ✅ up, sets it with editForumTopic, posts the closing line in the topic', async () => {
  const api = startBotApiMock({ has_topics_enabled: true, allows_users_to_create_topics: false })
  const root = mkdtempSync(join(tmpdir(), 'lanes-topics-lifecycle-d-'))
  const d = await startTgDaemon(api, root, 1828, { ROAMER_MODE: '1', LANES_CLOSE_GRACE_MS: '300', LANES_RETRY_BACKOFF_MS: '60000' })
  try {
    const tok = readFileSync(join(root, 'tok', String(d.port)), 'utf8').trim()
    const text = '[board][WO-77] ✅ 請 adam 整理 🚀 名單'
    const r = await fetch(`http://127.0.0.1:${d.port}/lanes/route`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ id: 'mesh-d-77', source: 'mesh', from: 'board', verified: true, text, meta: {}, line: 'call', notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } }) }).then(x => x.json()) as any
    expect(r).toMatchObject({ rule: 'mesh-board', target: 'lane' })
    expect(api.of('createForumTopic').map(c => c.body)).toEqual([{ chat_id: '1828', name: '工單 WO-77' }])
    const topic = 7001
    api.push(dm(1828, 90, '/lanes close 工作線#1', { command: true }))
    expect(await untilA(() => api.of('editForumTopic').length === 1, 15000)).toBe(true)
    expect(api.of('getForumTopicIconStickers').length).toBe(1)
    expect(api.of('editForumTopic')[0].body).toEqual({ chat_id: '1828', message_thread_id: topic, icon_custom_emoji_id: ICON_CHECK })
    // rich lane lines: the closing line goes as a rendered message, like the main's reply (lanes-topics-richlines.test.ts)
    expect(await untilA(() => api.of('sendRichMessage').some(c => String(c.body.rich_message?.markdown).includes('這條工作線結束了')))).toBe(true)
    const line = api.of('sendRichMessage').find(c => String(c.body.rich_message?.markdown).includes('這條工作線結束了'))!
    expect(line.body).toMatchObject({ message_thread_id: topic, disable_notification: true })
    expect(api.calls.some(c => c.method === 'deleteForumTopic' || c.method === 'closeForumTopic')).toBe(false)
    // later, in the finished topic: the main's item (no lane), its meta naming the topic
    api.push(dm(1828, 91, '再補一句', { topic, topicName: '工單 WO-77' }))
    const items = () => { try { return readFileSync(join(d.stateDir, 'lanes', 'state.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.rec === 'msg' && x.notif?.params?.meta?.message_id === '91') } catch { return [] } }
    expect(await untilA(() => items().length > 0)).toBe(true)
    expect(items()[0].notif.params.meta).toMatchObject({ topic: '7001', topic_name: '工單 WO-77' })
    expect(items()[0].notif.params.meta.topic_state).toBe('closed')                         // the line behind the topic has ended: the main answers there
    expect(String(items()[0].notif.params.meta.topic_anchor)).toMatch(/^knowledge\/lines\/.+\.md$/)   // and is told where that line's hand-over file is
  } finally { await d.stop(); api.stop() }
}, 60000)
