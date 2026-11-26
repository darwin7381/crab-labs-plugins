// onsen-avatar.ts — WO-172 part 3 (Chiron; Joey TG chiron:2549 「要有頭貼」; Onsen contract v1 §2 Member.avatar; mapping A-4: the avatars Joey chose
// are the bots' Telegram profile photos): this daemon puts its OWN bot's profile photo on its own Onsen member, so the member page and the conversation
// list use the same picture and nobody keeps a second copy.
//
//   when    at start (a random moment of the first minute: a fleet that restarts together does not upload together) and every 24 h (avatars rarely
//           change; a day to catch up is enough, and each check is one small request)
//   what    Bot API getUserProfilePhotos on the bot's own id, the newest photo's largest size, getFile, the file itself; its sha256 against the last
//           upload's (<STATE_DIR>/onsen/avatar.json): different → PUT <ONSEN_BASE>/v1/members/<agent>/avatar (the image itself as the body, its
//           Content-Type from its first bytes; Onsen WO-170 keeps the version when the bytes are the same). No photo: nothing is sent (Onsen shows its
//           computed fallback)
//   failure one line in the log; the next check (the next start, or 24 h later) tries again. Nothing else: no retry loop
//   never   for another member; never Joey's picture (Onsen's page side has his)
// Off unless ONSEN_AVATAR lists the agent (a comma list or `*`, as ONSEN_PULL): Onsen's upload endpoint is WO-170's and opens with it.
import { createHash } from 'node:crypto'

export type PhotoSize = { file_id: string; width?: number; height?: number; file_size?: number }
export type AvatarDeps = {
  agent: string
  /** the bot's own Telegram id (getMe) */
  botId(): Promise<number>
  /** getUserProfilePhotos(id, limit 1): the sizes of the bot's newest profile photo; [] when it has none */
  photoSizes(id: number): Promise<PhotoSize[]>
  /** getFile and the download: the file's bytes */
  download(fileId: string): Promise<Uint8Array>
  /** PUT …/v1/members/<agent>/avatar with these bytes: Onsen's HTTP status (0: no answer) and, on a refusal, what it said */
  put(bytes: Uint8Array, contentType: string): Promise<{ status: number; detail?: string }>
  /** the last upload Onsen took: its sha256 */
  load(): { sha256: string; at?: string } | null
  save(x: { sha256: string; at: string; bytes: number }): void
  log(level: 'info' | 'warn', msg: string): void
  now?(): number
}
export type AvatarResult = 'uploaded' | 'same' | 'no_photo' | 'failed'
/** the image formats Onsen takes (WO-170 AVATAR_TYPES), from the first bytes */
export function imageType(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'image/webp'
  if (b.length >= 4 && String.fromCharCode(...b.subarray(0, 4)) === 'GIF8') return 'image/gif'
  return null
}
/** the largest size of a photo (by area, else by file size; Telegram lists them smallest first) */
export function largest(sizes: PhotoSize[]): PhotoSize | null {
  let best: PhotoSize | null = null
  const area = (s: PhotoSize) => (s.width ?? 0) * (s.height ?? 0) || (s.file_size ?? 0)
  for (const s of sizes) if (s?.file_id && (!best || area(s) >= area(best))) best = s
  return best
}
export const AVATAR_EVERY_MS = 24 * 3600_000

export class AvatarSync {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  constructor(readonly d: AvatarDeps) {}
  private now(): number { return (this.d.now ?? Date.now)() }

  /** one check: the photo, its hash against the last upload, the upload when it differs */
  async syncOnce(): Promise<AvatarResult> {
    if (this.running) return 'same'
    this.running = true
    try {
      const id = await this.d.botId()
      const best = largest(await this.d.photoSizes(id))
      if (!best) { this.d.log('info', `onsen avatar: the bot has no profile photo: nothing sent (Onsen shows its fallback)`); return 'no_photo' }
      const bytes = await this.d.download(best.file_id)
      const type = imageType(bytes)
      if (!type) { this.d.log('warn', `onsen avatar: the bot's photo is not an image Onsen takes (${bytes.length} bytes): not sent; checked again at the next start`); return 'failed' }
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (this.d.load()?.sha256 === sha256) return 'same'
      const r = await this.d.put(bytes, type)
      if (r.status < 200 || r.status >= 300) {
        this.d.log('warn', `onsen avatar: PUT /v1/members/${this.d.agent}/avatar answered ${r.status || 'nothing'}${r.detail ? ` (${r.detail.slice(0, 160)})` : ''}: tried again at the next start`)
        return 'failed'
      }
      this.d.save({ sha256, at: new Date(this.now()).toISOString(), bytes: bytes.length })
      this.d.log('info', `onsen avatar: the bot's profile photo is ${this.d.agent}'s avatar (${type}, ${bytes.length} bytes, sha256 ${sha256.slice(0, 12)})`)
      return 'uploaded'
    } catch (e) {
      this.d.log('warn', `onsen avatar: ${e instanceof Error ? e.message : e}: tried again at the next start`)
      return 'failed'
    } finally { this.running = false }
  }
  /** the first check after `firstMs`, then every `everyMs` */
  start(firstMs: number, everyMs = AVATAR_EVERY_MS): void {
    if (this.timer) return
    const next = (ms: number) => { this.timer = setTimeout(() => { void this.syncOnce().finally(() => next(everyMs)) }, ms); (this.timer as any).unref?.() }
    next(firstMs)
  }
  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = null }
}
