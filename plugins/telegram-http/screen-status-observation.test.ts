// WO-169 part 2 (Chiron 00:29Z; Onsen contract v1 §3): the composition that gives the status record also gives the observation, from the verdict and the
// program's facts, per Chiron's table. Every observation here passes the contract's Status rules (test-fixtures/status-v1-check.ts, the part of
// rescue-site/onsen-ui/fixtures/v1/status_v1_check.py this daemon observes; and that file itself at the end, when it is here). Synthetic screens only.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Since, composeRecord, regions, type RecordFacts, type ScreenVerdict, type TurnFact } from './screen-status.ts'
import { DeliveryFacts, LanesTap, TurnWatch, type StatusView } from './onsen-status.ts'
import { checkObservation } from './test-fixtures/status-v1-check.ts'

const R = '─'.repeat(80)
const screen = (above: string[], below: string[] = ['  Opus 5.5 · 7d 71%', '  ⏵⏵ bypass permissions on · 1 shell']) => ['', ...above, '', R, '❯ ', R, ...below, ''].join('\n')
const ST = regions(screen(['⏺ Bash(ls)', '', '✳ Cerebrating… (12s)'], ['  Opus 5.5 · 7d 71%', '  ⏵⏵ bypass permissions on · 1 shell', '', '  ⏺ main', '  ◯ general-purpose  Reading  3s · ↓ 1k tokens']))
const MENU = regions(['', '   Select model', '   ❯ 1. Default', '   Enter to set as default · Esc to cancel', ''].join('\n'))
const NOW = Date.parse('2026-11-26T01:00:00.000Z')
const V = (state: ScreenVerdict['state'], menu: ScreenVerdict['menu'] = 'none', by: ScreenVerdict['by'] = 'jev', p = 0.9): ScreenVerdict => ({ state, menu, p, by })
const prog = (state: StatusView['state'], detail: Record<string, unknown> = {}): StatusView => ({ state, detail: { queued_joey: 0, ...detail }, last_activity_at: '2026-11-26T00:59:00.000Z' })
const TURN: TurnFact = { id: 'p-1', started_at: '2026-11-26T00:58:00.000Z', trigger: { kind: 'message', conversation_id: '1828173984', message_id: '9001' } }
const TOOL = { turn_started_at: TURN.started_at, tool: { name: 'Bash', since: '2026-11-26T00:59:30.000Z' }, subagents: 0 }
const F = (o: RecordFacts = {}): RecordFacts => ({ now: NOW, session_id: 'sess-1', queue: { pending: 1, unread_by_member: 0 }, ...o })
const ALL: unknown[] = []                                   // every observation made here, for Chiron's own checker at the end
const obs = (v: ScreenVerdict | null, st: any, p: StatusView, f: RecordFacts = F()) => {
  const r = composeRecord(v, st, p, f)
  expect(checkObservation(r.observation)).toEqual([])
  ALL.push(JSON.parse(JSON.stringify(r.observation)))
  return r.observation
}
const main = (o: any) => o.sessions.find((s: any) => s.kind === 'main')

