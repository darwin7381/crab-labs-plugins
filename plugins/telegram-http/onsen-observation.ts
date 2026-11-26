// onsen-observation.ts — WO-180 (Chiron's ticket 2026-11-26; Joey TG chiron:2549 「人上線的時候可能名字旁邊會有燈好亮著，正在運行中可能會有 … 小
// svg 動畫甚至不用點進去在外面列表也能看到在動」, 2515 「不要補丁式」): the observation this daemon composes with its status record (screen-status.ts
// composeRecord; /healthz onsen.status.observation) goes to Onsen as it is, so Onsen's status of this agent has one source (CONTRACT v1 §3, §9).
//
//   what     PUT {Onsen}/v1/members/<agent>/observation with the credential /status/batch uses; the body is the object /healthz shows, unchanged (its ten
//            fields; reported_at = when it was composed). Onsen keeps the newest by reported_at and holds it 45 s
//   when     the record changed: at the point it is handed out (server.ts feed), not at a tick; unchanged: every HEARTBEAT_MS (15 s), the record
//            computed again for it (refresh) so reported_at is new; the first one the daemon composes
//   pace     one request in flight. When it comes back and the record changed meanwhile, the newest goes at once; what came between is dropped (no
//            queue, no replay, no spool: a snapshot, not an event; Onsen does not let an older one replace a newer one anyway)
//   failure  TIMEOUT_MS (5 s); nothing is thrown and nothing else waits on it (delivery, replies, /status/batch). A 400 (invalid_request: Onsen names the
//            rule the observation broke) is counted and written once per distinct message in this daemon's life as one line of
//            <workspace>/.lanes/run/screen-exceptions.jsonl (kind observation_rejected); it is not sent again: the next one goes at the next change or beat
//   switch   ONSEN_OBSERVATION (a comma list of agent names or `*`); not listing this agent: nothing is sent. /status/batch is unchanged either way
import type { Observation } from './screen-status.ts'

export const HEARTBEAT_MS = 15_000
export const TIMEOUT_MS = 5_000
/** distinct rejection messages written in one daemon's life at most (Onsen's messages name a field path, not a value: a few dozen exist) */
const TOLD_MAX = 100

export type PutAnswer = { status: number; json: any } | null
export interface ObservationPutDeps {
  agent: string
  /** ONSEN_OBSERVATION lists this agent, now */
  on(): boolean
  /** one PUT of `body` with the agent's credential, aborted at timeoutMs; null: no credential (nothing sent); throws on a network error or the timeout */
  put(body: Observation, timeoutMs: number): Promise<PutAnswer>
  /** compute the status record now (the tick's own step): the observation it composes is handed in through update() */
  refresh?(): void
  /** one line for run/screen-exceptions.jsonl */
  exception(line: Record<string, unknown>): void
  log(level: 'info' | 'warn', msg: string): void
  now?(): number
}
export type ObservationPutHealth = { on: boolean; sent: number; rejected: number; last_ok_at: string | null; last_status: number | null; last_error: string | null }

/** the observation without reported_at: what "the record changed" compares */
export const changeKey = (o: Observation): string => { const { reported_at: _r, ...rest } = o; return JSON.stringify(rest) }
const errText = (e: unknown): string => {
  const n = (e as { name?: unknown } | null)?.name
  if (n === 'TimeoutError' || n === 'AbortError') return 'timeout'
  return e instanceof Error ? e.message : String(e)
}
/** a put that ignores its own abort does not hold the one slot forever: given up this long after timeoutMs (counted as a timeout) */
const GUARD_MS = 1_000

export class ObservationPut {
  readonly heartbeatMs: number
  readonly timeoutMs: number
  /** the observation handed in last, its change key, and when */
  private latest: { o: Observation; key: string; ms: number } | null = null
  /** the change key of the last one sent, and when it was sent (ms) */
  private sentKey: string | null = null
  private sentAt = -Infinity
  private inflight = false
  private beat: ReturnType<typeof setTimeout> | null = null
  /** the beat fired and nothing has gone since (a timer a millisecond early is still the beat) */
  private beatNow = false
  private wasOn: boolean | null = null
  private stopped = false
  private told = new Set<string>()
  /** sent: PUTs made; rejected: answered 400; last_status: the last answer's HTTP status (null: none came back: a timeout, a network error, no credential) */
  readonly stats = { sent: 0, rejected: 0, last_ok_at: null as string | null, last_status: null as number | null, last_error: null as string | null }
  constructor(readonly d: ObservationPutDeps, o: { heartbeatMs?: number; timeoutMs?: number } = {}) {
    this.heartbeatMs = o.heartbeatMs ?? HEARTBEAT_MS
    this.timeoutMs = o.timeoutMs ?? TIMEOUT_MS
  }
  private now(): number { return (this.d.now ?? Date.now)() }
  /** the switch now; a change is logged once. Off: nothing held, no beat; on again: the next one handed in goes at once */
  private isOn(): boolean {
    let on = false
    try { on = this.d.on() } catch {}
    if (on !== this.wasOn) {
      if (this.wasOn !== null || on) this.d.log('info', on ? `onsen: observation on for ${this.d.agent} (PUT /v1/members/${this.d.agent}/observation at each change of the record and every ${this.heartbeatMs / 1000} s)`
        : `onsen: observation off for ${this.d.agent} (ONSEN_OBSERVATION does not list it): nothing sent`)
      this.wasOn = on
      if (!on) { this.latest = null; this.sentKey = null; this.sentAt = -Infinity; this.beatNow = false; this.disarm() }
    }
    return on
  }

