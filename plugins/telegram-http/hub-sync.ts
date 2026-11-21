// Hub sync: the receiving half of the mailbox (信箱) mechanism, spec v3 (Joey TG 444 / 447 / 455; Epeius
// knowledge/delivery-ledger-spec-phase1.md).
//
// The sender puts a message in the hub (BTCC agent_messages; id = the message number) and is done. This daemon asks
// the hub what is for its agent and not yet taken (GET /api/mesh/inbox/pending), pushes each row's `payload` into a
// ready session with meta.msg_id = <id>, and once the transcript shows ` msg_id="<id>"` it tells the hub
// (POST /api/mesh/inbox/taken). The hub is the source of truth; `hub-sync.json` only remembers push timing, the
// per-id push cap and what was seen/confirmed, so a restart neither loses nor floods anything.
//
// /inject with a sender-assigned btcc_msg_id is a doorbell: the daemon answers at once (the receiver gives /inject
// 8 s), syncs asynchronously, and delivers through the hub only when the hub lists that id with a payload.
// Otherwise (hub unreachable, 404 = BTCC not deployed yet, credential refused, id not listed) the held /inject goes
// down the old 1.32.2 path, unchanged. Ids delivered on the old path are remembered (`old_path`) so a later hub
// listing never pushes them a second time, and they are reported taken once the old path's receipt sees them.
//
// No alerts: a row that reaches the push cap stops being pushed and the hub keeps showing it untaken (that is the
// record). Everything without a hub row (scheduler, alerts, keep-warm, 讀信箱, Telegram, roamers) never comes here.
//
// The class has no timers and does nothing until start(); server.ts wires it to its sessions, transcript and log.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { attrKey, msgIdKey } from './receipt.ts'

/** A hub id is in the session when a transcript line renders ` msg_id="<id>"` (a hub push) or ` btcc_msg_id="<id>"`
 *  (the same message delivered by the old path, which renders the hub id under that name). Leading space on both. */
export function seenIn(lines: string[], id: number | string): boolean {
  const a = msgIdKey(id), b = attrKey('btcc_msg_id', id)
  return lines.some(l => l.includes(a) || l.includes(b))
}

export type Notif = { method: string; params: unknown }
export type HubPayload = { content: string; meta: Record<string, string> }
export type HubRow = { id: number; payload: HubPayload | null }
export type HubEntry = {
  pushes: number
  last_push_at: number | null
  seen_at: number | null
  taken_at: number | null
  /** Delivered on the old (1.32.2) path instead of by hub sync: never pushed from the hub, reported taken once seen. */
  old_path?: true
}
export type HubState = Record<string, HubEntry>
export type DoorbellRoute = 'hub' | 'old' | 'dup-hub' | 'dup-old'

export const CHANNEL_METHOD = 'notifications/claude/channel'
export const STATE_FILE = 'hub-sync.json'
export const DOORBELL_DIR = 'hub-doorbell'
const DAY_MS = 24 * 3600 * 1000
const TAKEN_BATCH = 200
const META_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** Is hub sync on for this daemon? Agent-inbox daemons only: a Telegram daemon of the same agent syncing the same
 *  identity's rows would push every message twice into the one session. */
export function hubSyncMode(env: { HUB_SYNC?: string }, inboxOnly: boolean, btccBase: string): { on: boolean; why: string } {
  if ((env.HUB_SYNC ?? '').trim() === '0') return { on: false, why: 'HUB_SYNC=0' }
  if (!inboxOnly) return { on: false, why: 'not an agent-inbox daemon' }
  if (!btccBase) return { on: false, why: 'BTCC_API_BASE unset' }
  return { on: true, why: 'on' }
}

function normPayload(p: unknown): HubPayload | null {
  if (typeof p === 'string') { try { p = JSON.parse(p) } catch { return null } }   // jsonb that came back as text
  if (!p || typeof p !== 'object') return null
  const { content, meta } = p as { content?: unknown; meta?: unknown }
  if (typeof content !== 'string' || !content) return null
  const out: Record<string, string> = {}
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
      if (!META_KEY_RE.test(k) || v == null || typeof v === 'object') continue
      out[k] = String(v)
    }
  }
  return { content, meta: out }
}

