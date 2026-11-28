// screen-status.ts — WO-165 A (Joey TG chiron:2485, 2026-11-25): the bottom of the agent's own Claude Code screen is read, and that reading is the
// state the daemon reports. WO-169 (Joey TG chiron:2547, 2520: 「Jev頂替只是程式邏輯判斷的部分…後面還是要根據他的輸出選項結果再經過一個程式輸出，
// 然後輸出的東西才擺在各種應該擺的位置」「不是把它當成 Agent 而是把它當成就是一個小程式的一小段」) fixes the interface around the judging step:
//
//   above     this file, no Jev: the look (WO-168: pane-look.ts, the one capture), regions() (Chiron's jev_screen.py, ported line for line), the counts and facts the program
//             reads (counted_by_program, found_by_program), the hash of what can change the answer, the cadence (ask only when the hash changed, one in
//             flight, the cache, the 60 s re-ask, the cap a minute)
//   middle    a ScreenJudge: judge(parts) → ScreenVerdict | null. The one in use is JevJudge (screen-judge-jev.ts: Jev asked, its answer collected by the
//             program into a ScreenVerdict; Jev's own shapes never leave that file). SCREEN_JUDGE picks it (jev, the default | program: none yet, the
//             record is statusOf's); a program judge later implements the same interface and only the setting changes
//   below     this file, no Jev: publishView(verdict or null, regions, statusOf's view, facts) composes the one status record (offline → starting →
//             usage limit → waiting → compacting → stuck → busy → idle); the reader's view() is what server.ts's currentStatus() gives Onsen, the pin,
//             /healthz and the lanes' five readers. Nothing below knows who judged (detail.judged_by is a label only)
//   collect   every new screen hash's first verdict of the day: one line of <workspace>/.lanes/run/screen-verdicts.jsonl (the three regions masked as
//             the exception log, the program's facts, the verdict): the question bank a program judge is tested on
//
// statusOf (onsen-status.ts) stays exactly as it is: it is still computed, it is the trigger (its change makes the screen be looked at at once), the
// fallback (no verdict) and the side every verdict is compared with (JevJudge's exception log).
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { hasUsageNotice, redact } from './duty-officer.ts'
import type { StatusView } from './onsen-status.ts'
import type { PaneLook } from './pane-look.ts'

