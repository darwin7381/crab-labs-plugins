// WO-197 final (telegram-http 1.59.0; Chiron's ruling A): the ONE file that talks to Telegram directly. Loaded only by a roamer daemon (ROAMER_MODE=1:
// server.ts imports it with a dynamic import() and nowhere else). Every other daemon (a non-roamer telegram-http daemon, the agent-inbox daemon) never
// loads this file or grammy: it is a connector and reaches Telegram only through Onsen and the machine's telegram-bridge.
//
// What is here, moved from server.ts / tg-fetch.ts as they were (a roamer behaves as a daemon did before 1.59.0 with ONSEN_BRIDGE off):
//   bot        grammy's Bot over TELEGRAM_API_ROOT (default https://api.telegram.org); the send bound (TELEGRAM_SEND_TIMEOUT_S / TELEGRAM_UPLOAD_TIMEOUT_S,
//              SendTimeoutError); the raw Bot API POST for what grammy does not expose (sendRichMessage, a rich editMessageText)
//   poll       the long poll and its retries (409 waits, any other error backs off), setMyCommands, the worker-topic mode at start (lanes on)
//   inbound    every update handler: the trace line, /start /help /status (/main /lanes with lanes on), the buttons (callback_query), each message kind;
//              the access gate and pairing (codes, the approved/ confirmations, the 5-minute sweep), the permission reply `yes abcde`, the typing
//              action, the 👀 ack, the control plane's and the roamer's slash commands, a photo / a voice note taken from Telegram, the local
//              transcript of a voice note; then server.ts finishInbound (the tag, the album wait, the routing: the same for every message)
//   outbound   the Telegram half of every send server.ts makes for a roamer: the reply tool (parts rich → plain, files), react, edit_message,
//              download_attachment, a text with buttons, an edit of one, the typing action, a worker topic (create, ✅ icon, mode)
// A roamer records nothing into Onsen (1.58.32: recording is off for ROAMER_MODE=1), so nothing here writes to Onsen.
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { execFile } from 'child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join, extname, sep } from 'path'
import { randomBytes } from 'crypto'
import { expandHiddenEntities } from './entities.ts'
import { richToMarkdown } from './rich-inbound.ts'
import { handleControlSlash, isControlEnabled, controlCommandsForBotApi, type InlineButton, type ReplyOptions } from './channel-bot-control.ts'
import { isRoamerEnabled, handleRoamerSlash, roamerCommandsForBotApi } from './roamer-control.ts'
import { isDutyCallback } from './duty-officer.ts'
import { memberOfTg } from './onsen-client.ts'
import * as Lanes from './lanes.ts'
import { topicMode, topicModeAtStart, topicVerdict, type TopicMe, type TopicVerdict } from './lanes-topics.ts'
import type { Facts } from './onsen-inbound.ts'

type Log = (level: 'info' | 'warn' | 'error', msg: string) => void
type PendingEntry = { senderId: string; chatId: string; createdAt: number; expiresAt: number; replies: number }
type GroupPolicy = { requireMention: boolean; allowFrom: string[] }
/** access.json as server.ts reads it (readAccessFile) */
export type Access = { dmPolicy: 'pairing' | 'allowlist' | 'disabled'; allowFrom: string[]; groups: Record<string, GroupPolicy>; pending: Record<string, PendingEntry>
  mentionPatterns?: string[]; ackReaction?: string; [k: string]: unknown }
export type TopicF = { message_thread_id?: number }
type SelfWho = { chat: string; id: number | string | undefined; from: string; via?: string }

/** what the Telegram side needs of the engine (server.ts): access.json, the shared send, the permission prompts, the menus, the tag builder */
export interface RoamerHost {
  log: Log
  stateDir: string
  inboxDir: string
  httpPort: string
  staticAccess: boolean
  loadAccess(): Access
  readAccessFile(): Access
  saveAccess(a: Access): void
  shuttingDown(): boolean
  botMenu(): Array<{ command: string; description: string }>
  startText: string
  helpText: string
  pairedStatusText(name: string): Promise<string>
  topicFields(a: Lanes.TopicAsk): TopicF
  sentIn(chat: string, ids: Array<number | null | undefined>, f: TopicF): void
  topicOfMessage(m: any): number | undefined
  /** server.ts sendTextWithMaybeKeyboard: a text (chunked) with an optional keyboard on its last part, where it answers */
  sendText(chat: string, text: string, keyboard?: InlineButton[][], where?: Lanes.TopicAsk): Promise<void>
  handledHere<T>(who: SelfWho | null, how: string, run: () => Promise<T>, mine?: (r: T | undefined) => boolean): Promise<T>
  /** a permission prompt answered here (a button, or `yes abcde`): gone (its conversation closed: cancelled, nothing sent), answered, or unknown */
  permissionAnswer(reqId: string, behavior: 'allow' | 'deny', senderId: string, via: 'button' | 'text'): 'gone' | 'answered' | 'unknown'
  permissionDetails(reqId: string): { tool_name: string; description: string; input_preview: string } | null
  /** a Telegram copy of a prompt now shows `text` (its See more), so a press elsewhere edits it from there */
  permissionCopyText(reqId: string, chat: string, msg: number, text: string): void
  /** the duty officer's question pressed: its toast, or null (this sender may not answer it) */
  dutyTap(data: string, senderId: string, who: string): Promise<string | null>
  pickerTap(data: string, senderId: string, reply: (msg: string) => Promise<void>): Promise<unknown>
  runControlCallback(data: string, httpPort: string, reply: (msg: string, opts?: ReplyOptions) => Promise<void>): Promise<void>
  /** the rest of a person's message (its tag, the album wait, the router): server.ts finishInbound */
  finishInbound(f: Facts, got: { imagePath?: string; imageError?: string }): Promise<unknown>
  replyForwardMeta(m: any, attachmentFromReply: boolean, skipTopicCreation: boolean): Record<string, string>
  safeName(s: string | undefined): string | undefined
  metaExcerpt(s: string, cap?: number): string
}

// lanes-topics (item 7, always on, lanes on or off): a send never hangs forever. 2026-11-23 19:19 TPE the channel bot's reply (rich text, the raw POST's
// bare fetch) got no result for over 120 s with nothing in the log, while getMe answered in 0.7 s; grammy's own calls wait up to its 500 s default. Every
// call that delivers something to a chat gets TELEGRAM_SEND_TIMEOUT_S (default 45): on expiry the call fails with SendTimeoutError, which says the
// message MAY have been delivered, and is never sent again by the daemon (a duplicate is the caller's choice: the rich → plain fallbacks do not run on
// it). One log line per timeout (method, elapsed; never the text). The long poll and every other method keep grammy's own wait.
const SEND_TIMEOUT_S = (() => { const n = Number(process.env.TELEGRAM_SEND_TIMEOUT_S ?? 45); return Number.isFinite(n) && n > 0 ? n : 45 })()
// A file upload (photo, document: up to 50 MB) legitimately takes longer than a text send: its own bound, TELEGRAM_UPLOAD_TIMEOUT_S (default 300), never
// shorter than the send bound. Without it a large file on a slow uplink would be reported as "no answer" at 45 s while still uploading.
const UPLOAD_TIMEOUT_S = (() => { const n = Number(process.env.TELEGRAM_UPLOAD_TIMEOUT_S ?? 300); return Math.max(SEND_TIMEOUT_S, Number.isFinite(n) && n > 0 ? n : 300) })()
const UPLOAD_SENDS = new Set(['sendPhoto', 'sendDocument'])
const sendBoundS = (method: string): number => UPLOAD_SENDS.has(method) ? UPLOAD_TIMEOUT_S : SEND_TIMEOUT_S
const BOUNDED_SENDS = new Set(['sendMessage', 'sendRichMessage', 'sendPhoto', 'sendDocument', 'sendChatAction', 'editMessageText', 'setMessageReaction',
  'createForumTopic', 'editForumTopic'])
