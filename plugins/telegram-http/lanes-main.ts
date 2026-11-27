/**
 * lanes-main.ts — M1 (the delivery ledger) and M2 (the main record). docs/state-journal.md has the journal shapes.
 *
 * M2. The main is one record per process ("gen", id = its pid): starting | idle | in_turn(prompt_id, tool_open) | walled(kind) | gone(end_reason).
 *     The session registry can supply a missing gen. Its turn edges come from the main's hooks, and a dead pid ends it even without a hook.
 *     The main's wall is ITS record (PL4): an account-kind StopFailure walls it and starts a wall episode (wall_since); it leaves `walled` only on its
 *     own next hook event, and the episode ends at its next Stop. The lanes' wall (lanes.ts S.wall) is another record and never moves this one.
 *     A walled gen is offered one item when its retry time comes (its probe): that offer is how the main's own hook events resume.
 * M1. One record per item meant for the main: queued → offered(gen) → bound(gen, prompt_id) → done.
 *     The one rule: an item is done only when the turn it was bound to ends with Stop. How a turn that had no normal end ended decides the rest
 *     (WO-201, Chiron mesh-13184): a compaction inside it is no end (the turn goes on); no genuine model output after the item was bound (liveness.ts,
 *     the shared predicate): offered once more (settle; a non-account StopFailure: after a backoff, with a cap: failTurn); output already there (the
 *     process gone, another session, a non-account StopFailure): an interrupted turn's (holdCut: it rides the next delivery with the interrupted line).
 *     A turn of a prompt ends at its LAST Stop: other Stop hooks (the user's, run in parallel with ours) can block a Stop ours let through,
 *     and the turn goes on under the same prompt_id. So a Stop leaves the gen idle with `stopped_prompt`,
 *     and any later hook event of that prompt in that gen re-opens the turn: M2 back to in_turn, the items done at that Stop back to bound
 *     (reason turn_continued). They end at the turn's next Stop like any bound item. An idle main is offered one item (it opens the turn); a busy main is never pushed to: its hook
 *     pulls queued items at the next tool boundary (PostToolUse) or at Stop, and they are bound to that prompt at that moment.
 *     WO-177 一: WHETHER the main can take an item now is the status record's (canTake: its member state is idle); M2 says only HOW (offer to an idle gen,
 *     pull into a turn) and keeps the turn's edges. Held items stay queued and are offered the moment the record turns idle.
 * One writer: the tg daemon. Information (the digest) is never offered alone: it rides the next offer or pull.
 */
import type { Journal, Row } from './lanes-state.ts'
import { BOUNDARY_MAIN_RULE, boundaryCardOn, decisionMainRule, decisionsOn, deferDecisionsOn, deferMainRule } from './lanes-boundary.ts'
import { genuineAssistantAfterFile } from './liveness.ts'

import type { CallCheck, CallWait } from './onsen-client.ts'
import { REG_SETTLE_MS, type Registry } from './onsen-status.ts'
import { hhmmTaipei, personCanProbe } from './usage-wall.ts'

export type MainWall = { walled: boolean; clearedMs: number | null; lastWallMs?: number | null; resets_at?: string | null }

export type Notif = { method: string; params: unknown }
export type ItemKind = 'joey' | 'peer' | 'alert' | 'digest' | 'handoff' | 'carry'
export type Via = 'tg' | 'inbox'
export type MainPhase = 'starting' | 'idle' | 'in_turn' | 'walled' | 'gone'
export type EndReason = 'asked' | 'killed' | 'exited' | 'replaced'
type CutTurn = { at: number; why: string; retry_at?: number; background_agents?: number }

export type MainEnv = {
  journal: Journal
  agent: string
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
  /** write one notification into the MCP stream of main process `pid` on daemon `via`; true = written into a stream the SDK holds (false: no such stream, nothing offered) */
  offer: (notif: Notif, via: Via, pid: number) => Promise<boolean>
  /** the tg daemon's SDK transport holds a GET stream of process `pid` (an offer can be written): the one signal that a starting gen can take input */
  streamOpen: (pid: number) => boolean
  /** the information that rides a delivery (the digest): its text and its item fields (`events`: event id → the record version shown; `items`); null = nothing new */
  info: () => { text: string; fields: Record<string, unknown> } | null
  /** an item reached done */
  done: (item: Row) => void
  /** an item left done: its turn went on after the Stop that closed it (whatever `done` set is undone) */
  undone: (item: Row) => void
  /** a line to Joey from the router (push), with the rule that sent it; `events`: the M3 events the line is about (it meets their Joey line) */
  tellJoey: (text: string, rule: string, events?: string[]) => void
  /** the backoff before the walled main's next probe offer (ms), after `probes` failed ones */
  wallBackoff?: (kind: string, probes: number) => number
  /** WO-120: the agent's usage-wall state (usage_wall.py, read by usage-wall.ts) for the wall episode that began at `wallSinceMs`: 'walled' = the
   *  keeper probes outside the session, so no item is fed to the wall; cleared (clearedMs) = its probe (or a genuine turn) got an answer: one
   *  offer now, once per clear (a failed offer then waits for retry_at or a newer clear); null = no fresh state: the PL4 probe as before */
  usageWall?: (wallSinceMs: number) => MainWall | null
  callId?: (event: string) => string | undefined
  checkCall?: (id: string, why: CallWait, item: Row) => Promise<CallCheck>
  /** Persist the blocked receipt for a person's bound delivery, ordered with its other delivery facts. */
  blocked?: (item: Row, retryAfter: string | null) => void
  /** the session id the keeper launched (.lanes/main-expected), or a renew in progress */
  expectedSession: () => string[]
  registry?: Pick<Registry, 'mainForAdoption' | 'backgroundAgents'>
  /** 002v: the accepted main's session id is the expected one from now on (.lanes/main-expected): a /clear's new session survives a restart */
  expect?: (sid: string) => void
  pidAlive: (pid: number) => boolean
  /** a SessionStart that is not the main was refused */
  refused: (sid: string, pid: number | null, reason: string) => void
  /** the main process changed (the MCP sessions of the old one lose the main's tools) */
  genChanged: (pid: number | null) => void
  /** the limit-menu pane read (a TUI state no hook reports): a sentence for Joey, or null. drive = choose the option that waits or continues (the
   *  walled main's probe: a menu it is parked on is dealt with before anything is offered to it) */
  menu?: (drive?: boolean) => Promise<{ text: string; asks: boolean } | null>
  /** the registration context an accepted main gets */
  context: (agent: string, sid: string) => string
  /** PL7 (M4): an item is owed to the main (offered, pulled; the wake) only while it carries an open M3 main obligation (lanes.ts). Without it: every
   *  item but the digest (a unit of M1 alone) */
  owed?: (item: Row) => boolean
  /** 002q (M3), 002w (B): of these events, what the main still owes on each (a Joey line, a peer's answer, a scheduler receipt: handed to it, or open on
   *  what it owns), the rule the lane stop applies to a lane: the Stop check's facts, one entry per event, `owes` naming each */
  mainOwed?: (events: string[]) => Array<{ id: string; from: string; text: string; owes: string[]; kinds?: string[] }>
  /** the memory gate's facts (M3): the open Joey-sourced proposals, and whether a curator lane holds the write right */
  memory?: () => { proposals: Array<{ id: string; ts: string; lane: string; text: string }>; curator: boolean }
  /** 002v (C04): of these events, the senders of those the router's thread gate stopped (the event record's `stop`): the main's answer to them
   *  in the turn that took the stop in is the last line of that conversation, so the router marks it no_reply ("不用回" is the router's) */
  stoppedPeers?: (events: string[]) => string[]
  /** lanes-golive (A5): the btcc id of the newest of these events from `peer` that the thread gate stopped (the call the main's answer quotes), or null */
  stoppedRequest?: (events: string[], peer: string) => string | null
  /** 002w (D): a tool call of the main went through (its PostToolUse): the daemon meets what it completed (a scheduler receipt) */
  toolDone?: (name: string, input: any, response: string, error: boolean) => void
  /** 002w (D): a tool call of the main the daemon refuses before it runs (a scheduler run completed twice): the hook's deny reason, or null */
  toolGate?: (name: string, input: any) => string | null
  /** lanes-golive (C3): items the main's turn took in (bound: offered and opened a turn, or pulled at a boundary): with lanes on this is the one evidence
   *  that the main has a delivery (the fleet's transcript receipt is not read for it), e.g. a scheduler run's start receipt */
  bound?: (items: Row[]) => void
  /** WO-128 (item 9): M1 offered an idle (or walled, its probe) main an item: one wake of the main */
  woke?: (item: Row, o: { gen: string; probe: boolean }) => void
  /** WO-128 (item 4): what waits on the main's decision in its mailbox, as lines for the context the main gets back (registration, a resumed main's first
   *  prompt, after a compaction); '' = nothing to add */
  mailbox?: () => Promise<string>
  /** WO-177 一 (Chiron's ticket; Joey TG chiron:2485, 2515): the status record's member state now, as decideWake reads it (lanes.ts memberNow: statusOf's
   *  state through the screen judge, its detail's walled / compacting as states of their own). It is the one answer to 「can the main take an item now」
   *  (canTake: 'idle', which takes in idle with background and interrupted). null: no status record here (Onsen step 3 off): M2's phase answers */
  memberState?: () => string | null
  /** WO-181 (Chiron): the unread mentions of this agent in Onsen (onsen-mentions.ts), fetched when a delivery is about to go to the main, as one block that
   *  rides with the digest (the same place, the same go); resolves null: none, or Onsen did not answer in time. Returns null at once when switched off
   *  (nothing is awaited: the delivery goes exactly as without it). Never wakes the main by itself */
  mentions?: () => Promise<{ text: string; posts: string[] } | null> | null
  /** WO-181: the delivery carrying these mention posts reached the main (offered into its session, or pulled into its turn): they are marked read */
  mentionsDelivered?: (posts: string[]) => void
  /** WO-201: the ms of the first genuine assistant record the transcript `path` has after `sinceMs` (0: none; null: cannot tell). Default: liveness.ts
   *  genuineAssistantAfterFile (the fleet's one predicate). Tests pass real transcript files; this is the seam, not a second definition */
  genuineAfter?: (path: string, sinceMs: number) => number | null
}

export type MainEvent = {
  event: string; session_id?: string; prompt_id?: string; pid?: number; transcript_path?: string; source?: string
  error?: string; tool_name?: string; tool_timeout_ms?: number; tool_input?: any; tool_brief?: Record<string, string>; tool_response?: string; tool_error?: boolean; dids?: string[]; phase?: 'check' | 'final'; reason?: string
  /** 002r: the event fired inside a subagent of the main (the hook input's agent_id): not the main's turn */
  sub?: boolean
}
/** PL5: the turn the main's aids judge, from M1/M2 (they read no transcript): its prompt, when it and the turn before it started, the items bound to
 *  it (the digest's content is the digest), and its tool calls with their results (main-hook.py posts every PostToolUse) */
export type Turn = { prompt_id: string; started_at: string | null; prev_started_at: string | null
  items: Array<{ id: string; kind: string; content: string; user: string }>; calls: Array<{ name: string; input: any; result: string; error: boolean }> }
type AidItem = { mid: string; kind: string; user: string; no_reply: boolean; system: boolean; body: string }
export type MainReply = { accepted?: boolean; additionalContext?: string; block?: string; turn?: Turn; proposals?: unknown[]; curator?: boolean
  items?: AidItem[]; outputs?: Output[]; context?: { items: AidItem[]; outputs: Output[] }; mark_no_reply?: string; mark_reply_to?: string; deny?: string }
type Output = { to: string; reply_to: string; text: string }

const num = (k: string, d: number): number => { const n = Number(process.env[k] ?? d); return Number.isFinite(n) ? n : d }
/** 疑似卡死: a gen that owes a hook event (a turn open, or an offer unbound) has sent none for this long */
export let MAIN_STUCK_MS = num('LANES_MAIN_STUCK_MS', 600_000)
/** WO-164: how long a batched item waits for a delivery before it leads one itself (LANES_DEFER_MAX_WAIT_S, the cards' batch window; 0 = no limit) */
export const batchWaitMs = (): number => { const n = num('LANES_DEFER_MAX_WAIT_S', 2700); return n > 0 ? n * 1000 : 0 }
/** WO-157b (Chiron status-latency-lab, 「會判錯的」 3): how long statusOf must keep reading idle, with no hook event of the gen meanwhile, before a turn M2
 *  still holds open is closed as interrupted (Esc fires no Stop: the lab measured M2 in_turn 131 s while the session file, the screen and statusOf said idle
 *  0.4–0.6 s after the key) */
export let MAIN_IDLE_CONFIRM_MS = num('LANES_MAIN_IDLE_CONFIRM_MS', 4_000)
export const __setMainIdleConfirmMs = (ms: number): void => { MAIN_IDLE_CONFIRM_MS = ms }
export const __setMainStuckMs = (ms: number): void => { MAIN_STUCK_MS = ms }
/** 002x: the offer's own bound. An idle gen binds an offer within two seconds (1,304 offers of 002v and 002w: the slowest took 1.6 s); one still
 *  unbound after this long was lost on the client side (002w r1 A05, r2 I04: written half a second after the gen's stream opened, never bound, and
 *  it waited for the stuck episode: MAIN_STUCK_MS, ten minutes outside the lab). It is written once more, and nobody is told */
export let OFFER_LEASE_MS = num('LANES_OFFER_LEASE_MS', 20_000)
export const __setOfferLeaseMs = (ms: number): void => { OFFER_LEASE_MS = ms }
/** WO-157c (Chiron, WO-157 15:25Z, his words): the line in front of an item whose turn was interrupted (Esc, or a turn that never ended normally) when it
 *  reaches the main again */
export const INTERRUPTED_LINE = '〔這一則你做到一半被中斷了（有人在你的畫面按了 Esc，或那一回合沒有正常結束）。中斷之後 Joey 說了新的，就照新的。沒有說，就回寄件人一句停在哪一步，不要自己把被中斷的動作重做一次。〕'
/** WO-201 (Chiron resend audit 2026-11-27, rule 3, point 2): how many times an item read into a turn that was then cut (its gen ended, or its process started
 *  another session) before the model said anything after it is offered to the next one. Cut the same way once more, it is closed (done, reason cut_twice)
 *  and Joey is told which: it is not offered a third time */
