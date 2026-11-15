// Universe 002l (D5, RV1 C08 #2): a Joey message handed into a running run (E18 steering) makes that run's reply_agent to the peer an owner-relay commitment.
// design/identity rule 5 「承諾必入帳」. The lane process is a script that only waits; the steer hook's hand-over is written by the test.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, appendFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?d5-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-d5-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.sh'); writeFileSync(bin, '#!/bin/sh\nsleep 4\n'); chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => { L.__setClaudeBin(restore) })
const mesh: any[] = []
L.__setMeshSend(async b => { mesh.push(b); return { text: 'sent', msgId: 60000 + mesh.length, delivered: true } })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const st = L.__lanesState()
const rows = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }

test('D5: a run started by a peer gets Joey\'s message by steering; its relay to the peer is recorded as an owner-relay commitment', async () => {
  const d = await L.routeEvent({ id: 'mesh-c8', source: 'mesh', from: 'eve', verified: true, btcc_msg_id: '50020', text: 'WO-27 什麼時候能交？', meta: {}, notif: { method: '', params: {} } } as any)
  expect(d.target).toBe('lane')
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  st.botmsgs['1030'] = d.lane!
  const j = await L.routeEvent({ id: 'tg-1033', source: 'telegram', from: 'joey', text: '跟 Eve 說週五交', meta: { message_id: '1033', chat_id: '1' }, notif: { method: '', params: {} }, reply_to_message_id: '1030' } as any)
  expect(j.note).toContain('steering')
  const tok = L.__runTok(d.lane!)!
  expect(tok.trigger).not.toBe('joey')                                                  // the run itself was Eve's
  mkdirSync(join(dir, 'run', 'steer'), { recursive: true })
  appendFileSync(join(dir, 'run', 'steer', `${d.lane}.out.jsonl`), JSON.stringify({ id: 'tg-1033', at: Date.now(), event: 'PostToolUse', tool: 'Bash' }) + '\n')   // the hook handed it over
  const out = await L.callLaneTool(tok, 'reply_agent', { to: 'eve', text: 'Joey 說 WO-27 週五交給你。', reply_to: '50020' })
  expect(out).toBe('sent')
  const c = rows().find(r => r.kind === 'commitment' && r.lane === d.lane)!
  expect(c).toBeTruthy(); expect(c.refs).toMatchObject({ from: 'owner-relay', auto: true, who: 'eve' })
})

test('D5: without a steered Joey message the same relay is no owner-relay commitment', async () => {
  const d = await L.routeEvent({ id: 'mesh-c9', source: 'mesh', from: 'eve', verified: true, btcc_msg_id: '50030', text: '順便問 WO-28？', meta: {}, notif: { method: '', params: {} } } as any)
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  await L.callLaneTool(L.__runTok(d.lane!)!, 'reply_agent', { to: 'eve', text: 'WO-28 還在排隊。', reply_to: '50030' })
  expect(rows().some(r => r.kind === 'commitment' && r.lane === d.lane)).toBe(false)
  await until(() => !Object.keys(st.lanes).some(id => L.__runTok(id)), 8000)            // no lane process outlives the file
}, 12000)
