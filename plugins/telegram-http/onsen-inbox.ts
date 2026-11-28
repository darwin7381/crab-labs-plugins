import { stamp } from './lanes-digest.ts'

type Log = (level: 'info' | 'warn' | 'error', msg: string) => void
export type Answer = { status: number; json: any } | null
/** one call to one Onsen base with the daemon's credential (onsen-client.ts OnsenClient.request); null = no credential; throws on a network error */
export type Req = (method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number) => Promise<Answer>

export function switchOn(value: string | undefined, agent: string): boolean {
  const list = String(value ?? '').split(',').map(x => x.trim()).filter(Boolean)
  return list.includes('*') || list.includes(agent)
}

/** WO-158: a roster url that is BTCC's own mailbox inject (/api/mesh/mailbox/<name>/inject: a mailbox-type identity such as bt-app-codex, no daemon,
 *  nothing takes from Onsen for it): send_to_agent keeps the push to it */
export function isMailboxInject(url: unknown): boolean {
  try { return /^\/api\/mesh\/mailbox\/[^/]+\/inject\/?$/.test(new URL(String(url ?? '')).pathname) } catch { return false }
}
// ------------------------------------------------------------------ send (3b)
// Onsen 0.9.3: WO-147's source kinds (/send refuses any other name with 400)
export type SendKind = 'peer_call' | 'peer_mail'
/** the sender's facts in their own fields (Onsen 0.9.3, Chiron WO-151 11:15Z); the text stays as the agent reads it */
export type SendFacts = { refs?: { btcc_msg_id?: number; thread?: string; op?: string
    /** WO-175 item 2 (CONTRACT §4): the Call a reply answers (its call id) */
    call?: string }; no_reply?: boolean }

/** error: why it was not stored (only when stored is false) */
export type SendOutcome = { stored: boolean; duplicate: boolean; pulling: boolean; error?: string
  /** WO-163 point 7 (Epeius; Chiron WO-164 point 7): the recipient's state as Onsen holds it, when /send answers it ({state, reporting, reported_s_ago,
   *  walled_until?, waiting_for?}); absent from an Onsen that does not send it */
  recipient?: Record<string, unknown> }
/** WO-164 point 7 (Chiron, WO-164 15:56Z, his words; WO-163 point 7): the sentence that follows the original one in the tool result of send_to_agent (call,
 *  mail) and a lane's reply_agent when the answer carries the recipient's state as Onsen holds it (`recipient`: {state, reporting, reported_s_ago,
 *  walled_until?, waiting_for?}, Onsen 0.12.2 /send). Only these four; every other state adds nothing (''). Nothing is decided here (who gets it): the state
 *  is said. The 1.52.0 sentence 「X's daemon is not taking messages right now」 stays for its own case (the recipient's daemon is not taking from Onsen).
 *  Reporting lost first (the state shown is then the last one sent, not the present); a wall: walled_until, a `walled` field or state; HH:MM in the lanes'
 *  zone (LANES_TZ, as the 此刻 line) when the time is known. */
export function recipientNote(to: string, rec: unknown): string {
  if (!rec || typeof rec !== 'object') return ''
  const r = rec as Record<string, any>
  const x = String(to ?? '').trim() || '對方'
  if (r.reporting === 'lost') {
    const n = Number(r.reported_s_ago)
    return `${x} 已經 ${Number.isFinite(n) ? Math.round(n) : '?'} 秒沒有回報狀態，可能沒在跑。訊息排著。`
  }
  const wall = r.walled_until ?? (r.walled && typeof r.walled === 'object' ? r.walled.until : undefined)
  if (wall != null || r.walled === true || (r.walled && typeof r.walled === 'object') || r.state === 'walled') {
    const ms = typeof wall === 'number' ? wall : typeof wall === 'string' ? Date.parse(wall) : NaN
    const hm = Number.isFinite(ms) && ms > 0 ? stamp(new Date(ms).toISOString()).slice(6) : ''
    return `${x} 現在撞到用量上限${hm ? `，約 ${hm} 恢復` : ''}。你的訊息排著，它恢復後才會看到。`
  }
  if (r.state === 'offline') return `${x} 的主線現在不在線上。例行的事它的分身照常處理；要主線決定的，等它回來才會看到。`
  if (r.state === 'waiting') return `${x} 的主線停在一個選單上等 Joey 按，按完之前看不到你的訊息；例行的事它的分身照常處理。`
  return ''
}
export class OnsenSender {
  /** sent: stored (new or already there); not_pulling: stored while the recipient's daemon was not polling (queued); failed: not stored */
  readonly stats = { sent: 0, duplicate: 0, not_pulling: 0, failed: 0, last_error: null as string | null }
  private warnAt = 0
  constructor(readonly o: { req: Req; log: Log; now?: () => number }) {}
  /** POST /send; never throws. stored: Onsen has it (new or already had it); pulling (Onsen 0.9.1): Onsen has seen the recipient’s connector within its active window (ruling 44); not pulling: it takes it when it polls again */
  async send(to: string, kind: SendKind, payload: Record<string, unknown>, dedupe: string | null, facts: SendFacts = {}): Promise<SendOutcome> {
    try {
      const refs = facts.refs && Object.keys(facts.refs).length ? facts.refs : undefined
      const post = () => this.o.req('POST', '/send', { to, kind, payload, ...(dedupe ? { dedupe } : {}), ...(refs ? { refs } : {}),
        ...(facts.no_reply ? { no_reply: true } : {}) }, 10_000)
      const r = await post()
      const res = r?.status === 200 && Array.isArray(r.json?.results) ? r.json.results : null
      if (res) {
        this.stats.sent++
        const duplicate = res[0]?.duplicate === true, pulling = res[0]?.pulling === true
        if (duplicate) this.stats.duplicate++
        if (!pulling) this.stats.not_pulling++
        const rec = res[0]?.recipient ?? r?.json?.recipient
        return { stored: true, duplicate, pulling, ...(rec && typeof rec === 'object' ? { recipient: rec as Record<string, unknown> } : {}) }
      }
      throw new Error(r ? `HTTP ${r.status}${r.json?.detail ? ` ${String(r.json.detail).slice(0, 120)}` : ''}` : 'no mesh credential')
    } catch (e) {
      this.stats.failed++
      this.stats.last_error = `${e instanceof Error ? e.message : e}`.slice(0, 200)
      const now = this.o.now ? this.o.now() : Date.now()
      if (now - this.warnAt > 300_000) { this.warnAt = now; this.o.log('warn', `onsen send: ${kind} to ${to} not written to Onsen (${this.stats.last_error})`) }
      return { stored: false, duplicate: false, pulling: false, error: this.stats.last_error ?? 'not stored' }
    }
  }
}