export class SendTimeoutError extends Error {
  constructor(readonly method: string, readonly elapsedMs: number) {
    super(`${method}: no answer from Telegram within ${sendBoundS(method)} s; the message may or may not have been delivered. It was not sent again: look at the chat before sending it again.`)
  }
}

// Permission-reply spec from anthropics/claude-cli-internal src/services/mcp/channelPermissions.ts — inlined (no CC repo dep). 5 lowercase letters a-z
// minus 'l'. Case-insensitive for phone autocorrect. Strict: no bare yes/no (conversational), no prefix/suffix chatter.
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// #16 (2026-07-10): pairing codes live 30 minutes (was 1h). The pairing prompt shows the remaining validity so the human knows the code in an old
// message may be dead; expired codes are pruned on every gate call AND by a periodic sweep (so they clear even with zero traffic).
const PAIRING_TTL_MS = 30 * 60 * 1000
const PAIRING_PRUNE_INTERVAL_MS = 5 * 60 * 1000
type GateResult = { action: 'deliver'; access: Access } | { action: 'drop' } | { action: 'pair'; code: string; isResend: boolean; expiresAt: number }
function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) if (p.expiresAt < now) { delete a.pending[code]; changed = true }
  return changed
}
/** #16: human-readable remaining validity of a pairing code */
function pairingRemainingMin(expiresAt: number): number { return Math.max(1, Math.ceil((expiresAt - Date.now()) / 60000)) }

type AttachmentMeta = { kind: string; file_id: string; size?: number; mime?: string; name?: string }
/** A photo pending download: file_id/size survive a failed download so the agent still gets attachment_file_id + image_error instead of silence (#2) */
type ImageSource = { file_id: string; size?: number; download: () => Promise<string>; unique?: string }

// #12 (opt-in, CHANNEL_BOT_VOICE_TRANSCRIBE=1): local speech-to-text of a voice note / audio file, so the agent reads what was said. CHANNEL_BOT_TRANSCRIBE_CMD
// (a program given the audio path, its stdout the text) wins; else the openai-whisper CLI on CPU (CHANNEL_BOT_WHISPER_BIN if not on the daemon's PATH;
// CHANNEL_BOT_WHISPER_MODEL picks the model, default "small" — a voice note transcribes in seconds). Why not media-alchemist's transcribe.sh: its local mode
// force-selects MPS whenever torch reports it available, and current torch builds fail there with SparseMPS NotImplementedError (whisper's sparse
// alignment_heads can't .to("mps")) — verified broken 2026-07-10 on the Mac mini for both small and large-v3. CPU whisper CLI is deterministic and fast
// enough for voice notes (8s note → 7s wall with small).
function isVoiceTranscribeEnabled(): boolean {
  const v = (process.env.CHANNEL_BOT_VOICE_TRANSCRIBE ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}
const VOICE_TRANSCRIBE_TIMEOUT_MS = 240_000
const VOICE_TRANSCRIPT_CAP = 500
function execFileP(cmd: string, args: string[], timeout: number): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => { if (err) reject(err); else resolve({ stdout: String(stdout) }) })
  })
}
async function transcribeVoiceFile(audioPath: string, inboxDir: string): Promise<string | undefined> {
  const custom = (process.env.CHANNEL_BOT_TRANSCRIBE_CMD ?? '').trim()
  if (custom) {
    const { stdout } = await execFileP(custom, [audioPath], VOICE_TRANSCRIBE_TIMEOUT_MS)
    return stdout.trim() || undefined
  }
  const whisperBin = (process.env.CHANNEL_BOT_WHISPER_BIN ?? '').trim() || 'whisper'
  const model = (process.env.CHANNEL_BOT_WHISPER_MODEL ?? '').trim() || 'small'
  const outDir = join(inboxDir, 'transcripts')
  mkdirSync(outDir, { recursive: true })
  await execFileP(whisperBin, [audioPath, '--model', model, '--device', 'cpu', '--fp16', 'False', '--output_format', 'txt', '--output_dir', outDir, '--verbose', 'False'],
    VOICE_TRANSCRIBE_TIMEOUT_MS)
  // whisper writes <basename-without-ext>.txt into output_dir
  const base = audioPath.split(sep).pop()!.replace(/\.[^.]+$/, '')
  const outPath = join(outDir, `${base}.txt`)
  try {
    const text = readFileSync(outPath, 'utf8')
    rmSync(outPath, { force: true })
    return text.trim() || undefined
  } catch {
    return undefined
  }
}

export class RoamerTelegram {
  readonly bot: Bot
  /** grammy's onStart sets it; '' = not polling (yet) */
  botUsername = ''
  /** the latest update_id, so the heartbeat shows whether polling is actually receiving updates (vs alive but stuck) */
  lastUpdateId = 0
  private host: RoamerHost | null = null
  private pollRunning = false
  /** lanes-topics (item 4): the ✅ topic icon's custom emoji id, once found */
  private checkIconId: string | undefined
  private readonly apiRoot: string

  constructor(private readonly o: { token: string; apiRoot?: string; log: Log; handover?: { pollOffset: number | null; rememberPollOffset(offset: number | null): void } }) {
    // genesis lab: grammy uses the same API root as the raw POST and the file downloads, so a TELEGRAM_API_ROOT mock receives getUpdates / sendMessage too
    this.apiRoot = o.apiRoot ?? 'https://api.telegram.org'
    this.bot = new Bot(o.token, { client: { ...(o.apiRoot ? { apiRoot: o.apiRoot } : {}) } })
    this.bot.api.config.use((prev, method, payload, signal) =>
      BOUNDED_SENDS.has(method) ? this.boundedSend(method, s => prev(method, payload, s), signal) : prev(method, payload, signal))
  }

  private get log(): Log { return this.o.log }
  /** polling: grammy's onStart has run (the bot's username known) */
  get polling(): boolean { return this.botUsername !== '' }

