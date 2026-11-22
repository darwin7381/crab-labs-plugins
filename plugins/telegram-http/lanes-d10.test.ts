// Universe 002l (D10, RV3 G08 #3): a no_reply notice never touches the flood or rate state. design/routing 「標了『不用回』的純通知 → 帳本：只記一行，不開任何
// session。零 token」. The lane process is a script; no network, no model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?d10-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-d10-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, time
time.sleep(1.5)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
process.env.LANES_PEER_NEW_PER_MIN = '5'
afterAll(() => { L.__setClaudeBin(restore); delete process.env.LANES_PEER_NEW_PER_MIN })
const sent: string[] = [], mesh: any[] = []
L.__setMeshSend(async b => { mesh.push(b); return { text: 'sent', msgId: 91000 + mesh.length, delivered: true } })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'],
  sendBot: async (_c: string, text: string) => { sent.push(text); return 9700 + sent.length }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const st = L.__lanesState()
const rows = (n: string): any[] => { try { return readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(25) } return f() }
const ev = (id: string, from: string, text: string, extra: object = {}) => ({ id, source: 'mesh', from, verified: true, text, meta: {}, notif: { method: '', params: {} }, ...extra } as any)

test('D10: 40 no_reply FYIs from one peer: 40 ledger lines, no lane, no flood episode, the rate bucket untouched, nothing to Joey, nothing back to the peer', async () => {
  const ds = await Promise.all(Array.from({ length: 40 }, (_, i) => L.routeEvent(ev(`mesh-fyi-${i + 1}`, 'eve', `FYI：mock-api 部署進度 ${i + 1}/40`, { no_reply: true }))))
  expect(ds.every(d => d.target === 'ledger' && d.rule === 'mesh-no-reply')).toBe(true)
  expect(rows('ledger.jsonl').filter(r => r.kind === 'fyi' && String(r.event).startsWith('mesh-fyi-')).length).toBe(40)
  expect(st.flood?.eve?.episode).toBeUndefined()
  expect(st.flood?.eve?.bucket ?? 5).toBe(5)                                   // never charged (or never created)
  expect(rows('ledger.jsonl').some(r => r.refs?.flag === 'peer-flood')).toBe(false)
  expect(sent.length).toBe(0); expect(mesh.length).toBe(0)
  expect(rows('lanes.jsonl').filter(r => r.kind === 'spawn').length).toBe(0)
})

test('D10: after the FYIs the peer\'s ordinary new conversations get lanes as if the FYIs had not come (5 a minute)', async () => {
  const ds = []
  for (let i = 1; i <= 5; i++) ds.push(await L.routeEvent(ev(`mesh-q-${i}`, 'eve', `問題 ${i}：WO-${100 + i} 排第幾？`)))
  expect(ds.every(d => d.target === 'lane')).toBe(true)
  const sixth = await L.routeEvent(ev('mesh-q-6', 'eve', '問題 6'))
  expect(sixth.rule).toBe('peer-flood')                                        // the rate limit itself still works
  await until(() => rows('lanes.jsonl').filter(r => r.kind === 'exit').length >= 5, 12000)
}, 20000)

test('D10: the flood episode\'s "answered" counts the events that opened a lane, not FYIs or other admits', async () => {
  // the episode started at mesh-q-6 with the 5 lanes of this minute; an FYI during the episode is neither answered nor merged
  await L.routeEvent(ev('mesh-fyi-x', 'eve', 'FYI：還在部署', { no_reply: true }))
  expect(st.flood!.eve.episode!.answered).toBe(5)
  expect(st.flood!.eve.episode!.count).toBe(1)
  L.floodTick(Date.now() + 10 * 60_000)
  const sum = rows('ledger.jsonl').find(r => r.refs?.peer_flood === 'eve')!
  expect(sum.refs).toMatchObject({ count: 1, answered: 5, ledger_only: 1 })
})
