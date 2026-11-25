/**
 * lanes-state.ts — the state journal of the lanes mechanisms (docs/state-journal.md).
 *
 * One append-only file, <STATE_DIR>/lanes/state.jsonl, written by ONE writer (the tg daemon). Every transition of the five
 * mechanisms is one line:
 *   {"ts": ISO-8601 with ms, "rec": "msg|main|event|run|wake", "id": ..., "state": <new state>, ...fields}
 * The journal IS the persisted state: at boot the daemon folds it (load) and continues from there. A record's current state is
 * the merge of its lines in file order (a later line's fields replace earlier ones; a field written as null clears it). The fold also counts them:
 * `version` = how many lines the record has, so "changed since version v" is exact (a timestamp is not: two lines can share a millisecond).
 * `wake` lines (M4) are a log of decisions, not a record: they are not folded.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'

export type RecKind = 'msg' | 'main' | 'event' | 'run' | 'wake'
type Table = Exclude<RecKind, 'wake'>
/** a folded record: its last state and every field its lines carried (created = the ts of its first line, n = creation order) */
export type Row = { ts: string; rec: RecKind; id: string; state: string; created: string; n: number; version: number; [k: string]: any }

export class Journal {
  readonly t: Record<Table, Map<string, Row>> = { msg: new Map(), main: new Map(), event: new Map(), run: new Map() }
  private n = 0
  /** Onsen step 3 (WO-143): read-only observers of each write (the folded row after it, and the line as written); not called by load(). Never throw into a write. */
  private observers: Array<(row: Row, line: Record<string, unknown>) => void> = []
  constructor(readonly path: string, private clock: () => number = Date.now) {}
  observe(fn: (row: Row, line: Record<string, unknown>) => void): void { this.observers.push(fn) }
  /** WO-147 (Onsen step 4a): read-only observers of every line as written, `wake` lines included (the observers above see folded records only, and a `wake`
   *  line folds into none); not called by load(). Never throw into a write. */
  private lineObservers: Array<(line: Record<string, unknown>) => void> = []
  observeLines(fn: (line: Record<string, unknown>) => void): void { this.lineObservers.push(fn) }

  /** fold the file (boot); returns how many lines were read */
  load(): number {
    if (!existsSync(this.path)) return 0
    let k = 0
    for (const l of readFileSync(this.path, 'utf8').split('\n')) {
      if (!l) continue
      let j: any
      try { j = JSON.parse(l) } catch { continue }
      if (j && typeof j.rec === 'string' && typeof j.id === 'string') { this.apply(j); k++ }
    }
    return k
  }

  /** append one transition and apply it */
  write(rec: RecKind, id: string, state: string, fields: Record<string, unknown> = {}): Row | null {
    const line: Record<string, unknown> = { ts: new Date(this.clock()).toISOString(), rec, id, state }
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && !(k in line)) line[k] = v
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    appendFileSync(this.path, JSON.stringify(line) + '\n')
    const row = this.apply(line)
    if (row) for (const o of this.observers) { try { o(row, line) } catch {} }
    for (const o of this.lineObservers) { try { o(line) } catch {} }
    return row
  }

  private apply(line: Record<string, any>): Row | null {
    if (line.rec === 'wake' || !(line.rec in this.t)) return null
    const tab = this.t[line.rec as Table]
    let row = tab.get(line.id)
    if (!row) { row = { created: line.ts, n: ++this.n, version: 0 } as Row; tab.set(line.id, row) }
    for (const [k, v] of Object.entries(line)) { if (k === 'version') continue; if (v === null) delete row[k]; else row[k] = v }
    row.version++
    return row
  }

  get(rec: Table, id: string): Row | undefined { return this.t[rec].get(id) }
  rows(rec: Table, pred: (r: Row) => boolean = () => true): Row[] {
    return [...this.t[rec].values()].filter(pred).sort((a, b) => a.n - b.n)
  }
  /** what GET /lanes/state serves: every folded record of each mechanism */
  snapshot(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const strip = (r: Row) => { const { n, ...rest } = r; return rest }
    return { ...extra, msg: this.rows('msg').map(strip), main: this.rows('main').map(strip), event: this.rows('event').map(strip), run: this.rows('run').map(strip) }
  }
}
