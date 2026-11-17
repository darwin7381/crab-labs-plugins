// Universe 002k (E4): a lane's notice to Joey in a run started by a Joey message is sent as a Telegram reply to that message. No network, no model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?e4-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-e4-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
// a lane process that answers with reply_agent + receipt only: the daemon's never-silent line is what reaches Joey
const bin = join(dir, 'lane.sh')
writeFileSync(bin, `#!/bin/sh\necho '{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","name":"mcp__lane__reply_agent","input":{"to":"eve","text":"今天不維護。"}},{"type":"tool_use","name":"mcp__lane__receipt","input":{"outcome":"done","did":"回覆 eve"}}],"usage":{}}}'\necho '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'\n`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => L.__setClaudeBin(restore))
const sent: Array<{ text: string; silent: boolean; replyTo?: number; topic?: number }> = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async (_c: string, text: string, o: any) => { sent.push({ text, silent: !!o?.silent, replyTo: o?.replyTo, topic: o?.topic }); return 9900 + sent.length }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const st = L.__lanesState()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(30) } return f() }
let n = 0
function run(ev: object, trigger = 'joey', topic?: number): any {
  n += 1
  const id = `adam.worker.${n}`, evId = (ev as any).id ?? `ev-e4-${n}`
  st.lanes[id] = { id, kind: 'worker', n, session_id: 's', thread: `adam#t-e4${n}`, status: 'running', created: '', last: '', transcript: '/x', runs: 0, tokens_in: 0, tokens_out: 0, ...(topic ? { topic } : {}) } as any
  st.threads[`adam#t-e4${n}`] = { id: `adam#t-e4${n}`, lane: id, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
  L.__putQueue({ ev: { id: evId, text: 'x', meta: {}, notif: { method: '', params: {} }, ...ev }, lane: id, state: 'leased', lease_until: 0, attempts: 1, priority: 1, enqueued: '' })
  return { runId: `${id}.r1`, lane: id, evId, closers: [], critical: false, trigger, cls: trigger, escalated: false, pushed: false }
}
const TG = (mid: string, extra: object = {}) => ({ source: 'telegram', from: 'joey', meta: { message_id: mid, chat_id: '1' }, ...extra })

test('E4: notify_joey in a run started by Joey\'s Telegram message is a reply to that message; so is ask_joey', async () => {
  const tok = run(TG('1234'))
  expect(await L.callLaneTool(tok, 'notify_joey', { text: '請求 id：req-1、req-2。' })).toContain('sent to Joey')
  expect(sent.at(-1)).toMatchObject({ replyTo: 1234 }); expect(sent.at(-1)!.text).toContain('req-1')
  const t2 = run(TG('1300'))
  expect(await L.callLaneTool(t2, 'ask_joey', { text: '要不要重啟？' })).toContain('sent to Joey')
  expect(sent.at(-1)).toMatchObject({ replyTo: 1300, silent: false })
})

test('E4: a worker\'s topic and the reply go together', async () => {
  const tok = run(TG('1400'), 'joey', 555)
  await L.callLaneTool(tok, 'notify_joey', { text: '收到，我來查。' })
  expect(sent.at(-1)).toMatchObject({ replyTo: 1400, topic: 555 })
})

test('E4: no reply_to for a run that Joey\'s message did not start: a peer, an alert, a follow-up, a Telegram event without a usable id, another chat', async () => {
  const cases: Array<[string, object, string]> = [
    ['peer', { source: 'mesh', from: 'eve', meta: { message_id: '777' } }, 'peer'],                      // a mesh event never has a Telegram message id, whatever its meta says
    ['alert', { source: 'mesh', from: 'alert-dispatcher', meta: {} }, 'alert'],
    ['follow-up', { id: 'ev-fu-abc123', source: 'mesh', from: 'joey', meta: {}, synthetic: '[車道事件｜後續檢查]' }, 'joey'],
    ['no id', { source: 'telegram', from: 'joey', meta: {} }, 'joey'],
    ['bad id', { source: 'telegram', from: 'joey', meta: { message_id: 'abc', chat_id: '1' } }, 'joey'],
    ['other chat', { source: 'telegram', from: 'joey', meta: { message_id: '1500', chat_id: '-100999' } }, 'joey'],
  ]
  for (const [name, ev, trig] of cases) {
    const tok = run(ev, trig)
    await L.callLaneTool(tok, 'notify_joey', { text: `通知 ${name}` })
    expect({ name, replyTo: sent.at(-1)!.replyTo }).toEqual({ name, replyTo: undefined })
  }
})
