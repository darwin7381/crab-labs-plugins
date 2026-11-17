import { describe, expect, test } from 'bun:test'
import { mkdtempSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { receiptKeys, receivedIn, recentReceiptLines } from './receipt.ts'

// How Claude Code 2.1.322 records a channel notification it took (from a real transcript, 11-17 13:08:26Z):
// a queue-operation enqueue line whose content is the rendered <channel …> tag with our meta verbatim.
const enqueue = (attrs: string, body: string, ts = '2026-11-17T13:08:26.868Z') =>
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: ts, sessionId: 's',
    content: `<channel source="plugin:agent-inbox:agent-inbox" ${attrs}>\n${body}\n</channel>` })

const inbox = { method: 'notifications/claude/channel', params: { content: '讀信箱（1 封未讀）',
  meta: { chat_id: 'local-inject', user: 'fleet-watchdog', user_id: 'local-inject', ts: '2026-11-17T13:08:26.850Z',
    via: 'local-inject', verified: 'true', relay: 'direct', no_reply: 'true' } } }
const inboxLine = enqueue('chat_id="local-inject" user="fleet-watchdog" user_id="local-inject" ts="2026-11-17T13:08:26.850Z" ' +
  'via="local-inject" verified="true" relay="direct" no_reply="true"', '讀信箱（1 封未讀）')

const tg = (mid: number) => ({ method: 'notifications/claude/channel', params: { content: 'hi',
  meta: { chat_id: '1828173984', message_id: String(mid), user: 'Joey', ts: '2026-11-17T13:20:05.000Z' } } })
const tgLine = (mid: number) => enqueue(`chat_id="1828173984" message_id="${mid}" user="Joey" ts="2026-11-17T13:20:05.000Z"`, 'hi')

describe('receipt keys', () => {
  test('agent-inbox inject: ts + chat_id, found in the real enqueue form', () => {
    const k = receiptKeys(inbox)!
    expect(k).toEqual(['ts=\\"2026-11-17T13:08:26.850Z\\"', 'chat_id=\\"local-inject\\"'])
    expect(receivedIn([inboxLine], k)).toBe(true)
  })
  test('telegram: message_id disambiguates two messages in the same second', () => {
    expect(receivedIn([tgLine(436)], receiptKeys(tg(436))!)).toBe(true)
    expect(receivedIn([tgLine(436)], receiptKeys(tg(437))!)).toBe(false)
  })
  test('keys split across two lines do not count', () => {
    const k = receiptKeys(tg(436))!
    const a = enqueue('chat_id="1828173984" message_id="999" ts="2026-11-17T13:20:05.000Z"', 'x')
    const b = enqueue('chat_id="1828173984" message_id="436" ts="2026-11-17T09:00:00.000Z"', 'y')
    expect(receivedIn([a, b], k)).toBe(false)
  })
  test('another delivery with a different ts is not this one', () => {
    const other = { ...inbox, params: { ...inbox.params, meta: { ...inbox.params.meta, ts: '2026-11-17T13:08:27.001Z' } } }
    expect(receivedIn([inboxLine], receiptKeys(other)!)).toBe(false)
  })
  test('no meta.ts → null (old behaviour applies)', () => {
    expect(receiptKeys({ method: 'm', params: { content: 'x' } })).toBeNull()
    expect(receiptKeys({ method: 'm', params: { meta: { ts: '' } } })).toBeNull()
    expect(receiptKeys({ method: 'm', params: undefined })).toBeNull()
  })
  test('values are matched in their JSON-escaped form', () => {
    const n = { method: 'm', params: { meta: { ts: '2026-11-17T00:00:00.000Z', chat_id: 'a"b\\c' } } }
    const line = JSON.stringify({ content: '<channel chat_id="a"b\\c" ts="2026-11-17T00:00:00.000Z">x</channel>' })
    expect(receivedIn([line], receiptKeys(n)!)).toBe(true)
  })
})

describe('recentReceiptLines', () => {
  test('reads recent transcripts only, keeps lines with a ts attribute', () => {
    const d = mkdtempSync(join(tmpdir(), 'receipt-'))
    const now = Date.now()
    writeFileSync(join(d, 'cur.jsonl'), [JSON.stringify({ type: 'assistant' }), inboxLine, ''].join('\n'))
    writeFileSync(join(d, 'old.jsonl'), tgLine(1) + '\n')
    utimesSync(join(d, 'old.jsonl'), (now - 3_600_000) / 1000, (now - 3_600_000) / 1000)
    writeFileSync(join(d, 'notes.txt'), inboxLine)
    const lines = recentReceiptLines(d, now - 60_000)
    expect(lines).toEqual([inboxLine])
    expect(receivedIn(lines, receiptKeys(inbox)!)).toBe(true)
  })
  test('only the tail is read', () => {
    const d = mkdtempSync(join(tmpdir(), 'receipt-'))
    writeFileSync(join(d, 't.jsonl'), inboxLine + '\n' + 'x'.repeat(5000) + '\n')
    expect(recentReceiptLines(d, 0, 1000)).toEqual([])
    expect(recentReceiptLines(d, 0, 100_000)).toEqual([inboxLine])
  })
  test('missing dir → [] (no throw)', () => {
    expect(recentReceiptLines('/nonexistent-receipt-dir', 0)).toEqual([])
  })
})
