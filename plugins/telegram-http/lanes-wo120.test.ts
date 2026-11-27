// WO-120 × lanes (1.34.1): with a fresh usage-wall state, the usage-wall alerts (system-alert WallAlerts) are the one sender of the main's wall
// pushes. lanes' main-wall-up / main-wall-down then go to the lanes ledger only (LanesDeps.wallNoticeOwned); without it, or when it says no, they
// are pushed as before. The wall records (M2) are not touched. mainHeldCount: what M1 holds for the main (the enter alert's count).
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
const L = await import('./lanes.ts?wo120-test') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-wo120-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
const open = new Set<string>(), sent: string[] = [], asked: Array<{ rule: string; kind: string | null }> = []
let owned = true
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  notifySession: async (sid: string) => open.has(sid), streamOpen: (sid: string) => open.has(sid),
  sendBot: async (_c: string, text: string) => { sent.push(text); return 300 + sent.length }, joeyChatId: () => '1',
  wallNoticeOwned: (rule: string, m: { kind: string | null }) => { asked.push({ rule, kind: m.kind }); return owned } } as any)
L.__setWallProbe(3_600_000)
const procs: any[] = []
afterAll(() => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } L.__setWallProbe(300_000) })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const M = () => L.__main()
const ledger = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
let nj = 0, np = 0
async function startMain() {
  const p = Bun.spawn(['sleep', '600']); procs.push(p)
  const sid = randomUUID(), g = { pid: p.pid, sid, proc: p, mcp: `mcp-${p.pid}` }
  writeFileSync(join(dir, 'main-expected'), sid)
  open.add(g.mcp); L.__noteMcpPid(g.mcp, g.pid)
  await L.__mainEvent({ event: 'SessionStart', pid: g.pid, session_id: sid, source: 'startup' })
  await M().pump()
  return g
}
const hook = (g: { pid: number; sid: string }, event: string, o: object = {}) => L.__mainEvent({ event, pid: g.pid, session_id: g.sid, ...o })
async function joey(text: string): Promise<string> {
  const id = ++nj + 700, meta = { chat_id: '1', message_id: String(id), user: 'joey_lab' }
  await L.routeEvent({ id: `tg-1-${id}`, source: 'telegram', from: 'joey', text, meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: text, meta } } } as any)
  await M().pump()
  return M().items(r => r.event === `tg-1-${id}`)[0].id
}

test('owned: the main\'s usage wall goes up and down with no lanes push; both notices are on the ledger (+usage-wall); M1 still holds the message', async () => {
  const g = await startMain()
  const k = sent.length
  const id = await joey('週報好了嗎')
  const p = `wo-${++np}`
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  await hook(g, 'StopFailure', { prompt_id: p, error: 'rate_limit', reason: "You've hit your weekly limit" })
  expect(M().mainPhase()).toBe('walled')
  expect(M().items(r => r.id === id)[0].state).toBe('queued')            // the record and the hold are lanes' own, unchanged
  expect(L.mainHeldCount()).toBe(1)
  const id2 = await joey('還有一件')
  expect(L.mainHeldCount()).toBe(2)
  expect(asked[asked.length - 1]).toEqual({ rule: 'main-wall-up', kind: 'rate_limit' })
  const p2 = `wo-${++np}`
  await hook(g, 'UserPromptSubmit', { prompt_id: p2, dids: [id, id2] }); await hook(g, 'Stop', { prompt_id: p2, phase: 'final' })
  await sleep(20)
  expect(M().mainPhase()).toBe('idle')
  expect(asked[asked.length - 1].rule).toBe('main-wall-down')
  expect(sent.slice(k).filter(s => s.includes('主線模型額度') || s.includes('主線恢復')).length).toBe(0)
  expect(ledger().filter(r => String(r.refs?.tier_rule ?? '').endsWith('+usage-wall')).map(r => r.refs.tier_rule))
    .toEqual(['main-wall-up+usage-wall', 'main-wall-down+usage-wall'])
  expect(L.mainHeldCount()).toBe(0)
  g.proc.kill('SIGKILL'); await g.proc.exited; open.delete(g.mcp); await M().tick()
})

test('not owned (no fresh state, or a kind usage_wall.py does not record): pushed as before', async () => {
  owned = false
  const g = await startMain()
  const k = sent.length
  const id = await joey('今天的報告呢？')
  const p = `wo-${++np}`
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  await hook(g, 'StopFailure', { prompt_id: p, error: 'authentication_failed', reason: 'Please run /login' })
  const p2 = `wo-${++np}`
  await hook(g, 'UserPromptSubmit', { prompt_id: p2, dids: [id] }); await hook(g, 'Stop', { prompt_id: p2, phase: 'final' })
  await sleep(20)
  expect(asked.slice(-2)).toEqual([{ rule: 'main-wall-up', kind: 'authentication_failed' }, { rule: 'main-wall-down', kind: null }])
  expect(sent.slice(k).filter(s => s.includes('主線模型登入失效')).length).toBe(1)
  expect(sent.slice(k).filter(s => s.includes('主線恢復了')).length).toBe(1)
  g.proc.kill('SIGKILL'); await g.proc.exited; open.delete(g.mcp); await M().tick()
  owned = true
})
