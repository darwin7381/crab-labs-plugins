// WO-151 3a / 3b (Relay part 3; Joey TG chiron:2362 「本地有一份但改以遠端的主要主機程式為主？也會握手同步？」): the agent-inbox daemon takes what is
// sent to it from Onsen (fleet-core onsen5.py, 0.9.0), and a sender also writes what it sends there. Both paths stay on: today's push to /inject and
// this one; the same message is delivered once, by whichever arrives first.
//
//   take (3a)   OnsenPuller holds GET /inbox?after=<last seq taken>&wait=25 (the `after` is the handshake: "I have up to N"). New items are first
//               written to the local copy (pending), then handed, in seq order, to the daemon's own delivery (server.ts deliverInbound, the code /inject
//               runs), then acked (POST /inbox/ack {upto}). A crash between take and hand-off hands the pending items on at the next start (once, not
//               zero times). Onsen answering `reset` (a promoted standby that lost the last instant): continue from its `continue_after`.
//   first start the pull's first start (no local copy of the pull yet) begins at Onsen's current count (GET /inbox with an `after` past any count →
//               reset → continue_after): senders write to Onsen before every daemon pulls, and what is already there came through /inject.
//   local copy  <STATE_DIR>/onsen-inbox.json (OnsenInbox; atomic writes): last_seq taken, acked_seq, the items taken but not yet handed on, and a
//               bounded list of the dedupe keys already delivered (5000, oldest dropped first, each with its time).
//   dedupe      one key per message in both paths (dedupeKeyOf): the sender's explicit `dedupe`, else `msg:<msg_id>` when msg_id is an integer (Onsen's
//               own rule). Whichever path delivers first records it; the other finds it and is dropped (counted). No key: cannot be matched, delivered.
//   Onsen down  the loop backs off (2 s doubling to 60 s); the /inject path keeps working; Onsen keeps what is not acked. One base: ONSEN_BASE
//               (Chiron 11:05Z, Joey TG chiron:2407: no standby switching here).
//   send (3b)   OnsenSender: POST /send after the caller's own push (its latency unchanged). Push delivered: not awaited. Push failed: awaited, and
//               Onsen's `pulling` (0.9.1: the recipient's daemon polled in the last 90 s) makes it delivered; otherwise the failure stands.
// The credential is the daemon's mesh credential (the request functions come from onsen-client.ts); it is never logged here.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'

type Log = (level: 'info' | 'warn' | 'error', msg: string) => void
export type Answer = { status: number; json: any } | null
/** one call to one Onsen base with the daemon's credential (onsen-client.ts OnsenClient.request); null = no credential; throws on a network error */
export type Req = (method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number) => Promise<Answer>

/** one item of the caller's inbox, as GET /inbox gives it (onsen5.py _item). `dedupe`: the sender's key, when Onsen returns it */
export type PullItem = { seq: number; sender: string; relay?: string | null; kind?: string; payload: Record<string, unknown>; at?: string; given?: number
  dedupe?: string | null; dedupe_key?: string | null }

/** A switch (ONSEN_PULL, ONSEN_SEND): a comma list of agent names or `*`; unset or empty = off */
export function switchOn(value: string | undefined, agent: string): boolean {
  const list = String(value ?? '').split(',').map(x => x.trim()).filter(Boolean)
  return list.includes('*') || list.includes(agent)
}

/** The key one message has in both paths: the sender's explicit dedupe (trimmed, ≤200), else msg:<msg_id> when msg_id is an integer, else null */
export function dedupeKeyOf(dedupe: unknown, msgId: unknown): string | null {
  const d = dedupe == null ? '' : String(dedupe).trim().slice(0, 200)
  if (d) return d
  return typeof msgId === 'number' && Number.isInteger(msgId) ? `msg:${msgId}` : null
}
/** a pulled item's key: Onsen's field (dedupe, or dedupe_key), else one in the payload, else msg:<msg_id> */
export function itemKey(it: PullItem): string | null {
  return dedupeKeyOf(it.dedupe ?? it.dedupe_key ?? it.payload?.dedupe, it.payload?.msg_id)
}

