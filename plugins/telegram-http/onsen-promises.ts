import { memberOfTg } from './onsen-client.ts'
import { MEMBER_CHAT } from './onsen-connector.ts'
import { parseLocal } from './lanes-digest.ts'
import type { Ob } from './lanes-events.ts'
import { ownItem, type SelfWriter } from './onsen-self.ts'
import type { ItemRef } from './onsen-items.ts'

/** A DM identifies its recipient even when this reply concerns no inbound event. In a group the quoted sender identifies them. */
export function chatWaiter(chat: unknown, origin?: ItemRef): string | undefined {
  const id = String(chat ?? '')
  return MEMBER_CHAT.exec(id)?.[1] ?? memberOfTg(id) ?? (origin?.kind === 'message' ? origin.from : undefined)
    ?? (/^\d+$/.test(id) ? 'tg-' + id : undefined)
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
  const clock = words.match(/(?:(今天|明天|後天)\s*)?(?<!第\s*)(\d{1,2})\s*(?::(\d{2})|點(?:(\d{1,2})分)?)\s*(?:前|回報|回覆|$)/)
  if (!clock) return null
  const local = new Date(at + 8 * 3600_000)
  const day = clock[1] === '明天' ? 1 : clock[1] === '後天' ? 2 : 0
  const hour = Number(clock[2]), minute = Number(clock[3] ?? clock[4] ?? 0)
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
    if (!o.to || (o.state !== 'open' && o.state !== 'handed')) continue
    const commitment = o.level === 'commitment'
    if (!commitment && !(o.level === 'answer' && o.due_at != null && (!refs.length || o.sent))) continue
    const session = commitment ? o.owner ?? 'main' : 'main'
    const due = o.due_at ?? null
    o.self = { key: 'promise:' + eventId + ':' + o.id, item: ownItem('self', session,
      `答應 ${o.to}：${o.what ?? ''}（${eventId}）`, due, o.to.toLowerCase(), due,
      refs.map(r => ({ kind: 'item', value: r.onsen_item_id }))) }
    writer(o.self)
  }
}
