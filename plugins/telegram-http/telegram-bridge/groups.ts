import { createHash } from 'node:crypto'
import type { Agent } from './agent.ts'

function isGroup(chat: { type?: string } | undefined): boolean {
  return chat?.type === 'group' || chat?.type === 'supergroup'
}

/** The suffix of the write key and of the once-per-message outage notice. Telegram numbers in basic groups are bot-local. */
export function messageKey(member: string, m: any): string {
  const chat = String(m.chat.id)
  if (!isGroup(m.chat)) return `${member}:${chat}:${m.message_id}`
  if (chat.startsWith('-100')) return `${chat}:${m.message_id}`
  const hash = createHash('sha256').update(m.text ?? m.caption ?? '').digest('hex').slice(0, 16)
  return `${chat}:${m.from.id}:${m.date}:${hash}`
}

export function mentionedMembers(m: any, agents: Iterable<Agent>): string[] {
  const bots = [...agents].filter(a => a.accepted && a.state !== 'conflict' && a.username)
  const text: string = m.text ?? m.caption ?? ''
  const names = new Set<string>()
  for (const e of (m.text != null ? m.entities : m.caption_entities) ?? []) {
    let bot: Agent | undefined
    if (e.type === 'mention') {
      const tag = text.slice(e.offset, e.offset + e.length).toLowerCase()
      bot = bots.find(a => tag === '@' + a.username.toLowerCase())
    } else if (e.type === 'text_mention') {
      bot = bots.find(a => a.botId === String(e.user?.id))
    }
    if (bot) names.add(bot.member)
  }
  for (const bot of bots) {
    if (!text || names.has(bot.member)) continue
    for (const pattern of bot.access()?.mentionPatterns ?? []) {
      try { if (new RegExp(pattern, 'i').test(text)) { names.add(bot.member); break } } catch {}
    }
  }
  return [...names]
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
  const m = u.message
  if (isGroup(m?.chat) && m.migrate_to_chat_id != null)
    return { kind: 'migration', path: `/bridge/chats/${m.chat.id}`, body: { moved_to: String(m.migrate_to_chat_id) } }
  const cm = u.my_chat_member
  if (!isGroup(cm?.chat) || String(cm.new_chat_member?.user?.id) !== a.botId) return
  const state = membership(cm.new_chat_member)
  if (!state || state === membership(cm.old_chat_member)) return
  return { kind: 'membership', path: `/bridge/chats/${cm.chat.id}/members/${encodeURIComponent(a.member)}`,
    body: { state, at: new Date(cm.date * 1000).toISOString() } }
}
