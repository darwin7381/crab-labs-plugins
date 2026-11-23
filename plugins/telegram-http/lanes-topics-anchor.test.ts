// lanes-topics item 5: a work topic's anchor file. The fleet's rule: every open line of work has an anchor file under the workspace's knowledge/, for
// whoever takes over; lanes write nothing under knowledge/ (guard hook, 11-23). Each WORKER lane owns exactly one file, knowledge/lines/<slug>.md,
// assigned at open_worker and created only if absent (title, topic, Joey's words of the opening turn, the brief); its 〔車道資訊〕 names it (read first,
// update at checkpoints); the guard lets that lane write that one path and nothing else under knowledge/; open_worker tells the main the path for
// knowledge/REANCHOR.md (the main is that file's only writer). Other lanes: unchanged.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { anchorSlug } from './lanes-topics.ts'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?topics-anchor') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-topics-anchor-'))
process.env.LANES_DIR = join(dir, '.lanes')
mkdirSync(join(dir, '.lanes'), { recursive: true })
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, '.lanes', 'router.json'))
let nextTopic = 7500
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async () => 1, joeyChatId: () => '1', botUsername: () => 'lab_test_bot', createTopic: async () => ++nextTopic, topicDone: async () => 'ok' } as any)
L.__setClaudeBin(join(import.meta.dir, 'test-fixtures', 'no-claude.sh'))
const procs: any[] = []
afterAll(() => { for (const p of procs) try { p.kill('SIGKILL') } catch {}; delete process.env.LANES_FLOOD_CONTROL })
const laneOf = (topic: number) => Object.values(L.__lanesState().lanes).find(l => l.topic === topic)!
const HOOK = join(import.meta.dir, 'lanes-hooks', 'lane-guard-hook.py')

test('slug: letters and digits of the title in any script, lower case, dashes; nothing that climbs out', () => {
  expect(anchorSlug('整理 Q3 報表', 'w')).toBe('整理-q3-報表')
  expect(anchorSlug('../../etc/passwd', 'w')).toBe('etc-passwd')
  expect(anchorSlug('🚀', 'worker-4')).toBe('worker-4')
})

test('open_worker in a turn on Joey\'s message: the anchor file is created with the title, the topic link, his words and the brief; the main is told the path', async () => {
  const meta = { chat_id: '1', message_id: '2001', user: 'joey' }
  await L.routeEvent({ id: 'tg-1-2001', source: 'telegram', from: 'joey', text: '這件開一條線：把 Q3 報表整理好，週五前', meta, verified: true,
    notif: { method: 'notifications/claude/channel', params: { content: '這件開一條線：把 Q3 報表整理好，週五前', meta } } } as any)
  const proc = Bun.spawn(['sleep', '600']); procs.push(proc)
  const sid = `00000000-0000-4000-8000-${String(proc.pid).padStart(12, '0')}`
  writeFileSync(join(dir, '.lanes', 'main-expected'), sid)
  await L.__mainEvent({ event: 'SessionStart', pid: proc.pid, session_id: sid })
  await L.__mainEvent({ event: 'UserPromptSubmit', pid: proc.pid, prompt_id: 'p-a', dids: L.__main().items(r => String(r.event) === 'tg-1-2001').map(r => r.id) })
  L.__noteMcpPid('mcp-main', proc.pid)                       // after the turn took the item (a stream opening on an idle main would offer it first)
  let r = ''
  try { r = await L.callMainTool('open_worker', { title: '整理 Q3 報表', brief: '目標：Q3 報表。限制：不改原始資料。完成：貼結論。' }, 'mcp-main') }
  finally { await L.__mainEvent({ event: 'Stop', pid: proc.pid, prompt_id: 'p-a', phase: 'final' }) }
  const rel = join('knowledge', 'lines', '整理-q3-報表.md')
  expect(r).toContain(`Its anchor file is ${rel}`)
  expect(r).toContain('knowledge/REANCHOR.md'); expect(r).toContain(`定錨檔：${rel}`)
  const lane = laneOf(7501)
  expect(lane.anchor).toBe(rel)
  const text = readFileSync(join(dir, rel), 'utf8')
  expect(text).toContain('# 定錨檔：整理 Q3 報表')
  expect(text).toContain('https://t.me/lab_test_bot/7501')
  expect(text).toContain('〔Joey 原話｜分流器從 Telegram 收到的原文，不是車道的轉述〕message_id 2001：「這件開一條線：把 Q3 報表整理好，週五前」')
  expect(text).toContain('目標：Q3 報表。限制：不改原始資料。完成：貼結論。')
  for (const h of ['## 要交出什麼（Joey 原話）', '## 已定的／被否決的', '## 做到哪、產物在哪', '## 背景在跑什麼', '## 下一步']) expect(text).toContain(h)
  // the lane's block names it, with the instruction; a reflex lane's has none
  const ctx = L.laneContext(lane as any, { ev: { id: 'x', source: 'mesh', from: 'main', text: '', meta: {}, notif: { method: '', params: {} } } as any } as any)
  expect(ctx).toContain(`你的定錨檔：${rel}（${join(dir, rel)}）`); expect(ctx).toContain('每一趟開始先讀它；到檢查點')
  const reflex = Object.values(L.__lanesState().lanes).find(l => l.kind !== 'worker')
  if (reflex) expect(L.laneContext(reflex as any, { ev: { id: 'y', source: 'mesh', from: 'x', text: '', meta: {}, notif: { method: '', params: {} } } as any } as any)).not.toContain('你的定錨檔')
}, 20000)

