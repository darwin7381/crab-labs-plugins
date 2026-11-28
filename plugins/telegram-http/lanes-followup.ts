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
  /** event: the ORIGIN event (a follow-up is another run of it, PL3); run: the lane run that scheduled it */
  id: string; thread: string; lane: string; event: string; run?: string; run_id: string | null
  trigger: string; cls: string; from: string
  after_minutes: number; note: string; created: string; due: number; due_iso: string
  /** 'ended' (002k C6): cancelled because the run that scheduled it found nothing new */
  state: 'pending' | 'fired' | 'ended'; fired?: string; fired_event?: string
  /** 002k (C6): how many follow-up runs the chain has had once this one fires (1 = scheduled by an ordinary run); ended = why it was cancelled */
  chain?: number; ended?: string
  /** Writer bookkeeping for take members. A follow-up run's receipt decides whether there is another check to publish. */
  onsen?: 'awaiting_receipt' | 'submitted' | 'withdrawn'
  withdrawn_version?: number
}

// ------------------------------------------------------------------ 002k (C6): a follow-up chain stops by program
// 002j group C (C02): a follow-up chain on one thread re-polled for 9 simulated hours while it waited for Joey: 10 runs, 3.3M tokens, five
// near-identical notes. Two rules, both code (a model that keeps polling is answered with a program, not with more prompt text):
//   - a chain has a run cap: at most LANES_FOLLOWUP_CHAIN_MAX (default 4) follow-up runs after the ordinary run that started it; the
//     follow-up that would be the next one is refused;
//   - when a follow-up run's outcome is the same as the previous run's on that thread, the next follow-up is not scheduled (one the run
//     already scheduled is cancelled): the thread waits for a new event or for Joey. A new event on the thread starts a new chain.
export const FOLLOWUP_CHAIN_MAX = (): number => Math.max(1, Number(process.env.LANES_FOLLOWUP_CHAIN_MAX ?? 4) || 4)
/** What a run found, as text to compare: the receipt's outcome plus its did (else summary, else happened). Clock times, dates and run or
 *  follow-up ids are blanked (they differ in every run and say nothing); every other number is kept (a measurement that moved IS a change). */
export function outcomeFingerprint(outcome: string, a: { did?: unknown; summary?: unknown; happened?: unknown }): string {
  const pick = [a.did, a.summary, a.happened].find(x => typeof x === 'string' && x.trim()) as string | undefined
  const text = (pick ?? '').replace(/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}(?::\d{2})?|\b(?:fu|run|ev|mesh)-?[0-9a-f]{2,}\b/gi, '#').replace(/\s+/g, ' ').trim().toLowerCase()
  return `${String(outcome ?? '').trim().toLowerCase()}|${text}`
}
const bigrams = (s: string): Set<string> => { const o = new Set<string>(); for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); return o }
/** Same outcome word and (near) the same text (bigram overlap >= 0.85). No text on either side = no evidence of "unchanged" = false. */
export function sameOutcome(x: string, y: string): boolean {
  const [ox, ...rx] = x.split('|'), [oy, ...ry] = y.split('|')
  const tx = rx.join('|'), ty = ry.join('|')
  if (ox !== oy || !tx || !ty) return false
  if (tx === ty) return true
  const bx = bigrams(tx), by = bigrams(ty)
  let inter = 0; for (const g of bx) if (by.has(g)) inter++
  return inter / (bx.size + by.size - inter) >= 0.85
}

