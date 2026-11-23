// lanes-topics item 2: ONE function decides the topic of an outgoing Telegram message (lanes.ts targetTopic): an explicit topic wins; else the topic of
// the message it answers (reply_to) when the daemon knows it (Joey's messages as they come in, the bot's own as they go out: state.json, and Joey's in
// the journal too, so it survives a restart); else, for the main's reply, the one topic every Telegram item of its turn is in; else no topic.
// Measured 11-23: a message is inside a topic only when it carries message_thread_id (reply_parameters alone lands outside).
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?topics-target') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-topics-target-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
const deps = { role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async () => 1, joeyChatId: () => '1' } as any
L.lanesInit(deps)
L.__setClaudeBin(join(import.meta.dir, 'test-fixtures', 'no-claude.sh'))
const procs: any[] = []
afterAll(() => { for (const p of procs) try { p.kill('SIGKILL') } catch {}; delete process.env.LANES_FLOOD_CONTROL })

/** Joey's message `mid` (chat 1), in `topic` or outside topics, as server.ts hands it to the router */
async function joey(mid: number, text: string, topic?: number) {
  const meta: Record<string, string> = { chat_id: '1', message_id: String(mid), user: 'joey', ...(topic ? { topic: String(topic) } : {}) }
  return L.routeEvent({ id: `tg-1-${mid}`, source: 'telegram', from: 'joey', text, meta, verified: true, ...(topic ? { message_thread_id: String(topic) } : {}),
    notif: { method: 'notifications/claude/channel', params: { content: text, meta } } } as any)
}
const itemsOf = (mids: number[]) => L.__main().items(r => r.kind !== 'digest' && mids.map(m => `tg-1-${m}`).includes(String(r.event))).map(r => r.id)
/** a main turn whose bound items are Joey's messages `mids` */
async function turn(prompt: string, mids: number[], f: () => void | Promise<void>) {
  const proc = Bun.spawn(['sleep', '600']); procs.push(proc)
  const sid = `00000000-0000-4000-8000-${String(proc.pid).padStart(12, '0')}`
  writeFileSync(join(dir, 'main-expected'), sid)
  await L.__mainEvent({ event: 'SessionStart', pid: proc.pid, session_id: sid })
  await L.__mainEvent({ event: 'UserPromptSubmit', pid: proc.pid, prompt_id: prompt, dids: itemsOf(mids) })
  try { await f() } finally {
    await L.__mainEvent({ event: 'Stop', pid: proc.pid, prompt_id: prompt, phase: 'final' }); await L.__mainEvent({ event: 'SessionEnd', pid: proc.pid }); proc.kill('SIGKILL')
  }
}

test('Joey\'s messages are recorded where they were typed; reply_to one of them: its topic, or no topic for one typed outside topics', async () => {
  expect((await joey(100, '這件事做到哪？', 7001)).target).toBe('main')
  await joey(102, '平常講話')
  expect(L.knownTopic('1', '100')).toBe(7001)
  expect(L.knownTopic('1', '102')).toBeNull()
  expect(L.knownTopic('1', '999')).toBeUndefined()
  expect(L.targetTopic({ chat: '1', replyTo: '100' })).toBe(7001)
  expect(L.targetTopic({ chat: '1', replyTo: 100 })).toBe(7001)
  expect(L.targetTopic({ chat: '1', replyTo: '102' })).toBeUndefined()
  expect(L.targetTopic({ chat: '1', replyTo: '999' })).toBeUndefined()
  expect(L.targetTopic({ chat: '2', replyTo: '100' })).toBeUndefined()               // message ids are per chat
})

