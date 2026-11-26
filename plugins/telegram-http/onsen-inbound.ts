// WO-194 (Chiron; bridge step 2, design https://rescue.tunnel.fud.city/onsen-bridge.html; Onsen's half WO-193 = Onsen 0.33.0): a person's Telegram
// message, once past the allowlist, is written into Onsen to be delivered (`deliver: true`), not routed here; it comes back as a `person_message` item
// of this agent's Onsen inbox (the agent-inbox daemon takes it and hands it to this daemon over the loopback POST /onsen/person) and only then goes to
// the router, as before. A message written on Onsen's page is a person_message too (via web) and takes the same way.
//
//   switch   ONSEN_INBOUND (inboundOn): unset, empty, 0 / off = off (the default: the path before, nothing written with deliver); a comma list of agent
//            names or `*`. Needs recording on and Onsen ≥ 0.33.0 (MIN_ONSEN). Read again at most every 30 s (server.ts liveSetting).
//   A        InboundWriter: POST /messages, today's record of the message plus `deliver: true` (and meta reply_quote, topic_name, reply_to_text,
//            reply_to_user), awaited, in arrival order (one at a time: a message waits behind the one before it). Written (or a duplicate: the same
//            idem_key) = received: 👀 then (server.ts). Onsen not answering or 5xx: tried again after 1 s, 3 s, 10 s; not written 15 s after it came:
//            the person is told once (heldText) and it is tried every 30 s until written, then goes on as normal. Refused (4xx) or no credential:
//            delivered here the way it was before (never lost). The queue is on disk (a restart resumes it).
//   facts    InboundStore: what the arrival knew of the message (Facts: everything the <channel> tag is built from that Onsen does not carry: the
//            sender's username, the replied-to and forwarded messages' ids, the photo's file ids, attachment_origin, a voice note's caption), kept on
//            disk under chat:message_id until the person_message comes back. The tag is then built by the same function as before (server.ts
//            finishInbound), so it is the tag of the switch off. Lost (a deleted state dir): built from the payload (server.ts factsFromPayload).
//   once     the store remembers what it delivered (chat:message_id and pm:<Onsen id>, 5000 kept): a person_message handed over twice (the inbox's
//            retry after a slow answer) is delivered once.
//   back     A.1 (Chiron 11:35Z): written into Onsen and not back from the inbox within BACK_MS (20 s; the agent-inbox daemon down or not pulling):
//            this daemon delivers it once itself from the facts it kept (server.ts inboundBack); the person_message that comes back later is a
//            duplicate (not delivered again). After a restart, every message whose facts are still kept and that is not waiting to be written is
//            looked at 20 s after the start the same way.
//   edits    point 8: an edit of a message still waiting to be written goes into the same queue behind it (InboundWriter.after: POST /events once the
//            message is written), so Onsen ends with the new text.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { OnsenItem } from './onsen-client.ts'

type Log = (level: 'info' | 'warn' | 'error', msg: string) => void
export type Request = (method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number) => Promise<{ status: number; json: any } | null>

/** Onsen 0.33.0 (WO-193): POST /messages takes `deliver` and puts the person_message item */
export const MIN_ONSEN = '0.33.0'
export const RETRY_MS = [1_000, 3_000, 10_000]
export const HELD_MS = 15_000
export const LATER_MS = 30_000
export const TRY_MS = 5_000
/** A.1: written into Onsen and not back from the inbox this long after: delivered here from the facts kept (server.ts inboundBack) */
export const BACK_MS = 20_000
export const ITEM_KINDS = ['person_message', 'person_edit']
/** the one system message the person gets when their message is not in Onsen 15 s after it came */
export const heldText = (agent: string): string => `Onsen 現在連不上，這一則還沒交給 ${agent}；連上會自動補交，不用重傳。`

/** ONSEN_INBOUND: unset, empty, 0 / off / false / no = off (the default); a comma list of agent names or `*` = on for those agents */
export function inboundOn(value: string | undefined, agent: string): boolean {
  const v = String(value ?? '').trim()
  if (!v || ['0', 'off', 'false', 'no'].includes(v.toLowerCase())) return false
  const list = v.split(',').map(x => x.trim()).filter(Boolean)
  return list.includes('*') || list.includes(agent)
}

