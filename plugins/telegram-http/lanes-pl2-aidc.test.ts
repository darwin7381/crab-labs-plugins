// Universe 002m, model aid (c): no digest in answers to Joey. T3-R #8 (002l r1-r3, M): the lane digest rode on Joey's own message (002b piggyback) and the main
// folded the lanes' machine events into its answer to him. main-role 「主線是被告知，不是被打斷」, merge 「摘要只在主線的回合邊界送」: while Joey's message is the
// turn's trigger the digest is kept; it is handed over when that turn has ended (a turn-end record after it) and the main is idle. No network, no process.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?pl2-aidc-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-pl2-aidc-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const T = join(dir, 'main.jsonl')
writeFileSync(T, '')
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: T, claude_pid: 1, registered_at: new Date().toISOString() }))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'] } as any)
const rec = (o: object) => JSON.stringify(o) + '\n'
const fyi = (n: number) => rec({ ts: new Date().toISOString(), lane: `adam.reflex.${n}`, thread: `adam#t-${n}`, event: 'ev', kind: 'notify', notify_main: true, refs: { tier: 'silent', escalated: false },
  text: `[silent] A-14${n} mock-backup 03:00 備份成功，耗時 4${n}s` })
const joey = (text: string) => ({ id: `tg-${Math.random()}`, source: 'telegram', from: 'joey', text, meta: { message_id: '9' },
  notif: { method: 'notifications/claude/channel', params: { content: text, meta: { chat_id: '1', message_id: '9', user: 'joey' } } }, verified: true }) as any
const alertToMain = (text: string) => ({ id: `mesh-${Math.random()}`, source: 'mesh', from: 'alert-dispatcher', text, meta: {},
  notif: { method: 'notifications/claude/channel', params: { content: text, meta: { user: 'alert-dispatcher' } } }, verified: false }) as any
const turnEnd = () => rec({ type: 'system', subtype: 'turn_duration', timestamp: new Date(Date.now() + 5).toISOString() })
function reset(n: number[]): void {
  writeFileSync(join(dir, 'ledger.jsonl'), n.map(fyi).join(''))
  rmSync(join(dir, 'digest.json'), { force: true }); writeFileSync(T, '')
  delete (L.__lanesState() as any).digest_held_at
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

test('aid (c): Joey\'s message to the main carries no digest; it is kept, and handed over once his turn has ended and the main is idle', async () => {
  reset([1, 2])
  const d = await L.routeEvent(joey('副本現在幾個？'))
  expect(d.target).toBe('main')
  expect(d.digest).toBeUndefined()
  expect((L.notifWithDigest(joey('副本現在幾個？').notif, d) as any).params.content).toBe('副本現在幾個？')     // his question alone
  expect(L.__lanesState().digest_held_at).toBeGreaterThan(0)
  const got: Array<{ content: string; meta: Record<string, string> }> = []
  const io = { mainConnected: async () => true, mainIdle: async () => true, deliver: async (content: string, meta: Record<string, string>) => { got.push({ content, meta }); return true } }
  expect(await L.digestTickWith(io)).toBe('no-wake-entry')                     // his turn has not ended: nothing (and these FYIs never wake)
  expect(got.length).toBe(0)
  await sleep(10); appendFileSync(T, turnEnd())
  expect(await L.digestTickWith({ ...io, mainIdle: async () => false })).toBe('main-busy')
  expect(await L.digestTickWith(io)).toBe('delivered-at-boundary')
  expect(got.length).toBe(1)
  expect(got[0].content).toContain('A-141'); expect(got[0].content).toContain('A-142')
  expect(got[0].meta).toMatchObject({ kind: 'digest', no_reply: 'true' })
  expect(L.__lanesState().digest_held_at).toBeUndefined()
  expect(await L.digestTickWith(io)).toBe('no-wake-entry')                     // once
  expect(readFileSync(join(dir, 'routing.jsonl'), 'utf8')).toContain('"rule":"digest-held"')
})

test('aid (c): nothing pending: nothing is held', async () => {
  reset([])
  await L.routeEvent(joey('在嗎？'))
  expect(L.__lanesState().digest_held_at).toBeUndefined()
})

test('aid (c): a held digest that another delivery to the main carried meanwhile is not sent twice', async () => {
  reset([3])
  await L.routeEvent(joey('今天怎樣？'))
  const other = await L.routeEvent(alertToMain('unsigned: disk 91%'))         // not Joey's: it still carries the digest (002b)
  expect(other.target).toBe('main')
  expect(other.digest?.items).toBe(1)
  await L.ackDigest(other)
  await sleep(10); appendFileSync(T, turnEnd())
  expect(await L.digestTickWith({ mainConnected: async () => true, mainIdle: async () => true, deliver: async () => true })).toBe('held-nothing-left')
})

test('aid (c): LANES_JOEY_DIGEST_HOLD=0 brings back the 002b piggyback on Joey\'s message', async () => {
  reset([4])
  process.env.LANES_JOEY_DIGEST_HOLD = '0'
  const d = await L.routeEvent(joey('報告？'))
  delete process.env.LANES_JOEY_DIGEST_HOLD
  expect(d.digest?.items).toBe(1)
})
