/**
 * lanes-main.ts — M1 (the delivery ledger) and M2 (the main record). docs/state-journal.md has the journal shapes.
 *
 * M2. The main is one record per process ("gen", id = its pid): starting | idle | in_turn(prompt_id, tool_open) | walled(kind) | gone(end_reason).
 *     It moves only on the main's own hook events (lanes-hooks/main-hook.py posts every one of them to /lanes/main-event) and on one
 *     `kill -0` of its pid (SIGKILL fires no hook). Nothing reads the transcript.
 * M1. One record per item meant for the main: queued → offered(gen) → bound(gen, prompt_id) → done.
 *     The one rule: an item is done only when the turn it was bound to ends with Stop. StopFailure, or the end of its gen, puts it back
 *     to queued for the next idle gen. An idle main is offered one item (it opens the turn); a busy main is never pushed to: its hook
 *     pulls queued items at the next tool boundary (PostToolUse) or at Stop, and they are bound to that prompt at that moment.
 * One writer: the tg daemon. Information (the digest) is never offered alone: it rides the next offer or pull.
 */
import type { Journal, Row } from './lanes-state.ts'

export type Notif = { method: string; params: unknown }
export type ItemKind = 'joey' | 'peer' | 'alert' | 'digest' | 'handoff' | 'carry'
export type Via = 'tg' | 'inbox'
export type MainPhase = 'starting' | 'idle' | 'in_turn' | 'walled' | 'gone'
export type EndReason = 'asked' | 'killed' | 'exited' | 'replaced'

export type MainEnv = {
  journal: Journal
  agent: string
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
  /** write one notification into the open MCP stream of main process `pid` on daemon `via`; true = written */
  offer: (notif: Notif, via: Via, pid: number) => Promise<boolean>
  /** the tg daemon has an open MCP stream of process `pid` (an offer can be written) */
  streamOpen: (pid: number) => boolean
  /** the information that rides a delivery (the digest): its text and its item fields (`events`: event id → the record version shown; `items`); null = nothing new */
  info: () => { text: string; fields: Record<string, unknown> } | null
  /** an item reached done */
  done: (item: Row) => void
  /** a line to Joey from the router (push), with the rule that sent it */
  tellJoey: (text: string, rule: string) => void
  /** the shared model wall (one record for the lanes and the main) */
  wallUp: (kind: string, text: string, by: string) => void
  wallActive: () => boolean
  /** the session id the keeper launched (.lanes/main-expected), or a renew in progress */
  expectedSession: () => string[]
  pidAlive: (pid: number) => boolean
  /** a SessionStart that is not the main was refused */
  refused: (sid: string, pid: number | null, reason: string) => void
  /** the main process changed (the MCP sessions of the old one lose the main's tools) */
  genChanged: (pid: number | null) => void
  /** the limit-menu pane read (a TUI state no hook reports): a sentence for Joey, or null */
  menu?: () => Promise<string | null>
  /** the registration context an accepted main gets */
  context: (agent: string, sid: string) => string
}

export type MainEvent = {
  event: string; session_id?: string; prompt_id?: string; pid?: number; transcript_path?: string; source?: string
  error?: string; tool_name?: string; tool_input?: any; dids?: string[]; phase?: 'check' | 'final'; reason?: string
}
export type MainReply = { accepted?: boolean; additionalContext?: string; block?: string
  items?: Array<{ mid: string; kind: string; user: string; no_reply: boolean; system: boolean; body: string }>; outputs?: Output[] }
type Output = { to: string; reply_to: string; text: string }

const num = (k: string, d: number): number => { const n = Number(process.env[k] ?? d); return Number.isFinite(n) ? n : d }
/** 疑似卡死: a gen in a turn with no hook event for this long, or idle with an offer it never took */
export let MAIN_STUCK_MS = num('LANES_MAIN_STUCK_MS', 600_000)
export const __setMainStuckMs = (ms: number): void => { MAIN_STUCK_MS = ms }
// SPECIAL CASE (kept, see RBP report): an offer written into a client that is still starting can be dropped by it (002h/002i: 50 ms after connect).
// An unbound item has had no effect, so the same item is offered again to the same idle gen when no hook event at all came after the offer.
export let OFFER_RETRY_MS = num('LANES_OFFER_RETRY_MS', 20_000)
export const __setOfferRetryMs = (ms: number): void => { OFFER_RETRY_MS = ms }
const BODY_MAX = 4000