/** Simulated wall time as "YYYY-MM-DD HH:MM" in the lab's zone (UTC+8). */
export function simTime(ms: number): string {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms))
  const g = (t: string) => p.find(x => x.type === t)?.value ?? ''
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`
}

export function checkFollowupArgs(a: unknown, pendingInThread: number): { ok: true; after: number; note: string } | { ok: false; error: string } {
  const o = (a ?? {}) as Record<string, unknown>
  const after = Number(o.after_minutes)
  const note = typeof o.note === 'string' ? o.note.replace(/\s+/g, ' ').trim() : ''
  if (!Number.isFinite(after) || after < FOLLOWUP_MIN_MINUTES || after > FOLLOWUP_MAX_MINUTES)
    return { ok: false, error: `after_minutes must be a number from ${FOLLOWUP_MIN_MINUTES} to ${FOLLOWUP_MAX_MINUTES} (minutes from now)` }
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
    `這是這條對話線先前排好的後續檢查，現在（${simTime(nowMs)}）到時間了；排定時是 ${simTime(Date.parse(f.created))}，要求 ${f.after_minutes} 分鐘後再看。`,
    `當時留下的備註：${f.note}`,
    `這是同一件事的再一趟，不是新的事：Joey 已經有這件事的那一句。照備註與 runbook 重新檢查現況：條件還成立，就做可逆的小處理並確認結果（不可逆的事仍然只能 escalate）；真的還需要再等，可以再呼叫一次 followup。`,
    `結果跟上一趟不同（outcome 變了：例如從 changed 變成恢復的 normal，或變成 failed）才用 notify_joey 告訴 Joey，並填 outcome；一樣的結果分流器會拒絕，不必再說。最後呼叫 receipt 收尾（不用再填 run_id：回執上一趟已送），happened / did / promised / needs_main 寫具體的數字與時間。`,
  ].join('\n')
}

// ------------------------------------------------------------------ commitments
export type Commitment = { who: string; what: string; by: string }

const DAYWORD = '(?:今天|明天|明早|今晚|後天|週[一二三四五六日]|星期[一二三四五六日])'
// 1.38.3: 「第 1 點」 is an item number, not one o'clock (sonn's commitment of TG 7899 got 「時限：1 點」 from 「第 1 點的『自動帶回覆』」)
const BY_RE = new RegExp(`(?:${DAYWORD}\\s*)?(?<!第\\s*)\\d{1,2}\\s*(?::\\d{2}|點|時)\\s*前?|\\d+\\s*(?:分鐘|小時)\\s*(?:內|後|以內)?|${DAYWORD}(?:前|內)?`)

// ------------------------------------------------------------------ 1.38.3 (WO-131 D): what counts as a promise for later
// Every reply the main sent Joey (and some of its mails) was recorded as a commitment with the whole message: sonn 11-23 13:37Z → 11-24 01:25Z, 20 rows,
// p 0.72-0.99 (TG 7901 「進度：…正在縮。接下來：全套測試 → 推 1.35.0 → 回你兩題的完整答案」 0.99; TG 7905 「✅ 1.35.0 全艦隊上線…」 0.97). The question Jev is asked
// (promiseAsk: 「Does `message` say that its sender will do or deliver something later?」) is answered right: a status report names the sender's next steps.
// The record wants less: a promise owed to someone. A text is asked only when one of its sentences has an explicit form of one, and the commitment is
// those sentences, not the message:
//   - the sender's own future: 我會…, 我們會…, 我將…, I will / I'll / we'll;
//   - something owed by a time: <day or time>前／之前／以前／內 … 給／回你／交／完成… (「明天 10:00 前給你」, 「週五前會做好」, 「30 分鐘內回你」);
//   - a day or a later time with an action owed: 明天／明早／稍後／晚點／N 分鐘後… 給／回你／告訴／查／確認… (「我明天回你」, 「10 分鐘後再查一次並回報」); 今晚 is no later
//     time by itself (「今晚上線的三樣」 is a report), only with 前／之前 (「今晚前給你」);
//   - after something, owed to the recipient: …後／之後／到時 … 回你／給你／告訴你 (「上線後在這個 thread 回你一句」, Sonn to Chiron, #10900).
// A question (？／嗎) and a negated one (不用／不必／不會…) are not. A report of what was done, or of the work in progress and its next steps without such a
// form (「我現在提交、再整套跑一次」, 「換完給你結果」), is not asked. LANES_PROMISE_FORM=0: every text is asked, whole (1.38.2).
export const promiseFormOn = (): boolean => process.env.LANES_PROMISE_FORM !== '0'
const LATER = '(?:明天|明早|明晚|明日|今天內|今日內|後天|稍後|晚點|晚一點|待會|等一下|回頭|下週[一二三四五六日]?|下周[一二三四五六日]?|下禮拜|週[一二三四五六日]|星期[一二三四五六日]|月底|\\d+\\s*(?:分鐘|小時|天)後)'
const WHEN = `(?:${LATER}|今天|今晚|\\d{1,2}\\s*(?::\\d{2}|點|時)(?:\\d{1,2}\\s*分)?|\\d{1,2}[/-]\\d{1,2}|\\d+\\s*(?:分鐘|小時|天))`
const OWED = '(?:給|回你|回妳|回您|回覆|回報|回信|答覆|告訴|通知|交|寄|送|完成|做好|做完|弄好|處理|整理|補|提供|確認|查|修好|上線|推上|發|決定)'
const PROMISE_FORMS: RegExp[] = [
  /(?:我|我們|我们|咱們)(?:這邊|这边)?\s*(?:會|会|將|将)(?![議议員员計计談谈面]|不[會会])/,
  /\b(?:I|we)(?:'ll|’ll|\s+will|\s+shall)\b|\bI'm going to\b/i,
  new RegExp(`${WHEN}\\s*(?:之前|以前|前|以內|內)[^。！？；\\n]{0,40}?${OWED}`),
  new RegExp(`${LATER}[^。！？；\\n]{0,30}?${OWED}`),
  /(?:之後|以後|(?<![然最])後|到時)[^。！？；\n]{0,16}?(?:回你|回妳|回您|給你|給妳|告訴你|通知你|交給你|寄給你)/,
  /\bby (?:tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|end of (?:day|week)|eod|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b|\btomorrow\b[^.!?\n]{0,30}\b(?:send|give|reply|answer|deliver|finish|fix|check)/i,
]
const QUESTION = /(?:[？?]|嗎[。.!！]?)\s*$|([會会能要可])不\1/            // …？, …嗎, 會不會 / 能不能 / 要不要
/** a negated stretch (up to the next comma or stop) promises nothing: 「明天不用給」, 「這不會影響」 */
const NEGATED = /(?:不用|不必|不需要|不會|不会|無需|无需|別|别|沒有要|不打算|don't|won't|will not|not going to)[^，,。；;！!？?\n]*/gi
/** the sentences of `text` that hold an explicit promise for later ([] = none: a report, an answer, information) */
export function promiseSentences(text: string): string[] {
  const clean = String(text ?? '').replace(/第\s*\d+\s*(?:點|项|項|條|条|題|题|步|件)/g, '第N')
  const out: string[] = []
  for (const raw of clean.split(/(?<=[。！？!?；;])|\n+/)) {
    const s = raw.replace(/^(?:[\s>*#|•·-]+|\d+[.、)）]\s*)+/, '').replace(/\s+/g, ' ').trim()     // list and quote marks, not a leading number
    if (s.length < 2 || QUESTION.test(s)) continue
    const said = s.replace(NEGATED, '')
    if (PROMISE_FORMS.some(re => re.test(said))) out.push(s)
  }
  return out
}

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
