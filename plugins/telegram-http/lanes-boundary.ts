/**
 * lanes-boundary.ts — WO-125 (telegram-http 1.37.0): the lanes' boundary, first step. Chiron's evidence (11-23, 108 lane runs): of the 46 runs a lane
 * closed by itself, 10 were done wrong, and 5 of those reported as done a write the guard had refused (elsa.reflex.1, cadmus.reflex.3 / .5,
 * pheme.reflex.1, metis.reflex.3); 15 refused write attempts in 10 runs, 0 got through, and the receipt or Joey's line said "written" anyway.
 * Joey ruled 「那就試試看吧、記得同步紀錄觀察點」 (TG chiron:2095). Three parts, each with its own switch (default on, `0` = off = 1.36.2's behaviour):
 *   A  LANES_BOUNDARY_CARD  the boundary card in every run's 〔車道資訊〕 block: the default (the ticket's words), its 判例 from .lanes/boundary.md (the main's)
 *   B  LANES_BLOCK_FACTS    every write or command the guard refuses in a run is counted by the system; the run's notify_joey / ask_joey, its receipt
 *                           and its digest line carry 〔系統〕這一趟 N 次寫入或指令被擋：…, and its scheduled receipt cannot be filed as a success
 *   C  LANES_RECEIPT_STEPS  the receipt takes `steps` (done / not done each); a step not done cannot be filed as a success
 * The texts and the small pure helpers live here; lanes.ts wires them in, lanes-hooks/lane-guard-hook.py reports the refusals (POST /lane-blocked).
 */
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

export const boundaryCardOn = (): boolean => process.env.LANES_BOUNDARY_CARD !== '0'
export const blockFactsOn = (): boolean => process.env.LANES_BLOCK_FACTS !== '0'
export const receiptStepsOn = (): boolean => process.env.LANES_RECEIPT_STEPS !== '0'
/** WO-127 (telegram-http 1.38.0): one round trip, its own switch (default on; `0` = 1.37.2: no lane tool, no router rule, no sentence) */
export const decisionsOn = (): boolean => process.env.LANES_DECISIONS !== '0'
/** WO-127 item 4: who tells Joey about a matter the main decided: `lane` (default: the run that finishes it, once) | `main` (the main, as before) */
export const decisionReporter = (): 'lane' | 'main' => process.env.LANES_DECISION_REPORTER === 'main' ? 'main' : 'lane'
/** WO-128 (telegram-http 1.39.0): a card that can wait does not wake the main (default on; `0` = 1.38.x: every card wakes the main). Under LANES_DECISIONS. */
export const deferDecisionsOn = (): boolean => decisionsOn() && process.env.LANES_DEFER_DECISIONS !== '0'
/** WO-137 甲 (telegram-http 1.41.1): the longest a card that can wait goes untold (seconds, from the agent's earliest card the main has not been told about);
 *  then the main is woken once for every card waiting (the batch wake). Default 2700 (45 minutes); `0` = 1.41.0: no batch wake, only the due wake. */
export const deferMaxWaitS = (): number => { const n = Number(process.env.LANES_DEFER_MAX_WAIT_S ?? 2700); return Number.isFinite(n) && n > 0 ? n : 0 }
/** WO-137 甲: the batch wake is on (under LANES_DEFER_DECISIONS) */
export const batchWakeOn = (): boolean => deferDecisionsOn() && deferMaxWaitS() > 0
/** WO-144 (telegram-http 1.46.0): every run's opening carries the main's recent conversation with Joey (from Onsen), and the boundary card says to look at it
 *  before judging (default on; `0` = as before WO-144: no block, no sentence) */
export const mainChatOn = (): boolean => process.env.LANES_MAIN_CHAT !== '0'
/** WO-144 point 8 (telegram-http 1.46.0): the program gate behind the card's 但書 — a lane's action on the matter the main is handling in its current turn is
 *  not done (default on; `LANES_MAIN_SAME_MATTER=0`, or `LANES_MAIN_CHAT=0`: no gate, no Jev call) */
export const mainSameMatterOn = (): boolean => mainChatOn() && process.env.LANES_MAIN_SAME_MATTER !== '0'
/** the Jev threshold of the gate (`LANES_MAIN_SAME_MATTER_P`, default 0.8) */
export const mainSameMatterP = (): number => { const n = Number(process.env.LANES_MAIN_SAME_MATTER_P ?? 0.8); return Number.isFinite(n) ? n : 0.8 }
/** what a refused action returns to the lane (Sonn's wording, pending Chiron's review); `doing` = the 「在處理」 of the 此刻 line */
export function mainSameMatterRefusal(doing: string): string {
  const d = String(doing ?? '').replace(/\s+/g, ' ').trim()
  return `沒有做：主線正在回合中處理同一件事（在處理：${d.length > 80 ? `${d.slice(0, 80)}…` : d}）。照邊界卡的但書，這件交給主線：用 handoff_main 交過去（寫你查到的、你本來要做什麼），不要自己動手。`
}

// ------------------------------------------------------------------ A: the boundary card
export const BOUNDARY_FILE = 'boundary.md'
export const BOUNDARY_NONE = '- （還沒有）'
/** more lines than this in the card as sent: the main's digest says so (once per content of boundary.md) */
export const BOUNDARY_WARN_LINES = 40
/** the default card, the ticket's words (WO-125 A.2), `<agent>` filled in. The last line is the 判例 placeholder that boundary.md replaces. */
export function boundaryDefault(agent: string): string[] {
  return [
    `# 邊界卡（${agent} 的；主線寫的，你只能讀）`,
    '這件事做完，需不需要下面任何一樣？三樣都不需要，就是你的：做完，記一筆。',
    `1. 用 ${agent} 的名義答應、核准、拒絕；或在有一項沒過、有一段沒查的時候，判定「沒事」。`,
    BOUNDARY_Q2,                                                       // WO-137 乙: back to 1.39.1's question 2 (WO-132 had added production)
    boundaryQ3(agent),
    '需要任何一樣：分的是「一步」，不是「一件」。你做得了的每一步都做完（讀、查、對數字、擬好回覆、備好指令），'
      // WO-131 (1.38.3, Chiron mail #11046, verbatim): the step goes to the main as a decision card (LANES_DECISIONS=0: the 1.37 words, no card tool)
      + (decisionsOn() ? BOUNDARY_CARD_STEP : BOUNDARY_HANDOFF_STEP)
      + (decisionsOn() ? boundaryDecisionSentence() : ''),          // WO-127 item 8: the same line (the card's line count and hash do not change)
    ...(mainChatOn() ? [BOUNDARY_LOOK_LINE] : []),                     // WO-144 item 2: right before the 「沒把握」 line, whichever of the two it is
    deferDecisionsOn() ? BOUNDARY_DEFER_LINE : '沒把握：交給主線，不猜著做完。',   // WO-128 item 5: the same line replaced (line count, card_hash unchanged)
    boundaryProdLine(agent),                                           // WO-132 item 1: a line of its own after the 「沒把握」 line (WO-128's); WO-137 乙: its words
    '回報照實際發生的寫：指示裡的步驟，哪幾步做了、哪幾步沒做，都列出來；有沒做的，結果不能填正常。寫入或指令被擋，就寫被擋，不寫已做。',
    '判例（主線留的，新的在上面；跟上面衝突時照判例）：',
    BOUNDARY_NONE,
  ]
}
export type BoundaryCard = { text: string; lines: number; source: 'default' | 'file'; hash: string | null }
/** the card as this run gets it. WO-125 A.3: the default up to and including the 判例 heading always stays (the three questions and the two report
 *  sentences reach every agent); a non-empty <lanes dir>/boundary.md replaces the line 「- （還沒有）」, whole (A.4: no truncation). */
