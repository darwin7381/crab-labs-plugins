// 002w (I, 002v round 2 D02): Joey's own words travel with everything the main gets that came from his message. ONE function (joeyWords) renders the
// router's text of Joey's Telegram message from its event record, marked 〔Joey 原話｜…〕; the hand-over, the memory proposal (its standing digest line, its
// ledger_query row, the memory gate's listing that asks for memory_decide) and every digest line of a Joey event use it. D02 s4 r2: the lane filed
// Joey's 「記住」 in its own words and the main vetoed it, 「我在主線對話紀錄裡找不到你 2006 那則的原文」. A worker lane in its topic, run by a waiting script.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, chmodSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?w-i-test') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-w-i-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
const GO = join(dir, 'go'), bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, time
t0 = time.time()
while time.time() - t0 < 60 and not os.path.exists('${GO}'): time.sleep(0.02)
try: os.remove('${GO}')
except OSError: pass
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
afterAll(() => { try { writeFileSync(GO, 'ok') } catch {}; L.__setClaudeBin(restore); delete process.env.LANES_FLOOD_CONTROL })
const st = L.__lanesState()
const LANE = 'adam.worker.1', TOPIC = '888'
st.lanes[LANE] = { id: LANE, kind: 'worker', n: 1, session_id: '32b0d8cc-1a32-4fd9-abac-1662c9fe4b55', thread: 'adam#t-wi', status: 'idle', created: '', last: new Date().toISOString(), transcript: join(dir, 'none.jsonl'), runs: 0, tokens_in: 0, tokens_out: 0, topic: Number(TOPIC) } as any
st.threads['adam#t-wi'] = { id: 'adam#t-wi', lane: LANE, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
st.topics[TOPIC] = LANE
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const HEAD = '〔Joey 原話｜分流器從 Telegram 收到的原文，不是車道的轉述〕'
const SAID = '記住：週三 14:00 是 mock-api 的維護窗口，那段時間的告警不用叫我。'
let pid = ''
test('setup: Joey writes in the worker\'s topic; the lane files his 「記住」 as a memory proposal in its own words', async () => {
  const meta = { message_id: '2006', chat_id: '1' }
  const d = await L.routeEvent({ id: 'tg-1-2006', source: 'telegram', from: 'joey', text: SAID, meta, notif: { method: '', params: {} }, message_thread_id: TOPIC } as any)
  expect(d.lane).toBe(LANE)
  expect(await until(() => !!L.__runTok(LANE))).toBe(true)
  const out = await L.callLaneTool(L.__runTok(LANE)!, 'ledger_write', { kind: 'memory_proposal', text: 'mock-api 週三下午有維護' })
  pid = out.match(/mp-[0-9a-f]+/)![0]
  expect(await L.callLaneTool(L.__runTok(LANE)!, 'notify_joey', { outcome: 'normal', text: '記下了，提案給主線。' })).toContain('sent to Joey')   // his line met: no hand-over carries his words
  writeFileSync(GO, 'ok'); await until(() => !L.__runTok(LANE))
  expect(L.__main().items((r: any) => r.event === 'tg-1-2006').length).toBe(0)
})

test('002w I, path the memory proposal\'s standing digest line: it carries Joey\'s own words (2a936a7: only the lane\'s restatement)', () => {
  const dg = L.__digest()!.text
  const line = dg.split('\n').find(l => l.includes(`記憶提案 ${pid}`))!
  expect(line).toContain('mock-api 週三下午有維護'); expect(line).toContain(HEAD); expect(line).toContain('message_id 2006'); expect(line).toContain(SAID)
})

test('002w I, path ledger_query(kind=memory_proposal): the proposal\'s row carries Joey\'s own words (2a936a7: the lane\'s text and review only)', () => {
  const q = L.ledgerQueryTool({ kind: 'memory_proposal' })
  expect(q).toContain(pid); expect(q).toContain(HEAD); expect(q).toContain(SAID)
})

test('002w I, path the memory gate\'s listing (the hold that asks for memory_decide): each proposal carries Joey\'s own words (2a936a7: 240 characters of the lane\'s text)', () => {
  const p = L.memoryFacts().proposals.find(x => x.id === pid)! as any
  expect(p.joey_words).toContain(HEAD); expect(p.joey_words).toContain(SAID)
  const py = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('g', ${JSON.stringify(join(import.meta.dir, 'lanes-hooks', 'main-memory-gate.py'))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(m.reason({'hook_event_name': 'Stop', 'session_id': 's'}, {'prompt_id': 'p1'}, json.loads(sys.argv[1]), False))`
  const r = spawnSync('python3', ['-c', py, JSON.stringify([{ ...p, shown: true }])], { encoding: 'utf8', env: { ...process.env, LANES_DIR: dir } })
  expect(r.stdout).toContain(pid); expect(r.stdout).toContain(HEAD); expect(r.stdout).toContain(SAID)
})

test('002w I, path a digest line of a Joey event (and the activity list, the same renderer): it carries his own words next to what the lane did (2a936a7: the lane\'s words only)', () => {
  L.__events().note('tg-1-2006', { did: '已記下週三維護窗口，提案給主線' })
  const line = L.activityList('-1h').split('\n').find(l => l.includes('已記下週三維護窗口'))!
  expect(line).toContain(HEAD); expect(line).toContain(SAID)
  const peer = L.activityList('-1h').split('\n').find(l => l.includes('來自 eve'))
  expect(peer ?? '').not.toContain(HEAD)
})

test('002w I, path the hand-over (handToMain): the block comes from the same function, unchanged in form', async () => {
  const meta = { message_id: '2007', chat_id: '1' }
  await L.routeEvent({ id: 'tg-1-2007', source: 'telegram', from: 'joey', text: '把舊快照刪掉。', meta, notif: { method: '', params: {} }, message_thread_id: TOPIC } as any)
  expect(await until(() => !!L.__runTok(LANE))).toBe(true)
  await L.callLaneTool(L.__runTok(LANE)!, 'handoff_main', { text: 'Joey 要刪舊快照（不可逆），交主線' })
  const ho = L.__main().items((r: any) => r.kind === 'handoff' && r.event === 'tg-1-2007')[0]
  expect(String(ho.notif.params.content)).toContain(`${HEAD}話題 #${TOPIC}，message_id 2007：「把舊快照刪掉。」`)
  writeFileSync(GO, 'ok'); await until(() => !L.__runTok(LANE))
  expect(existsSync(GO)).toBe(false)
})
