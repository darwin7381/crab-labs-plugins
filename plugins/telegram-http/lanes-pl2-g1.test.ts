// Universe 002m (L6G1 + L6T1, RV6 §3): a delivery to the main survives the main's replacement until a live main has read it. Consumed = taken in AND a
// turn ended after that; a cut turn's own tool calls are not consumption. design/stability SR2 「訊息掉了沒人處理（沿用現有的磁碟佇列與重送）」.
// Transcript shapes as this Claude Code writes them. No network, no process.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?pl2-g1-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-pl2-g1-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const T = join(dir, 'main.jsonl')
writeFileSync(T, '')
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: T, claude_pid: 1, registered_at: new Date().toISOString() }))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => [],
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
const rec = (o: object) => JSON.stringify(o) + '\n'
const T0 = Date.parse('2026-11-15T02:00:00.000Z'), at = (s: number) => new Date(T0 + s * 1000).toISOString()
const tg = (id: number, text: string) => `<channel source="plugin:telegram-http:telegram-http" chat_id="1" message_id="${id}" user="joey_lab" ts="${at(0)}">\n${text}\n</channel>`
const n = (id: number) => ({ method: 'notifications/claude/channel', params: { content: 'x', meta: { chat_id: '1', message_id: String(id), user: 'joey_lab' } } }) as any
const take = (s: number, id: number, text: string) => rec({ type: 'user', isMeta: true, timestamp: at(s), message: { role: 'user', content: tg(id, text) } })
const toolCall = (s: number) => rec({ type: 'assistant', timestamp: at(s), message: { model: 'claude-haiku-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } })
const toolResult = (s: number) => rec({ type: 'user', timestamp: at(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } })
const endTurn = (s: number) => rec({ type: 'assistant', timestamp: at(s), message: { model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '好了' }] } })
const turnDur = (s: number) => rec({ type: 'system', subtype: 'turn_duration', timestamp: at(s) })
const noResp = (s: number) => rec({ type: 'assistant', timestamp: at(s), message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'No response requested.' }] } })

test('L6T1: a message the main took in and was working on (a tool call, then the kill) is not consumed; it is parked again and its record closed', () => {
  writeFileSync(T, take(10, 1004, 'C4：把報表做完') + toolCall(11))
  expect(L.deliveryFate(n(1004), T0 + 9_000)).toEqual({ fate: 'working', takenAt: T0 + 10_000 })
  expect(L.replacementAction(n(1004), T0 + 9_000, T0 + 11_000)).toBe('park-close')
  // the replaced process resumes: "No response requested." is no turn end
  writeFileSync(T, readFileSync(T, 'utf8') + noResp(20))
  expect(L.deliveryFate(n(1004), T0 + 9_000)!.fate).toBe('working')
})

test('L6T1: a turn that ended after the take-in consumed it; the end-of-turn record alone counts too', () => {
  writeFileSync(T, take(10, 1005, '查一下') + toolCall(11) + toolResult(12) + endTurn(13))
  expect(L.deliveryFate(n(1005), T0 + 9_000)!.fate).toBe('consumed')
  expect(L.replacementAction(n(1005), T0 + 9_000, T0 + 13_000)).toBe('keep')
  writeFileSync(T, take(10, 1005, '查一下') + toolCall(11) + turnDur(14))
  expect(L.deliveryFate(n(1005), T0 + 9_000)!.fate).toBe('consumed')
  // a turn end from BEFORE the take-in is not evidence
  writeFileSync(T, endTurn(5) + turnDur(6) + take(10, 1005, '查一下') + toolCall(11))
  expect(L.deliveryFate(n(1005), T0 + 9_000)!.fate).toBe('working')
})

test('L6T1: taken in with nothing after it (the kill came before the first call) is parked again and closed', () => {
  writeFileSync(T, endTurn(5) + take(10, 1006, '還要多久？'))
  expect(L.deliveryFate(n(1006), T0 + 9_000)).toEqual({ fate: 'taken', takenAt: T0 + 10_000 })
  expect(L.replacementAction(n(1006), T0 + 9_000, T0 + 5_000)).toBe('park-close')
})

test('L6G1: a delivery with no trace in the transcript (it went into the dead session) is parked again; the record stays to retract a late read', () => {
  writeFileSync(T, endTurn(5))
  expect(L.deliveryFate(n(1007), T0 + 9_000)).toEqual({ fate: 'none' })
  expect(L.replacementAction(n(1007), T0 + 9_000, T0 + 5_000)).toBe('park')
  writeFileSync(T, endTurn(5) + rec({ type: 'queue-operation', operation: 'enqueue', timestamp: at(10), content: tg(1007, '還要多久？') }))
  expect(L.deliveryFate(n(1007), T0 + 9_000)).toEqual({ fate: 'queued' })
  expect(L.replacementAction(n(1007), T0 + 9_000, T0 + 5_000)).toBe('park')
})

test('L6G1: server.ts never puts a main delivery into a session memory queue, and a closed session\'s memory queue is parked on disk', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'latin1')
  const body = src.slice(src.indexOf('function deliverToMain('), src.indexOf('function stampDid('))
  expect(body).not.toContain('memQueue')
  expect(body).toContain('persistInbound(notif)')
  const evict = src.slice(src.indexOf('function evictZombieSession('), src.indexOf('function evictZombieSession(') + 800)
  expect(evict).toContain('parkMemQueue(sid)')
  expect(evict).not.toContain('memQueue.delete(sid)')
  // the sweep keeps a delivery the main is working on, and the replacement uses the same fate
  expect(src).toContain("if (fate?.fate === 'working') continue")
  expect(src).toContain('Lanes.replacementAction(d.notif, d.at, newest)')
})
