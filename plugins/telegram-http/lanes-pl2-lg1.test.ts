// Universe 002m (LG1, RV5/RV6 G01 #5): a claude process that is not the registered main (its register-main was refused, or a live main holds the role)
// gets no reply, react, edit_message or download_attachment, and is refused at CallTool too. runtime RU5 「只有持有「主」的那一個，拿得到你主對話的回覆工具」;
// RU4 「沒有發的工具，就是不能做的事」. No network, no process.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?pl2-lg1-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-pl2-lg1-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const MAIN = 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', OTHER = '1e0f0a0e-0000-4000-8000-000000000002'
writeFileSync(join(dir, 'main-expected'), MAIN)
const changed: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => [],
  sendBot: async () => 1, joeyChatId: () => '1', toolsChanged: (sid: string) => changed.push(sid) } as any)
const ME = process.pid                 // the "main" claude: a live pid
const SECOND = process.ppid            // the second claude: another live pid

test('LG1: before anything is known, no session is judged (a main that is starting keeps its tools)', () => {
  expect(L.sessionNotMain('mcp-main')).toBe(false)
  L.__noteMcpPid('mcp-main', ME)
  expect(L.sessionNotMain('mcp-main')).toBe(false)
  expect(L.sessionNotMain(undefined)).toBe(false)
})

test('LG1: the main registers and binds; a second claude in the folder is refused, told to list its tools again, and is not the main', () => {
  expect(L.__registerMainForTest(MAIN, join(dir, 'main.jsonl'), ME).accepted).toBe(true)
  expect(L.mainMcpSession()).toBe('mcp-main')
  L.__noteMcpPid('mcp-2', SECOND)                                  // its stream opens: a live main holds the role
  expect(L.sessionNotMain('mcp-2')).toBe(true)
  expect(changed).toEqual(['mcp-2'])
  const r = L.__registerMainForTest(OTHER, join(dir, 'other.jsonl'), SECOND)
  expect(r.accepted).toBe(false)
  expect(changed).toEqual(['mcp-2', 'mcp-2'])                      // the refusal tells it again
  expect(L.sessionNotMain('mcp-2')).toBe(true)
  expect(L.sessionNotMain('mcp-main')).toBe(false)
  expect(L.notMainRefusal('reply')).toMatch(/^refused: reply is only available to adam's registered main session/)
  expect(L.MAIN_TELEGRAM_TOOLS).toEqual(['reply', 'react', 'edit_message', 'download_attachment'])
})

test('LG1: a refused process stays refused while no main is bound; a new main process of the registered session is not judged', () => {
  L.__setMainConnected(null)
  expect(L.sessionNotMain('mcp-2')).toBe(true)                     // refused before, still refused
  L.__noteMcpPid('mcp-3', 999_999_1)                               // an unknown process while no main is bound: not judged
  expect(L.sessionNotMain('mcp-3')).toBe(false)
})

test('LG1: server.ts lists no tools to a session that is not the main, refuses the Telegram tools at CallTool, and can tell it to list again', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'latin1')
  const list = src.slice(src.indexOf('mcp.setRequestHandler(ListToolsRequestSchema'), src.indexOf('mcp.setRequestHandler(ListToolsRequestSchema') + 600)
  expect(list).toContain('Lanes.sessionNotMain(serverSessionId.get(mcp))) return { tools: [] }')
  const call = src.slice(src.indexOf('mcp.setRequestHandler(CallToolRequestSchema'))
  const gate = call.indexOf('Lanes.MAIN_TELEGRAM_TOOLS.includes(req.params.name) && Lanes.sessionNotMain(serverSessionId.get(mcp))')
  expect(gate).toBeGreaterThan(0)
  expect(gate).toBeLessThan(call.indexOf("case 'reply':"))
  expect(src).toContain('tools: { listChanged: true }')
  expect(src).toContain('s.sendToolListChanged()')
})
