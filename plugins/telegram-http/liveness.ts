/**
 * liveness.ts — the ONE consumption/liveness predicate, side-effect-free.
 *
 * "When did this agent last produce a GENUINE assistant turn?" — anchored on
 * assistant records (enqueue writes user/queue-operation records: that is the
 * delivery, not consumption of it), discriminated by the first-class
 * `isApiErrorMessage` boolean (NEVER stop_reason: error records carry
 * stop_sequence, which genuine turns also use; never message text: rewording-
 * fragile and quota-only). Tail-reads 64KB — live transcripts reach 23MB+.
 *
 * Extracted from server.ts 2026-08-23 so supervisor / wrapper / watchdogs can
 * share ONE predicate instead of drifting copies (Chiron Task #11: the 7h
 * channel-bot blackout was invisible to every detector because the in-daemon
 * caller is DELIVERY-triggered; an active poller needs this same predicate).
 * Consumers: `import { newestGenuineAssistantAtIn } from './liveness.ts'` —
 * importing this module starts nothing and reads nothing until called.
 */
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'

export const TRANSCRIPT_TAIL_BYTES = 64 * 1024

/** Newest genuine-assistant-record timestamp (ms) in the newest jsonl of
 *  `transcriptDir`; 0 if none/unreadable. */
export function newestGenuineAssistantAtIn(transcriptDir: string): number {
  try {
    let newestFile = ''
    let newestMtime = 0
    for (const f of readdirSync(transcriptDir)) {
      if (!f.endsWith('.jsonl')) continue
      try {
        const m = statSync(join(transcriptDir, f)).mtimeMs
        if (m > newestMtime) { newestMtime = m; newestFile = f }
      } catch {}
    }
    if (!newestFile) return 0
    return genuineAssistantAtFile(join(transcriptDir, newestFile))
  } catch { return 0 }
}

/** Same predicate for ONE known transcript file (lanes / 002: the registered main's
 *  transcript, not the newest file in a directory that lanes also write to). */
export function genuineAssistantAtFile(path: string): number {
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES)
    const len = size - start
    if (len <= 0) return 0
    const buf = Buffer.allocUnsafe(len)
    const fd = openSync(path, 'r')
    try { readSync(fd, buf, 0, len, start) } finally { closeSync(fd) }
    let text = buf.toString('utf8')
    if (start > 0) {
      const nl = text.indexOf('\n')          // drop the partial first line
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }
    let newestTs = 0
    for (const line of text.split('\n')) {
      if (!line) continue
      let r: { type?: string; isApiErrorMessage?: boolean; timestamp?: string; message?: { model?: string } }
      try { r = JSON.parse(line) } catch { continue }
      if (r?.type !== 'assistant') continue
      if (r?.isApiErrorMessage) continue
      // 2026-09-19 (chiron 3779, verified on 3 transcripts): after a supervisor/
      // wrapper restart the CLI answers the isMeta "Continue from where you left
      // off." prompt with an assistant record that is model=<synthetic>, has no
      // requestId, shares the user record's millisecond and reads "No response
      // requested." — ZERO model calls. It is not an API error, so the check
      // above let it through and a delivery landing just before the restart was
      // marked consumed by a turn no model ever saw (same lie-family as the
      // 2026-08-22 prometheus loss). Anything the CLI stamps <synthetic> is by
      // definition not the agent reading anything.
      if (r?.message?.model === '<synthetic>') continue
      const t = Date.parse(r?.timestamp ?? '')
      if (Number.isFinite(t) && t > newestTs) newestTs = t
    }
    return newestTs
  } catch { return 0 }
}

// ── per-delivery intake (universe 002j) ─────────────────────────────────────
// "A genuine assistant record after the delivery" (above) says the AGENT is
// working. It does not say THIS message was read: an agent in the middle of a
// turn keeps writing assistant records while a new message only sits in the
// client's input queue. If that claude process then dies, the message dies with
// it, and the daemon had already counted it as consumed (known limit of issue
// #13; reproduced in the Genesis lab, universes 002g–002i, 2026-11-13).
//
// The transcript records what became of each message, so read that instead:
//   queue-operation enqueue                      the client received it
//   user, as a prompt (not a tool result)        the model has it
//   queue-operation remove absorbed_mid_turn     the model has it (mid-turn)
//   attachment queued_command                    the model has it (mid-turn)
// Checked against live fleet transcripts (claude 2.1.x) on 2026-11-14.