/** GET /api/mesh/inbox/pending body → rows ordered by id; null when the body isn't a row list. Accepts a bare array
 *  or {rows | pending | messages | items: […]}; ids as numbers or numeric strings; a payload that isn't
 *  {content, meta} (or JSON text of one) becomes null and is skipped by the caller. */
export function parsePending(body: unknown): HubRow[] | null {
  const list = Array.isArray(body) ? body
    : body && typeof body === 'object'
      ? ['rows', 'pending', 'messages', 'items'].map(k => (body as Record<string, unknown>)[k]).find(Array.isArray)
      : undefined
  if (!Array.isArray(list)) return null
  const rows: HubRow[] = []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const id = Number((r as { id?: unknown }).id)
    if (!Number.isSafeInteger(id) || id <= 0) continue
    rows.push({ id, payload: normPayload((r as { payload?: unknown }).payload) })
  }
  return rows.sort((a, b) => a.id - b.id)
}

/** The channel notification for a hub row: the payload as the hub holds it, with meta.msg_id = the id. chat_id, ts
 *  and btcc_msg_id are filled only when the payload lacks them (the same defaults /inject uses). */
export function payloadNotif(id: number, p: HubPayload, defaults: { chat_id: string; ts: string }): Notif {
  const meta: Record<string, string> = { ...p.meta }
  if (!meta.chat_id) meta.chat_id = defaults.chat_id
  if (!meta.ts) meta.ts = defaults.ts
  if (!meta.btcc_msg_id) meta.btcc_msg_id = String(id)
  meta.msg_id = String(id)
  return { method: CHANNEL_METHOD, params: { content: p.content, meta } }
}

const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function loadState(path: string): HubState {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: HubState = {}
  for (const [id, e] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(id) || !e || typeof e !== 'object') continue
    const x = e as Record<string, unknown>
    out[id] = {
      pushes: typeof x.pushes === 'number' && x.pushes >= 0 ? Math.floor(x.pushes) : 0,
      last_push_at: numOrNull(x.last_push_at), seen_at: numOrNull(x.seen_at), taken_at: numOrNull(x.taken_at),
      ...(x.old_path === true ? { old_path: true as const } : {}),
    }
  }
  return out
}

export function saveState(path: string, state: HubState): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
  renameSync(tmp, path)   // atomic on POSIX
}

/** Drop entries 24 h after taken; entries never taken, 48 h after their last activity (the hub lists rows for 24 h
 *  only, so such an id can't come back). Returns how many were dropped. */
export function gcState(state: HubState, now: number): number {
  let n = 0
  for (const [id, e] of Object.entries(state)) {
    const last = e.taken_at ?? Math.max(e.seen_at ?? 0, e.last_push_at ?? 0)
    if (e.taken_at != null ? now - e.taken_at > DAY_MS : now - last > 2 * DAY_MS) { delete state[id]; n++ }
  }
  return n
}

type Held = { chatId: string; notif: Notif; seq: number }

/** Doorbells answered before a sync could decide them: hand them to the old path (used at boot when hub sync is
 *  off, so nothing parked by a previous process is lost). Returns how many were dispatched. */
export async function drainLeftoverDoorbells(stateDir: string, dispatch: (chatId: string, n: Notif) => Promise<void>,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void): Promise<number> {
  const dir = join(stateDir, DOORBELL_DIR)
  let files: string[] = []
  try { files = readdirSync(dir).filter(f => f.endsWith('.json')).sort() } catch { return 0 }
  let n = 0
  for (const f of files) {
    try {
      const h = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { chatId: string; notif: Notif }
      await dispatch(h.chatId, h.notif)
      n++
    } catch (err) {
      log('warn', `hub: leftover doorbell ${f} unreadable or undeliverable: ${err}`)
      continue
    }
    try { rmSync(join(dir, f)) } catch {}
  }
  if (n) log('info', `hub: hub sync is off — ${n} doorbell(s) held by the previous process sent down the old path`)
  return n
}