  /** run one Bot API call with the send bound; `outer`: the caller's own abort signal, kept */
  private async boundedSend<T>(method: string, run: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
    const ac = new AbortController(), t0 = Date.now()
    const onOuter = (): void => ac.abort()
    outer?.addEventListener('abort', onOuter)
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, rej) => {
      timer = setTimeout(() => {
        ac.abort()
        this.log('warn', `telegram send timeout: ${method} got no answer in ${Date.now() - t0} ms (bound ${sendBoundS(method)} s); not sent again`)
        rej(new SendTimeoutError(method, Date.now() - t0))
      }, sendBoundS(method) * 1000)
    })
    try { return await Promise.race([run(ac.signal), expired]) }
    finally { clearTimeout(timer); outer?.removeEventListener('abort', onOuter) }
  }

  // ---- Rich Messages (Telegram Bot API 10.1, 2026-06-11): grammy 1.41.x doesn't expose sendRichMessage / editMessageText's rich_message, so the raw
  // Bot API is POSTed (with the same send bound as grammy's calls)
  async callBotApi(method: string, payload: Record<string, unknown>): Promise<any> {
    const data = await this.boundedSend(method, async signal => {
      const res = await fetch(`${this.apiRoot}/bot${this.o.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal })
      return (await res.json()) as { ok: boolean; result?: any; description?: string; error_code?: number }
    })
    if (!data.ok) throw new Error(`${method}: ${data.error_code ?? '?'} ${data.description ?? 'unknown error'}`)
    return data.result
  }

  private keyboard(spec: InlineButton[][]): InlineKeyboard {
    const k = new InlineKeyboard()
    spec.forEach((row, i) => { if (i > 0) k.row(); for (const btn of row) k.text(btn.text, btn.callback_data) })
    return k
  }

  /** one text message; its message_id */
  async sendText(chat: string, text: string, o: { keyboard?: InlineButton[][]; topicF?: TopicF; silent?: boolean; replyTo?: number; allowWithoutReply?: boolean } = {}): Promise<number> {
    const m = await this.bot.api.sendMessage(chat, text, {
      ...(o.keyboard ? { reply_markup: this.keyboard(o.keyboard) } : {}), ...(o.topicF ?? {}), ...(o.silent ? { disable_notification: true } : {}),
      ...(o.replyTo != null ? { reply_parameters: { message_id: o.replyTo, ...(o.allowWithoutReply ? { allow_sending_without_reply: true } : {}) } } : {}),
    })
    return m.message_id
  }

  /** a text already cut into parts, the keyboard on the LAST part (where the action call-to-action lives); a part that fails is logged and the rest go */
  async sendChunks(chat: string, chunks: string[], keyboard: InlineButton[][] | undefined, tf: TopicF): Promise<number[]> {
    const ids: number[] = []
    const kb = keyboard ? this.keyboard(keyboard) : undefined
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1
      try {
        const m = await this.bot.api.sendMessage(chat, chunks[i]!, { ...tf, ...(isLast && kb ? { reply_markup: kb } : {}) })
        ids.push(m.message_id)
      } catch (err) {
        this.log('warn', `sendTextWithMaybeKeyboard failed: ${err instanceof Error ? err.message : err}`)
      }
    }
    return ids
  }

  /** edit a message's text; `clearKeyboard`: its buttons go (a prompt that was answered or is gone) */
  async editText(chat: string, msg: number, text: string, o: { clearKeyboard?: boolean } = {}): Promise<void> {
    await this.bot.api.editMessageText(chat, msg, text, o.clearKeyboard ? { reply_markup: { inline_keyboard: [] } } : undefined)
  }

  /**
   * THE text send to a chat: the main's `reply` and (lanes on) every lane line and router notice. Each part goes as a Rich Message (GFM rendered) when
   * `useRich`, and as a plain sendMessage when the rich send fails for any reason but the item-7 timeout (it may have been delivered: never sent twice).
   * `rich[i]` / `plain[i]` are the same part in each form (a lane line's label is written differently in each). reply_parameters on the first part (every
   * part with `replyAll`); `quiet` and the topic on every part. A failure says how many parts had gone out.
   */
  async sendParts(chat_id: string, parts: { rich: string[]; plain: string[] }, o: {
    what: string; useRich: boolean; parseMode?: 'MarkdownV2'; quiet: { disable_notification?: boolean }; topicF: TopicF
    replyParams?: Record<string, unknown>; replyAll?: boolean; sentLog?: (method: string, id: unknown, t0: number) => void
  }): Promise<number[]> {
    const sentIds: number[] = []
    const { quiet, topicF, parseMode } = o
    const n = parts.plain.length
    try {
      for (let i = 0; i < n; i++) {
        const shouldReplyTo = !!o.replyParams && (o.replyAll || i === 0)
        if (o.useRich) {
          const t0 = Date.now()
          try {
            const r = await this.callBotApi('sendRichMessage', {
              chat_id, rich_message: { markdown: parts.rich[i] }, ...(shouldReplyTo ? { reply_parameters: o.replyParams } : {}), ...quiet, ...topicF,
            })
            sentIds.push(r.message_id)
            o.sentLog?.('sendRichMessage', r.message_id, t0)
            continue
          } catch (re) {
            if (re instanceof SendTimeoutError) throw re          // item 7: it may have been delivered: never sent again as plain text
            this.log('warn', `sendRichMessage failed, falling back to plain: ${re instanceof Error ? re.message : re}`)
          }
        }
        const t0 = Date.now()
        const sent = await this.bot.api.sendMessage(chat_id, parts.plain[i]!, {
          ...(shouldReplyTo ? { reply_parameters: o.replyParams as { message_id: number } } : {}), ...(parseMode ? { parse_mode: parseMode } : {}), ...quiet, ...topicF,
        })
        sentIds.push(sent.message_id)
        o.sentLog?.('sendMessage', sent.message_id, t0)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`${o.what} failed after ${sentIds.length} of ${n} chunk(s) sent: ${msg}`, { cause: err })
    }
    return sentIds
  }

  /** the reply tool's Telegram half: the text parts (sendParts), then each file as its own message (.jpg/.jpeg/.png/.gif/.webp as a photo, Telegram
   *  compresses + shows inline; everything else a document), threaded under reply_to when there is one; the ids of everything sent */
  async sendReply(chat_id: string, o: { chunks: string[]; files: string[]; useRich: boolean; parseMode?: 'MarkdownV2'; quiet: { disable_notification?: boolean }
    topicF: TopicF; replyParams?: { message_id: number }; replyAll: boolean; silent: boolean; photoExts: Set<string>; sentLog: (method: string, id: unknown, t0: number) => void }): Promise<number[]> {
    const sentIds = await this.sendParts(chat_id, { rich: o.chunks, plain: o.chunks }, { what: 'reply', useRich: o.useRich, parseMode: o.parseMode, quiet: o.quiet,
      topicF: o.topicF, sentLog: o.sentLog, replyParams: o.replyParams, replyAll: o.replyAll })
    // Files go as separate messages (Telegram doesn't mix text+file in one sendMessage call). Thread under reply_to if present.
    for (const f of o.files) {
      const input = new InputFile(f)
      const base = o.replyParams ? { reply_parameters: o.replyParams, ...o.quiet } : (o.silent ? o.quiet : undefined)
      const opts = o.topicF.message_thread_id != null ? { ...(base ?? {}), ...o.topicF } : base
      const method = o.photoExts.has(extname(f).toLowerCase()) ? 'sendPhoto' as const : 'sendDocument' as const
      const t0 = Date.now()
      try {
        const sent = method === 'sendPhoto' ? await this.bot.api.sendPhoto(chat_id, input, opts) : await this.bot.api.sendDocument(chat_id, input, opts)
        sentIds.push(sent.message_id)
        o.sentLog(method, sent.message_id, t0)
      } catch (fe) {
        // item 7: a file that got no answer says what had already gone out
        if (fe instanceof SendTimeoutError) throw new Error(`reply failed after ${sentIds.length} of ${o.chunks.length + o.files.length} part(s) sent: ${fe.message}`)
        throw fe
      }
    }
    return sentIds
  }

  async react(chat: string, msg: number, emoji: string): Promise<void> {
    await this.bot.api.setMessageReaction(chat, msg, [{ type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] }])
  }

  /** edit_message's Telegram half: rich (editMessageText with rich_message) when `rich`, the plain edit on a rendering failure (never on a timeout); the id */
  async editMessage(chat: string, msg: number, text: string, o: { rich: boolean; parseMode?: 'MarkdownV2' }): Promise<unknown> {
    if (o.rich) {
      try {
        const r = await this.callBotApi('editMessageText', { chat_id: chat, message_id: msg, rich_message: { markdown: text } })
        return r && typeof r === 'object' ? r.message_id : msg
      } catch (re) {
        if (re instanceof SendTimeoutError) throw re              // item 7: no answer: not edited again as plain text
        this.log('warn', `editMessageText rich failed, falling back to plain: ${re instanceof Error ? re.message : re}`)
      }
    }
    const edited = await this.bot.api.editMessageText(chat, msg, text, ...(o.parseMode ? [{ parse_mode: o.parseMode }] : []))
    return typeof edited === 'object' ? edited.message_id : msg
  }

  async typing(chat: string, tf: TopicF): Promise<void> { await this.bot.api.sendChatAction(chat, 'typing', tf) }

  /** a file of a Telegram message, by its file_id, into `dir` as <ms>-<file_unique_id>.<ext> (download_attachment); Telegram caps bot downloads at 20 MB */
  async download(fileId: string, dir: string, o: { prefix?: string; defaultExt?: string } = {}): Promise<{ path: string; filePath: string }> {
    const file = await this.bot.api.getFile(fileId)
    if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired')
    const res = await fetch(`${this.apiRoot}/file/bot${this.o.token}/${file.file_path}`)
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    // file_path is from Telegram (trusted), but strip to safe chars anyway so nothing downstream can be tricked by an unexpected extension
    const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : (o.defaultExt ?? 'bin')
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || (o.defaultExt ?? 'bin')
    const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
    const path = join(dir, `${Date.now()}-${o.prefix ?? uniqueId}.${ext}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, buf)
    return { path, filePath: file.file_path }
  }

  // Download a Telegram photo (largest size) to the inbox. Shared by the message:photo handler and replyAttachment. Throws on any failure so the caller
  // can mark image_error instead of silently losing the picture (#2).
  private async downloadPhoto(ctx: Context, best: { file_id: string; file_unique_id: string }): Promise<string> {
    const file = await ctx.api.getFile(best.file_id)
    if (!file.file_path) throw new Error('getFile returned no file_path')
    const res = await fetch(`${this.apiRoot}/file/bot${this.o.token}/${file.file_path}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const ext = file.file_path.split('.').pop() ?? 'jpg'
    const dir = this.host!.inboxDir
    const path = join(dir, `${Date.now()}-${best.file_unique_id}.${ext}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, buf)
    return path
  }

  /** #12 (opt-in): local whisper transcript for voice/audio attachments */
  private async maybeTranscribeVoice(attachment: AttachmentMeta | undefined): Promise<string | undefined> {
    if (!attachment) return undefined
    if (attachment.kind !== 'voice' && attachment.kind !== 'audio') return undefined
    if (!isVoiceTranscribeEnabled()) return undefined
    const h = this.host!
    try {
      const got = await this.download(attachment.file_id, h.inboxDir, { prefix: 'voice', defaultExt: 'oga' })
      const raw = await transcribeVoiceFile(got.path, h.inboxDir)
      if (!raw) return undefined
      return h.metaExcerpt(raw, VOICE_TRANSCRIPT_CAP)
    } catch (err) {
      this.log('warn', `voice transcribe failed (delivering without transcript): ${err instanceof Error ? err.message : err}`)
      return undefined
    }
  }

  // ---- worker topics (lanes on): Bot API 10.5, private-chat topics
  async createTopic(chat: string, name: string): Promise<number> { return (await this.bot.api.createForumTopic(chat, name)).message_thread_id }
  /** lanes-topics (item 1): the topic mode as getMe shows it now (one decision, lanes-topics.ts) */
  async topicsUsable(): Promise<TopicVerdict> { return topicVerdict((await this.bot.api.getMe()) as unknown as TopicMe) }
  /** lanes-topics (item 4): a finished topic gets the ✅ icon (its id from getForumTopicIconStickers, looked up once and kept; none there: the icon is left
   *  as it is). Never deleteForumTopic: it removes the topic's messages. */
  async topicDone(chat: string, thread: number): Promise<string> {
    this.checkIconId ??= ((await this.bot.api.getForumTopicIconStickers()) as Array<{ emoji?: string; custom_emoji_id?: string }>)
      .find(s => s.emoji?.replace(/️/g, '') === '✅')?.custom_emoji_id
    if (!this.checkIconId) return 'getForumTopicIconStickers has no ✅: the icon was left as it is'
    await this.bot.api.editForumTopic(chat, thread, { icon_custom_emoji_id: this.checkIconId })
    return `the icon was set to ✅ (${this.checkIconId})`
  }
  // lanes-golive: private-chat topics for worker lanes (Bot API 10.5, 2026-11-22: setMySettings; getMe reports has_topics_enabled and
  // allows_users_to_create_topics). lanes-topics (item 1): the topic mode is ONE decision (lanes-topics.ts topicModeAtStart). LANES_WORKER_TOPICS=enable
  // sends has_topics_enabled=true AND allows_users_to_create_topics=false in one call and checks both with getMe; auto changes nothing and warns once when
  // getMe shows the broken mode (the user opens a topic per message: 11-23, Joey's chat); off: never a worker topic.
  private async laneTopicsAtStart(me: Record<string, unknown>): Promise<void> {
    const r = await topicModeAtStart(topicMode(), me as TopicMe, {
      setMySettings: p => (this.bot.api.raw as any).setMySettings(p),
      getMe: async () => (await this.bot.api.getMe()) as unknown as TopicMe,
    })
    if (r.warn) this.log('warn', `lanes: worker topics: ${r.warn}`)
    this.log('info', `lanes: worker topics ${r.mode}: ${r.verdict.usable === true ? 'usable' : r.verdict.usable === false ? 'not used' : 'not known (asked when a worker opens)'}`
      + `${r.set ? ' (setMySettings sent)' : ''}: ${r.verdict.why}`)
  }

  // ---- inbound -------------------------------------------------------------------------------------------------------------------------------
  private gate(ctx: Context): GateResult {
    const h = this.host!
    const access = h.loadAccess()
    if (pruneExpired(access)) h.saveAccess(access)
    if (access.dmPolicy === 'disabled') return { action: 'drop' }
    const from = ctx.from
    if (!from) return { action: 'drop' }
    const senderId = String(from.id)
    const chatType = ctx.chat?.type
    if (chatType === 'private') {
      if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
      if (access.dmPolicy === 'allowlist') return { action: 'drop' }
      // pairing mode — check for existing non-expired code for this sender
      for (const [code, p] of Object.entries(access.pending)) {
        if (p.senderId === senderId) {
          // Reply twice max (initial + one reminder), then go silent.
          if ((p.replies ?? 1) >= 2) return { action: 'drop' }
          p.replies = (p.replies ?? 1) + 1
          h.saveAccess(access)
          return { action: 'pair', code, isResend: true, expiresAt: p.expiresAt }
        }
      }
      // Cap pending at 3. Extra attempts are silently dropped.
      if (Object.keys(access.pending).length >= 3) return { action: 'drop' }
      const code = randomBytes(3).toString('hex') // 6 hex chars
      const now = Date.now()
      const expiresAt = now + PAIRING_TTL_MS  // #16: 30min TTL
      access.pending[code] = { senderId, chatId: String(ctx.chat!.id), createdAt: now, expiresAt, replies: 1 }
      h.saveAccess(access)
      return { action: 'pair', code, isResend: false, expiresAt }
    }
    if (chatType === 'group' || chatType === 'supergroup') {
      const policy = access.groups[String(ctx.chat!.id)]
      if (!policy) return { action: 'drop' }
      const groupAllowFrom = policy.allowFrom ?? []
      const requireMention = policy.requireMention ?? true
      if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return { action: 'drop' }
      if (requireMention && !this.isMentioned(ctx, access.mentionPatterns)) return { action: 'drop' }
      return { action: 'deliver', access }
    }
    return { action: 'drop' }
  }

  // Like gate() but for bot commands: no pairing side effects, just allow/drop.
  private dmCommandGate(ctx: Context): { access: Access; senderId: string } | null {
    if (ctx.chat?.type !== 'private') return null
    if (!ctx.from) return null
    const h = this.host!
    const senderId = String(ctx.from.id)
    const access = h.loadAccess()
    if (pruneExpired(access)) h.saveAccess(access)
    if (access.dmPolicy === 'disabled') return null
    if (access.dmPolicy === 'allowlist' && !access.allowFrom.includes(senderId)) return null
    return { access, senderId }
  }

  private isMentioned(ctx: Context, extraPatterns?: string[]): boolean {
    const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
    const text = ctx.message?.text ?? ctx.message?.caption ?? ''
    for (const e of entities) {
      if (e.type === 'mention') {
        const mentioned = text.slice(e.offset, e.offset + e.length)
        if (mentioned.toLowerCase() === `@${this.botUsername}`.toLowerCase()) return true
      }
      if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === this.botUsername) return true
    }
    // Reply to one of our messages counts as an implicit mention.
    if (ctx.message?.reply_to_message?.from?.username === this.botUsername) return true
    for (const pat of extraPatterns ?? []) {
      try { if (new RegExp(pat, 'i').test(text)) return true } catch { /* Invalid user-supplied regex — skip it. */ }
    }
    return false
  }

  // The /telegram:access skill drops a file at approved/<senderId> when it pairs someone. Poll for it, send confirmation, clean up. For Telegram DMs,
  // chatId == senderId, so we can send directly without stashing chatId.
  private checkApprovals(): void {
    const dir = join(this.host!.stateDir, 'approved')
    let files: string[]
    try { files = readdirSync(dir) } catch { return }
    for (const senderId of files) {
      const file = join(dir, senderId)
      void this.bot.api.sendMessage(senderId, 'Paired! Say hi to Claude.').then(
        () => rmSync(file, { force: true }),
        err => {
          this.log('error', `failed to send approval confirm: ${err}`)
          rmSync(file, { force: true })            // Remove anyway — don't loop on a broken send.
        },
      )
    }
  }

  // When a message replies to another message that carries a file (e.g. user replies to an invoice PDF and @mentions the bot in the reply text), Telegram
  // keeps the file on the REPLIED-TO message, not the reply itself. The per-type handlers only read the current message's own attachment, so without this
  // the file would be lost. Photos need a deferred download closure (mirrors message:photo); everything else carries a file_id download_attachment takes.
  private replyAttachment(ctx: Context): { attachment?: AttachmentMeta; image?: ImageSource } {
    const sn = (s: string | undefined) => this.host!.safeName(s)
    const rt = ctx.message?.reply_to_message
    if (!rt) return {}
    if (rt.document) { const d = rt.document; return { attachment: { kind: 'document', file_id: d.file_id, size: d.file_size, mime: d.mime_type, name: sn(d.file_name) } } }
    if (rt.video) { const v = rt.video; return { attachment: { kind: 'video', file_id: v.file_id, size: v.file_size, mime: v.mime_type, name: sn(v.file_name) } } }
    if (rt.audio) { const a = rt.audio; return { attachment: { kind: 'audio', file_id: a.file_id, size: a.file_size, mime: a.mime_type, name: sn(a.file_name) } } }
    if (rt.voice) { const vo = rt.voice; return { attachment: { kind: 'voice', file_id: vo.file_id, size: vo.file_size, mime: vo.mime_type } } }
    if (rt.video_note) { const vn = rt.video_note; return { attachment: { kind: 'video_note', file_id: vn.file_id, size: vn.file_size } } }
    if (rt.photo && rt.photo.length > 0) {
      const best = rt.photo[rt.photo.length - 1]!
      return { image: { file_id: best.file_id, size: best.file_size, download: () => this.downloadPhoto(ctx, best), unique: best.file_unique_id } }
    }
    return {}
  }

  /** everything the <channel> tag of one Telegram message is built from (OnsenInbound.Facts: the same shape a connector builds from a person_message) */
  private inboundFacts(ctx: Context, text: string, image: ImageSource | undefined, attachment: AttachmentMeta | undefined, attachmentFromReply: boolean,
    voiceTranscript: string | undefined, inTopic: number | undefined): Facts {
    const m: any = ctx.message, from = ctx.from!
    return {
      chat_id: String(ctx.chat!.id), ...(m?.message_id != null ? { msgId: m.message_id } : {}), text,
      from: { id: from.id, ...(from.username != null ? { username: from.username } : {}) }, date: m?.date ?? 0,
      ...(image ? { image: { file_id: image.file_id, file_unique_id: image.unique ?? image.file_id, ...(image.size != null ? { size: image.size } : {}) } } : {}),
      ...(attachment ? { attachment: { ...attachment } } : {}), fromReply: attachmentFromReply,
      ...(voiceTranscript ? { voiceTranscript } : {}), ...(inTopic != null ? { inTopic } : {}),
      // Reply-root / forward-origin / album context (2026-07-10) — see server.ts replyForwardMeta. lanes-topics: with lanes on, the topic's creation
      // service message (what a message typed in a topic replies to) is not a reply of Joey's
      rfm: this.host!.replyForwardMeta(m, attachmentFromReply && !!(attachment || image), Lanes.LANES_ON),
      ...(m?.media_group_id ? { mgid: String(m.media_group_id) } : {}),
      // When a real caption exists, `text` is its entity-expanded form (top of handleInbound) — album captions keep their hidden URLs.
      ...(m?.caption != null ? { caption: text } : {}),
    }
  }

  private async handleInbound(ctx: Context, text: string, image: ImageSource | undefined, attachment?: AttachmentMeta,
    /** true when attachment/image were pulled off the replied-to message (replyAttachment) rather than the message itself — emits
     *  attachment_origin="reply" so the agent knows whose file this is. */
    attachmentFromReply = false): Promise<void> {
    const h = this.host!
    // Expand hidden-payload entities (text_link URLs etc. — see entities.ts) so the channel text is self-contained. Guarded by identity: only when the
    // text we were handed IS the message text/caption — synthetic strings like '(video note)' or joined album captions must never be sliced with offsets
    // that belong to a different string.
    if (text === ctx.message?.text) text = expandHiddenEntities(text, ctx.message.entities)
    else if (text === ctx.message?.caption) text = expandHiddenEntities(text, ctx.message.caption_entities)

    const result = this.gate(ctx)
    if (result.action === 'drop') return
    if (result.action === 'pair') {
      const lead = result.isResend ? 'Still pending' : 'Pairing required'
      // #16: show remaining validity so a stale code in scrollback is recognizably dead (30min TTL; expired codes are auto-pruned).
      const mins = pairingRemainingMin(result.expiresAt)
      await ctx.reply(`${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}\n\n(code expires in ~${mins} min)`)
      return
    }

    const access = result.access
    const from = ctx.from!
    const chat_id = String(ctx.chat!.id)
    const msgId = ctx.message?.message_id

    // Permission-reply intercept: if this looks like "yes xxxxx" for a pending permission request, emit the structured event instead of relaying as
    // chat. The sender is already gate()-approved at this point (non-allowlisted senders were dropped above), so we trust the reply.
    const permMatch = PERMISSION_REPLY_RE.exec(text)
    // WO-197: the message itself is handled here (never delivered as chat): its receipt goes to the end (handledHere)
    const self: SelfWho = { chat: chat_id, id: msgId, from: String(from.id) }
    if (permMatch) {
      await h.handledHere(self, 'permission', async () => {
        const reqId = permMatch[2]!.toLowerCase()
        const behavior = permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny'
        if (h.permissionAnswer(reqId, behavior, String(from.id), 'text') === 'gone') return
        if (msgId != null) void this.react(chat_id, msgId, behavior === 'allow' ? '✅' : '❌').catch(() => {})
      })
      return
    }

    // lanes-topics (item 2): the topic this message was typed in (lanes off: none, as before); its name as its creation message says it (a message typed
    // in a topic replies to the topic's creation service message: knowledge/topics-design.md A3)
    const inTopic = Lanes.LANES_ON ? h.topicOfMessage(ctx.message) : undefined
    if (inTopic != null) Lanes.noteTopicName(inTopic, (ctx.message as any)?.reply_to_message?.forum_topic_created?.name)
    const here: Lanes.TopicAsk = { chat: chat_id, topic: inTopic }

    // Typing indicator — signals "processing" until we reply (or ~5s elapses).
    void this.typing(chat_id, h.topicFields(here)).catch(() => {})
    // Ack reaction — lets the user know we're processing. Fire-and-forget. Telegram only accepts a fixed emoji whitelist — if the user configures
    // something outside that set the API rejects it and we swallow.
    if (access.ackReaction && msgId != null) void this.react(chat_id, msgId, access.ackReaction).catch(() => {})

    // Channel-bot TUI control plane (opt-in via CHANNEL_BOT_TMUX_SESSION env). Intercepts slash commands like /clear /restart /resume_list /resume <id>
    // and acts on the claude TUI directly (tmux send-keys / launchctl / pkill / wrapper-args-file + restart) — instead of forwarding the slash to claude
    // as ordinary chat content. WO-197: a slash text that either handles: its receipt goes to the end (handledHere); one neither knows goes on to the
    // session, delivered as any message
    const ownSlash = text.trim().startsWith('/') ? self : null
    if (isControlEnabled()) {
      const handled = await h.handledHere(ownSlash, 'command', () => handleControlSlash(text, h.httpPort,
        async (msg: string, opts?: ReplyOptions) => { await h.sendText(chat_id, msg, opts?.keyboard, here) }), x => x !== false)   // answered where it was typed
      if (handled) { this.log('info', `channel-bot-control handled slash: ${text.slice(0, 60)}`); return }
    }
    // Roamer control plane (ROAMER_MODE=1): /roam etc. handled inline. Non-slash text falls through to server.ts finishInbound, whose dispatch routes it
    // to the current roamer target's MCP session only (roamerResolveCurrentTargetMcpSession), not to every connected session.
    if (isRoamerEnabled()) {
      const handled = await h.handledHere(ownSlash, 'command', () => handleRoamerSlash(text, async (msg: string, opts?: ReplyOptions) => {
        await h.sendText(chat_id, msg, opts?.keyboard, here)
      }), x => x !== false)
      if (handled) { this.log('info', `roamer handled slash: ${text.slice(0, 60)}`); return }
    }

    // #2: a failed photo download used to vanish silently (no image_path, no marker, no file_id — the agent couldn't even tell a photo existed). Now the
    // failure is MARKED (image_error) and the photo's file_id survives as attachment_file_id so the agent can retry via download_attachment.
    let imagePath: string | undefined
    let imageError: string | undefined
    if (image) {
      try { imagePath = await image.download() } catch (err) {
        this.log('error', `photo download failed: ${err instanceof Error ? err.message : err}`)
        imageError = 'download failed'
      }
    }
    const voiceTranscript = await this.maybeTranscribeVoice(attachment)
    await h.finishInbound(this.inboundFacts(ctx, text, image, attachment, attachmentFromReply, voiceTranscript, inTopic), { imagePath, imageError })
  }

  private registerHandlers(): void {
    const bot = this.bot, h = this.host!
    const answer = (ctx: Context, o?: { text: string }) => ctx.answerCallbackQuery(o).catch(() => {})
    // Without this, any throw in a message handler stops polling permanently (grammy's default error handler calls bot.stop() and rethrows).
    bot.catch(err => { this.log('error', `handler error (polling continues): ${err.error}`) })

    // Track the latest update_id so the heartbeat log shows whether polling is actually receiving updates (vs alive but stuck).
    bot.use(async (ctx, next) => {
      if (ctx.update?.update_id) {
        this.lastUpdateId = ctx.update.update_id
        if (this.stopped) this.o.handover?.rememberPollOffset(this.lastUpdateId + 1)
      }
      // Minimal inbound trace (2026-08-23, Atlas's 2-of-3 album-documents loss): one line per update makes "did the update even arrive" a grep instead of
      // an argument. Never log content — ids and shape only.
      const m = ctx.update?.message
      if (m) {
        const kind = m.photo ? 'photo' : m.document ? 'document' : m.video ? 'video' : m.voice ? 'voice' : m.audio ? 'audio' : m.animation ? 'animation'
          : m.sticker ? 'sticker' : m.text != null ? 'text' : (m as any).rich_message ? 'rich' : 'other'
        // kind=other: the names of the message's fields (never their content), so an undelivered type can be told from a service message afterwards
        const shape = kind === 'other' ? ` keys=${Object.keys(m).filter(k => !['message_id', 'from', 'chat', 'date', 'message_thread_id', 'is_topic_message'].includes(k)).slice(0, 8).join(',')}` : ''
        this.log('info', `inbound u=${ctx.update.update_id} chat=${m.chat?.id} msg=${m.message_id} kind=${kind}${m.media_group_id ? ` mgid=${m.media_group_id}` : ''}${m.document?.file_name ? ` name=${h.safeName(m.document.file_name)}` : ''}${shape}`)
      }
      await next()
    })

    // Commands are DM-only. Responding in groups would: (1) leak pairing codes via /status to other group members, (2) confirm bot presence in
    // non-allowlisted groups, (3) spam channels the operator never approved. Silent drop matches the gate's behavior for unrecognized groups.
    bot.command('start', async ctx => { if (!this.dmCommandGate(ctx)) return; await ctx.reply(h.startText) })
    bot.command('help', async ctx => { if (!this.dmCommandGate(ctx)) return; await ctx.reply(h.helpText) })

    // 002k: /lanes and /main renew (lanes.ts), answered by the daemon, never forwarded to a session; registered only with lanes on (lanes off, /main and
    // /lanes are ordinary messages as in the fleet). lanes-topics (item 2): answered in the topic it was typed in, through the one topic decision
    if (Lanes.LANES_ON) {
      const replyWhereTyped = async (ctx: Context, text: string): Promise<void> => {
        const chat = String(ctx.chat!.id), tf = h.topicFields({ chat, topic: h.topicOfMessage(ctx.message) })
        const m = await ctx.reply(text, tf)
        h.sentIn(chat, [m?.message_id], tf)
      }
      bot.command('main', async ctx => {
        const gated = this.dmCommandGate(ctx)
        if (!gated || !gated.access.allowFrom.includes(gated.senderId)) return
        const sub = (ctx.message?.text ?? '').trim().split(/\s+/)[1] ?? ''
        if (sub !== 'renew') { await replyWhereTyped(ctx, '用法：/main renew（把主線換成新的 session，交接焦點卡與帳本）'); return }
        await replyWhereTyped(ctx, await Lanes.mainRenew(ctx.from?.username ?? gated.senderId))
      })
      bot.command('lanes', async ctx => {
        const gated = this.dmCommandGate(ctx)
        if (!gated || !gated.access.allowFrom.includes(gated.senderId)) return
        await replyWhereTyped(ctx, await Lanes.lanesCommand(ctx.message?.text ?? '/lanes', ctx.from?.username ?? gated.senderId))
      })
      // lanes-topics (item 2): a topic's name as its service messages say it (the bot's own createForumTopic, a rename); nothing is answered or routed
      bot.on(['message:forum_topic_created', 'message:forum_topic_edited'], ctx => {
        const m: any = ctx.message
        if (!h.loadAccess().allowFrom.includes(String(ctx.chat?.id))) return
        Lanes.noteTopicName(m?.message_thread_id, m?.forum_topic_created?.name ?? m?.forum_topic_edited?.name)
      })
    }

    bot.command('status', async ctx => {
      const gated = this.dmCommandGate(ctx)
      if (!gated) return
      const { access, senderId } = gated
      if (access.allowFrom.includes(senderId)) {
        // #8 (2026-07-10): grammy command middleware runs BEFORE message:text, so /status never reached handleControlSlash's daemon-status branch —
        // paired users in control mode only ever saw "Paired as X". The daemon + claude TUI health block is merged in here (pairedStatusText).
        await ctx.reply(await h.pairedStatusText(ctx.from!.username ? `@${ctx.from!.username}` : senderId))
        return
      }
      for (const [code, p] of Object.entries(access.pending)) {
        if (p.senderId === senderId) {
          await ctx.reply(`Pending pairing (code expires in ~${pairingRemainingMin(p.expiresAt)} min) — run in Claude Code:\n\n/telegram:access pair ${code}`)
          return
        }
      }
      await ctx.reply(`Not paired. Send me a message to get a pairing code.`)
    })

    // Inline buttons: the duty officer's questions, the startup pickers, the control plane's / roamer's pickers (resume: roam: model: effort:), and the
    // permission requests (perm:allow:<id>, perm:deny:<id>, perm:more:<id>). Security mirrors the text-reply path: allowFrom must contain the sender.
    bot.on('callback_query:data', async ctx => {
      const data = ctx.callbackQuery.data
      const senderId = String(ctx.from.id)
      // Duty officer question (WO-97): only the people this bot sends ops traffic to may answer it.
      if (isDutyCallback(data)) {
        const toast = await h.dutyTap(data, senderId, ctx.from.username ? `@${ctx.from.username}` : senderId)
        await answer(ctx, { text: toast == null ? 'Not authorized.' : toast.slice(0, 190) })
        return
      }
      const allowed = (): boolean => h.loadAccess().allowFrom.includes(senderId)
      if (data.startsWith('spick:')) {
        if (!allowed()) { await answer(ctx, { text: 'Not authorized.' }); return }
        const chatId = String(ctx.chat?.id ?? senderId)
        const cbm: any = ctx.callbackQuery.message           // lanes-topics: the answer goes where the button was
        try { await h.pickerTap(data, senderId, async (msg: string) => { await h.sendText(chatId, msg, undefined, { chat: chatId, topic: h.topicOfMessage(cbm), replyTo: cbm?.message_id }) }) }
        catch (err) { this.log('warn', `startup-picker callback failed: ${err instanceof Error ? err.message : err}`) }
        await answer(ctx)
        return
      }
      // resume: + roam: + model: + effort: buttons. In roamer mode, resume:/roam: go through the roamer handler (it knows how to drive the picker against
      // the dynamic current_target tmux); in channel-bot mode, resume:/model: go to channel-bot's handleCallbackData (fixed TMUX_SESSION): runControlCallback
      if (data.startsWith('resume:') || data.startsWith('roam:') || data.startsWith('model:') || data.startsWith('effort:')) {
        if (!allowed()) { await answer(ctx, { text: 'Not authorized.' }); return }
        const chatId = String(ctx.chat?.id ?? senderId)
        const cbm: any = ctx.callbackQuery.message           // lanes-topics: a tap on a picker is answered where the picker is
        const replyToTg = async (msg: string, opts?: ReplyOptions) => {
          await h.sendText(chatId, msg, opts?.keyboard, { chat: chatId, topic: h.topicOfMessage(cbm), replyTo: cbm?.message_id })
        }
        try { await h.runControlCallback(data, h.httpPort, replyToTg) }
        catch (err) { this.log('warn', `callback dispatch failed: ${err instanceof Error ? err.message : err}`) }
        await answer(ctx)
        return
      }
      const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(data)
      if (!m) { await answer(ctx); return }
      if (!allowed()) { await answer(ctx, { text: 'Not authorized.' }); return }
      const [, behavior, request_id] = m as unknown as [string, 'allow' | 'deny' | 'more', string]
      if (behavior === 'more') {
        const details = h.permissionDetails(request_id)
        if (!details) { await answer(ctx, { text: 'Details no longer available.' }); return }
        const { tool_name, description, input_preview } = details
        let prettyInput: string
        try { prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2) } catch { prettyInput = input_preview }
        const expanded = `🔐 Permission: ${tool_name}\n\n` + `tool_name: ${tool_name}\n` + `description: ${description}\n` + `input_preview:\n${prettyInput}`
        const keyboard = new InlineKeyboard().text('✅ Allow', `perm:allow:${request_id}`).text('❌ Deny', `perm:deny:${request_id}`)
        await ctx.editMessageText(expanded, { reply_markup: keyboard }).catch(() => {})
        const cm: any = ctx.callbackQuery.message                            // WO-176: that copy's text now (a press in Onsen edits it from here)
        h.permissionCopyText(request_id, String(cm?.chat?.id), cm?.message_id, expanded)
        await answer(ctx)
        return
      }
      // Route B: the permission answer goes back to the *specific* server that asked, not all sessions (server.ts permissionAnswer)
      if (h.permissionAnswer(request_id, behavior, senderId, 'button') === 'gone') {
        await answer(ctx, { text: '這個權限詢問已經不在了，沒有送出' })
        return
      }
      const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
      await answer(ctx, { text: label })
      // Replace buttons with the outcome so the same request can't be answered twice and the chat history shows what was chosen.
      const msg = ctx.callbackQuery.message
      if (msg && 'text' in msg && msg.text) await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
    })

    bot.on('message:text', async ctx => {
      // If this text (e.g. a reply that @mentions the bot) carries no file of its own but the message it replies to does, pull that attachment in — so
      // "reply to a file message + tag me" delivers the file, not just the text.
      const { attachment, image } = this.replyAttachment(ctx)
      await this.handleInbound(ctx, ctx.message.text, image, attachment, true)
    })
    bot.on('message:photo', async ctx => {
      const caption = ctx.message.caption ?? '(photo)'
      // Defer download until after the gate approves — any user can send photos, and we don't want to burn API quota or fill the inbox for dropped
      // messages. Largest size is last in the array.
      const photos = ctx.message.photo
      const best = photos[photos.length - 1]!
      await this.handleInbound(ctx, caption, { file_id: best.file_id, size: best.file_size, download: () => this.downloadPhoto(ctx, best), unique: best.file_unique_id })
    })
    // NOTE: registered BEFORE message:document — Telegram animation messages also carry a legacy `document` field, so the document handler would swallow them.
    bot.on('message:animation', async ctx => {
      const anim = ctx.message.animation
      await this.handleInbound(ctx, ctx.message.caption ?? '(animation)', undefined, { kind: 'animation', file_id: anim.file_id, size: anim.file_size, mime: anim.mime_type, name: h.safeName(anim.file_name) })
    })
    bot.on('message:document', async ctx => {
      const doc = ctx.message.document
      const name = h.safeName(doc.file_name)
      await this.handleInbound(ctx, ctx.message.caption ?? `(document: ${name ?? 'file'})`, undefined, { kind: 'document', file_id: doc.file_id, size: doc.file_size, mime: doc.mime_type, name })
    })
    bot.on('message:voice', async ctx => {
      const voice = ctx.message.voice
      await this.handleInbound(ctx, ctx.message.caption ?? '(voice message)', undefined, { kind: 'voice', file_id: voice.file_id, size: voice.file_size, mime: voice.mime_type })
    })
    bot.on('message:audio', async ctx => {
      const audio = ctx.message.audio
      const name = h.safeName(audio.file_name)
      await this.handleInbound(ctx, ctx.message.caption ?? `(audio: ${h.safeName(audio.title) ?? name ?? 'audio'})`, undefined, { kind: 'audio', file_id: audio.file_id, size: audio.file_size, mime: audio.mime_type, name })
    })
    bot.on('message:video', async ctx => {
      const video = ctx.message.video
      await this.handleInbound(ctx, ctx.message.caption ?? '(video)', undefined, { kind: 'video', file_id: video.file_id, size: video.file_size, mime: video.mime_type, name: h.safeName(video.file_name) })
    })
    bot.on('message:video_note', async ctx => {
      const vn = ctx.message.video_note
      await this.handleInbound(ctx, '(video note)', undefined, { kind: 'video_note', file_id: vn.file_id, size: vn.file_size })
    })
    bot.on('message:sticker', async ctx => {
      const sticker = ctx.message.sticker
      await this.handleInbound(ctx, `(sticker${sticker.emoji ? ` ${sticker.emoji}` : ''})`, undefined, { kind: 'sticker', file_id: sticker.file_id, size: sticker.file_size })
    })
    // Location / contact previously had NO handler — such messages were dropped silently (no gate, no ack, nothing reached the agent). Rendered as
    // text; no attachment (there is no file to download).
    bot.on('message:location', async ctx => {
      const loc = ctx.message.location
      const venue = (ctx.message as any).venue
      const venuePart = venue?.title ? ` — ${h.safeName(venue.title)}${venue.address ? `, ${h.safeName(venue.address)}` : ''}` : ''
      await this.handleInbound(ctx, `(location: ${loc.latitude}, ${loc.longitude}${venuePart})`, undefined)
    })
    bot.on('message:contact', async ctx => {
      const c = ctx.message.contact
      const name = h.safeName([c.first_name, c.last_name].filter(Boolean).join(' ')) || 'contact'
      await this.handleInbound(ctx, `(contact: ${name}, ${h.safeName(c.phone_number)})`, undefined)
    })
    // A message whose content is `rich_message` and nothing else (a formatted paste; a forwarded rich reply of a bot): no handler above matches it, and
    // until 1.35.3 it was dropped with one `kind=other` line (2026-11-17, Hestia #9758: Joey waited an hour). Delivered as its text, blocks flattened to
    // markdown (rich-inbound.ts); a block type this version does not know is named in the text.
    bot.on('message', async (ctx, next) => {
      const m = ctx.message as any
      if (!m?.rich_message || m.text != null || m.caption != null) return next()
      const { attachment, image } = this.replyAttachment(ctx)
      await this.handleInbound(ctx, richToMarkdown(m.rich_message) || '(rich message: nothing readable in it)', image, attachment, true)
    })
  }

  // Retry polling with backoff on any error. Previously only 409 was retried — a single ETIMEDOUT/ECONNRESET/DNS failure rejected bot.start(), the catch
  // returned, and polling stopped permanently while the process stayed alive. 2026-05-13 by Joey: the inner loop wrapped in an outer try/catch so a sync
  // throw in the IIFE itself gets logged and retried instead of silently terminating the loop.
  private stopped = false
  private pollTask?: Promise<void>
  private timers: ReturnType<typeof setInterval>[] = []
  private async pollLoop(): Promise<void> {
    const h = this.host!
    for (let attempt = 1; !this.stopped; attempt++) {
      try {
        await this.bot.start({
          onStart: info => {
            if (this.stopped) return
            attempt = 0
            this.botUsername = info.username
            this.log('info', `polling as @${info.username}`)
            if (Lanes.LANES_ON) void this.laneTopicsAtStart(info as unknown as Record<string, unknown>)
            // Baseline commands (everyone gets these). Channel-bot mode appends the TUI-control commands so /resume_list, /restart, etc. appear in
            // Telegram's autocomplete; roamer mode its own.
            const controlCommands = controlCommandsForBotApi()
            const roamerCommands = roamerCommandsForBotApi()
            if (controlCommands.length > 0) this.log('info', `channel-bot control mode ON: registering ${controlCommands.length} TUI-control slash commands`)
            if (roamerCommands.length > 0) this.log('info', `roamer mode ON: registering ${roamerCommands.length} roamer slash commands`)
            // Register to both default and all_private_chats scopes so the autocomplete shows up in DMs regardless of any BotFather-era placeholder
            // scope leftover. /clear first, /model second (Joey TG 7727)
            const menu = h.botMenu()
            void this.bot.api.setMyCommands(menu).catch(() => {})
            void this.bot.api.setMyCommands(menu, { scope: { type: 'all_private_chats' } }).catch(() => {})
          },
        })
        return // bot.stop() was called — clean exit from the loop
      } catch (err) {
        if (this.stopped || h.shuttingDown()) return
        // bot.stop() mid-setup rejects with grammy's "Aborted delay" — expected, not an error.
        if (err instanceof Error && err.message === 'Aborted delay') return
        const is409 = err instanceof GrammyError && err.error_code === 409
        // Route B: daemon is long-lived. 409 means another process is currently polling the same token. Wait patiently — the conflict could be a stale
        // process that will exit on its next restart. Never shutdown on 409; launchd would just relaunch and we'd loop.
        const delay = is409 ? Math.min(5000 + 5000 * Math.min(attempt, 6), 30000) : Math.min(1000 * attempt, 15000)
        const detail = is409 ? `409 Conflict${attempt === 1 ? ' — another instance is polling this token; waiting for it to release' : ''}` : `polling error: ${err}`
        this.log('warn', `${detail}, retrying in ${delay / 1000}s (attempt ${attempt})`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }

  /** the update handlers, the pairing confirmations and sweep, then the long poll (once) */
  start(host: RoamerHost): void {
    if (this.pollRunning) return
    this.host = host
    this.registerHandlers()
    if (!host.staticAccess) {
      this.timers.push(setInterval(() => this.checkApprovals(), 5000).unref())
      // #16: sweep expired pairing codes even when no message traffic triggers a gate() call — otherwise a dead code sits in access.json (and counts toward
      // the 3-pending cap) until the next inbound.
      this.timers.push(setInterval(() => {
        try {
          const a = host.readAccessFile()
          if (pruneExpired(a)) { host.saveAccess(a); this.log('info', 'pairing sweep: pruned expired pending code(s)') }
        } catch (err) { this.log('warn', `pairing sweep failed: ${err instanceof Error ? err.message : err}`) }
      }, PAIRING_PRUNE_INTERVAL_MS).unref())
    }
    this.startPoll(host)
    this.log('info', 'roamer (ROAMER_MODE=1): the Telegram long poll is started (roamer-telegram.ts); this daemon is not a connector')
  }

  private startPoll(host: RoamerHost): void {
    this.pollRunning = true
    this.pollTask = (async () => {
      while (!this.stopped && !host.shuttingDown()) {
        try {
          const pending = this.o.handover?.pollOffset
          if (pending != null) {
            await this.bot.api.getUpdates({ offset: pending, limit: 1 })
            if (this.stopped || host.shuttingDown()) break
            this.o.handover!.rememberPollOffset(null)
          }
          await this.pollLoop()
          break
        } catch (err) {
          this.log('error', `pollLoop crashed unexpectedly: ${err} — restarting in 5s`)
          await new Promise(r => setTimeout(r, 5000))
        }
      }
      this.pollRunning = false
      this.botUsername = ''
    })()
  }

  /** bot.stop() signals the poll loop to end; the current getUpdates request may take up to its long-poll timeout to return */
  async stop(drain = false): Promise<void> {
    if (!drain) return this.bot.stop()
    const checkpoint = this.o.handover!
    const offset = checkpoint.pollOffset ?? this.lastUpdateId + 1
    checkpoint.rememberPollOffset(offset)
    this.stopped = true
    try {
      const running = this.bot.isRunning()
      try { if (running) await this.bot.stop() }
      finally { await this.pollTask }
      // grammy sends its last offset before an in-flight batch finishes. Confirm any later update,
      // or the saved offset when resuming a drain after a process restart.
      if (!running || checkpoint.pollOffset !== offset)
        await this.bot.api.getUpdates({ offset: checkpoint.pollOffset!, limit: 1 })
    } catch (err) {
      this.stopped = false
      if (this.host && !this.host.shuttingDown()) this.startPoll(this.host)
      throw err
    }
    for (const timer of this.timers) clearInterval(timer)
  }
}
