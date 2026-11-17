// Universe 002l (D16, RV4 T1-R #8 E9): the main's report on work a lane handed over goes out at the tier the router gives that event's class (a peer's
// request: silent), not as a push. design/notify 「分級由分流器依訊息類型與車道設定決定，不靠各條線自己判斷要不要吵你」. The lane is a script that waits.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?pl-d16-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-pld16-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.sh'); writeFileSync(bin, '#!/bin/sh\nsleep 2\n'); chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => { L.__setClaudeBin(restore) })
L.__setMeshSend(async () => ({ text: 'sent', msgId: 50011, delivered: true }))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const rows = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
let hid = ''
/** the main takes these M1 items into a turn and the turn ends with Stop (its hook events, as main-hook.py posts them) */
async function mainTakes(ids: string[]): Promise<void> {
  const pid = L.__main().mainPid()!, p = `p-${Math.random().toString(36).slice(2)}`
  await L.__mainEvent({ event: 'UserPromptSubmit', pid, prompt_id: p, dids: ids })
  await L.__mainEvent({ event: 'Stop', pid, prompt_id: p, phase: 'final' })
}

test('D16: a lane hands a peer\'s request to the main; once the main got it, its report (no Joey message since, not quoting one) goes out silent', async () => {
  const d = await L.routeEvent({ id: 'mesh-e9', source: 'mesh', from: 'eve', verified: true, btcc_msg_id: '50008', text: '可以答應我週五前給 10 月可用率嗎？', meta: {}, notif: { method: '', params: {} } } as any)
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  const tok = L.__runTok(d.lane!)!
  expect(L.tierFor(tok.cls, false).tier).toBe('silent')                                   // a peer's matter
  await L.callLaneTool(tok, 'handoff_main', { text: 'Eve 要 10 月可用率，週五前；要主線決定答不答應' })
  const esc = rows().find(r => r.kind === 'escalation')!
  hid = esc.refs.handoff
  expect(esc.text.startsWith(`〔${hid}〕`)).toBe(true); expect(esc.refs.class).toBe(tok.cls)
  expect(L.handoffReplyTier({})).toBeNull()                                               // not delivered yet: nothing to answer
  const item = L.__main().items(r => r.kind === 'handoff' && (r.handoffs ?? []).includes(hid))[0]   // M1: the hand-over is an item for the main
  expect(String(item.notif.params.content)).toContain(hid)                                // the main reads the id
  await mainTakes([item.id])                                                              // its turn ends with Stop: done
  expect(L.handoffReplyTier({})).toMatchObject({ silent: true, handoff: hid })
  expect(L.handoffReplyTier({ reply_to: 1030 })).toBeNull()                               // quoting a message of Joey's: an ordinary answer
  expect(L.handoffReplyTier({ handoff_id: hid })).toMatchObject({ silent: true })
  L.noteMainReplyTier(L.handoffReplyTier({ handoff_id: hid })!, 1015)
  expect(rows().find(r => r.lane === 'main' && r.refs?.message_id === 1015)!.refs.tier).toBe('silent')
  await until(() => !L.__runTok(d.lane!), 4000)
})

test('D16: after a Joey message reaches the main, an unnamed reply is ordinary again; a named one keeps the hand-over\'s tier', async () => {
  await L.routeEvent({ id: 'tg-1020', source: 'telegram', from: 'joey', text: '今天怎樣？', meta: { message_id: '1020', chat_id: '1' }, notif: { method: '', params: {} } } as any)
  expect(L.handoffReplyTier({})).toBeNull()
  expect(L.handoffReplyTier({ handoff_id: `〔${hid}〕` })).toMatchObject({ silent: true })
  expect(L.handoffReplyTier({ handoff_id: 'ho-nope' })).toBeNull()
})

test('D16: the notify profile still rules: with /lanes notify default everything rings, the hand-over report included', async () => {
  await L.lanesCommand('/lanes notify default', 'joey_lab')
  expect(L.handoffReplyTier({ handoff_id: hid })).toMatchObject({ silent: false })
  await L.lanesCommand('/lanes notify tiered', 'joey_lab')
})