test('only if absent: a second open worker of the same title gets its own file; after the first is closed, the same title continues the same file', async () => {
  writeFileSync(join(dir, 'knowledge', 'lines', '整理-q3-報表.md'), '# 定錨檔：整理 Q3 報表\n\n做到第二步（工作線寫的）\n')
  await L.callMainTool('open_worker', { title: '整理 Q3 報表', brief: '另一份' }, 'mcp-main')
  expect(laneOf(7502).anchor).toBe(join('knowledge', 'lines', '整理-q3-報表-2.md'))
  await L.callMainTool('lane_close', { lane_id: laneOf(7501).id }, 'mcp-main')
  await L.callMainTool('lane_close', { lane_id: laneOf(7502).id }, 'mcp-main')
  await L.callMainTool('open_worker', { title: '整理 Q3 報表', brief: '接著做' }, 'mcp-main')
  expect(laneOf(7503).anchor).toBe(join('knowledge', 'lines', '整理-q3-報表.md'))
  expect(readFileSync(join(dir, 'knowledge', 'lines', '整理-q3-報表.md'), 'utf8')).toContain('做到第二步（工作線寫的）')     // not overwritten
}, 20000)

// ---- the guard (python, the lane's PreToolUse hook), with the lanes state the daemon wrote
function guard(laneId: string, kind: string, input: Record<string, unknown>): string {
  const r = spawnSync('python3', [HOOK], { input: JSON.stringify({ ...input, cwd: dir }), encoding: 'utf8',
    env: { ...process.env, LANES_DIR: join(dir, '.lanes'), LANES_MEMORY_DIR: join(dir, 'memory'), LANES_WORKSPACE: dir, LANE_KIND: kind, LANE_ID: laneId, GENESIS_LOGOS_URL: '', LANES_LOGOS_URL: '' } })
  return r.stdout
}

test('the guard: the open worker writes its own anchor file (Write, Edit, shell) and nothing else under knowledge/; other kinds and a closed worker write none', () => {
  const lane = laneOf(7503), mine = lane.anchor!, other = laneOf(7502).anchor!
  expect(guard(lane.id, 'worker', { tool_name: 'Write', tool_input: { file_path: mine, content: 'x' } })).toBe('')
  expect(guard(lane.id, 'worker', { tool_name: 'Edit', tool_input: { file_path: join(dir, mine), old_string: 'a', new_string: 'b' } })).toBe('')
  expect(guard(lane.id, 'worker', { tool_name: 'Bash', tool_input: { command: `echo '- 定了：用新版' >> ${mine}` } })).toBe('')
  for (const f of ['knowledge/REANCHOR.md', other, 'knowledge/lines/new.md', 'knowledge/topics-design.md']) {
    const w = guard(lane.id, 'worker', { tool_name: 'Write', tool_input: { file_path: f, content: 'x' } })
    expect(w).toContain('lanes do not write knowledge/'); expect(w).toContain('its own anchor file')
    expect(guard(lane.id, 'worker', { tool_name: 'Bash', tool_input: { command: `echo x > ${f}` } })).toContain('lanes do not write knowledge/')
  }
  expect(guard(lane.id, 'worker', { tool_name: 'Bash', tool_input: { command: 'echo x > knowledge/lines/*.md' } })).toContain('lanes do not write knowledge/')
  // the same path, another lane or kind: refused
  expect(guard(laneOf(7502).id, 'worker', { tool_name: 'Write', tool_input: { file_path: mine, content: 'x' } })).toContain('lanes do not write knowledge/')   // closed, and not its file
  expect(guard(lane.id, 'reflex', { tool_name: 'Write', tool_input: { file_path: mine, content: 'x' } })).toContain('lanes do not write knowledge/')
  expect(guard(lane.id, 'fork', { tool_name: 'Bash', tool_input: { command: `echo x >> ${mine}` } })).toContain('lanes do not write knowledge/')
  expect(guard(lane.id, 'worker', { tool_name: 'Bash', tool_input: { command: 'echo x > notes.md' } })).toContain('claim the file first')   // the rest of the workspace: as before
})

test('a reflex, mail or fork lane gets no anchor file; a worker the router opens (a board work order) gets one too', async () => {
  const text = '[board][WO-88] 請 adam 處理'
  const d = await L.routeEvent({ id: 'mesh-an-88', source: 'mesh', from: 'board', verified: true, text, meta: {}, line: 'call', notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any)
  expect(d).toMatchObject({ rule: 'mesh-board', target: 'lane' })
  expect(L.__lanesState().lanes[d.lane!].anchor).toBe(join('knowledge', 'lines', '工單-wo-88.md'))
  expect(existsSync(join(dir, 'knowledge', 'lines', '工單-wo-88.md'))).toBe(true)
  for (const l of Object.values(L.__lanesState().lanes)) if (l.kind !== 'worker') expect(l.anchor).toBeUndefined()
})
