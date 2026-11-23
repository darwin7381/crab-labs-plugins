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

/** Same predicate for ONE known transcript file. */
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
      let r: GenuineCandidate
      try { r = JSON.parse(line) } catch { continue }
      if (!isGenuineAssistant(r)) continue
      const t = Date.parse(r?.timestamp ?? '')
      if (Number.isFinite(t) && t > newestTs) newestTs = t
    }
    return newestTs
  } catch { return 0 }
}

type GenuineCandidate = { type?: string; isApiErrorMessage?: boolean; timestamp?: string; message?: { model?: string } }
/** THE predicate: an assistant record a model really produced */
export function isGenuineAssistant(r: GenuineCandidate | null | undefined): boolean {
  if (r?.type !== 'assistant') return false
  if (r?.isApiErrorMessage) return false
  // 2026-09-19 (chiron 3779, verified on 3 transcripts): after a supervisor/
  // wrapper restart the CLI answers the isMeta "Continue from where you left
  // off." prompt with an assistant record that is model=<synthetic>, has no
  // requestId, shares the user record's millisecond and reads "No response
  // requested." — ZERO model calls. It is not an API error, so the check
  // above let it through and a delivery landing just before the restart was
  // marked consumed by a turn no model ever saw (same lie-family as the
  // 2026-08-22 prometheus loss). Anything the CLI stamps <synthetic> is by
  // definition not the agent reading anything.
  if (r?.message?.model === '<synthetic>') return false
  return true
}

/** lanes-topics (item 3): the model of the LAST genuine assistant record of one transcript (the session's model as it really ran), or null. Reads the
 *  tail, widening (64KB, 1MB, 8MB) until it finds one: a turn of big tool results can push the last assistant record far from the end. */
export function genuineAssistantModelFile(path: string): string | null {
  try {
    const size = statSync(path).size
    for (const want of [TRANSCRIPT_TAIL_BYTES, 1024 * 1024, 8 * 1024 * 1024]) {
      const start = Math.max(0, size - want), len = size - start
      if (len <= 0) return null
      const buf = Buffer.allocUnsafe(len)
      const fd = openSync(path, 'r')
      try { readSync(fd, buf, 0, len, start) } finally { closeSync(fd) }
      const lines = buf.toString('utf8').split('\n')
      if (start > 0) lines.shift()                                  // the partial first line
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i] || !lines[i].includes('"assistant"')) continue
        let r: GenuineCandidate
        try { r = JSON.parse(lines[i]) } catch { continue }
        if (isGenuineAssistant(r) && typeof r.message?.model === 'string' && r.message.model.trim()) return r.message.model.trim()
      }
      if (start === 0) return null
    }
    return null
  } catch { return null }
}