  /** the record was handed out with this observation (server.ts feed): sent now if it changed or the beat is due; else nothing */
  update(o: Observation): void {
    if (this.stopped || !this.isOn()) return
    this.latest = { o, key: changeKey(o), ms: this.now() }
    this.flush()
  }
  /** the latest goes out if nothing is in flight and it is due: changed since the last one sent, or the beat is due (a held one only while it is
   *  fresh: handed in within one beat, so a compute loop that stopped is not reported as alive) */
  private flush(): void {
    const l = this.latest
    if (this.inflight || !l || this.stopped) return
    const now = this.now()
    const changed = l.key !== this.sentKey, beatDue = this.beatNow || now - this.sentAt >= this.heartbeatMs
    if (!changed && !(beatDue && now - l.ms <= this.heartbeatMs)) return
    this.sentKey = l.key; this.sentAt = now; this.beatNow = false
    this.arm()
    this.inflight = true
    this.stats.sent++
    void this.send(l.o)
  }
  private async send(o: Observation): Promise<void> {
    let r: PutAnswer = null, err: unknown = null, guard: ReturnType<typeof setTimeout> | null = null
    try {
      r = await Promise.race([this.d.put(o, this.timeoutMs), new Promise<never>((_, no) => {
        guard = setTimeout(() => no(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), this.timeoutMs + GUARD_MS)
        ;(guard as any).unref?.()
      })])
    } catch (e) { err = e } finally { if (guard) clearTimeout(guard) }
    this.inflight = false
    try { this.note(o, r, err) } catch {}
    this.flush()                                                     // it changed while this one was out: the newest, now
  }
  private note(o: Observation, r: PutAnswer, err: unknown): void {
    if (err != null || !r) {
      this.stats.last_status = null
      this.stats.last_error = err != null ? errText(err) : 'no mesh credential'
      return
    }
    this.stats.last_status = r.status
    if (r.status >= 200 && r.status < 300) { this.stats.last_ok_at = new Date(this.now()).toISOString(); this.stats.last_error = null; return }
    const e = r.json?.error, code = typeof e?.code === 'string' ? e.code : null
    const message = typeof e?.message === 'string' ? e.message : `HTTP ${r.status}`
    this.stats.last_error = code ? `${code}: ${message}` : message
    if (r.status !== 400) return
    this.stats.rejected++
    const k = `${code ?? ''}|${message}`
    if (this.told.has(k) || this.told.size >= TOLD_MAX) return
    this.told.add(k)
    this.d.log('warn', `onsen: observation rejected (${this.stats.last_error}); written to screen-exceptions.jsonl once, the next one is sent as usual`)
    try { this.d.exception({ ts: new Date(this.now()).toISOString(), agent: this.d.agent, kind: 'observation_rejected', kinds: ['observation_rejected'], status: r.status, code, message, observation: o }) } catch {}
  }
  /** the beat: HEARTBEAT_MS after the last one sent, the record computed again (refresh hands it in: it goes, its reported_at new); if refresh handed
   *  nothing in, the held one goes while it is fresh; else nothing until the next update() (the beat being overdue, it goes then) */
  private arm(): void {
    this.disarm()
    if (this.stopped) return
    this.beat = setTimeout(() => {
      this.beat = null
      if (this.stopped || !this.isOn()) return
      this.beatNow = true
      try { this.d.refresh?.() } catch {}
      this.flush()
    }, Math.max(0, this.sentAt + this.heartbeatMs - this.now()))
    ;(this.beat as any).unref?.()
  }
  private disarm(): void { if (this.beat) clearTimeout(this.beat); this.beat = null }
  stop(): void { this.stopped = true; this.disarm() }
  /** /healthz onsen.status.put */
  health(): ObservationPutHealth {
    let on = false
    try { on = this.d.on() } catch {}
    return { on, ...this.stats }
  }
}