/** WO-197 (sonn 14:4xZ): the switch takes effect only on a daemon that has an agent-inbox partner: the daemon its person_message items come back
 *  from. The one signal is LANES_INBOX_PORT (that partner's loopback port, set on every Telegram daemon whose agent has an agent-inbox daemon; the
 *  same variable mailbox_decide reads). Without it (a roamer: lanes off, no agent-inbox) a message written with deliver would only come back through
 *  the 20 s fallback (A.1), so `*` (or its name) leaves such a daemon on the path before. */
export const hasInboxPartner = (env: Record<string, string | undefined>): boolean => Number(env.LANES_INBOX_PORT ?? 0) > 0
export function inboundEffective(value: string | undefined, agent: string, partner: boolean): boolean {
  return partner && inboundOn(value, agent)
}

/** what the arrival knew of one Telegram message (all the <channel> tag is built from; plain JSON, kept on disk) */
export type Facts = {
  chat_id: string
  msgId?: number
  /** the content as the agent reads it (entities expanded; a file's placeholder such as (photo) when it has no caption) */
  text: string
  from: { id: number; username?: string }
  /** Telegram's date, seconds */
  date: number
  /** a photo to take (its own, or the replied-to message's): taken when the tag is built */
  image?: { file_id: string; file_unique_id: string; size?: number }
  attachment?: { kind: string; file_id: string; size?: number; mime?: string; name?: string }
  fromReply: boolean
  voiceTranscript?: string
  inTopic?: number
  /** the reply / forward / album attributes (server.ts replyForwardMeta), as the arrival computed them */
  rfm: Record<string, string>
  mgid?: string
  /** the caption an album item contributes (its own caption, entities expanded) */
  caption?: string
  /** not from Telegram's own message: built from a person_message payload (its picture may be in Onsen only) */
  onsenFiles?: Array<{ kind?: string | null; name?: string | null; mime?: string | null; bytes?: number | null; url?: string | null }>
  /** WO-197 (Chiron 15:27Z): the person_message's client.meta (what the bridge sent as client_meta; Onsen does not read it): each key an attribute of
   *  the tag of the same name, as is, last; a key the tag already sets from its own facts keeps the tag's value */
  clientMeta?: Record<string, string>
}

/** WO-197: client.meta as tag attributes: every key shaped as an attribute name (letters, digits, _; not starting with a digit), its value as is (a
 *  string; another JSON value as its JSON text). Which keys is the bridge's business: none is named here. null: none */
export function clientMetaOf(client: unknown): Record<string, string> | null {
  const m = (client as any)?.meta
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(m)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) || v == null) continue
    out[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return Object.keys(out).length ? out : null
}
export type InItem = OnsenItem & { deliver: true }
export type Job = { key: string; item: InItem; at: number; tries: number; held: boolean; topic?: number }
/** point 8: an edit event (POST /events) of the message `of`, written after that message (it waits behind it in the same queue) */
export type EventJob = { key: string; of: string; event: Record<string, unknown>; at: number; tries: number; held: true }
type AnyJob = Job | EventJob
const isEvent = (j: AnyJob): j is EventJob => 'event' in j

function atomicWrite(file: string, v: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 })
  renameSync(tmp, file)
}
const errText = (e: unknown): string => String(e instanceof Error ? e.message : e).slice(0, 160)

