// state.ts: what telegram-bridge keeps across a restart, one JSON file per machine (<state dir>/state.json, default ~/.local/state/telegram-bridge).
// Written atomically (tmp, rename), at most every 500 ms while something changed, and at once at the end of every feed batch and at stop.
//
//   feed      the feed cursor (`after`, the last `next` taken) and the seqs of the batch being drawn that are done (a restart in the middle of a
//             batch draws the rest, not the done ones again)
//   accepted  the members Onsen's endpoint list last took from this bridge (at start, with Onsen not answering, these bots are polled again:
//             the Onsen-down sentence still reaches the person)
//   sent      Onsen message id → the Telegram messages it became (text parts, files, the label): an edit finds its parts, a resend skips them
//   actions   Action id → its Telegram messages and text (action_resolved swaps the buttons for the outcome); keys: a button's short key → the
//             Action and option it answers (Telegram allows 64 bytes of callback data)
//   retries   feed `message` items whose send failed, waiting for their next try (10 s, 30 s, 2 min; a 429's retry_after)
//   reports   delivery reports Onsen did not take yet (sent again every 10 s)
//   sorry     the messages that got the Onsen-down sentence (once each, across restarts)
//   topics    a Telegram topic and its Onsen thread, shared by the bots of a group
//   lines     stage two: a restart line → its message with the lift button (member:line id)
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type SentRec = { member: string; chat: string; text: number[]; files: number[]; label: string | null; at: number }
export type ActionRec = { member: string; chat: string; msgs: number[]; text: string; at: number; done?: boolean }
export type KeyRec = { member: string; action: string; option: string; label: string; at: number }
export type Progress = { text: number[]; files: number[] }
export type RetryRec = { item: any; attempt: number; due: number; progress: Progress; lastError: string }
export type ReportRec = { message_id: string; body: Record<string, unknown>; tries: number; due: number }
export type TopicRec = { member: string; chat: string; thread: string | null; client_thread: string; name: string; state: string; at: number }
/** Telegram group chats are shared. A person's positive chat number identifies a different DM at each bot. */
export function chatScope(member: string, chat: string): string { return chat.startsWith('-') ? chat : `${member}:${chat}` }
export function topicKey(t: Pick<TopicRec, 'member' | 'chat' | 'thread' | 'client_thread'>): string {
  return `${chatScope(t.member, t.chat)}:${t.client_thread || 'thread:' + t.thread}`
}
export type LineRec = { member: string; chat: string; msg: number; lift_until: number | null; lifted: boolean; at: number; id: string; pressed?: boolean }

/** WO-199: the ⚠️ line a bridge put under a person's message blocked by a usage limit (removed once the message is taken in again) */
export type BlockedRec = { member: string; chat: string; msg: number; at: number; gone?: boolean; tries?: number }

export type StateData = {
  feed: { after: string | null; drawn: string[] }
  accepted: string[]
  sent: Record<string, SentRec>
  actions: Record<string, ActionRec>
  keys: Record<string, KeyRec>
  keySeq: number
  retries: RetryRec[]
  reports: ReportRec[]
  sorry: Record<string, number>
  topics: Record<string, TopicRec>
  lines: Record<string, LineRec>
  blocked: Record<string, BlockedRec>
}
const empty = (): StateData => ({ feed: { after: null, drawn: [] }, accepted: [], sent: {}, actions: {}, keys: {}, keySeq: 0, retries: [], reports: [], sorry: {}, topics: {}, lines: {}, blocked: {} })

/** keep the newest `max` of a record keyed map (by .at) */
function trim<T extends { at: number }>(m: Record<string, T>, max: number): void {
  const ks = Object.keys(m)
  if (ks.length <= max) return
  ks.sort((a, b) => m[a]!.at - m[b]!.at)
  for (const k of ks.slice(0, ks.length - max)) delete m[k]
}

export class StateStore {
  readonly file: string
  data: StateData
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(readonly dir: string, private log: (l: string, m: string) => void = () => {}) {
    this.file = join(dir, 'state.json')
    this.data = empty()
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8'))
      if (j && typeof j === 'object') this.data = { ...empty(), ...j, feed: { ...empty().feed, ...(j.feed ?? {}) } }
      // Older bridges stored member:chat:thread. When two bots knew the same topic keep its newest record.
      const topics = Object.entries(this.data.topics)
      if (topics.some(([key, t]) => key !== topicKey(t))) {
        this.data.topics = {}
        for (const [, t] of topics.sort((a, b) => a[1].at - b[1].at)) this.data.topics[topicKey(t)] = t
        this.dirty()
      }
    } catch {}
  }
  /** something changed: written within 500 ms */
  dirty(): void {
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, 500)
    ;(this.timer as any).unref?.()
  }
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    const d = this.data
    trim(d.sent, 3000); trim(d.actions, 1000); trim(d.keys, 3000); trim(d.topics, 2000); trim(d.lines, 500); trim(d.blocked ?? {}, 500)
    const sk = Object.keys(d.sorry)
    if (sk.length > 2000) { sk.sort((a, b) => d.sorry[a]! - d.sorry[b]!); for (const k of sk.slice(0, sk.length - 2000)) delete d.sorry[k] }
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (e) { this.log('warn', `state: could not write ${this.file} (${(e as Error).message})`) }
  }
}
