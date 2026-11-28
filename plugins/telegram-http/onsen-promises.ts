import { memberOfTg } from './onsen-client.ts'
import { MEMBER_CHAT } from './onsen-connector.ts'
import { promiseSentences } from './lanes-followup.ts'
import { parseLocal } from './lanes-digest.ts'
import type { Ob } from './lanes-events.ts'
import { ownItem, type ItemWriter } from './onsen-item-writes.ts'
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

/** Extract a time from the clause that promises delivery. The optional by field is an explicit tool argument. */
export function promiseTime(words: string, at: number, by?: string): number | null {
  if (by && by !== '未說明') return timeInPhrase(by, at)
  // A comma can separate a time adjunct from its promise, e.g. 「10 分鐘後，我會回報」.
  const phrases = words.replace(/(\d+(?:\.\d+)?\s*(?:分鐘|小時|天)\s*(?:以內|之後|內|後))\s*[，,]\s*(?=我(?:們)?[會將]|回報|給你)/g, '$1 ')
  for (const clause of phrases.split(/[，,。；;！？!?\n]+|\.\s+/)) {
    // A bare time attached to the action also occurs in terse tool/receipt text (「10 分鐘後回圖」).
    if (!promiseSentences(clause).length && !/(?:分鐘|小時|天)(?:內|後)\s*(?:再|回|給|交|寄|查)|(?:點|時|:\d\d)(?:半|\d+分)?\s*(?:前|回|給|交|寄)/.test(clause)) continue
    const due = timeInPhrase(clause, at)
    if (due != null) return due
  }
  return null
}

function timeInPhrase(words: string, at: number): number | null {
  const stamp = words.match(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)?/i)
  if (stamp) { const ms = parseLocal(stamp[0]); return ms >= at ? ms : null }
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
  const due = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, hour - 8, minute)
  if (due >= at) return due
  if (weekday) return due + 7 * 86400_000
  return clock[1] ? null : due + 86400_000
}

export function resumablePromise(o: Ob, now: number): boolean {
  if (o.self) return o.state === 'met' && !o.self.complete
  return o.level === 'commitment' && o.state === 'open' && !!memberWaiter(o.to)
    && !o.told && !o.rang && o.due_at != null && o.due_at >= now
}

/** Called at the M3 journal transition. The writer resolves completion to the original Item id after restart. */
export function projectPromises(eventId: string, obs: Ob[], writer: ItemWriter, refs: ItemRef[] = [], previous: Ob[] = []): void {
  for (const o of obs) {
    if (o.self) {
      if (o.state === 'met' && !o.self.complete) {
        o.self = { ...o.self, complete: true }
        writer(o.self)
      }
      continue
    }
    const waiter = memberWaiter(o.to)
    if (!waiter || o.due_at == null || (o.state !== 'open' && o.state !== 'handed')) continue
    const commitment = o.level === 'commitment'
    if (commitment) {
      if (!resumablePromise(o, Date.now())) continue
    } else {
      if (o.level !== 'answer' || o.told || o.rang || (refs.length && !o.sent)) continue
      // Only a new or changed answer is a live hand-off. Editing a pull-era journal entry must not publish old answers.
      const old = previous.find(p => p.id === o.id)
      if (old?.level === 'answer' && old.state === o.state && old.due_at === o.due_at && old.sent === o.sent && old.to === o.to) continue
    }
    const session = commitment ? o.owner ?? 'main' : 'main'
    const due = o.due_at ?? null
    o.self = { key: 'promise:' + eventId + ':' + o.id, item: ownItem('self', session,
      `請向 ${waiter} 回報：${o.what ?? ''}（${eventId}）`, due, waiter, commitment && (o.by === 'promise-check' || session !== 'main') ? null : due,
      refs.map(r => ({ kind: 'item', value: r.onsen_item_id }))) }
    writer(o.self)
  }
}