export const CUT_REOFFERS = 1
/** WO-201 (point 4, inventory L5): the failed turns (a StopFailure that is not an account kind: server_error, an overload, unknown) an item may have
 *  before it is parked and the stuck path takes it. Between two, it waits wallBackoff(err, n): the main wall's own base for these kinds (LANES_WALL_PROBE_MS,
 *  300 s), not the next 5-second pump */
export let MAIN_FAIL_MAX = num('LANES_MAIN_FAIL_MAX', 3)
export const __setMainFailMax = (n: number): void => { MAIN_FAIL_MAX = n }
const BODY_MAX = 4000
/** the first words of an event's text (the Stop check names each event it holds the turn for) */
const firstWords = (t: string): string => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > 30 ? `${s.slice(0, 30)}…` : s }
const WALL_WORD: Record<string, string> = { rate_limit: '模型額度用完了', authentication_failed: '模型登入失效', billing_error: '模型帳務出錯', account_on_hold: '模型帳號被暫停',
  oauth_org_not_allowed: '模型帳號不被允許', cloud_credential_error: '模型憑證出錯' }


export type MainApi = ReturnType<typeof createMain>
/** one M1 + M2 per lanes instance (the tg daemon has one; tests load several) */
export function createMain(E: MainEnv) {
  let cur: string | null = null                           // the live gen (id = pid as text)
  let registryGap: { since: number; told: boolean } | null = null
  const lastEventAt = new Map<string, number>()          // gen → ms of its last hook event (silence = the stuck rule)
  const toolBound = new Map<string, number>()            // gen → ms the open tool may stay silent: its own declared timeout (0 = it declares none)
  const pendingEnd = new Map<string, EndReason>()        // gen → why it is about to end (asked: /restart; replaced: /main renew)
  const outputs = new Map<string, Output[]>()            // prompt id → the reply / send_to_agent calls of that turn (answered gate)
  const calls = new Map<string, Turn['calls']>()          // prompt id → every tool call of that turn with its result (the summary gate)
  const starts = new Map<string, { prompt: string; at: string; prev: string | null }>()   // gen → its running turn's start, and the start of the turn before
  const openTools = new Map<string, { name: string; input: any; at: string }>()   // WO-148 (item 3): gen → the tool its turn has open now (PreToolUse → PostToolUse)
  // 002v (002s r2 G02, u002s-G02-s2-r2-20261119-221622): gen → the work its turns carry on: the items of the last turn that took any in, and every
  // output since. A turn that takes in nothing (a background task's notification opened it, Claude Code starts it on its own) continues that work:
  // the last-words check reads the work's messages and outputs for it (that turn ended on Joey's 194, never sent, and had no items to ask about).
  // 002w (B): the work keeps its item ids and their event ids, so every per-turn duty of such a turn reads them (turnWork).
  const work = new Map<string, { items: AidItem[]; outputs: Output[]; ids: string[]; events: string[] }>()
  /** the stuck episode: a live gen silent too long; or (002w E) `undelivered`: owed items nobody could take (no live gen, or one that cannot be offered them) */
  let stuck: { gen: string | null; prompt: string | null; at: number; undelivered?: boolean } | null = null
  let offering = false
  // A final Stop can arrive during an awaited stream write. Its cleared guard must stay cleared.
  let finalStops = 0
  let wallWakePending = false
  let seq = 0
  let restoredThrough = 0

  const J = (): Journal => E.journal
  const aidItem = (r: Row): AidItem => { const m = metaOf(r.notif); return { mid: m.message_id || m.btcc_msg_id || r.id, kind: m.message_id ? 'tg' : m.btcc_msg_id ? 'mesh' : 'sys',
    user: String(m.user ?? ''), no_reply: m.no_reply === 'true', system: m.user === 'lanes' || r.kind === 'handoff' || r.kind === 'carry', body: contentOf(r).slice(0, BODY_MAX) } }
  /** boot: fold done by the caller (journal.load); pick the live gen */
  function initMain(): void {
    cur = null; registryGap = null; stuck = null; offering = false; takeSince = null; hookOut.clear()
    lastEventAt.clear(); pendingEnd.clear(); outputs.clear(); calls.clear(); starts.clear(); work.clear(); openTools.clear()
    const live = J().rows('main', r => r.state !== 'gone')
    for (const g of live.slice(0, -1)) endGen(g, 'replaced')            // only one gen can be live
    const g = live[live.length - 1]
    if (g) { cur = g.id; lastEventAt.set(g.id, Date.now()) }
    const restored = J().rows('msg')
    restoredThrough = restored.at(-1)?.n ?? 0
    seq = restored.length
  }

  // ------------------------------------------------------------------ M2 queries (everything else asks these)
  function currentGen(): Row | null { return cur ? J().get('main', cur) ?? null : null }
  function mainPid(): number | null { const g = currentGen(); return g ? Number(g.pid) : null }
  function mainPhase(): MainPhase { return (currentGen()?.state as MainPhase) ?? 'gone' }
  /** WO-132 (item 3): when the main's running turn started (this daemon saw its first hook event), or null (not in a turn, or begun before this daemon) */
  function turnStart(): string | null { const g = currentGen(); const st = g ? starts.get(g.id) : undefined; return g && g.state === 'in_turn' && st && st.prompt === g.prompt_id ? st.at : null }
  /** WO-148 (item 3): the tool the main's running turn has open now (name, input, since when), or null; seen by this daemon's hooks only */
  function openTool(): { name: string; input: any; at: string } | null {
    const g = currentGen()
    return g && g.state === 'in_turn' && g.tool_open ? openTools.get(g.id) ?? null : null
  }
  /** the main is there: a live gen that is not walled */
  function mainUp(): boolean { const p = mainPhase(); return p === 'idle' || p === 'in_turn' || p === 'starting' }
  function mainSession(): { session_id: string; pid: number; transcript_path: string } | null {
    const g = currentGen()
    return g ? { session_id: String(g.session_id ?? ''), pid: Number(g.pid), transcript_path: String(g.transcript_path ?? '') } : null
  }
  /** the main's process is about to end for this reason (/restart and /kill_stuck: asked; /main renew: replaced) */
  function markEnd(reason: EndReason): void { if (cur) pendingEnd.set(cur, reason) }

  // ------------------------------------------------------------------ WO-177 一: can the main take an item now (the status record)
  /** the status record's member state now (null: no record here) */
  function member(): string | null { try { return E.memberState?.() ?? null } catch { return null } }
  /** since when the status record has said, without a break, that gen `gen` can take an item (ms). The offer's lease and the untaken items' clock count
   *  only this time (null: it does not say so now, or there is no record) */
  let takeSince: { gen: string; at: number } | null = null
  /** the one answer to 「can the main take an item now」 (WO-177 一): the status record says idle (idle with background and interrupted included). The
   *  offer, its lease and the stuck alarms ask this; M2's phase only says HOW an item reaches the main (an idle gen is offered one, which opens its turn;
   *  a gen in a turn pulls at its next tool boundary or Stop) and keeps the turn's edges. No record here (Onsen step 3 off): M2 idle, as before */
  function canTake(g: Row, now = Date.now()): boolean {
    const m = member()
    if (m == null) { takeSince = null; return g.state === 'idle' }
    if (m !== 'idle') { takeSince = null; return false }
    if (!takeSince || takeSince.gen !== g.id) takeSince = { gen: g.id, at: now }
    return true
  }
  /** WO-200: M2 can still say walled after the keeper cleared, or be idle when the keeper first reports a wall. */
  function wallDelivery(g = currentGen()) {
    const wall = E.usageWall?.(Date.parse(String(g?.wall_since ?? '')) || 0)
    const refused = Number(g?.wall_refused_at ?? 0)
    const observed = g?.wall_clear_at as number | null | undefined
    const clear = wall?.walled ? null : wall?.clearedMs != null && wall.clearedMs >= refused ? wall.clearedMs : observed ?? null
    const active = !!wall?.walled || (g?.state === 'walled' && clear == null) || member() === 'walled'
    const last = Math.max(wall?.lastWallMs ?? 0, refused)
    // If the keeper is absent, M2 retains its existing account probe. A keeper clear authorizes one offer.
    const probe = g?.state === 'walled' && !wall?.walled && ((!wall && Date.now() >= Number(g.retry_at ?? Infinity)) || (clear ?? 0) > Number(g.uw_clear_used ?? 0))
    return { active, person: active && personCanProbe(last || null), clear, probe }
  }
  const accountFailure = (reason: unknown): boolean => typeof reason === 'string' && reason.startsWith('stop_failure:') && ACCOUNT_WALL.has(reason.slice('stop_failure:'.length))
  const accountCut = (r: Row): boolean => heldCut(r) && accountFailure(r.cut_by)
  /** An item already refused or interrupted by this wall waits for the clear. */
  function wallAllows(r: Row, wall: ReturnType<typeof wallDelivery>): boolean {
    if (!wall.active) return true
    // A queued refusal from an older journal only carries its stop_failure reason.
    const refused = accountFailure(r.reason) || accountCut(r)
    return wall.person && r.kind === 'joey' && !refused
  }
  /** WO-177 一: mainCanTake() for the live gen (false: no gen) */
  function mainCanTake(): boolean { const g = currentGen(); return !!g && canTake(g) }
  /** WO-177 一: what M1 does with an item for the main now: 'offer' (an idle gen the record says can take one), else why it waits: M2's phase (in_turn: it
   *  pulls at its next boundary; walled; starting; gone) or, for an idle gen, the record's member state (waiting, walled, compacting, busy, …) */
  function deliveryNow(): string {
    const g = currentGen()
    if (!g) return 'gone'
    if (g.state !== 'idle') return String(g.state)
    return canTake(g) ? 'offer' : member() ?? String(g.state)
  }
  /** WO-177 一: the status record changed (lanes.ts mainStatusChanged, at each record server.ts hands out whose member state or interruption differs): an
   *  item held while the main could not take it is offered at that moment, not at the next tick */
  function statusChanged(clearedMs?: number | null): void {
    const g = currentGen()
    // The keeper timestamps a clear to whole seconds. Preserve an observed transition even when
    // the local refusal has milliseconds in that same second, and after the keeper file ages out.
    if (g?.state === 'walled' && clearedMs != null && clearedMs >= Math.floor(Number(g.wall_refused_at ?? 0) / 1000) * 1000) {
      J().write('main', g.id, 'walled', { wall_clear_at: clearedMs })
    }
    if (g) canTake(g)
    void pump(clearedMs != null ? 'wall-clear' : undefined)
  }

  // ------------------------------------------------------------------ M1
  let didSeq = 0
  const newId = (): string => `m-${Date.now().toString(36)}-${(++didSeq).toString(36)}`
  const items = (pred: (r: Row) => boolean): Row[] => J().rows('msg', pred)
  const itemCount = (rs: Row[]): number => rs.filter(r => r.kind !== 'digest').length
  const unsettled = (g: Row, p?: string): Row[] => items(r => (r.state === 'offered' || r.state === 'bound') && r.gen === g.id && (!p || r.prompt_id === p))
  const metaOf = (n: Notif): Record<string, string> => (((n?.params ?? {}) as any).meta ?? {}) as Record<string, string>
  /** queue an item for the main. `target` = only the gen with this session id may take it (a renew brief is for the new main). */
  function enqueue(kind: ItemKind, notif: Notif, o: { via?: Via; event?: string | null; target?: string; fields?: Record<string, unknown>; batched?: boolean } = {}): string {
    const id = newId()
    const params = { ...((notif.params ?? {}) as Record<string, unknown>) }
    params.meta = { ...metaOf(notif), did: id }
    const g = currentGen()
    const callId = o.fields?.call_id ?? (o.event ? E.callId?.(o.event) : undefined)
    let waited: CallWait | undefined
    if (callId) {
      if (!g || g.state === 'starting' || member() === 'offline') waited = 'offline'
      else if (wallDelivery(g).active) waited = 'wall'
    }
    J().write('msg', id, 'queued', { kind, ...(callId ? { call_id: callId, queued_gen: g?.id, waited } : {}), via: o.via ?? 'tg', event: o.event ?? null, ...(o.target ? { target: o.target } : {}), notif: { method: notif.method, params }, ...(o.fields ?? {}),
      ...(o.batched ? { reason: 'batched', batched_at: new Date().toISOString() } : {}) })
    seq++
    if (kind === 'digest') J().write('wake', id, 'no_wake', { reason: 'information: rides the next delivery' })
    else if (o.batched) J().write('wake', id, 'no_wake', { reason: `batched: rides the next delivery to the main and never wakes it alone${batchWaitMs() ? ` (it leads one after ${Math.round(batchWaitMs() / 60_000)} min)` : ''}` })
    else if (!g || g.state !== 'idle') J().write('wake', id, 'no_wake', { reason: !g ? 'main gone: offered to the next gen' : g.state === 'in_turn' ? 'main in a turn: pulled at its next tool boundary or Stop' : `main ${g.state}` })
    else if (!canTake(g)) J().write('wake', id, 'no_wake', { reason: `main ${member()} (the status record): offered when the record says it can take it` })   // WO-177 一
    if (kind !== 'digest') void pump(kind === 'joey' ? 'person' : undefined)
    return id
  }
  const owed = (r: Row): boolean => E.owed ? E.owed(r) : r.kind !== 'digest'
  const forGen = (r: Row, g: Row): boolean => !r.target || r.target === g.session_id
  /** WO-157c (Chiron 15:25Z, 1): an item of a turn that was interrupted (Esc: statusIdle; a turn that never got Stop: beginTurn), queued again and waiting
   *  to ride the next thing the main is given (an offer, or a pull into a turn). It never opens a turn on its own: the main would start again what Joey
   *  just stopped. A colleague's, a scheduler's, an alert's item that no new turn took within MAIN_STUCK_MS is let go (tick: 'interrupted_untaken'). */
  const heldCut = (r: Row): boolean => r.state === 'queued' && r.reason === 'interrupted'
  /** WO-164 (Chiron: 「信交給主線名下的串是併批，不為它單獨叫醒」): a mail on a thread the main owns, queued batched. It rides the next thing the main is given
   *  (an offer, or a pull into a turn) and never opens a turn on its own, until it has waited LANES_DEFER_MAX_WAIT_S (the cards' batch window, 2700 s; 0 =
   *  no limit): then it leads one offer and every other batched item rides it (one wake for the batch) */
  const batchedRider = (r: Row, now = Date.now()): boolean => r.state === 'queued' && r.reason === 'batched'
    && !(batchWaitMs() > 0 && now - (Date.parse(String(r.batched_at ?? r.ts)) || now) >= batchWaitMs())
  /** WO-201 (point 4): an item whose turn failed (failTurn) waiting for its retry time (`fail_retry_at`), or parked at the cap (reason stop_failure_cap):
   *  neither offered nor pulled nor riding until then (the gen's next final Stop lets them go at once: releaseFailed) */
  const waitsRetry = (r: Row, now = Date.now()): boolean => r.state === 'queued' && (r.reason === 'stop_failure_cap' || Number(r.fail_retry_at ?? 0) > now)
  const queuedForOffer = (r: Row, g: Row): boolean => r.state === 'queued' && owed(r) && forGen(r, g) && !batchedRider(r) && !waitsRetry(r)
  /** the reason an offered item goes back with when nobody took the offer: a held item keeps its hold (it rides the next offer again) */
  const backReason = (r: Row, why: string): string => r.reason === 'interrupted' ? 'interrupted' : r.reason === 'batched' ? 'batched' : why
  /** an item that was in an interrupted turn: Chiron's line goes in front of it each time it reaches the main (cut_at, set when the turn was cut) */
  const cutText = (r: Row, text: string): string => r.cut_at ? `${INTERRUPTED_LINE}\n${text}` : text
  /** the digest that rides this delivery: the one queued digest item, refreshed, or a new one; null = nothing to tell. WO-181: `mb`, the unread mentions
   *  fetched for this delivery, ride in it as one block after the digest's own text (alone when the digest has nothing); the item keeps their posts
   *  (`mentions`), marked read once it reached the main */
  function attachInfo(mb: { text: string; posts: string[] } | null = null): Row | null {
    const inf = E.info()
    if (!inf && !mb) return null
    const text = [inf?.text, mb?.text].filter(Boolean).join('\n')
    const fields = { ...(inf?.fields ?? {}), mentions: mb ? mb.posts : null }
    const q = items(r => r.kind === 'digest' && r.state === 'queued')
    const notif = { method: 'notifications/claude/channel', params: { content: text, meta: { chat_id: 'lanes', user: 'lanes', user_id: 'lanes', via: 'lanes', kind: 'digest', no_reply: 'true' } } }
    if (q.length) {
      const d = q[q.length - 1]
      J().write('msg', d.id, 'queued', { notif: { ...notif, params: { ...notif.params, meta: { ...notif.params.meta, did: d.id } } }, ...fields })
      return J().get('msg', d.id)!
    }
    const id = enqueue('digest', notif, { fields })
    return J().get('msg', id)!
  }
  /** WO-181: the fetch of the unread mentions for a delivery about to go to the main; null: switched off (nothing to wait for). Never rejects */
  function mentionsNow(): Promise<{ text: string; posts: string[] } | null> | null {
    let p: Promise<{ text: string; posts: string[] } | null> | null = null
    try { p = E.mentions ? E.mentions() : null } catch (e) { E.log('warn', `lanes: mention cards: ${e}`) }
    return p ? p.catch(e => { E.log('warn', `lanes: mention cards: ${e}`); return null }) : null
  }
  /** WO-181: the digest `dg` reached the main: the mention posts it carried are marked read */
  function mentionsReached(dg: Row | null): void {
    const ps = dg && Array.isArray(dg.mentions) ? (dg.mentions as unknown[]).map(String).filter(Boolean) : []
    if (ps.length) { try { E.mentionsDelivered?.(ps) } catch (e) { E.log('warn', `lanes: mention cards: ${e}`) } }
  }
  function contentOf(r: Row): string { return String((r.notif?.params as any)?.content ?? '') }
  /** the turn of prompt `p` of gen `g`, for the main's aids */
  function turnOf(g: Row, p: string): Turn {
    const st = starts.get(g.id)
    return { prompt_id: p, started_at: st?.prompt === p ? st.at : null, prev_started_at: st?.prompt === p ? st.prev : null,
      items: items(r => (r.state === 'bound' || r.state === 'done') && r.gen === g.id && r.prompt_id === p).map(r => ({ id: r.id, kind: String(r.kind), content: contentOf(r), user: String(metaOf(r.notif).user ?? '') })),
      calls: calls.get(p) ?? [] }
  }

  /** 002w (B, gaps 8, 9): what a turn of the main works on: the items bound to prompt `p` (not the digest) and their events; a turn that took in nothing
   *  carries on the gen's work (the last turn that took items in: `carried`). Every per-turn duty reads this one set: the Stop check's hold, the last-words
   *  check's context, mark_no_reply, and (lanes.ts mainTurn) what the main's reply and send_to_agent meet. */
  function turnWork(g: Row, p: string): { items: Row[]; events: string[]; carried: boolean } {
    const its = items(r => (r.state === 'bound' || r.state === 'done') && r.gen === g.id && r.prompt_id === p && r.kind !== 'digest')
    const w = its.length ? undefined : work.get(g.id)
    const rows = w ? items(r => w.ids.includes(r.id)) : its
    return { items: rows, events: w ? w.events : [...new Set(its.map(r => String(r.event ?? '')).filter(Boolean))], carried: !!w }
  }
  /** Returns synchronously for ordinary deliveries. A Call lookup can overlap another hook; only the same queued version can be used. */
  function checked(rows: Row[], g: Row, clear: number | null): Row[] | Promise<Row[]> {
    const pending: Promise<void>[] = []
    const skip = new Set<string>()
    for (const r of rows) {
      const id = r.call_id ?? (r.event ? E.callId?.(String(r.event)) : undefined)
      if (!id || !E.checkCall) continue
      const why: CallWait | undefined = r.waited ?? (r.n <= restoredThrough ? 'restart'
        : r.queued_gen !== g.id || r.last_no_wake === 'unreachable' ? 'offline'
        : clear != null && clear >= Date.parse(r.created) ? 'wall' : undefined)
      if (!why) continue
      if (!r.waited) J().write('msg', r.id, 'queued', { waited: why })
      const version = r.version
      pending.push(E.checkCall(id, why, r).then(result => {
        if (r.state !== 'queued' || r.version !== version || result !== 'open') skip.add(r.id)
        if (r.state === 'queued' && r.version === version && typeof result === 'object') {
          closeItem(r, { reason: 'call_already_final', call_state: result.final, gen: null, prompt_id: null })
        }
      }).catch(e => { skip.add(r.id); E.log('warn', `lanes: checking delayed Call ${id}: ${e}`) }))
    }
    return pending.length ? Promise.all(pending).then(() => rows.filter(r => !skip.has(r.id) && r.state === 'queued')) : rows
  }

  /** the gen is idle and has nothing offered: offer it the oldest owed item, with the information riding on it */
  async function pump(wake?: 'person' | 'wall-clear'): Promise<void> {
    if (!E) return
    if (offering) {
      // Only a person's wall probe or the keeper's clear needs an immediate pass after this one.
      // Stream registration and ordinary enqueues keep the existing one-offer ordering.
      if (wake === 'wall-clear' || (wake === 'person' && wallDelivery().person)) wallWakePending = true
      return
    }
    offering = true
    try {
      do {
        wallWakePending = false
        await offerNext()
      } while (wallWakePending)
    } finally { offering = false }
  }
  async function offerNext(): Promise<void> {
    const g = currentGen()
    if (!g) return
    // PL4: a walled gen is offered one item when its retry time comes: its probe. Its own hook events then take it out of `walled` (and a
    // StopFailure walls it again, with a longer backoff). A limit menu it is parked on is driven first (002k G16a).
    const wall = wallDelivery(g)
    const probe = wall.probe
    const mayOffer = () => (g.state === 'idle' || g.state === 'walled') && (probe || (wall.active ? wall.person : canTake(g)))
    if (!mayOffer()) return
    const version = g.version
    const stillReady = () => {
      const fresh = wallDelivery(g)
      return currentGen() === g && g.version === version && fresh.active === wall.active && fresh.person === wall.person
        && fresh.probe === probe && mayOffer()
    }
    const eligible = (r: Row) => probe || wallAllows(r, wall)
    if (items(r => r.state === 'offered' && r.gen === g.id).length) return            // one offer opens one turn
    // 002w (E, gap 4): the oldest owed item whose own stream (its `via`) can take it. An item whose stream is down waits without holding the rest:
    // 2a936a7 tried only the oldest, so a mesh item behind a closed inbox stream held every later one, Joey's Telegram messages included.
    const cut: CutTurn | undefined = g.cut_turn
    const resume = cut && g.resume_sent !== cut.at && (probe || !wall.active) && Date.now() >= (cut.retry_at ?? 0)
    // A person's successful turn can end M2's episode while an earlier cut still waits in M1.
    // The keeper timestamps clears to whole seconds, as in statusChanged.
    const releasedCut = (r: Row) => wall.clear != null && accountFailure(r.cut_by)
      && wall.clear >= Math.floor(Date.parse(r.cut_at ?? r.ts) / 1000) * 1000
    const candidates = () => items(r => queuedForOffer(r, g) && eligible(r)
      && (!heldCut(r) || releasedCut(r)))
    const cands = candidates()
    if (!cands.length && !resume) return
    const mp = cands.length && !(wall.active && !probe) ? mentionsNow() : null
    const mb = mp ? await mp : null
    if (mp && !stillReady()) return
    let menu: { text: string; asks: boolean } | null = null
    if (probe && E.menu) {
      menu = await E.menu(true).catch(() => null)
      if (!stillReady()) return
      if (menu?.asks) E.tellJoey(menu.text, 'main-menu')
    }
    const advanceProbe = (row: Row, fields: Record<string, unknown> = {}) => setMain(row, 'walled', {
      ...fields,
      retry_at: Date.now() + backoff(String(row.kind ?? ''), Number(row.probes ?? 0)),
      ...(menu && !menu.asks ? { wall_menu: menu.text } : {}), ...(wall.clear != null ? { uw_clear_used: wall.clear } : {}),
    })
    const down = new Set<string>()
    // Work can arrive while the probe is driving the menu. It takes precedence over a bare resume.
    for (const it of probe ? candidates() : cands) {
      if (it.state !== 'queued' || down.has(String(it.via))) continue
      // Interrupted and batched items ride the lead, along with every refusal released by this clear.
      let riders = items(r => r.id !== it.id && r.state === 'queued' && (heldCut(r) || r.reason === 'batched' || (wall.clear != null && accountFailure(r.reason))) && owed(r) && forGen(r, g) && eligible(r))
      const checkedGroup = checked([it, ...riders], g, wall.clear)
      if (checkedGroup instanceof Promise) {
        const group = await checkedGroup
        if (!stillReady()) return
        if (!group.includes(it) || it.state !== 'queued') continue
        riders = group.filter(r => r !== it && r.state === 'queued')
      }
      const dg = wall.active && !probe ? null : attachInfo(mb)
      const ids = [it.id, ...riders.map(r => r.id), ...(dg ? [dg.id] : [])]
      const p = (it.notif?.params ?? {}) as Record<string, any>
      const own = [cutText(it, String(p.content ?? '')), ...riders.map(r => cutText(r, renderItem(r)))].join('\n')
      const content = dg ? `${contentOf(dg)}\n〔以上是系統附上的車道摘要，只附這一次；以下才是這則訊息本身〕\n${own}` : own
      const notif = { method: it.notif.method, params: { ...p, content, meta: { ...(p.meta ?? {}), did: ids.join(','), ...(dg ? { lane_digest: 'rides' } : {}) } } }
      let ok = false
      // Sonn #11516 (1): while this offer is on its way the item is still `queued`; an edit must not rewrite it then (the main would get the old text
      // while Onsen records replaced_in_queue): replaceQueued skips the ids in flight and the edit goes as a new message
      for (const id of ids) inFlight.add(id)
      try { ok = await E.offer(notif, it.via as Via, Number(g.pid)) } catch (e) { E.log('warn', `lanes: offer of ${it.id} failed: ${e}`) }
      finally { for (const id of ids) inFlight.delete(id) }
      const now = currentGen()
      if (!now || now.id !== g.id) return
      if (!ok) {
        down.add(String(it.via))
        if (it.last_no_wake !== 'unreachable') { J().write('msg', it.id, 'queued', { last_no_wake: 'unreachable' }); J().write('wake', it.id, 'no_wake', { reason: `main gen ${g.id} has no open ${it.via} stream` }) }
        continue
      }
      // Consume the keeper's clear only after a write. A failed lookup or a disconnected stream still owes this offer.
      if (probe && now.state === 'walled' && now.version === version) {
        advanceProbe(now)
      }
      // 002w: the offer is awaited, and the main can take it in meanwhile: its UserPromptSubmit names the item (did) and binds it. Only an item still
      // queued becomes `offered`; writing `offered` over `bound` sent a taken item back to be offered again (stuck_unbound), a second delivery.
      for (const id of ids) if (J().get('msg', id)?.state === 'queued') J().write('msg', id, 'offered', { gen: g.id, last_no_wake: null, person_wall_offer: wall.active && !probe || null })
      mentionsReached(dg)                                                                     // WO-181: in its session now: the mentions it carried are read
      J().write('wake', it.id, 'wake', { reason: `main ${probe ? 'walled: its probe' : 'idle'} (gen ${g.id}); offered ${it.kind}${dg ? ' with the digest' : ''}${riders.length ? `, ${riders.length} item(s) riding` : ''}` })
      for (const r of riders) J().write('wake', r.id, 'wake', { reason: `${r.reason}: rides the offer of ${it.id} (gen ${g.id})` })
      try { E.woke?.(J().get('msg', it.id)!, { gen: g.id, probe }) } catch (e) { E.log('warn', `lanes: woke hook: ${e}`) }
      delivered()
      return
    }
    // A final Call has been closed by checked(). A disconnected stream or an unverified Call is still owed.
    if (resume && !candidates().length && stillReady()) {
      const reason = ACCOUNT_WALL.has(cut.why) ? '用量上限' : cut.why === 'gen_end' ? '對話結束' : `模型回應錯誤 ${cut.why}`
      const background = cut.background_agents ? `當時有 ${cut.background_agents} 個背景工作在跑，重開後已經不在。` : ''
      const content = `上一回合 ${hhmmTaipei(cut.at)}（台北）被打斷（${reason}），接著做沒做完的；沒有要接的就直接結束這一回合。${background}`
      const notif = { method: 'notifications/claude/channel', params: { content, meta: { chat_id: 'lanes', user: 'lanes', via: 'lanes', no_reply: 'true' } } }
      const before = finalStops
      const sent = await E.offer(notif, 'tg', Number(g.pid)).catch(e => { E.log('warn', `lanes: resume offer failed: ${e}`); return false })
      if (sent) {
        // Hooks may already have refused this turn, replaced its gen, or finished it. Count every write
        // on the agent's latest gen. Only a still-open interval between final Stops needs the guard.
        const now = J().lastMain ?? g
        const fields = { resumes: (now.resumes ?? 0) + 1, ...(before === finalStops ? { cut_turn: cut, resume_sent: cut.at } : {}) }
        if (probe && now === g && now.version === version) advanceProbe(now, fields)
        else J().write('main', now.id, now.state, fields)
      }
    }
    // With no keeper, an attempted PL4 probe uses its retry slot even if every stream was down.
    if (probe && wall.clear == null && down.size && stillReady()) advanceProbe(g)
  }
  /** 002w (E, gaps 4, 11): an item reached the main (offered, or bound at a boundary): an episode of owed items nobody could take is over */
  function delivered(): void {
    if (!stuck?.undelivered) return
    stuck = null
    E.tellJoey('主線接到訊息了：等著的訊息現在交給它。', 'main-delivered')
  }

  /** bind queued owed items (and the riding information) to the running prompt: what a busy main pulls at a boundary. `mb` (WO-181): the unread mentions
   *  fetched for it (pullable() first said there is something to pull) */
  const pullable = (g: Row): boolean => items(r => r.state === 'queued' && owed(r) && forGen(r, g) && !waitsRetry(r)).length > 0
  async function pull(g: Row, prompt: string, mb: { text: string; posts: string[] } | null = null): Promise<Row[]> {
    const wall = wallDelivery(g)
    let got = items(r => r.state === 'queued' && owed(r) && forGen(r, g) && !waitsRetry(r) && wallAllows(r, wall))     // WO-201: a failed turn's item waits for its retry time
    const verified = checked(got, g, wall.clear)
    if (verified instanceof Promise) {
      got = await verified
      if (currentGen() !== g || g.prompt_id !== prompt || g.state !== 'in_turn') return []
      const fresh = wallDelivery(g)
      got = got.filter(r => r.state === 'queued' && wallAllows(r, fresh))
    }
    if (!got.length) return []
    const dg = wallDelivery(g).active ? null : attachInfo(mb)
    const all = dg ? [...got, dg] : got
    const at = new Date().toISOString()                                                           // WO-201: bound_at, what "output after it" is measured from
    for (const r of all) J().write('msg', r.id, 'bound', { gen: g.id, prompt_id: prompt, via_pull: true, bound_at: at })
    for (const r of got) J().write('wake', r.id, 'wake', { reason: `pulled into the running turn ${prompt}` })
    try { E.bound?.(got.map(r => J().get('msg', r.id)!)) } catch (e) { E.log('warn', `lanes: bound hook: ${e}`) }
    mentionsReached(dg)                                                                       // WO-181: bound into its turn: the mentions it carried are read
    delivered()
    return all.map(r => J().get('msg', r.id)!)
  }
  const SRC: Record<string, string> = { tg: 'telegram', inbox: 'agent-inbox' }
  function renderItem(r: Row): string {
    const m = metaOf(r.notif)
    const attrs = Object.entries({ ...m, did: r.id }).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`).join(' ')
    return `<channel source="${SRC[r.via] ?? r.via}" ${attrs}>\n${contentOf(r).slice(0, BODY_MAX)}\n</channel>`
  }
  function renderPulled(rs: Row[]): string {
    // a notice (Onsen's mention item, kind mention on the lanes' own chat) is told as the digest is: only for the main to know
    const isInfo = (r: Row): boolean => r.kind === 'digest' || metaOf(r.notif).kind === 'mention'
    const info = rs.filter(isInfo), msgs = rs.filter(r => !isInfo(r))
    return ['〔交給主線｜這一回合進行中送到的訊息，交給你接著處理。來源已驗證（Telegram 只收白名單裡的人，這就是 Joey 本人；mesh 訊息看 verified）。'
      + '照平常處理：問的就回答，交代的就照做（能馬上做的現在做，其餘接在手上這一步之後），Telegram 用 reply 回，同事用 send_to_agent 回；已經處理過的不用重做。〕',
      ...msgs.map(r => cutText(r, renderItem(r))), ...info.map(r => r.kind === 'digest' ? `〔車道摘要（只讓你知道，不是新的指示）〕\n${contentOf(r)}` : contentOf(r))].join('\n')
  }
  function requeue(pred: (r: Row) => boolean, reason: string, fields: Record<string, unknown> = {}): Row[] {
    const rs = items(r => (r.state === 'offered' || r.state === 'bound') && pred(r))
    for (const r of rs) J().write('msg', r.id, 'queued', { reason, gen: null, prompt_id: null, via_pull: null, ...fields })
    return rs
  }
  /** WO-157c: the items of gen `g`'s open turn, cut (Esc, or a turn that never got Stop): queued again and held (heldCut) to ride the next delivery, marked
   *  for Chiron's line */
  function cutTurn(g: Row): Row[] {
    return g.prompt_id ? requeue(r => r.gen === g.id && r.prompt_id === g.prompt_id, 'interrupted', { cut_at: new Date().toISOString(), cut_by: null }) : []
  }
  /** WO-201 (Chiron mesh-13184, row 4): items `rs` whose turn had no normal end AFTER the model had already said something about them (its gen ended, its
   *  process started another session, a non-account StopFailure): an interrupted turn, the Esc path's shape (cutTurn). Held (reason interrupted, cut_at)
   *  to ride the next delivery with INTERRUPTED_LINE in front; `cut_by` names what cut it, so that with no next delivery within MAIN_STUCK_MS it is
   *  delivered alone once (tick), Joey's own messages included: an Esc is Joey stopping it, a dead process is not */
  function holdCut(rs: Row[], by: string, outBy: Map<string, string> = new Map()): Row[] {
    if (!rs.length) return []
    const at = new Date().toISOString()
    for (const r of rs) J().write('msg', r.id, 'queued', { reason: 'interrupted', gen: null, prompt_id: null, via_pull: null, cut_at: at, cut_by: by, ...(outBy.has(r.id) ? { output_by: outBy.get(r.id) } : {}) })
    return rs
  }
  function finish(pred: (r: Row) => boolean, how: Record<string, unknown> = {}): Row[] {
    const rs = items(r => r.state === 'bound' && pred(r))
    for (const r of rs) closeItem(r, how)
    return rs
  }
  function closeItem(r: Row, how: Record<string, unknown>): void {
    J().write('msg', r.id, 'done', { reason: null, ...how }); try { E.done(J().get('msg', r.id)!) } catch (e) { E.log('warn', `lanes: done hook ${r.id}: ${e}`) }
  }

  // ------------------------------------------------------------------ WO-201: how a turn ended (Chiron resend audit 2026-11-27, mesh-13184; Joey TG chiron:2864)
  // Four cases, decided by how the turn the item was bound to ended, never by "the gen changed":
  //   1. a normal end (its final Stop): done (finish, `received: stop`).
  //   2. a compaction inside the turn: the turn goes on; nothing moves (sessionStart `goesOn`).
  //   3. no normal end, and NO genuine output after the binding: offered once more; a second such end closes it with one main-cut line (settle).
  //   4. no normal end, output ALREADY there (the process gone, another session, a non-account StopFailure): an interrupted turn (holdCut: the Esc path).
  // Output only means the work started: marking such an item done would leave nothing to wake the main for the rest of it; offering its full text at
  // once mostly gets a second answer. The interrupted line rides the next delivery with it instead.
  const genuineAfter = (path: string, sinceMs: number): number | null => { try { return (E.genuineAfter ?? genuineAssistantAfterFile)(path, sinceMs) } catch { return null } }
  /** did the model say anything after item `r` was bound to a turn of gen `g`? 'stop': it reached done at a final Stop before (its turn then went on:
   *  turn_continued); a number: the ms of the first genuine assistant record of g's transcript after `bound_at` (liveness.ts: a response begun after the
   *  binding); 0: nothing; null: cannot tell (no transcript path, the file unreadable or too large) */
  function outputOf(g: Row, r: Row): 'stop' | string | number | null {
    if (r.received === 'stop') return 'stop'
    const h = hookOut.get(r.id)                                       // mesh-13196: M2's own hook fact, live (the transcript's last second may not be on disk yet)
    if (h && h.gen === g.id && h.prompt === r.prompt_id && h.at >= (Date.parse(String(r.bound_at ?? '')) || 0)) return `hook:${h.ev}`
    const tp = String(g.transcript_path ?? '')
    const since = Date.parse(String(r.bound_at ?? r.ts))            // no bound_at (bound before 1.59.1): the item's last line, later than its binding
    return tp && Number.isFinite(since) ? genuineAfter(tp, since) : null
  }
  const hasOutput = (o: 'stop' | string | number | null): boolean => typeof o === 'string' || (typeof o === 'number' && o > 0)
  /** what said there was output, for the held item's line (output_by): stop, hook:<event>, transcript */
  const outputBy = (o: 'stop' | string | number | null): string => typeof o === 'string' ? o : 'transcript'
  /** WO-201 (Chiron mesh-13196, lab: m-mwyr8ssj-1 bound 09:04:15.464, M2 tool_open react at 17.737, killed 0.6 s later; settle read the transcript at
   *  18.413 and found nothing, though three genuine records after the binding (17.398, 17.682, 18.269) were in it afterwards: the last second was not on
   *  disk yet). M2's own fact, received live: item id → the first hook event of the main (not a subagent's) for the item's own prompt, in its gen, after
   *  it was bound. Counted: PreToolUse / PostToolUse (the model emitted a tool call) and Stop (the model ended its response) for an item bound when its
   *  prompt began; for an item pulled into a running turn only Stop, since a tool call after the pull may belong to the response that was already streaming
   *  (the reason the transcript check keys on message.id). In memory: after a daemon restart the transcript alone answers, as before */
  const hookOut = new Map<string, { gen: string; prompt: string; ev: string; at: number }>()
  function noteOutput(g: Row, p: string, ev: string): void {
    const now = Date.now()
    for (const r of items(x => x.state === 'bound' && x.gen === g.id && x.prompt_id === p && (!x.via_pull || ev === 'Stop'))) {
      const h = hookOut.get(r.id)
      if (h && h.gen === g.id && h.prompt === p) continue
      hookOut.set(r.id, { gen: g.id, prompt: p, ev, at: now })
    }
    if (hookOut.size > 2000) for (const k of [...hookOut.keys()].slice(0, hookOut.size - 2000)) hookOut.delete(k)
  }
  /** gen `g` ends, or its process starts another session that is not a compaction of the running turn, while items `rs` are offered to it or bound to
   *  its turn (no normal end: cases 3 and 4 above):
   *  - offered, never bound: it never reached a turn: queued again (`why`), as before (an item never read cannot be a second copy).
   *  - bound, output already there: held as an interrupted turn's (holdCut, cut_by `why`): it rides the next delivery with the interrupted line.
   *  - bound, nothing after it: queued again once (`cuts`: CUT_REOFFERS). Cut the same way again: closed (done, reason cut_twice); the caller tells Joey
   *    which (tellCut). It is not offered a third time.
   *  - bound and it cannot be told: queued again as before (the failure Chiron prefers: one copy too many, never one lost), and the log says why. */
  function settle(g: Row, rs: Row[], why: string): { back: Row[]; held: Row[]; capped: Row[] } {
    const back: Row[] = [], hold: Row[] = [], capped: Row[] = [], outBy = new Map<string, string>()
    const again = (r: Row, f: Record<string, unknown> = {}): void => { J().write('msg', r.id, 'queued', { reason: why, gen: null, prompt_id: null, via_pull: null, ...f }); back.push(r) }
    for (const r of rs) {
      if (r.state === 'offered') { again(r); continue }
      if (r.state !== 'bound') continue
      const out = outputOf(g, r)
      if (hasOutput(out)) { hold.push(r); outBy.set(r.id, outputBy(out)); continue }
      if (out == null) {
        E.log('info', `lanes: ${why} of gen ${g.id}: cannot tell whether the model said anything after item ${r.id} (${g.transcript_path ? `transcript ${g.transcript_path} unreadable or too large` : 'no transcript path'}): queued again as before`)
        again(r)
        continue
      }
      const cuts = Number(r.cuts ?? 0) + 1
      if (cuts <= CUT_REOFFERS) { again(r, { cuts }); continue }
      closeItem(r, { reason: 'cut_twice', cuts, cut_by: why })
      capped.push(r)
    }
    const held = holdCut(hold, why, outBy)
    if (held.length || capped.length) E.log('info', `lanes: ${why} of gen ${g.id}: ${itemCount(held)} item(s) the model had answered held as an interrupted turn's (they ride the next delivery), ${itemCount(capped)} cut twice with no output (closed), ${itemCount(back)} queued again`)
    return { back, held, capped }
  }
  /** WO-201: the line Joey gets about items closed after a second cut (or a parked item that failed again): what they were, and that they are not
   *  given to the main again. It is the line about each (it meets their Joey line, as the asked-restart notice) */
  function tellClosed(rs: Row[], what: string): void {
    const told = rs.filter(r => r.kind !== 'digest')
    if (!told.length) return
    E.tellJoey(`${what}為了不一直重來，這 ${told.length} 則不會再自動交給主線：${told.map(r => `「${contentOf(r).replace(/\s+/g, ' ').slice(0, 80)}」`).join('；')}。還要處理的話請再說一次（同事的事請對方再送一次）。`,
      'main-cut', [...new Set(told.map(r => String(r.event ?? '')).filter(Boolean))])
  }
  const tellCut = (rs: Row[], why: string): void => tellClosed(rs, `主線兩次在讀進下面的訊息之後、還沒有任何輸出就${why === 'gen_end' ? '結束了（行程不在了）' : '換了一個 session'}。`)
  /** WO-201 (point 4, inventory L5): turn `p` of gen `g` ended in a StopFailure that is not an account kind (server_error, an overload, unknown). An item
   *  the model had already said something about (outputOf) is an interrupted turn's (case 4: holdCut, cut_by stop_failure:<err>). One with nothing after
   *  it (or it cannot be told): the turn was refused (Chiron's rule 3): offered again, each after a backoff, wallBackoff(err, fails − 1) (for these kinds the main wall's base,
   *  LANES_WALL_PROBE_MS 300 s; it was the next 5-second pump, no gap and no cap). `fails` counts the failed turns per item; the MAIN_FAIL_MAX-th parks it
   *  (reason stop_failure_cap: neither offered nor pulled) and takes the stuck path (the episode opens; Joey is told once, main-stuck). The gen's next final
   *  Stop (the model answers again) lets the waiting and the parked items go (releaseFailed), a parked one once: failing again it is closed (done, reason
   *  stop_failure_gave_up) and Joey is told which. An item offered and never bound was not in the turn: queued again as before. The gen is idle, as before */
  function failTurn(g: Row, p: string, err: string): void {
    const now = Date.now()
    const rs = unsettled(g, p)
    const parked: Row[] = [], closed: Row[] = [], hold: Row[] = [], outBy = new Map<string, string>()
    for (const r of rs) {
      const back = { gen: null, prompt_id: null, via_pull: null }
      if (r.state !== 'bound') { J().write('msg', r.id, 'queued', { reason: `stop_failure:${err}`, ...back }); continue }
      const out = outputOf(g, r)
      if (hasOutput(out)) { hold.push(r); outBy.set(r.id, outputBy(out)); continue }      // case 4: the model had answered: an interrupted turn
      if (out == null) E.log('info', `lanes: StopFailure ${err} of gen ${g.id}: cannot tell whether the model said anything after item ${r.id}: the refused-turn retry`)
      const fails = Number(r.fails ?? 0) + 1
      if (fails < MAIN_FAIL_MAX) J().write('msg', r.id, 'queued', { reason: `stop_failure:${err}`, ...back, fails, fail_retry_at: now + backoff(err, fails - 1) })
      else if (!r.fail_released) { J().write('msg', r.id, 'queued', { reason: 'stop_failure_cap', ...back, fails, fail_retry_at: null }); parked.push(r) }
      else { closeItem(r, { reason: 'stop_failure_gave_up', fails, gen: null }); closed.push(r) }
    }
    const held = holdCut(hold, `stop_failure:${err}`, outBy)
    setMain(g, 'idle', { error: err, prompt_id: null, tool_open: null, stopped_prompt: null, cut_turn: bareCut(g, rs, err, now) })
    const waiting = items(r => r.state === 'queued' && typeof r.reason === 'string' && r.reason === `stop_failure:${err}` && Number(r.fail_retry_at ?? 0) > now)
    E.log('info', `lanes: main gen ${g.id}: turn ${p || '(none)'} ended in StopFailure ${err}: ${itemCount(waiting)} item(s) wait ${Math.round(backoff(err, 0) / 1000)} s or the next good turn, ${itemCount(parked)} parked at the cap (${MAIN_FAIL_MAX}), ${itemCount(closed)} closed, ${itemCount(held)} the model had answered held as an interrupted turn's`)
    if (parked.length) {
      const queued = items(r => r.state === 'queued' && owed(r)).length
      const text = `主線疑似卡死：${parked.length} 則訊息交給它 ${MAIN_FAIL_MAX} 次，${MAIN_FAIL_MAX} 次回合都以錯誤結束（${err}），先不再交給它：${parked.filter(r => r.kind !== 'digest').map(r => `「${contentOf(r).replace(/\s+/g, ' ').slice(0, 60)}」`).join('、')}。主線下一次正常結束一個回合，我會再交給它一次。有 ${queued} 則訊息等它。`
      if (!stuck) { stuck = { gen: g.id, prompt: null, at: now }; E.tellJoey(text, 'main-stuck') }
      else E.log('info', `lanes: ${parked.length} item(s) parked at the StopFailure cap during an open stuck episode (Joey was told once): ${parked.map(r => r.id).join(', ')}`)
    }
    if (closed.length) tellClosed(closed, `主線回合又以錯誤結束（${err}），這些訊息已經交給它 ${MAIN_FAIL_MAX + 1} 次都沒成功。`)
  }
  /** WO-201 (point 4): the gen ended a turn with a final Stop: the model answers again. The items a failed turn left waiting go now; the parked ones go once
   *  (fail_released: parked again they are closed) */
  function releaseFailed(): void {
    const rs = items(r => waitsRetry(r))
    for (const r of rs) J().write('msg', r.id, 'queued', r.reason === 'stop_failure_cap' ? { reason: 'stop_failure_released', fail_released: true, fail_retry_at: null } : { fail_retry_at: null })
    if (rs.length) E.log('info', `lanes: a turn of the main ended with Stop: ${rs.length} item(s) a failed turn left waiting are offered again`)
  }

  // ------------------------------------------------------------------ M2 transitions
  /** Included in the same journal write as the turn end. An undefined field keeps the previous fact. */
  function bareCut(g: Row, rs: Row[], why: string, at = Date.now()): CutTurn | undefined {
    if (g.resume_sent != null || itemCount(rs)) return
    if (why === 'gen_end') {
      let n: number | null | undefined
      try { if (g.session_id) n = E.registry?.backgroundAgents(g.session_id) } catch {}
      return { at, why, ...(n && n > 0 ? { background_agents: n } : {}) }
    }
    return ACCOUNT_WALL.has(why) ? { at, why } : { at, why, retry_at: at + backoff(why, 0) }
  }
  function setMain(g: Row, state: MainPhase, fields: Record<string, unknown> = {}): void { J().write('main', g.id, state, fields) }
  function endGen(g: Row, why: EndReason): void {
    if (g.state === 'gone') return
    // 002j (5018d39), kept as data: a restart Joey asked for does not hand the cut turn back to the new main; Joey gets one line instead.
    // SPECIAL CASE (kept, see RBP report): these items end done without a Stop because the owner decided a deliberate restart closes them.
    const cut = why === 'asked' && g.prompt_id ? finish(r => r.gen === g.id && r.prompt_id === g.prompt_id, { reason: 'asked_restart' }) : []
    // WO-201 (inventory L6; Chiron mesh-13184): the end of a process is no reason by itself. What it was given and never took goes to the next gen; what it
    // took and had answered rides the next delivery as an interrupted turn's; what it took and died on before saying anything goes once more (settle)
    const rs = unsettled(g)
    const cutFact = why !== 'asked' && g.prompt_id && (g.state === 'in_turn' || (g.state === 'walled' && !g.cut_turn))
      ? bareCut(g, rs.filter(r => !r.prompt_id || r.prompt_id === g.prompt_id), 'gen_end') : undefined
    const { back, capped } = settle(g, rs, 'gen_end')
    setMain(g, 'gone', { end_reason: why, prompt_id: null, tool_open: null, stopped_prompt: null, cut_turn: cutFact })
    if (cur === g.id) cur = null
    pendingEnd.delete(g.id); lastEventAt.delete(g.id); work.delete(g.id)
    if (stuck?.gen === g.id && !stuck.undelivered) stuck = null              // 002w (E): what nobody could take is still waiting: that episode goes on
    // 002q (T8-R): the notice is the line Joey gets about each cut message, so it is on their events (it meets their Joey line)
    // 002y (X-4; 002x T8-R a-r3: 2013 answered by msg 2014 at 1388.88, /restart at 1389.42, the notice msg 2017 still said 「還要處理的話請再說一次」):
    // only a cut message whose Joey line is still owed (M3: mainOwed, kind joey) is named; one the main already answered is closed (done, as every cut
    // item) without that sentence. An item with no event cannot be judged: it is named, as before. No such message: no notice.
    const told = cut.filter(r => r.kind !== 'digest')
    const evs = [...new Set(told.map(r => String(r.event ?? '')).filter(Boolean))]
    const owesJoey = E.mainOwed ? new Set(E.mainOwed(evs).filter(x => (x.kinds ?? []).includes('joey')).map(x => x.id)) : null
    const still = owesJoey ? told.filter(r => !r.event || owesJoey.has(String(r.event))) : told
    if (still.length) E.tellJoey(`主線被指令重啟（/restart 或 /kill_stuck）。重啟時它正在處理的 ${still.length} 則訊息不會自動交給新的主線：${still.map(r => contentOf(r).replace(/\s+/g, ' ').slice(0, 80)).join('；')}。還要處理的話請再說一次。`, 'asked-restart',
      [...new Set(still.map(r => String(r.event ?? '')).filter(Boolean))])
    if (still.length < told.length) E.log('info', `lanes: asked restart of gen ${g.id}: ${told.length - still.length} cut message(s) already answered, closed without the notice`)
    E.log('info', `lanes: main gen ${g.id} gone (${why}); ${back.length} item(s) queued again`)
    tellCut(capped, 'gen_end')
    try { E.genChanged(null) } catch {}
  }
  function beginTurn(g: Row, prompt: string, dids?: string[]): void {
    if (g.prompt_id === prompt) return
    if (g.stopped_prompt === prompt) return continueTurn(g, prompt)
    if (g.prompt_id) cutTurn(g)                                     // a turn that never got Stop or StopFailure: its items ride this turn (pull, WO-157c)
    outputs.clear(); calls.clear(); openTools.delete(g.id)                                          // the aids look at this prompt's calls only
    starts.set(g.id, { prompt, at: new Date().toISOString(), prev: starts.get(g.id)?.at ?? null })
    setMain(g, 'in_turn', { prompt_id: prompt, tool_open: null, stopped_prompt: null })
    const ids = new Set((dids ?? []).flatMap(d => String(d).split(',')).map(s => s.trim()).filter(Boolean))
    // what the prompt names (its did="…"), and whatever was offered to this gen: one offer opens one turn, so it is this turn's
    const bind = items(r => (r.state === 'offered' && r.gen === g.id) || (ids.has(r.id) && r.state === 'queued' && forGen(r, g)))
    const at = new Date().toISOString()                                                           // WO-201: bound_at, what "output after it" is measured from
    for (const r of bind) J().write('msg', r.id, 'bound', { gen: g.id, prompt_id: prompt, bound_at: at })
    if (bind.length) { try { E.bound?.(bind.map(r => J().get('msg', r.id)!)) } catch (e) { E.log('warn', `lanes: bound hook: ${e}`) }; delivered() }
  }
  /** the prompt the gen last stopped is running again: a Stop hook other than ours blocked that Stop. The turn was not over: it re-opens, and
   *  what that Stop closed is bound to it again. An item offered in the gap is not this turn's: it opens its own prompt (beginTurn). */
  function continueTurn(g: Row, prompt: string): void {
    setMain(g, 'in_turn', { prompt_id: prompt, tool_open: null, stopped_prompt: null })
    const back = items(r => r.state === 'done' && r.gen === g.id && r.prompt_id === prompt)
    for (const r of back) { J().write('msg', r.id, 'bound', { reason: 'turn_continued' }); try { E.undone(J().get('msg', r.id)!) } catch (e) { E.log('warn', `lanes: undone hook ${r.id}: ${e}`) } }
    E.log('info', `lanes: main gen ${g.id}: turn ${prompt} went on after its Stop (another Stop hook held it); ${back.length} item(s) bound again`)
  }
  /** PL4: the StopFailure kinds that wall the main: the account cannot be used (quota, billing, hold, login). Any other error (server_error, an
   *  overload, unknown) ends the turn: the gen is idle and its items are offered again after a backoff, with a cap (WO-201: failTurn). */
  const ACCOUNT_WALL = new Set(['rate_limit', 'billing_error', 'account_on_hold', 'authentication_failed', 'oauth_org_not_allowed', 'cloud_credential_error'])
  const backoff = (kind: string, probes: number): number => E.wallBackoff ? E.wallBackoff(kind, probes) : Math.min(1_800_000, 300_000 * 2 ** Math.min(20, probes))

  /** /lanes/main-event: every hook event of the main. The reply is what the hook prints. */
  async function mainEvent(b: MainEvent): Promise<MainReply> {
    const pid = Number(b.pid) || 0
    const ev = String(b.event ?? '')
    if (ev === 'SessionStart') return withMailbox(sessionStart(b, pid))
    let g = currentGen()
    // 1.53.1 (Mnemosyne #12058, Chiron #12069: builder on txmonster, 2026-11-25): a main whose SessionStart never reached this daemon (the TUI started
    // before the daemon answered, or the daemon restarted under it) was never the main again until its TUI restarted: every later event was "not the
    // main" and its hand-overs piled up unread. With no live gen, any hook event of the registered session (main-expected) adopts it, as its
    // SessionStart would have; the event is then handled as usual. A different session id, or a live gen of another process, is not adopted.
    if (!g && pid && E.expectedSession().includes(String(b.session_id ?? ''))) {
      const r = sessionStart({ ...b, source: 'adopt' }, pid)
      if (r.accepted !== false) { E.log('info', `lanes: main adopted on ${ev} (no SessionStart reached this daemon) session=${b.session_id} pid=${pid}`); g = currentGen() }
    }
    if (!g || !pid || Number(g.pid) !== pid) return {}                       // not the main: nothing of it is tracked
    // 002r (H05): a subagent's tool call. It starts, continues and ends no turn of the main, opens no tool of the main and is no boundary to pull at
    // (the pulled message would land in the subagent). While the main's turn is open (it waits on its Agent call) the subagent's work is the gen's
    // sign of life; an idle main that leaves an offer untaken is not excused by its background agents.
    if (b.sub && g.state !== 'in_turn') return {}
    lastEventAt.set(g.id, Date.now())
    if (stuck && !stuck.undelivered && stuck.gen === g.id) { stuck = null; E.tellJoey('主線又有動靜了（hook 事件恢復），疑似卡死解除。', 'main-unstuck') }
    if (b.sub) return {}                                                    // in an open turn: a sign of life (and the all-clear), nothing else
    const p = String(b.prompt_id ?? '')
    // WO-201 (mesh-13196): before this event binds or pulls anything, the items already bound to this prompt get M2's own output fact (noteOutput)
    if (p && (ev === 'PreToolUse' || ev === 'PostToolUse' || ev === 'Stop')) noteOutput(g, p, ev)
    switch (ev) {
      case 'UserPromptSubmit': {
        if (p) beginTurn(g, p, b.dids)
        // lanes-golive (Chiron line8-delivery-20261122: on --resume a SessionStart hook's context reached the conversation in 25 of 334 resumes; startup, clear
        // and compact do get it): the main-only rules go with the session's first prompt (a typed one, or a delivered item's) when its SessionStart could
        // not carry them, and again after a compaction (PreCompact clears the mark). Once per session.
        const row = J().get('main', g.id)!
        if (row.rules_shown === row.session_id) return {}
        setMain(row, row.state as MainPhase, { rules_shown: row.session_id })
        return withMailbox({ additionalContext: E.context(E.agent, String(row.session_id)) })
      }
      case 'PreCompact': {
        const row = J().get('main', g.id)!
        if (row.rules_shown) setMain(row, row.state as MainPhase, { rules_shown: null })    // the compacted conversation needs the rules again
        return {}
      }
      case 'PreToolUse': {
        if (!p) return {}
        beginTurn(g, p); setMain(J().get('main', g.id)!, 'in_turn', { tool_open: String(b.tool_name ?? 'tool') })
        // WO-148 (item 3; lab: the hook sent tool_input only for a btcc-receipt Bash): the hook's tool_brief, the field the call is about (lanes.ts masks it)
        openTools.set(g.id, { name: String(b.tool_name ?? 'tool'), input: b.tool_brief ?? b.tool_input ?? null, at: new Date().toISOString() })
        toolBound.set(g.id, Number(b.tool_timeout_ms) > 0 ? Math.round(Number(b.tool_timeout_ms) * 1.25) : 0)   // the tool's own bound, with a margin
        { const deny = E.toolGate?.(String(b.tool_name ?? ''), b.tool_input ?? {}); if (deny) return { deny } }     // 002w (D): refused before it runs
        const send = /__send_to_agent$/.test(String(b.tool_name ?? ''))
        let mark: string | undefined, markReplyTo: string | null = null
        // lanes-golive (A5): the WO-99 lines. no_reply is a mail field; a call ends a conversation as the answer to a call (reply_to, auto no_reply);
        // a feed post has no addressee. Already ending (or not a send to anyone): no mark.
        const line = String(b.tool_input?.line ?? '')
        const ends = line === 'feed' || (line === 'call' ? !!b.tool_input?.reply_to : b.tool_input?.no_reply === true)
        if (send && !ends && E.stoppedPeers) {
          // 002v (002s r2 C04, u002s-C04-s2-r2-20261119-215937): the thread gate stopped the conversation and handed its last message to this turn; the
          // main's answer to that peer ends it. "不用回" is the router's to enforce (identity.md), not the model's to remember: the hook marks the send.
          const to = String(b.tool_input?.to ?? '').trim().toLowerCase()
          if (to && E.stoppedPeers(turnWork(g, p).events).includes(to)) mark = `the conversation with ${to} was stopped by the thread gate; this answer ends it`
          if (mark && line === 'call') { markReplyTo = E.stoppedRequest?.(turnWork(g, p).events, to) ?? null; if (!markReplyTo) mark = undefined }   // a call ends only as an answer (reply_to)
        }
        // PL5: the summary gate judges the reply against this turn; 002w (F, gap 18): its C16 claims check judges a send_to_agent the same way
        return send || /__reply$/.test(String(b.tool_name ?? '')) ? { turn: turnOf(J().get('main', g.id)!, p), ...(mark ? { mark_no_reply: mark } : {}), ...(markReplyTo ? { mark_reply_to: markReplyTo } : {}) } : {}
      }
      case 'PostToolUse': {
        if (!p) return {}
        beginTurn(g, p)
        const n = String(b.tool_name ?? '')
        if (/(__reply|__send_to_agent)$/.test(n) && b.tool_input?.text) (outputs.get(p) ?? outputs.set(p, []).get(p)!).push({
          to: String(b.tool_input.to ?? (n.endsWith('__reply') ? 'Joey' : '')), reply_to: String(b.tool_input.reply_to ?? ''), text: String(b.tool_input.text) })
        { const list = calls.get(p) ?? calls.set(p, []).get(p)!; list.push({ name: n, input: b.tool_input ?? {}, result: String(b.tool_response ?? ''), error: !!b.tool_error }); if (list.length > 40) list.shift() }
        setMain(J().get('main', g.id)!, 'in_turn', { tool_open: null }); openTools.delete(g.id)
        try { E.toolDone?.(n, b.tool_input ?? {}, String(b.tool_response ?? ''), !!b.tool_error) } catch (e) { E.log('warn', `lanes: toolDone ${n}: ${e}`) }
        const mp = pullable(g) ? mentionsNow() : null                                       // WO-181: only when something is pulled now
        const got = await pull(J().get('main', g.id)!, p, mp ? await mp : null)
        return got.length ? { additionalContext: renderPulled(got) } : {}
      }
      case 'Stop': {
        if (!p) return {}
        beginTurn(g, p)
        if (b.phase !== 'final') {
          const mp = pullable(g) ? mentionsNow() : null                                     // WO-181: only when something is pulled now
          const got = await pull(J().get('main', g.id)!, p, mp ? await mp : null)
          if (got.length) return { block: '這一輪先不要結束。' + renderPulled(got) }
          const t = turnWork(g, p)
          // 002q (M3), 002w (B): the main's turn may not end silently while it still owes what the turn works on, the rule the lane stop applies to a
          // lane: a Joey line, a peer's answer, a scheduler receipt, handed to it or open on what it owns. Code, no model, before the aids; over turnWork
          // (a turn that took in nothing is asked about the work it carries on). One hold per turn (owed_hold on the gen), naming each: the next Stop of
          // the same turn ends it, and what is still owed stays open on its event.
          const gen = J().get('main', g.id)!
          if (E.mainOwed && gen.owed_hold !== p) {
            const owed = E.mainOwed(t.events)
            if (owed.length) {
              setMain(gen, 'in_turn', { owed_hold: p, owed_events: owed.map(o => o.id) })
              return { block: `這一輪還欠事沒交代，先不要結束：${owed.map(o => `${o.from}「${firstWords(o.text)}」：${o.owes.join('、')}`).join('；')}。Joey 用 reply 回（一則可以回全部），同事用 send_to_agent 回，排程用 ~/.claude/tools/btcc-receipt complete <run> 回執；做完再結束這一輪。` }
            }
          }
          const its = t.carried ? [] : t.items.filter(r => r.state === 'bound').map(aidItem), w = t.carried ? work.get(g.id) : undefined
          return { items: its, outputs: outputs.get(p) ?? [], ...(w ? { context: { items: w.items, outputs: w.outputs } } : {}),
            turn: turnOf(J().get('main', g.id)!, p), ...(E.memory ? E.memory() : { proposals: [], curator: false }) }   // PL5: the memory gate's facts
        }
        { // 002v: the work this turn leaves for the next (the turn's items, or the outputs it adds to the work it carried on)
          const mine = items(r => r.gen === g.id && r.prompt_id === p && (r.state === 'bound' || r.state === 'done') && r.kind !== 'digest')
          const outs = outputs.get(p) ?? [], w = work.get(g.id)
          if (mine.length) work.set(g.id, { items: mine.map(aidItem).slice(-6), outputs: outs.slice(-12), ids: mine.map(r => r.id),
            events: [...new Set(mine.map(r => String(r.event ?? '')).filter(Boolean))] })
          else if (w && outs.length) w.outputs = [...w.outputs, ...outs].slice(-12)
        }
        finish(r => r.gen === g.id && r.prompt_id === p, { received: 'stop' })      // WO-201 case 1; if the turn goes on (turn_continued) the mark says output was there
        releaseFailed()                                                              // WO-201 (point 4): the model answers: what failed turns left waiting goes
        // the turn may not be over: a Stop hook other than ours can still block this Stop (continueTurn); the prompt's outputs stay for its next Stop
        const was = J().get('main', g.id)!, since = was.wall_since as string | undefined, wmenu = was.wall_menu as string | undefined
        openTools.delete(g.id)
        finalStops++
        setMain(was, 'idle', { prompt_id: null, tool_open: null, error: null, stopped_prompt: p, cut_turn: null, resume_sent: null, ...(since ? { wall_since: null, wall_refused_at: null, wall_clear_at: null, probes: null, retry_at: null, kind: null, wall_menu: null } : {}) })
        if (since) {
          const n = items(r => queuedForOffer(r, was) && (!heldCut(r) || accountCut(r))).length
          E.tellJoey(`主線恢復了。這次從 ${hhmmTaipei(Date.parse(since))}（台北）起不能用模型。${n ? `保留的 ${n} 則訊息等著交給它。` : ''}${wmenu ? `期間${wmenu}` : ''}`, 'main-wall-down')
        }
        void pump()
        return {}
      }
      case 'StopFailure': {
        if (p) beginTurn(g, p)
        openTools.delete(g.id)
        const err = String(b.error ?? 'unknown')
        // WO-201 (point 4): not a wall: idle; the turn's items are offered again after a backoff, with a cap (failTurn). The account wall below is unchanged
        if (!ACCOUNT_WALL.has(err)) { if (p) outputs.delete(p); failTurn(g, p, err); return {} }
        const reason = `stop_failure:${err}`
        const back = unsettled(g, p)
        const wall = E.usageWall?.(Date.parse(String(g.wall_since ?? '')) || 0)
        for (const r of back) {
          const output = r.state === 'bound' && r.kind !== 'digest' ? outputOf(g, r) : null
          if (hasOutput(output)) {
            holdCut([r], reason, new Map([[r.id, outputBy(output)]]))
            continue
          }
          const refused = r.state === 'bound' && r.kind === 'joey'
          if (refused) E.blocked?.(r, wall?.resets_at ?? null)
          J().write('msg', r.id, 'queued', { reason, gen: null, prompt_id: null, via_pull: null, waited: 'wall',
            ...(refused ? { wall_blocked: p || r.id } : {}) })
        }
        if (p) outputs.delete(p)
        const cur = J().get('main', g.id)!
        // the main's own wall: one episode (wall_since) until its next Stop; each failed probe backs off
        const first = !cur.wall_since, probes = first ? 0 : Number(cur.probes ?? 0) + 1
        setMain(cur, 'walled', { kind: err, error: err, prompt_id: null, tool_open: null, stopped_prompt: null, wall_since: cur.wall_since ?? new Date().toISOString(), wall_refused_at: Date.now(), wall_clear_at: null, probes,
          cut_turn: bareCut(cur, back, err), retry_at: Date.now() + backoff(err, probes) })
        if (first) E.tellJoey(`主線${WALL_WORD[err] ?? '模型無法使用'}（原文：${String(b.reason ?? err).slice(0, 200)}）。給主線的 ${items(r => r.state === 'queued' && owed(r)).length} 則訊息先保留，一件都沒有丟；之後主線一能用就交給它，恢復時我會告訴你。主線要等額度重置、換帳號或換模型才會再動。車道照常處理警報與同事的事。`, 'main-wall-up')
        return {}
      }
      case 'SessionEnd': {
        // 002v (/clear, measured on Claude Code 2.1.322 for Joey TG 7645): /clear ends the session (reason clear) and the SAME process starts a new
        // one (SessionStart source clear, a new session id). The process is the main ("a SessionStart from the process of the live gen is accepted").
        // Ending the gen here left no live gen: the new session was refused ("not the registered main") and nobody was the main until the TUI
        // restarted. A session that ends while its process goes on ends no gen; the end of an older session of this process is ignored.
        if (String(b.reason ?? '') === 'clear' || (b.session_id && g.session_id && String(b.session_id) !== String(g.session_id))) return {}
        endGen(g, pendingEnd.get(g.id) ?? 'exited'); return {}
      }
    }
    return {}
  }
  /** WO-128 (item 4): the context the main gets back (its rules: registration, a resumed main's first prompt, after a compaction) carries what waits on its
   *  decision in the mailbox. Not added to a refusal. */
  async function withMailbox(r: MainReply): Promise<MainReply> {
    if (!E.mailbox || r.accepted === false || !r.additionalContext) return r
    const m = await E.mailbox().catch(() => '')
    return m ? { ...r, additionalContext: `${r.additionalContext}\n${m}` } : r
  }
  function sessionStart(b: MainEvent, pid: number): MainReply {
    const sid = String(b.session_id ?? '')
    if (!/^[0-9a-f-]{36}$/.test(sid) || !pid) return { accepted: false, additionalContext: notMainContext(E.agent, 'bad session id or pid') }
    const g = currentGen()
    const ok = E.expectedSession().includes(sid) || (!!g && Number(g.pid) === pid)
    if (!ok) {
      const reason = `not the registered main (expected ${E.expectedSession().join(' / ') || '(none)'}; main ${g?.session_id ?? '(none)'})`
      E.log('warn', `lanes: SessionStart REFUSED session=${sid} pid=${pid}: ${reason}`)
      E.refused(sid, pid, reason)
      return { accepted: false, additionalContext: notMainContext(E.agent, reason) }
    }
    if (g && Number(g.pid) !== pid) endGen(g, pendingEnd.get(g.id) ?? (E.pidAlive(Number(g.pid)) ? 'replaced' : 'killed'))
    const same = currentGen()
    // WO-201 (point 3; inventory L7): a compaction inside a turn is not its end. Measured on every lanes journal of the Mac mini and txmonster (2026-11-27):
    // 82 of 82 compactions of a running turn went on under the SAME prompt_id; until 1.59.0 its items were queued again here (`session_start`, 112 copies
    // in 4 days, nearly all answered twice). The turn stays open (in_turn, its prompt): its items end at its Stop like any turn's.
    const goesOn = !!same && same.state === 'in_turn' && !!same.prompt_id && b.source === 'compact'
    let capped: Row[] = []
    // another session in the same process while a turn was open (a /clear, a /resume): the turn is over; its items are settled as at a gen's end
    if (same && same.state === 'in_turn' && same.prompt_id && !goesOn) capped = settle(same, items(r => (r.state === 'offered' || r.state === 'bound') && r.gen === same.id && r.prompt_id === same.prompt_id), 'session_start').capped
    const id = String(pid)
    if (b.source === 'clear') work.delete(id)                               // 002w (B, 24a): the new session never saw that work
    // 002w (E, gap 13): the main's wall is an episode of the AGENT: a gen that ended walled hands its open episode to this one, whose first final Stop
    // ends it with the one wall-down notice (2a936a7: the episode ended with the gen, and Joey heard main-wall-up and never the recovery)
    const ended = J().rows('main', r => r.state === 'gone' && !!r.wall_since && r.id !== id)
    const since = ended.map(r => String(r.wall_since)).sort()[0]
    const carry = since ? { wall_since: since, wall_menu: ended.map(r => r.wall_menu).filter(Boolean).pop() ?? null } : {}
    const previous = same ?? J().lastMain
    for (const r of ended) J().write('main', r.id, 'gone', { wall_since: null, probes: null, retry_at: null, wall_menu: null })
    // lanes-golive: the SessionStart context reaches the conversation on startup, clear and compact; on resume it is all but lost (25 of 334, Chiron's
    // measure), so a resumed main gets the rules on its first prompt instead (UserPromptSubmit)
    const carried = ['startup', 'clear', 'compact'].includes(String(b.source ?? ''))
    J().write('main', id, goesOn ? 'in_turn' : E.streamOpen(pid) ? 'idle' : 'starting', { pid, session_id: sid, transcript_path: b.transcript_path ?? (goesOn ? same!.transcript_path ?? null : null),
      source: b.source ?? null, ...(goesOn ? {} : { prompt_id: null, tool_open: null, stopped_prompt: null }), end_reason: null, rules_shown: carried ? sid : null, ...carry,
      cut_turn: previous?.cut_turn ?? null, resume_sent: previous?.resume_sent ?? null, resumes: previous?.resumes ?? 0 })
    cur = id
    registryGap = null
    lastEventAt.set(id, Date.now())
    try { E.expect?.(sid) } catch {}                                       // 002v: the main's session now (a /clear changed it): the next launch's id
    E.log('info', `lanes: main gen ${id} (session ${sid}, ${b.source ?? 'startup'})`)
    if (goesOn) E.log('info', `lanes: main gen ${id}: compaction inside turn ${same!.prompt_id}: the turn goes on, nothing queued again (WO-201)`)
    tellCut(capped, 'session_start')
    try { E.genChanged(pid) } catch {}
    void pump()
    return carried ? { accepted: true, additionalContext: E.context(E.agent, sid) } : { accepted: true }
  }
  /** Run on a registry change and on the existing M2 tick (also covers a missed watch event at startup). */
  function registryChanged(now = Date.now()): void {
    if (currentGen()) return
    const candidate = E.registry?.mainForAdoption()
    if (!candidate) {
      if (!registryGap?.told) registryGap = null
      return
    }
    const { sessionId, pid, transcript } = candidate
    let why = candidate.issue
    if (!why) {
      if (!E.expectedSession().includes(sessionId)) why = 'not expected (main-expected)'
      else if (sessionStart({ event: 'SessionStart', source: 'adopt', session_id: sessionId, transcript_path: transcript }, pid).accepted) {
        E.log('info', `lanes: main adopted from the session registry session=${sessionId} pid=${pid}`)
        return
      } else why = 'adoption refused'
    }
    registryGap ??= { since: now, told: false }
    if (!registryGap.told && now - registryGap.since >= REG_SETTLE_MS) {
      registryGap.told = true
      const text = `${E.agent} 的主線出現在 session registry，但 M2 尚未接手（session=${sessionId} pid=${pid}，${why}）。`
      E.log('warn', text)
      E.tellJoey(text, 'main-registry-disagreement')
    }
  }
  /** the tg daemon's MCP stream of the main opened: a starting gen can now be offered */
  function streamOpened(pid: number): void {
    const g = currentGen()
    if (g && Number(g.pid) === pid && g.state === 'starting') setMain(g, 'idle')
    void pump()
  }
  /** every few seconds: kill -0 (SIGKILL fires no hook), the stuck rule, and a pump (an item no stream could take is still queued) */
  /** WO-157b: the main's statusOf as the daemon reads it now (idle: true when its state is idle). Two readings at least MAIN_IDLE_CONFIRM_MS apart that
   *  both say idle while M2 holds the turn open, and no hook event of the gen between them: the turn ended without a Stop (Esc). It is closed as
   *  interrupted (cutTurn, as beginTurn does for a turn that never got Stop or StopFailure), M2 goes idle, the items that came in meanwhile are offered
   *  and the cut ones ride with the next delivery (WO-157c). Returns true when it closed a turn.
   *  WO-169: `interruptedAt` (ms): since when the status record has said the screen shows this turn interrupted (the judge read 「Interrupted · What
   *  should Claude do instead?」). Seen after the gen's last hook event, it is the evidence the second reading waits for: the turn is closed at once. Seen
   *  before it (a record not yet re-judged after a new turn began), it is not: the two readings as above */
  let idleSeen: { gen: string; at: number; ev: number } | null = null
  function statusIdle(isIdle: boolean, now = Date.now(), interruptedAt: number | null = null): boolean {
    const g = currentGen()
    if (!g || g.state !== 'in_turn' || !isIdle) { idleSeen = null; return false }
    const ev = lastEventAt.get(g.id) ?? 0
    const seen = interruptedAt != null && interruptedAt > ev
    if (seen) idleSeen = { gen: g.id, at: now, ev }
    else {
      if (!idleSeen || idleSeen.gen !== g.id || idleSeen.ev !== ev) { idleSeen = { gen: g.id, at: now, ev }; return false }
      if (now - idleSeen.at < MAIN_IDLE_CONFIRM_MS) return false
    }
    const heldS = Math.round((now - idleSeen.at) / 1000)
    idleSeen = null
    const back = cutTurn(g).filter(r => owed(r))
    openTools.delete(g.id)
    setMain(g, 'idle', { prompt_id: null, tool_open: null, stopped_prompt: null, ended_by: 'interrupted' })   // WO-172: the turn's end, for its turn_end facts
    // WO-157c (Chiron 15:25Z, 1): the cut items are held, not offered on their own (1.55.1 offered them and the main began again 4 s after Esc); what
    // came in during the turn and never reached the conversation is offered now, with them riding
    E.log('info', `lanes: main gen ${g.id}: its turn ended without a Stop (${seen ? 'the status record shows it interrupted' : `statusOf idle for ${heldS} s`}, no hook event): closed as interrupted, ${back.length} item(s) held to ride the next delivery`)
    void pump()
    return true
  }
  /** the untaken notice (an idle gen that does not take what it is given): one sentence, the stuck rule's and WO-157c's */
  const untakenText = (mins: number, menu: string | null, queued: number, again: boolean): string =>
    `主線疑似卡死：交給它的訊息 ${mins} 分鐘沒有被接手（行程還活著，但沒有開始新的回合）。${menu ?? ''}有 ${queued} 則訊息等它，${again ? '我再交給它一次' : '已經再交給它一次，還是沒有被接手'}。`
  async function tick(now = Date.now()): Promise<void> {
    if (!E) return
    const previous = currentGen()
    if (previous && !E.pidAlive(Number(previous.pid))) endGen(previous, pendingEnd.get(previous.id) ?? 'killed')
    registryChanged(now)
    const g = currentGen()
    // WO-177 一 (Chiron: 「它有自己的 blocker：選單歸值班員或 Joey、上限有 until」): while the status record says the main waits on a menu or on the wall, that
    // blocker is the record's own (the observation names who takes it, and the wall its until): no stuck alarm is sent for it
    const m = member()
    const wall = wallDelivery(g)
    const held = m === 'waiting' || wall.active
    // 002w (E, gaps 4, 11): owed items queued past MAIN_STUCK_MS that nobody could take: no live gen, or a live gen that is neither in a turn (it would
    // pull them), nor walled (its wall notice told Joey), nor holding an offer (an offer it does not take is the silence rule below), and could not be
    // offered them. One alarm per episode, with the count; the next delivery ends it.
    if (!stuck && !held && (!g || ((g.state === 'idle' || g.state === 'starting') && !items(r => r.state === 'offered' && r.gen === g.id).length))) {
      const owedNow = items(r => r.state === 'queued' && owed(r) && !heldCut(r) && !batchedRider(r, now) && !waitsRetry(r, now))     // WO-157c: a held item waits for a delivery, not for a stream (WO-164: a batched one too; WO-201: a failed turn's, its retry time)
      if (owedNow.some(r => now - Date.parse(String(r.ts)) > MAIN_STUCK_MS)) {
        stuck = { gen: g?.id ?? null, prompt: null, at: now, undelivered: true }
        const mins = Math.max(1, Math.round((now - Math.min(...owedNow.map(r => Date.parse(String(r.ts))))) / 60_000))
        // WO-177 ② (Chiron 03:41Z, verbatim): the record says the main is working (busy, stuck) while M2 has had no turn: the items wait on the record, not on
        // a channel. The push stays; its sentence says that (the channel sentence is for a record that says it can take them and still nothing went in)
        E.tellJoey(!g ? `主線不在：現在沒有登記中的主線，${owedNow.length} 則訊息等它（最久的等了 ${mins} 分鐘）。警報和同事的事由車道照常處理；主線一登記我就交給它並告訴你。`
          : m === 'busy' || m === 'stuck' ? `主線的畫面顯示在處理中，但 ${Math.max(1, Math.round(MAIN_STUCK_MS / 60_000))} 分鐘沒有任何回合事件；有 ${owedNow.length} 件排著還沒交進去。`
          : `主線收不到訊息：${owedNow.length} 則訊息送不進主線（它的訊息通道沒有開，最久的等了 ${mins} 分鐘；行程還活著）。警報和同事的事由車道照常處理；一送進去我會告訴你。`, 'main-undelivered')
      }
    }
    if (g && !stuck) {
      // 疑似卡死, on M2 alone: the gen owes a hook event (a turn is open, or an offer is unbound) and has sent none for MAIN_STUCK_MS. The silence counts
      // from its last hook event, or from the offer when that came later. One alarm per episode; the next hook event clears it (mainEvent).
      const offered = items(r => r.state === 'offered' && r.gen === g.id)
      const offeredAt = offered.length ? Math.min(...offered.map(r => Date.parse(r.ts))) : 0
      // P14, refined (002q G03): an open tool call is work for as long as that tool is bounded: a Bash runs at most its declared timeout, so the
      // silence allowed is the larger of MAIN_STUCK_MS and that bound. A tool that declares no bound (an MCP call can hang for ever) is silence
      // like any other after MAIN_STUCK_MS. A dead process is kill -0's. One rule: the gen owes a hook event (a turn is open, or an offer is
      // not taken) and has sent none for longer than it could legitimately be silent
      const owes = g.state === 'in_turn' || ((g.state === 'idle' || g.state === 'walled') && offered.length > 0)
      // WO-177 一: an idle gen's silence counts only while the status record says it can take an item (from when it last turned so): the time it could not
      // (a menu, a compaction, the wall) is not silence. `take`: it can now
      const take = !wall.active && g.state === 'idle' && canTake(g, now)
      const from = take && takeSince?.gen === g.id ? takeSince.at : 0
      const since = Math.max(lastEventAt.get(g.id) ?? now, offeredAt, from)
      const limit = g.state === 'in_turn' && g.tool_open ? Math.max(MAIN_STUCK_MS, toolBound.get(g.id) ?? 0) : MAIN_STUCK_MS
      // 002x: the offer's own bound. An idle gen's offer still unbound after OFFER_LEASE_MS of silence goes back to `queued` (reason offer_untaken)
      // and the pump below writes it once more. `reoffered` on the item names the gen that got it twice: the lease does it once per gen, and the
      // stuck episode below does not write such an item a third time (a client that is frozen, not deaf, takes every copy when it runs again).
      // WO-177 一: only an offer the record said the main could take for the whole lease was 「可以拿卻沒拿」 (a menu open: Claude Code holds the copy and
      // gives it the moment the menu closes; a second copy would be a second prompt)
      const untaken = take ? offered.filter(r => r.reoffered !== g.id) : []
      if (untaken.length && now - since > OFFER_LEASE_MS && now - since <= limit) {
        for (const r of untaken) J().write('msg', r.id, 'queued', { reason: backReason(r, 'offer_untaken'), gen: null, prompt_id: null, via_pull: null, reoffered: g.id })
      } else if (owes && held && now - since > limit) {
        // WO-177 一: the record names the blocker (a menu, the wall): no stuck episode, nobody told. A walled gen's probe item goes back to wait for its
        // next probe time (a probe offer is the one way its own hook events resume), as the episode below would have put it back
        if (g.state === 'walled') for (const r of offered.filter(r => !r.person_wall_offer)) J().write('msg', r.id, 'queued', { reason: backReason(r, 'probe_untaken'), gen: null, prompt_id: null, via_pull: null })
      } else if (owes && now - since > limit) {
        stuck = { gen: g.id, prompt: g.prompt_id ?? null, at: now }
        // what the episode writes again: a walled gen's probe item (its next probe), an idle gen's item the lease has not written again yet
        const again = g.state === 'walled' ? offered : g.state === 'idle' ? offered.filter(r => r.reoffered !== g.id) : []
        const queued = items(r => r.state === 'queued' && owed(r)).length + offered.length
        // 002y (X-1): a limit menu on a main still in its turn is the main-wall mechanism's, not the watchdog's (lanes.ts mainMenuOwned): when no
        // StopFailure came to wall it, this alarm is what reads the menu and puts it in front of Joey, in a turn as well as idle
        const menu = E.menu ? (await E.menu(false).catch(() => null))?.text ?? null : null
        const mins = Math.max(1, Math.round((now - since) / 60_000))
        const doing = g.state === 'in_turn' ? items(r => r.state === 'bound' && r.gen === g.id && r.prompt_id === g.prompt_id && r.kind !== 'digest').map(r => contentOf(r).replace(/\s+/g, ' ').slice(0, 60)).filter(Boolean) : []
        E.tellJoey(g.state === 'in_turn'
          ? `主線疑似卡死：它在一個回合裡已經 ${mins} 分鐘沒有任何動靜${g.tool_open ? `（停在工具 ${g.tool_open} 裡沒有回來）` : ''}${doing.length ? `；它正在處理：${doing.map(t => `「${t}」`).join('、')}` : ''}。${menu ?? ''}有 ${queued} 則訊息等它。警報和同事的事由車道照常處理。要停掉可以用 /kill_stuck；它一有動靜我會再告訴你。`
          : untakenText(mins, menu, queued, !!(again.length || !offered.length)), 'main-stuck')
        // 002q (H02, H03): an offer the gen never took (no hook event for it: a notification lost on the client side, under host load) is not left to
        // wait for ever. The stuck episode is the signal: its untaken items go back to `queued` (reason stuck_unbound) and M1 offers once more, now.
        // Once per episode (the alarm does not fire again until a hook event ends it), and no timer of its own. A walled gen's probe item waits for
        // its next retry time like any probe.
        for (const r of again) J().write('msg', r.id, 'queued', { reason: backReason(r, 'stuck_unbound'), gen: null, prompt_id: null, via_pull: null, ...(g.state === 'idle' ? { reoffered: g.id } : {}) })
      } else if ((take || (g.state === 'walled' && wall.clear != null)) && !offered.length) {
        // WO-157c (Chiron 15:25Z, 1): a colleague's, a scheduler's or an alert's item of an interrupted turn that no new turn took within MAIN_STUCK_MS goes
        // the untaken path above: Joey is told (the same words) and it is offered once more, now leading an offer (with Chiron's line in front). Joey's own
        // items never go this way: they wait for the next delivery. WO-177 一: only while the record says the main can take one, counted from then.
        // WO-201 (Chiron mesh-13184): an item whose turn a dead process, another session or a StopFailure cut after the model had answered it (`cut_by`) goes
        // this way too, Joey's own included: an Esc is Joey stopping it; a process that died is not, and with no next delivery nothing else would wake it
        const quietFrom = Math.max(from, wall.clear ?? 0)
        const cutOld = items(r => !wall.active && heldCut(r) && owed(r) && (r.kind !== 'joey' || !!r.cut_by) && forGen(r, g) && now - Math.max(Date.parse(String(r.cut_at ?? r.ts)), quietFrom) > MAIN_STUCK_MS)
        // WO-201 (Chiron mesh-13191): when every such item is one a dead process, another session or a StopFailure cut (`cut_by`), it is not stuck: an
        // interrupted turn waited MAIN_STUCK_MS with nothing coming in to ride. It is offered alone once and nobody is told: no main-stuck push, no stuck
        // episode (so no main-unstuck either); before 1.59.1 such an item was offered again at once and Joey heard nothing. Any item without `cut_by`
        // (Esc-cut, a turn with no Stop: WO-157c) keeps the stuck path exactly as before
        const quiet = cutOld.length > 0 && cutOld.every(r => !!r.cut_by)
        if (quiet) {
          for (const r of cutOld) J().write('msg', r.id, 'queued', { reason: 'interrupted_untaken' })
          E.log('info', `lanes: main gen ${g.id}: ${cutOld.length} item(s) of a turn cut by ${[...new Set(cutOld.map(r => String(r.cut_by)))].join(', ')} had no delivery to ride for ${Math.round(MAIN_STUCK_MS / 1000)} s: offered alone once; not a stuck main, nobody told (WO-201)`)
        } else if (cutOld.length) {
          stuck = { gen: g.id, prompt: null, at: now }
          for (const r of cutOld) J().write('msg', r.id, 'queued', { reason: 'interrupted_untaken' })
          const menu = E.menu ? (await E.menu(false).catch(() => null))?.text ?? null : null
          const mins = Math.max(1, Math.round((now - Math.min(...cutOld.map(r => Date.parse(String(r.cut_at ?? r.ts))))) / 60_000))
          E.tellJoey(untakenText(mins, menu, items(r => r.state === 'queued' && owed(r)).length, true), 'main-stuck')
        }
      }
    }
    await pump()
  }


  /** Onsen step 2 (WO-142): Joey edited a message the main has not seen yet. Each item that carries it (chat_id / message_id in its meta), still queued
   *  and never offered, taken in or put back (no `reason`), gets the content and meta `rewrite` gives; the ids rewritten ([] = none: the caller delivers
   *  the edit as a new message) */
  /** ids of items whose offer is on its way to the main right now (pump): never rewritten by an edit (Sonn #11516 point 1) */
  const inFlight = new Set<string>()
  function replaceQueued(chat: string, messageId: string, rewrite: (p: { content: string; meta: Record<string, string> }) => { content: string; meta: Record<string, string> }): string[] {
    const rs = items(r => r.state === 'queued' && !r.reason && !inFlight.has(r.id) && r.kind !== 'digest' && metaOf(r.notif).chat_id === chat && String(metaOf(r.notif).message_id ?? '') === messageId)
    for (const r of rs) {
      const p = { ...((r.notif?.params ?? {}) as Record<string, any>) }
      const nw = rewrite({ content: String(p.content ?? ''), meta: { ...(p.meta ?? {}) } })
      J().write('msg', r.id, 'queued', { notif: { method: r.notif.method, params: { ...p, content: nw.content, meta: nw.meta } }, edited_in_queue: true })
    }
    return rs.map(r => r.id)
  }

  return { wallDelivery, initMain, currentGen, mainPid, mainPhase, mainUp, mainSession, markEnd, enqueue, pump, renderPulled, mainEvent, streamOpened, tick, registryChanged, statusIdle, turnWork, turnStart, openTool,
    replaceQueued, mainCanTake, deliveryNow, statusChanged, items: (pred: (r: Row) => boolean = () => true) => items(pred) }
}