// ------------------------------------------------------------------ regions (port of jev_screen.py regions(), 2026-11-26)
const RULE = /^\s*[─━]{20,}\s*$/
const ACT = /^\s*[*·✢✳✶✻✽]\s+\S.*…\s*(\(.*)?$/          // a live activity line: glyph, text, …, an optional parenthesis
const FIN = /^\s*[*·✢✳✶✻✽]\s+\S+ for .*· done /          // a turn's end: ✻ Worked for 17s · done 1:37 AM
const GLYPH = /^\s*[*·✢✳✶✻✽]\s+\S/                        // either, or any other glyph line (✻ Waiting for 2 background agents to finish)
// Chiron's jev_screen.py (mtime 11-26 02:00:26Z; questions v7, JCS c17c1c0): the effort hint right-aligned on the row above the input box is
// interface text, not output
const CHROME = /^\s*[◐◑◒◓○●◔◕]\s+\w+\s+·\s+\/effort\s*$/
const LIMIT = /You've hit your .{0,40}limit|Claude Code will continue automatically at|^\s*❯\s*\/rate-limit-options/   // what Claude Code prints at a limit
const INTERRUPTED = /Interrupted · What should Claude do instead\?/   // what Claude Code prints when Esc cut the turn
const REPLY = /^\s*[●⏺]\s*\S/                             // the model's reply or a tool call line
const COMMAND = /^\s*❯\s*\/\S/                            // a slash command typed after it
const INCOMING = /^\s*←\s+\S/                             // a channel message that came in after it
/** Python's s[:n]: n code points */
export const cut = (s: string, n: number): string => { const a = Array.from(s); return a.length <= n ? s : a.slice(0, n).join('') }

export type Counted = { running_agents: number; shells: number; monitors: number; background_tasks: number }
/** limit_message_is_latest_output / interrupted_is_latest_output: null with no such text above the input box (key order as Chiron's: it is the JSON
 *  Jev reads) */
export type Found = { live_activity_line: string | null; limit_message_is_latest_output: boolean | null; interrupted_is_latest_output: boolean | null
  finished_marker_comes_after_it: boolean; tool_running_line: boolean; esc_to_interrupt: boolean }
export type Regions = {
  has_input_box: boolean; above_input_box?: string; input_box?: string; below_input_box?: string; screen_bottom?: string
  counted_by_program: Counted; found_by_program: Found
}
export type Parts = { st: Regions; above: string[]; box: string[]; below: string[] }

export function regionParts(text: string): Parts {
  const rows = String(text ?? '').split('\n').map(r => r.replace(/\s+$/, ''))
  const idx: number[] = []
  rows.forEach((r, i) => { if (RULE.test(r)) idx.push(i) })
  const keep = (rs: string[]) => rs.filter(r => r.trim()).map(r => cut(r, 200))
  let above: string[], box: string[] = [], below: string[] = []
  let st: Omit<Regions, 'counted_by_program' | 'found_by_program'>
  if (idx.length >= 2) {
    const top = idx[idx.length - 2]!, bot = idx[idx.length - 1]!
    above = keep(rows.slice(0, top).filter(r => !CHROME.test(r))).slice(-14)   // 「◐ medium · /effort」: interface text (box branch only, as Chiron's)
    box = keep(rows.slice(top + 1, bot))
    below = keep(rows.slice(bot + 1))
    st = { has_input_box: true, above_input_box: above.join('\n'), input_box: cut(box.join('\n'), 300), below_input_box: below.join('\n') }
  } else {
    above = keep(rows).slice(-18)
    st = { has_input_box: false, screen_bottom: above.join('\n') }
  }
  const blob = [...above, ...below].join('\n')
  // the counts are read below the input box only (Chiron's jev_screen.py, 11-26 01:30Z: with no box, nothing; a menu over the text above it read
  // 「ran 1 shell command」 as a running shell: eval screen lab-limit-options-menu.txt)
  const src = below.join('\n')
  let m = /(\d+) shells?/.exec(src); const shells = m ? parseInt(m[1]!, 10) : 0
  m = /(\d+) monitors?/.exec(src); const monitors = m ? parseInt(m[1]!, 10) : 0
  m = /(\d+) background tasks?/.exec(src); const background_tasks = m ? parseInt(m[1]!, 10) : 0   // v3 (Chiron 19:21Z): "· 2 background tasks · ctrl+t to show tasks"
  let agents = below.filter(r => /^\s*◯\s+\S/.test(r)).length
  // "Waiting for N background agents" counts only while it is the LAST marker line above the box: once they finish, the old line stays on the screen
  // under a later marker (✻ Crunched for 2s · done). Chiron WO-165 20:23Z (lab 20:11Z: background.agents 1 held for two minutes after it finished)
  const marks = above.filter(r => GLYPH.test(r))
  m = marks.length ? /Waiting for (\d+) background agents?/.exec(marks[marks.length - 1]!) : null
  if (m) agents = Math.max(agents, parseInt(m[1]!, 10))
  const actI: number[] = [], finI: number[] = []
  above.forEach((r, i) => { if (ACT.test(r)) actI.push(i); if (FIN.test(r)) finI.push(i) })
  // "is X the latest output above the input box" (questions v7 found_by_program.how, one rule for both facts): the last line matching X; null with
  // none; the finished marker directly under it is its own turn's, skipped; any later line that shows work (a reply or tool line ● ⏺, a live
  // activity line, another finished marker; for Interrupted also a slash command or an incoming channel message) means it is over (lab-relay 11-26:
  // eight limit screens, one Esc on a permission prompt)
  const latestIs = (pat: RegExp, also: RegExp[] = []): boolean | null => {
    let hit = -1
    above.forEach((r, i) => { if (pat.test(r)) hit = i })
    if (hit < 0) return null
    let after = above.slice(hit + 1)
    if (after.length && FIN.test(after[0]!)) after = after.slice(1)
    return !after.some(r => REPLY.test(r) || ACT.test(r) || FIN.test(r) || also.some(a => a.test(r)))
  }
  const found: Found = {
    live_activity_line: actI.length ? above[actI[actI.length - 1]!]!.trim() : null,
    limit_message_is_latest_output: latestIs(LIMIT),
    interrupted_is_latest_output: latestIs(INTERRUPTED, [COMMAND, INCOMING]),
    finished_marker_comes_after_it: !!(actI.length && finI.length && finI[finI.length - 1]! > actI[actI.length - 1]!),
    tool_running_line: above.slice(-10).some(r => r.includes('Running…')),
    esc_to_interrupt: blob.includes('esc to interrupt'),
  }
  return { st: { ...st, counted_by_program: { running_agents: agents, shells, monitors, background_tasks }, found_by_program: found }, above, box, below }
}
/** the state Chiron's script hands to Jev for one screen (jev_screen.py regions()) */
export const regions = (text: string): Regions => regionParts(text).st
/** WO-177 (Chiron 03:41Z, ③ and ⑤): what the program's own cut says about work on the screen, the one reading of found_by_program's activity facts.
 *  busy: a live activity line with no finished marker after it, a "Running…" line, or "esc to interrupt"; compacting: that live activity line says
 *  Compacting. On Chiron's 64 labelled screens (screen-eval, regions-v7.json) the 6 working and 2 compacting ones have them, the 56 others (idle,
 *  background running, interrupted, usage limit, waiting, a shell) none. Read by JevJudge (a working / compacting verdict needs them: contradiction) and by
 *  the record when there is no verdict (recordView: busy, judged_by program) */
export function screenActivity(st: Pick<Regions, 'found_by_program'>): { busy: boolean; compacting: boolean } {
  const f = st.found_by_program
  const live = !!f.live_activity_line && !f.finished_marker_comes_after_it
  return { busy: live || f.tool_running_line || f.esc_to_interrupt, compacting: live && /Compacting/i.test(f.live_activity_line ?? '') }
}

// ------------------------------------------------------------------ WO-168 stage two: the program's facts of a screen, for the record
// Chiron 05:24:56Z (WO-168): the record shows a menu even with no judge (Jev down, SCREEN_JUDGE=program), as 1.58.7's activity facts show working and
// compacting: a menu is open when the screen has no input box and its last rows are a selection footer. The program also reads, from the same screen, each
// option as the screen shows it (its number, its text, the cursor on it), the question above them, and whether real text is typed in the input box (the
// capture keeps the escapes: dim text there is Claude Code's suggestion). The menu's kind is the judge's; the program names a kind only where a reader that
// is retired here had a rule for it (the usage-limit options: the duty officer's and modal-guard's; the resume list: the busy checks'), else null
export type MenuOption = { n: number | null; text: string; cursor: boolean }
export type ScreenFacts = {
  menu_open: boolean
  menu_kind: Exclude<VerdictMenu, 'none'> | null
  /** the menu's text above its options (rule rows dropped); '' with no menu */
  question: string
  options: MenuOption[]
  /** real text in the input box (not dim); null: no input box, or a screen captured without escapes */
  input_typed: boolean | null
  /** WO-168 (Chiron #200727): the usage-limit line Claude Code leaves under the prompt (「Usage limit reached · … Continuing automatically at … · Esc to
   *  cancel · /usage-credits」) with the input box there: not a menu; whether a limit is hit is the keeper's file, not this text */
  usage_notice?: boolean
}
/** the footer Claude Code draws under a menu, a dialog or a panel (Enter to confirm · Esc to cancel, Esc to cancel · Tab to amend, Enter to select, the
 *  model picker's Enter to set as default, the autocompact offer's enter confirm · esc not now, a panel's Esc to cancel) */
const MENU_FOOTER = /\b[Ee]sc to (cancel|exit|go back|close)\b|\b[Ee]nter to (confirm|select|set|continue)\b|\benter confirm\b|\besc not now\b/
const FOOTER_PART = /^\s*(·|↑\/↓|←\/→)/                    // the footer's first part when it wraps, or a hint row above it (◐ Medium effort ←/→ to adjust)
// the border a menu or a dialog is drawn under; Claude Code may right-align its effort hint on it (「▔▔▔…▔  ◐ medium · /effort」: real screen, 2.1.322)
const MENU_TOP = /^\s*(?:▔{8,}|[─━]{20,})(?:\s.*)?$/
const RULE_ROW = /^\s*[─━╌┄▔]{8,}\s*$/                   // a rule inside it
const NUM_OPT = /^(\s*)([❯›▶>])?(\s*)(\d+)\.\s+(.*?)\s*$/
const CUR_OPT = /^(\s*)❯\s+(\S.*?)\s*$/
const RATE_LIMIT_MENU = /Stop and wait|Switch to usage credits|Upgrade your plan/     // duty-officer.ts isRateLimitMenu, ratelimit-modal-guard.sh
const RATE_LIMIT_FOOTER = /Esc.*cancel|Enter.*confirm/
const RESUME_MENU = /Resume session/                                                 // channel-bot-control.ts isPickerOpen
const indentOf = (r: string): number => r.length - r.trimStart().length
const tidy = (s: string): string => s.replace(/[│╮╯╰╭]+\s*$/, '').replace(/^\s*[│]\s?/, '').trim()
// WO-168 (Chiron 11-28 00:27Z, item 7): a list longer than the screen draws its scroll arrow in the cursor's gutter (「   ↓ /clear」, the resume picker,
// real screen lab-resume-tall): the arrow is the gutter, not the row's text or its indent
const GUTTER_ARROW = /^(\s*)[↑↓](?=\s)/
const ungutter = (r: string): string => r.replace(GUTTER_ARROW, '$1 ')
/** how a row is drawn (its escapes): whether its first letter is bold, and whether every letter of it has a colour of its own (a foreground set, or dim)
 *  rather than the terminal's default. null: no letters */
export function rowStyle(ansi: string): { bold: boolean; coloured: boolean } | null {
  let bold = false, fg = false, dim = false, first: boolean | null = null, all = true, any = false
  const re = /\x1b\[([0-9;:]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|([^\x1b]+)/g
  for (let m = re.exec(ansi); m; m = re.exec(ansi)) {
    if (m[2] != null) {
      if (!m[2].replace(/[\s ]/g, '')) continue
      any = true
      if (first == null) first = bold
      if (!fg && !dim) all = false
      continue
    }
    if (m[1] == null) continue                                             // another sequence (a hyperlink, a cursor move): not text
    const ps = m[1] === '' ? ['0'] : m[1].split(/[;:]/)
    for (let k = 0; k < ps.length; k++) {
      const p = ps[k]!
      if (p === '0' || p === '') { bold = false; fg = false; dim = false }
      else if (p === '1') bold = true
      else if (p === '2') dim = true
      else if (p === '22') { bold = false; dim = false }
      else if (p === '39') fg = false
      else if (p === '38' || p === '48') { const set = p === '38'; k += ps[k + 1] === '5' ? 2 : ps[k + 1] === '2' ? 4 : 0; if (set) fg = true }
      else if (/^(3[0-7]|9[0-7])$/.test(p)) fg = true
    }
  }
  return any ? { bold: !!first, coloured: all } : null
}
/** the options of a menu block: the last clean 1..N numbered run with a live cursor on one of them; else, with no numbered run, the rows at the cursor
 *  row's column (the trust prompt, the autocompact offer, the resume picker, /mcp), n null; fewer than two: none. An option is its own row: a row under
 *  it at the label's column is a description in some menus (the refusal picker's 「Continue on Opus 4.8 now, …」, a resume session's 「3 hours ago ·
 *  HEAD · 631.3KB」) and a wrapped label in others, and the plain text cannot tell them apart, so neither is joined. `first`: the block index of the
 *  first option.
 *  WO-168 (Chiron 11-28 00:27Z, item 7): `ansi`, the same rows as captured: a heading at the options' column is not an option. Claude Code draws a
 *  section heading bold (/mcp 「Built-in MCPs (always available)」) or, as a label, all in a colour of its own with no option right above it (the
 *  resume picker's project 「claude-lab-relay」 under the search box); a row in that colour right under an option is that option's description and
 *  stays. `headings`: their block indexes (not the question either). Without escapes (a screen's text handed in) no row is taken as a heading */
export function menuOptions(block0: string[], ansi: string[] | null = null): { options: MenuOption[]; first: number; headings: number[] } {
  const block = block0.map(ungutter)
  type R = { i: number; n: number; text: string; cursor: boolean }
  const rows: R[] = []
  block.forEach((r, i) => { const m = NUM_OPT.exec(r); if (m) rows.push({ i, n: parseInt(m[4]!, 10), text: m[5]!, cursor: !!m[2] }) })
  let run: R[] = []
  for (const x of rows) { if (x.n === 1) run = [x]; else if (run.length && x.n === run[run.length - 1]!.n + 1) run.push(x) }
  if (run.length >= 2 && run.some(x => x.cursor)) return { options: run.map(x => ({ n: x.n, text: tidy(x.text), cursor: x.cursor })), first: run[0]!.i, headings: [] }
  const none = { options: [] as MenuOption[], first: -1, headings: [] as number[] }
  let ci = -1
  for (let i = block.length - 1; i >= 0; i--) if (CUR_OPT.test(block[i]!)) { ci = i; break }
  if (ci < 0) return none
  const col = block[ci]!.indexOf(CUR_OPT.exec(block[ci]!)![2]!)
  const at = (r: string): boolean => !!r.trim() && (indentOf(r) === col || (CUR_OPT.test(r) && r.indexOf(CUR_OPT.exec(r)![2]!) === col))
  let first = ci
  for (let i = ci - 1; i >= 0; i--) { const r = block[i]!; if (!r.trim()) continue; if (at(r)) first = i; else if (indentOf(r) < col) break }
  const style = (i: number) => ansi && ansi.length === block.length ? rowStyle(ansi[i]!) : null
  const opts: MenuOption[] = [], headings: number[] = []
  let firstOpt = -1, prevOpt = -1
  for (let i = first; i < block.length; i++) {
    const r = block[i]!
    if (!r.trim()) continue
    if (at(r)) {
      const m = CUR_OPT.exec(r), s = m ? null : style(i)
      if (s && (s.bold || (s.coloured && prevOpt !== i - 1))) { headings.push(i); continue }
      opts.push({ n: null, text: tidy(m ? m[2]! : r), cursor: !!m })
      if (firstOpt < 0) firstOpt = i
      prevOpt = i
    } else if (indentOf(r) < col) break
  }
  return opts.length >= 2 ? { options: opts, first: firstOpt, headings } : none
}
/** real text in the input box: the box's rows as captured (escapes kept), the prompt glyph and the box border left out, dim text left out */
export function inputTyped(boxAnsi: string[]): boolean {
  for (let k = 0; k < boxAnsi.length; k++) {
    let dim = false, text = ''
    const row = boxAnsi[k]!
    const re = /\x1b\[([0-9;:]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|([^\x1b]+)/g
    for (let m = re.exec(row); m; m = re.exec(row)) {
      if (m[2] != null) { if (!dim) text += m[2]; continue }
      if (m[1] == null) continue                                           // another sequence: not text
      const ps = m[1] === '' ? ['0'] : m[1].split(/[;:]/)
      for (const p of ps) { if (p === '2') dim = true; else if (p === '0' || p === '22' || p === '') dim = false }
    }
    let t = text.replace(/ /g, ' ').replace(/[│]/g, ' ').trim()
    if (k === 0 || /^[❯>!]\s/.test(t) || t === '❯' || t === '>' || t === '!') t = t.replace(/^[❯>!](\s|$)/, '').trim()
    if (t) return true
  }
  return false
}
// the two layouts of the refusal-fallback picker, anchored as ratelimit-modal-guard.sh:106-107 anchors them (option rows at column 0-4, so the same words
// inside tool output, indented further, never match); layout 2 draws no footer
const REFUSAL_1 = [/^(❯ |  )[0-9]\. Switch automatically/m, /^(❯ |  )[0-9]\. Stay on (Opus|Fable|Sonnet)/m, /^Enter to select .*Esc to cancel/m]
const REFUSAL_2 = [/^ {0,4}Session paused/m, /^ {0,4}(❯ +)?[0-9]\. Switch to (Opus|Fable|Sonnet|Haiku)/m, /^ {0,4}(❯ +)?[0-9]\. Edit prompt and retry/m]
// the Yes / No confirm of /model and /effort (channel-bot-control.ts isYesNoConfirmPickerOpen); it draws no footer either
const CONFIRM = [/^ {0,4}(Switch model\?|Change effort level\?)/m, /❯\s*1\.\s*Yes/i, /No,\s*go\s*back/i]
const FOOTER_ROWS = 12                                   // a footer is one of the last 12 non-blank rows (a task list or a retry line can sit under a menu)
/** the program's facts of one screen: `visible` its rows (plain), `visibleAnsi` the same rows as captured (null: no escapes: input_typed unknown) */
export function screenFacts(visible: string, visibleAnsi: string | null, st: Pick<Regions, 'has_input_box'>): ScreenFacts {
  const rows = String(visible ?? '').replace(/\n$/, '').split('\n').map(r => r.replace(/\s+$/, ''))
  const none: ScreenFacts = { menu_open: false, menu_kind: null, question: '', options: [], input_typed: null }
  if (st.has_input_box) {
    if (hasUsageNotice(rows)) none.usage_notice = true
    if (visibleAnsi == null) return none
    const idx: number[] = []
    rows.forEach((r, i) => { if (RULE.test(r)) idx.push(i) })
    const ansiRows = String(visibleAnsi).replace(/\n$/, '').split('\n').map(r => r.replace(/\s+$/, ''))
    if (idx.length < 2 || ansiRows.length !== rows.length) return none
    return { ...none, input_typed: inputTyped(ansiRows.slice(idx[idx.length - 2]! + 1, idx[idx.length - 1]!)) }
  }
  const ne: number[] = []
  rows.forEach((r, i) => { if (r.trim()) ne.push(i) })
  if (!ne.length) return none
  const tail30 = ne.slice(-30).map(i => rows[i]!).join('\n')
  const refusal = REFUSAL_1.every(r => r.test(tail30)) || REFUSAL_2.every(r => r.test(tail30))
  const confirm = CONFIRM.every(r => r.test(tail30))
  // the footer: the lowest of the last FOOTER_ROWS non-blank rows that reads as one, at a menu's indent (its wrapped first part, the row above, joins it)
  let footer = -1
  for (const i of ne.slice(-FOOTER_ROWS).reverse()) { if (indentOf(rows[i]!) <= 8 && MENU_FOOTER.test(rows[i]!)) { footer = i; break } }
  if (footer < 0 && !refusal && !confirm) return none
  let end = footer >= 0 ? footer : ne[ne.length - 1]! + 1
  if (footer >= 0) { const k = ne.indexOf(footer); if (k > 0 && FOOTER_PART.test(rows[ne[k - 1]!]!) && !NUM_OPT.test(rows[ne[k - 1]!]!)) end = ne[k - 1]! }
  // the window: the 40 rows above the footer; WO-168 (Chiron 11-28 00:27Z, item 1): a menu taller than that (the resume picker on a 50-row pane: its
  // border on row 6, its title 「Resume session (1 of 37)」 on row 7, the footer on row 49) reaches up to its own top border, on the visible screen
  let from = Math.max(0, end - 40)
  for (let j = end - 1; j >= 0; j--) if (MENU_TOP.test(rows[j]!)) { if (j < from) from = j; break }
  const win = rows.slice(from, end)
  const ansiAll = visibleAnsi == null ? null : String(visibleAnsi).replace(/\n$/, '').split('\n')
  const winAnsi = ansiAll && ansiAll.length === rows.length ? ansiAll.slice(from, end) : null
  const topAbove = (i: number): number => { for (let j = i - 1; j >= 0; j--) if (MENU_TOP.test(win[j]!)) return j; return -1 }
  // the options: a numbered run anywhere in the window (a rule between two options, as in the refusal picker, is inside the menu); with none, an
  // unnumbered list under the menu's top border only (a `❯ /command` echo above the border is history, not a cursor)
  let { options, first, headings } = menuOptions(win, winAnsi)
  let top: number
  if (options.length && options[0]!.n != null) top = topAbove(first)
  else {
    top = topAbove(win.length)
    const r = menuOptions(win.slice(top + 1), winAnsi ? winAnsi.slice(top + 1) : null)
    options = r.options; first = r.first >= 0 ? r.first + top + 1 : -1; headings = r.headings.map(i => i + top + 1)
  }
  // the question: the menu's text above its options. Not part of it: a heading of the list, and a box drawn inside the menu above the options (the
  // resume picker's search field 「╭───╮ │ ⌕ Search… │ ╰───╯」, item 7: the field is not the question)
  const qEnd = first >= 0 ? first : win.length
  const skip = new Set(headings)
  for (let i = top + 1; i < qEnd; i++) {
    if (!/^\s*╭─/.test(win[i]!)) continue
    let j = i + 1
    while (j < qEnd && !/^\s*╰─/.test(win[j]!)) j++
    if (j < qEnd) { for (let k = i; k <= j; k++) skip.add(k); i = j }
  }
  const qRows = win.slice(top + 1, qEnd).map((r, k) => skip.has(top + 1 + k) ? '' : r).filter(r => r.trim() && !RULE_ROW.test(r)).map(r => tidy(r)).filter(Boolean)
  const question = qRows.join('\n')
  const said = [question, ...options.map(o => o.text)].join('\n')
  const kind = refusal ? 'refusal_fallback' as const : confirm ? 'switch_confirm' as const
    : RATE_LIMIT_MENU.test(said) && footer >= 0 && RATE_LIMIT_FOOTER.test(rows[footer]!) ? 'usage_limit_options' as const
    : RESUME_MENU.test(question) ? 'resume_picker' as const : null
  return { menu_open: true, menu_kind: kind, question, options, input_typed: null }
}

// ------------------------------------------------------------------ the hash: what can change the answer
const digits = (s: string): string => s.replace(/\d+(?:[.,:]\d+)*/g, '#')
const AGENT_ROW = /^\s*◯\s+(\S+)/                          // a running sub-agent row: its kind stays, its live activity text changes all the time
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()     // column alignment moves when a timer gains a digit
/** one hashed line: digits masked, whitespace runs collapsed; a live activity line counts only as being there (its verb changes mid-turn, its glyph
 *  every second); a finished marker or any other glyph line with its glyph normalised */
const hl = (l: string): string => ACT.test(l) ? (/Compacting/i.test(l) ? '<activity line: compacting>' : '<activity line>')
  : squash(digits(GLYPH.test(l) ? l.replace(/^(\s*)[*·✢✳✶✻✽]/, '$1✻') : l))
// right-aligned notices ("stop hook problem · ctrl+o to see") and the usage notice ("You've used 79% of your weekly limit"): not a state (measured
// 11-25 19:27–19:31Z on a live pane: each one that came and went was a call)
const NOTICE = /^\s{16,}\S|You've used \d+% of your/
const parens = (l: string): number => (l.match(/\(/g)?.length ?? 0) - (l.match(/\)/g)?.length ?? 0)
/** lines as the hash reads them: notices left out; an activity line and the line(s) its parenthesis wraps onto ("… (running Stop hooks… 2/5 · 1m 27s ·"
 *  / "↓ 2.7k tokens)") are one line, and the wrap point moves as the timer grows */
function hashRows(rows: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < rows.length; i++) {
    const l = rows[i]!
    if (NOTICE.test(l)) continue
    if (ACT.test(l)) for (let d = parens(l), k = 0; d > 0 && k < 2 && i + 1 < rows.length; k++) d += parens(rows[++i]!)
    out.push(hl(l))
  }
  return out
}
/** the lines the hash is taken of: Chiron's list (WO-165 19:23Z, "only what can change the answer"; digits masked): has_input_box; whether there is
 *  an activity line, a finished marker after it, a "Running…", an "esc to interrupt" (and, since questions v6/v7, whether a limit message or an
 *  Interrupted is the latest output); the four counts; below_input_box in full; the last 2 lines above the input box; with no input box, screen_bottom in full. Masks
 *  on top, for the same purpose: a live activity line's text (and its wrapped tail), a ◯ sub-agent row's activity text (its kind stays; how many
 *  rows there are is a count), notices and whitespace runs are not part of it (exported for the tests) */
export function hashLines(p: Parts): string[] {
  const f = p.st.found_by_program, c = p.st.counted_by_program
  const out: string[] = [p.st.has_input_box ? 'box' : 'nobox',
    JSON.stringify([!!f.live_activity_line, f.finished_marker_comes_after_it, f.tool_running_line, f.esc_to_interrupt, f.limit_message_is_latest_output,
      f.interrupted_is_latest_output]),
    JSON.stringify([c.running_agents, c.shells, c.monitors, c.background_tasks])]
  if (p.st.has_input_box) {
    out.push(...hashRows(p.above).slice(-2))
    out.push('—below—')
    for (const l of p.below) { if (NOTICE.test(l)) continue; const a = AGENT_ROW.exec(l); out.push(a ? `◯ ${a[1]}` : hl(l)) }
  } else out.push(...hashRows(p.above))
  return out
}
export function screenHash(p: Parts): string {
  return createHash('sha1').update(hashLines(p).join('\n')).digest('hex').slice(0, 16)
}
/** the screen's text as it is (only for "has anything changed since the last ask": the 60 s re-ask) */
export function rawHash(p: Parts): string {
  const st = p.st
  return createHash('sha1').update(JSON.stringify([st.above_input_box, st.input_box, st.below_input_box, st.screen_bottom])).digest('hex').slice(0, 16)
}


// ------------------------------------------------------------------ 一 the fixed output: ScreenVerdict (its master copy: JCS screen-status/README.md)
/** the states a judge may answer. An option Chiron adds to questions.json is added here as well; one that is not does not reach the record */
export const VERDICT_STATES = ['working', 'idle', 'idle_background_running', 'waiting_for_human', 'interrupted', 'usage_limit', 'compacting', 'starting'] as const
/** the menus a judge may name */
// WO-168 item 6 (Chiron's questions v8 draft, 05:54Z): refusal_fallback (the picker after Claude Code's safeguards flagged the session) and switch_confirm
// ("Switch model?" / "Change effort level?" Yes / No, go back). The daemon knows them before v8 is published; with v7 a judge never names them
export const VERDICT_MENUS = ['none', 'permission', 'model_picker', 'trust_folder', 'usage_limit_options', 'resume_picker', 'plan_or_question', 'login',
  'refusal_fallback', 'switch_confirm', 'other'] as const
export type VerdictState = typeof VERDICT_STATES[number]
export type VerdictMenu = typeof VERDICT_MENUS[number]
/** what a judge answers for one screen: one of the states, one of the menus, how sure (0–1), who judged (a label: nothing below reads it to decide) */
export type ScreenVerdict = { state: VerdictState; menu: VerdictMenu; p: number; by: 'jev' | 'program'
  /** WO-168 item 6: a menu kind the judge named that is not in VERDICT_MENUS (a newer questions file): the verdict is taken with menu `other` and the
   *  judge's word kept here (detail.menu_raw), so a new kind never blanks a screen's verdict */
  menu_raw?: string }
const STATES: ReadonlySet<string> = new Set(VERDICT_STATES), MENUS: ReadonlySet<string> = new Set(VERDICT_MENUS)
export const isVerdictState = (s: unknown): s is VerdictState => typeof s === 'string' && STATES.has(s)
export const isVerdictMenu = (s: unknown): s is VerdictMenu => typeof s === 'string' && MENUS.has(s)
/** a verdict as the interface defines it (the two lists, p in 0–1, by jev | program); anything else a judge hands back is no verdict */
export function isVerdict(v: unknown): v is ScreenVerdict {
  const x = v as ScreenVerdict | null
  return !!x && typeof x === 'object' && isVerdictState(x.state) && isVerdictMenu(x.menu) && typeof x.p === 'number' && Number.isFinite(x.p) && x.p >= 0
    && x.p <= 1 && (x.by === 'jev' || x.by === 'program') && (x.menu_raw === undefined || (typeof x.menu_raw === 'string' && x.menu === 'other'))
}
/** the four fields only (/healthz, the question bank) */
export const verdictFields = (v: ScreenVerdict): ScreenVerdict => ({ state: v.state, menu: v.menu, p: v.p, by: v.by, ...(v.menu_raw !== undefined ? { menu_raw: v.menu_raw } : {}) })

// ------------------------------------------------------------------ 二 the replaceable piece: ScreenJudge, and the switch point
export interface ScreenJudge {
  /** its name as SCREEN_JUDGE names it */
  readonly name: string
  /** the verdict for this screen; null: it cannot tell this time (the record is statusOf's for this screen; asked about it again only by the 60 s
   *  re-ask). Rejected: the judging failed (asked again after retryMs, then every refreshMs, until it answers or the screen changes) */
  judge(parts: Parts): Promise<ScreenVerdict | null>
  /** why it cannot judge now ('' or absent: it can) */
  ready?(): string
  /** not asked before this moment (ms; a pause after a 429) */
  notBefore?(): number
  /** its own counts, for /healthz */
  health?(): Record<string, unknown>
  /** WO-177 五 (Chiron's ticket): what it judges by now (JevJudge: the questions file's sha); null or absent: one version only. A new version is a new
   *  judge to the reader: the answers and the cache are dropped and the screen is asked again at the next look; the question bank writes the same screen
   *  again under the new version */
  version?(): string | null
}
export const SCREEN_JUDGE_NAMES = ['jev', 'program'] as const
export type ScreenJudgeName = typeof SCREEN_JUDGE_NAMES[number]
/** SCREEN_JUDGE as a judge's name: jev (the default; also for a value that names no judge: `unknown` says which) or program */
export function screenJudgeName(v: string | null | undefined): { name: ScreenJudgeName; unknown?: string } {
  const s = String(v ?? '').trim().toLowerCase()
  if (!s || s === 'jev') return { name: 'jev' }
  if (s === 'program') return { name: 'program' }
  return { name: 'jev', unknown: s }
}
/** the switch point. jev: JevJudge (screen-judge-jev.ts). program: the program judge, not written yet: null, and the record is statusOf's (judged_by
 *  program). Once it is written it is handed in as `program` here and nothing else changes */
export function judgeFor(name: ScreenJudgeName, judges: Partial<Record<ScreenJudgeName, ScreenJudge | null>>): ScreenJudge | null {
  return judges[name] ?? null
}

// ------------------------------------------------------------------ 三 the program's output: one status record from a verdict
const r2 = (x: number): number => Math.round(x * 100) / 100
/** statusOf's offline reasons that mean the process is gone (the OS says so): offline, the judge not asked */
export const GONE = new Set(['pid_gone', 'pid_reused'])
export const gone = (p: StatusView): boolean => p.state === 'offline' && GONE.has(String((p.detail as any)?.reason ?? ''))
const pick = (o: Record<string, unknown>, ks: string[]): Record<string, unknown> => Object.fromEntries(ks.filter(k => o[k] !== undefined).map(k => [k, o[k]]))
/** no verdict in use: statusOf's view, labelled */
export const programView = (p: StatusView): StatusView => ({ ...p, detail: { ...(p.detail ?? {}), judged_by: 'program' } })
/** the remaining-quota percentage stays out of the record (JCS screen-status/README.md) */
const noPct = (s: string): string => s.replace(/\d+(?:[.,]\d+)?\s*%/g, '#%')
// ------------------------------------------------------------------ the observation (WO-169 part 2, Chiron 00:29Z: CONTRACT v1 section 3's shape)
/** Onsen's contract v1 (rescue-site/onsen-ui/CONTRACT.md §3), the part this daemon observes; Onsen adds valid_until, rollup, phrase and line, and turns
 *  a reporter that went quiet into unknown itself */
export type Trigger = { kind: 'message'; conversation_id: string; message_id: string } | { kind: 'thread'; thread_id: string } | { kind: 'schedule' } | { kind: 'other' }
export type TurnFact = { id: string; started_at: string; trigger: Trigger }
export type LastTurn = { id: string; outcome: 'done' | 'interrupted' | 'failed'; ended_at: string }
export type BlockerReason = 'permission' | 'input_required' | 'usage_limit' | 'dependency' | 'stalled'
export type Blocker = { id: string; reason: BlockerReason; since: string; until: string | null; menu_kind: Exclude<VerdictMenu, 'none'> | null; assignee: string | null
  /** WO-176: the open Action for this menu when the daemon knows it (RecordFacts.actionFor), else null (Onsen matches it itself) */
  action_id: string | null; summary: string }
export type ObsSession = { id: string; kind: 'main' | 'lane'; thread_id: string | null; activity: 'idle' | 'running' | 'paused' | 'stuck' | 'unknown'
  activity_since: string | null; turn: TurnFact | null; doing: { kind: 'thinking' | 'tool' | 'compacting' | 'waiting_subagents'; tool: string | null; since: string } | null
  blockers: Blocker[]; last_turn: LastTurn | null }
export type Observation = { connector?: string; held_item_ids?: string[]; presence: 'online' | 'offline'; presence_reason: null | 'disconnected' | 'process_gone'; lifecycle: 'ready' | 'starting' | 'stopped'
  main_session_id: string | null; sessions: ObsSession[]; background: { agents: number | null; shells: number | null; tasks: number | null; monitors: number | null } | null
  queue: { pending: number | null; unread_by_member: number | null }; last_activity_at: string | null; reported_at: string
  evidence: { source: 'classifier' | 'runtime'; confidence: number | null } }
/** what the program knows beside statusOf's view and the screen, for the record and its observation */
export type RecordFacts = {
  /** the text of a limit the program (usage_wall.py's state) cleared after the newest limit message in the transcript: that same text still on the
   *  screen is the cleared wall's, not a new one (11-26 07:13Z: chiron, eurymedon, angelia held as walled for 20 min after probe_after_switch) */
  cleared_limit_text?: string | null
  /** the main's pane runs Claude Code (the reader's last look); null: not looked at */
  alive?: boolean | null
  /** now (ms): reported_at, and the moment a since begins */
  now?: number
  /** when `key` first had `value` (ms; a value that changes starts again): activity_since, a blocker's or a doing's since */
  since?: (key: string, value: string) => number
  /** the main's Claude Code session (the registry's, else the lanes'); null: none known */
  session_id?: string | null
  /** the main's open turn as the program knows it (lanes on: M2 and its hooks; off: the transcript); null: none open */
  turn?: TurnFact | null
  /** the thread of the item that opened that turn (any kind); null: none known */
  turn_thread?: string | null
  last_turn?: LastTurn | null
  /** the main's queue: not yet handed into its conversation / handed in, not yet in a turn; null: not known */
  queue?: { pending: number | null; unread_by_member: number | null } | null
  /** a lane's thread is a schedule's (its run's trigger is the schedule) */
  scheduleThread?: (thread: string) => boolean
  /** WO-180 (Chiron 04:42Z, 1): the duty officer watches the main's pane: every menu on it is the officer's first */
  dutyWatches?: boolean
  /** this agent's own Onsen member name: a usage-limit menu waits on its own connector (WO-168, Chiron #200727). ScreenStatus fills it with its agent */
  self?: string | null
  /** WO-180 (Chiron 04:42Z, 2): the person the main's questions go to on Telegram, as an Onsen member: access.json's recipients through the mapping the
   *  Actions' assignees use (Onsen.assigneesOf; lab-relay: joey-test). Not given: the owner (assigneesOf's own fallback) */
  person?: string | null
  /** WO-180 (Chiron 04:42Z, 1): the duty officer's open question to a person about a menu of this kind on the main (its Action, once Onsen made it, and
   *  the first person asked); null: it asked nobody */
  asked?: (menu: Exclude<VerdictMenu, 'none'>) => { action_id: string; assignee: string | null } | null
  /** WO-176: the open Action of the main's permission prompt (the channel's; the duty officer's question about it uses the same one); null: none */
  actionFor?: (menu: Exclude<VerdictMenu, 'none'>) => string | null
}
const BLOCKER_SUMMARY: Record<BlockerReason, string> = { permission: '等待權限核准', input_required: '選單等待選擇', usage_limit: '用量受限，等待恢復',
  dependency: '等待外部作業', stalled: '回合停滯，沒有動靜' }
const menuReason = (m: string | null): BlockerReason => m === 'permission' ? 'permission' : m === 'usage_limit_options' ? 'usage_limit' : 'input_required'
/** statusOf's waitingFor (Claude Code's registry: "permission prompt", "dialog open") as a menu kind, when no verdict names it */
const registryMenu = (w: unknown): Exclude<VerdictMenu, 'none'> => /permission/i.test(String(w ?? '')) ? 'permission' : 'other'
/** WO-168: the menu kinds Onsen's observation takes (fleet-core app/v1_status.py MENUS; it answers 400 to the whole observation for any other, CONTRACT v1).
 *  A kind the daemon knows and Onsen does not yet (refusal_fallback, switch_confirm) goes to the observation as `other` until Onsen lists it */
const OBSERVATION_MENUS: ReadonlySet<string> = new Set(['permission', 'model_picker', 'trust_folder', 'usage_limit_options', 'resume_picker', 'plan_or_question', 'login', 'other'])
const obsMenu = (m: Exclude<VerdictMenu, 'none'> | null): Exclude<VerdictMenu, 'none'> | null => m == null || OBSERVATION_MENUS.has(m) ? m : 'other'
const isoMs = (ms: number): string => new Date(ms).toISOString()
/** WO-176: a blocker's Action from the daemon (never fails the observation) */
const actionOf = (f: RecordFacts, m: Exclude<VerdictMenu, 'none'> | null): string | null => { if (!m || !f.actionFor) return null; try { return f.actionFor(m) ?? null } catch { return null } }
/** the owner, when the facts name no person (Onsen.assigneesOf falls back to it the same way) */
const OWNER = 'joey'
/** WO-180 (Chiron 04:42Z, 1 and 2; CONTRACT §3 「有選單時必有明確成員」「同一選單的 action assignees 包含 blocker.assignee」): who a blocker of the main waits
 *  on, and its Action. One rule:
 *  - a permission prompt: the person it went to on Telegram, with that prompt's Action (its assignees are those people);
 *  - a usage-limit menu: this agent itself (its connector takes it; WO-168, Chiron #200727);
 *  - any other menu: the duty officer, whatever the kind, while it watches the pane (it handles each one first: by a ruling, or by its leaning when none
 *    covers it); once it asked a person, that question's Action and the person asked; the pane not watched: the person;
 *  - no menu (a wall without its options, a stalled turn): nobody.
 *  The person is never a fixed name: access.json's, as the Actions' assignees (lab-relay: joey-test) */
function assigned(f: RecordFacts, m: Exclude<VerdictMenu, 'none'> | null): { assignee: string | null; action_id: string | null } {
  if (!m) return { assignee: null, action_id: null }
  const person = f.person || OWNER
  if (m === 'permission') return { assignee: person, action_id: actionOf(f, m) }
  // WO-168 (Chiron #200727, 11-27; v3): the usage-limit menu is not the duty officer's and is not put to a person: this agent's own connector takes it
  // (「停下來等」, WO-204). The member itself, so the blocker still names who acts (CONTRACT §3: a menu has a member); no Action
  if (m === 'usage_limit_options') return { assignee: f.self || null, action_id: null }
  let q: { action_id: string; assignee: string | null } | null = null
  try { q = f.asked?.(m) ?? null } catch {}
  if (q?.action_id) return { assignee: q.assignee || person, action_id: q.action_id }
  return { assignee: f.dutyWatches ? 'duty-officer' : person, action_id: null }
}

/** the one status record, from a verdict (null: no verdict) and the program's facts: the regions' counts and statusOf's (the process, the usage wall,
 *  the turn's start and tool, stuck). The order is fixed (Chiron WO-169, 00:29Z): offline (the process is gone: statusOf's view) → starting (the
 *  process is there and not registered yet: statusOf's no_registration with Claude Code in the pane, or the verdict says starting) → usage limit (the
 *  verdict says so, or statusOf's wall) → waiting (a menu) → compacting → stuck (the verdict says working and statusOf counted the turn silent past
 *  its threshold: stuck stays, with the turn's start and tool) → busy → idle. No verdict: past offline and starting, statusOf's view as it is. The
 *  program's own detail stays: queued_joey, the wall, lane runs, the reason statusOf has for an offline the screen contradicts (a session this daemon
 *  has no stream with, one still registering). WO-177 ⑤: no judge's verdict but a screen that shows work: the program's own (programVerdict: working or
 *  compacting, judged_by program, judge_p 1). detail.judged_by = verdict.by (program: no verdict) and judge_p = verdict.p are labels: nothing
 *  downstream decides by them.
 *  The same call gives the observation (CONTRACT v1 §3; Chiron's table, WO-169 00:29Z) from the same inputs: presence, lifecycle, the main's session
 *  (its activity, turn and trigger, doing, blockers, last turn), one session per running lane, the screen's background counts, the queue, the evidence */
/** WO-168 stage two: the screen a record is composed for. `hash`/`seen_at`: which screen and when it was looked at (detail.screen: anything that presses
 *  keys compares it with a look of its own first); `facts`: the program's facts of that screen (screenFacts) */
export type ScreenCtx = { hash: string; seen_at: number; facts: ScreenFacts | null
  /** the screen came from a look of the one capture (detail.screen is written); false: a screen's text handed in (tests), no look time */
  look?: boolean }
export function composeRecord(v: ScreenVerdict | null, st: Regions | null, prog: StatusView, f: RecordFacts = {}, sc?: ScreenCtx | null): { view: StatusView; observation: Observation } {
  const view = recordView(v, st, prog, f, sc ?? null)
  return { view, observation: observe(v, st, prog, view, f) }
}
/** the record alone (composeRecord's view) */
export function publishView(v: ScreenVerdict | null, st: Regions | null, prog: StatusView, f: RecordFacts = {}): StatusView {
  return composeRecord(v, st, prog, f).view
}
/** WO-177 ⑤ (Chiron 03:41Z): the program's own verdict when no judge's is there: working, or compacting, on an activity fact of the screen
 *  (screenActivity), else none. It goes the same way as a judge's (the order below), so the record holds items and turn_end the same with Jev up or down.
 *  WO-168 (Chiron 05:24:56Z, 紀錄要補的 7): a menu open by the program's facts (screenFacts: no input box and a selection footer, or a layout the program
 *  knows) is waiting for a human, its kind the program's (null: other) */
export function programVerdict(st: Regions, facts?: ScreenFacts | null): ScreenVerdict | null {
  if (facts?.menu_open && !st.has_input_box) return { state: 'waiting_for_human', menu: facts.menu_kind ?? 'other', p: 1, by: 'program' }
  const a = screenActivity(st)
  return a.busy ? { state: a.compacting ? 'compacting' : 'working', menu: 'none', p: 1, by: 'program' } : null
}
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()
/** WO-168: the menu's kind for the record: the judge's, unless it could only say `other` and the program knows the layout */
const menuKindOf = (v: ScreenVerdict, facts: ScreenFacts | null): Exclude<VerdictMenu, 'none'> =>
  v.state === 'waiting_for_human' && v.menu !== 'none' && v.menu !== 'other' ? v.menu : facts?.menu_kind ?? (v.menu === 'none' ? 'other' : v.menu)
/** WO-168: what the record says about the open menu: its kind (waitingFor), its question (waiting_text, every kind: the program's reading of the menu, else
 *  the bottom of the screen as before), its options as the screen shows them (menu_options), the judge's own word for a kind it does not know (menu_raw) */
function menuDetail(v: ScreenVerdict, st: Regions, facts: ScreenFacts | null): Record<string, unknown> {
  const text = facts?.question ? facts.question : st.has_input_box ? st.above_input_box ?? '' : st.screen_bottom ?? ''
  const q = noPct(redact(text))
  return { waitingFor: menuKindOf(v, facts), waiting_text: facts?.question ? cutMid(q, 300) : cut(q, 200),
    ...(facts?.options.length ? { menu_options: facts.options.map(o => ({ n: o.n, text: cut(noPct(redact(o.text)), 200), cursor: o.cursor })) } : {}),
    ...(v.menu_raw !== undefined ? { menu_raw: v.menu_raw } : {}) }
}
/** a long question keeps its head (the title: 「Switch model?」) and its tail (the ask: 「Do you want to proceed?」), n code points in all */
const cutMid = (s: string, n: number): string => { const a = Array.from(s); return a.length <= n ? s : a.slice(0, 100).join('') + '…' + a.slice(a.length - (n - 101)).join('') }
function recordView(judged: ScreenVerdict | null, st: Regions | null, prog: StatusView, f: RecordFacts, sc: ScreenCtx | null = null): StatusView {
  if (gone(prog)) return programView(prog)
  const facts = st && sc ? sc.facts : null
  let v = judged ?? (st ? programVerdict(st, facts) : null)
  // WO-168 (Chiron #200727; sandwich-master 11-27 13:00Z): a judge that calls the usage-limit line under the prompt a menu is not taken: the input box is
  // there and nothing else on the screen is a dialog; the program's own reading of the screen stands instead
  if (v && st && v.state === 'waiting_for_human' && st.has_input_box && facts?.usage_notice) v = programVerdict(st, facts)
  // WO-168: which screen this record is for, and whether real text is typed in its input box
  const seen = st && sc ? { ...(sc.look !== false ? { screen: { hash: sc.hash, seen_at: isoMs(sc.seen_at) } } : {}), ...(st.has_input_box && facts?.input_typed != null ? { input_typed: facts.input_typed } : {}) } : {}
  const pd = (prog.detail ?? {}) as Record<string, any>
  const registering = prog.state === 'offline' && pd.reason === 'no_registration' && (!!v || f.alive === true)
  const base = { ...pick(pd, ['queued_joey', 'walled', 'lanes']), ...(prog.state === 'offline' ? { program_offline: pd.reason ?? null } : {}) }
  if (!v || !st) {
    if (!registering) { const pv = programView(prog); return st && sc ? { ...pv, detail: { ...pv.detail, ...seen } } : pv }
    return { state: 'starting', detail: { ...base, judged_by: 'program', ...seen }, last_activity_at: prog.last_activity_at ?? null }
  }
  const turn = prog.state === 'busy' || prog.state === 'stuck' || prog.state === 'waiting' ? pick(pd, ['turn_started_at', 'tool']) : {}
  const J = { judged_by: v.by, judge_p: r2(v.p) }
  const c = st.counted_by_program
  const out = (state: StatusView['state'], detail: Record<string, unknown>): StatusView => ({ state, detail: { ...detail, ...J, ...seen }, last_activity_at: prog.last_activity_at ?? null })
  // WO-168: a menu open on this screen keeps its kind, question and options in the record while the state is starting or walled (the order is unchanged)
  const menuOpen = v.state === 'waiting_for_human' || (!!facts?.menu_open && !st.has_input_box)
  const mv: ScreenVerdict = v.state === 'waiting_for_human' ? v : { ...v, menu: facts?.menu_kind ?? 'other' }
  const md = menuOpen ? menuDetail(mv, st, facts) : {}
  if (registering || v.state === 'starting') return out('starting', { ...base, ...md })
  // the wall is the program's (WO-168 layer table). The screen's usage_limit (WO-177 二: the limit message is the latest output) stands for a wall the
  // program missed, never for one it cleared: the same message is still the latest output until the next turn, and every delivery is held while the
  // record says walled, so that turn never comes (11-26 07:13Z, three agents)
  const clearedOnScreen = v.state === 'usage_limit' && !pd.walled && !!f.cleared_limit_text
    && flat(`${st.above_input_box ?? ''}\n${st.screen_bottom ?? ''}`).includes(flat(f.cleared_limit_text))
  if (clearedOnScreen) return out('idle', { ...base, cleared_limit_on_screen: true })
  if (v.state === 'usage_limit' || pd.walled) return out('walled', { ...base, walled: { until: pd.walled?.until ?? null, ...(pd.walled?.kind ? { kind: pd.walled.kind } : {}) }, ...md })
  if (v.state === 'waiting_for_human') return out('waiting', { ...md, ...turn, ...base })
  if (v.state === 'compacting') return out('busy', { compacting: true, ...turn, ...base })
  if (v.state === 'working' && prog.state === 'stuck') return out('stuck', { threshold_s: pd.threshold_s ?? null, ...turn, subagents: c.running_agents, ...base })
  if (v.state === 'working') return out('busy', { ...turn, subagents: c.running_agents, ...base })
  if (v.state === 'idle_background_running') return out('idle', { background: { agents: c.running_agents, shells: c.shells, monitors: c.monitors, tasks: c.background_tasks }, ...base })
  if (v.state === 'interrupted') return out('idle', { interrupted: true, ...base })
  return out('idle', { ...base })
}
function observe(v: ScreenVerdict | null, st: Regions | null, prog: StatusView, view: StatusView, f: RecordFacts): Observation {
  const now = f.now ?? Date.now()
  const since = (k: string, val: string): string => isoMs(f.since ? f.since(k, val) : now)
  const pd = (prog.detail ?? {}) as Record<string, any>, vd = (view.detail ?? {}) as Record<string, any>
  const goneNow = gone(prog), disconnected = prog.state === 'offline' && pd.reason === 'not_connected'
  const starting = view.state === 'starting'
  // a Claude Code still starting is online whether or not it has reached the daemon yet (no_registration, or not_connected while the screen says
  // starting: the fleet's restart after the 11-26 07:12Z account switch). Offline + starting cannot be written: offline leaves the main unknown,
  // starting needs it idle (status_v1_check)
  const presence: Observation['presence'] = goneNow || (disconnected && !starting) || (view.state === 'offline' && !starting) ? 'offline' : 'online'
  const presence_reason: Observation['presence_reason'] = presence === 'online' ? null : goneNow || f.alive === false ? 'process_gone' : 'disconnected'
  const lifecycle: Observation['lifecycle'] = presence_reason === 'process_gone' ? 'stopped' : starting ? 'starting' : 'ready'
  // CONTRACT v1 (Chiron 03:07Z, CONTRACT.md:211): the main session is written `main`, a lane its full id (<agent>.<kind>.<n>), in every place (sessions[].id, main_session_id)
  const mainId = 'main'
  const known = !!f.session_id || presence === 'online'                    // a main this daemon has seen: no idle main is made up
  const sessions: ObsSession[] = []
  if (known) {
    const s: ObsSession = { id: mainId, kind: 'main', thread_id: null, activity: 'unknown', activity_since: null, turn: null, doing: null, blockers: [], last_turn: f.last_turn ?? null }
    if (s.last_turn && vd.interrupted === true && s.last_turn.outcome === 'done') s.last_turn = { ...s.last_turn, outcome: 'interrupted' }   // the screen shows the cut
    if (presence === 'online') {
      // WO-177 (Chiron 04:01Z item 1; status_v1_check.py 03:59Z: online, an activity is never unknown): a record that says the main works (busy, a
      // compaction, stuck) with no turn the program has open (a compaction while idle: only PreCompact fires; a turn a Stop hook sent back) is a turn of
      // its own: started when statusOf says the turn began (turn_started_at), else when the record turned so; id turn-<ms> (the daemon's form for a turn
      // known by its start, as TurnWatch's); trigger other
      const works = view.state === 'busy' || view.state === 'stuck'
      const workAt = since('main.work', works ? 'work' : 'none')                     // one turn through busy → compacting → busy (lab 04:08:49Z)
      const startMs = typeof vd.turn_started_at === 'string' && !Number.isNaN(Date.parse(vd.turn_started_at)) ? Date.parse(vd.turn_started_at) : Date.parse(workAt)
      const t = f.turn ?? (works ? { id: `turn-${startMs}`, started_at: isoMs(startMs), trigger: { kind: 'other' as const } } : null)
      // WO-168: a waiting record without a judge's verdict names its menu in waitingFor (the program's kind, or the registry's words)
      const menu: Exclude<VerdictMenu, 'none'> | null = obsMenu(view.state === 'waiting' ? (v?.state === 'waiting_for_human' ? (v.menu === 'none' ? null : v.menu)
        : isVerdictMenu(vd.waitingFor) && vd.waitingFor !== 'none' ? vd.waitingFor : registryMenu(vd.waitingFor))
        : view.state === 'idle' && vd.dialog_open === true ? 'other' : null)                 // statusOf: a dialog open outside a turn
      // WO-180 (Chiron 04:42Z, 3): a blocker lasts while each record in a row shows it (the same reason and menu kind); a record with none ends it, so
      // the next menu is a new blocker (a new id, since = when it appeared), not the one before it (/status took /theme's id and since across a
      // `blockers: []` record). Its assignee and Action may change while it lasts (the duty officer asks a person): the same blocker
      const block = (reason: BlockerReason, menu_kind: Exclude<VerdictMenu, 'none'> | null, until: string | null = null): Blocker => {
        const at = since(`main.blocker`, `${reason}|${menu_kind ?? ''}`)
        return { id: `${mainId}:${reason}:${menu_kind ?? '-'}:${Date.parse(at).toString(36)}`, reason, since: at, until, menu_kind,
          ...assigned(f, menu_kind), summary: BLOCKER_SUMMARY[reason] }
      }
      if (starting) s.activity = 'idle'
      else if (view.state === 'walled') {
        const um = v?.state === 'waiting_for_human' || v?.state === 'usage_limit' ? (v.menu === 'usage_limit_options' ? 'usage_limit_options' as const : null) : null
        s.blockers = [block('usage_limit', um, typeof vd.walled?.until === 'string' ? vd.walled.until : null)]
        s.activity = t ? 'paused' : 'idle'
      } else if (view.state === 'waiting' || menu) {
        s.blockers = [block(menuReason(menu), menu)]
        s.activity = view.state === 'waiting' && t ? 'paused' : 'idle'
      } else if (view.state === 'stuck') {
        s.activity = t ? 'stuck' : 'unknown'
        if (t) s.blockers = [block('stalled', null)]
      } else if (view.state === 'busy') s.activity = t ? 'running' : 'unknown'
      else if (view.state === 'idle') s.activity = 'idle'
      if (s.activity === 'running' || s.activity === 'paused' || s.activity === 'stuck') { s.turn = t; s.thread_id = f.turn_thread ?? (t?.trigger.kind === 'thread' ? t.trigger.thread_id : null) }
      if (s.activity === 'running') {
        const tool = vd.tool && typeof vd.tool === 'object' && vd.tool.name ? vd.tool : null
        // WO-177 (Chiron 04:01Z item 2): the doing's since is when THIS doing began. The tool branch took statusOf's tool.since and left the memory at the
        // thinking before it, so the thinking after the tool came back with the turn's start: every doing now goes through the one memory
        const at = since('main.doing', vd.compacting === true ? `compacting|${t!.id}` : tool ? `tool|${tool.name}|${t!.id}` : `thinking|${t!.id}`)
        s.doing = vd.compacting === true ? { kind: 'compacting', tool: null, since: at }
          : tool ? { kind: 'tool', tool: String(tool.name), since: typeof tool.since === 'string' ? tool.since : at }
          : { kind: 'thinking', tool: null, since: at }
      }
      if (s.activity === 'unknown' || s.activity === 'idle') s.blockers = s.activity === 'idle' ? s.blockers : []
      s.activity_since = since('main.activity', s.activity)
    }
    sessions.push(s)
  }
  if (!sessions[0]?.blockers.length) since('main.blocker', '')             // WO-180 (04:42Z, 3): no blocker in this record: the next one is new
  // one session per running lane run (statusOf's detail.lanes): running, its trigger its thread's (a schedule's run: schedule)
  for (const l of Array.isArray(pd.lanes) ? pd.lanes as Array<Record<string, any>> : []) {
    if (!l?.id || sessions.some(x => x.id === l.id)) continue
    const thread = typeof l.thread === 'string' && l.thread ? l.thread : null
    const at = typeof l.since === 'string' ? l.since : isoMs(now)
    const trigger: Trigger = thread && f.scheduleThread?.(thread) ? { kind: 'schedule' } : thread ? { kind: 'thread', thread_id: thread } : { kind: 'other' }
    // WO-177 六: the tool the run has open now (lanes.ts runningLanes, from the run's own stream), else thinking
    const tool = l.tool && typeof l.tool === 'object' && typeof l.tool.name === 'string' && l.tool.name ? l.tool as { name: string; since?: unknown } : null
    sessions.push(presence === 'online'
      ? { id: String(l.id), kind: 'lane', thread_id: thread, activity: 'running', activity_since: at, turn: { id: String(l.run ?? l.id), started_at: at, trigger },
          doing: tool ? { kind: 'tool', tool: tool.name, since: typeof tool.since === 'string' ? tool.since : at }
            : { kind: 'thinking', tool: null, since: typeof l.thinking_since === 'string' ? l.thinking_since : at }, blockers: [], last_turn: null }   // WO-177: thinking since its last tool came back
      : { id: String(l.id), kind: 'lane', thread_id: thread, activity: 'unknown', activity_since: null, turn: null, doing: null, blockers: [], last_turn: null })
  }
  const c = st?.counted_by_program
  return { presence, presence_reason, lifecycle, main_session_id: known ? mainId : null, sessions,
    background: c && presence === 'online' ? { agents: c.running_agents, shells: c.shells, tasks: c.background_tasks, monitors: c.monitors } : null,
    queue: { pending: f.queue?.pending ?? null, unread_by_member: f.queue?.unread_by_member ?? null }, last_activity_at: prog.last_activity_at ?? null,
    reported_at: isoMs(now), evidence: v ? { source: v.by === 'jev' ? 'classifier' : 'runtime', confidence: v.p } : { source: 'runtime', confidence: null } }
}
/** a since memory: when each key first had its present value (a value that changes starts again) */
export class Since {
  private m = new Map<string, { v: string; at: number }>()
  at(key: string, value: string, now = Date.now()): number {
    const x = this.m.get(key)
    if (x && x.v === value) return x.at
    this.m.set(key, { v: value, at: now })
    return now
  }
}

// ------------------------------------------------------------------ one look at the pane
// WO-168 stage two: the look is pane-look.ts's (the one capture of the own pane: PaneReader, snapPaneLook); this file's own snapPane is gone

// ------------------------------------------------------------------ the reader
export interface ScreenDeps {
  agent: string
  /** <workspace>/.lanes: run/screen-verdicts.jsonl (the question bank) */
  lanesDir: string
  /** the JEV_SCREEN switch for this agent, now: the screen is read at all */
  switchOn(): boolean
  /** the judge SCREEN_JUDGE picks now (judgeFor); null: none, the record is statusOf's (judged_by program) */
  judge(): ScreenJudge | null
  /** SCREEN_JUDGE as it reads now (the log only) */
  judgeSetting?(): string
  /** WO-168: a look of the one capture (pane-look.ts PaneReader.look: its listener hands the look to sample() too, once), or the old text-and-command shape */
  snap(): Promise<PaneLook | { cmd: string; pane: string } | null>
  /** the pane's foreground command is Claude Code */
  isClaude(cmd: string): boolean
  /** statusOf's view now (the program's side) */
  program(): StatusView
  /** the record this reader gives may have changed: report again (statusOf computed, view() applied) */
  publish(): void
  log(level: 'info' | 'warn', msg: string): void
  now?(): number
  random?(): number
}
export interface ScreenOpts {
  pollMs: number; maxPerMin: number; pokeMs: number[]; retryMs: number; activeCheckMs: number
  /** the first look after start: at a random moment within this (a fleet that restarts together does not ask together) */
  firstJitterMs: number
  /** a screen seen again within this (a notice that comes and goes, a flicker between two screens) takes its earlier verdict: not asked again */
  cacheMs: number
  /** Chiron 19:23Z: this long after the last ask, any change of the screen's text (not only of its hash) is asked again, cache or not (a change the
   *  hash does not see is caught within a minute) */
  refreshMs: number
}
export const SCREEN_DEFAULTS: ScreenOpts = { pollMs: 1000, maxPerMin: 20, pokeMs: [40, 450], retryMs: 10_000, activeCheckMs: 10_000, firstJitterMs: 5000,
  cacheMs: 10 * 60_000, refreshMs: 60_000 }
const CACHE_MAX = 16
/** the question bank's file is rotated past this; at start (and at a new day) its last BANK_TAIL bytes are read for the day's hashes */
const BANK_MAX = 20 * 1024 * 1024, BANK_TAIL = 8 * 1024 * 1024
/** WO-168: facts, the program's facts of the screen (screenFacts); seq, the look's number in pane-look.ts's reader (0: a look handed in as text) */
type Cur = { hash: string; raw: string; parts: Parts; cmd: string; alive: boolean; at: number; facts: ScreenFacts; seq: number }
/** an answer, and the judge's version it was given under (WO-177 五) */
type Ans = { hash: string; at: number; v: ScreenVerdict | null; parts: Parts; seq: number; ver: string | null
  /** WO-168: the screen it was given for: when that screen was looked at, and its program facts */
  seenAt: number; facts: ScreenFacts; look: boolean }
const iso = (ms: number): string => new Date(ms).toISOString()

export class ScreenStatus {
  readonly o: ScreenOpts
  private cur: Cur | null = null
  private answer: Ans | null = null
  private cache = new Map<string, Ans>()
  private inflight: { hash: string; at: number } | null = null
  /** the last call: when, and the screen's text then (the 60 s re-ask) */
  private lastAsk: { at: number; raw: string } | null = null
  private failed: { hash: string; tries: number; at: number } | null = null
  private calls: number[] = []
  private capTold = 0
  private notVerdictTold = 0
  private looking = false
  private lastLookAt = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private firstTimer: ReturnType<typeof setTimeout> | null = null
  private pokes = new Set<number>()
  private progKey: string | null = null
  /** listed: JEV_SCREEN lists the agent (the pane is read: WO-177 ⑤, with or without a judge); judge: the one SCREEN_JUDGE picks; on: listed, a judge, and it
   *  is ready (the judge is asked) */
  private act: { on: boolean; listed: boolean; judge: ScreenJudge | null; at: number; why: string; ver: string | null } = { on: false, listed: false, judge: null, at: -Infinity, why: 'not checked', ver: null }
  private seq = 0
  /** the question bank: the hashes written today (UTC) */
  private bank: { day: string; hashes: Set<string> } | null = null
  /** judged_jev / judged_program: the records handed out (view(p, true)) with a Jev verdict in them / statusOf's */
  readonly stats = { looks: 0, changes: 0, calls: 0, refreshes: 0, cache_hits: 0, failed: 0, capped: 0, not_verdict: 0, judged_jev: 0, judged_program: 0, banked: 0 }
  constructor(readonly d: ScreenDeps, o: Partial<ScreenOpts> = {}) { this.o = { ...SCREEN_DEFAULTS, ...o } }
  private now(): number { return (this.d.now ?? Date.now)() }

  // ---- on / off
  /** the switch, the judge and its readiness, checked at most every activeCheckMs; a change is logged once. A new judge starts from nothing (the
   *  verdicts held were the other one's); WO-177 五: so does a new version of the same judge (Chiron's questions file changed: the answers held were given
   *  to the old questions; a screen that does not change is asked again at the next look) */
  active(): boolean {
    const now = this.now()
    if (now - this.act.at < this.o.activeCheckMs) return this.act.on
    const listed = this.d.switchOn()
    const judge = listed ? this.d.judge() : null
    const why = !listed ? 'JEV_SCREEN does not list this agent' : !judge ? `SCREEN_JUDGE=${this.d.judgeSetting?.() || 'program'}: no screen judge` : judge.ready?.() ?? ''
    const on = !why
    const ver = on ? judgeVersion(judge!) : null
    const newVer = on && this.act.on && judge === this.act.judge && ver !== this.act.ver
    if (on !== this.act.on || why !== this.act.why || judge !== this.act.judge || newVer) {
      this.d.log('info', newVer ? `screen-status: judge ${judge!.name} now judges by version ${ver ?? '-'} (was ${this.act.ver ?? '-'}): its answers are dropped, the screen is asked again`
        : on ? `screen-status: ON for ${this.d.agent} (judge ${judge!.name}${ver ? ` version ${ver}` : ''}; poll ${this.o.pollMs} ms)`
        : `screen-status: off for ${this.d.agent} (${why}): the status is statusOf's${listed ? ' and the screen\'s activity facts (judged_by program)' : ', unchanged'}`)
      if (!on || judge !== this.act.judge || newVer) { this.answer = null; this.cur = null; this.failed = null; this.cache.clear() }
    }
    this.act = { on, listed, judge, at: now, why, ver }
    return on
  }

  // ---- looking
  start(): void {
    if (this.timer || this.firstTimer) return
    const first = Math.floor((this.d.random ?? Math.random)() * Math.max(this.o.pollMs, this.o.firstJitterMs))   // a fleet that starts together does not look together
    this.firstTimer = setTimeout(() => { this.firstTimer = null; this.tick(); this.timer = setInterval(() => this.tick(), this.o.pollMs); (this.timer as any).unref?.() }, first)
    ;(this.firstTimer as any).unref?.()
  }
  stop(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer); this.firstTimer = null
    if (this.timer) clearInterval(this.timer); this.timer = null
  }
  tick(): void {
    this.active()
    if (!this.act.listed) return                                                       // WO-177 ⑤: the pane is read with or without a judge
    if (this.now() - this.lastLookAt < this.o.pollMs * 0.6) return                     // the duty officer looked a moment ago
    void this.lookNow()
  }
  /** the main's state changed (a hook, the registry, a tool): look now and once more a moment later, without waiting for the poll */
  poke(): void {
    if (!this.act.listed) return
    for (const ms of this.o.pokeMs) {
      if (this.pokes.has(ms)) continue
      this.pokes.add(ms)
      const t = setTimeout(() => { this.pokes.delete(ms); void this.lookNow() }, ms)
      ;(t as any).unref?.()
    }
  }
  /** statusOf's view was just computed: a change of its state or detail (not last_activity_at alone, not the heartbeat) is an event of the main */
  programChanged(v: StatusView): void {
    const k = JSON.stringify([v.state, v.detail ?? null])
    if (this.progKey !== null && k !== this.progKey) this.poke()
    this.progKey = k
  }
  async lookNow(): Promise<void> {
    if (this.looking || !this.act.listed) return
    this.looking = true
    let s: PaneLook | { cmd: string; pane: string } | null = null
    try { s = await this.d.snap() } catch {} finally { this.looking = false }
    if (s) { if ('visible' in s) this.sample(s); else this.sample(s.pane, s.cmd) }
    else if (this.cur) { this.cur = null; this.d.publish() }                           // the pane cannot be read: statusOf
  }
  /** one look at the pane: WO-168, a look of the one capture (pane-look.ts PaneReader: ours, the duty officer's, a busy check's; each one once), or a
   *  screen's text and foreground command handed in as before */
  sample(pane: string | PaneLook, cmd?: string): void {
    if (!this.act.listed) return
    const look = typeof pane === 'string' ? null : pane
    if (look && look.seq && look.seq === this.cur?.seq) return
    const text = look ? look.visible : pane as string
    const now = this.now()
    this.lastLookAt = now
    this.stats.looks++
    const parts = regionParts(text)
    const hash = screenHash(parts)
    const fg = look ? look.cmd : cmd ?? ''
    const alive = this.d.isClaude(fg)
    const prev = this.cur
    this.cur = { hash, raw: rawHash(parts), parts, cmd: fg, alive, at: look?.at ?? now, facts: screenFacts(text, look ? look.visibleAnsi : null, parts.st), seq: look?.seq ?? 0 }
    if (!prev || prev.hash !== hash || prev.alive !== alive) {
      this.stats.changes++
      this.maybeAsk()
      this.d.publish()
    } else this.maybeAsk()
  }

  // ---- asking the judge
  private maybeAsk(): void {
    const c = this.cur, j = this.act.judge
    if (!c || this.inflight || !j || !this.act.on) return
    const now = this.now()
    const refresh = !!this.lastAsk && now - this.lastAsk.at >= this.o.refreshMs && this.lastAsk.raw !== c.raw
    if (!refresh && this.answer?.hash === c.hash) return
    if (!c.alive) return                                      // Claude Code is not the pane's program: not asked
    if (!refresh) {
      const hit = this.cache.get(c.hash)
      if (hit && now - hit.at < this.o.cacheMs) { this.stats.cache_hits++; this.answer = hit; this.d.publish(); return }
    }
    if (now < (j.notBefore?.() ?? 0)) return
    // a failed call is not given up on (WO-169 criterion 13, Chiron 00:57Z: Jev down 00:07–00:40Z, 27 agents whose screen did not change stayed on
    // program 36 min after it came back): the second try after retryMs, then one every refreshMs (the 60 s re-ask), until a verdict or a new screen.
    // A judge that answered and could not tell (null) is not asked again for that screen (the cache)
    if (!refresh && this.failed?.hash === c.hash && now - this.failed.at < (this.failed.tries >= 2 ? this.o.refreshMs : this.o.retryMs)) return
    if (gone(this.d.program())) return                        // the process is gone (the OS says so): offline, not asked
    this.calls = this.calls.filter(t => now - t < 60_000)
    if (this.calls.length >= this.o.maxPerMin) {
      this.stats.capped++
      if (now - this.capTold >= 60_000) { this.capTold = now; this.d.log('warn', `screen-status: ${this.o.maxPerMin} judge calls in the last minute: not asked until the minute frees (statusOf meanwhile)`) }
      return
    }
    if (j.ready?.()) return                                   // its own readiness, now (its file may have gone since active() looked)
    this.calls.push(now)
    if (refresh) this.stats.refreshes++
    this.lastAsk = { at: now, raw: c.raw }
    this.inflight = { hash: c.hash, at: now }
    void this.ask(c, j, this.act.ver)
  }
  private async ask(c: Cur, j: ScreenJudge, ver: string | null): Promise<void> {
    let v: ScreenVerdict | null = null, failed = false
    try {
      const r = await j.judge(c.parts)
      if (r != null && !isVerdict(r)) {
        this.stats.not_verdict++
        if (this.now() - this.notVerdictTold >= 3600_000) { this.notVerdictTold = this.now(); this.d.log('warn', `screen-status: judge ${j.name} answered something that is not a ScreenVerdict (${JSON.stringify(r).slice(0, 200)}): no verdict`) }
      } else v = r
    } catch { failed = true }
    this.inflight = null
    this.stats.calls++
    if (j !== this.act.judge) { this.maybeAsk(); return }      // SCREEN_JUDGE changed while it judged: that answer is not the new judge's
    // WO-177 五: its version changed while it judged: that answer is the old version's. The change is taken now (as active() would) and asked again
    if (judgeVersion(j) !== ver) { this.act.at = -Infinity; this.active(); this.maybeAsk(); return }
    if (failed) {
      this.stats.failed++
      this.failed = { hash: c.hash, tries: this.failed?.hash === c.hash ? this.failed.tries + 1 : 1, at: this.now() }
      this.d.publish()
      this.maybeAsk()
      return
    }
    this.failed = null
    const a: Ans = { hash: c.hash, at: this.now(), v, parts: c.parts, seq: ++this.seq, ver, seenAt: c.at, facts: c.facts, look: c.seq > 0 }
    this.answer = a
    this.cache.delete(a.hash); this.cache.set(a.hash, a)
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!)
    if (v) this.bankIt(c, v, ver)
    this.d.publish()
    if (this.cur && this.cur.hash !== c.hash) this.maybeAsk()                           // the screen moved on while it was judged: ask once more
  }

  // ---- what is published
  /** the record for statusOf's view `p` now: `p` untouched when JEV_SCREEN does not list this agent; the verdict's record (publishView) when the screen
   *  showing now has one (while a newer screen is being judged, the last verdict stands); else statusOf's view, judged_by program. `fed`: this is the
   *  one handed out (counted) */
  view(p: StatusView, fed = false): StatusView { return this.record(p, {}, fed).view }
  /** the record (as view()) and its observation, from the one composition (composeRecord): the verdict in use, the screen showing now (its counts are
   *  the observation's background even with no verdict), whether the pane runs Claude Code, and the program's facts `f` */
  record(p: StatusView, f: RecordFacts = {}, fed = false): { view: StatusView; observation: Observation } {
    const c = this.cur, a = this.answer
    const ok = this.act.on && !!c && c.alive && !gone(p) && !!a?.v && (a.hash === c.hash || !!this.inflight)
    if (fed && this.act.listed) { if (ok && a!.v!.by === 'jev') this.stats.judged_jev++; else this.stats.judged_program++ }
    const seen = this.act.listed && c ? c : null
    // WO-168: the screen the record is for (detail.screen). While a newer screen is judged the last verdict stands, with its own screen's facts; the verdict
    // of the screen showing now takes that screen's own look (its text may differ from the judged one only in what the hash masks: a digit, a timer)
    const own = ok && a!.hash !== c!.hash
    const sc: ScreenCtx | null = ok ? (own ? { hash: a!.hash, seen_at: a!.seenAt, facts: a!.facts, look: a!.look } : { hash: c!.hash, seen_at: c!.at, facts: c!.facts, look: c!.seq > 0 })
      : seen?.alive ? { hash: seen.hash, seen_at: seen.at, facts: seen.facts, look: seen.seq > 0 } : null
    const r = composeRecord(ok ? a!.v! : null, ok ? (own ? a!.parts.st : c!.parts.st) : seen?.alive ? seen.parts.st : null, p, { self: this.d.agent, ...f, alive: seen ? seen.alive : null }, sc)
    return { view: this.act.listed ? r.view : p, observation: r.observation }
  }
  /** WO-168 stage two: the record for exactly this look's screen (the one a reader is about to act on): its own verdict when the judge has answered for its
   *  hash (the answer in use, or one cached within cacheMs), else the program's facts of it; never the verdict of another screen. null when JEV_SCREEN does
   *  not list this agent (no record of the screen: the caller reads the screen as it did before) */
  recordOf(look: PaneLook, p: StatusView, f: RecordFacts = {}): { view: StatusView; hash: string; facts: ScreenFacts; alive: boolean } | null {
    if (!this.act.listed) return null
    const parts = regionParts(look.visible), hash = screenHash(parts), alive = this.d.isClaude(look.cmd)
    const facts = screenFacts(look.visible, look.visibleAnsi, parts.st)
    const a = this.answer?.hash === hash ? this.answer : this.cache.get(hash) ?? null
    const fresh = !!a && (a === this.answer || this.now() - a.at < this.o.cacheMs)
    const v = this.act.on && alive && !gone(p) && fresh && a?.v ? a.v : null
    return { view: composeRecord(v, alive ? parts.st : null, p, { self: this.d.agent, ...f, alive }, alive ? { hash, seen_at: look.at, facts } : null).view, hash, facts, alive }
  }
  /** the screen with this hash is still the one showing and this verdict is the one in use for it (a judge's own check, a moment later) */
  holds(hash: string, v: ScreenVerdict): boolean { return this.cur?.hash === hash && this.answer?.hash === hash && this.answer.v === v }
  /** for /healthz: the reader, its judge's own counts, the screen now, the verdict in use (ScreenVerdict's four fields) */
  health(): Record<string, unknown> {
    const j = this.act.judge, a = this.answer
    return { on: this.act.on, ...(this.act.on ? {} : { why: this.act.why }), reading: this.act.listed, judge: j?.name ?? null, judge_version: this.act.ver, poll_ms: this.o.pollMs, ...this.stats, ...(j?.health?.() ?? {}),
      screen: this.cur ? { hash: this.cur.hash, alive: this.cur.alive, at: iso(this.cur.at) } : null,
      answer: a?.v ? verdictFields(a.v) : null, answered: a ? { hash: a.hash, at: iso(a.at), verdict: !!a.v, judge_version: a.ver } : null, in_flight: !!this.inflight }
  }

  // ---- 五 the question bank
  /** a screen hash's first verdict of the day (UTC) under each version of the judge (WO-177 五: the same screen again under new questions, the row
   *  carrying the version): one line of run/screen-verdicts.jsonl, its regions masked as the exception log masks them. The day's hash-and-version keys
   *  are read back from the file's tail at start and when the day turns, so a restart does not write a screen twice */
  private bankIt(c: Cur, v: ScreenVerdict, ver: string | null): void {
    const now = this.now(), day = iso(now).slice(0, 10)
    const f = join(this.d.lanesDir, 'run', 'screen-verdicts.jsonl')
    if (!this.bank || this.bank.day !== day) this.bank = { day, hashes: bankedOn(f, day) }
    const key = bankKey(c.hash, ver)
    if (this.bank.hashes.has(key)) return
    this.bank.hashes.add(key)
    const st = redactRegions(c.parts.st)
    const rec = { ts: iso(now), agent: this.d.agent, hash: c.hash, judge_version: ver, has_input_box: st.has_input_box, screen: screenRegions(st),
      counted_by_program: st.counted_by_program, found_by_program: st.found_by_program, verdict: verdictFields(v) }
    try {
      mkdirSync(join(this.d.lanesDir, 'run'), { recursive: true })
      try { if (statSync(f).size > BANK_MAX) renameSync(f, `${f}.1`) } catch {}
      appendFileSync(f, JSON.stringify(rec) + '\n')
      this.stats.banked++
    } catch {}
  }
}
/** a judge's version now (null: it has one version only, or it could not say) */
const judgeVersion = (j: ScreenJudge): string | null => { try { return j.version?.() ?? null } catch { return null } }
/** the question bank's key: the screen's hash under the judge's version (a row from before WO-177 has no version: '') */
const bankKey = (hash: string, ver: string | null | undefined): string => `${hash}|${ver ?? ''}`
/** the hash-and-version keys the question bank already has for `day` (its file's last BANK_TAIL bytes; every line starts with its ts) */
function bankedOn(f: string, day: string): Set<string> {
  const out = new Set<string>()
  let text = ''
  let fd: number | null = null
  try {
    const size = statSync(f).size, n = Math.min(size, BANK_TAIL)
    const buf = Buffer.alloc(n)
    fd = openSync(f, 'r')
    readSync(fd, buf, 0, n, size - n)
    text = buf.toString('utf8')
  } catch { return out } finally { if (fd != null) try { closeSync(fd) } catch {} }
  const head = `{"ts":"${day}`
  for (const l of text.split('\n')) {
    if (!l.startsWith(head)) continue
    try { const j = JSON.parse(l); if (typeof j.hash === 'string') out.add(bankKey(j.hash, typeof j.judge_version === 'string' ? j.judge_version : null)) } catch {}
  }
  return out
}
/** the screen text that goes to Jev and into the logs: tokens, keys and e-mail addresses hidden (the duty officer's redact) */
export function redactRegions(st: Regions): Regions {
  const o: Regions = { ...st, found_by_program: { ...st.found_by_program, live_activity_line: st.found_by_program.live_activity_line == null ? null : redact(st.found_by_program.live_activity_line) } }
  for (const k of ['above_input_box', 'input_box', 'below_input_box', 'screen_bottom'] as const) if (typeof o[k] === 'string') o[k] = redact(o[k] as string)
  return o
}
/** the three regions (or, with no input box, the bottom of the screen) as the logs keep them */
export function screenRegions(st: Regions): Record<string, string | undefined> {
  return st.has_input_box ? { above_input_box: st.above_input_box, input_box: st.input_box, below_input_box: st.below_input_box } : { screen_bottom: st.screen_bottom }
}
export function lastLines(st: Regions, n: number): string {
  const t = st.has_input_box ? st.above_input_box ?? '' : st.screen_bottom ?? ''
  return t.split('\n').slice(-n).join('\n')
}