export const INTAKE_TAIL_BYTES = 2_000_000
/** A record counts for a delivery only if it was written at or after that
 *  delivery (minus this skew): an older enqueue belongs to an earlier attempt,
 *  usually inside a claude process that has died since. */
export const INTAKE_SKEW_MS = 3_000

/** taken    the message is in the model's hands (as a prompt, or absorbed mid-turn)
 *  takenAt  when (ms; 0 when not taken)
 *  queued   the client has received it and the model has not read it yet */
export type Intake = { taken: boolean; queued: boolean; takenAt: number }

/** The strings that recognise one notification inside a transcript line, as
 *  they are written in a JSON string. Every attribute keeps its leading space,
 *  so `reply_to_message_id="7"` is never read as `message_id="7"`. null = this
 *  notification carries nothing to recognise it by. */
export function intakeNeedles(notif: { params?: unknown } | null | undefined): string[] | null {
  const p = (notif?.params ?? {}) as { meta?: Record<string, unknown>; content?: unknown }
  const meta = p.meta ?? {}
  const has = (v: unknown) => v != null && String(v) !== ''
  const attr = (k: string, v: unknown) => JSON.stringify(` ${k}="${String(v)}"`).slice(1, -1)
  if (has(meta.message_id)) {
    const n = [attr('message_id', meta.message_id)]
    if (has(meta.chat_id)) n.push(attr('chat_id', meta.chat_id))
    return n
  }
  if (has(meta.btcc_msg_id)) return [attr('btcc_msg_id', meta.btcc_msg_id)]
  if (has(meta.did)) return [attr('did', meta.did)]                 // 002j: the daemon's own id for deliveries that carry no other
  if (typeof p.content === 'string') {
    const m = p.content.match(/^\[scheduled\]\[[^\]]*\](\[run:\d+\])/)
    if (m) return [m[1]]
  }
  if (has(meta.ts)) return [attr('ts', meta.ts)]                    // last resort (002i behaviour)
  return null
}

/** The end of a file as text, whole lines only; null when it cannot be read. */
export function tailText(path: string, max = INTAKE_TAIL_BYTES): string | null {
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - max)
    const len = size - start
    if (len <= 0) return ''
    const buf = Buffer.allocUnsafe(len)
    const fd = openSync(path, 'r')
    try { readSync(fd, buf, 0, len, start) } finally { closeSync(fd) }
    const text = buf.toString('utf8')
    if (start === 0) return text
    const nl = text.indexOf('\n')
    return nl >= 0 ? text.slice(nl + 1) : ''
  } catch { return null }
}

/** What became of one delivery, from transcript text. */
export function intakeInText(text: string, needles: string[], sinceMs = 0): Intake {
  let queued = false, takenAt = 0
  const took = (t: number) => { if (t > takenAt) takenAt = t }
  for (const line of text.split('\n')) {
    if (!line || !needles.every(n => line.includes(n))) continue
    let j: any
    try { j = JSON.parse(line) } catch { continue }
    const at = Date.parse(j?.timestamp ?? '')
    if (!Number.isFinite(at)) continue
    if (sinceMs && !(at >= sinceMs - INTAKE_SKEW_MS)) continue
    if (j.type === 'user') {
      // The message itself as a prompt — not a tool result that happens to print
      // the same tag (an agent reading its own transcript does exactly that).
      const c = j.message?.content
      if (typeof c === 'string') took(at)
      else if (Array.isArray(c)) {
        const own = JSON.stringify(c.filter((b: any) => b?.type !== 'tool_result'))
        if (needles.every(n => own.includes(n))) took(at)
      }
    }
    // the queued_command attachment carries the ENQUEUE time; the remove record carries the time it was absorbed
    else if (j.type === 'attachment' && j.attachment?.type === 'queued_command') took(at)
    else if (j.type === 'queue-operation' && j.operation === 'remove' && j.reason === 'absorbed_mid_turn') took(at)
    else if (j.type === 'queue-operation' && j.operation === 'enqueue') queued = true
  }
  return { taken: takenAt > 0, queued: queued && !takenAt, takenAt }
}