// ------------------------------------------------------------------ the facts kept until the message comes back
export const PARK_DAYS = 7
export const DONE_MAX = 5000
export class InboundStore {
  private parked = new Map<string, { facts: Facts; at: number }>()
  private done = new Map<string, number>()
  readonly stats = { parked: 0, taken: 0, rebuilt: 0, duplicates: 0, here: 0, save_errors: 0 }
  constructor(private o: { file: string; log: Log; now?: () => number }) {
    try {
      const j = JSON.parse(readFileSync(o.file, 'utf8'))
      for (const [k, v] of Object.entries(j.parked ?? {})) this.parked.set(k, v as { facts: Facts; at: number })
      for (const [k, at] of (j.done ?? []) as Array<[string, number]>) this.done.set(k, at)
    } catch {}
    this.prune()
  }
  private now(): number { return this.o.now ? this.o.now() : Date.now() }
  private prune(): void {
    const old = this.now() - PARK_DAYS * 86_400_000
    for (const [k, v] of this.parked) if (v.at < old) this.parked.delete(k)
    while (this.done.size > DONE_MAX) this.done.delete(this.done.keys().next().value!)
  }
  private save(): void {
    try { atomicWrite(this.o.file, { v: 1, parked: Object.fromEntries(this.parked), done: [...this.done] }) }
    catch (e) { this.stats.save_errors++; this.o.log('warn', `onsen inbound: ${this.o.file} not written (${errText(e)})`) }
  }
  park(key: string, facts: Facts): void { this.parked.set(key, { facts, at: this.now() }); this.stats.parked++; this.prune(); this.save() }
  get(key: string): Facts | undefined { return this.parked.get(key)?.facts }
  update(key: string, fn: (f: Facts) => void): boolean { const p = this.parked.get(key); if (!p) return false; fn(p.facts); this.save(); return true }
  /** the facts of a message coming back (kept until done() is called with its key) */
  take(key: string): Facts | undefined { const f = this.parked.get(key)?.facts; if (f) this.stats.taken++; return f }
  /** delivered: its facts go, its keys are remembered (a second hand-over is a duplicate) */
  finish(keys: string[]): void {
    for (const k of keys) { this.parked.delete(k); this.done.delete(k); this.done.set(k, this.now()) }
    this.prune(); this.save()
  }
  isDone(key: string): boolean { return this.done.has(key) }
  /** the keys whose facts are kept (not delivered yet) */
  waiting(): string[] { return [...this.parked.keys()] }
  /** the message went into Onsen to be delivered from there (an edit of it comes back as a person_edit) */
  viaOnsen(key: string): boolean { return this.parked.has(key) || this.done.has(key) }
  health(): Record<string, unknown> { return { ...this.stats, waiting: this.parked.size, remembered: this.done.size } }
}

