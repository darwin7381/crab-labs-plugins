// Universe 002j: the MAIN behind the model wall.
// The wall is read from the main's own transcript, in the shape real sessions write (fleet transcripts, 40 days to
// 2026-11-14, 462 limit records): the API error is a synthetic assistant record and the turn then ends normally.
//   - the main's last assistant record is a wall error  -> the wall comes up, Joey is told once
//   - what is meant for the main is kept; each kept message of Joey's gets a line
//   - a delivery the main took in and answered with the error is held, and given again when the wall is down
//   - a one-line run on the main's model probes; when it gets through: Joey is told once, a main that was stopped in the
//     middle of work is told to carry on, the kept messages are given
//   - the same error record never raises the wall twice; a newer one does
// The "model" is a shell script that prints the result record claude prints: no model, no network.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { lastAssistantFile } from './liveness.ts'
// its own instance of the lane engine (the lanes test files otherwise share one module: queue, timers, the lane binary)
const L = await import('./lanes.ts?mainwall-test') as typeof import('./lanes.ts')

const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-mainwall-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const T = join(dir, 'main.jsonl')
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: T, claude_pid: 1, registered_at: new Date().toISOString() }))
const sent: string[] = [], notices: Array<{ content: string; meta: Record<string, string> }> = []
let sweeps = 0
const script = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p }
const WALLED = script('walled.sh', `echo '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You have hit your weekly limit · resets 5:48pm (Asia/Taipei)"}'\nexit 1`)
const OK = script('ok.sh', `echo '{"type":"result","subtype":"success","is_error":false,"result":"OK"}'\nexit 0`)
const restore = L.__setClaudeBin(WALLED)
L.__setWallProbe(300)
afterAll(() => { L.__setClaudeBin(restore); L.__setWallProbe(300_000) })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'], sweepNow: () => { sweeps++ },
  sendBot: async (_c: string, text: string) => { sent.push(text); return 4000 + sent.length }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
L.__setDigestIO({ mainConnected: async () => true, deliver: async (content, meta) => { notices.push({ content, meta }); return true } })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const rec = (o: object) => JSON.stringify(o) + '\n'
const iso = (ms: number) => new Date(ms).toISOString()
const tag = (id: string, text: string, ms: number) => `<channel source="plugin:telegram-http:telegram-http" chat_id="1" message_id="${id}" user="joey_lab" ts="${iso(ms)}">\n${text}\n</channel>`
const prompt = (ms: number, id: string, text: string) => rec({ type: 'user', isMeta: true, timestamp: iso(ms), message: { role: 'user', content: tag(id, text, ms) } })
const genuine = (ms: number, tool = false) => rec({ type: 'assistant', timestamp: iso(ms), message: { model: 'claude-haiku-5-5', stop_reason: tool ? 'tool_use' : 'end_turn',
  content: tool ? [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'make report' } }] : [{ type: 'text', text: '好' }] } })
const toolResult = (ms: number) => rec({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'step 3 of 7 done' }] } })
const LIMIT = "You've hit your weekly limit · resets 5:48pm (Asia/Taipei)"
const apiErr = (ms: number, text = LIMIT) => rec({ type: 'assistant', timestamp: iso(ms), isApiErrorMessage: true, message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text }] } })
const turnEnd = (ms: number) => rec({ type: 'system', subtype: 'turn_duration', timestamp: iso(ms) })
const noResp = (ms: number) => rec({ type: 'assistant', timestamp: iso(ms), message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } })
const tgNotif = (id: string, chat = '1') => ({ method: 'notifications/claude/channel', params: { content: 'x', meta: { chat_id: chat, message_id: id, user: 'joey_lab' } } }) as any
const meshNotif = (id: string) => ({ method: 'notifications/claude/channel', params: { content: 'x', meta: { btcc_msg_id: id, user: 'eve' } } }) as any
const sysNotif = () => ({ method: 'notifications/claude/channel', params: { content: 'x', meta: { did: 'm1-1', user: 'lanes' } } }) as any
const now = Date.now()