// ------------------------------------------------------------------ the local copy
export type InboxFile = { v: 1; last_seq: number; acked_seq: number; pending: PullItem[]; keys: Array<[string, number]>; saved_at?: string
  /** false: the file holds only /inject's keys (the pull never started): the pull's first start still takes Onsen's count */
  based?: boolean }
export const MAX_KEYS = 5000

export class OnsenInbox {
  lastSeq = 0
  ackedSeq = 0
  pending: PullItem[] = []
  /** the pull has a starting point (its baseline or a local copy of its own); false at the pull's first start: it starts at Onsen's count (OnsenPuller.baseline) */
  based = false
  private keys = new Map<string, number>()       // delivered key → ms; insertion order = age (a re-record moves it to the end)
  private claimed = new Set<string>()            // a delivery of this key is in progress (either path)
  readonly stats = { delivered_keys: 0, inject_dup_dropped: 0, save_errors: 0 }
  private saveWarnAt = 0
  constructor(readonly o: { file: string; maxKeys?: number; log?: Log; now?: () => number }) { this.load() }
  private now(): number { return this.o.now ? this.o.now() : Date.now() }

  load(): void {
    let j: Partial<InboxFile> | null = null
    try { j = JSON.parse(readFileSync(this.o.file, 'utf8')) } catch { return }
    if (!j || typeof j !== 'object') return
    this.based = j.based !== false
    this.lastSeq = Number.isInteger(j.last_seq) && j.last_seq! >= 0 ? j.last_seq! : 0
    this.ackedSeq = Number.isInteger(j.acked_seq) && j.acked_seq! >= 0 ? Math.min(j.acked_seq!, this.lastSeq) : 0
    this.pending = Array.isArray(j.pending) ? j.pending.filter(p => p && Number.isInteger(p.seq) && p.payload && typeof p.payload === 'object').sort((a, b) => a.seq - b.seq) : []
    this.keys.clear()
    if (Array.isArray(j.keys)) for (const e of j.keys) if (Array.isArray(e) && typeof e[0] === 'string') this.keys.set(e[0], Number(e[1]) || 0)
    this.trim()
  }
  /** atomic (tmp + rename), 0600; a failure is logged once an hour and the state stays in memory */
  save(): void {
    const body: InboxFile = { v: 1, last_seq: this.lastSeq, acked_seq: this.ackedSeq, pending: this.pending, keys: [...this.keys], based: this.based, saved_at: new Date(this.now()).toISOString() }
    try {
      mkdirSync(dirname(this.o.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.o.file}.tmp`
      writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 })
      renameSync(tmp, this.o.file)
    } catch (e) {
      this.stats.save_errors++
      if (this.now() - this.saveWarnAt > 3600_000) { this.saveWarnAt = this.now(); this.o.log?.('warn', `onsen inbox: could not write ${this.o.file} (${e}); kept in memory`) }
    }
  }
  private trim(): void {
    const max = this.o.maxKeys ?? MAX_KEYS
    while (this.keys.size > max) this.keys.delete(this.keys.keys().next().value!)
  }

  // ---------------------------------------------------------------- dedupe (both paths)
  /** delivered already, or being delivered right now */
  seen(key: string): boolean { return this.keys.has(key) || this.claimed.has(key) }
  /** a delivery of `key` starts (synchronous: two arrivals of one key cannot both pass); false = seen */
  claim(key: string): boolean {
    if (this.seen(key)) return false
    this.claimed.add(key)
    return true
  }
  /** the delivery did not happen (the key stays free) */
  release(key: string): void { this.claimed.delete(key) }
  /** the delivery happened: remembered (and written) */
  record(key: string): void {
    this.claimed.delete(key)
    this.keys.delete(key)
    this.keys.set(key, this.now())
    this.stats.delivered_keys++
    this.trim()
    this.save()
  }
  get keyCount(): number { return this.keys.size }

  // ---------------------------------------------------------------- the pull's own state
  /** items Onsen gave: the ones after last_seq go to pending (in seq order) and last_seq moves; written before any is handed on */
  take(items: PullItem[]): PullItem[] {
    const fresh = items.filter(it => it && Number.isInteger(it.seq) && it.seq > this.lastSeq && it.payload && typeof it.payload === 'object').sort((a, b) => a.seq - b.seq)
    if (!fresh.length) return []
    this.pending.push(...fresh)
    this.lastSeq = fresh[fresh.length - 1]!.seq
    this.save()
    return fresh
  }
  /** this pending item was handed on */
  handed(seq: number): void {
    this.pending = this.pending.filter(p => p.seq !== seq)
    this.save()
  }
  /** the seq everything up to which may be acked: never past an item not yet handed on, never past last_seq */
  ackable(): number {
    const first = this.pending.length ? this.pending[0]!.seq - 1 : this.lastSeq
    return Math.max(0, Math.min(first, this.lastSeq))
  }
  acked(upto: number): void {
    if (upto <= this.ackedSeq) return
    this.ackedSeq = Math.min(upto, this.lastSeq)
    this.save()
  }
  /** Onsen has fewer than this daemon took (a promoted standby): continue from its count; the delivered keys drop the repeats */
  reset(continueAfter: number): void {
    this.lastSeq = Math.max(0, continueAfter)
    this.ackedSeq = Math.min(this.ackedSeq, this.lastSeq)
    this.save()
  }
  /** the pull's first start: begin after Onsen's current count (what is there was sent while the pull was off and came through /inject) */
  baseline(seq: number): void {
    this.lastSeq = Math.max(0, seq)
    this.ackedSeq = Math.min(this.ackedSeq, this.lastSeq)
    this.based = true
    this.save()
  }
}

// ------------------------------------------------------------------ take (3a)
export type HandResult = 'delivered' | 'duplicate' | 'undelivered'

export class OnsenPuller {
  private running = false
  private stopped: Promise<void> | null = null
  private backoffMs = 0
  private warnAt = 0
  private credWarnAt = 0
  private wake: (() => void) | null = null
  readonly stats = { last_poll_at: null as string | null, polls: 0, taken: 0, delivered: 0, dup_dropped: 0, undelivered: 0, unkeyed: 0, replayed: 0,
    resets: 0, errors: 0, last_error: null as string | null, baseline: null as number | null }
  constructor(readonly o: { req: Req; base: string; inbox: OnsenInbox; deliver: (it: PullItem) => Promise<HandResult>; log: Log; host: string
    waitS?: number; limit?: number; minBackoffMs?: number; maxBackoffMs?: number; now?: () => number; noCredentialRetryMs?: number }) {}
  private now(): number { return this.o.now ? this.o.now() : Date.now() }

  start(): void {
    if (this.running) return
    this.running = true
    const n = this.o.inbox.pending.length
    if (n) this.o.log('info', `onsen inbox: ${n} item(s) taken before the last stop and not yet handed on: handing them on first`)
    this.stopped = this.loop()
  }
  async stop(): Promise<void> { this.running = false; this.wake?.(); await this.stopped?.catch(() => {}) }
  private sleep(ms: number): Promise<void> {
    return new Promise(res => { const t = setTimeout(() => { this.wake = null; res() }, ms); (t as any).unref?.(); this.wake = () => { clearTimeout(t); this.wake = null; res() } })
  }

  /** hand on every pending item, in seq order; a throw stops here (the item stays pending, in order) */
  async drain(): Promise<void> {
    const inbox = this.o.inbox
    while (inbox.pending.length) {
      const it = inbox.pending[0]!
      const replay = !this.stats.polls
      const r = await this.o.deliver(it)
      if (replay) this.stats.replayed++
      if (r === 'delivered') { this.stats.delivered++; if (!itemKey(it)) this.stats.unkeyed++ }
      else if (r === 'duplicate') this.stats.dup_dropped++
      else this.stats.undelivered++
      inbox.handed(it.seq)
    }
  }
  private async ack(): Promise<void> {
    const upto = this.o.inbox.ackable()
    if (upto <= this.o.inbox.ackedSeq) return
    const r = await this.o.req('POST', '/inbox/ack', { upto }, 10_000)
    if (r && r.status === 200) this.o.inbox.acked(upto)
    else throw new Error(`ack ${upto}: ${r ? `HTTP ${r.status}` : 'no credential'}`)
  }

  /** one round: hand on what is pending, ack, one long poll, take and hand on what it gave, ack. Throws on any failure (the loop backs off). */
  async once(): Promise<void> {
    if (!this.o.inbox.based) { await this.baseline(); return }
    await this.drain()
    await this.ack()
    const inbox = this.o.inbox, waitS = this.o.waitS ?? 25
    const path = `/inbox?after=${inbox.lastSeq}&wait=${waitS}&limit=${this.o.limit ?? 100}&host=${encodeURIComponent(this.o.host)}`
    const r = await this.o.req('GET', path, undefined, (waitS + 15) * 1000)
    if (!r) throw new NoCredential()
    if (r.status !== 200) throw new Error(`GET /inbox: HTTP ${r.status}${r.json?.detail ? ` ${String(r.json.detail).slice(0, 120)}` : ''}`)
    this.stats.polls++
    this.stats.last_poll_at = new Date(this.now()).toISOString()
    const j = r.json ?? {}
    if (j.reset === true && Number.isInteger(j.continue_after)) {
      this.stats.resets++
      this.o.log('warn', `onsen inbox: Onsen has fewer items (${j.continue_after}) than this daemon took (${inbox.lastSeq}): continuing after ${j.continue_after}; repeats are dropped by their dedupe key`)
      inbox.reset(j.continue_after)
      return
    }
    const items: PullItem[] = Array.isArray(j.items) ? j.items : []
    const fresh = inbox.take(items)
    this.stats.taken += fresh.length
    await this.drain()
    await this.ack()
  }

  /** The pull's first start (no local copy of the pull yet): senders write to Onsen before every daemon pulls, so the inbox may hold items that already
   *  came through /inject. Ask with an `after` past any count: Onsen answers reset with its count (continue_after); start after it. Nothing is acked:
   *  the earlier items stay in Onsen as they were. */
  async baseline(): Promise<void> {
    const r = await this.o.req('GET', `/inbox?after=${BASELINE_AFTER}&wait=0&limit=1&host=${encodeURIComponent(this.o.host)}`, undefined, 15_000)
    if (!r) throw new NoCredential()
    if (r.status !== 200) throw new Error(`GET /inbox (first start): HTTP ${r.status}`)
    const n = r.json?.reset === true && Number.isInteger(r.json?.continue_after) ? r.json.continue_after
      : Number.isInteger(r.json?.last_seq) ? r.json.last_seq : null
    if (n == null) throw new Error('GET /inbox (first start): no count in the answer')
    this.o.inbox.baseline(n)
    this.stats.baseline = n
    this.o.log('info', `onsen inbox: first start of the pull: starting at seq ${n}, earlier items skipped (they were sent while the pull was off and came through /inject)`)
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.once()
        if (this.backoffMs) this.o.log('info', `onsen inbox: ${this.o.base} answers again`)
        this.backoffMs = 0
      } catch (e) {
        if (!this.running) break
        if (e instanceof NoCredential) {
          if (this.now() - this.credWarnAt > 3600_000) { this.credWarnAt = this.now(); this.o.log('warn', 'onsen inbox: no mesh credential; not taking from Onsen (the /inject path is unchanged)') }
          await this.sleep(this.o.noCredentialRetryMs ?? 60_000)
          continue
        }
        this.stats.errors++
        this.stats.last_error = `${e instanceof Error ? e.message : e}`.slice(0, 200)
        const min = this.o.minBackoffMs ?? 2_000, max = this.o.maxBackoffMs ?? 60_000
        this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, max) : min
        if (this.now() - this.warnAt > 300_000 || this.backoffMs === min) {
          this.warnAt = this.now()
          this.o.log('warn', `onsen inbox: ${this.stats.last_error}; retrying in ${Math.round(this.backoffMs / 1000)} s (the /inject path is unchanged; Onsen keeps what is not acked)`)
        }
        await this.sleep(this.backoffMs)
      }
    }
  }
  health(): Record<string, unknown> {
    return { base: this.o.base, last_seq: this.o.inbox.lastSeq, acked_seq: this.o.inbox.ackedSeq,
      pending: this.o.inbox.pending.length, ...this.stats, backoff_s: Math.round(this.backoffMs / 1000) }
  }
}
class NoCredential extends Error {}
/** an `after` past any inbox count (Onsen answers reset with its count); within Postgres BIGINT, where Onsen stores the last `after` */
export const BASELINE_AFTER = Number.MAX_SAFE_INTEGER

// ------------------------------------------------------------------ send (3b)
export type SendKind = 'call' | 'mail' | 'scheduled' | 'alert' | 'board' | 'watchdog' | 'ring' | 'other'

export type SendOutcome = { stored: boolean; duplicate: boolean; pulling: boolean }
export class OnsenSender {
  readonly stats = { sent: 0, duplicate: 0, failed: 0, delivered_by_onsen: 0, last_error: null as string | null }
  private warnAt = 0
  constructor(readonly o: { req: Req; log: Log; now?: () => number }) {}
  /** POST /send; never throws. stored: Onsen has it (new or already had it); pulling (Onsen 0.9.1): the recipient's daemon asked for its inbox in the
   *  last 90 s, so it will take it */
  async send(to: string, kind: SendKind, payload: Record<string, unknown>, dedupe: string | null): Promise<SendOutcome> {
    try {
      const r = await this.o.req('POST', '/send', { to, kind, payload, ...(dedupe ? { dedupe } : {}) }, 10_000)
      const res = r?.status === 200 && Array.isArray(r.json?.results) ? r.json.results : null
      if (res) {
        this.stats.sent++
        const duplicate = res[0]?.duplicate === true
        if (duplicate) this.stats.duplicate++
        return { stored: true, duplicate, pulling: res[0]?.pulling === true }
      }
      throw new Error(r ? `HTTP ${r.status}${r.json?.detail ? ` ${String(r.json.detail).slice(0, 120)}` : ''}` : 'no mesh credential')
    } catch (e) {
      this.stats.failed++
      this.stats.last_error = `${e instanceof Error ? e.message : e}`.slice(0, 200)
      const now = this.o.now ? this.o.now() : Date.now()
      if (now - this.warnAt > 300_000) { this.warnAt = now; this.o.log('warn', `onsen send: ${kind} to ${to} not written to Onsen (${this.stats.last_error}); today's path carried it as before`) }
      return { stored: false, duplicate: false, pulling: false }
    }
  }
}

// ------------------------------------------------------------------ the pushed mail's text (BTCC store_or_push + the receiver's /deliver filter)
/** Python's str.isprintable() for one code point: not Other (Cc, Cf, Cs, Co, Cn) or Separator (Zl, Zp, Zs), the ASCII space excepted */
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u
/** the text a push through the oncall receiver's /deliver reaches /inject with: printable characters and newlines, cut at 3500 code points (receiver.py) */
export function receiverText(text: string): string {
  const out: string[] = []
  for (const ch of String(text ?? '')) {
    if (ch === '\n' || ch === ' ' || !NON_PRINTABLE.test(ch)) out.push(ch)
    if (out.length >= 3500) break
  }
  return out.join('')
}
/** BTCC mail.py _hm: "%m-%d %H:%MZ" in UTC, "—" without a time */
export function hmUtc(iso: unknown): string {
  if (iso == null || iso === '') return '—'
  const d = new Date(String(iso))
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`
}
/** The text BTCC pushes for a mail whose recipient's mailbox is off (mail.py store_or_push), from the mail as GET /api/mesh/mail/<id> returns it to its
 *  sender: a new mail 【信】…（期限 …。#id）, a reply 【回信】…（<from> 回你寄的信 #<original>；不用回）, the ask as 「要你：…」 right under the first line. */
export function pushedMailText(m: { id: number; from: string; title?: string | null; ask?: string | null; body?: string | null; deadline?: string | null
  no_reply?: boolean | null; reply_to_id?: number | null }, reply: boolean): string {
  const title = m.title ?? '', body = m.body ?? ''
  let text = reply
    ? `【回信】${title}\n${body}\n（${m.from} 回你寄的信 #${m.reply_to_id}；不用回）`
    : `【信】${title}\n${body}\n（期限 ${hmUtc(m.deadline)}${m.no_reply ? '；不用回' : ''}。#${m.id}）`
  if (m.ask) {
    const i = text.indexOf('\n')
    text = i < 0 ? `${text}\n要你：${m.ask}` : `${text.slice(0, i)}\n要你：${m.ask}\n${text.slice(i + 1)}`
  }
  return receiverText(text)
}