export type HubDeps = {
  base: string
  auth: () => Record<string, string>
  fetch?: typeof fetch
  /** Write `n` into every ready session; resolves to how many took it (0 = no ready session). Never throws. */
  push: (n: Notif) => Promise<number>
  /** Transcript lines to look for receipts in (receipt.ts recentReceiptLines), [] when unavailable. */
  seenLines: (sinceMs: number) => string[]
  /** The old 1.32.2 path for a held doorbell. */
  dispatchOld: (chatId: string, n: Notif) => Promise<void>
  defaultChatId: () => string
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
  now?: () => number
}

export type HubOpts = {
  stateDir: string
  /** Whether a push can be confirmed from the transcript. A function is asked at each use: false while the daemon
   *  has no transcript dir to read (RECEIPT_CHECK=0, or the dir doesn't exist), and then a push counts as seen,
   *  as on the old path; otherwise every push read as unseen and was sent maxPushes times (channel bot, 11-20). */
  receiptCheck: boolean | (() => boolean)
  graceMs: number
  maxPushes: number
  /** Wait after a 404 / 401 / 403 before asking again (default 5 min). */
  backoffMs?: number
  fetchTimeoutMs?: number
}

export class HubSync {
  private state: HubState
  private dirty = false
  private readonly statePath: string
  private readonly doorbellDir: string
  private listing = new Map<number, HubPayload>()   // last successful listing, rows with a payload
  private nullPayload = 0
  private held = new Map<number, Held>()
  private seq = 0
  private chain: Promise<void> = Promise.resolve()
  private queued: Promise<void> | null = null
  private getBackoffUntil = 0
  private takenBackoffUntil = 0
  private lastSyncAt: number | null = null
  private lastSyncOk: boolean | null = null
  private status = 'not synced yet'
  private takenStatus = 'ok'
  private capLogged = new Set<number>()
  private readonly now: () => number
  private readonly fetchFn: typeof fetch

  constructor(private deps: HubDeps, private opts: HubOpts) {
    this.now = deps.now ?? Date.now
    this.fetchFn = deps.fetch ?? fetch
    this.statePath = join(opts.stateDir, STATE_FILE)
    this.doorbellDir = join(opts.stateDir, DOORBELL_DIR)
    this.state = loadState(this.statePath)
  }

  /** Load doorbells a previous process held, then sync once (boot). */
  start(): Promise<void> {
    try {
      for (const f of readdirSync(this.doorbellDir).filter(f => /^\d+\.json$/.test(f)).sort()) {
        try {
          const h = JSON.parse(readFileSync(join(this.doorbellDir, f), 'utf8')) as { chatId: string; notif: Notif }
          if (h && typeof h.chatId === 'string' && h.notif?.method) this.held.set(Number(f.slice(0, -5)), { chatId: h.chatId, notif: h.notif, seq: ++this.seq })
        } catch {}
      }
    } catch {}
    const ids = Object.keys(this.state)
    this.deps.log('info', `hub sync: on — state ${ids.length} id(s), ${this.pushedUnseen()} pushed and not yet seen, ` +
      `${this.held.size} held doorbell(s) from the previous process`)
    return this.kick('boot')
  }

  /** Run a sync soon. Calls while one is queued (not started) share it; a call during a running sync queues one more. */
  kick(reason: string): Promise<void> {
    if (this.queued) return this.queued
    const p = this.chain.then(() => { this.queued = null; return this.run(reason) })
      .catch(err => this.deps.log('error', `hub sync (${reason}) failed: ${err instanceof Error ? err.stack ?? err.message : err}`))
    this.queued = p
    this.chain = p
    return p
  }