export function boundaryCard(agent: string, lanesDir: string): BoundaryCard {
  let file = ''
  try { file = readFileSync(join(lanesDir, BOUNDARY_FILE), 'utf8') } catch {}
  const body = file.trim() ? file.replace(/^\s*\n/, '').replace(/\s+$/, '') : ''
  const text = [...boundaryDefault(agent).slice(0, -1), body || BOUNDARY_NONE].join('\n')
  return { text, lines: text.split('\n').length, source: body ? 'file' : 'default', hash: body ? createHash('sha256').update(file).digest('hex').slice(0, 16) : null }
}
/** WO-125 A.4: the line in the main's digest when the card is long */
export const boundaryReminder = (lines: number): string => `邊界卡現在 ${lines} 行，整理一下`
/** WO-125 A.5: the main's rule, the ticket's words; lanes-main.ts puts it right after the focus card's */
export const BOUNDARY_MAIN_RULE = '- 邊界卡 .lanes/boundary.md：分身每一趟都讀。它交回來的事你覺得它自己做得完，或它自己做完的事你覺得該先問你，就在卡的「判例」加一行'
  + '（例：「讀者低於標準線就是異常，交給我」「純知會的信勾掉就好」），新的寫在上面。沒寫這個檔的時候分身用內建的預設。焦點卡照舊只寫你現在在做什麼。'

// ------------------------------------------------------------------ WO-127: one round trip (the main answers one decision, the lane that asked finishes)
// Chiron's ticket WO-127 (Joey 「那就試試看吧、記得同步紀錄觀察點」, TG chiron:2095; seam claude-epeius/knowledge/lane-mailbox-seam.md v2). The words of
// item 8 are the ticket's, verbatim; the `main` reporter (LANES_DECISION_REPORTER=main) says who reports instead.
/** WO-125 A.2: the step that needs the main, as 1.37.0 to 1.38.2 wrote it (and LANES_DECISIONS=0 still does: there is no card tool then) */
export const BOUNDARY_HANDOFF_STEP = '只把需要主線的那一步交出去，寫成：要你決定什麼／期限／關鍵事實與出處／我的建議與根據（查不到根據就寫「沒有建議」）／你說好之後還剩哪幾步。'
/** WO-131 (1.38.3, Chiron mail #11046): how the step that needs the main is handed over, in the boundary card's 「需要任何一樣：…」 sentence */
export const BOUNDARY_CARD_STEP = '只把需要主線的那一步交出去：用 decide_later 開一張決定卡（同事的來信用 mailbox_card 附在那封信上），五格：要你決定什麼／期限／關鍵事實與出處／我的建議與根據（查不到根據就寫「沒有建議」）／你說好之後我會做什麼。整件只能主線自己做的才用 handoff_main。'
/** item 8: the boundary card's sentence, right after the step's words (on the same line) */
export const BOUNDARY_DECISION_SENTENCE = '主線回了決定：照決定把剩下的做完，向 Joey 回報一次，寫明是照主線的決定。做不下去就整件交給主線，不再問第二次。'
const BOUNDARY_DECISION_SENTENCE_MAIN = '主線回了決定：照決定把剩下的做完（這件事由主線向 Joey 回報）。做不下去就整件交給主線，不再問第二次。'
export const boundaryDecisionSentence = (): string => decisionReporter() === 'main' ? BOUNDARY_DECISION_SENTENCE_MAIN : BOUNDARY_DECISION_SENTENCE
/** item 8: the main's rule, right after the boundary card's (lanes-main.ts) */
export const DECISION_MAIN_RULE = '- 分身交來要你決定的事附著決定卡。照卡就能決定的：用 mailbox_decide 回（照建議／改成…／不做），原本那條分身會接著做完並向 Joey 回報，你不用再為這件事回報。'
  + '收不回的動作、要你這段對話才知道的事：你自己做，做完那一件就算結掉。收不回的事和真金，先看原文再決定。'
const DECISION_MAIN_RULE_MAIN = '- 分身交來要你決定的事附著決定卡。照卡就能決定的：用 mailbox_decide 回（照建議／改成…／不做），原本那條分身會接著做完；這件事由你向 Joey 回報一次，寫明你的決定。'
  + '收不回的動作、要你這段對話才知道的事：你自己做，做完那一件就算結掉。收不回的事和真金，先看原文再決定。'
export const decisionMainRule = (): string => decisionReporter() === 'main' ? DECISION_MAIN_RULE_MAIN : DECISION_MAIN_RULE

// ------------------------------------------------------------------ WO-128: what can wait does not wake the main (Chiron's ticket; the words are its, verbatim)
/** WO-144 item 2 (Chiron's words, verbatim; the 但書 from Joey TG chiron:2263): the line before the 「沒把握」 line, in the default card and so in the card built from .lanes/boundary.md */
export const BOUNDARY_LOOK_LINE = '判斷之前：先看上面「主線最近和 Joey 的對話」；跟這件事有關的不夠，用 chat_history 搜（工單編號、標題裡的詞）。Joey 在對話裡已經講定的事，照他講的做，回報或交回時附那一則的編號。但書：對話裡還在談、沒有講定的，不算；主線正在回合中而且在處理同一件事（看上面「此刻」），交給主線，不跟它同時動手。'
/** item 5: the boundary card's line, in place of 「沒把握：交給主線，不猜著做完。」 */
export const BOUNDARY_DEFER_LINE = '要主線決定的那一步：等得起就用 decide_later 放進主線的信箱，不叫醒它；等不起才叫醒，寫出什麼會壞、誰在等。沒把握：當它等得起，不叫醒，也不猜著做完。'
/** item 5: the main's rule, right after the decision card's */
export const DEFER_MAIN_RULE = '- 等得起的事不會單獨叫醒你：你每次醒來，摘要會列「信箱有幾件等你決定」，一起處理；快到期的那一件才會單獨叫你。'
/** WO-137 甲 (item 7, the ticket's words, verbatim at the default 45 minutes): the same rule with the batch wake on; LANES_DEFER_MAX_WAIT_S=0: 1.41.0's */
export const deferMainRule = (): string => batchWakeOn()
  ? `- 等得起的事會併成一批告訴你：你每次醒來，摘要會列「信箱有幾件等你決定」；你一直沒醒的話，最晚 ${Math.max(1, Math.round(deferMaxWaitS() / 60))} 分鐘會為它們叫你一次。快到期的那一件會再單獨叫你。`
  : DEFER_MAIN_RULE
