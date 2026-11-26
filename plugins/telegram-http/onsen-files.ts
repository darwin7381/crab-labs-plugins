// WO-190 (Chiron; Joey TG chiron:2686): every file that passes through Telegram is stored in Onsen itself, so Onsen's page can show it (until now Onsen
// kept only its name, size and Telegram file_id, attachments[].client_ref, and v1 gave url null).
//   in   a person's photo, document, video (animation, video note), voice or audio: once the message is recorded, the daemon takes the file (a photo: the
//        inbox copy it downloads for the agent anyway; anything else: fetched from Telegram by the daemon itself, into memory only, never into the
//        agent's inbox, at most the 20 MB a bot may download) and uploads it with this agent's credential (POST /v1/files, Idempotency-Key = the
//        message's idem_key). The agent gets exactly what it got before (attachment_file_id, download on demand).
//   out  a file the reply tool sends: once Telegram took it (its message_id gives the record's idem_key), the original file is uploaded the same way.
//   The record keeps its place in the spool; its ids join it as attachment_file_ids when the sync sends it (OnsenClient.recordWithFiles). A file over
//   a limit (Telegram's 20 MB for a bot, Onsen's 25 MB) or not stored for any reason: the record is as before WO-190 (name and Telegram id), one log line;
//   nothing waits for it (the delivery to the agent, the Telegram send).
//   ONSEN_FILES (filesOn): the switch, both directions; off by default. The `in` half needs Onsen ≥ 0.29.4 (an older one refuses attachment_file_ids on
//   an `in` message: the sync then records it again without them, OnsenClient.withoutFiles); the `out` half Onsen ≥ 0.29.1.
// A sticker is not stored (Telegram's own artwork, not a file anyone sent).
import { readFileSync, statSync } from 'fs'
import { basename, extname } from 'path'
import { ONSEN_FILE_MAX, type OnsenItem } from './onsen-client.ts'

type Log = (level: 'info' | 'warn' | 'error', msg: string) => void
/** the most a bot may download from Telegram (getFile) */
export const TG_BOT_FILE_MAX = 20 * 1024 * 1024
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ')
  .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<token>').slice(0, 200)      // a Telegram file address carries the bot token: never in a log line

/** ONSEN_FILES: unset, empty, 0 / off / false / no = off (the default); a comma list of agent names or `*` = on for those agents */
export function filesOn(value: string | undefined, agent: string): boolean {
  const v = String(value ?? '').trim()
  if (!v || ['0', 'off', 'false', 'no'].includes(v.toLowerCase())) return false
  const list = v.split(',').map(x => x.trim()).filter(Boolean)
  return list.includes('*') || list.includes(agent)
}

/** the record kinds whose file goes into Onsen */
export const FILE_KINDS = new Set<OnsenItem['kind']>(['photo', 'document', 'video', 'voice'])
/** a recorded message that carries a file to store: a sent one (status ok) of a file kind; an incoming one must name its Telegram file */
export function wantsFiles(item: OnsenItem): boolean {
  if (item.status !== 'ok' || !FILE_KINDS.has(item.kind)) return false
  return item.direction === 'out' || !!item.attachments?.[0]?.file_id
}
/** the Idempotency-Key of file `i` of `n` in a message: its idem_key (one file, as every Telegram message has), else idem_key:<i> */
export const fileKey = (idem: string, i: number, n: number): string => n > 1 ? `${idem}:${i}` : idem

