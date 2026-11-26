// WO-192 (Chiron; design https://rescue.tunnel.fud.city/onsen-bridge.html, Onsen's half WO-191 = Onsen 0.31.0): an agent's words to a person are
// written into Onsen FIRST (that moment counts as said), then sent to Telegram, then their delivery is reported to Onsen. One reply = one Onsen message.
//   A  POST /messages: the fields the record has always had, idem_key tg:<agent>:<chat>:out:pre:<uuid>, NO client_msg_id, delivery {client: telegram,
//      state: pending}, the whole body (not split), attachment_file_ids (the reply's files, uploaded before A). Not taken: tried again after 1 s, 3 s,
//      10 s; still not (or refused for good, a 4xx): the send fails with 「Onsen 沒收下，這一則沒有送出」 and nothing goes to Telegram (no path around Onsen).
//   Telegram: exactly as before (each part rich, plain on a rendering error; each file its own message), run by the caller's steps, whose Bot API calls
//      are not recorded (server.ts runs them inside Onsen.withoutRecord: the message is already in Onsen; recorded too, one reply would be 2–3 messages).
//   B  POST /messages/<id>/delivery {client, state: sent | failed, client_msg_ids (every Telegram message it became, in order), at, error?}: through
//      the spool (OnsenClient.recordDeliveryReport, kind 'r'), so it reaches Onsen before a later edit or reaction of that message (their target is
//      found by those numbers) and survives a restart. Once per message: sent, or failed when the resends gave up.
//   Telegram failing: the send does not fail; it says 「已寫進 Onsen（網頁看得到）；Telegram 還沒送到：<why>，會再送」, and the parts not yet sent go again
//      after 10 s, 30 s, 2 min (a 429: its retry_after at least). A Telegram timeout (the part may have arrived) is never sent again (item 7): B failed.
//   ONSEN_FIRST (firstOn): the switch, off by default; only against an Onsen ≥ 0.31.0 (OnsenVersion: GET /v1/meta at start and every 10 min; an
//      older Onsen ignores `delivery` and has no B).
import { randomUUID } from 'crypto'
import type { OnsenItem } from './onsen-client.ts'

type Log = (level: 'info' | 'warn' | 'error', msg: string) => void
/** one call to Onsen with this agent's credential (OnsenClient.request): null = no credential; throws on a network error or the timeout */
export type Request = (method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number) => Promise<{ status: number; json: any } | null>

/** the Onsen that takes `delivery` on A and has B (WO-191, 88c130b) */
export const MIN_ONSEN = '0.31.0'
/** A: the waits before each new try (the first try is at once) */
export const WRITE_RETRY_MS = [1_000, 3_000, 10_000]
/** A: one try's bound */
export const WRITE_TRY_MS = 5_000
/** Telegram failed: the waits before each resend of the parts not yet sent */
export const RESEND_MS = [10_000, 30_000, 120_000]
/** Onsen's version: how often it is read again; after no answer, sooner */
export const VERSION_EVERY_MS = 10 * 60_000
export const VERSION_RETRY_MS = 60_000

export const NOT_TAKEN = 'Onsen 沒收下，這一則沒有送出'
export const heldText = (why: string): string => `已寫進 Onsen（網頁看得到）；Telegram 還沒送到：${why}，會再送`
export const unsureText = (why: string): string => `已寫進 Onsen（網頁看得到）；Telegram 沒有回應：${why}；可能已經送到，不會再送（先看 Telegram 再決定要不要再說一次）`

/** ONSEN_FIRST: unset, empty, 0 / off / false / no = off (the default); a comma list of agent names or `*` = on for those agents */
export function firstOn(value: string | undefined, agent: string): boolean {
  const v = String(value ?? '').trim()
  if (!v || ['0', 'off', 'false', 'no'].includes(v.toLowerCase())) return false
  const list = v.split(',').map(x => x.trim()).filter(Boolean)
  return list.includes('*') || list.includes(agent)
}
/** a.b.c ≥ min.b.c (numeric; a missing part is 0; anything after the numbers, as in 0.31.0-rc1, is ignored) */
export function versionAtLeast(v: string, min: string): boolean {
  const nums = (s: string) => (String(s).trim().match(/^v?(\d+(?:\.\d+)*)/)?.[1] ?? '').split('.').filter(Boolean).map(Number)
  const a = nums(v), b = nums(min)
  if (!a.length) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = a[i] ?? 0, y = b[i] ?? 0; if (x !== y) return x > y }
  return true
}
export const idemPre = (agent: string, chat: string): string => `tg:${agent}:${chat}:out:pre:${randomUUID()}`