/** item 1: the optional argument of decide_later and mailbox_card (the lanes' copies; not sent to BTCC) */
export const URGENT_BECAUSE_PROP = { type: 'string', description: '選填。等不起才填：什麼會壞、誰在等（一句）。填了＝現在叫醒主線。不填＝等得起：不叫醒主線，它下一次醒來時在摘要看到這一件，快到期才單獨叫它。' }
export type MainDecision = 'as_recommended' | 'changed' | 'declined'
/** the decision in words: 照建議｜改成：<note>｜不做 */
export function decisionWords(decision: string, note?: string | null): string {
  return decision === 'changed' ? `改成：${String(note ?? '').trim()}` : decision === 'declined' ? '不做' : decision === 'as_recommended' ? '照建議' : decision
}
/** item 4: what the system puts in front of the finishing lane's line to Joey */
export const decisionPrefix = (decision: string, note?: string | null): string => `照主線的決定（${decisionWords(decision, note)}）：`
/** the five boxes of a decision card (fleet-mail.ts CARD_SCHEMA), one line each; `when` formats the deadline */
export function cardLines(card: Record<string, unknown> | null | undefined, when: (s: string) => string = s => s): string[] {
  const c = (card ?? {}) as Record<string, unknown>, s = (k: string): string => String(c[k] ?? '').trim()
  return [`要你決定：${s('decide') || '（卡上沒寫）'}`, ...(s('deadline') ? [`期限：${when(s('deadline'))}`] : []), ...(s('facts') ? [`關鍵事實：${s('facts')}`] : []),
    `建議：${s('recommend') || '（沒有建議）'}`, ...(s('basis') ? [`根據：${s('basis')}`] : []), ...(s('then') ? [`說好之後：${s('then')}`] : [])]
}
/** item 5: a run started by the main's decision may not ask again */
export const DECISION_ASK_AGAIN = 'refused: this run carries the main\'s decision on this matter, and a matter gets one decision (one round trip). You cannot ask again: '
  + 'finish it as decided, or, if it cannot be finished, hand the whole matter back with handoff_main (the card and what this run did go with it automatically). Nothing was put in the mailbox.'

// ------------------------------------------------------------------ B: what the guard refused in this run
export type Blocked = { target: string; category: 'file' | 'command'; tool: string; at: string; cleared?: string }
export type BlockedFacts = { n: number; targets: string[] }
/** the refusals of a run that still count (no later success on the same target), and their targets in order of first refusal */
export function blockedFacts(list: Blocked[] | undefined): BlockedFacts | null {
  const live = (list ?? []).filter(b => !b.cleared)
  if (!live.length) return null
  return { n: live.length, targets: [...new Set(live.map(b => b.target))] }
}
/** WO-125 B, the ticket's words: at most 3 targets listed; more: 「等 N 個」 (N = how many targets in all) */
export function blockedLine(f: BlockedFacts): string {
  return `〔系統〕這一趟 ${f.n} 次寫入或指令被擋：${f.targets.slice(0, 3).join('、')}${f.targets.length > 3 ? ` 等 ${f.targets.length} 個` : ''}`
}
/** the outcomes that say "done as asked": refused for a scheduled receipt while a refusal counts (B), and with a step not done (C) */
export const SUCCESS_OUTCOMES = ['done', 'normal', 'ok']
export const isSuccess = (outcome: unknown): boolean => SUCCESS_OUTCOMES.includes(String(outcome ?? '').trim().toLowerCase())
/** the refusal of a scheduled receipt filed as a success while refusals count (the receipt tool and btcc-receipt complete through the guard) */
export function blockedReceiptRefusal(run: string, outcome: string, f: BlockedFacts): string {
  return `沒有記錄，排程 run ${run} 也沒有完成：${blockedLine(f)}。這一趟有寫入或指令被擋，排程回執的結果不能填 ${outcome}（done、ok、normal 都不行）。`
    + '照實際發生的寫：outcome 填 failed，note（或 did）寫被擋的是什麼、哪幾步因此沒做；被擋的那幾步要做，用 handoff_main 交給主線，回執一樣填 failed。'
}
const WRITE_PROGS_LAST = new Set(['cp', 'mv', 'install', 'rsync', 'scp', 'ln'])
const WRITE_PROGS_ANY = new Set(['tee', 'touch', 'truncate', 'sponge'])
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** WO-125 B: does this (successful) Bash command write `target` (a workspace-relative or absolute path)? A redirect to it, tee / touch / truncate of it,
 *  the destination of cp / mv / install / rsync / scp / ln, sed -i / perl -i on it, dd of=it, an interpreter's open(it, 'w'|'a'). A command that only
 *  names it (cat, tail, grep: a read) does not: a lane that checks the file after the refusal has not written it. */
