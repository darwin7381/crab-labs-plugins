// Receipt: did the Claude Code client actually take a channel notification? (2026-11-17, Atlas btcc 9738)
//
// Writing into the SSE stream is not receipt. A client whose channel handler isn't registered yet drops the
// notification silently, and the old "consumed = any genuine assistant record after delivery" check then acked
// it anyway (atlas: 35 replayed deliveries dropped at session-open, all auto-acked on its next unrelated turn).
// Claude Code writes a `queue-operation` enqueue record the moment it takes a channel notification, and the
// rendered <channel …> tag carries our meta attributes verbatim, e.g. (inside the JSON string of the jsonl line)
//   <channel source=\"plugin:agent-inbox:agent-inbox\" chat_id=\"local-inject\" … ts=\"2026-11-17T13:08:26.850Z\" …>
// So receipt = one transcript line holding this delivery's ts (plus chat_id / message_id when present).

import { closeSync, openSync, readdirSync, readSync, statSync } from 'fs'
import { join } from 'path'

type Notif = { method: string; params: unknown }

/** Substrings a received copy of `notif` must contain, as they appear in the jsonl line; null = no meta.ts. */
export function receiptKeys(notif: Notif): string[] | null {
  const meta = (notif.params as { meta?: Record<string, unknown> } | undefined)?.meta
  if (!meta || typeof meta.ts !== 'string' || !meta.ts) return null
  // attribute inside a JSON-encoded string: ts=\"<json-escaped value>\"
  const attr = (k: string, v: unknown) => `${k}=\\"${JSON.stringify(String(v)).slice(1, -1)}\\"`
  const keys = [attr('ts', meta.ts)]
  for (const k of ['chat_id', 'message_id']) {
    if (meta[k] != null && meta[k] !== '') keys.push(attr(k, meta[k]))
  }
  return keys
}

/** The receipt key for a hub message id (hub-sync.ts, 1.33.0): the rendered ` msg_id=\"<id>\"` attribute WITH its
 *  leading space. Attributes in the rendered tag are space-separated, and `btcc_msg_id="<id>"` is rendered too, so
 *  without the space every btcc_msg_id (or any other *_msg_id) attribute would match. JSON-escaped like the others. */
export function msgIdKey(id: string | number): string {
  return attrKey('msg_id', id)
}

/** ` <name>=\"<value>\"` as it appears inside the jsonl string, leading space included (see msgIdKey). */
export function attrKey(name: string, value: string | number): string {
  return ` ${name}=\\"${JSON.stringify(String(value)).slice(1, -1)}\\"`
}

/** True when one line holds every key (keys on different lines don't count). */
export function receivedIn(lines: string[], keys: string[]): boolean {
  return lines.some(l => keys.every(k => l.includes(k)))
}

/** Lines carrying a rendered channel `ts` attribute, from the (up to 3) newest main-thread transcripts in
 *  `dir` modified since `sinceMs` - 5 s; the last `tailBytes` of each. Unreadable → [] (never throws). */
export function recentReceiptLines(dir: string, sinceMs: number, tailBytes = 4 * 1024 * 1024): string[] {
  let files: Array<{ p: string; m: number }> = []
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
      .map(f => { const p = join(dir, f); return { p, m: statSync(p).mtimeMs } })
      .filter(x => x.m >= sinceMs - 5000).sort((a, b) => b.m - a.m).slice(0, 3)
  } catch { return [] }
  const out: string[] = []
  for (const { p } of files) {
    let fd: number | null = null
    try {
      fd = openSync(p, 'r')
      const size = statSync(p).size
      const len = Math.min(size, tailBytes)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, size - len)
      for (const line of buf.toString('utf8').split('\n')) if (line.includes('ts=\\"')) out.push(line)
    } catch {
      // unreadable file: no evidence from it
    } finally {
      if (fd !== null) try { closeSync(fd) } catch {}
    }
  }
  return out
}