export type MainApi = ReturnType<typeof createMain>
/** one M1 + M2 per lanes instance (the tg daemon has one; tests load several) */
export function createMain(E: MainEnv) {
  let cur: string | null = null                           // the live gen (id = pid as text)
  const lastEventAt = new Map<string, number>()          // gen → ms of its last hook event (silence = the stuck rule)
  const pendingEnd = new Map<string, EndReason>()        // gen → why it is about to end (asked: /restart; replaced: /main renew)
  const outputs = new Map<string, Output[]>()            // prompt id → the reply / send_to_agent calls of that turn (answered gate)
  let stuck: { gen: string; prompt: string | null; at: number } | null = null
  let offering = false
  let seq = 0
  const bootAt = Date.now()

  const J = (): Journal => E.journal
  /** boot: fold done by the caller (journal.load); pick the live gen */
  function initMain(): void {
    cur = null; stuck = null; offering = false
    lastEventAt.clear(); pendingEnd.clear(); outputs.clear()
    const live = J().rows('main', r => r.state !== 'gone')
    for (const g of live.slice(0, -1)) endGen(g, 'replaced')            // only one gen can be live
    const g = live[live.length - 1]
    if (g) { cur = g.id; lastEventAt.set(g.id, Date.now()) }
    seq = J().rows('msg').length
  }

  // ------------------------------------------------------------------ M2 queries (everything else asks these)
  function currentGen(): Row | null { return cur ? J().get('main', cur) ?? null : null }
  function mainPid(): number | null { const g = currentGen(); return g ? Number(g.pid) : null }
  function mainPhase(): MainPhase { return (currentGen()?.state as MainPhase) ?? 'gone' }
  /** the main is there: a live gen that is not walled */
  function mainUp(): boolean { const p = mainPhase(); return p === 'idle' || p === 'in_turn' || p === 'starting' }
  /** since when the main has been away (gone or walled), ms; 0 = it is there */
  function awaySince(): number {
    const g = currentGen()
    if (g && g.state === 'walled') return Date.parse(g.ts)
    if (g) return 0
    const last = J().rows('main').pop()
    return last ? Date.parse(last.ts) : bootAt                // no main has registered since this daemon started
  }
  function mainSession(): { session_id: string; pid: number; transcript_path: string } | null {
    const g = currentGen()
    return g ? { session_id: String(g.session_id ?? ''), pid: Number(g.pid), transcript_path: String(g.transcript_path ?? '') } : null
  }
  /** the main's process is about to end for this reason (/restart and /kill_stuck: asked; /main renew: replaced) */
  function markEnd(reason: EndReason): void { if (cur) pendingEnd.set(cur, reason) }

  // ------------------------------------------------------------------ M1
  let didSeq = 0
  const newId = (): string => `m-${Date.now().toString(36)}-${(++didSeq).toString(36)}`
  const items = (pred: (r: Row) => boolean): Row[] => J().rows('msg', pred)
  const metaOf = (n: Notif): Record<string, string> => (((n?.params ?? {}) as any).meta ?? {}) as Record<string, string>
  /** queue an item for the main. `target` = only the gen with this session id may take it (a renew brief is for the new main). */
  function enqueue(kind: ItemKind, notif: Notif, o: { via?: Via; event?: string | null; target?: string; fields?: Record<string, unknown> } = {}): string {
    const id = newId()
    const params = { ...((notif.params ?? {}) as Record<string, unknown>) }
    params.meta = { ...metaOf(notif), did: id }
    J().write('msg', id, 'queued', { kind, via: o.via ?? 'tg', event: o.event ?? null, ...(o.target ? { target: o.target } : {}), notif: { method: notif.method, params }, ...(o.fields ?? {}) })
    seq++
    const g = currentGen()
    if (kind === 'digest') J().write('wake', id, 'no_wake', { reason: 'information: rides the next delivery' })
    else if (!g || g.state !== 'idle') J().write('wake', id, 'no_wake', { reason: !g ? 'main gone: offered to the next gen' : g.state === 'in_turn' ? 'main in a turn: pulled at its next tool boundary or Stop' : `main ${g.state}` })
    if (kind !== 'digest') void pump()
    return id
  }
  const owed = (r: Row): boolean => r.kind !== 'digest'
  const forGen = (r: Row, g: Row): boolean => !r.target || r.target === g.session_id
  /** the digest that rides this delivery: the one queued digest item, refreshed, or a new one; null = nothing to tell */
  function attachInfo(): Row | null {
    const inf = E.info()
    if (!inf) return null
    const q = items(r => r.kind === 'digest' && r.state === 'queued')
    const notif = { method: 'notifications/claude/channel', params: { content: inf.text, meta: { chat_id: 'lanes', user: 'lanes', user_id: 'lanes', via: 'lanes', kind: 'digest', no_reply: 'true' } } }
    if (q.length) {
      const d = q[q.length - 1]
      J().write('msg', d.id, 'queued', { notif: { ...notif, params: { ...notif.params, meta: { ...notif.params.meta, did: d.id } } }, ...inf.fields })
      return J().get('msg', d.id)!
    }
    const id = enqueue('digest', notif, { fields: inf.fields })
    return J().get('msg', id)!
  }
  function contentOf(r: Row): string { return String((r.notif?.params as any)?.content ?? '') }

  /** the gen is idle and has nothing offered: offer it the oldest owed item, with the information riding on it */
  async function pump(): Promise<void> {
    if (!E || offering) return
    offering = true                                                   // one offer at a time: the decision and the write are one transition
    try { await offerNext() } finally { offering = false }
  }
  async function offerNext(): Promise<void> {
    const g = currentGen()
    if (!g || g.state !== 'idle') return
    if (items(r => r.state === 'offered' && r.gen === g.id).length) return            // one offer opens one turn
    const it = items(r => r.state === 'queued' && owed(r) && forGen(r, g))[0]
    if (!it) return
    const dg = attachInfo()
    const ids = [it.id, ...(dg ? [dg.id] : [])]
    const p = (it.notif?.params ?? {}) as Record<string, any>
    const content = dg ? `${contentOf(dg)}\n〔以上是系統附上的車道摘要，只附這一次；以下才是這則訊息本身〕\n${String(p.content ?? '')}` : String(p.content ?? '')
    const notif = { method: it.notif.method, params: { ...p, content, meta: { ...(p.meta ?? {}), did: ids.join(','), ...(dg ? { lane_digest: 'rides' } : {}) } } }
    let ok = false
    try { ok = await E.offer(notif, it.via as Via, Number(g.pid)) } catch (e) { E.log('warn', `lanes: offer of ${it.id} failed: ${e}`) }
    const now = currentGen()
    if (!ok || !now || now.id !== g.id) {
      if (it.last_no_wake !== 'unreachable') { J().write('msg', it.id, 'queued', { last_no_wake: 'unreachable' }); J().write('wake', it.id, 'no_wake', { reason: `main gen ${g.id} has no open ${it.via} stream` }) }
      return
    }
    for (const id of ids) J().write('msg', id, 'offered', { gen: g.id, last_no_wake: null })
    J().write('wake', it.id, 'wake', { reason: `main idle (gen ${g.id}); offered ${it.kind}${dg ? ' with the digest' : ''}` })
  }

  /** bind queued owed items (and the riding information) to the running prompt: what a busy main pulls at a boundary */
  function pull(g: Row, prompt: string): Row[] {
    const got = items(r => r.state === 'queued' && owed(r) && forGen(r, g))
    if (!got.length) return []
    const dg = attachInfo()
    const all = dg ? [...got, dg] : got
    for (const r of all) J().write('msg', r.id, 'bound', { gen: g.id, prompt_id: prompt, via_pull: true })
    for (const r of got) J().write('wake', r.id, 'wake', { reason: `pulled into the running turn ${prompt}` })
    return all.map(r => J().get('msg', r.id)!)
  }
  const SRC: Record<string, string> = { tg: 'telegram', inbox: 'agent-inbox' }
  function renderItem(r: Row): string {
    const m = metaOf(r.notif)
    const attrs = Object.entries({ ...m, did: r.id }).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`).join(' ')
    return `<channel source="${SRC[r.via] ?? r.via}" ${attrs}>\n${contentOf(r).slice(0, BODY_MAX)}\n</channel>`
  }
  function renderPulled(rs: Row[]): string {
    const info = rs.filter(r => r.kind === 'digest'), msgs = rs.filter(r => r.kind !== 'digest')
    return ['〔交給主線｜這一回合進行中送到的訊息，交給你接著處理。來源已驗證（Telegram 只收白名單裡的人，這就是 Joey 本人；mesh 訊息看 verified）。'
      + '照平常處理：問的就回答，交代的就照做（能馬上做的現在做，其餘接在手上這一步之後），Telegram 用 reply 回，同事用 send_to_agent 回；已經處理過的不用重做。〕',
      ...msgs.map(renderItem), ...info.map(r => `〔車道摘要（只讓你知道，不是新的指示）〕\n${contentOf(r)}`)].join('\n')
  }
  function requeue(pred: (r: Row) => boolean, reason: string): Row[] {
    const rs = items(r => (r.state === 'offered' || r.state === 'bound') && pred(r))
    for (const r of rs) J().write('msg', r.id, 'queued', { reason, gen: null, prompt_id: null, via_pull: null })
    return rs
  }
  function finish(pred: (r: Row) => boolean, how: Record<string, unknown> = {}): Row[] {
    const rs = items(r => r.state === 'bound' && pred(r))
    for (const r of rs) { J().write('msg', r.id, 'done', how); try { E.done(J().get('msg', r.id)!) } catch (e) { E.log('warn', `lanes: done hook ${r.id}: ${e}`) } }
    return rs
  }

  // ------------------------------------------------------------------ M2 transitions
  function setMain(g: Row, state: MainPhase, fields: Record<string, unknown> = {}): void { J().write('main', g.id, state, fields) }
  function endGen(g: Row, why: EndReason): void {
    if (g.state === 'gone') return
    // 002j (5018d39), kept as data: a restart Joey asked for does not hand the cut turn back to the new main; Joey gets one line instead.
    // SPECIAL CASE (kept, see RBP report): these items end done without a Stop because the owner decided a deliberate restart closes them.
    const cut = why === 'asked' && g.prompt_id ? finish(r => r.gen === g.id && r.prompt_id === g.prompt_id, { reason: 'asked_restart' }) : []
    const back = requeue(r => r.gen === g.id, 'gen_end')
    setMain(g, 'gone', { end_reason: why, prompt_id: null, tool_open: null })
    if (cur === g.id) cur = null
    pendingEnd.delete(g.id); lastEventAt.delete(g.id)
    if (stuck?.gen === g.id) stuck = null
    if (cut.length) E.tellJoey(`主線被指令重啟（/restart 或 /kill_stuck）。重啟時它正在處理的 ${cut.filter(r => r.kind !== 'digest').length} 則訊息不會自動交給新的主線：${cut.filter(r => r.kind !== 'digest').map(r => contentOf(r).replace(/\s+/g, ' ').slice(0, 80)).join('；')}。還要處理的話請再說一次。`, 'asked-restart')
    E.log('info', `lanes: main gen ${g.id} gone (${why}); ${back.length} item(s) queued again`)
    try { E.genChanged(null) } catch {}
  }
  function beginTurn(g: Row, prompt: string, dids?: string[]): void {
    if (g.prompt_id === prompt) return
    if (g.prompt_id) requeue(r => r.gen === g.id && r.prompt_id === g.prompt_id, 'interrupted')       // a turn that never got Stop or StopFailure
    setMain(g, 'in_turn', { prompt_id: prompt, tool_open: null })
    const ids = new Set((dids ?? []).flatMap(d => String(d).split(',')).map(s => s.trim()).filter(Boolean))
    // what the prompt names (its did="…"), and whatever was offered to this gen: one offer opens one turn, so it is this turn's
    const bind = items(r => (r.state === 'offered' && r.gen === g.id) || (ids.has(r.id) && r.state === 'queued' && forGen(r, g)))
    for (const r of bind) J().write('msg', r.id, 'bound', { gen: g.id, prompt_id: prompt })
  }
  const wallErrors = new Set(['rate_limit', 'authentication_failed', 'billing_error', 'oauth_org_not_allowed', 'account_on_hold', 'server_error', 'cloud_credential_error'])

  /** /lanes/main-event: every hook event of the main. The reply is what the hook prints. */
  async function mainEvent(b: MainEvent): Promise<MainReply> {
    const pid = Number(b.pid) || 0
    const ev = String(b.event ?? '')
    if (ev === 'SessionStart') return sessionStart(b, pid)
    const g = currentGen()
    if (!g || !pid || Number(g.pid) !== pid) return {}                       // not the main: nothing of it is tracked
    lastEventAt.set(g.id, Date.now())
    if (stuck && stuck.gen === g.id) { stuck = null; E.tellJoey('主線又有動靜了（hook 事件恢復），疑似卡死解除。', 'main-unstuck') }
    const p = String(b.prompt_id ?? '')
    switch (ev) {
      case 'UserPromptSubmit': if (p) beginTurn(g, p, b.dids); return {}
      case 'PreToolUse': if (p) { beginTurn(g, p); setMain(J().get('main', g.id)!, 'in_turn', { tool_open: String(b.tool_name ?? 'tool') }) } return {}
      case 'PostToolUse': {
        if (!p) return {}
        beginTurn(g, p)
        const n = String(b.tool_name ?? '')
        if (/(__reply|__send_to_agent)$/.test(n) && b.tool_input?.text) (outputs.get(p) ?? outputs.set(p, []).get(p)!).push({
          to: String(b.tool_input.to ?? (n.endsWith('__reply') ? 'Joey' : '')), reply_to: String(b.tool_input.reply_to ?? ''), text: String(b.tool_input.text) })
        setMain(J().get('main', g.id)!, 'in_turn', { tool_open: null })
        const got = pull(J().get('main', g.id)!, p)
        return got.length ? { additionalContext: renderPulled(got) } : {}
      }
      case 'Stop': {
        if (!p) return {}
        beginTurn(g, p)
        if (b.phase !== 'final') {
          const got = pull(J().get('main', g.id)!, p)
          if (got.length) return { block: '這一輪先不要結束。' + renderPulled(got) }
          const bound = items(r => r.state === 'bound' && r.gen === g.id && r.prompt_id === p && r.kind !== 'digest')
          return { items: bound.map(r => { const m = metaOf(r.notif); return { mid: m.message_id || m.btcc_msg_id || r.id, kind: m.message_id ? 'tg' : m.btcc_msg_id ? 'mesh' : 'sys',
            user: String(m.user ?? ''), no_reply: m.no_reply === 'true', system: m.user === 'lanes' || r.kind === 'handoff' || r.kind === 'carry', body: contentOf(r).slice(0, BODY_MAX) } }), outputs: outputs.get(p) ?? [] }
        }
        finish(r => r.gen === g.id && r.prompt_id === p)
        outputs.delete(p)
        setMain(J().get('main', g.id)!, 'idle', { prompt_id: null, tool_open: null, error: null })
        void pump()
        return {}
      }
      case 'StopFailure': {
        if (p) beginTurn(g, p)
        const err = String(b.error ?? 'unknown')
        const back = requeue(r => r.gen === g.id && (!p || r.prompt_id === p), `stop_failure:${err}`)
        if (p) outputs.delete(p)
        // every API error ends the turn without Stop; a wall kind holds the main until the shared probe gets through
        setMain(J().get('main', g.id)!, 'walled', { kind: wallErrors.has(err) ? err : 'error', error: err, prompt_id: null, tool_open: null })
        E.wallUp(wallErrors.has(err) ? err : 'error', String(b.reason ?? err).slice(0, 200), `main:${back.length}`)
        return {}
      }
      case 'SessionEnd': endGen(g, pendingEnd.get(g.id) ?? 'exited'); return {}
    }
    return {}
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
    if (same && same.state === 'in_turn' && same.prompt_id) requeue(r => r.gen === same.id && r.prompt_id === same.prompt_id, 'session_start')
    const id = String(pid)
    J().write('main', id, E.wallActive() ? 'walled' : E.streamOpen(pid) ? 'idle' : 'starting', { pid, session_id: sid, transcript_path: b.transcript_path ?? null, source: b.source ?? null, prompt_id: null, tool_open: null, end_reason: null })
    cur = id
    lastEventAt.set(id, Date.now())
    E.log('info', `lanes: main gen ${id} (session ${sid}, ${b.source ?? 'startup'})`)
    try { E.genChanged(pid) } catch {}
    void pump()
    return { accepted: true, additionalContext: E.context(E.agent, sid) }
  }
  /** the tg daemon's MCP stream of the main opened: a starting gen can now be offered */
  function streamOpened(pid: number): void {
    const g = currentGen()
    if (g && Number(g.pid) === pid && g.state === 'starting') setMain(g, 'idle')
    void pump()
  }
  /** the shared wall went up (a lane run hit it): an idle main is walled too (same account); a main in a turn meets it itself (StopFailure) */
  function wallRaised(kind: string): void {
    const g = currentGen()
    if (g && (g.state === 'idle' || g.state === 'starting')) setMain(g, 'walled', { kind, error: null })
  }
  /** the shared wall came down: a walled main is idle again */
  function wallLifted(): void {
    const g = currentGen()
    if (g && g.state === 'walled') setMain(g, E.streamOpen(Number(g.pid)) ? 'idle' : 'starting', { kind: null, error: null })
    void pump()
  }

  /** every few seconds: kill -0 (SIGKILL fires no hook), the stuck rule, the offer retry, and a pump */
  async function tick(now = Date.now()): Promise<void> {
    if (!E) return
    const g = currentGen()
    if (g && !E.pidAlive(Number(g.pid))) { endGen(g, pendingEnd.get(g.id) ?? 'killed'); return }
    if (g) {
      const last = lastEventAt.get(g.id) ?? now
      const offered = items(r => r.state === 'offered' && r.gen === g.id)
      const offeredAt = offered.length ? Math.min(...offered.map(r => Date.parse(r.ts))) : 0
      if (!stuck && ((g.state === 'in_turn' && now - last > MAIN_STUCK_MS) || (g.state === 'idle' && offeredAt && now - offeredAt > MAIN_STUCK_MS && last <= offeredAt))) {
        stuck = { gen: g.id, prompt: g.prompt_id ?? null, at: now }
        const queued = items(r => r.state === 'queued' && owed(r)).length + offered.length
        const menu = g.state === 'idle' && E.menu ? await E.menu().catch(() => null) : null
        const mins = Math.max(1, Math.round((now - (g.state === 'idle' ? offeredAt : last)) / 60_000))
        E.tellJoey(g.state === 'in_turn'
          ? `主線疑似卡死：它在一個回合裡已經 ${mins} 分鐘沒有任何動靜${g.tool_open ? `（停在工具 ${g.tool_open}）` : ''}。有 ${queued} 則訊息等它。警報和同事的事由車道照常處理。要停掉可以用 /kill_stuck；它一有動靜我會再告訴你。`
          : `主線疑似卡死：交給它的訊息 ${mins} 分鐘沒有被接手（行程還活著，但沒有開始新的回合）。${menu ?? ''}有 ${queued} 則訊息等它。`, 'main-stuck')
      }
      // SPECIAL CASE (kept): an offer that left no hook event at all is written again (see OFFER_RETRY_MS)
      if (g.state === 'idle' && offered.length && now - offeredAt > OFFER_RETRY_MS && last <= offeredAt) {
        for (const r of offered) J().write('msg', r.id, 'queued', { reason: 'offer_unanswered', gen: null })
        J().write('wake', offered[0].id, 'no_wake', { reason: `offer to gen ${g.id} left no hook event in ${Math.round(OFFER_RETRY_MS / 1000)} s: offered again` })
      }
    }
    await pump()
  }


  return { initMain, currentGen, mainPid, mainPhase, mainUp, awaySince, mainSession, markEnd, enqueue, pump, renderPulled, mainEvent, streamOpened, wallRaised, wallLifted, tick,
    items: (pred: (r: Row) => boolean = () => true) => items(pred) }
}

// ------------------------------------------------------------------ registration text (the main-only rules travel with the architecture)
export function notMainContext(agent: string, reasons: string): string {
  return `[lanes] 注意：你不是 ${agent} 的主線（${reasons}）。你不會收到 Telegram 或 mesh 訊息，也不要用 reply / send_to_agent 代替主線發言。`
}
export function mainContext(agent: string, sid: string): string {
  return [
    `[lanes] 你是 ${agent} 的主線（session ${sid} 已登記）。以下是主線專用規則，車道不適用：`,
    '- Telegram 與分流到主線的 mesh 訊息只會送到你這裡。例行警報、排程、別的 agent 的新話題由反射線（headless 車道）處理；'
      + '它們做了什麼，會附在下一則交給你的訊息裡（標「車道摘要」；不會為了它單獨叫醒你）。你忙的時候送到的訊息，會在你下一個工具呼叫之後或回合要結束時交給你（標「交給主線」）。'
      + '只有交給你的事（車道用 handoff_main 交接、車道處理失敗、被停掉的對話線）會叫醒你：那件事由你接手，處理完由你回報 Joey 一次。'
      + '摘要裡寫「已通知 Joey」「已請 Joey 決定」的事，車道已經跟他講過了：不要重複通知他，除非你有新的資訊或他問起。其他不必回覆。',
    '- 被問「今天發生了什麼」「處理了哪些事」「答應過誰什麼」「還有什麼沒結束」：先呼叫一次 ledger_query()（不帶任何參數），'
      + '它回傳整天每件事一行的活動清單，包含車道處理掉、沒有叫醒你的例行事。清單裡每一件都要交代到，連同它的具體數字、時間、人名，再補上你自己處理的事。'
      + '某一件的原文用 ledger_query(text=關鍵字)；答應過什麼也可以查 kind=commitment。',
    '- 維護焦點卡 .lanes/focus.md：任務改變時更新，3 到 6 行，寫「目前在做什麼、關鍵限制、別碰什麼」。車道開機時會讀它。',
    '- 長任務或要讀很多東西的事交出去：open_worker(title, brief) 開一條綁 Telegram 話題的工作線；fork(task) 開一條帶著你目前脈絡的分身線。',
    '- 一件事可以拆成幾塊各自去查：用 fan_out(tasks, conclusion)，每塊開一條查詢線，最後一條綜合線讀完全部、交回你一份結論；你讀的是一份綜合，不是 N 份全文。不要自己一塊一塊查。',
    '- 你答應了別人什麼（給 Joey 或別的 agent「我會…」「…前給你」）：用 commitment(who, what, by, due) 記下；有時限就填 due，到時沒標完成會提醒 Joey。做完用 commitment_done。',
    '- 帳本裡累積了好幾筆記憶提案、你又閒著：用 curate_memory 把寫入權交給一條整理線去整理，做完它自己交還（curate_stop 隨時收回）；單筆提案用 memory_decide 決定。',
    '- 回報車道交給你的事（摘要或交接裡以〔ho-…〕開頭的那一件）時，reply 帶 handoff_id=那個編號；響不響由分流器依那件事的類別決定，你不用自己判斷。',
    '- 上面這些車道工具（fan_out、commitment、commitment_done、curate_memory、curate_stop、memory_decide、memory_history、memory_revert、open_worker、fork、peer_hold）可能是延遲載入的：看不到就先用 ToolSearch 搜它的名字載入，再呼叫。',
    '- 記憶目錄只有主線寫，每次寫入自動 commit；車道只能在帳本留 memory_proposal，你在摘要裡看到再決定要不要寫。'
      + '記憶目錄是 git：memory_history 看誰在什麼時候改了什麼；要退回某一次改動，用 memory_revert(sha, reason)，不要手動改回去。',
  ].join('\n')
}