const MIME: Record<string, string> = { '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.html': 'text/html', '.pdf': 'application/pdf', '.zip': 'application/zip', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.wav': 'audio/wav', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
/** a file's type: the one Telegram gave, else from its name's extension, else none (Onsen takes it as application/octet-stream) */
export function mimeOf(name: string | null | undefined, given?: string | null): string | undefined {
  return given || MIME[extname(String(name ?? '')).toLowerCase()] || undefined
}

export type Got = { bytes: Uint8Array; name?: string | null } | { why: string }
export type Source = () => Promise<Got>
export type Upload = (bytes: Uint8Array, o: { key: string; name?: string | null; mime?: string | null }) => Promise<{ id: string } | { error: string }>

/** a local file (a photo's inbox copy, a reply's file): its bytes, unless it is over Onsen's 25 MB or cannot be read */
export function localFile(path: string): Got {
  try {
    const st = statSync(path)
    if (!st.isFile()) return { why: 'not a file' }
    if (st.size > ONSEN_FILE_MAX) return { why: `over Onsen's 25 MB (${st.size} bytes)` }
    return { bytes: new Uint8Array(readFileSync(path)), name: basename(path) }
  } catch (e) { return { why: `not read (${errText(e)})` } }
}

/** a file from Telegram, fetched by the daemon itself (getFile, then its file path), into memory only. `size`: the message's own file_size (a file over
 *  the 20 MB a bot may download is not asked for) */
export async function telegramFile(o: { fileId: string; size?: number; getFile: (id: string) => Promise<{ file_path?: string; file_size?: number }>
  fileUrl: (path: string) => string; fetch?: typeof fetch; timeoutMs?: number }): Promise<Got> {
  const over = (n: number) => `over the 20 MB a bot may download from Telegram (${n} bytes)`
  if (o.size != null && o.size > TG_BOT_FILE_MAX) return { why: over(o.size) }
  try {
    const f = await o.getFile(o.fileId)
    if (f.file_size != null && f.file_size > TG_BOT_FILE_MAX) return { why: over(f.file_size) }
    if (!f.file_path) return { why: 'Telegram gave no file path' }
    const r = await (o.fetch ?? fetch)(o.fileUrl(f.file_path), { signal: AbortSignal.timeout(o.timeoutMs ?? 60_000) })
    if (!r.ok) { try { await r.body?.cancel() } catch {} return { why: `Telegram answered HTTP ${r.status}` } }
    const len = Number(r.headers.get('content-length') ?? NaN)
    if (Number.isFinite(len) && len > ONSEN_FILE_MAX) { try { await r.body?.cancel() } catch {} return { why: `over Onsen's 25 MB (${len} bytes)` } }
    const bytes = new Uint8Array(await r.arrayBuffer())
    if (bytes.byteLength > ONSEN_FILE_MAX) return { why: `over Onsen's 25 MB (${bytes.byteLength} bytes)` }
    return { bytes, name: basename(f.file_path) }
  } catch (e) { return { why: `not fetched from Telegram (${errText(e)})` } }
}

/** the files of one recorded message into Onsen: each source's bytes, uploaded with the key of its place; the ids in `attachments` order (a file not
 *  stored is left out, with one log line: why). Never throws */
export async function storeFiles(item: OnsenItem, sources: Source[], upload: Upload, log: Log): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < sources.length; i++) {
    const a = item.attachments?.[i] ?? {}, key = fileKey(item.idem_key, i, sources.length)
    const not = (why: string) => log('warn', `onsen: files: ${key} (${item.kind}${a.name ? ` ${a.name}` : ''}) not stored in Onsen: ${why}; recorded with the name and Telegram id only`)
    let got: Got
    try { got = await sources[i]!() } catch (e) { got = { why: errText(e) } }
    if ('why' in got) { not(got.why); continue }
    const name = a.name ?? got.name ?? null
    const r = await upload(got.bytes, { key, name, mime: mimeOf(name, a.mime) }).catch(e => ({ error: errText(e) }))
    if ('error' in r) { not(r.error); continue }
    ids.push(r.id)
    log('info', `onsen: files: ${key} stored as Onsen file ${r.id} (${got.bytes.byteLength} bytes)`)
  }
  return ids
}

/** the inbox copy of a person's photo, which the daemon downloads for the agent anyway (message:photo): the upload waits for it instead of fetching the
 *  photo again. A message that never reached the download (a permission reply, a command the daemon answered) or whose download failed: null, and the
 *  upload fetches its own */
export class PhotoCopies {
  private m = new WeakMap<object, { p: Promise<string | null>; settle: (path: string | null) => void }>()
  open(msg: object): void {
    let settle!: (path: string | null) => void
    const p = new Promise<string | null>(r => { settle = r })
    this.m.set(msg, { p, settle })
  }
  /** the download (its result unchanged) settles the copy */
  track(msg: object, download: Promise<string>): Promise<string> {
    const c = this.m.get(msg)
    if (c) download.then(path => c.settle(path), () => c.settle(null))
    return download
  }
  /** the message is handled: a copy still open has none */
  done(msg: object): void { this.m.get(msg)?.settle(null) }
  /** the copy's path once known (null: none); null at once for a message never opened */
  of(msg: object): Promise<string | null> { return this.m.get(msg)?.p ?? Promise.resolve(null) }
}
