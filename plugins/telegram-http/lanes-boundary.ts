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
    '2. 收不回的動作：錢、金鑰、發布、刪除、改設定、對外。',
    `3. 只有主對話才知道的事：Joey 剛講的、談到一半的、${agent} 自己的標準。`,
    '需要任何一樣：分的是「一步」，不是「一件」。你做得了的每一步都做完（讀、查、對數字、擬好回覆、備好指令），'
      // WO-131 (1.38.3, Chiron mail #11046, verbatim): the step goes to the main as a decision card (LANES_DECISIONS=0: the 1.37 words, no card tool)
      + (decisionsOn() ? BOUNDARY_CARD_STEP : BOUNDARY_HANDOFF_STEP)
      + (decisionsOn() ? boundaryDecisionSentence() : ''),          // WO-127 item 8: the same line (the card's line count and hash do not change)
    '沒把握：交給主線，不猜著做完。',
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