  /** /inject carried a sender-assigned hub id. Decides synchronously; 'old' = the caller delivers it on the old path
   *  now; 'dup-old' = already handed to the old path, deliver nothing; 'hub' / 'dup-hub' = hub sync delivers it
   *  (a held doorbell still falls back to the old path if the sync can't confirm the hub lists it). */
  doorbell(id: number, chatId: string, notif: Notif): DoorbellRoute {
    const key = String(id)
    const st = this.state[key]
    if (st) {
      void this.kick('doorbell')
      this.deps.log('info', `hub: doorbell #${id} is a duplicate (already ${st.old_path ? 'on the old path' : st.taken_at ? 'taken' : st.seen_at ? 'seen' : `pushed ${st.pushes}x`}) — not pushed again`)
      return st.old_path ? 'dup-old' : 'dup-hub'
    }
    if (this.held.has(id)) {
      this.deps.log('info', `hub: doorbell #${id} is a duplicate (held, waiting for the sync) — not pushed again`)
      return 'dup-hub'
    }
    if (this.listing.has(id)) {
      void this.kick('doorbell')
      return 'hub'
    }
    if (this.lastSyncOk === false || !this.deps.auth().Authorization) {
      this.markOldPath(id)
      this.deps.log('info', `hub: doorbell #${id} → old path (${this.deps.auth().Authorization ? `hub ${this.status}` : 'no mesh credential'})`)
      return 'old'
    }
    const h: Held = { chatId, notif, seq: ++this.seq }
    this.held.set(id, h)
    try {
      mkdirSync(this.doorbellDir, { recursive: true, mode: 0o700 })
      const p = join(this.doorbellDir, `${id}.json`)
      writeFileSync(`${p}.tmp`, JSON.stringify({ chatId, notif }), { mode: 0o600 })
      renameSync(`${p}.tmp`, p)
    } catch (err) {
      this.deps.log('warn', `hub: could not persist held doorbell #${id} (kept in memory): ${err}`)
    }
    void this.kick('doorbell')
    return 'hub'
  }

  /** The old path's receipt saw a delivery (or, with RECEIPT_CHECK=0, pushed it). If it carried a hub id this
   *  daemon handed to the old path, report it taken. */
  oldPathSeen(n: Notif): void {
    const meta = (n.params as { meta?: Record<string, unknown> } | undefined)?.meta
    const id = meta?.btcc_msg_id
    if (typeof id !== 'string' || !/^\d+$/.test(id)) return
    const st = this.state[id]
    if (!st?.old_path || st.seen_at != null) return
    st.seen_at = this.now()
    this.dirty = true
    this.deps.log('info', `hub: #${id} seen on the old path — reporting taken`)
    this.save()
  }

  health(): Record<string, unknown> {
    let pending = 0
    for (const id of this.listing.keys()) {
      const e = this.state[String(id)]
      if (!e || (e.seen_at == null && !e.old_path)) pending++
    }
    const es = Object.values(this.state)
    return {
      enabled: true,
      credential: !!this.deps.auth().Authorization,
      last_sync_at: this.lastSyncAt != null ? new Date(this.lastSyncAt).toISOString() : null,
      last_sync_ok: this.lastSyncOk,
      status: this.status,
      pending_from_hub: pending,
      pushed_unseen: this.pushedUnseen(),
      to_confirm: es.filter(e => e.seen_at != null && e.taken_at == null).length,
      capped: es.filter(e => !e.old_path && e.seen_at == null && e.pushes >= this.opts.maxPushes).length,
      held_doorbells: this.held.size,
      without_payload: this.nullPayload,
    }
  }

  /** Snapshot for tests. */
  entry(id: number): HubEntry | undefined {
    const e = this.state[String(id)]
    return e ? { ...e } : undefined
  }

  private pushedUnseen(): number {
    return Object.values(this.state).filter(e => !e.old_path && e.pushes > 0 && e.seen_at == null).length
  }

  private markOldPath(id: number): void {
    this.state[String(id)] = { pushes: 0, last_push_at: this.now(), seen_at: null, taken_at: null, old_path: true }
    this.dirty = true
    this.save()
  }

  private save(): void {
    if (!this.dirty) return
    try {
      saveState(this.statePath, this.state)
      this.dirty = false
    } catch (err) {
      this.deps.log('error', `hub: could not write ${this.statePath}: ${err}`)
    }
  }

