// tg-format.ts: how a message looks on Telegram, so the bridge draws what the daemon draws today (WO-196 part B 「Telegram 上看到的跟現在一樣」).
// Ported from server.ts 1.58.21 (not importable; see tg-access.ts): chunk 520-539, the label line of a lane / system message laneLabelMd +
// laneLineParts 690-699, the text send sendTextParts 641-685 (Rich Message first, plain sendMessage when the rich one fails for any reason but
// a timeout), safeName / metaExcerpt / mediaKindLabel / displayName 3637-3669.
import { TgError, TgTimeout, type Tg } from './tg.ts'

export const MAX_CHUNK_LIMIT = 4096

/** server.ts chunk(): Telegram caps a message at 4096 characters; newline mode cuts at a paragraph, then a line, then a space */
export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

/** server.ts laneLabelMd: the label's GFM characters escaped */
export const labelMd = (label: string): string => label.replace(/[\\`*_~[\]<>|]/g, '\\$&')
/** server.ts laneLineParts: the label (author_label: 〔agent·工作線#2〕, a system sender) as the first line of the first part; rich: its own paragraph */
export function labelParts(label: string | null, body: string, limit: number, useRich: boolean, mode: 'length' | 'newline' = useRich ? 'newline' : 'length'): { rich: string[]; plain: string[] } {
  const room = Math.max(1, limit - (label ? [...label].length + 2 : 0))
  const chunks = chunk(body, room, mode)
  if (!chunks.length) chunks.push('')
  return {
    rich: chunks.map((c, i) => i === 0 && label ? `${labelMd(label)}\n\n${c}` : c),
    plain: chunks.map((c, i) => i === 0 && label ? `${label}\n${c}` : c),
  }
}

const SAFE_CHAR_MAP: Record<string, string> = { '<': '＜', '>': '＞', '[': '［', ']': '］', ';': '；', '\r': ' ', '\n': ' ' }
export const safeName = (s: string | undefined): string | undefined => s?.replace(/[<>\[\]\r\n;]/g, ch => SAFE_CHAR_MAP[ch] ?? '_')
export function metaExcerpt(s: string, cap = 200): string {
  const t = safeName(s.replace(/\s+/g, ' ').trim()) ?? ''
  return t.length > cap ? t.slice(0, cap - 1) + '…' : t
}
export function displayName(u: { username?: string; first_name?: string; last_name?: string; id: number | string }): string {
  return safeName(u.username ?? [u.first_name, u.last_name].filter(Boolean).join(' ')) || String(u.id)
}
export function mediaKindLabel(m: any): string | undefined {
  if (m.photo) return '(photo)'
  if (m.document) return `(document: ${safeName(m.document.file_name) ?? 'file'})`
  if (m.video) return '(video)'
  if (m.audio) return '(audio)'
  if (m.voice) return '(voice message)'
  if (m.video_note) return '(video note)'
  if (m.sticker) return '(sticker)'
  if (m.animation) return '(animation)'
  if (m.location) return '(location)'
  if (m.contact) return '(contact)'
  return undefined
}

/** Telegram's reply_markup for an inline keyboard: rows of {text, callback_data} or {text, url} */
export type Button = { text: string; callback_data?: string; url?: string }

/** server.ts sendTextParts: each part as a Rich Message when `useRich`, else (or when the rich send fails, a timeout excepted: it may have been
 *  delivered) a plain sendMessage. reply_parameters on the first part (every part with replyAll); silent, the topic and the keyboard (last part)
 *  as given. Returns the ids sent; `sent` (when given) collects them as they go, so a failure part-way says what went out. Throws on a failure. */
export async function sendTextParts(tg: Tg, chat: string, parts: { rich: string[]; plain: string[] }, o: {
  useRich: boolean; silent?: boolean; threadId?: number | null; replyTo?: number | null; replyAll?: boolean; keyboard?: Button[][]
  sent?: number[]; startAt?: number
}): Promise<number[]> {
  const ids = o.sent ?? []
  const n = parts.plain.length
  for (let i = o.startAt ?? 0; i < n; i++) {
    const common: Record<string, unknown> = {
      chat_id: chat,
      ...(o.replyTo != null && (o.replyAll || i === 0) ? { reply_parameters: { message_id: o.replyTo, allow_sending_without_reply: true } } : {}),
      ...(o.silent ? { disable_notification: true } : {}),
      ...(o.threadId != null ? { message_thread_id: o.threadId } : {}),
      ...(o.keyboard && i === n - 1 ? { reply_markup: { inline_keyboard: o.keyboard } } : {}),
    }
    if (o.useRich) {
      try {
        const r = await tg.call('sendRichMessage', { ...common, rich_message: { markdown: parts.rich[i] } })
        ids.push(Number(r.message_id))
        continue
      } catch (e) {
        if (e instanceof TgTimeout) throw e
        if (e instanceof TgError && e.code === 429) throw e          // flood control: the plain one would be refused too; the caller waits
      }
    }
    const r = await tg.call('sendMessage', { ...common, text: parts.plain[i] })
    ids.push(Number(r.message_id))
  }
  return ids
}

/** an edit of one message: rich first (editMessageText rich_message), plain when that fails (server.ts edit_message 2742-2770). `keyboard`: undefined
 *  leaves the buttons as they are, null or [] takes them away */
export async function editText(tg: Tg, chat: string, id: number, text: { rich: string; plain: string }, useRich: boolean, keyboard?: Button[][] | null): Promise<void> {
  const markup = keyboard === undefined ? {} : { reply_markup: { inline_keyboard: keyboard ?? [] } }
  if (useRich) {
    try { await tg.call('editMessageText', { chat_id: chat, message_id: id, rich_message: { markdown: text.rich }, ...markup }); return } catch (e) {
      if (e instanceof TgTimeout) throw e
      if (e instanceof TgError && /message is not modified/i.test(e.description)) return
    }
  }
  try { await tg.call('editMessageText', { chat_id: chat, message_id: id, text: text.plain, ...markup }) } catch (e) {
    if (e instanceof TgError && /message is not modified/i.test(e.description)) return
    throw e
  }
}

export const isRich = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const v = (env.TELEGRAM_RICH_MESSAGES ?? '').trim().toLowerCase()
  return v !== '0' && v !== 'off' && v !== 'false' && v !== 'no'
}
