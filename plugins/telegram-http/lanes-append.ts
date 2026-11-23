// WO-123 (Chiron, from Joey TG chiron:2070 「為何不讓簡單的事分身可以在一定確定性底下進行處理？」): a lane may add text at the END of the files the
// main declared, and nowhere else. 2026-11-23: of 44 hand-overs to mains, 3 were handed over only because the lane could not write one line to a
// record file (pheme's state/situation.md, chiron's harness-journal.md, kairos's sync log), and each hand-over wakes a main with its whole context.
//
// Append-only is by construction, not by analysing how a write is spelled: the one way in is the `append_file` tool (the daemon opens the file with
// O_APPEND and makes one write); Write, Edit and every shell write to a declared file stay refused by lane-guard-hook.py, which reads the same
// declaration with the same rules (appendable() there: keep the two in step).
//
// The declaration is the main's: `.lanes/appendable.txt`, one workspace-relative path per line (`#` = comment). Only record-like files can be
// declared (APPEND_EXT); memory, .lanes/, secrets, settings, code, CLAUDE.md, knowledge/REANCHOR.md and the anchor files it lists, and a worker's
// anchor files are never declarable, whatever the declaration says.
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeSync } from 'fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'path'

export const APPENDABLE_FILE = 'appendable.txt'
export const APPEND_EXT = ['.md', '.txt', '.log', '.csv', '.tsv', '.jsonl']
export const APPEND_MAX = 4000
const NEVER_DIRS = ['.lanes', '.secrets', '.git', '.claude', 'bin', '.telegram-state', '.agent-inbox-state', 'node_modules', join('knowledge', 'lines')]
const NEVER_NAMES = ['claude.md', 'reanchor.md', 'memory.md']

export type Declared = { rel: string; abs: string }
export type Refused = { line: string; why: string }

const under = (p: string, root: string): boolean => p === root || p.startsWith(root + sep)
/** the real path of `p`: of its deepest existing ancestor, plus the rest (the file may not exist yet) */
function real(p: string): string {
  let cur = resolve(p)
  const rest: string[] = []
  for (;;) {
    try { return join(realpathSync(cur), ...rest) } catch {
      const d = dirname(cur)
      if (d === cur) return resolve(p)
      rest.unshift(basename(cur)); cur = d
    }
  }
}
/** the anchor files knowledge/REANCHOR.md lists (a path ending .md in backticks, or after 「定錨檔：」) */
function anchorFiles(wsr: string): Set<string> {
  const out = new Set<string>()
  let text = ''
  try { text = readFileSync(join(wsr, 'knowledge', 'REANCHOR.md'), 'utf8') } catch { return out }
  for (const m of text.matchAll(/`([^`\s]+\.md)`|定錨檔：\s*([^\s|｜)）`]+\.md)/g)) {
    const p = m[1] ?? m[2]
    if (p && !p.startsWith('/') && !p.startsWith('~')) out.add(real(join(wsr, p)))
  }
  return out
}

function check(line: string, wsr: string, lanesDir: string, memDir: string, anchors: Set<string>): Declared | string {
  if (line.startsWith('/') || line.startsWith('~')) return 'not a workspace-relative path'
  const abs0 = resolve(wsr, line)
  if (abs0 === wsr || !under(abs0, wsr)) return 'outside the workspace'
  try { const st = lstatSync(abs0); if (st.isSymbolicLink()) return 'a symbolic link'; if (!st.isFile()) return 'not a regular file' } catch { /* not there yet: it is created by the first append */ }
  const abs = real(abs0)
  if (!under(abs, wsr)) return 'resolves outside the workspace'
  if (!APPEND_EXT.includes(extname(abs).toLowerCase())) return `only ${APPEND_EXT.join(' ')} files can be declared (records and logs; not settings, state or code)`
  if (NEVER_NAMES.includes(basename(abs).toLowerCase())) return 'never declarable: the main is its only writer'
  if (NEVER_DIRS.some(d => under(abs, join(wsr, d))) || under(abs, lanesDir) || under(abs, memDir)) return 'never declarable: memory, .lanes/, secrets, settings and a worker\'s anchor file have a single writer'
  if (anchors.has(abs)) return 'never declarable: an anchor file listed in knowledge/REANCHOR.md'
  return { rel: relative(wsr, abs), abs }
}

/** the declaration, checked: what a lane may append to, and the lines that were refused (with why) */
export function readDeclared(ws: string, lanesDir: string, memDir: string): { ok: Declared[]; refused: Refused[] } {
  let text = ''
  try { text = readFileSync(join(lanesDir, APPENDABLE_FILE), 'utf8') } catch { return { ok: [], refused: [] } }
  const wsr = real(ws), ld = real(lanesDir), mem = real(memDir), anchors = anchorFiles(wsr)
  const ok: Declared[] = [], refused: Refused[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const r = check(line, wsr, ld, mem, anchors)
    if (typeof r === 'string') refused.push({ line, why: r })
    else if (!ok.some(d => d.abs === r.abs)) ok.push(r)
  }
  return { ok, refused }
}

/** the declared file `path` names (workspace-relative or absolute), or null */
export function declaredFor(path: string, ws: string, ok: Declared[]): Declared | null {
  const p = String(path ?? '').trim()
  if (!p) return null
  const abs = real(resolve(real(ws), p))
  return ok.find(d => d.abs === abs) ?? null
}

/** add `text` at the end of `abs`: one write on an O_APPEND descriptor. A line break is put before it when the file does not end with one, and after
 *  it when the text does not. Synchronous: two calls in one process never interleave; another process's `>>` lands whole before or after. */
export function appendText(abs: string, text: string): { bytes: number; before: number } {
  try { if (lstatSync(abs).isSymbolicLink()) throw new Error('a symbolic link') } catch (e) { if (String(e).includes('symbolic')) throw e }
  mkdirSync(dirname(abs), { recursive: true })
  const fd = openSync(abs, 'a+')
  try {
    const before = fstatSync(fd).size
    let lead = ''
    if (before > 0) { const b = Buffer.alloc(1); readSync(fd, b, 0, 1, before - 1); if (b[0] !== 0x0a) lead = '\n' }
    const buf = Buffer.from(lead + (text.endsWith('\n') ? text : text + '\n'), 'utf8')
    writeSync(fd, buf)
    return { bytes: buf.length, before }
  } finally { closeSync(fd) }
}
