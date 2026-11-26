// WO-169 section 四 (Chiron's ticket): the lanes' readers of the main's state read the one status record (server.ts currentStatus(), handed in as
// mainStatus), not statusOf: decideWake's member, the 此刻 line, the same-matter gate, the Esc wrap-up. The router runs in this process (lanes.ts, role tg,
// LANES_WAKE_DECIDE on for this agent); the record is composed here as server.ts does: publishView(the judge's verdict, the regions, statusOf's view).
// The wake row's member_state (server.ts) is checked by screen-status-daemon.test.ts.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { programView, publishView, regions, type ScreenVerdict } from './screen-status.ts'
import type { StatusView } from './onsen-status.ts'

const AGENT = 'wo169test'
process.env.LANES_WAKE_DECIDE = `someone-else,${AGENT}`
const L = await import('./lanes.ts?wo169') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-wo169-'))
process.env.LANES_DIR = dir
writeFileSync(join(dir, 'router.json'), readFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), 'utf8'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const R = '─'.repeat(80)
const screen = (above: string[]) => ['', ...above, '', R, '❯ ', R, '  Opus 5.5 · 7d 71%', '  ⏵⏵ bypass permissions on', ''].join('\n')
const MENU = ['', '   Select model', '   ❯ 1. Default (recommended)', '     2. Opus', '   Enter to set as default · Esc to cancel', ''].join('\n')
const BUSY = screen(['⏺ Bash(sleep 60)', '  ⎿  Running…', '', '✳ Cerebrating… (40s)'])
const INTR = screen(['✻ Churned for 6s · done 12:07 AM', '  ⎿  Interrupted · What should Claude do instead?'])
const SHELL = screen(['⏺ Started it.', '', '✻ Brewed for 2s · done 2:29 AM · 1 shell still running'])
/** what the screen judge said, the screen, statusOf's view: the record as server.ts composes it (null verdict: statusOf's, judged_by program) */
let verdict: ScreenVerdict | null = null, shown = BUSY
let program: StatusView = { state: 'idle', detail: { queued_joey: 0 }, last_activity_at: new Date().toISOString() }
const record = (): StatusView => verdict ? publishView(verdict, regions(shown), program) : programView(program)
const V = (state: ScreenVerdict['state'], menu: ScreenVerdict['menu'] = 'none'): ScreenVerdict => ({ state, menu, p: 0.9, by: 'jev' })
L.lanesInit({ role: 'tg', agent: AGENT, workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false,
  registryNames: () => ['chiron', 'eve'], sendBot: async () => 1, joeyChatId: () => '1', mainStatus: record, notifySession: async () => true, streamOpen: () => true } as any)