test('the last assistant record, in the shapes real sessions write', () => {
  const f = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, body); return p }
  // a message answered only by the limit error; the harness then ends the turn normally
  expect(lastAssistantFile(f('a.jsonl', genuine(now - 9000) + turnEnd(now - 8900) + prompt(now - 5000, '501', '報告好了嗎') + apiErr(now - 4900) + turnEnd(now - 4800))))
    .toEqual({ at: now - 4900, apiError: true, text: LIMIT, midTask: false, model: 'claude-haiku-5-5' })
  // the limit hit in the middle of work, right after a tool result
  expect(lastAssistantFile(f('b.jsonl', prompt(now - 9000, '501', '做報告') + genuine(now - 8000, true) + toolResult(now - 7000) + apiErr(now - 6900) + turnEnd(now - 6800)))?.midTask).toBe(true)
  // two walled messages in a row: the second is not "in the middle of work"
  expect(lastAssistantFile(f('c.jsonl', genuine(now - 9000) + prompt(now - 8000, '1', 'a') + apiErr(now - 7900) + turnEnd(now - 7800) + prompt(now - 5000, '2', 'b') + apiErr(now - 4900) + turnEnd(now - 4800))))
    .toMatchObject({ apiError: true, midTask: false, model: 'claude-haiku-5-5', at: now - 4900 })
  // a healthy session; the resumed session's "No response requested." record says nothing
  expect(lastAssistantFile(f('d.jsonl', prompt(now - 9000, '1', 'a') + genuine(now - 8000) + turnEnd(now - 7900) + noResp(now - 100)))).toMatchObject({ apiError: false, at: now - 8000 })
  expect(lastAssistantFile(join(dir, 'nope.jsonl'))).toBeNull()
})

test('which API errors are a wall (the wordings real sessions wrote, fleet transcripts 2026-10/11)', () => {
  expect(L.wallKind("You've hit your weekly limit · resets Nov 17, 9am (Asia/Taipei)")).toBe('usage')
  expect(L.wallKind("You've hit your session limit · resets 3pm (Asia/Taipei)")).toBe('usage')
  expect(L.wallKind("You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.")).toBe('usage')
  expect(L.wallKind("You're out of usage credits. Run /usage-credits to keep using Fable or /model to switch models.")).toBe('usage')
  // the server's own rate limiting says "not your usage limit" and carries the status a usage limit carries
  expect(L.wallKind('API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited', 429)).toBe('overload')
  expect(L.wallKind('API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.')).toBe('overload')
  expect(L.wallKind('Please run /login · API Error: 403 Attention Required! | Cloudflare')).toBe('auth')
  expect(L.wallKind('Not logged in · Please run /login')).toBe('auth')
  expect(L.wallKind('Login expired · Please run /login')).toBe('auth')
  expect(L.wallKind('Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead')).toBe('auth')
  expect(L.wallKind("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)")).toBe('error')
  // a refusal is not a wall: waiting changes nothing, and "Usage Policy" is not a usage limit
  expect(L.wallKind('API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy')).toBeNull()
  expect(L.wallKind('API Error: this model has safety measures that flag messages on most cybersecurity or biology topics')).toBeNull()
  expect(L.wallKind('好，我來處理')).toBeNull()
  // a lane run's result record: status alone decides only when the wording says nothing
  expect(L.walledResult({ type: 'result', is_error: true, api_error_status: 429, result: 'API Error' })?.kind).toBe('usage')
  expect(L.walledResult({ type: 'result', is_error: true, api_error_status: 400, result: 'API Error: 400 invalid request' })).toBeNull()
})

test('a main that hit the limit in the middle of work: the wall comes up from its own transcript, Joey is told once', async () => {
  writeFileSync(T, genuine(now - 60_000) + turnEnd(now - 59_000) + prompt(now - 30_000, '501', '做 10 月報告') + genuine(now - 29_000, true) + toolResult(now - 28_000) + apiErr(now - 27_000) + turnEnd(now - 26_900))
  expect(L.wallHoldsMain()).toBe(false)
  L.mainWallTick()
  expect(L.wallHoldsMain()).toBe(true)
  expect(await until(() => sent.length === 1)).toBe(true)
  expect(sent[0]).toContain('主線現在不能用模型'); expect(sent[0]).toContain('weekly limit'); expect(sent[0]).toContain('做到一半'); expect(sent[0]).toContain('一則都不會丟')
  const w = L.__lanesState().main_wall!
  expect(w.model).toBe('claude-haiku-5-5'); expect(w.mid_task).toBe(true); expect(w.kind).toBe('usage')
  L.mainWallTick(); await sleep(60)
  expect(sent.length).toBe(1)                                                                    // told once
  expect(L.wallActive()).toBe(false)                                                             // the lanes' wall is a separate fact: nothing said they are walled
  expect(await until(() => sweeps >= 1)).toBe(true)                                              // deliveries already taken in get marked now
})

