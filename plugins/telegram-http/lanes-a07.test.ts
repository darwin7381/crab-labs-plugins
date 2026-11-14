// Universe 002k: /lanes (list, close, master switch) and the notify profile. No network, no lane process.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?a07-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-a07-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const sent: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'],
  sendBot: async (_c: string, text: string) => { sent.push(text); return 7000 + sent.length }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const rows = (n: string): any[] => { try { return readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const st = L.__lanesState()
st.lanes['adam.worker.1'] = { id: 'adam.worker.1', kind: 'worker', n: 1, session_id: 's1', thread: 'adam#t-w1', status: 'idle', created: '', last: new Date().toISOString(), transcript: '/x', runs: 2, tokens_in: 41000, tokens_out: 900, title: 'WO-27 補 mock-tickets 分類', topic: 55 } as any
st.lanes['adam.reflex.3'] = { id: 'adam.reflex.3', kind: 'reflex', n: 3, session_id: 's3', thread: 'adam#t-r3', status: 'idle', created: '', last: new Date().toISOString(), transcript: '/x', runs: 1, tokens_in: 19000, tokens_out: 300 } as any
st.topics['55'] = 'adam.worker.1'; st.tickets['WO-27'] = 'adam.worker.1'
const ev = (id: string, from: string, text: string) => ({ id, source: 'mesh', from, verified: true, text, meta: {}, notif: { method: '', params: {} } } as any)

test('/lanes lists every open lane with kind, id, title, who opened it, status, runs and tokens', async () => {
  const out = await L.lanesCommand('/lanes', 'joey_lab')
  expect(out).toContain('總開關：開')
  expect(out).toContain('worker'); expect(out).toContain('adam.worker.1'); expect(out).toContain('WO-27'); expect(out).toContain('41k token')
  expect(out).toContain('reflex'); expect(out).toContain('adam.reflex.3')
})

test('/lanes close by WO number: the lane is closed, its topic and ticket unbound, the ledger says what it last did, the main is told', async () => {
  const out = await L.lanesCommand('/lanes close WO-27', 'joey_lab')
  expect(out).toContain('已關閉'); expect(st.lanes['adam.worker.1'].status).toBe('closed')
  expect(st.topics['55']).toBeUndefined(); expect(st.tickets['WO-27']).toBeUndefined()
  expect(rows('lanes.jsonl').some(r => r.kind === 'closed' && r.lane === 'adam.worker.1')).toBe(true)
  const led = rows('ledger.jsonl').find(r => r.refs?.closed === 'adam.worker.1')
  expect(led.notify_main).toBe(true); expect(led.text).toContain('WO-27')
  expect(await L.lanesCommand('/lanes close 工作線#1', 'joey_lab')).toContain('已經關了')
  expect(await L.lanesCommand('/lanes close nope', 'joey_lab')).toContain('找不到')
})

test('/lanes off: every event goes to the main and no lane starts; /lanes on restores the rules', async () => {
  expect(await L.lanesCommand('/lanes off', 'joey_lab')).toContain('已關閉')
  const d1 = await L.routeEvent(ev('m-1', 'alert-dispatcher', '[P2][warning] mock-api p95 2.2s'))
  expect(d1).toMatchObject({ rule: 'master-off', target: 'main' })
  const d2 = await L.routeEvent(ev('m-2', 'eve', 'mock-api 今天會維護嗎？'))
  expect(d2.target).toBe('main')
  expect(rows('routing.jsonl').filter(r => r.rule === 'master-off' && r.target === 'main').length).toBe(2)   // the two events (the switch itself is logged with target none)
  expect(await L.lanesCommand('/lanes', 'joey_lab')).toContain('總開關：關')
  expect(await L.lanesCommand('/lanes on', 'joey_lab')).toContain('已打開')
  const d3 = await L.routeEvent(ev('m-3', 'eve', '另外問一下工單數'))
  expect(d3.target).toBe('lane')
})

test('notify profile: default = every lane message rings; tiered = the router table', async () => {
  expect(L.tierFor('scheduled', false).tier).toBe('silent')
  expect(await L.lanesCommand('/lanes notify default', 'joey_lab')).toContain('照常推播')
  expect(L.tierFor('scheduled', false)).toEqual({ tier: 'push', rule: 'profile.default' })
  expect(L.tierFor('peer', false).tier).toBe('push')
  await L.lanesCommand('/lanes notify tiered', 'joey_lab')
  expect(L.tierFor('scheduled', false).tier).toBe('silent')
  expect(await L.lanesCommand('/lanes notify loud', 'joey_lab')).toContain('用法')
})
