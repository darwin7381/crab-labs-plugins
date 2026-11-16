// Universe 002m (G06, RV5/RV6: judge where_each_died 0.02-0.04 in every play): the 3-failure hand-over says where each run died: how it ended, after
// how long and how many calls, its last tool call and result, its last words and its error output. stability SR2 「反射線連續失敗就升級主線」 (H15).
// The "lane process" is a shell script that prints one tool call and dies: no model, no network.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?pl2-g06-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-pl2-g06-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const dying = join(dir, 'dying.sh')
writeFileSync(dying, `#!/bin/sh
echo '{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":5,"output_tokens":7},"content":[{"type":"text","text":"先看 mock-api 的 health"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"curl -s localhost:18900/health"}}]}}'
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"curl: (7) Failed to connect to localhost port 18900"}]}}'
echo 'fatal: lane crashed in the tool loop' >&2
sleep 0.1
exit 3
`); chmodSync(dying, 0o755)
const restore = L.__setClaudeBin(dying)
L.__setRetryBackoff(20)
afterAll(() => { L.__setClaudeBin(restore); L.__setRetryBackoff(5000) })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const rows = (name: string): any[] => { try { return readFileSync(join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }

test('G06: after three failed runs the hand-over to the main names, for each run, how it died, its last tool call and result, and its error output', async () => {
  const d = await L.routeEvent({ id: 'mesh-g06', source: 'mesh', from: 'scheduler', verified: true, text: '[scheduled][health-check][run:5][normal][ops] 查 mock-api', meta: {},
    notif: { method: 'notifications/claude/channel', params: { content: 'x', meta: {} } } } as any)
  expect(d.target).toBe('lane')
  expect(await until(() => rows('ledger.jsonl').some(r => r.event === 'mesh-g06' && r.kind === 'escalation'))).toBe(true)
  const esc = rows('ledger.jsonl').find(r => r.event === 'mesh-g06' && r.kind === 'escalation')
  expect(esc.text).toContain('連續 3 次')
  expect(esc.text).toContain('每一次死在哪裡：')
  for (const n of [1, 2, 3]) expect(esc.text).toContain(`第 ${n} 次（${d.lane}.r`)
  expect(esc.text.match(/行程以 exit 3 結束/g)?.length).toBe(3)
  expect(esc.text).toContain('死前最後的工具呼叫 Bash `curl -s localhost:18900/health`')
  expect(esc.text).toContain('最後的工具結果：curl: (7) Failed to connect')
  expect(esc.text).toContain('錯誤輸出：fatal: lane crashed in the tool loop')
  expect(esc.text).toContain('1 次模型呼叫')
})

test('G06: the text itself: a run killed for running too long, a run with no tool call, and attempts the daemon never saw end', () => {
  const t = L.failedHandoffText({ attempts: 3, ev: { from: 'eve', text: '幫我查' }, deaths: [
    { run: 'adam.reflex.1.r1', how: '超過 600 秒還沒結束，被 daemon 停下（SIGKILL）', after_s: 600, calls: 9, last_tool: 'Bash `sleep 900`' },
    { run: 'adam.reflex.1.r2', how: '行程被訊號 SIGTERM 結束', after_s: 1.2, calls: 0 }] })
  expect(t).toContain('- 第 1 次（adam.reflex.1.r1）：超過 600 秒還沒結束，被 daemon 停下（SIGKILL），跑了 600 秒、9 次模型呼叫；死前最後的工具呼叫 Bash `sleep 900`')
  expect(t).toContain('- 第 2 次（adam.reflex.1.r2）：行程被訊號 SIGTERM 結束，跑了 1.2 秒、0 次模型呼叫；沒有呼叫任何工具')
  expect(t).toContain('- 其餘 1 次沒有被 daemon 看到結束')
})

test('G06: three long deaths still reach the main whole (the hand-over is not cut at the old 1000 characters)', () => {
  const long = (n: number) => ({ run: `adam.reflex.9.r${n}`, how: '行程以 exit 1 結束', after_s: 30, calls: 12, last_tool: 'Bash `' + 'x'.repeat(120) + '`',
    last_result: 'r'.repeat(160), last_text: 't'.repeat(120), stderr: 'e'.repeat(160) })
  const t = L.failedHandoffText({ attempts: 3, ev: { from: 'scheduler', text: 'q'.repeat(400) }, deaths: [long(1), long(2), long(3)] })
  expect(t.length).toBeLessThan(3000)
  expect(t).toContain('第 3 次（adam.reflex.9.r3）')
})