test('what is kept for the main: every message of Joey\'s gets a line; mesh messages are counted; system notices are not', async () => {
  L.noteHeldForMain(tgNotif('502'))
  expect(await until(() => sent.length === 2)).toBe(true)
  expect(sent[1]).toContain('收到'); expect(sent[1]).toContain('先保留'); expect(sent[1]).toContain('weekly limit')
  L.noteHeldForMain(tgNotif('503'))
  expect(await until(() => sent.length === 3)).toBe(true)
  expect(sent[2]).toContain('這一則也保留了'); expect(sent[2]).toContain('2 則')
  L.noteHeldForMain(meshNotif('50010')); L.noteHeldForMain(sysNotif()); L.noteHeldForMain(tgNotif('504', '777'))   // a message from another chat is kept, not answered in Joey's
  await sleep(80)
  expect(sent.length).toBe(3)
  expect(L.__lanesState().main_wall!.held).toBe(4)                                               // 502, 503, the mesh one, 504; not the system notice
})

test('a delivery the main took in and answered only with the error is held, not sent round the retry path', () => {
  const d: any = { notif: tgNotif('501') }
  expect(L.walledStep(d, now - 30_000)).toBe('hold'); expect(d.walled).toBe(true)
  expect(L.walledStep(d, now - 30_000)).toBe('hold')                                             // and stays held while the wall is up
  expect(L.__lanesState().main_wall!.held).toBe(5)                                               // counted once
  expect(L.walledStep({ notif: tgNotif('509') } as any, now - 1_000)).toBe('pass')               // taken in AFTER the error record: not this wall's doing
})

test('probes that hit the wall change nothing; the first that gets through takes it down', async () => {
  expect(await until(() => (L.__lanesState().main_wall?.probes ?? 0) >= 2, 4000)).toBe(true)
  expect(L.wallHoldsMain()).toBe(true); expect(sent.length).toBe(3)                              // no message per probe
  const before = sweeps
  L.__setClaudeBin(OK)
  expect(await until(() => !L.wallHoldsMain(), 4000)).toBe(true)
  expect(await until(() => sent.length === 4)).toBe(true)
  expect(sent[3]).toContain('主線的模型恢復了'); expect(sent[3]).toContain('保留的 5 則'); expect(sent[3]).toContain('已經通知它接著做完')
  expect(notices.length).toBe(1)                                                                 // the main is told to carry on with the turn the wall cut
  expect(notices[0].meta.kind).toBe('wall-resume'); expect(notices[0].content).toContain('做到一半'); expect(notices[0].content).toContain('5 則')
  expect(await until(() => sweeps > before, 3000)).toBe(true)                                    // what was kept is given
  expect(L.__lanesState().main_wall).toBeUndefined()
  expect(L.wallLiftedRecently()).toBe(true); expect(L.wallLiftedRecently(0)).toBe(false)   // the stuck-queue alarm stays quiet about what is being given now
})

test('when the wall is down, the held delivery is given again', () => {
  const d: any = { notif: tgNotif('501'), walled: true }
  expect(L.walledStep(d, now - 30_000)).toBe('regive'); expect(d.walled).toBe(false)
})

test('the same error record never raises the wall twice; a newer one does, and a walled message alone needs no carry-on notice', async () => {
  L.__setClaudeBin(WALLED)
  L.mainWallTick(); await sleep(60)
  expect(L.wallHoldsMain()).toBe(false); expect(sent.length).toBe(4)
  // a delivery whose error record was already acted on: marked, held for one sweep, then given again
  const d: any = { notif: tgNotif('501') }
  expect(L.walledStep(d, now - 30_000)).toBe('hold'); expect(L.wallHoldsMain()).toBe(false)
  expect(L.walledStep(d, now - 30_000)).toBe('regive')
  // the main is given the message again and the limit is still there: a newer error record
  const t = Date.now()
  appendFileSync(T, prompt(t - 50, '501', '做 10 月報告') + apiErr(t - 20) + turnEnd(t - 10))
  L.mainWallTick()
  expect(L.wallHoldsMain()).toBe(true)
  expect(await until(() => sent.length === 5)).toBe(true)
  expect(sent[4]).toContain('主線現在不能用模型'); expect(sent[4]).not.toContain('做到一半')
  L.__setClaudeBin(OK)
  expect(await until(() => !L.wallHoldsMain(), 4000)).toBe(true)
  expect(await until(() => sent.length === 6)).toBe(true)
  expect(sent[5]).toContain('主線的模型恢復了'); expect(sent[5]).not.toContain('接著做完')
  expect(notices.length).toBe(1)                                                                 // no second notice: the message itself is given again
})

test('the wall is in the daemon\'s own records', () => {
  const rows = (name: string): any[] => { try { return readFileSync(join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
  const rules = rows('ledger.jsonl').map(r => r.refs?.tier_rule).filter(Boolean)
  expect(rules.filter(r => r === 'main-wall-up').length).toBe(2)
  expect(rules.filter(r => r === 'main-wall-down').length).toBe(2)
  expect(rules.filter(r => r === 'main-wall-held').length).toBe(2)
})