/** The tails of the transcripts a delivery made at `sinceMs` can be in: the
 *  newest jsonl of `transcriptDir`, and the one before it when that one was
 *  still written after the delivery (the session changed in between). */
export function intakeTexts(transcriptDir: string, sinceMs = 0): string[] {
  const files: Array<{ f: string; m: number }> = []
  try {
    for (const f of readdirSync(transcriptDir)) {
      if (!f.endsWith('.jsonl')) continue
      try { files.push({ f, m: statSync(join(transcriptDir, f)).mtimeMs }) } catch {}
    }
  } catch { return [] }
  files.sort((a, b) => b.m - a.m)
  const out: string[] = []
  for (const [i, x] of files.slice(0, 2).entries()) {
    if (i > 0 && x.m < sinceMs - INTAKE_SKEW_MS) break
    const t = tailText(join(transcriptDir, x.f))
    if (t != null) out.push(t)
  }
  return out
}

/** What became of one delivery to the agent whose transcripts are in
 *  `transcriptDir`. null = cannot tell (nothing to recognise the notification
 *  by, or no readable transcript): the caller falls back to the assistant-record
 *  rule. `texts` lets one sweep read the files once for all its deliveries. */
export function intakeIn(transcriptDir: string, notif: { params?: unknown }, sinceMs = 0, texts?: string[]): Intake | null {
  const needles = intakeNeedles(notif)
  if (!needles) return null
  const ts = texts ?? intakeTexts(transcriptDir, sinceMs)
  if (ts.length === 0) return null
  let queued = false, takenAt = 0
  for (const t of ts) {
    const r = intakeInText(t, needles, sinceMs)
    if (r.takenAt > takenAt) takenAt = r.takenAt
    queued ||= r.queued
  }
  return { taken: takenAt > 0, queued: queued && !takenAt, takenAt }
}

// ── what the sweep does with one delivery ───────────────────────────────────
export type Verdict = 'consumed' | 'unanswered' | 'wait' | 'regive' | 'old-rule'

export const ARRIVE_GRACE_MS = 20_000     // no trace this long after a delivery made into a starting client = it never arrived
export const STARTUP_WINDOW_MS = 30_000   // "a starting client": the delivery was written this soon after its SSE stream opened

/** Pure decision table (false-STALL beats false-ACK; never worse than the
 *  assistant-record rule it refines).
 *
 *  "Taken" alone is NOT consumption: an agent at its usage limit takes the
 *  message in as a prompt and answers with a synthetic API-error record — zero
 *  work (fleet replay 2026-11-14: Plutus, weekly limit, every hourly wake-up
 *  taken and unanswered). Consumed = taken AND a genuine assistant record after
 *  that. The intake evidence only moves the anchor of the old rule from "when
 *  the daemon wrote it" to "when the model got it" — and withholds the ack
 *  entirely while the message has not been taken.
 *
 *    cannot tell                                   → old rule
 *    taken, genuine assistant record after it      → consumed
 *    taken, none yet, its process alive/unknown    → unanswered (grace, then parked again: as before)
 *    taken, none yet, its process died             → give it again now
 *    not taken, already given again                → wait (only "taken" settles it)
 *    not taken, the process it was written to died → give it again now
 *    queued in a live (or unknown) process         → wait; after `retainMs`, old rule
 *    no trace, written into a starting client,
 *      older than ARRIVE_GRACE_MS                  → give it again (once: see regiven)
 *    no trace otherwise                            → old rule */
