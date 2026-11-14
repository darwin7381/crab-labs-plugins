/**
 * Universe 002c (lineage 002b): lane follow-ups and commitments. Pure helpers; the daemon wiring is in lanes.ts.
 *
 * followup(after_minutes, note): a lane that must wait (a runbook says "act only if it lasts 5 minutes") does not
 * just end. It schedules a follow-up; at that SIMULATED time the router starts a follow-up lane on the same thread
 * (same conversation: it resumes the thread's lane session). Same lane cap, same ban on irreversible actions.
 *
 * commitment: when a lane promises something to someone it is recorded as its own ledger kind `commitment`
 * (who, what, by when): by the lane's own commitment(...) call, or, if the lane only wrote it in its closing receipt
 * (`promised`), derived from that receipt.
 */
import { isNone } from './lanes-digest.ts'

export const FOLLOWUP_MIN_MINUTES = 1
export const FOLLOWUP_MAX_MINUTES = 240
export const FOLLOWUP_MAX_PER_THREAD = 3

export type Followup = {
  id: string; thread: string; lane: string; event: string; run_id: string | null
  trigger: string; cls: string; from: string
  after_minutes: number; note: string; created: string; due: number; due_iso: string
  state: 'pending' | 'fired'; fired?: string; fired_event?: string
}

/** Simulated wall time as "YYYY-MM-DD HH:MM" in the lab's zone (UTC+8). */
export function simTime(ms: number): string {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms))
  const g = (t: string) => p.find(x => x.type === t)?.value ?? ''
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`
}

export function runIdOfText(text: string): string | null {
  const m = /\[run:(\d+)\]/.exec(text ?? '')
  return m ? m[1] : null
}

export function checkFollowupArgs(a: unknown, pendingInThread: number): { ok: true; after: number; note: string } | { ok: false; error: string } {
  const o = (a ?? {}) as Record<string, unknown>
  const after = Number(o.after_minutes)
  const note = typeof o.note === 'string' ? o.note.replace(/\s+/g, ' ').trim() : ''
  if (!Number.isFinite(after) || after < FOLLOWUP_MIN_MINUTES || after > FOLLOWUP_MAX_MINUTES)
    return { ok: false, error: `after_minutes must be a number from ${FOLLOWUP_MIN_MINUTES} to ${FOLLOWUP_MAX_MINUTES} (simulated minutes from now)` }
  if (!note) return { ok: false, error: 'note is required: what to check again and what to do if the condition still holds' }
  if (pendingInThread >= FOLLOWUP_MAX_PER_THREAD)
    return { ok: false, error: `this thread already has ${pendingInThread} pending follow-ups (max ${FOLLOWUP_MAX_PER_THREAD}); finish, or escalate to the main` }
  return { ok: true, after, note: note.slice(0, 600) }
}

/** Pending follow-ups whose simulated due time has come, earliest first. */
export function duePending(all: Record<string, Followup>, nowMs: number): Followup[] {
  return Object.values(all ?? {}).filter(f => f.state === 'pending' && f.due <= nowMs).sort((a, b) => a.due - b.due)
}

/** The message the follow-up lane is started with. Does not repeat the original event's text. */
export function followupEventText(f: Followup, nowMs: number): string {
  return [
    `[車道事件｜後續檢查 ${f.id}｜thread ${f.thread}｜原事件 ${f.event}]`,
    `這是這條對話線先前排好的後續檢查，現在（模擬時間 ${simTime(nowMs)}）到時間了；排定時是 ${simTime(Date.parse(f.created))}，要求 ${f.after_minutes} 分鐘後再看。`,
    `當時留下的備註：${f.note}`,
    ...(f.run_id ? [`原排程回合的 run_id：${f.run_id}。收尾的 receipt 填這個 run_id。`] : []),
    `照備註與 runbook 重新檢查現況：條件還成立，就做可逆的小處理並確認結果（不可逆的事仍然只能 escalate）；已經恢復，就回報恢復。真的還需要再等，可以再呼叫一次 followup。最後一定先用 notify_joey 給 Joey 留一句（只一則；響不響由分流器決定，後續檢查通常是靜音），再呼叫 receipt 收尾；只留 receipt 不算收尾。receipt 的 happened / did / promised / needs_main 寫具體的數字與時間。`,
  ].join('\n')
}

// ------------------------------------------------------------------ commitments
export type Commitment = { who: string; what: string; by: string }

const DAYWORD = '(?:今天|明天|明早|今晚|後天|週[一二三四五六日]|星期[一二三四五六日])'
const BY_RE = new RegExp(`(?:${DAYWORD}\\s*)?\\d{1,2}\\s*(?::\\d{2}|點|時)\\s*前?|\\d+\\s*(?:分鐘|小時)\\s*(?:內|後|以內)?|${DAYWORD}(?:前|內)?`)

export function commitmentText(c: Commitment): string {
  return `答應 ${c.who}：${c.what}（時限：${c.by}）`
}

/** commitment(who, what, by) arguments. by may be left out ("未說明"). */
export function checkCommitmentArgs(a: unknown): { ok: true; c: Commitment } | { ok: false; error: string } {
  const o = (a ?? {}) as Record<string, unknown>
  const s = (k: string, n: number) => (typeof o[k] === 'string' ? (o[k] as string).replace(/\s+/g, ' ').trim().slice(0, n) : '')
  const who = s('who', 80), what = s('what', 500), by = s('by', 120) || '未說明'
  if (!who || !what) return { ok: false, error: 'who and what are required (to whom, and what was promised); by = deadline, or leave empty' }
  return { ok: true, c: { who, what, by } }
}

/** A commitment derived from the `promised` field of a closing receipt; null when it says nothing was promised. */
export function commitmentFromReport(promised: string | undefined | null, eventFrom: string | undefined, peer: string | null | undefined): Commitment | null {
  if (!promised || isNone(promised)) return null
  const what = promised.replace(/\s+/g, ' ').trim().slice(0, 500)
  const m = what.match(BY_RE)
  return { who: (peer || eventFrom || '未指明').trim(), what, by: m ? m[0].trim() : '未說明' }
}
