// WO-189 (Chiron; ruling A, 09:21Z): the files Joey sends an agent from Onsen's page. A message he writes there (the forms inbox's `say` item) carries
// `attachments: [{kind, name, mime, bytes, url}]` (Onsen's Message.attachments). The daemon takes each file with this agent's own credential, only from
// Onsen's own address, into the same inbox as Telegram's pictures, and the <channel> tag carries the attributes a Telegram message would: a picture
// `image_path` (several: `image_path_2`, …, by position, `media_group_count` as for an album); any other file the existing set (`attachment_kind`,
// `attachment_file_id`, `attachment_name`, `attachment_mime`, `attachment_size`) with `attachment_file_id` = `onsen:<file id>`, which
// download_attachment answers with the local copy (taken again when it is not there). A picture not taken: `image_error` (403, the timeout, too large,
// no credential) and its `onsen:` id to retry with, the text delivered all the same. No new word for the agent, no new tool.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

export type OnsenAttachment = { kind?: string | null; name?: string | null; mime?: string | null; bytes?: number | null; url?: string | null }
export type GetFile = (url: string, maxBytes: number) => Promise<{ status: number; bytes: Uint8Array | null; mime: string | null } | null>
/** Onsen's own limit for a file (ONSEN_FILE_MAX_BYTES, 25 MB) */
export const MAX_BYTES = 25 * 1024 * 1024

/** the file id in an attachment's url (…/files/<id>), or null */
export function fileIdOf(url: string | null | undefined): string | null {
  const m = /\/files\/(\d+)(?:[?#].*)?$/.exec(String(url ?? ''))
  return m ? m[1] : null
}
export const isPicture = (a: OnsenAttachment): boolean => a.kind === 'photo' || /^image\//i.test(String(a.mime ?? ''))
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'text/markdown': 'md', 'text/plain': 'txt',
  'application/pdf': 'pdf', 'application/json': 'json' }
/** the local file name: <ms>-onsen-<id>.<ext> (the extension from the name, else the type; letters and digits only) */
export function localName(id: string, name: string | null | undefined, mime: string | null | undefined, now = Date.now()): string {
  const fromName = /\.([A-Za-z0-9]{1,10})$/.exec(String(name ?? ''))?.[1]
  const ext = (fromName ?? EXT[String(mime ?? '').split(';')[0].trim().toLowerCase()] ?? 'bin').replace(/[^A-Za-z0-9]/g, '') || 'bin'
  return `${now}-onsen-${id.replace(/[^0-9]/g, '') || 'x'}.${ext}`
}
/** one file into `dir`: its path, or why it was not taken (a short reason for image_error) */
export async function takeOne(get: GetFile, url: string, id: string, name: string | null | undefined, mime: string | null | undefined, dir: string,
  max = MAX_BYTES, now = Date.now()): Promise<{ path: string } | { why: string }> {
  let r: Awaited<ReturnType<GetFile>>
  try { r = await get(url, max) } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    return { why: /timeout|timed out|aborted/i.test(m) ? 'timeout' : /too large/.test(m) ? `too large (over ${Math.round(max / 1048576)} MB)` : m.slice(0, 120) }
  }
  if (r == null) return { why: 'no credential' }
  if (!r.bytes) return { why: `HTTP ${r.status}` }
  try {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, localName(id, name, mime ?? r.mime, now))
    writeFileSync(path, r.bytes)
    return { path }
  } catch (e) { return { why: `not written (${e instanceof Error ? e.message : e})`.slice(0, 120) } }
}
/** the <channel> attributes for a message's attachments, each file taken now. `saved`: onsen:<id> → local path, for download_attachment */
export async function attachmentMeta(atts: OnsenAttachment[], o: { get: GetFile; dir: string; saved: Map<string, string>; max?: number; now?: () => number;
  log?: (msg: string) => void }): Promise<Record<string, string>> {
  const meta: Record<string, string> = {}
  const list = atts.filter(a => a && typeof a === 'object')
  for (let i = 0; i < list.length; i++) {
    const a = list[i], k = i === 0 ? '' : `_${i + 1}`
    const id = fileIdOf(a.url) ?? `${i + 1}`, fid = `onsen:${id}`
    const size = Number.isFinite(Number(a.bytes)) ? String(Number(a.bytes)) : null
    const max = o.max ?? MAX_BYTES
    const got = !a.url ? { why: 'no url' } : size != null && Number(size) > max ? { why: `too large (over ${Math.round(max / 1048576)} MB)` }
      : await takeOne(o.get, a.url, id, a.name, a.mime, o.dir, max, o.now ? o.now() : Date.now())
    if ('path' in got) o.saved.set(fid, got.path)
    else o.log?.(`onsen: page file ${fid} (${a.name ?? '?'}) not taken: ${got.why}`)
    if (isPicture(a)) {
      if ('path' in got) meta[`image_path${k}`] = got.path
      else Object.assign(meta, { [`image_error${k}`]: got.why, [`attachment_kind${k}`]: 'photo', [`attachment_file_id${k}`]: fid, ...(size ? { [`attachment_size${k}`]: size } : {}) })
    } else {
      Object.assign(meta, { [`attachment_kind${k}`]: String(a.kind || 'document'), [`attachment_file_id${k}`]: fid,
        ...(size ? { [`attachment_size${k}`]: size } : {}), ...(a.mime ? { [`attachment_mime${k}`]: String(a.mime) } : {}), ...(a.name ? { [`attachment_name${k}`]: String(a.name) } : {}) })
    }
  }
  if (list.length > 1) meta.media_group_count = String(list.length)
  return meta
}
