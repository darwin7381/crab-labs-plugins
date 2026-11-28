import { createHash } from 'node:crypto'
import { expandHiddenEntities, telegramCommand } from '../entities.ts'
import { richText } from '../rich-inbound.ts'
import type { Agent } from './agent.ts'

export function isGroup(chat: { type?: string } | undefined): boolean {
  return chat?.type === 'group' || chat?.type === 'supergroup'
}

/** Rich blocks can contain nested files. Keep the content and stable file identity in a deterministic order. */
function richContent(value: any): unknown {
  if (Array.isArray(value)) {
    const parts: unknown[] = []
    for (const entry of value) {
      const part = richContent(entry), last = parts.at(-1)
      if (typeof last === 'string' && typeof part === 'string') parts[parts.length - 1] = last + part
      else parts.push(part)
    }
    return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : parts
  }
  if (value == null || typeof value !== 'object') return value
  if (value.type === 'mention' || value.type === 'text_mention' || value.type === 'bot_command') return richText(value)
  if (value.file_unique_id) return { file_unique_id: value.file_unique_id }
  return Object.fromEntries(Object.keys(value).filter(k => k !== 'file_id').sort().map(k => [k, richContent(value[k])]))
}

/** Only facts shared by the receiving bots belong here. Telegram's file_id and basic-group message_id are bot-local. */
function basicGroupHash(m: any): string {
  const text = m.text ?? m.caption ?? ''
  const hash = createHash('sha256').update(text)
  const details: Record<string, unknown> = {}
  // The second bot can contribute mentions the first did not see on this same message.
  const entities = m.text != null ? m.entities : m.caption_entities
  const expanded = expandHiddenEntities(text, entities?.filter((e: { type: string }) => e.type === 'text_link'))
  if (expanded !== text) details.expanded = expanded
  if (m.rich_message) details.rich = richContent(m.rich_message)
  if (m.media_group_id != null) details.album = m.media_group_id
  if (m.photo?.length) details.photo = m.photo.map((p: any) => p.file_unique_id).filter(Boolean).sort()
  for (const kind of ['animation', 'audio', 'document', 'sticker', 'video', 'video_note', 'voice']) {
    if (m[kind]?.file_unique_id) details[kind] = m[kind].file_unique_id
  }
  const origin = m.forward_origin
  if (origin || m.forward_date) details.forward = [origin?.date ?? m.forward_date,
    origin?.sender_user?.id ?? m.forward_from?.id, origin?.chat?.id ?? origin?.sender_chat?.id ?? m.forward_from_chat?.id,
    origin?.message_id ?? m.forward_from_message_id, origin?.sender_user_name ?? m.forward_sender_name, origin?.author_signature ?? m.forward_signature]
  if (m.location) details.location = [m.location.latitude, m.location.longitude, m.venue?.title, m.venue?.address]
  if (m.contact) details.contact = [m.contact.phone_number, m.contact.user_id, m.contact.first_name, m.contact.last_name, m.contact.vcard]
  // 0xff cannot occur in UTF-8 text. Existing text-only keys retain their original hash.
  if (Object.keys(details).length) hash.update(Buffer.from([0xff])).update(JSON.stringify(details))
  return hash.digest('hex').slice(0, 16)
}

/** The suffix of the write key and of the once-per-message outage notice. Telegram numbers in basic groups are bot-local. */
export function messageKey(member: string, m: any): string {
  const chat = String(m.chat.id)
  if (!isGroup(m.chat)) return `${member}:${chat}:${m.message_id}`
  if (chat.startsWith('-100')) return `${chat}:${m.message_id}`
  return `${chat}:${m.from.id}:${m.date}:${basicGroupHash(m)}`
}

/** Classic entities carry offsets into the message. Rich text nodes carry their target or label directly. */
function mentionAccount(entity: any, label?: string): string | undefined {
  if (entity.type === 'mention') return entity.username ? '@' + entity.username : label ?? richText(entity.text)
  if (entity.type === 'text_mention') {
    if (entity.user?.username) return '@' + entity.user.username
    const id = entity.user?.id ?? entity.user_id
    if (id != null) return String(id)
  }
  if (entity.type === 'bot_command') {
    const target = telegramCommand(entity.bot_command ?? label ?? richText(entity.text))?.target
    if (target) return '@' + target
  }
}

function collectRichMentions(node: any, accounts: string[]): void {
  if (!node || typeof node !== 'object') return
  const account = mentionAccount(node)
  if (account) accounts.push(account)
  for (const child of Object.values(node)) collectRichMentions(child, accounts)
}

/** Send the Telegram account references in order. Onsen resolves them against every bridge's endpoints. */
export function telegramMentions(m: any, agents: Iterable<Agent> = []): string[] {
  const text: string = m.text ?? m.caption ?? ''
  const accounts: string[] = []
  for (const e of (m.text != null ? m.entities : m.caption_entities) ?? []) {
    const account = mentionAccount(e, text.slice(e.offset, e.offset + e.length))
    if (account) accounts.push(account)
  }
  collectRichMentions(m.rich_message?.blocks, accounts)
  if (!text) return accounts
  const explicit = new Set(accounts.map(account => account.toLowerCase()))
  for (const bot of agents) {
    if (!bot.accepted || bot.state === 'conflict' || !bot.username) continue
    const account = '@' + bot.username
    if (explicit.has(account.toLowerCase()) || explicit.has(bot.botId)) continue
    for (const pattern of bot.access()?.mentionPatterns ?? []) {
      try {
        if (new RegExp(pattern, 'i').test(text)) { accounts.push(account); break }
      } catch { /* Ignore an invalid access.json pattern and try the next one. */ }
    }
  }
  return accounts
}

type ChatWrite = { kind: 'membership' | 'migration'; path: string; body: { state: 'in' | 'left'; at: string } | { moved_to: string } }
function membership(member: any): 'in' | 'left' | undefined {
  switch (member?.status) {
    case 'creator': case 'administrator': case 'member': return 'in'
    case 'restricted': return member.is_member ? 'in' : 'left'
    case 'left': case 'kicked': return 'left'
  }
}

/** Only Telegram service updates change the chat itself. They use the same ordered writer as messages. */
export function chatWrite(a: Agent, u: any): ChatWrite | undefined {
  const cm = u.my_chat_member
  const chat = (cm ?? u.message)?.chat
  if (!isGroup(chat)) return
  const access = a.access()
  if (!access || access.dmPolicy === 'disabled' || !access.groups?.[String(chat.id)]) return
  if (!cm && u.message.migrate_to_chat_id != null)
    return { kind: 'migration', path: `/bridge/chats/${chat.id}`, body: { moved_to: String(u.message.migrate_to_chat_id) } }
  if (String(cm?.new_chat_member?.user?.id) !== a.botId) return
  const state = membership(cm.new_chat_member)
  if (!state || state === membership(cm.old_chat_member)) return
  return { kind: 'membership', path: `/bridge/chats/${cm.chat.id}/members/${encodeURIComponent(a.member)}`,
    body: { state, at: new Date(cm.date * 1000).toISOString() } }
}
