// Universe 002l (D12, RV3 G07 #2): one quota exhaustion is told to Joey once, naming the session that hit it: the lanes' wall and the main's wall of the
// same kind share one notice, and the TUI relay of the same usage-limit line defers to it. design/notify 「同一件事不會連發」. No model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const WALL = "You've hit your weekly limit · resets Nov 15, 10:49pm (Asia/Taipei)"
async function instance(tag: string) {
  const L = await import(`./lanes.ts?d12-${tag}`) as typeof import('./lanes.ts')
  const dir = mkdtempSync(join(tmpdir(), `lanes-d12${tag}-`))
  process.env.LANES_DIR = dir
  copyFileSync(ROUTER, join(dir, 'router.json'))
  writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
  const bin = join(dir, 'lane.sh')
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429, result: WALL }) + '\n')
  writeFileSync(bin, `#!/bin/sh\ncat '${join(dir, 'result.json')}'\nexit 1\n`); chmodSync(bin, 0o755)
  const restore = L.__setClaudeBin(bin)
  const sent: string[] = []
  L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'],
    sendBot: async (_c: string, text: string) => { sent.push(text); return 9900 + sent.length }, joeyChatId: () => '1' } as any)
  L.__setMainConnected('mcp-main')
  const rows = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
  return { L, sent, rows, restore }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const ev = (id: string) => ({ id, source: 'mesh', from: 'eve', verified: true, text: 'WO-27 排第幾？', meta: {}, notif: { method: '', params: {} } } as any)
const wallPushes = (sent: string[]) => sent.filter(t => /不能用模型|額度用完/.test(t))
const restores: Array<() => void> = []
afterAll(() => { for (const r of restores) r() })

test('D12: the lanes hit the wall first (one push naming the lanes); the main hits the same wall: recorded, not pushed again', async () => {
  const { L, sent, rows, restore } = await instance('a'); restores.push(() => L.__setClaudeBin(restore))
  await L.routeEvent(ev('mesh-w1'))
  expect(await until(() => L.wallActive())).toBe(true)
  await until(() => wallPushes(sent).length >= 1)
  L.noteMainWalled({ kind: 'usage', text: WALL, at: Date.now(), midTask: true, model: 'claude-haiku-5-5' })
  await sleep(100)
  expect(wallPushes(sent).length).toBe(1)
  expect(wallPushes(sent)[0]).toContain('車道')                                          // it names the session that hit the wall
  const r = rows().find(x => x.refs?.tier_rule === 'main-wall-up+deduped-lanes-wall')!
  expect(r).toBeTruthy(); expect(r.text).toContain('主線現在不能用模型')                // the main's wall is on the record
})

test('D12: the main hits the wall first (one push naming the main); the lanes then hit it: recorded, not pushed; their recovery is not pushed either', async () => {
  const { L, sent, rows, restore } = await instance('b'); restores.push(() => L.__setClaudeBin(restore))
  L.noteMainWalled({ kind: 'usage', text: WALL, at: Date.now(), midTask: false, model: 'claude-haiku-5-5' })
  expect(await until(() => wallPushes(sent).length === 1)).toBe(true)
  expect(wallPushes(sent)[0]).toContain('主線現在不能用模型')
  await L.routeEvent(ev('mesh-w2'))
  expect(await until(() => L.wallActive())).toBe(true)
  await sleep(100)
  expect(wallPushes(sent).length).toBe(1)
  expect(rows().some(x => x.refs?.tier_rule === 'wall-up+deduped-main-wall')).toBe(true)
})

test('D12: with lanes on, the TUI relay of a wall line defers to the lanes wall notice; other TUI warnings and ops alerts are still sent', async () => {
  const SA = await import('./system-alert.ts?d12') as typeof import('./system-alert.ts')
  const { L } = await instance('c')
  const got: string[] = []
  SA.startSystemAlertWatcher({ notify: t => got.push(t), log: () => {}, defer: (m: string) => L.wallKind(m) != null })
  SA.relayTuiAlert(WALL, 'jsonl session x')
  SA.relayTuiAlert('API Error: 529 overloaded', 'otel:api_error')
  expect(got.length).toBe(0)
  SA.relayTuiAlert('Refusal (Usage Policy): (no text)', 'jsonl session x')
  SA.sendOpsAlert(`有訊息停放超過 20 分鐘未送達：${WALL}`, 'park-watchdog')
  expect(got.length).toBe(2)
})