describe("Chiron's table, field by field", () => {
  test('presence / presence_reason / lifecycle', () => {
    expect(obs(null, null, prog('idle'))).toMatchObject({ presence: 'online', presence_reason: null, lifecycle: 'ready', main_session_id: 'main' })
    const g = obs(V('working'), ST, prog('offline', { reason: 'pid_gone' }), F({ turn: TURN }))
    expect(g).toMatchObject({ presence: 'offline', presence_reason: 'process_gone', lifecycle: 'stopped', background: null })
    expect(main(g)).toMatchObject({ activity: 'unknown', turn: null, doing: null, blockers: [] })
    expect(obs(V('idle'), ST, prog('offline', { reason: 'not_connected' }))).toMatchObject({ presence: 'offline', presence_reason: 'disconnected', lifecycle: 'ready' })
    // starting (WO-169 第一節: no_registration with Claude Code in the pane, or the verdict starting): online, the main idle with no turn
    for (const [v, f] of [[null, F({ alive: true, session_id: null })], [V('starting'), F({ session_id: null })], [V('working'), F({ turn: TURN })]] as const) {
      const o = obs(v, v ? ST : null, prog('offline', { reason: 'no_registration' }), f)
      expect(o).toMatchObject({ presence: 'online', lifecycle: 'starting' })
      expect(main(o)).toMatchObject({ activity: 'idle', turn: null, doing: null })
    }
    // not connected yet while the screen says starting (07:12–07:14Z, 11-26: eight agents restarting after the account switch): online, starting, the main idle
    const nc = obs(V('starting'), ST, prog('offline', { reason: 'not_connected' }), F({ session_id: 'abc' }))
    expect(nc).toMatchObject({ presence: 'online', presence_reason: null, lifecycle: 'starting' })
    expect(main(nc)).toMatchObject({ activity: 'idle', turn: null, doing: null })
    // no registration and nothing seen of the process: no main is made up
    expect(obs(null, null, prog('offline', { reason: 'no_registration' }), F({ session_id: null }))).toMatchObject({ presence: 'offline', presence_reason: 'disconnected', sessions: [], main_session_id: null })
    expect(obs(null, null, prog('offline', { reason: 'no_registration' }), F({ session_id: null, alive: false }))).toMatchObject({ presence_reason: 'process_gone', lifecycle: 'stopped' })
  })
  test('activity: running (busy, compacting), paused (a menu or the wall in a turn), stuck, idle (else); busy or stuck with no turn open: the record\'s own turn (WO-177: online is never unknown)', () => {
    const run = main(obs(V('working'), ST, prog('busy', TOOL), F({ turn: TURN })))
    expect(run).toMatchObject({ id: 'main', kind: 'main', activity: 'running', turn: TURN, doing: { kind: 'tool', tool: 'Bash', since: TOOL.tool.since }, blockers: [] })
    expect(main(obs(V('working'), ST, prog('idle'), F({ turn: TURN }))).doing).toEqual({ kind: 'thinking', tool: null, since: '2026-11-26T01:00:00.000Z' })
    expect(main(obs(V('compacting'), ST, prog('busy', TOOL), F({ turn: TURN }))).doing).toMatchObject({ kind: 'compacting', tool: null })
    expect(main(obs(null, null, prog('busy', TOOL), F({ turn: TURN })))).toMatchObject({ activity: 'running', doing: { kind: 'tool', tool: 'Bash' } })
    // WO-177 (Chiron 04:01Z item 1, status_v1_check.py 03:59Z): no turn the program has open: the turn statusOf says began (turn_started_at), id turn-<ms>, trigger other
    const own = { id: `turn-${Date.parse(TURN.started_at)}`, started_at: TURN.started_at, trigger: { kind: 'other' } }
    expect(main(obs(V('working'), ST, prog('busy', TOOL), F({ turn: null })))).toMatchObject({ activity: 'running', turn: own, doing: { kind: 'tool', tool: 'Bash' } })
    const st = main(obs(V('working'), ST, prog('stuck', { threshold_s: 600, ...TOOL }), F({ turn: TURN })))
    expect(st).toMatchObject({ activity: 'stuck', turn: TURN, doing: null, blockers: [{ reason: 'stalled', menu_kind: null, assignee: null, until: null }] })
    expect(main(obs(null, null, prog('stuck', { threshold_s: 600, ...TOOL }), F({ turn: null })))).toMatchObject({ activity: 'stuck', turn: own, doing: null, blockers: [{ reason: 'stalled' }] })
    // a compaction while idle (no turn: only PreCompact fired): running, doing compacting, a turn from when the record turned compacting
    const cmp = main(obs(V('compacting'), ST, prog('idle'), F({ turn: null })))
    expect(cmp).toMatchObject({ activity: 'running', turn: { id: `turn-${NOW}`, started_at: new Date(NOW).toISOString(), trigger: { kind: 'other' } }, doing: { kind: 'compacting', tool: null } })
    for (const v of [V('idle'), V('interrupted'), V('idle_background_running')]) expect(main(obs(v, ST, prog('idle'), F({ turn: TURN })))).toMatchObject({ activity: 'idle', turn: null, blockers: [] })
  })
  test('blockers (criterion 10): a permission prompt in a turn: paused, permission, the person it went to on Telegram; /model opened while idle: idle, input_required, model_picker, the duty officer while it watches the pane', () => {
    const perm = main(obs(V('waiting_for_human', 'permission'), ST, prog('busy', TOOL), F({ turn: TURN, dutyWatches: true, person: 'joey-test' })))
    expect(perm).toMatchObject({ activity: 'paused', turn: TURN, doing: null, blockers: [{ reason: 'permission', menu_kind: 'permission', assignee: 'joey-test', action_id: null, until: null, summary: '等待權限核准' }] })
    const model = main(obs(V('waiting_for_human', 'model_picker'), MENU, prog('idle', { dialog_open: true }), F({ turn: null, dutyWatches: true, person: 'joey-test' })))
    expect(model).toMatchObject({ activity: 'idle', turn: null, blockers: [{ reason: 'input_required', menu_kind: 'model_picker', assignee: 'duty-officer', summary: '選單等待選擇' }] })
    expect(main(obs(V('waiting_for_human', 'usage_limit_options'), MENU, prog('idle'), F())).blockers[0]).toMatchObject({ reason: 'usage_limit', menu_kind: 'usage_limit_options' })
    // no verdict (Jev down): Claude Code's registry says waiting for a permission prompt in a turn / a dialog open outside one
    expect(main(obs(null, null, prog('waiting', { waitingFor: 'permission prompt', ...TOOL }), F({ turn: TURN, dutyWatches: true, person: 'joey-test' })))).toMatchObject({ activity: 'paused', blockers: [{ reason: 'permission', menu_kind: 'permission', assignee: 'joey-test' }] })
    expect(main(obs(null, null, prog('idle', { dialog_open: true }), F({ dutyWatches: true })))).toMatchObject({ activity: 'idle', blockers: [{ reason: 'input_required', menu_kind: 'other', assignee: 'duty-officer' }] })
    // the wall: paused in a turn, idle out of one; until = the wall's time; no menu: nobody
    const wall = { walled: { until: '2026-11-26T03:00:00.000Z', kind: 'session' } }
    expect(main(obs(V('working'), ST, prog('busy', { ...wall, ...TOOL }), F({ turn: TURN, dutyWatches: true })))).toMatchObject({ activity: 'paused', blockers: [{ reason: 'usage_limit', until: '2026-11-26T03:00:00.000Z', menu_kind: null, assignee: null }] })
    expect(main(obs(V('usage_limit', 'usage_limit_options'), MENU, prog('idle', wall), F({ dutyWatches: true })))).toMatchObject({ activity: 'idle', blockers: [{ reason: 'usage_limit', menu_kind: 'usage_limit_options', assignee: 'duty-officer' }] })
  })
  test('WO-180 (Chiron 04:42Z, 1, 2): every menu is the duty officer\'s first while it watches the pane; once it asked, the person asked with that Action; not watched: the person (access.json\'s, never a fixed name); a permission prompt: the person it went to on Telegram, with its Action', () => {
    const menus = ['model_picker', 'other', 'resume_picker', 'trust_folder', 'plan_or_question', 'login', 'usage_limit_options'] as const
    for (const m of menus) {
      const b = main(obs(V('waiting_for_human', m), MENU, prog('idle'), F({ dutyWatches: true, person: 'joey-test' }))).blockers[0]
      expect([m, b.assignee, b.action_id]).toEqual([m, 'duty-officer', null])
      expect(main(obs(V('waiting_for_human', m), MENU, prog('idle'), F({ dutyWatches: false, person: 'joey-test' }))).blockers[0].assignee).toBe('joey-test')
    }
    expect(main(obs(V('waiting_for_human', 'other'), MENU, prog('idle'), F())).blockers[0].assignee).toBe('joey')          // no person given: the owner, as assigneesOf
    // the duty officer asks a person about /theme: from then on that person and the question's Action; the same blocker (id, since)
    const mem = new Since(); let now = NOW
    const f = (o: RecordFacts = {}) => F({ dutyWatches: true, person: 'joey-test', since: (k, v) => mem.at(k, v, now), now, ...o })
    const before = main(obs(V('waiting_for_human', 'other'), MENU, prog('idle'), f())).blockers[0]
    now += 9_000
    const asked = (m: string) => m === 'other' ? { action_id: '22', assignee: 'joey-test' } : null
    const after = main(obs(V('waiting_for_human', 'other'), MENU, prog('idle'), f({ asked }))).blockers[0]
    expect([before.assignee, before.action_id]).toEqual(['duty-officer', null])
    expect(after).toMatchObject({ id: before.id, since: before.since, assignee: 'joey-test', action_id: '22' })
    expect(main(obs(V('waiting_for_human', 'other'), MENU, prog('idle'), f({ asked: () => ({ action_id: '23', assignee: null }) }))).blockers[0].assignee).toBe('joey-test')   // asked nobody named: the person
    expect(main(obs(V('waiting_for_human', 'other'), MENU, prog('idle'), f({ asked: () => { throw new Error('x') } }))).blockers[0]).toMatchObject({ assignee: 'duty-officer', action_id: null })
    // a permission prompt: the person it went to on Telegram and its own Action, the duty officer watching or not, asked or not
    const perm = main(obs(V('waiting_for_human', 'permission'), ST, prog('busy', TOOL), f({ turn: TURN, asked: () => ({ action_id: '99', assignee: 'x' }), actionFor: m => m === 'permission' ? '40' : null }))).blockers[0]
    expect(perm).toMatchObject({ reason: 'permission', assignee: 'joey-test', action_id: '40' })
  })
  test('WO-180 (Chiron 04:42Z, 3; acceptance 10): /theme then /status: two blockers, a new id and since for each, a record with none between them; one menu across records keeps its id and since', () => {
    const mem = new Since(); let now = Date.parse('2026-11-26T04:19:48.245Z')
    const f = () => F({ dutyWatches: true, person: 'joey-test', since: (k, v) => mem.at(k, v, now), now })
    const theme = main(obs(V('waiting_for_human', 'other'), MENU, prog('idle'), f())).blockers[0]
    now += 4_000
    expect(main(obs(V('waiting_for_human', 'other'), MENU, prog('idle'), f())).blockers[0]).toMatchObject({ id: theme.id, since: theme.since })   // the same menu
    now = Date.parse('2026-11-26T04:20:12.000Z')
    expect(main(obs(V('idle'), ST, prog('idle'), f())).blockers).toEqual([])                                                 // the duty officer pressed Esc
    now = Date.parse('2026-11-26T04:22:14.411Z')
    const status = main(obs(V('waiting_for_human', 'other'), MENU, prog('idle'), f())).blockers[0]
    expect(theme).toMatchObject({ since: '2026-11-26T04:19:48.245Z', assignee: 'duty-officer' })
    expect(status).toMatchObject({ since: '2026-11-26T04:22:14.411Z', assignee: 'duty-officer' })
    expect(status.id).not.toBe(theme.id)
    // statusOf's own view between them (no verdict, nothing open) ends it too; so does the main going offline
    const a = main(obs(null, null, prog('idle', { dialog_open: true }), f())).blockers[0]
    now += 30_000
    obs(null, null, prog('offline', { reason: 'pid_gone' }), f())
    now += 1_000
    const b = main(obs(null, null, prog('idle', { dialog_open: true }), f())).blockers[0]
    expect([a.since === status.since, b.since === new Date(now).toISOString(), b.id !== a.id]).toEqual([true, true, true])
  })
  test('turn and trigger (criterion 9) come from the program: Joey\'s message, a thread, a schedule; last_turn as it ended; the screen\'s Interrupted marks it interrupted (criterion 12)', () => {
    const thread: TurnFact = { ...TURN, trigger: { kind: 'thread', thread_id: 'lab-relay#t-aa01' } }
    expect(main(obs(V('working'), ST, prog('busy', TOOL), F({ turn: thread }))).turn.trigger).toEqual({ kind: 'thread', thread_id: 'lab-relay#t-aa01' })
    expect(main(obs(V('working'), ST, prog('busy', TOOL), F({ turn: thread }))).thread_id).toBe('lab-relay#t-aa01')
    expect(main(obs(V('working'), ST, prog('busy', TOOL), F({ turn: TURN, turn_thread: 'lab-relay#t-joey' }))).thread_id).toBe('lab-relay#t-joey')
    const last = { id: 'p-0', outcome: 'done' as const, ended_at: '2026-11-26T00:50:00.000Z' }
    expect(main(obs(null, null, prog('idle'), F({ last_turn: last }))).last_turn).toEqual(last)
    expect(main(obs(V('interrupted'), ST, prog('idle'), F({ last_turn: last }))).last_turn).toEqual({ ...last, outcome: 'interrupted' })
    expect(main(obs(V('idle'), ST, prog('idle'), F({ last_turn: { ...last, outcome: 'failed' } }))).last_turn.outcome).toBe('failed')
  })
  test('lanes (criterion 11): one running session per lane run, its trigger its thread (a schedule\'s: schedule), beside a main waiting on a menu', () => {
    const lanes = [{ id: 'lab-relay.reflex.3', run: 'lab-relay.reflex.3.r1', kind: 'reflex', since: '2026-11-26T00:59:10.000Z', thread: 'lab-relay#t-sch1' },
      { id: 'lab-relay.mail.1', run: 'lab-relay.mail.1.r2', kind: 'mail', since: '2026-11-26T00:59:20.000Z', thread: 'lab-relay#t-mail' }]
    const o = obs(V('waiting_for_human', 'model_picker'), MENU, prog('idle', { lanes, dialog_open: true }), F({ scheduleThread: t => t === 'lab-relay#t-sch1' }))
    expect(o.sessions.map((s: any) => [s.id, s.kind, s.activity])).toEqual([['main', 'main', 'idle'], ['lab-relay.reflex.3', 'lane', 'running'], ['lab-relay.mail.1', 'lane', 'running']])
    expect(o.sessions[0].blockers[0]).toMatchObject({ menu_kind: 'model_picker' })
    expect(o.sessions[1]).toMatchObject({ thread_id: 'lab-relay#t-sch1', activity_since: lanes[0]!.since, turn: { id: 'lab-relay.reflex.3.r1', started_at: lanes[0]!.since, trigger: { kind: 'schedule' } }, doing: { kind: 'thinking' } })
    expect(o.sessions[2].turn.trigger).toEqual({ kind: 'thread', thread_id: 'lab-relay#t-mail' })
    // a main paused on a permission prompt while a lane runs
    const p = obs(V('waiting_for_human', 'permission'), ST, prog('busy', { lanes, ...TOOL }), F({ turn: TURN }))
    expect(p.sessions.map((s: any) => s.activity)).toEqual(['paused', 'running', 'running'])
  })
  test('background: the screen\'s four counts, also with no verdict; nothing read: null (never 0); queue and evidence; no percentage anywhere', () => {
    expect(obs(null, ST, prog('idle')).background).toEqual({ agents: 1, shells: 1, tasks: 0, monitors: 0 })
    expect(obs(null, null, prog('idle')).background).toBeNull()
    expect(obs(null, null, prog('idle'), F({ queue: null })).queue).toEqual({ pending: null, unread_by_member: null })
    expect(obs(V('idle', 'none', 'jev', 0.83), ST, prog('idle')).evidence).toEqual({ source: 'classifier', confidence: 0.83 })
    expect(obs(V('idle', 'none', 'program', 1), ST, prog('idle')).evidence).toEqual({ source: 'runtime', confidence: 1 })
    expect(obs(null, null, prog('idle')).evidence).toEqual({ source: 'runtime', confidence: null })
    const o = obs(V('waiting_for_human', 'other'), regions(screen(["You've used 79% of your weekly limit", 'Some panel'])), prog('idle'))
    expect(JSON.stringify(o)).not.toMatch(/\d\s*%/)
  })
  test('since: an activity and a blocker keep the moment they began across calls; a change starts again', () => {
    const mem = new Since()
    let now = NOW
    const f = () => F({ now, since: (k, v) => mem.at(k, v, now), turn: TURN })
    const a = main(obs(V('waiting_for_human', 'permission'), ST, prog('busy', TOOL), f()))
    now += 5000
    const b = main(obs(V('waiting_for_human', 'permission'), ST, prog('busy', TOOL), f()))
    expect(b.activity_since).toBe(a.activity_since); expect(b.blockers[0].since).toBe(a.blockers[0].since); expect(b.blockers[0].id).toBe(a.blockers[0].id)
    now += 5000
    const c = main(obs(V('working'), ST, prog('busy', TOOL), f()))
    expect(c.activity_since).toBe('2026-11-26T01:00:10.000Z')
  })
})

