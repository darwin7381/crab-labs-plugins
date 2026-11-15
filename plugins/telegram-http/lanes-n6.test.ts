// Universe 002l (N6, RV2 T7-R #9 #12 #13 #15): behind the main's model wall nothing is replayed into the main, on any path, and the carry-on notice at
// wall-down is decided from the wall's own record and what is still owed, not from the transcript's last record alone. 002j: 「主線撞到額度：給主線的訊息
// 先保留」. The "model" is a shell script; no network.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, appendFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const wasOn = process.env.GENESIS_LANES
process.env.GENESIS_LANES = '1'                                                    // LANES_ON is read at import: this instance runs as a lanes daemon
const L = await import('./lanes.ts?n6-test') as typeof import('./lanes.ts')
if (wasOn === undefined) delete process.env.GENESIS_LANES; else process.env.GENESIS_LANES = wasOn
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-n6-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const T = join(dir, 'main.jsonl')
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: T, claude_pid: 1, registered_at: new Date().toISOString() }))
const script = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p }
const WALLED = script('walled.sh', `echo '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You have hit your weekly limit"}'\nexit 1`)
const OK = script('ok.sh', `echo '{"type":"result","subtype":"success","is_error":false,"result":"OK"}'\nexit 0`)
const restore = L.__setClaudeBin(WALLED)
L.__setWallProbe(300)
afterAll(() => { L.__setClaudeBin(restore); L.__setWallProbe(300_000) })
let parked = 0
const sent: string[] = [], notices: Array<{ content: string; meta: Record<string, string> }> = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sweepNow: () => {}, pendingCount: () => parked, sendBot: async (_c: string, text: string) => { sent.push(text); return 4100 + sent.length }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
L.__setDigestIO({ mainConnected: async () => true, deliver: async (content, meta) => { notices.push({ content, meta }); return true } })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const rec = (o: object) => JSON.stringify(o) + '\n'
const iso = (ms: number) => new Date(ms).toISOString()
const genuine = (ms: number, tool = false) => rec({ type: 'assistant', timestamp: iso(ms), message: { model: 'claude-haiku-5-5', stop_reason: tool ? 'tool_use' : 'end_turn',
  content: tool ? [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'make report' } }] : [{ type: 'text', text: '好' }] } })
const toolResult = (ms: number) => rec({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'step 3 of 7 done' }] } })
const apiErr = (ms: number) => rec({ type: 'assistant', timestamp: iso(ms), isApiErrorMessage: true, message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: "You've hit your weekly limit · resets 5:48pm (Asia/Taipei)" }] } })
const turnEnd = (ms: number) => rec({ type: 'system', subtype: 'turn_duration', timestamp: iso(ms) })
const tgNotif = (id: string) => ({ method: 'notifications/claude/channel', params: { content: 'x', meta: { chat_id: '1', message_id: id, user: 'joey_lab' } } }) as any

test('N6: behind the wall no replay is allowed (the session-open replay asks the same gate as the timer drain)', () => {
  expect(L.replayAllowed()).toBe(true)
  const now = Date.now()
  writeFileSync(T, genuine(now - 30_000, true) + toolResult(now - 29_000) + apiErr(now - 28_000) + turnEnd(now - 27_900))
  L.mainWallTick()
  expect(L.wallHoldsMain()).toBe(true)
  expect(L.replayAllowed()).toBe(false)
})

test('N6: the main\'s process was replaced behind the wall and wrote new records; two held messages are still parked: at wall-down the main is still told to carry on, and Joey is told the two are handed over now', async () => {
  L.noteHeldForMain(tgNotif('601')); L.noteHeldForMain(tgNotif('602'))
  parked = 2
  appendFileSync(T, genuine(Date.now()))                                            // the new process wrote a genuine record: the last record is no longer the error
  L.__setClaudeBin(OK)
  expect(await until(() => !L.wallHoldsMain(), 4000)).toBe(true)
  expect(await until(() => sent.some(t => t.includes('主線的模型恢復了')))).toBe(true)
  expect(notices.length).toBe(1); expect(notices[0].meta.kind).toBe('wall-resume'); expect(notices[0].content).toContain('2 則')
  const down = sent.find(t => t.includes('主線的模型恢復了'))!
  expect(down).toContain('保留的 2 則訊息現在交給主線'); expect(down).toContain('已經通知它接著做完')
  expect(L.replayAllowed()).toBe(true)
})

test('N6: when nothing is owed any more (the held messages were already taken in) and the last record is not the error, no carry-on notice; Joey is not told they are being handed over now', async () => {
  L.__setClaudeBin(WALLED)
  const now = Date.now()
  appendFileSync(T, genuine(now - 3000, true) + toolResult(now - 2500) + apiErr(now - 2000) + turnEnd(now - 1900))
  L.mainWallTick()
  expect(L.wallHoldsMain()).toBe(true)
  L.noteHeldForMain(tgNotif('603'))
  parked = 0
  appendFileSync(T, genuine(Date.now()))
  const n0 = notices.length, s0 = sent.length
  L.__setClaudeBin(OK)
  expect(await until(() => !L.wallHoldsMain(), 4000)).toBe(true)
  expect(await until(() => sent.slice(s0).some(t => t.includes('主線的模型恢復了')))).toBe(true)
  expect(notices.length).toBe(n0)
  const down = sent.slice(s0).find(t => t.includes('主線的模型恢復了'))!
  expect(down).not.toContain('現在交給主線'); expect(down).toContain('已經都交給主線了')
})
