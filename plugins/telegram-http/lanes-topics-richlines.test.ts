// lanes-topics (rich lane lines): a lane's line to Joey renders like the main's reply. The live test on the test bot (11-23) showed a worker's report in
// its topic as RAW markdown (## headings, table pipes, **bold**): lane lines went out as plain sendMessage while the main's reply goes through
// sendRichMessage. Now both use one send (server.ts sendTextParts): rich first, the plain fallback on a rendering error (never on a timeout), chunked,
// the topic on every part, ring / silent as before. The label pushJoey writes (〔agent·工作線#n〕) stays its own first line: its GFM characters are
// escaped and a blank line separates it from the body (plain form: label, line break, body, as before).
// A real tg daemon (lanes on) and a worker lane whose "claude" is a script that calls the lane's notify_joey through the lane MCP endpoint.
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, dm, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { telegramWorkOrderRouter, startTgDaemon, until, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const BODY = (lane: string) => `## T3 完成 ${lane}\n\n| 項目 | 狀態 |\n|---|---|\n| 報表 | **完成** |\n\n下一步：**寄出**`
let api: BotApiMock, d: TgDaemon, root = ''
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'lanes-topics-richlines-'))
  mkdirSync(join(root, 'bin'), { recursive: true })
  const bin = join(root, 'bin', 'claude')
  writeFileSync(bin, `#!/usr/bin/env python3
import json, os, sys, urllib.request
a = sys.argv[1:]
srv = json.load(open(a[a.index('--mcp-config') + 1]))['mcpServers']['lane']
def post(body, sid=None):
    h = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Authorization': srv['headers']['Authorization']}
    if sid: h['mcp-session-id'] = sid
    r = urllib.request.urlopen(urllib.request.Request(srv['url'], data=json.dumps(body).encode(), headers=h, method='POST'), timeout=20)
    raw, out = r.read().decode(), None
    for line in raw.splitlines():
        if line.startswith('data:'): out = json.loads(line[5:])
    return (out if out is not None else (json.loads(raw) if raw.strip().startswith('{') else None)), r.headers.get('mcp-session-id') or sid
_, sid = post({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 'fake-lane', 'version': '0'}}})
post({'jsonrpc': '2.0', 'method': 'notifications/initialized'}, sid)
lane = os.environ.get('LANE_ID', '?')
body = ${JSON.stringify(BODY('__LANE__'))}.replace('__LANE__', lane)
res, _ = post({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'notify_joey', 'arguments': {'text': body, 'outcome': 'changed'}}}, sid)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': json.dumps(res)[:200]}), flush=True)
`)
  chmodSync(bin, 0o755)
  api = startBotApiMock({ has_topics_enabled: true, allows_users_to_create_topics: false })
  d = await startTgDaemon(api, root, JOEY, { ROAMER_MODE: '1', FIXTURE_MEMBER_TOKEN: 'test-member', LANES_ROUTER: telegramWorkOrderRouter(root), LANES_AGENT: 'sonn_lab', AGENT_INBOX_SELF: 'sonn_lab', LANES_CLAUDE_BIN: bin, TELEGRAM_SEND_TIMEOUT_S: '1',
    LANES_RETRY_BACKOFF_MS: '600000', LANES_CLOSE_GRACE_MS: '300' })
}, 40000)
afterAll(async () => { await d?.stop(); api?.stop() })

async function workOrder(n: number): Promise<any> {
  api.push(dm(JOEY, n, `[board][WO-${n}] 請 sonn_lab 整理名單`))
  const find = () => {
    try { return readFileSync(join(d.ws, '.lanes', 'routing.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(r => r.event === 'tg-' + JOEY + '-' + n) } catch {}
  }
  await until(() => !!find())
  return find()
}
const richFor = (lane: string) => api.of('sendRichMessage').filter(c => String(c.body.rich_message?.markdown ?? '').includes(lane))
const plainFor = (lane: string) => api.of('sendMessage').filter(c => String(c.body.text ?? '').includes(lane))

test('a worker\'s line with a heading, a table and bold goes out as a rich message in its topic; the label is its own first line; it rings', async () => {
  expect(await workOrder(1)).toMatchObject({ rule: 'tg-work-order', target: 'lane' })
  expect(await until(() => richFor('sonn_lab.worker.1').length === 1, 15000)).toBe(true)
  const c = richFor('sonn_lab.worker.1')[0]
  expect(c.body.message_thread_id).toBe(7001)
  expect(c.body.disable_notification).toBeUndefined()
  expect(c.body.rich_message.markdown).toBe(`〔sonn\\_lab·工作線#1〕\n\n${BODY('sonn_lab.worker.1')}`)       // the label's _ escaped, a blank line after it; the body as written
  expect(plainFor('sonn_lab.worker.1')).toEqual([])
  expect(d.log()).toMatch(/lane line sent: method=sendRichMessage chat=1828 message=\d+ topic=7001 ms=\d+/)
}, 30000)

test('a rendering error falls back to plain text once (label, line break, body), in the topic', async () => {
  api.fail.fn = (m, b) => m === 'sendRichMessage' && String(b.rich_message?.markdown ?? '').includes('sonn_lab.worker.2')
  expect(await workOrder(2)).toMatchObject({ target: 'lane' })
  expect(await until(() => plainFor('sonn_lab.worker.2').length === 1, 15000)).toBe(true)
  await Bun.sleep(300)
  api.fail.fn = null
  expect(richFor('sonn_lab.worker.2').length).toBe(1)
  const p = plainFor('sonn_lab.worker.2')
  expect(p.length).toBe(1)
  expect(p[0].body).toMatchObject({ message_thread_id: 7002, text: `〔sonn_lab·工作線#2〕\n${BODY('sonn_lab.worker.2')}` })
}, 30000)

test('a rich send that gets no answer is not sent again as plain text', async () => {
  api.hang.fn = (m, b) => m === 'sendRichMessage' && String(b.rich_message?.markdown ?? '').includes('sonn_lab.worker.3')
  expect(await workOrder(3)).toMatchObject({ target: 'lane' })
  expect(await until(() => richFor('sonn_lab.worker.3').length === 1, 15000)).toBe(true)
  expect(await until(() => /telegram send timeout: sendRichMessage/.test(d.log()), 8000)).toBe(true)
  await Bun.sleep(500)
  api.hang.fn = null
  expect(plainFor('sonn_lab.worker.3')).toEqual([])
}, 30000)

test('a silent lane line stays silent (the closing line of a finished topic), rendered, in the topic, label first', async () => {
  api.push(dm(JOEY, 95, '/lanes close 工作線#1', { command: true }))
  const closing = () => api.of('sendRichMessage').filter(c => String(c.body.rich_message?.markdown ?? '').includes('這條工作線結束了') && c.body.message_thread_id === 7001)
  expect(await until(() => closing().length === 1, 15000)).toBe(true)
  expect(closing()[0].body.disable_notification).toBe(true)
  expect(String(closing()[0].body.rich_message.markdown).startsWith('〔sonn\\_lab·工作線#1〕\n\n這條工作線結束了')).toBe(true)
}, 30000)
