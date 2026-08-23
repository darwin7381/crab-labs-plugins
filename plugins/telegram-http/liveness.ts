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
    const path = join(transcriptDir, newestFile)
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
      let r: { type?: string; isApiErrorMessage?: boolean; timestamp?: string }
      try { r = JSON.parse(line) } catch { continue }
      if (r?.type !== 'assistant') continue
      if (r?.isApiErrorMessage) continue
      const t = Date.parse(r?.timestamp ?? '')
      if (Number.isFinite(t) && t > newestTs) newestTs = t
    }
    return newestTs
  } catch { return 0 }
}
