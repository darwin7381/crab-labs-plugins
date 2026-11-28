import { memberOfTg } from './onsen-client.ts'
import { MEMBER_CHAT } from './onsen-connector.ts'
import { parseLocal } from './lanes-digest.ts'
import type { Ob } from './lanes-events.ts'
import { ownItem, type SelfWriter } from './onsen-self.ts'
import type { ItemRef } from './onsen-items.ts'

export function memberWaiter(value: unknown): string | undefined {
  const name = String(value ?? '').trim().toLowerCase()
  if (/^\d+$/.test(name)) return memberOfTg(name) ?? 'tg-' + name
  return MEMBER_CHAT.exec(name.startsWith('member:') ? name : 'member:' + name)?.[1]
}

/** A DM identifies its recipient even when this reply concerns no inbound event. In a group the quoted sender identifies them. */
export function chatWaiter(chat: unknown, origins: ItemRef[] = []): string | undefined {
  const id = String(chat ?? '')
  const direct = MEMBER_CHAT.exec(id)?.[1] ?? memberOfTg(id) ?? (/^\d+$/.test(id) ? 'tg-' + id : undefined)
  if (direct) return direct
  const senders = new Set(origins.filter(r => r.kind === 'message').map(r => r.from))
  return senders.size === 1 ? [...senders][0] : undefined
}

/** Only set the deadline when the words give a time. Jev's deadline *probability* is never a timestamp. */
export function promiseTime(words: string, at: number): number | null {
  const stamp = words.match(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)?/i)
  if (stamp) { const ms = parseLocal(stamp[0]); return Number.isFinite(ms) ? ms : null }
  const relative = words.match(/(\d+(?:\.\d+)?)\s*(分鐘|小時|天)\s*(?:以內|之後|內|後)/)
    ?? words.match(/\b(?:in|within)\s+(\d+(?:\.\d+)?)\s+(minutes?|hours?|days?)\b/i)
  if (relative) {
    const unit = relative[2]!.toLowerCase()
    const minutes = /^(小時|hour)/.test(unit) ? 60 : /^(天|day)/.test(unit) ? 1440 : 1
    return at + Number(relative[1]) * minutes * 60_000
  }
  const clock = words.match(/(?<!第\s*)(?<!\d)(今天|明天|後天|明早|今晚|(?:星期|週)[日一二三四五六])?\s*(凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2})\s*(?::(\d{2})|[點時](?:(\d{1,2})分|(半))?)(?!\d)/)
  if (!clock) return null
  const local = new Date(at + 8 * 3600_000)
  const weekday = /^(?:星期|週)(.)$/.exec(clock[1] ?? '')
  const day = weekday ? ('日一二三四五六'.indexOf(weekday[1]!) - local.getUTCDay() + 7) % 7
    : clock[1] === '後天' ? 2 : clock[1] === '明天' || clock[1] === '明早' ? 1 : 0
  let hour = Number(clock[3])
  if (hour < 12 && (clock[1] === '今晚' || /中午|下午|晚上/.test(clock[2] ?? ''))) hour += 12
  if (hour === 12 && /凌晨|上午/.test(clock[2] ?? '')) hour = 0
  const minute = clock[6] ? 30 : Number(clock[4] ?? clock[5] ?? 0)
  if (hour > 23 || minute > 59) return null
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, hour - 8, minute)
}

/** Called at the M3 journal transition. The same saved creation request identifies early completion after restart. */
export function projectPromises(eventId: string, obs: Ob[], writer: SelfWriter, refs: ItemRef[] = []): void {
  for (const o of obs) {
    if (o.self) {
      if (o.state === 'met' && !o.self.complete) {
        o.self = { ...o.self, complete: true }
        writer(o.self)
      }
      continue
    }
    const waiter = memberWaiter(o.to)
    if (!waiter || (o.state !== 'open' && o.state !== 'handed')) continue
    const commitment = o.level === 'commitment'
    if (!commitment && !(o.level === 'answer' && o.due_at != null && (!refs.length || o.sent))) continue
    const session = commitment ? o.owner ?? 'main' : 'main'
    const due = o.due_at ?? null
    o.self = { key: 'promise:' + eventId + ':' + o.id, item: ownItem('self', session,
      `請向 ${waiter} 回報：${o.what ?? ''}（${eventId}）`, due, waiter, due,
      refs.map(r => ({ kind: 'item', value: r.onsen_item_id }))) }
    writer(o.self)
  }
}