/** an error's own words: the innermost cause (sendTextParts wraps a part's failure), the token never (a Bot API address carries it) */
const errText = (e: unknown): string => {
  let x: any = e
  for (let n = 0; n < 3 && x?.cause instanceof Error; n++) x = x.cause
  return (x instanceof Error ? x.message : String(x)).replace(/\s+/g, ' ').replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<token>').slice(0, 300)
}
const said = (j: any): string => { const e = j?.error ?? j?.detail; return e == null ? '' : ` (${String(typeof e === 'object' ? e.message ?? e.code ?? JSON.stringify(e) : e).slice(0, 200)})` }
const RETRYABLE_4XX = new Set([401, 403, 408, 425, 429])
/** a 429's wait, in seconds (grammy's GrammyError.parameters, else the description "retry after N"); 0 = none */
export function retryAfterS(e: unknown): number {
  for (let x: any = e, n = 0; x && n < 3; x = x.cause, n++) {
    const p = Number(x?.parameters?.retry_after)
    if (Number.isFinite(p) && p > 0) return p
    const m = /retry after (\d+)/i.exec(String(x?.message ?? ''))
    if (m) return Number(m[1])
  }
  return 0
}

/** Onsen's version (GET /v1/meta → data.server_version), read at start and every VERSION_EVERY_MS; no answer keeps what was known (and reads again
 *  sooner). `ok`: known and ≥ MIN_ONSEN */
export class OnsenVersion {
  version: string | null = null
  checkedAt: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> | null = null
  private started = false
  private triedAt = 0
  constructor(private o: { request: Request; log: Log; everyMs?: number; retryMs?: number }) {}
  get ok(): boolean { return this.version != null && versionAtLeast(this.version, MIN_ONSEN) }
  /** one read (a read already running is shared); never throws */
  check(): Promise<void> {
    this.running ??= (async () => {
      this.triedAt = Date.now()
      let next = this.o.retryMs ?? VERSION_RETRY_MS
      try {
        const r = await this.o.request('GET', '/v1/meta', undefined, 5_000)
        const v = r && r.status === 200 ? r.json?.data?.server_version ?? r.json?.server_version : null
        if (typeof v === 'string' && v.trim()) {
          const was = this.ok, first = this.version == null
          this.version = v.trim(); this.checkedAt = new Date().toISOString(); next = this.o.everyMs ?? VERSION_EVERY_MS
          if (first || was !== this.ok) this.o.log('info', `onsen first: Onsen is ${this.version}: ${this.ok ? `≥ ${MIN_ONSEN}, a reply is written into Onsen before Telegram (where ONSEN_FIRST is on)` : `older than ${MIN_ONSEN}, replies are recorded after Telegram as before`}`)
        } else this.o.log('warn', `onsen first: GET /v1/meta ${r ? `answered HTTP ${r.status}` : 'not asked (no mesh credential)'}; ${this.version ? `keeping ${this.version}` : 'version unknown: replies are recorded after Telegram as before'}`)
      } catch (e) {
        this.o.log('warn', `onsen first: GET /v1/meta: ${errText(e)}; ${this.version ? `keeping ${this.version}` : 'version unknown: replies are recorded after Telegram as before'}`)
      } finally {
        this.running = null
        if (this.started) this.schedule(next)
      }
    })()
    return this.running
  }
  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.check() }, ms)
    ;(this.timer as any).unref?.()
  }
  start(): void { if (this.started) return; this.started = true; void this.check() }
  stop(): void { this.started = false; if (this.timer) clearTimeout(this.timer); this.timer = null }
  /** never read yet: wait for the read running (or a new one, unless one failed within the retry wait: no reply waits on an Onsen that is not
   *  answering) at most `ms` */
  async ensure(ms: number): Promise<boolean> {
    if (this.version != null) return this.ok
    if (!this.running && Date.now() - this.triedAt < (this.o.retryMs ?? VERSION_RETRY_MS)) return false
    await Promise.race([this.running ?? this.check(), new Promise(r => { const t = setTimeout(r, ms); (t as any).unref?.() })])
    return this.ok
  }
  health(): Record<string, unknown> { return { onsen_version: this.version, version_ok: this.ok, version_checked_at: this.checkedAt } }
}