export function deliveryVerdict(a: {
  intake: Intake | null
  holderAlive: boolean | null      // null = the client process is unknown
  ageMs: number
  sinceOpenMs: number | null       // delivery time − the SSE-open time of the stream it was written to
  regiven: boolean
  retainMs: number
  newestAssistantAt: number        // newestGenuineAssistantAtIn(): 0 = none
}): Verdict {
  if (!a.intake) return 'old-rule'
  if (a.intake.taken) {
    if (a.newestAssistantAt > a.intake.takenAt) return 'consumed'
    if (a.regiven) return 'wait'
    // The model got it and the process died before it wrote anything in answer
    // (lab control run 2026-11-14: absorbed mid-turn, killed 11 s later; the
    // resumed session sat idle with the message in its history, and 1.27.8 had
    // acked it on the assistant records written before it was absorbed). No
    // assistant record after it means no tool call was made for it, so giving
    // it again cannot repeat a side effect. A LIVE process that has not
    // answered is the usage-limit wall: grace, as before.
    return a.holderAlive === false ? 'regive' : 'unanswered'
  }
  // Given again already: its parked copy is the message now. The old rule must
  // not settle it: the dead process's own assistant records sit after the
  // delivery and would "prove" consumption a second time.
  if (a.regiven) return 'wait'
  if (a.holderAlive === false) return 'regive'
  if (a.intake.queued) return a.ageMs > a.retainMs ? 'old-rule' : 'wait'
  if (a.sinceOpenMs != null && a.sinceOpenMs < STARTUP_WINDOW_MS && a.ageMs > ARRIVE_GRACE_MS) return 'regive'
  return 'old-rule'
}

/** What became of one delivery, read from ONE known transcript (the registered main's). */
export function intakeAtFile(path: string, notif: { params?: unknown }, sinceMs = 0): Intake | null {
  const needles = intakeNeedles(notif)
  if (!needles) return null
  const t = tailText(path)
  if (t == null) return null
  return intakeInText(t, needles, sinceMs)
}

export type LastAssistant = { at: number; apiError: boolean; text: string; midTask: boolean; model: string }
/** The last assistant record of a transcript: the model's own record, or an API-error record (usage limit, overload,
 *  login). The harness writes such an error as a synthetic assistant record flagged isApiErrorMessage and then ends the
 *  turn in the ordinary way (fleet transcripts, 40 days to 2026-11-14: all 462 limit records are followed by the
 *  end-of-turn record), so "the turn was cut off" does not describe a session behind a model wall; its last assistant
 *  record does. The "No response requested." record of a resumed session is skipped: it says nothing either way.
 *  midTask = the error came in the middle of work (after a tool result or a record of the model's own), not as the only
 *  answer to a prompt. model = the model of the newest genuine record: what a probe for this session has to call. */
export function lastAssistantFile(path: string): LastAssistant | null {
  const text = tailText(path, 400_000)
  if (!text) return null
  const lines = text.split('\n')
  let out: LastAssistant | null = null, prevSeen = false
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (!l || (!l.includes('"assistant"') && !l.includes('"user"'))) continue
    let j: any
    try { j = JSON.parse(l) } catch { continue }
    if (j.type === 'assistant') {
      const synthetic = j.message?.model === '<synthetic>'
      if (!out) {
        if (synthetic && !j.isApiErrorMessage) continue
        const at = Date.parse(j.timestamp ?? '')
        if (!Number.isFinite(at)) continue
        if (!j.isApiErrorMessage) return { at, apiError: false, text: '', midTask: false, model: String(j.message?.model ?? '') }
        out = { at, apiError: true, midTask: false, model: '',
          text: (Array.isArray(j.message?.content) ? j.message.content : []).map((c: any) => String(c?.text ?? '')).join(' ').slice(0, 200) }
        continue
      }
      if (synthetic) continue                              // an earlier error record: the model is further back
      if (!prevSeen) out.midTask = true
      out.model = String(j.message?.model ?? '')
      return out
    }
    if (j.type === 'user' && out && !prevSeen) {
      const c = j.message?.content
      out.midTask = Array.isArray(c) && c.some((b: any) => b?.type === 'tool_result')
      prevSeen = true
    }
  }
  return out
}