describe('the program facts behind turn, trigger and last_turn', () => {
  const rowMain = (state: string, prompt: string | null, ts: string) => ({ row: { rec: 'main', id: 'g1', state, prompt_id: prompt, ts, pid: 7 }, line: { state, ...(prompt ? { prompt_id: prompt } : {}) } })
  function tapRig() {
    let gen: any = { rec: 'main', id: 'g1', state: 'idle', pid: 7 }
    const facts = new DeliveryFacts({ agent: 'adam', sink: () => {} })
    const trig = (r: any) => r.kind === 'joey' ? { trigger: { kind: 'message' as const, conversation_id: String(r.notif.params.meta.chat_id), message_id: String(r.notif.params.meta.message_id) }, thread: 'adam#t-joey' }
      : { trigger: { kind: 'thread' as const, thread_id: 'adam#t-call' }, thread: 'adam#t-call' }
    const tap = new LanesTap({ facts, joey: () => null, gen: () => gen, changed: () => {}, trigger: trig })
    const main = (state: string, prompt: string | null, ts: string) => { gen = { ...gen, state, prompt_id: prompt, ts }; const m = rowMain(state, prompt, ts); tap.journal({ ...gen, ...m.row } as any, m.line) }
    const msg = (kind: string, id: string) => ({ rec: 'msg', id, kind, notif: { params: { meta: { chat_id: '1828', message_id: id } } }, ts: 'x' }) as any
    const bind = (kind: string, prompt: string, id: string) => tap.journal(msg(kind, id), { state: 'bound', prompt_id: prompt })
    const queue = (kind: string, id: string) => tap.journal(msg(kind, id), { state: 'queued' })
    const offer = (items: Array<[string, string]>) => { for (const [kind, id] of items) tap.journal(msg(kind, id), { state: 'offered', gen: 'g1' }) }
    return { tap, main, bind, queue, offer, event: (b: any) => tap.mainEvent({ pid: 7, ...b }) }
  }
  test('lanes on: the open turn (its prompt), what opened it (the first item bound to it), how the last one ended: done, interrupted (Esc), interrupted (a new prompt with no Stop), failed', () => {
    const r = tapRig()
    r.bind('joey', 'p1', 'm1'); r.main('in_turn', 'p1', '2026-11-26T01:00:00.000Z'); r.bind('peer', 'p1', 'm2')
    expect(r.tap.turnFacts()).toEqual({ id: 'p1', started_at: '2026-11-26T01:00:00.000Z', trigger: { kind: 'message', conversation_id: '1828', message_id: 'm1' }, thread: 'adam#t-joey' })
    r.main('idle', null, '2026-11-26T01:00:09.000Z')
    expect(r.tap.turnFacts()).toBeNull()
    expect(r.tap.lastTurn()).toEqual({ id: 'p1', outcome: 'done', ended_at: '2026-11-26T01:00:09.000Z' })
    // a colleague's call opens the next turn; Esc: M2 closes it (statusIdle), the wrap-up tells a Stop with interrupted
    r.bind('peer', 'p2', 'm3'); r.main('in_turn', 'p2', '2026-11-26T01:01:00.000Z')
    expect(r.tap.turnFacts()!.trigger).toEqual({ kind: 'thread', thread_id: 'adam#t-call' })
    r.main('idle', null, '2026-11-26T01:01:05.000Z'); r.event({ event: 'Stop', phase: 'final', interrupted: true })
    expect(r.tap.lastTurn()).toEqual({ id: 'p2', outcome: 'interrupted', ended_at: '2026-11-26T01:01:05.000Z' })
    // a turn the main began itself (nothing bound): other; a new prompt while it never ended: interrupted
    r.main('in_turn', 'p3', '2026-11-26T01:02:00.000Z')
    expect(r.tap.turnFacts()!.trigger).toEqual({ kind: 'other' })
    r.main('in_turn', 'p4', '2026-11-26T01:02:30.000Z')
    expect(r.tap.lastTurn()).toEqual({ id: 'p3', outcome: 'interrupted', ended_at: '2026-11-26T01:02:30.000Z' })
    // StopFailure (before M2's row) then the wall: failed
    r.event({ event: 'StopFailure' }); r.main('walled', null, '2026-11-26T01:03:00.000Z')
    expect(r.tap.lastTurn()).toEqual({ id: 'p4', outcome: 'failed', ended_at: '2026-11-26T01:03:00.000Z' })
  })
  test("the turn after Esc (lab 00:50:04Z): Joey's next message is offered and the cut item rides it; the cut item is bound first, the message opened the turn", () => {
    const r = tapRig()
    r.main('idle', null, '2026-11-26T01:05:00.000Z')
    r.queue('joey', 'm701')                                                  // the next message comes in
    r.offer([['joey', 'm701'], ['joey', 'm700'], ['digest', 'd1']])          // M1: the lead first, then what rides it
    r.bind('joey', 'p9', 'm700'); r.bind('digest', 'p9', 'd1'); r.bind('joey', 'p9', 'm701')
    r.main('in_turn', 'p9', '2026-11-26T01:05:01.000Z')
    expect(r.tap.turnFacts()!.trigger).toEqual({ kind: 'message', conversation_id: '1828', message_id: 'm701' })
    // a turn the main runs anyway pulls an item at a boundary: it opened nothing
    r.main('idle', null, '2026-11-26T01:06:00.000Z')
    r.main('in_turn', 'p10', '2026-11-26T01:06:01.000Z')
    r.tap.journal({ rec: 'msg', id: 'm702', kind: 'joey', notif: { params: { meta: { chat_id: '1828', message_id: 'm702' } } }, ts: 'x' } as any, { state: 'bound', prompt_id: 'p10', via_pull: true })
    expect(r.tap.turnFacts()!.trigger).toEqual({ kind: 'other' })
  })
  test("a turn that goes on after its Stop (another Stop hook held it; chiron 01:23–01:42Z, Chiron WO-169 01:47Z B): never its own last_turn", () => {
    const r = tapRig()
    const o = () => { const t = r.tap.turnFacts()                           // as server.ts recordFacts() hands them over
      return obs(V('working'), ST, prog('busy', TOOL), F({ turn: t && { id: t.id, started_at: t.started_at, trigger: t.trigger }, turn_thread: t?.thread ?? null, last_turn: r.tap.lastTurn() })) }
    r.main('in_turn', 'p0', '2026-11-26T01:20:00.000Z'); r.main('idle', null, '2026-11-26T01:21:00.000Z')
    r.bind('joey', 'p1', 'm1'); r.main('in_turn', 'p1', '2026-11-26T01:23:39.000Z')
    r.main('idle', null, '2026-11-26T01:27:00.000Z')                         // the Stop: as far as anyone can tell then, p1 ended
    expect(r.tap.lastTurn()).toEqual({ id: 'p1', outcome: 'done', ended_at: '2026-11-26T01:27:00.000Z' })
    r.main('in_turn', 'p1', '2026-11-26T01:27:08.000Z')                      // lanes-main continueTurn: the same prompt runs again
    expect(main(o())).toMatchObject({ activity: 'running', turn: { id: 'p1', started_at: '2026-11-26T01:23:39.000Z' },
      last_turn: { id: 'p0', outcome: 'done', ended_at: '2026-11-26T01:21:00.000Z' } })   // obs(): the contract's rule holds (checkObservation)
    r.main('idle', null, '2026-11-26T01:42:00.000Z')                         // its real end
    expect(r.tap.lastTurn()).toEqual({ id: 'p1', outcome: 'done', ended_at: '2026-11-26T01:42:00.000Z' })
    r.main('in_turn', 'p2', '2026-11-26T01:43:00.000Z')
    expect(main(o()).last_turn).toEqual({ id: 'p1', outcome: 'done', ended_at: '2026-11-26T01:42:00.000Z' })
    // the first turn of the daemon's life goes on: no turn before it, no last_turn
    const q = tapRig()
    q.main('in_turn', 'p5', '2026-11-26T01:50:00.000Z'); q.main('idle', null, '2026-11-26T01:50:30.000Z'); q.main('in_turn', 'p5', '2026-11-26T01:50:31.000Z')
    expect(q.tap.lastTurn()).toBeNull()
    const bad = o(), m = main(bad)
    m.turn = { ...m.turn, id: 'p1' }                                        // what chiron showed at 01:37Z: the checker's port catches it
    expect(checkObservation(bad)).toEqual(['main: the open turn p1 is also last_turn'])
  })
  test('lanes off: the transcript\'s turn, opened by the first Joey message it took in; turn_duration ends it as done', () => {
    const facts = new DeliveryFacts({ agent: 'adam', sink: () => {} })
    const w = new TurnWatch({ dir: () => null, facts, joey: (m: any) => m?.chat_id ? { chat: String(m.chat_id), id: String(m.message_id) } : null, changed: () => {} })
    const tag = (id: string) => `<channel source="plugin:telegram-http:telegram-http" chat_id="1828" message_id="${id}" user="joey" user_id="1828" ts="x">\nhi\n</channel>`
    w.handle({ type: 'user', message: { role: 'user', content: tag('77') }, timestamp: '2026-11-26T01:00:00.000Z' })
    w.handle({ type: 'user', message: { role: 'user', content: tag('78') }, timestamp: '2026-11-26T01:00:01.000Z' })
    expect(w.turnFacts()).toEqual({ id: `turn-${Date.parse('2026-11-26T01:00:00.000Z')}`, started_at: '2026-11-26T01:00:00.000Z', trigger: { kind: 'message', conversation_id: '1828', message_id: '77' }, thread: null })
    w.handle({ type: 'system', subtype: 'turn_duration', durationMs: 900, timestamp: '2026-11-26T01:00:05.000Z' })
    expect(w.turnFacts()).toBeNull()
    expect(w.lastTurn()).toEqual({ id: `turn-${Date.parse('2026-11-26T01:00:00.000Z')}`, outcome: 'done', ended_at: '2026-11-26T01:00:05.000Z' })
  })
  test('the queue (lanes off): not yet handed in / handed in, not yet in a turn', () => {
    const facts = new DeliveryFacts({ agent: 'adam', sink: () => {} })
    facts.delivered('1828', '1'); facts.delivered('1828', '2'); facts.delivered('1828', '3')
    facts.inSession('1828', '2', 'main', new Date().toISOString()); facts.inSession('1828', '3', 'main', new Date().toISOString()); facts.seen('1828', '3', 'main', new Date().toISOString())
    expect(facts.counts()).toEqual({ pending: 1, unread_by_member: 1 })
  })
})

// the rules' one copy (Chiron WO-169 01:47Z: rescue-site/onsen-ui/fixtures/v1/status_v1_check.py, which validate.py calls), when it is on this machine:
// every observation the tests above made passes it too (the tests run in order within this file)
const CHECKER = join(homedir(), 'rescue-site', 'onsen-ui', 'fixtures', 'v1', 'status_v1_check.py')
const PY = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' }).status === 0
test.skipIf(!PY || !existsSync(CHECKER))("every observation above passes Chiron's status_v1_check.py (--observation)", () => {
  expect(ALL.length).toBeGreaterThan(20)
  const prog = 'import json,sys,importlib.util\nspec=importlib.util.spec_from_file_location("c",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n' +
    'print(json.dumps([m.check_status(o,observation=True)[0] for o in json.load(sys.stdin)],ensure_ascii=False))'
  const r = spawnSync('python3', ['-I', '-c', prog, CHECKER], { input: JSON.stringify(ALL), encoding: 'utf8', maxBuffer: 16 << 20 })
  expect(r.status).toBe(0)
  const got = JSON.parse(r.stdout) as string[][]
  expect(got.map((p, i) => p.length ? { i, p, o: ALL[i] } : null).filter(Boolean)).toEqual([])
})