// ------------------------------------------------------------------ registration text (the main-only rules travel with the architecture)
export function notMainContext(agent: string, reasons: string): string {
  return `[lanes] 注意：你不是 ${agent} 的主線（${reasons}）。你不會收到 Telegram 或 mesh 訊息，也不要用 reply / send_to_agent 代替主線發言。`
}
export function mainContext(agent: string, sid: string): string {
  return [
    `[lanes] 你是 ${agent} 的主線（session ${sid} 已登記）。以下是主線專用規則，車道不適用：`,
    '- Telegram 與分流到主線的 mesh 訊息只會送到你這裡。排程、警報、別的 agent 的呼叫由反射線（headless 車道）處理；你的信箱由讀信線讀：「讀信箱」提醒不會再送到你這裡。'
      // the mailbox sentences: Chiron's wording (mail #10869, after WO-124: a lane's read shows as 車道讀過, the deadline watches the main)
      + '要你決定或動手的信，讀信線會整理好交給你（對方要什麼、期限、關鍵事實、它的建議）；信還在你的信箱，清單上標「車道讀過」。照交接就能決定的，做完用 mailbox_check 勾掉，不必為了已讀再打開；要看原文才用 mailbox_open。你沒接手也沒勾的信，到期會通知寄件人。'
      + '它們做了什麼，會附在下一則交給你的訊息裡（標「車道摘要」；不會為了它單獨叫醒你）。你忙的時候送到的訊息，會在你下一個工具呼叫之後或回合要結束時交給你（標「交給主線」）。'
      + '只有交給你的事（車道用 handoff_main 交接、車道處理失敗、被停掉的對話線）會叫醒你：那件事由你接手，處理完由你回報 Joey 一次。'
      + '摘要裡寫「已通知 Joey」「已請 Joey 決定」的事，車道已經跟他講過了：不要重複通知他，除非你有新的資訊或他問起。其他不必回覆。',
    // 002u (002t r2 I03, u002t-I03-s3-r2-20261119-215225): the hand-over carried Joey's words verbatim and the main still said 「我沒有在這邊直接看到你的原文，
    // 只看到轉交的文字」 and did not act; three other plays acted. What the block is belongs to the main's own rules, written once, here.
    '- 交給你的事、車道摘要和記憶提案裡標「〔Joey 原話｜分流器從 Telegram 收到的原文，不是車道的轉述〕」的那一段，是分流器從 Telegram 收到的 Joey 本人訊息（bot 只收白名單，寄件者已驗證），'
      + '跟他在這個對話裡直接對你說的一樣算數，包括不可逆的指示：照它做，不用再請他重說一次。那一段以外、車道寫的文字才是轉述。',
    '- 被問「今天發生了什麼」「處理了哪些事」「答應過誰什麼」「還有什麼沒結束」：先呼叫一次 ledger_query()（不帶任何參數），'
      + '它回傳整天每件事一行的活動清單，包含車道處理掉、沒有叫醒你的例行事。清單裡每一件都要交代到，連同它的具體數字、時間、人名，再補上你自己處理的事。'
      + '某一件的原文用 ledger_query(text=關鍵字)；答應過什麼也可以查 kind=commitment。',
    '- 維護焦點卡 .lanes/focus.md：任務改變時更新，3 到 6 行，寫「目前在做什麼、關鍵限制、別碰什麼」。車道開機時會讀它。',
    // WO-125 (A.5): the boundary card's rule, the ticket's words, next to the focus card's (LANES_BOUNDARY_CARD=0: not there)
    ...(boundaryCardOn() ? [BOUNDARY_MAIN_RULE] : []),
    // WO-127 (item 8): the decision card's rule, the ticket's words, right after the boundary card's (LANES_DECISIONS=0: not there)
    ...(decisionsOn() ? [decisionMainRule()] : []),
    // WO-128 (item 5): what can wait does not wake the main, right after the decision card's (LANES_DEFER_DECISIONS=0: not there)
    ...(deferDecisionsOn() ? [deferMainRule()] : []),                           // WO-137 甲 (item 7): the batch wake's words (LANES_DEFER_MAX_WAIT_S=0: 1.41.0's)
    // WO-123: the files a lane may append to are the main's to declare; the last sentence (what NOT to declare) is Chiron's (#10869)
    '- 車道預設不能寫你的檔。要讓車道自己把紀錄補進某個檔（日誌、流水帳、狀態紀錄），在 .lanes/appendable.txt 宣告它：一行一個相對路徑（只收 .md .txt .log .csv .tsv .jsonl；記憶、.lanes/、CLAUDE.md、REANCHOR 與它列的定錨檔、設定檔一律不收）。'
      + '車道用 append_file 把內容加在檔案最後，既有內容它動不了。你自己往這些檔加內容也用 append_file 或 shell 的 >>，不要整檔重寫，車道同時加的那一行才不會掉。'
      + '會被程式讀進去照著做的檔（排程或交易用的狀態、清單、佇列）不要宣告，就算副檔名收：車道處理的是別人送來的文字，它加進去的一行會被那支程式當真。',   // Chiron's sentence (#10869)
    '- 長任務或要讀很多東西的事交出去：open_worker(title, brief) 開一條綁 Joey 私訊話題的工作線（一件事一個話題；它回你話題連結和話題名稱；bot 沒開私訊話題時，它會告訴你，那就自己做）；fork(task) 開一條帶著你目前脈絡的分身線。'
      + '做完用 lane_close 收掉：話題標上 ✅、留著不刪；Joey 之後在那個話題說的話交給你，你的 reply 會自動回到那個話題（reply_to 他那則，或 topic 指定；topic="0" 是話題外）。'
      + '話題裡來的訊息，標籤帶 topic_state（closed＝那條線已結束）和 topic_anchor（那條線的定錨檔）：回答前先讀那份檔，話題裡講過的用 chat_history 查。',   // WO-146: Onsen records topic messages (thread) in the DM's conversation; chat_history lists them
    '- 一件事可以拆成幾塊各自去查：用 fan_out(tasks, conclusion)，每塊開一條查詢線，最後一條綜合線讀完全部、交回你一份結論；你讀的是一份綜合，不是 N 份全文。不要自己一塊一塊查。',
    '- 你答應了別人什麼（給 Joey 或別的 agent「我會…」「…前給你」）：用 commitment(who, what, by, due) 記下；有時限就填 due，到時沒標完成會提醒 Joey。做完用 commitment_done。',
    '- 帳本裡累積了好幾筆記憶提案、你又閒著：用 curate_memory 把寫入權交給一條整理線去整理，做完它自己交還（curate_stop 隨時收回）；單筆提案用 memory_decide 決定。',
    '- 回報車道交給你的事時照平常用 reply（照現行規則推播：做了什麼就報什麼）。找別隻 agent 照 agent-inbox 的說明用 send_to_agent 的三條線（動態／信／呼叫）。'
      + '排程的回執照人格檔用 ~/.claude/tools/btcc-receipt complete <run>（一個 run 只會完成一次，車道已完成的會被擋下並告訴你）。',
    '- 上面這些車道工具（fan_out、commitment、commitment_done、curate_memory、curate_stop、memory_decide、memory_history、memory_revert、open_worker、fork、peer_hold、append_file）可能是延遲載入的：看不到就先用 ToolSearch 搜它的名字載入，再呼叫。',
    '- 記憶目錄只有主線寫，每次寫入自動 commit；車道只能在帳本留 memory_proposal，你在摘要裡看到再決定要不要寫。'
      + '記憶目錄是 git：memory_history 看誰在什麼時候改了什麼；要退回某一次改動，用 memory_revert(sha, reason)，不要手動改回去。',
  ].join('\n')
}