export function bashWritesPath(cmd: string, target: string): boolean {
  if (!target || !cmd.includes(target)) return false
  const t = escapeRe(target)
  if (new RegExp(`>\\|?\\s*['"]?(?:\\S*/)?${t}(?=['"\\s;&|)]|$)`).test(cmd)) return true                       // > file, >> file, >| file
  if (new RegExp(`\\bopen\\(\\s*['"](?:\\S*/)?${t}['"]\\s*,\\s*['"][^'"]*[wax+]`).test(cmd)) return true          // python / perl open(path, 'a')
  if (new RegExp(`\\bdd\\b[^;&|\\n]*\\bof=['"]?(?:\\S*/)?${t}`).test(cmd)) return true
  for (const seg of cmd.split(/[;&|\n]+/)) {
    if (!seg.includes(target)) continue
    const words = seg.trim().split(/\s+/).filter(w => !/^[A-Za-z_]\w*=/.test(w) && !['sudo', 'env', 'command', 'nice', 'nohup', 'time', 'then', 'do', '{'].includes(w))
    const prog = (words[0] ?? '').replace(/^.*\//, '')
    const last = (words.at(-1) ?? '').replace(/^['"]|['"]$/g, '')
    const hit = (w: string): boolean => w.replace(/^['"]|['"]$/g, '') === target || w.replace(/^['"]|['"]$/g, '').endsWith('/' + target)
    if (WRITE_PROGS_LAST.has(prog) && hit(last)) return true
    if (WRITE_PROGS_ANY.has(prog) && words.slice(1).some(hit)) return true
    if ((prog === 'sed' || prog === 'perl') && words.some(w => /^-[A-Za-z]*i/.test(w) || w.startsWith('--in-place')) && words.slice(1).some(hit)) return true
  }
  return false
}

// ------------------------------------------------------------------ C: the steps of the instruction, done or not
export type Step = { step: string; done: boolean; note?: string }
/** the receipt's `steps`: null = not given (or empty); { why } = unreadable (the receipt is refused, nothing recorded) */
export function parseSteps(v: unknown): Step[] | { why: string } | null {
  if (v == null || (Array.isArray(v) && !v.length)) return null
  if (!Array.isArray(v)) return { why: 'steps 要是一個陣列，每一步一項：{ step, done, note? }。' }
  const out: Step[] = []
  for (const [i, x] of v.entries()) {
    const step = String((x as any)?.step ?? '').trim()
    const d = (x as any)?.done
    const done = d === true || d === 'true' ? true : d === false || d === 'false' ? false : null
    if (!step || done == null) return { why: `steps 第 ${i + 1} 項要有 step（這一步是什麼）和 done（true 或 false）。` }
    const note = String((x as any)?.note ?? '').trim()
    out.push({ step, done, ...(note ? { note } : {}) })
  }
  return out
}
/** the steps not done, as the receipt record and the digest show them */
export function stepsNotDoneText(steps: Step[]): string {
  return steps.map((s, i) => ({ s, i })).filter(x => !x.s.done).map(x => `第 ${x.i + 1} 步「${x.s.step}」${x.s.note ? `（${x.s.note}）` : ''}`).join('、')
}
/** WO-125 C: a step not done and a success outcome, in a run that handed nothing to the main. The words 「把沒做的那幾步交給主線，或把結果改成部分完成」
 *  are the ticket's; either way out is accepted: after an accepted handoff_main in the run the receipt goes through with its steps as they are. */
export function stepsRefusal(outcome: string, steps: Step[]): string {
  return `沒有記錄：steps 裡有沒做的步驟（${stepsNotDoneText(steps)}），結果不能填 ${outcome}。把沒做的那幾步交給主線，或把結果改成部分完成：`
    + '交給主線＝先 handoff_main（寫清楚哪幾步沒做、為什麼），再送這份回執，沒做的步驟照樣寫 done=false；部分完成＝outcome 填 failed（排程端記成 failed），did 寫哪幾步做了、哪幾步沒做。'
}
// ------------------------------------------------------------------ WO-129 (telegram-http 1.39.0): the run a schedule gave a lane has one receipt path, with steps
// Chiron's ticket. With LANES_RECEIPT_STEPS on: a scheduled run's receipt carries steps (refused without); a lane completes a scheduled run only with the
// receipt tool (its btcc-receipt complete, or a direct call of the completion API the guard sees, is refused with a pointer); when steps were not done,
// the run's notify_joey ends with the steps line, in the form of the blocked-writes line. Off: 1.38.3.
/** item 1: the refusal of a scheduled run's receipt that has no steps */
export function missingStepsRefusal(run: string | null): string {
  return `沒有記錄：這一趟是排程交給你的${run ? `（run ${run}）` : ''}，回執要帶 steps：把指示裡的每一步照順序列一項（step＝那一步是什麼，done＝true｜false，note＝發生了什麼或為什麼沒做）。`
    + '條件沒成立所以不用做的步驟算做了（done=true，note 寫條件沒成立）；指示只有一件事就列一項。補上 steps，再送一次這份回執。'
}
/** item 2: what a lane is told when it completes a scheduled run any other way than the receipt tool (btcc-receipt complete, a direct completion call) */
export function receiptCliPointer(run: string | null, how: 'cli' | 'api' = 'cli'): string {
  return `This command was not run: in a lane, a scheduled run is completed only by the receipt tool: receipt(run_id=${run || '<run>'}, outcome, steps), every step of the instruction `
    + 'in its order (step, done true|false, note). '
    + (how === 'api' ? 'A direct call of the scheduler\'s completion API is not how a lane completes a run. ' : 'The btcc-receipt complete in your persona or in the scheduler\'s message means the receipt tool for you. ')
    + 'btcc-receipt ack is unchanged. Nothing was sent to the scheduler; run any other part of the command on its own.'
}
/** item 4, the ticket's form: 〔系統〕這一趟 5 步裡 1 步沒做：第 3 步「…」 (at most 3 listed, as the blocked-writes line); '' when every step was done */
export const STEP_IN_LINE_MAX = 40
export function stepsLine(steps: Step[] | undefined): string {
  const not = (steps ?? []).map((s, i) => ({ s, i })).filter(x => !x.s.done)
  if (!not.length) return ''
  const name = (t: string): string => { const c = Array.from(t.replace(/\s+/g, ' ').trim()); return c.length > STEP_IN_LINE_MAX ? c.slice(0, STEP_IN_LINE_MAX - 1).join('') + '…' : c.join('') }
  return `〔系統〕這一趟 ${steps!.length} 步裡 ${not.length} 步沒做：${not.slice(0, 3).map(x => `第 ${x.i + 1} 步「${name(x.s.step)}」`).join('、')}${not.length > 3 ? ` 等 ${not.length} 步` : ''}`
}
/** the receipt tool when C is on: the description says how to list the steps, the schema takes them */
export function receiptToolWithSteps(base: { name: string; description: string; inputSchema: any }): { name: string; description: string; inputSchema: any } {
  return {
    ...base,
    description: base.description + ' List each step of the instruction in steps, in its order (a scheduled routine\'s numbered steps, or each thing you were asked to do), with done true or false: a step you did not do, or whose write or command was refused, is done false. '
      + 'With any step not done the outcome cannot be done (nor ok / normal): hand the steps not done to the main with handoff_main first (then this receipt goes through, the steps as they are), or file the run as partly done (部分完成), which is outcome failed (the scheduler records failed) with the steps not done in did.',
    inputSchema: { ...base.inputSchema, properties: { ...base.inputSchema.properties,
      steps: { type: 'array', description: 'each step of the instruction, in order: { step: what it was, done: true | false, note: what happened or why not }',
        items: { type: 'object', properties: { step: { type: 'string' }, done: { type: 'boolean' }, note: { type: 'string' } }, required: ['step', 'done'] } } } },
  }
}

// ------------------------------------------------------------------ WO-132 (telegram-http 1.40.0): an alert's lane on a production machine
// Chiron's ticket (Joey TG chiron:2081 「也不要失控明明處理不完硬亂弄腳矯枉過正」, 2095). Prometheus 11-24 09:27–09:30Z: four warning alerts of one host in 49 s
// opened four reflex lanes; two of them ran `docker compose … up -d` on the production identity box over ssh while the main was fixing that box, and Joey
// got five messages in three minutes. The words (item 1, verbatim) ride the boundary card's switch (LANES_BOUNDARY_CARD); the helpers below are pure.
/** item 1: question 2 of the boundary card */
export const BOUNDARY_Q2 = '2. 收不回的動作：錢、金鑰、發布、刪除、改設定、對外。'
/** item 1: question 3 of the boundary card (the agent's name filled in, as the card already does) */
export const boundaryQ3 = (agent: string): string => `3. 只有主對話才知道的事：Joey 剛講的、談到一半的、${agent} 自己的標準、主線手上正在動的東西（看上面「此刻」）。`
/** item 1: the line after the 「沒把握」 line */
export const BOUNDARY_PROD_LINE_132 = '正式服務正在壞、等不起：唯讀查清楚、把要下的指令備好，用 handoff_main 交給主線，第一句寫什麼壞了、誰在等。不自己下那個指令。'
/** WO-137 乙 (Chiron; Joey TG chiron:2153), verbatim: the production line as 1.41.1 sends it (${agent} filled in) */
export const boundaryProdLine = (agent: string): string => `正式服務壞了：先看上面「此刻」。主線正在回合中、而且在動同一個服務：把你查到的原因和備好的指令用 handoff_main 交給它，不跟它同時動手。主線閒著或叫不醒：文件（runbook、README）寫明、做了可以重來的修復，由你做，這不算改設定；動手前照 ${agent} 自己的規矩登記變更，做完向 Joey 回報一次，寫明下了什麼指令、結果、還沒查的。文件上沒有的做法、刪資料、動錢、動金鑰：交主線。`
/** item 1: the identity card's 「做可逆的小處理」, and what it reads with the boundary card on */
export const IDENTITY_SMALL_OLD = '做可逆的小處理'
export const IDENTITY_SMALL_NEW = '做可逆的小處理'                     // WO-137 乙: back to 1.39.1's words (WO-132 had added 「（不動正式的機器或服務）」)
/** item 1 (Chiron 10:23Z, the ticket's 5th point): the second half of the identity card's critical-alert line, old and new */
export const CRITICAL_TAIL_OLD = '不要為了「嚴重」而 handoff_main：主線會在摘要裡看到。'
export const CRITICAL_TAIL_NEW = '嚴重本身不是交主線的理由，也不是不交的理由：照邊界卡的三問判，要主線的照樣用 handoff_main 交。摘要不會叫醒主線。'

/** item 5: a line to Joey that says the main takes over or is asked to act (主線接手／交給主線／要主線…／主線會…), in a clause that does not deny it.
 *  The same way as the claims check of lanes.ts (CLAIM_RE / claimsHandover): a pattern, then the few characters before the match in its own clause. */
const MAIN_ASK_RE = new RegExp([
  '主線\\s*(?:來\\s*)?接手',
  '(?:交給|交由|交回|轉給|轉交|留給|丟給|請|要|讓|需要|需|待|等|麻煩)\\s*主線',
  '由\\s*主線\\s*(?:來\\s*)?(?:處理|決定|接手|回報|報|核對|確認|看|查|補|做|定奪|裁決|跟進|追)',
  '主線\\s*(?:會|將|再|可以?|可再|得|應該?|該|需要|要|有需要|來|去)(?!的)',
  '\\b(?:hand(?:ed|ing)?|pass(?:ed|ing)?|leave|leaving|left)\\b[^.;\\n]{0,24}\\bto the main\\b',
  '\\bthe main (?:will|should|can|could|needs? to|must|has to|to)\\b',
].join('|'), 'gi')
const MAIN_ASK_NEG = /(?:不|沒|没|未|別|别|勿|毋|無須|無需|无需|免)[^，。；！？,.;!?\n]{0,6}$|(?:\bnot\b|n't|\bnever\b|\bwithout\b|\bno need\b)[^,.;!?\n]{0,24}$/i
/** the phrase that says so ('' = none). Quoted code (a fenced block, `inline`) is not the lane's own sentence: a pasted hook error is no ask. */
export function mainAskPhrase(text: string): string {
  const raw = String(text ?? '')
  const s = raw.replace(/```[\s\S]*?(?:```|$)/g, m => ' '.repeat(m.length)).replace(/`[^`\n]*`/g, m => '`' + ' '.repeat(m.length - 2) + '`')   // same length: indexes stay
  const re = new RegExp(MAIN_ASK_RE.source, 'gi')
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (!MAIN_ASK_NEG.test(s.slice(Math.max(0, m.index - 30), m.index))) {
      const from = Math.max(0, s.lastIndexOf('\n', m.index) + 1, ...['。', '；', '！', '？'].map(p => s.lastIndexOf(p, m!.index) + 1))
      const to = [s.indexOf('\n', m.index), ...['。', '；', '！', '？'].map(p => s.indexOf(p, m!.index))].filter(i => i >= 0).reduce((a, b) => Math.min(a, b), s.length)
      return Array.from(raw.slice(from, to).trim()).slice(0, 80).join('')
    }
    if (m[0].length === 0) re.lastIndex++
  }
  return ''
}
/** item 5: the refusal (once per run) of a notify_joey / ask_joey that says the main takes over, from a run that handed nothing to the main */
export function mainAskRefusal(tool: string, phrase: string): string {
  return `沒有送出：這一則 ${tool} 說主線會接手或要主線做事（「${phrase}」），但這一趟沒有交給主線（沒有 handoff_main、decide_later、mailbox_card），主線不會被叫醒，也看不到。`
    + '要主線做的：先用 handoff_main 交給它（寫清楚要它做什麼；等得起、只要它決定的用 decide_later），交了之後由主線回報 Joey，你不用再通知 Joey。'
    + '不需要主線的：把那一句拿掉，再送一次。這個提醒一趟只有一次。'
}
/** item 6: what a notify_joey refused by the notice de-duplication says in its tool result (Joey already got the same line: the step is done) */
export const DEDUPE_DONE_NOTE = '（Joey 已經收過同一則，這一步算做了：receipt 的 steps 裡回報 Joey 的那一步填 done=true。）'
/** item 6: a step of a receipt that is the report to Joey (its words, or its note) */
export const REPORT_STEP_RE = /joey|回報|通知|告訴|報給|報告|notify|report/i
/** item 6: the steps as the receipt records them when this run's notify_joey was dropped by the de-duplication: a report step marked not done is done */
export function dedupedSteps(steps: Step[]): { steps: Step[]; changed: number } {
  let changed = 0
  const out = steps.map(s => {
    if (s.done || !REPORT_STEP_RE.test(`${s.step} ${s.note ?? ''}`)) return s
    changed++
    return { ...s, done: true, note: `${s.note ? `${s.note}；` : ''}Joey 已經收過同一則（通知被去重擋下），算做了` }
  })
  return { steps: out, changed }
}

/** item 8 (observation only, never a refusal): the commands of a Bash call that change state on another machine, as the guard sees the command: an ssh with
 *  a remote command that restarts, rebuilds, removes, writes or reconfigures (docker / docker compose up·restart·down·rm…, systemctl restart·stop·start…,
 *  rm, mv, a write, kill, nginx -s, kubectl apply…, ufw, iptables, package installs, git pull…), and scp / rsync to a remote destination. One entry per
 *  remote host the command touches: { host, what: the changes found }. */
export type RemoteChange = { host: string; what: string[] }
/** the simple commands of a shell line (quotes removed, words kept whole); ; & | && || newline ( ) end a command. A heredoc after ssh becomes its remote command. */
export function shellCommands(cmd: string): string[][] {
  let src = String(cmd ?? '')
  src = src.replace(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g, (_m, _q, _tag, rest: string, body: string, off: number) => {
    const line = src.slice(src.lastIndexOf('\n', off) + 1, off)
    return /(?:^|[\s;&|(])(?:\S*\/)?ssh\s/.test(line) ? `${rest} '${body.replace(/'/g, `'\\''`)}'` : rest
  })
  const out: string[][] = []
  let cur: string[] = [], w = '', inW = false, i = 0
  const push = (): void => { if (inW) { cur.push(w); w = ''; inW = false } }
  const end = (): void => { push(); if (cur.length) out.push(cur); cur = [] }
  while (i < src.length) {
    const c = src[i]
    if (c === "'") { const j = src.indexOf("'", i + 1); w += j < 0 ? src.slice(i + 1) : src.slice(i + 1, j); inW = true; i = j < 0 ? src.length : j + 1; continue }
    if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\' && j + 1 < src.length) { w += src[j + 1]; j += 2; continue } w += src[j]; j++ }
      inW = true; i = j + 1; continue
    }
    if (c === '\\' && i + 1 < src.length) { if (src[i + 1] !== '\n') { w += src[i + 1]; inW = true } i += 2; continue }
    if (c === '#' && !inW) { while (i < src.length && src[i] !== '\n') i++; continue }
    if (';&|\n()'.includes(c)) { end(); i++; continue }
    if (/\s/.test(c)) { push(); i++; continue }
    w += c; inW = true; i++
  }
  end()
  return out
}
const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'nice', 'ionice', 'command', 'exec', 'stdbuf', 'then', 'do', 'else', '{', '!'])
const SSH_ARG_OPTS = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''))
const SCRATCH = /^(?:\/tmp\/|\/var\/tmp\/|\/dev\/)/
const progOf = (w: string | undefined): string => String(w ?? '').replace(/^.*\//, '')
/** the words of a command without its leading assignments and wrappers (sudo -u x, timeout 10, env A=b …) */
function bare(words: string[]): string[] {
  let k = 0
  while (k < words.length) {
    const w = words[k]
    if (/^[A-Za-z_]\w*=/.test(w) || WRAPPERS.has(w)) { k++; if (w === 'sudo') while (k < words.length && words[k].startsWith('-')) k += ['-u', '-g', '-C', '-h', '-p'].includes(words[k]) ? 2 : 1; continue }
    if (w === 'timeout') { k++; while (k < words.length && words[k].startsWith('-')) k++; k++; continue }
    break
  }
  return words.slice(k)
}
const nonOpts = (ws: string[]): string[] => ws.filter(x => !x.startsWith('-'))
/** the state changes one simple command makes on the machine it runs on (nested shells, docker exec and ssh not followed here, but by remoteChangesOf) */
function changesOf(words0: string[], depth: number): string[] {
  const words = bare(words0)
  if (!words.length || depth > 4) return []
  const out: string[] = []
  // a write by redirect (> file, >> file), outside /tmp and /dev
  for (let k = 0; k < words.length; k++) {
    const m = words[k].match(/^\d*(>>?)(.*)$/)
    if (!m) continue
    const target = m[2] || words[k + 1] || ''
    if (target && !target.startsWith('&') && !SCRATCH.test(target)) out.push(`${m[1]} ${target}`)
  }
  const p = progOf(words[0]), args = words.slice(1), sub = nonOpts(args)[0] ?? ''
  const nested = (s: string | undefined): string[] => s ? shellCommands(s).flatMap(c => changesOf(c, depth + 1)) : []
  switch (p) {
    case 'bash': case 'sh': case 'zsh': case 'dash': { const i = args.indexOf('-c'); return [...out, ...(i >= 0 ? nested(args[i + 1]) : [])] }
    case 'su': { const i = args.indexOf('-c'); return [...out, ...(i >= 0 ? nested(args[i + 1]) : [])] }
    case 'docker': case 'podman': return [...out, ...dockerChanges(p, args, depth)]
    case 'docker-compose': return [...out, ...composeChanges('docker-compose', args, depth)]
    case 'systemctl': return ['restart', 'stop', 'start', 'reload', 'try-restart', 'reload-or-restart', 'try-reload-or-restart', 'enable', 'disable', 'mask', 'unmask', 'kill',
      'daemon-reload', 'isolate', 'reboot', 'poweroff', 'halt', 'set-property', 'edit', 'revert'].includes(sub) ? [...out, `systemctl ${sub}`] : out
    case 'service': { const a = nonOpts(args); return ['restart', 'stop', 'start', 'reload', 'force-reload'].includes(a[1] ?? '') ? [...out, `service ${a[0]} ${a[1]}`] : out }
    case 'rm': case 'rmdir': case 'unlink': case 'shred': case 'mv': case 'cp': case 'truncate': case 'chmod': case 'chown': case 'chgrp': case 'ln': case 'install':
    case 'mkdir': case 'touch': case 'tee': {
      const paths = nonOpts(args).filter(a => !/^[0-7]{3,4}$|^[ugoa]*[+-=][rwxXst]+$/.test(a))
      return paths.length && paths.every(a => SCRATCH.test(a)) ? out : [...out, p]
    }
    case 'dd': return args.some(a => a.startsWith('of=') && !SCRATCH.test(a.slice(3))) ? [...out, 'dd of='] : out
    case 'sed': case 'perl': return args.some(a => /^-[A-Za-z]*i/.test(a) || a.startsWith('--in-place')) ? [...out, `${p} -i`] : out
    case 'kill': case 'pkill': case 'killall': case 'reboot': case 'shutdown': case 'poweroff': case 'halt': return [...out, p]
    case 'nginx': { const i = args.indexOf('-s'); return i >= 0 ? [...out, `nginx -s ${args[i + 1] ?? ''}`.trim()] : out }
    case 'apachectl': case 'apache2ctl': return ['restart', 'graceful', 'stop', 'start', 'graceful-stop'].includes(sub) ? [...out, `${p} ${sub}`] : out
    case 'kubectl': return ['apply', 'delete', 'create', 'replace', 'patch', 'edit', 'scale', 'rollout', 'set', 'label', 'annotate', 'drain', 'cordon', 'uncordon', 'taint'].includes(sub)
      && !(sub === 'rollout' && ['status', 'history'].includes(nonOpts(args)[1] ?? '')) ? [...out, `kubectl ${sub}`] : out
    case 'ufw': return ['allow', 'deny', 'reject', 'limit', 'delete', 'insert', 'enable', 'disable', 'reset', 'reload', 'route', 'default', 'prepend'].includes(sub) ? [...out, `ufw ${sub}`] : out
    case 'iptables': case 'ip6tables': return args.some(a => /^-(?:[AIDRFXPNZ]|-append|-insert|-delete|-replace|-flush|-policy)$/.test(a)) ? [...out, p] : out
    case 'apt': case 'apt-get': case 'yum': case 'dnf': case 'apk': case 'snap': return ['install', 'remove', 'purge', 'upgrade', 'dist-upgrade', 'full-upgrade', 'autoremove', 'add', 'del', 'refresh'].includes(sub) ? [...out, `${p} ${sub}`] : out
    case 'pip': case 'pip3': return ['install', 'uninstall'].includes(sub) ? [...out, `${p} ${sub}`] : out
    case 'git': return ['pull', 'push', 'checkout', 'reset', 'merge', 'rebase', 'commit', 'clean', 'stash', 'switch', 'restore', 'apply', 'am', 'cherry-pick', 'revert'].includes(sub) ? [...out, `git ${sub}`] : out
    case 'crontab': return args.some(a => a === '-r' || a === '-e') || nonOpts(args).length ? [...out, 'crontab'] : out
    case 'certbot': return ['renew', 'certonly', 'delete', 'revoke', 'install', 'run'].includes(sub) || !sub ? [...out, `certbot ${sub}`.trim()] : out
  }
  return out
}
const DOCKER_MUT = new Set(['run', 'start', 'stop', 'restart', 'kill', 'rm', 'rmi', 'create', 'pull', 'update', 'rename', 'pause', 'unpause', 'cp', 'load', 'import', 'commit', 'prune'])
const DOCKER_GROUPS = new Set(['container', 'network', 'volume', 'image', 'system', 'service', 'stack', 'swarm', 'node', 'secret', 'config', 'plugin'])
const DOCKER_GROUP_MUT = new Set([...DOCKER_MUT, 'connect', 'disconnect', 'remove', 'deploy', 'scale', 'rollback', 'init', 'join', 'leave', 'enable', 'disable', 'install', 'upgrade', 'push'])
function dockerChanges(p: string, args: string[], depth: number): string[] {
  let k = 0
  while (k < args.length && args[k].startsWith('-')) k += ['-H', '--host', '-c', '--context', '--config', '-l', '--log-level'].includes(args[k]) ? 2 : 1
  const sub = args[k] ?? ''
  if (sub === 'compose') return composeChanges(`${p} compose`, args.slice(k + 1), depth)
  if (sub === 'exec') return execChanges(`${p} exec`, args.slice(k + 1), ['-e', '--env', '-u', '--user', '-w', '--workdir', '--env-file'], depth)
  if (DOCKER_GROUPS.has(sub)) {
    const s2 = nonOpts(args.slice(k + 1))[0] ?? ''
    if (sub === 'container' && s2 === 'exec') return execChanges(`${p} container exec`, args.slice(args.indexOf('exec', k) + 1), ['-e', '--env', '-u', '--user', '-w', '--workdir', '--env-file'], depth)
    return DOCKER_GROUP_MUT.has(s2) ? [`${p} ${sub} ${s2}`] : []
  }
  return DOCKER_MUT.has(sub) ? [`${p} ${sub}`] : []
}
const COMPOSE_ARG_OPTS = new Set(['-f', '--file', '-p', '--project-name', '--project-directory', '--env-file', '--profile', '--ansi', '--parallel', '--progress'])
const COMPOSE_MUT = new Set(['up', 'down', 'restart', 'stop', 'start', 'rm', 'kill', 'pull', 'create', 'run', 'pause', 'unpause', 'scale', 'cp'])
function composeChanges(name: string, args: string[], depth: number): string[] {
  let k = 0
  while (k < args.length && (args[k].startsWith('-') || args[k].startsWith('$'))) k += COMPOSE_ARG_OPTS.has(args[k]) ? 2 : 1
  const sub = args[k] ?? ''
  if (sub === 'exec') return execChanges(`${name} exec`, args.slice(k + 1), ['-e', '--env', '-u', '--user', '-w', '--workdir', '--index'], depth)
  if (!COMPOSE_MUT.has(sub) || args.slice(k + 1).includes('--dry-run')) return []
  return [`${name} ${sub}`]
}
/** docker exec / compose exec: what the command it runs inside the container changes */
function execChanges(name: string, args: string[], withValue: string[], depth: number): string[] {
  let k = 0
  while (k < args.length && args[k].startsWith('-')) k += withValue.includes(args[k]) ? 2 : 1
  const inner = args.slice(k + 1)                                     // after the container (or service) name
  return changesOf(inner, depth + 1).map(c => `${name} … ${c}`)
}
/** item 8: the remote changes of one Bash command (see RemoteChange) */
export function remoteChanges(cmd: string, depth = 0): RemoteChange[] {
  const out: RemoteChange[] = []
  const add = (host: string, what: string[]): void => {
    if (!what.length) return
    const had = out.find(o => o.host === host)
    if (had) had.what.push(...what.filter(w => !had.what.includes(w))); else out.push({ host, what: [...new Set(what)] })
  }
  if (depth > 3) return out
  for (const c of shellCommands(cmd)) {
    const words = bare(c)
    const p = progOf(words[0])
    if (p === 'ssh') {
      let k = 1
      while (k < words.length && words[k].startsWith('-') && words[k] !== '--') {
        const letters = words[k].slice(1)
        let needs = false
        for (let x = 0; x < letters.length; x++) if (SSH_ARG_OPTS.has(letters[x])) { needs = x === letters.length - 1; break }
        k += needs ? 2 : 1
      }
      if (words[k] === '--') k++
      const host = words[k], remote = words.slice(k + 1).join(' ')
      if (!host || !remote.trim()) continue
      add(host, shellCommands(remote).flatMap(rc => changesOf(rc, 0)))
      for (const r of remoteChanges(remote, depth + 1)) add(r.host, r.what)    // ssh through a jump host's shell
      continue
    }
    if (p === 'scp' || p === 'rsync') {
      const a = nonOpts(words.slice(1))
      const dest = a.at(-1) ?? ''
      const m = dest.match(/^(?:[^/:\s]+@)?([^/:\s]+):/)
      const path = dest.slice(dest.indexOf(':') + 1)
      if (a.length >= 2 && m && !SCRATCH.test(path) && !(p === 'rsync' && words.some(w => w === '-n' || w === '--dry-run' || /^-[A-Za-z]*n[A-Za-z]*$/.test(w)))) add(dest.slice(0, dest.indexOf(':')), [`${p} to remote`])
    }
  }
  return out
}

// ------------------------------------------------------------------ 1.41.1: a scheduler receipt is met only when the scheduler completed the run
// Chiron mail #11236 (run 6985, 11-24): the main's heredoc that rewrote ANCHOR.md mentioned 「btcc-receipt complete 6985」; mainToolDone matched it against the
// whole command text and recorded the receipt met (13:05:42Z), so the main's real call at 13:15:54Z was refused (「已經回執過了」) and it had to POST
// /complete by hand. Metis mail #11280 (run 6804, 11-23 02:43:53Z): the lane's receipt sent outcome `done`, BTCC answered HTTP 422, and the receipt was
// recorded met (any answer was), so its retries and the main's call were refused; BTCC kept the run stalled_no_complete. Same on angelia 6865, cadmus 6969 /
// 6994, elsa 6972, pheme 6989 (the fleet's state journals, 11-23 to 11-24: every receipt a lane filed with `done` got 422; 23 others filed `done` too and
// were completed by the btcc-receipt CLI's `ok`).
/** the scheduler's outcomes (BTCC schedule_runs.outcome; the btcc-receipt CLI's choices): ok | nothing-to-do | failed. The receipt's words in them: done /
 *  normal / ok (and none) → ok; nothing-to-do; failed. Another word goes as it is (the scheduler refuses it, and the receipt stays owed). */
export function btccOutcome(outcome: unknown): string {
  const o = String(outcome ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-')
  if (!o || isSuccess(o)) return 'ok'
  if (['nothing-to-do', 'nothing', 'noop', 'no-op', 'skipped'].includes(o)) return 'nothing-to-do'
  if (['failed', 'fail', 'failure', 'error', 'partial', 'partly-done', '部分完成'].includes(o)) return 'failed'
  return o
}
/** a scheduler that says the run is already completed (BTCC 409 「run is completed, not completable」): someone completed it; nothing is owed */
const ALREADY_COMPLETED = /\bis completed\b|"state"\s*:\s*"completed"/i
/** what the agent-inbox daemon's answer to /lanes/scheduler says: `<action> run N: HTTP <status>[ <body>]` (server.ts schedulerCall), `<action> run N
 *  failed: <error>`, `BTCC_API_BASE not set`, `no scheduler`. ok = the run is completed now (2xx) or already was (409 with 「is completed」); another
 *  answer (an older daemon, a stand-in) counts as before. */
export function schedulerAnswerOk(text: unknown): { ok: boolean; already?: boolean } {
  const t = String(text ?? '')
  const m = t.match(/^(?:complete|ack) run \S+: HTTP (\d{3})/)
  if (m) {
    const s = Number(m[1])
    if (s >= 200 && s < 300) return { ok: true }
    return s === 409 && ALREADY_COMPLETED.test(t.slice(m[0].length)) ? { ok: true, already: true } : { ok: false }
  }
  if (/^(?:complete|ack) run \S+ failed: /.test(t) || t === 'BTCC_API_BASE not set' || t === 'no scheduler') return { ok: false }
  return { ok: true }
}
/** what the btcc-receipt CLI printed (the main's Bash result): on a refusal or an error it prints 「btcc-receipt: HTTP <code> <body>」 or 「btcc-receipt:
 *  <Error>: …」 and exits 1; otherwise BTCC's answer. ok = no such line, or a 409 that says the run is completed; `text`: the line, or BTCC's answer. */
export function receiptCliAnswer(response: unknown): { ok: boolean; already?: boolean; text: string } {
  const r = String(response ?? '')
  const http = r.match(/btcc-receipt: HTTP (\d{3})[^\n"]*(?:"[^\n]*)?/)
  if (http) return Number(http[1]) === 409 && ALREADY_COMPLETED.test(http[0]) ? { ok: true, already: true, text: http[0].slice(0, 200) } : { ok: false, text: http[0].slice(0, 200) }
  const err = r.match(/btcc-receipt: [A-Za-z]*(?:Error|Exception)\b[^\n]*/)
  if (err) return { ok: false, text: err[0].slice(0, 200) }
  const done = r.match(/\{[^\n{}]*"state"\s*:\s*"completed"[^\n{}]*\}/)
  return { ok: true, text: (done ? done[0] : r).slice(0, 200) || 'completed' }
}
/** the programs a command line runs through before the one it names (the guard's WRAPPERS, lane-guard-hook.py), shell keywords, and the shells whose -c runs a line */
const RUN_WRAPPERS = new Set(['sudo', 'time', 'timeout', 'nohup', 'exec', 'env', 'command', 'nice', 'stdbuf', 'setsid', 'xargs', 'watch', 'builtin'])
const RUN_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}'])
const RUN_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
/** Chiron mail #11236: the scheduler runs a Bash line really completes with the btcc-receipt CLI (`btcc-receipt complete N`, any path, through env / sudo /
 *  timeout …, python3 <path>/btcc-receipt, inside bash -c '…'), read as the guard reads it (lane-guard-hook.py receipt_cli_calls): the words of each simple
 *  command (shellCommands: quotes removed, a heredoc's body dropped). A mention is not a call: an echo, a quoted string, a heredoc's text, a commit message. */
export function receiptCliRuns(cmd: string, depth = 0): string[] {
  const out: string[] = []
  for (const c of shellCommands(cmd)) {
    let k = 0
    while (k < c.length) {
      const w = c[k], b = progOf(w)
      if (RUN_KEYWORDS.has(w) || /^[A-Za-z_]\w*=/.test(w) || RUN_WRAPPERS.has(b)) { k += b === 'timeout' && !RUN_KEYWORDS.has(w) ? 2 : 1; continue }
      if (w.startsWith('-') && k && RUN_WRAPPERS.has(progOf(c[k - 1]))) { k++; continue }
      break
    }
    let prog = progOf(c[k]), args = c.slice(k + 1)
    if (/^python[\d.]*$/.test(prog) && progOf(args.find(a => !a.startsWith('-'))) === 'btcc-receipt') { const i = args.findIndex(a => !a.startsWith('-')); prog = 'btcc-receipt'; args = args.slice(i + 1) }
    if (RUN_SHELLS.has(prog) && depth < 3) { const i = args.indexOf('-c'); if (i >= 0 && args[i + 1]) out.push(...receiptCliRuns(args[i + 1], depth + 1)); continue }
    if (prog !== 'btcc-receipt' || args[0] !== 'complete') continue
    const pos: string[] = []
    for (let i = 1; i < args.length; i++) { if (args[i] === '--outcome' || args[i] === '--note') { i++; continue } if (!args[i].startsWith('-')) pos.push(args[i]) }
    if (/^\d+$/.test(pos[0] ?? '')) out.push(pos[0])
  }
  return out
}