// ------------------------------------------------------------------ A: written into Onsen, in arrival order
export class InboundWriter {
  private q: AnyJob[] = []
  private running = false
  private wake: (() => void) | null = null
  readonly stats = { written: 0, duplicates: 0, retries: 0, held: 0, refused: 0, late: 0, edits_after: 0, last_error: null as string | null }
  constructor(private o: { file: string; request: Request; log: Log
    /** A took it (or had it: duplicate); id = the Onsen message id */
    written: (job: Job, id: number, duplicate: boolean, late: boolean) => void
    /** not written 15 s after it came: tell the person (once per message) */
    held: (job: Job) => void
    /** Onsen refused it (4xx) or there is no credential: deliver it the way it was before */
    refused: (job: Job, why: string) => void
    retryMs?: number[]; heldMs?: number; laterMs?: number; tryMs?: number; now?: () => number }) {
    try {
      const j = JSON.parse(readFileSync(o.file, 'utf8'))
      if (Array.isArray(j.jobs)) this.q = j.jobs.filter((x: any) => x && typeof x.key === 'string' && (x.item || x.event))
    } catch {}
    if (this.q.length) { o.log('info', `onsen inbound: ${this.q.length} message(s) not yet written into Onsen before the last stop: writing them first`); this.kick() }
  }
  private now(): number { return this.o.now ? this.o.now() : Date.now() }
  private save(): void { try { atomicWrite(this.o.file, { v: 1, jobs: this.q }) } catch (e) { this.o.log('warn', `onsen inbound: ${this.o.file} not written (${errText(e)})`) } }
  get size(): number { return this.q.length }
  pending(key: string): Job | undefined { return this.q.find((j): j is Job => !isEvent(j) && j.key === key) }
  /** an edit of a message still waiting: it is written with the new text (saved) */
  rewrite(key: string, body: string): boolean { const j = this.pending(key); if (!j) return false; j.item = { ...j.item, body }; this.save(); return true }
  enqueue(job: Job): void { this.q.push(job); this.save(); this.kick() }
  /** point 8: the edit event of a message still waiting goes into the queue behind it (written after the message: Onsen ends with the new text);
   *  false = the message is not waiting here (the caller records the event the usual way) */
  after(of: string, event: Record<string, unknown>): boolean {
    if (!this.pending(of)) return false
    this.q.push({ key: `${of}:event:${String(event.idem_key ?? this.q.length)}`, of, event, at: this.now(), tries: 0, held: true })
    this.save(); this.kick()
    return true
  }
  private kick(): void { if (this.running) { this.wake?.(); return } this.running = true; void this.loop().finally(() => { this.running = false; if (this.q.length) this.kick() }) }
  /** one try of A: ok (id, duplicate), refused (4xx, no credential: never tried again), or not now (Onsen not answering, 5xx, 408, 429) */
  private async tryOnce(job: AnyJob): Promise<{ ok: true; id: number; duplicate: boolean } | { ok: false; refused: boolean; why: string }> {
    try {
      const r = await this.o.request('POST', isEvent(job) ? '/events' : '/messages', isEvent(job) ? job.event : job.item, this.o.tryMs ?? TRY_MS)
      if (!r) return { ok: false, refused: true, why: 'no mesh credential' }
      const id = Number(r.json?.id)
      if (r.status >= 200 && r.status < 300 && (Number.isFinite(id) || isEvent(job))) return { ok: true, id, duplicate: r.json?.duplicate === true }
      const why = `HTTP ${r.status}${r.json?.detail ? ` ${String(r.json.detail).slice(0, 120)}` : ''}`
      return { ok: false, refused: r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429, why }
    } catch (e) { return { ok: false, refused: false, why: errText(e) } }
  }
  /** every waiting message 15 s old and not written: the person is told once */
  private heldCheck(): void {
    const heldMs = this.o.heldMs ?? HELD_MS
    let changed = false
    for (const j of this.q) {
      if (isEvent(j) || j.held || this.now() - j.at < heldMs) continue
      j.held = true; changed = true; this.stats.held++
      this.o.log('warn', `onsen inbound: ${j.key} not written into Onsen ${Math.round((this.now() - j.at) / 1000)} s after it came (${this.stats.last_error ?? '?'}): the person is told; trying again until it is`)
      try { this.o.held(j) } catch (e) { this.o.log('warn', `onsen inbound: telling the person about ${j.key} failed: ${errText(e)}`) }
    }
    if (changed) this.save()
  }
  private sleep(ms: number): Promise<void> {
    return new Promise(res => { const t = setTimeout(() => { this.wake = null; res() }, ms); (t as any).unref?.(); this.wake = () => { clearTimeout(t); this.wake = null; res() } })
  }
  private async loop(): Promise<void> {
    const retry = this.o.retryMs ?? RETRY_MS, later = this.o.laterMs ?? LATER_MS
    while (this.q.length) {
      const job = this.q[0]!
      const r = await this.tryOnce(job)
      if (r.ok) {
        this.q.shift(); this.save()
        if (isEvent(job)) { this.stats.edits_after++; this.o.log('info', `onsen inbound: the edit of ${job.of} made while it waited to be written is in Onsen now, after the message`); continue }
        if (r.duplicate) this.stats.duplicates++; else this.stats.written++
        if (job.held) this.stats.late++
        this.o.log('info', `onsen inbound: ${job.key} written to Onsen (message ${r.id}${r.duplicate ? ', already there' : ''}${job.tries ? `, after ${job.tries} retr${job.tries === 1 ? 'y' : 'ies'}` : ''})`)
        try { this.o.written(job, r.id, r.duplicate, job.held) } catch (e) { this.o.log('warn', `onsen inbound: after writing ${job.key}: ${errText(e)}`) }
        continue
      }
      this.stats.last_error = r.why
      if (r.refused) {
        this.q.shift(); this.save()
        if (isEvent(job)) { this.o.log('warn', `onsen inbound: the edit of ${job.of} not taken by Onsen (${r.why}): dropped`); continue }
        this.stats.refused++
        this.o.log('warn', `onsen inbound: ${job.key} not taken by Onsen (${r.why}): delivered here the way it was before`)
        try { this.o.refused(job, r.why) } catch (e) { this.o.log('warn', `onsen inbound: delivering ${job.key} here failed: ${errText(e)}`) }
        continue
      }
      job.tries++; this.stats.retries++
      if (job.tries === 1) this.o.log('warn', `onsen inbound: ${job.key}: Onsen did not take it (${r.why}); trying again`)
      const wait = job.tries <= retry.length ? retry[job.tries - 1]! : later
      const end = this.now() + wait
      // the wait in slices of at most 1 s: a message 15 s old is told about on time even while a long wait runs
      while (this.now() < end) { this.heldCheck(); await this.sleep(Math.min(1_000, Math.max(0, end - this.now()))) }
      this.heldCheck()
    }
  }
  health(): Record<string, unknown> { return { ...this.stats, waiting: this.q.length, oldest_s: this.q.length ? Math.round((this.now() - this.q[0]!.at) / 1000) : null } }
}
