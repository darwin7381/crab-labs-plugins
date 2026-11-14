// Universe 002k: /main renew — the main role is handed to a fresh session. No network, no model; the "old main" is a sleeping child.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
const L = await import('./lanes.ts?i04-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-i04-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const T = join(dir, 'old.jsonl')
const old = spawn('sleep', ['60'])
afterAll(() => { try { old.kill('SIGKILL') } catch {} })
writeFileSync(T, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { model: 'claude-haiku-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 512000, cache_creation_input_tokens: 3000 }, content: [{ type: 'text', text: 'ok' }] } }) + '\n')
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: T, claude_pid: old.pid, registered_at: new Date().toISOString() }))
writeFileSync(join(dir, 'focus.md'), '進行中：mock-api 快取方案 A（TTL 60s）。別碰：mock-tickets 佇列。')
const sent: string[] = [], delivered: Array<{ content: string; meta: any }> = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'], repersistUnconsumed: () => 2,
  sendBot: async (_c: string, text: string) => { sent.push(text); return 9000 + sent.length }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
L.__setDigestIO({ mainConnected: async () => true, deliver: async (content: string, meta: any) => { delivered.push({ content, meta }); return true } })
// what the old main left on disk: a promise to Eve and work handed over
writeFileSync(join(dir, 'ledger.jsonl'), [
  { ts: new Date().toISOString(), lane: 'adam.reflex.2', kind: 'commitment', text: '答應 eve：保留舊 /drafts 參數到月底（時限：月底前）', notify_main: true },
  { ts: new Date().toISOString(), lane: 'adam.reflex.3', kind: 'escalation', text: 'mock-backup 失敗一次，待主線決定要不要重跑', notify_main: true },
].map(r => JSON.stringify(r)).join('\n') + '\n')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }

test('/main renew: the new session id is marked for the keeper, the old process is stopped, Joey is told it is under way', async () => {
  const out = await L.mainRenew('joey_lab')
  expect(out).toContain('主線換新中'); expect(out).toContain('515k token')
  const st = L.__lanesState()
  expect(st.renew!.old_sid).toBe('a20fb7c0-f35a-4365-9a21-9e16e9f78fed')
  expect(readFileSync(join(dir, 'run', 'renew'), 'utf8').trim()).toBe(st.renew!.new_sid)
  expect(await until(() => old.exitCode !== null || old.signalCode !== null)).toBe(true)
  expect(await L.mainRenew('joey_lab')).toContain('目前沒有登記中、活著的主線')         // the old one is gone; nothing to hand over twice
})

test('when the fresh session registers: its first message is the hand-over brief from disk, the lifecycle record says main handover, Joey is told', async () => {
  const st = L.__lanesState()
  const sid = st.renew!.new_sid
  writeFileSync(join(dir, 'main-expected'), sid)
  const req: any = { socket: { remotePort: 0 } }
  const self = spawn('sleep', ['30'])
  ;(L as any).__setCallerPid?.(self.pid)
  const r = (L as any).__registerMainForTest ? (L as any).__registerMainForTest(sid, join(dir, 'new.jsonl'), self.pid) : null
  expect(r?.accepted).toBe(true)
  expect(await until(() => delivered.length === 1)).toBe(true)
  const b = delivered[0]
  expect(b.meta.kind).toBe('handover')
  expect(b.content).toContain('第 2 代'); expect(b.content).toContain('快取方案 A'); expect(b.content).toContain('eve'); expect(b.content).toContain('月底')
  expect(b.content).toContain('mock-backup')
  expect(await until(() => sent.some(t => t.includes('主線換新了')))).toBe(true)
  const lc = readFileSync(join(dir, 'lanes.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  expect(lc.filter(x => x.note === 'main handover').length).toBe(1)
  expect(st.renew).toBeUndefined(); expect(existsSync(join(dir, 'run', 'renew'))).toBe(false)
  self.kill('SIGKILL')
})
