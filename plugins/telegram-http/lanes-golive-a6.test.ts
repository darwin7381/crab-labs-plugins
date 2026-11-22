// lanes-golive A6 / A5: the lab's world out of the prompts (./bin/svc, mock-api, 「模擬時間」, ./bin/btcc-receipt, "send_to_agent 就是 reply_agent"); the
// fleet's receipt tool (~/.claude/tools/btcc-receipt) is recognised; the main hook's thread-stop mark follows the WO-99 lines (mail: no_reply; call:
// reply_to; feed: nothing); memory commits are signed with the agent's fleet identity form.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { mainContext } from './lanes-main.ts'
const L = await import('./lanes.ts?golive-a6') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-golive-a6-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
L.lanesInit({ role: 'tg', agent: 'Lab-Test', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setClaudeBin(join(import.meta.dir, 'test-fixtures', 'no-claude.sh'))
const LAB = [/\.\/bin\/svc/, /mock-api/, /模擬時間/, /\.\/bin\/btcc-receipt/, /就是 reply_agent/, /simulated/]

test('A6: no lab text in a lane\'s card (every kind) or in the main\'s context; the fleet receipt tool and the three lines are named', () => {
  for (const kind of ['reflex', 'worker', 'fork', 'curator', 'synthesis', 'mail'] as const) {
    const card = L.identityCard({ kind })
    for (const re of LAB) expect(card).not.toMatch(re)
    expect(card).toContain('~/.claude/tools/btcc-receipt'); expect(card).toContain('line=mail'); expect(card).toContain('line=call'); expect(card).toContain('line=feed')
  }
  const tools = JSON.stringify(L.laneToolsFor('mail'))
  for (const re of LAB) expect(tools).not.toMatch(re)
  const mc = mainContext('lab-test', 'sid')
  for (const re of LAB) expect(mc).not.toMatch(re)
  expect(mc).toContain('~/.claude/tools/btcc-receipt complete <run>'); expect(mc).toContain('讀信線')
})

test('A6: the main\'s ~/.claude/tools/btcc-receipt complete N is the receipt of run N (the lab regex wanted a bin/ path): a lane\'s run is not completed twice', async () => {
  const text = '[scheduled][daily][run:7171] 每日檢查'
  const d = await L.routeEvent({ id: 'mesh-a6-1', source: 'mesh', from: 'scheduler', verified: true, text, meta: { run_id: '7171' },
    notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any)
  expect(d.target).toBe('lane')
  expect(L.mainToolGate('Bash', { command: '~/.claude/tools/btcc-receipt complete 7171 --outcome done' })).toContain('7171')
  expect(L.mainToolGate('Bash', { command: '/Users/x/.claude/tools/btcc-receipt complete 7171' })).toContain('7171')
  expect(L.mainToolGate('Bash', { command: 'echo btcc-receipts-complete 7171' })).toBeNull()
})

test('A6: memory commits are signed <agent>@fleet.local (the fleet form), not @genesis.lab', () => {
  expect(L.gitEmail()).toBe('lab-test@fleet.local')
})

// the main hook (python) against a stand-in daemon that marks the send as the end of a stopped conversation
const tok = mkdtempSync(join(tmpdir(), 'golive-a6-tok-'))
let reply: Record<string, unknown> = {}
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async () => Response.json(reply) })
writeFileSync(join(tok, String(server.port)), 'tok')
afterAll(() => server.stop(true))
async function hook(input: Record<string, unknown>): Promise<any> {
  const p = Bun.spawn(['python3', join(import.meta.dir, 'lanes-hooks', 'main-hook.py')], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', LANES_DIR: dir, TELEGRAM_HTTP_PORT: String(server.port), MCP_TOKEN_DIR: tok, TYPESAFE_API_KEY: '', TYPESAFE_KEY_FILE: '/nonexistent', CLAUDE_PID: '4242' } })
  p.stdin.write(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', prompt_id: 'p', tool_name: 'mcp__plugin_agent-inbox_agent-inbox__send_to_agent', tool_input: input }))
  p.stdin.end()
  const out = await new Response(p.stdout).text(); await p.exited
  return out.trim() ? JSON.parse(out) : null
}
test('A5: the stop mark per line: a mail gets no_reply, a call gets reply_to (the stopped call it answers), a feed post nothing', async () => {
  reply = { turn: { prompt_id: 'p' }, mark_no_reply: 'stopped', mark_reply_to: '8801' }
  const mail = await hook({ line: 'mail', to: 'eve', title: 't', ask: 'a', text: 'x' })
  expect(mail.hookSpecificOutput.updatedInput).toMatchObject({ line: 'mail', no_reply: true })
  const call = await hook({ line: 'call', to: 'eve', because: 'b', text: 'x' })
  expect(call.hookSpecificOutput.updatedInput).toMatchObject({ line: 'call', reply_to: '8801' })
  expect(call.hookSpecificOutput.updatedInput.no_reply).toBeUndefined()
  expect(await hook({ line: 'feed', title: 't', text: 'x' })).toBeNull()
  reply = { turn: { prompt_id: 'p' }, mark_no_reply: 'stopped' }                         // no stopped call to quote: a call is left as it is
  expect(await hook({ line: 'call', to: 'eve', because: 'b', text: 'x' })).toBeNull()
})
