// Universe 002k (B9): a follow-up run always leaves one notify_joey line (the router decides the tier) and then the receipt; the stop
// hook and the daemon backstop agree with the follow-up text. No network, no model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { followupEventText, type Followup } from './lanes-followup.ts'
const L = await import('./lanes.ts?b9-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-b9-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.sh')
writeFileSync(bin, `#!/bin/sh\necho '{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","name":"mcp__lane__receipt","input":{"outcome":"nothing-to-do","run_id":"47","did":"備份仍正常"}}],"usage":{}}}'\necho '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'\n`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => L.__setClaudeBin(restore))
const sent: Array<{ text: string; silent: boolean }> = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async (_c: string, text: string, o: any) => { sent.push({ text, silent: !!o?.silent }); return 9600 + sent.length }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(30) } return f() }
const NOW = Date.parse('2026-11-13T02:55:00Z')
const fu = (note: string): Followup => ({ id: 'fu-b9', thread: 'adam#t-b9', lane: 'adam.reflex.1', event: 'mesh-47', run_id: '47', trigger: 'scheduled', cls: 'scheduled', from: 'scheduler',
  after_minutes: 5, note, created: new Date(NOW - 300_000).toISOString(), due: NOW, due_iso: new Date(NOW).toISOString(), state: 'pending' })

test('B9: the follow-up text says: always one notify_joey line first, then the receipt; a receipt alone is not a close', () => {
  const t = followupEventText(fu('再查備份'), NOW)
  expect(t).not.toContain('notify_joey 或 receipt')
  expect(t).toContain('一定先用 notify_joey')
  expect(t).toContain('再呼叫 receipt')
  expect(t).toContain('只留 receipt 不算收尾')
})

test('B9: the stop hook agrees: a follow-up run (even of a [high-frequency] routine) is blocked at a receipt alone; the scheduled run itself is not', () => {
  const hook = join(import.meta.dir, 'lanes-hooks', 'lane-stop-hook.py')
  const t = join(dir, 'lane-t.jsonl')
  const run = (prompt: string, tools: string[]) => {
    writeFileSync(t, JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n'
      + JSON.stringify({ type: 'assistant', message: { content: tools.map(n => ({ type: 'tool_use', name: `mcp__lane__${n}`, input: {} })) } }) + '\n')
    const r = spawnSync('python3', [hook], { input: JSON.stringify({ transcript_path: t, session_id: `s-${Math.random()}` }), env: { ...process.env, LANES_DIR: dir }, encoding: 'utf8' })
    return r.stdout.includes('"block"') ? 'block' : 'end'
  }
  const fuText = followupEventText(fu('[high-frequency] 再查備份'), NOW)            // the note carries the tag of the routine it belongs to
  expect(fuText).toContain('[high-frequency]')
  expect(run(fuText, ['receipt'])).toBe('block')
  expect(run(fuText, ['notify_joey', 'receipt'])).toBe('end')
  expect(run('[scheduled][hourly-backup-check][run:47][normal][ops][high-frequency] 檢查', ['receipt'])).toBe('end')     // unchanged
})

test('B9: the daemon backstop agrees: a follow-up run that ended with the receipt alone gets its line written for it', async () => {
  const st = L.__lanesState()
  st.lanes['adam.reflex.1'] = { id: 'adam.reflex.1', kind: 'reflex', n: 1, session_id: 's', thread: 'adam#t-b9', status: 'idle', created: '', last: new Date().toISOString(), transcript: join(dir, 'x.jsonl'), runs: 1, tokens_in: 0, tokens_out: 0 } as any
  st.threads['adam#t-b9'] = { id: 'adam#t-b9', lane: 'adam.reflex.1', peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
  const f = fu('[high-frequency] 再查備份'); f.due = Date.now() - 1
  st.followups['fu-b9'] = f
  L.followupTick()
  expect(await until(() => sent.length === 1)).toBe(true)
  expect(sent[0].text).toContain('處理了'); expect(sent[0].silent).toBe(true)                    // the scheduled class is silent
  const ledger = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  expect(ledger.some(r => String(r.refs?.tier_rule ?? '').endsWith('never-silent-backstop'))).toBe(true)
})