/** thrown by a send that has no Telegram id to give (the lanes' sendBot) when the message is written into Onsen and Telegram has not taken it yet: it
 *  is said (not a failure, not to be sent again by the caller); `message` is the sentence for whoever sent it. lanes.ts reads `heldInOnsen` */
export class HeldInOnsen extends Error {
  readonly heldInOnsen = true
  constructor(message: string, readonly onsenId: number, readonly sentIds: number[]) { super(message) }
}

/** one Telegram message of a reply (a text part, a file): sends it, gives its message_id */
export type Step = { what: string; run: () => Promise<number> }
/** what B says (POST /messages/<id>/delivery) */
export type Report = { client: 'telegram'; state: 'sent' | 'failed'; client_msg_ids: string[]; at: string; error?: string }
/** the item A writes: a record with `delivery` and no client_msg_id */
export type FirstItem = OnsenItem & { delivery: { client: 'telegram'; state: 'pending' } }
/** ids: the Telegram messages it became (all of them: sent). held: written into Onsen, Telegram not (yet): the sentence for the caller, the Onsen id,
 *  the parts that did go */
export type Outcome = { ids: number[] } | { held: string; onsenId: number; ids: number[] }

/** A, Telegram, B (see the top of this file) */
export class FirstSender {
  readonly stats = { written: 0, write_duplicates: 0, write_retries: 0, write_refused: 0, written_without_files: 0, delivered: 0, held: 0, resent: 0,
    gave_up: 0, unsure: 0 }
  constructor(private o: {
    request: Request; log: Log
    /** B: one report into the spool (OnsenClient.recordDeliveryReport) */
    report: (onsenId: number, r: Report) => void
    /** a Telegram timeout (the part may have arrived: never sent again) */
    isTimeout: (e: unknown) => boolean
    retryMs?: number[]; tryMs?: number; resendMs?: number[]
  }) {}
  private sleep(ms: number): Promise<void> { return new Promise(r => { const t = setTimeout(r, ms); (t as any).unref?.() }) }

  /** A, tried at once and after each WRITE_RETRY_MS wait. A 4xx that is not worth repeating ends it at once; one that refuses the files (an upload
   *  swept, not this agent's) is tried once more as `bare` (the same message without them). Never throws */
  async write(item: FirstItem, bare?: FirstItem): Promise<{ id: number } | { error: string }> {
    const waits = this.o.retryMs ?? WRITE_RETRY_MS
    let it = item, last = 'not tried'
    for (let n = 0; n <= waits.length; n++) {
      if (n > 0) { this.stats.write_retries++; await this.sleep(waits[n - 1]!) }
      let r: { status: number; json: any } | null
      try { r = await this.o.request('POST', '/messages', it, this.o.tryMs ?? WRITE_TRY_MS) }
      catch (e) { last = `POST /messages: ${errText(e)}`; continue }
      if (!r) return { error: 'no mesh credential' }
      if (r.status >= 200 && r.status < 300 && /^\d{1,18}$/.test(String(r.json?.id ?? ''))) {
        this.stats.written++
        if (r.json.duplicate) this.stats.write_duplicates++
        return { id: Number(r.json.id) }
      }
      last = `POST /messages answered HTTP ${r.status}${said(r.json)}`
      if (r.status >= 400 && r.status < 500 && !RETRYABLE_4XX.has(r.status)) {
        if (bare && it !== bare && it.attachment_file_ids?.length) {
          this.o.log('warn', `onsen first: ${it.idem_key}: Onsen refused it with its files (${last}); written again without them (their names only)`)
          this.stats.written_without_files++
          it = bare; n--                                   // at once, not counted as a retry
          continue
        }
        return { error: last }
      }
    }
    return { error: last }
  }