test('an explicit topic wins over everything; "0" is explicitly outside topics; a #-prefixed id is read; garbage is ignored', () => {
  expect(L.targetTopic({ chat: '1', topic: '7005', replyTo: '100', turn: true })).toBe(7005)
  expect(L.targetTopic({ chat: '1', topic: '#7005' })).toBe(7005)
  expect(L.targetTopic({ chat: '1', topic: 7005 })).toBe(7005)
  expect(L.targetTopic({ chat: '1', topic: '0', replyTo: '100' })).toBeUndefined()
  expect(L.targetTopic({ chat: '1', topic: 'abc', replyTo: '100' })).toBe(7001)
})

test('the bot\'s own messages: what was sent into a topic is found by its id (a reply to the bot\'s message goes where that message is)', () => {
  L.noteSent('1', [5001, 5002], 7002)
  L.noteSent('1', [5003], null)
  expect(L.targetTopic({ chat: '1', replyTo: '5001' })).toBe(7002)
  expect(L.targetTopic({ chat: '1', replyTo: '5003' })).toBeUndefined()
  expect(L.knownTopic('1', '5003')).toBeNull()
})

test('the main\'s reply with no reply_to: the one topic all Telegram items of its turn are in; mixed or none: no topic; reply_to still decides first', async () => {
  await joey(110, 'A', 7001); await joey(111, 'B', 7001)
  await turn('p-same', [110, 111], () => {
    expect(L.targetTopic({ chat: '1', turn: true })).toBe(7001)
    expect(L.targetTopic({ chat: '1' })).toBeUndefined()                               // not the main's reply: no turn rule
    expect(L.targetTopic({ chat: '1', turn: true, replyTo: '102' })).toBeUndefined()   // it quotes a message outside topics
    expect(L.targetTopic({ chat: '1', turn: true, replyTo: '5001' })).toBe(7002)
    expect(L.targetTopic({ chat: '1', turn: true, replyTo: '999' })).toBe(7001)        // an unknown quote: the turn
  })
  await joey(120, 'C', 7001); await joey(121, 'D')
  await turn('p-mixed', [120, 121], () => expect(L.targetTopic({ chat: '1', turn: true })).toBeUndefined())
  await joey(130, 'E', 7001); await joey(131, 'F', 7003)
  await turn('p-two', [130, 131], () => expect(L.targetTopic({ chat: '1', turn: true })).toBeUndefined())
  await joey(140, 'G')
  await turn('p-out', [140], () => expect(L.targetTopic({ chat: '1', turn: true })).toBeUndefined())
}, 30000)

test('topic names: kept as learned; the hand-over and the lane event name the topic', () => {
  L.noteTopicName(7001, '工作：示範')
  expect(L.topicName(7001)).toBe('工作：示範'); expect(L.topicName('7001')).toBe('工作：示範'); expect(L.topicName(7999)).toBeUndefined()
  L.noteTopicName(7001, '  工作：示範  改名 ')
  expect(L.topicName(7001)).toBe('工作：示範 改名')
})

test('a daemon restart keeps it: the next daemon reads state.json; without state.json\'s map, Joey\'s messages are still found in the journal', async () => {
  const L2 = await import('./lanes.ts?topics-target-2') as typeof import('./lanes.ts')
  L2.lanesInit(deps)
  expect(L2.targetTopic({ chat: '1', replyTo: '100' })).toBe(7001)
  expect(L2.targetTopic({ chat: '1', replyTo: '5001' })).toBe(7002)
  expect(L2.knownTopic('1', '102')).toBeNull()
  expect(L2.topicName(7001)).toBe('工作：示範 改名')
  const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')); delete st.msg_topics; writeFileSync(join(dir, 'state.json'), JSON.stringify(st))
  const L3 = await import('./lanes.ts?topics-target-3') as typeof import('./lanes.ts')
  L3.lanesInit(deps)
  expect(L3.targetTopic({ chat: '1', replyTo: '100' })).toBe(7001)                    // the journal: the event's tg.topic
  expect(L3.knownTopic('1', '102')).toBeNull()
  expect(L3.knownTopic('1', '5001')).toBeUndefined()                                  // the bot's own sends were only in state.json
})