  private setStatus(s: string, ok: boolean): void {
    if (s !== this.status) {
      this.deps.log(ok ? 'info' : 'warn', `hub: pending ${s}${ok ? '' : ' — /inject doorbells take the old path until it answers'}`)
    }
    this.status = s
  }

  private async run(reason: string): Promise<void> {
    const startSeq = this.seq        // doorbells held up to here were committed at the hub before this GET is sent
    const started = this.now()
    const auth = this.deps.auth()
    let fresh: Map<number, HubPayload> | null = null
    let attempted = false
    if (!auth.Authorization) {
      this.setStatus('skipped: no mesh credential', false)
    } else if (started >= this.getBackoffUntil) {
      attempted = true
      try {
        const r = await this.fetchFn(`${this.deps.base}/api/mesh/inbox/pending`, {
          headers: { ...auth, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(this.opts.fetchTimeoutMs ?? 5000),
        })
        if (r.status === 200) {
          const rows = parsePending(await r.json().catch(() => null))
          if (rows) {
            fresh = new Map()
            let nul = 0
            for (const row of rows) { if (row.payload) fresh.set(row.id, row.payload); else nul++ }
            this.nullPayload = nul
            this.setStatus('ok', true)
          } else {
            this.setStatus('answered 200 with an unreadable body', false)
          }
        } else {
          if (r.status === 404 || r.status === 401 || r.status === 403) this.getBackoffUntil = started + (this.opts.backoffMs ?? 300_000)
          this.setStatus(`HTTP ${r.status}${r.status === 404 ? ' (BTCC endpoint not deployed?)' : ''}`, false)
        }
      } catch (err) {
        this.setStatus(`unreachable (${String(err).slice(0, 100)})`, false)
      }
    }
    if (attempted) {
      this.lastSyncAt = started
      this.lastSyncOk = fresh != null
      if (fresh) this.listing = fresh
    }
    this.sweepSeen()
    await this.resolveHeld(startSeq, fresh)
    const pushed = await this.pushDue()
    await this.flushTaken()
    if (gcState(this.state, this.now())) this.dirty = true
    this.save()
    if (pushed) this.deps.log('info', `hub sync (${reason}): pushed ${pushed}`)
  }

  private async resolveHeld(startSeq: number, fresh: Map<number, HubPayload> | null): Promise<void> {
    for (const [id, h] of [...this.held]) {
      if (h.seq > startSeq) continue   // rung after this GET went out: the next sync decides
      this.held.delete(id)
      try { rmSync(join(this.doorbellDir, `${id}.json`)) } catch {}
      if (fresh?.has(id)) {
        this.deps.log('info', `hub: doorbell #${id} → hub sync delivers it`)
        continue
      }
      if (this.state[String(id)]) continue   // pushed by an earlier sync after all
      this.markOldPath(id)
      this.deps.log('info', `hub: doorbell #${id} → old path (${fresh ? 'the hub does not list it with a payload' : `hub ${this.status}`})`)
      try { await this.deps.dispatchOld(h.chatId, h.notif) } catch (err) {
        this.deps.log('error', `hub: old-path dispatch of doorbell #${id} failed: ${err}`)
      }
    }
  }

  private receiptOn(): boolean {
    const rc = this.opts.receiptCheck
    return typeof rc === 'function' ? rc() : rc
  }

  private sweepSeen(): void {
    if (!this.receiptOn()) return
    const unseen = Object.entries(this.state).filter(([, e]) => !e.old_path && e.pushes > 0 && e.seen_at == null)
    if (!unseen.length) return
    const since = Math.min(...unseen.map(([, e]) => e.last_push_at ?? this.now()))
    const lines = this.deps.seenLines(since)
    if (!lines.length) return
    for (const [id, e] of unseen) {
      if (seenIn(lines, id)) {
        e.seen_at = this.now()
        this.dirty = true
        this.deps.log('info', `hub: #${id} seen in the transcript after ${e.pushes} push(es)`)
      }
    }
  }

  private async pushDue(): Promise<number> {
    let pushed = 0
    let firstSight: string[] | null = null   // transcript lines, read once per run, only if a never-pushed row exists
    for (const id of [...this.listing.keys()].sort((a, b) => a - b)) {
      const key = String(id)
      const e = this.state[key]
      if (e && (e.old_path || e.seen_at != null || e.taken_at != null)) continue
      if (!e && this.receiptOn()) {
        // Never pushed from here: if the old path already put it in the session (a previous process, the rollout
        // before this version, a lost state file), don't push it again — just report it taken.
        firstSight ??= this.deps.seenLines(this.now() - DAY_MS)
        if (seenIn(firstSight, id)) {
          this.state[key] = { pushes: 0, last_push_at: null, seen_at: this.now(), taken_at: null }
          this.dirty = true
          this.deps.log('info', `hub: #${id} is already in the transcript (delivered before hub sync) — not pushed, reporting taken`)
          continue
        }
      }
      if (e && e.pushes >= this.opts.maxPushes) {
        if (!this.capLogged.has(id)) {
          this.capLogged.add(id)
          this.deps.log('warn', `hub: #${id} pushed ${e.pushes} times and never seen in the transcript — not pushing it again (the hub keeps it untaken)`)
        }
        continue
      }
      const now = this.now()
      if (e?.last_push_at != null && now - e.last_push_at < this.opts.graceMs) continue
      const notif = payloadNotif(id, this.listing.get(id)!, { chat_id: this.deps.defaultChatId(), ts: new Date(now).toISOString() })
      const n = await this.deps.push(notif)
      if (n === 0) break   // no ready session: everything waits at the hub for the next trigger
      const entry = e ?? (this.state[key] = { pushes: 0, last_push_at: null, seen_at: null, taken_at: null })
      entry.pushes++
      entry.last_push_at = now
      if (!this.receiptOn()) entry.seen_at = now   // no receipt check: pushed = seen (1.32.1 rule)
      this.dirty = true
      this.save()   // per push: a restart right after must know it was pushed
      pushed++
      this.deps.log('info', `hub: pushed #${id} into ${n} session(s) (push ${entry.pushes}/${this.opts.maxPushes})`)
    }
    return pushed
  }

  private async flushTaken(): Promise<void> {
    const ids = Object.entries(this.state).filter(([, e]) => e.seen_at != null && e.taken_at == null).map(([id]) => Number(id))
    if (!ids.length) return
    const auth = this.deps.auth()
    if (!auth.Authorization || this.now() < this.takenBackoffUntil) return
    for (let i = 0; i < ids.length; i += TAKEN_BATCH) {
      const batch = ids.slice(i, i + TAKEN_BATCH)
      let why = ''
      try {
        const r = await this.fetchFn(`${this.deps.base}/api/mesh/inbox/taken`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ msg_ids: batch }),
          signal: AbortSignal.timeout(this.opts.fetchTimeoutMs ?? 5000),
        })
        if (r.ok) {
          const j = await r.json().catch(() => ({})) as { updated?: unknown; ignored?: unknown }
          const t = this.now()
          for (const id of batch) this.state[String(id)].taken_at = t
          this.dirty = true
          const ignored = Array.isArray(j.ignored) ? j.ignored : []
          this.deps.log('info', `hub: taken confirmed for ${batch.length} id(s) (updated ${String(j.updated ?? '?')}` +
            `${ignored.length ? `, ignored ${ignored.slice(0, 10).join(',')}` : ''})`)
          if (this.takenStatus !== 'ok') this.takenStatus = 'ok'
          continue
        }
        if (r.status === 404 || r.status === 401 || r.status === 403) this.takenBackoffUntil = this.now() + (this.opts.backoffMs ?? 300_000)
        why = `HTTP ${r.status}`
      } catch (err) {
        why = `unreachable (${String(err).slice(0, 100)})`
      }
      // quietly: one line per change of reason, retried at the next sync
      if (why !== this.takenStatus) this.deps.log('warn', `hub: taken not confirmed (${why}) — ${ids.length - i} id(s) retried at the next sync`)
      this.takenStatus = why
      break
    }
  }
}