  /** A, then the Telegram steps, then B. A not taken: throws `NOT_TAKEN（why）` (nothing was sent). `late`: the Telegram ids once a resend ends (all
   *  that went, sent or given up) */
  async send(o: { item: FirstItem; bare?: FirstItem; steps: Step[]; late?: (ids: number[]) => void }): Promise<Outcome> {
    const w = await this.write(o.item, o.bare)
    if ('error' in w) {
      this.stats.write_refused++
      this.o.log('warn', `onsen first: ${o.item.idem_key}: Onsen did not take it (${w.error}); nothing was sent to Telegram`)
      throw new Error(`${NOT_TAKEN}（${w.error}）`)
    }
    const id = w.id, ids: number[] = []
    const r = await this.run(o.steps, 0, ids)
    if (r === true) {
      this.stats.delivered++
      this.report(id, 'sent', ids)
      return { ids }
    }
    const why = this.why(o.steps, r.at, ids, r.err)
    if (this.o.isTimeout(r.err)) {
      this.stats.unsure++
      this.o.log('warn', `onsen first: Onsen message ${id} (${o.item.idem_key}): Telegram did not answer for ${o.steps[r.at]!.what} (${errText(r.err)}); it may have arrived: not sent again, reported failed`)
      this.report(id, 'failed', ids, `${o.steps[r.at]!.what}: ${errText(r.err)}`)
      return { held: unsureText(why), onsenId: id, ids: [...ids] }
    }
    this.stats.held++
    this.o.log('warn', `onsen first: Onsen message ${id} (${o.item.idem_key}) written; Telegram failed at ${o.steps[r.at]!.what} after ${ids.length} of ${o.steps.length} message(s): ${errText(r.err)}; sent again after ${(this.o.resendMs ?? RESEND_MS).map(ms => `${ms / 1000} s`).join(', ')}`)
    void this.resend(id, o, r.at, ids, r.err)
    return { held: heldText(why), onsenId: id, ids: [...ids] }
  }

  /** the parts from `from` on, in order, until one fails */
  private async run(steps: Step[], from: number, ids: number[]): Promise<true | { at: number; err: unknown }> {
    for (let i = from; i < steps.length; i++) {
      try { ids.push(await steps[i]!.run()) } catch (err) { return { at: i, err } }
    }
    return true
  }
  private why(steps: Step[], at: number, ids: number[], err: unknown): string {
    return `${steps[at]!.what}${ids.length ? `（前 ${ids.length} 則已送到）` : ''}：${errText(err)}`
  }
  private report(id: number, state: Report['state'], ids: number[], error?: string): void {
    try { this.o.report(id, { client: 'telegram', state, client_msg_ids: ids.map(String), at: new Date().toISOString(), ...(error ? { error } : {}) }) }
    catch (e) { this.o.log('warn', `onsen first: the ${state} report of Onsen message ${id} was not spooled: ${errText(e)}`) }
  }
  /** the background resend: the parts not yet sent, after each RESEND_MS wait (a 429's retry_after at least); B once at the end */
  private async resend(id: number, o: { item: FirstItem; steps: Step[]; late?: (ids: number[]) => void }, from: number, ids: number[], err: unknown): Promise<void> {
    let at = from, last = err
    try {
      for (const wait of this.o.resendMs ?? RESEND_MS) {
        await this.sleep(Math.max(wait, retryAfterS(last) * 1000))
        const r = await this.run(o.steps, at, ids)
        if (r === true) {
          this.stats.resent++
          this.o.log('info', `onsen first: Onsen message ${id} (${o.item.idem_key}) sent again: Telegram has all ${ids.length} message(s) now (${ids.join(', ')})`)
          this.report(id, 'sent', ids)
          return
        }
        at = r.at; last = r.err
        if (this.o.isTimeout(last)) break                  // it may have arrived: never sent again
      }
      this.stats.gave_up++
      const error = `${o.steps[at]!.what}${ids.length ? `（前 ${ids.length} 則已送到）` : ''}: ${errText(last)}`
      this.o.log('warn', `onsen first: Onsen message ${id} (${o.item.idem_key}): Telegram still failing (${error}); gave up, reported failed`)
      this.report(id, 'failed', ids, error)
    } finally {
      if (ids.length) { try { o.late?.([...ids]) } catch {} }
    }
  }
}
