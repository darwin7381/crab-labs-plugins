// WO-192 point 5 (Chiron 11:10Z): the router's notice to Joey that answers events (tellJoey with events, e.g. asked-restart) counts as said once it is
// written into Onsen, even while Telegram has not taken it (ONSEN_FIRST: sendBot throws heldInOnsen), as a lane's line does (sendLine). Telegram took
// it: met with its id, as before. Neither: still owed.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const AGENT = 'wo192r'
const inboxSrv = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch() { return Response.json({ ok: true, offered: true }) } })
process.env.LANES_INBOX_PORT = String(inboxSrv.port)
const L = await import('./lanes.ts?wo192-router') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-wo192r-'))
process.env.LANES_DIR = dir
writeFileSync(join(dir, 'router.json'), readFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), 'utf8'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'b31fbc70-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
let mode: 'ok' | 'held' | 'fail' = 'ok'
L.lanesInit({ role: 'tg', agent: AGENT, workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, notifySession: async () => true, streamOpen: () => true,
  registryNames: () => ['chiron'], joeyChatId: () => '1828', mainStatus: () => ({ state: 'idle', detail: {} }),
  sendBot: async () => {
    if (mode === 'held') throw Object.assign(new Error('已寫進 Onsen（網頁看得到）；Telegram 還沒送到：timeout，會再送'), { heldInOnsen: true })
    if (mode === 'fail') throw new Error('Telegram down')
    return 777
  } } as any)
afterAll(() => { inboxSrv.stop(true); delete process.env.LANES_INBOX_PORT })
const ev = (id: string) => { L.__events().open(id, { class: 'joey', owner: 'main', from: 'joey', text: 'x', obligations: [{ kind: 'joey', level: 'line', state: 'handed' }] }); return id }
const joeyOb = (id: string) => ((L.__events().get(id)?.obligations ?? []) as any[]).find(o => o.kind === 'joey')
const settle = () => new Promise(r => setTimeout(r, 50))

test('a router notice held in Onsen answers its events (ref onsen); Telegram taking it: its id; neither: still owed', async () => {
  mode = 'held'; const a = ev('ev-held')
  L.__tellJoey('主線被指令重啟…', 'asked-restart', [a]); await settle()
  expect(joeyOb(a)).toMatchObject({ state: 'met', ref: 'onsen' })
  mode = 'ok'; const b = ev('ev-ok')
  L.__tellJoey('主線被指令重啟…', 'asked-restart', [b]); await settle()
  expect(joeyOb(b)).toMatchObject({ state: 'met', ref: '777' })
  mode = 'fail'; const c = ev('ev-fail')
  L.__tellJoey('主線被指令重啟…', 'asked-restart', [c]); await settle()
  expect(joeyOb(c).state).not.toBe('met')
})