L.__setMainConnected('mcp-main')
afterAll(() => { delete process.env.LANES_WAKE_DECIDE })
const routing = (): any[] => { try { return readFileSync(join(dir, 'routing.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const rowOf = (id: string) => routing().filter(r => r.event === id).at(-1)
let n = 0
function mesh(from: string, text: string, o: Record<string, unknown> = {}): any {
  n += 1
  return { id: `mesh-169-${n}`, source: 'mesh', from, text, verified: true, meta: { user: from }, notif: { method: 'notifications/claude/channel', params: { content: text, meta: { user: from } } },
    line: 'call', btcc_msg_id: String(71000 + n), ...o }
}
const pid = process.pid
let p = 0
const turn = async () => { await L.__mainEvent({ event: 'UserPromptSubmit', pid, prompt_id: `p169-${++p}` }); await L.__mainEvent({ event: 'PreToolUse', pid, prompt_id: `p169-${p}`, tool_name: 'Bash', tool_input: { command: 'sleep 60' } }) }
const stop = async () => { await L.__mainEvent({ event: 'Stop', pid }) }
const phase = () => L.__main().mainPhase()

test('decideWake: a /model menu open outside a turn — statusOf idle (dialog_open), the screen judge waiting (model_picker): the record says waiting, so the decision is 「等人按」', async () => {
  await stop()
  program = { state: 'idle', detail: { queued_joey: 0, dialog_open: true }, last_activity_at: new Date().toISOString() }
  shown = MENU
  verdict = V('waiting_for_human', 'model_picker')
  expect(record()).toMatchObject({ state: 'waiting', detail: { waitingFor: 'model_picker', judged_by: 'jev' } })
  const a = mesh('eve', '維護幾點？', { verified: false })
  await L.routeEvent(a)
  expect(rowOf(a.id)).toMatchObject({ rule: 'wake:unverified', decided_by: 'new', wake_target: 'held:waiting' })
  // the same moment with no verdict (SCREEN_JUDGE=program, or Jev unsure): statusOf's idle {dialog_open} decides, as before
  verdict = null
  const b = mesh('eve', '維護幾點？（再問一次）', { verified: false })
  await L.routeEvent(b)
  expect(rowOf(b.id)).toMatchObject({ wake_target: 'main_now' })
})

test('the 此刻 line and the same-matter gate read the record: waiting, stuck (not overwritten by working), busy; idle / interrupted / background = not in a turn', async () => {
  await turn()                                                            // M2: in a turn (the gate reads the record, not M2)
  shown = MENU; verdict = V('waiting_for_human', 'model_picker'); program = { state: 'idle', detail: { queued_joey: 0, dialog_open: true }, last_activity_at: new Date().toISOString() }
  expect(L.mainNowLine()).toBe('主線：停在一個選單上等 Joey 按（model_picker）。交給它的事要等 Joey 按了才會看到。')
  expect(L.mainTurnNow()).not.toBeNull()
  shown = BUSY; verdict = V('working')
  program = { state: 'stuck', detail: { queued_joey: 0, threshold_s: 600, turn_started_at: new Date(Date.now() - 20 * 60_000).toISOString(), tool: null, subagents: 0 },
    last_activity_at: new Date(Date.now() - 11 * 60_000).toISOString() }
  expect(record().state).toBe('stuck')
  expect(L.mainNowLine()).toBe('主線：回合開著，但 11 分鐘 沒有任何動靜，可能卡住了。交給它的事不一定會被看到。')
  expect(L.mainTurnNow()).not.toBeNull()
  program = { state: 'idle', detail: { queued_joey: 0 }, last_activity_at: new Date().toISOString() }
  expect(L.mainNowLine()).toMatch(/^主線：回合中/)                          // the screen says working while statusOf says idle: the record's busy
  expect(L.mainTurnNow()).not.toBeNull()
  for (const [s, text] of [['interrupted', INTR], ['idle_background_running', SHELL], ['idle', INTR]] as const) {
    shown = text; verdict = V(s)
    expect(L.mainNowLine()).toBe('主線：閒置。交給它的事馬上會看到。')
    expect(L.mainTurnNow()).toBeNull()
  }
  verdict = null; await stop()
})

test('the Esc wrap-up: a record that says idle + interrupted (seen after the turn\'s last hook) closes the turn at its change, at once; the item that waited is offered', async () => {
  await stop()
  program = { state: 'busy', detail: { queued_joey: 0 }, last_activity_at: new Date().toISOString() }
  shown = BUSY; verdict = V('working')
  L.mainStatusChanged()
  await turn()
  expect(phase()).toBe('in_turn')
  // an item comes in during the turn: the main takes it at its next step (it stays queued for this gen)
  program = { state: 'busy', detail: { queued_joey: 0 }, last_activity_at: new Date().toISOString() }
  const meta = { chat_id: '1', message_id: '16901', user: 'joey_lab' }
  const m = { id: 'tg-1-16901', source: 'telegram', from: 'joey', text: '這一則在回合中進來', meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: '這一則在回合中進來', meta } } }
  await L.routeEvent(m as any)
  expect(rowOf(m.id)).toMatchObject({ wake_target: 'main_after_step' })
  const item = () => L.__main().items((r: any) => r.event === m.id)[0]
  expect(item().state).toBe('queued')
  await new Promise(r => setTimeout(r, 5))
  // Esc: statusOf and the screen say idle; the screen judge read 「Interrupted」
  program = { state: 'idle', detail: { queued_joey: 0 }, last_activity_at: new Date().toISOString() }
  shown = INTR; verdict = V('interrupted')
  const t0 = Date.now()
  L.mainStatusChanged()
  expect(phase()).toBe('idle')
  await new Promise(r => setTimeout(r, 20))
  expect(item().state).toBe('offered')
  expect(Date.now() - t0).toBeLessThan(2000)
})

test('the Esc wrap-up: idle with no interruption seen still takes two readings MAIN_IDLE_CONFIRM_MS apart; an interruption seen BEFORE the turn\'s last hook (a record not re-judged yet) is no evidence', async () => {
  await stop()
  await turn()
  // idle, not interrupted: one reading does not close
  program = { state: 'idle', detail: { queued_joey: 0 }, last_activity_at: new Date().toISOString() }
  shown = SHELL; verdict = V('idle_background_running')
  L.mainStatusChanged(); L.mainStatusChanged()
  expect(phase()).toBe('in_turn')
  // the record says interrupted since before a new turn began (the next turn started before the screen was judged again)
  await stop()
  shown = INTR; verdict = V('interrupted')
  L.mainStatusChanged()                                                     // the interruption seen now (no turn open: nothing to close)
  await new Promise(r => setTimeout(r, 5))
  await turn()                                                              // a new turn: its hooks come after the interruption was seen
  L.mainStatusChanged()
  expect(phase()).toBe('in_turn')
  verdict = V('working'); shown = BUSY
  L.mainStatusChanged()
  expect(phase()).toBe('in_turn')
  verdict = null; await stop()
})
