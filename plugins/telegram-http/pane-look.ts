// pane-look.ts — WO-168 stage two (Chiron's ticket; Joey TG chiron:2515 「不要補丁式」, 2520): the ONE capture of this daemon's own pane. Every reader in
// the daemon that judges the main's state takes its screen from here (the status record's screen layer, the duty officer, the busy checks before a
// Telegram command), so the pane is read in one place, by one tmux run, and every look also feeds the record:
//
//   one tmux client run   display-message (foreground command, copy mode, path, pane height) ; capture-pane -p -e -S -<scrollback>
//                         -e keeps the escapes: dim text in the input box is Claude Code's suggestion, not typed (detail.input_typed). The plain text
//                         (escapes stripped) of the last pane_height rows is what `capture-pane -p` gives: what the record reads. The scrollback (60
//                         rows, the duty officer's model bundle, `capture -S -60` until now) comes in the same run
//   single flight         readers that ask at the same moment share one run; fresh(maxAgeMs) gives the last look when it is recent enough
//   listeners             every look is handed to the status record (screen-status.ts ScreenStatus.sample), whoever asked for it
//
// Roamer panes are not read here (Chiron 05:24:56Z: the record is not extended to them; their readers stay as they are).
import { spawn } from 'node:child_process'

export type PaneLook = {
  /** when the capture was started (ms) */
  at: number
  /** this reader's look number (a listener sees each look once) */
  seq: number
  /** pane_current_command, pane_in_mode, pane_current_path */
  cmd: string; inMode: boolean; path: string
  /** the visible rows, escapes stripped: `capture-pane -p` */
  visible: string
  /** the visible rows as captured, with escapes */
  visibleAnsi: string
  /** the scrollback rows taken and the visible rows, escapes stripped: `capture-pane -p -S -<n>` */
  text: string
}
export type Snap = Omit<PaneLook, 'at' | 'seq'>

// what tmux -e emits: SGR and other CSI sequences, OSC 8 hyperlinks (ended by BEL or ST), charset switches
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const CSI = /\x1b\[[0-9;:?<=>]*[ -/]*[@-~]/g
const ESC2 = /\x1b[()*+][0-9A-Za-z]|\x1b[=>78]/g
export function stripAnsi(s: string): string { return String(s ?? '').replace(OSC, '').replace(CSI, '').replace(ESC2, '') }

/** the capture's text split at its last `height` rows: the scrollback above, the visible rows below. capture-pane prints every visible row (trailing
 *  empty rows too), so the visible part is the last `height` lines of its output */
export function splitVisible(out: string, height: number): { scrollback: string; visible: string } {
  const rows = out.replace(/\n$/, '').split('\n')
  const h = Number.isFinite(height) && height > 0 ? Math.min(height, rows.length) : rows.length
  return { scrollback: rows.slice(0, rows.length - h).join('\n'), visible: rows.slice(rows.length - h).join('\n') }
}

/** one look at `tmux` in ONE tmux client run; null when the pane cannot be read. `-u`: a launchd daemon has no UTF-8 locale (the duty officer's note).
 *  `socket` (tests): the private tmux server's socket (`-S`); the daemon itself uses the default resolution. Killed (SIGKILL) at timeoutMs */
export function snapPaneLook(tmux: string, o: { scrollback?: number; timeoutMs?: number; socket?: string } = {}): Promise<Snap | null> {
  const scrollback = o.scrollback ?? 60, timeoutMs = o.timeoutMs ?? 3000
  const pre = o.socket ? ['-S', o.socket] : []
  const argv = [...pre, '-u', 'display-message', '-p', '-t', tmux, '#{pane_current_command}\t#{pane_in_mode}\t#{pane_current_path}\t#{pane_height}', ';',
    'capture-pane', '-p', '-e', ...(scrollback > 0 ? ['-S', `-${scrollback}`] : []), '-t', tmux]
  return new Promise(resolve => {
    let out = '', done = false
    let p: ReturnType<typeof spawn>
    try { p = spawn('tmux', argv, { stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return resolve(null) }
    const end = (v: Snap | null) => { if (!done) { done = true; clearTimeout(t); resolve(v) } }
    const t = setTimeout(() => { try { p.kill('SIGKILL') } catch {}; end(null) }, timeoutMs)
    p.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8') })
    p.on('error', () => end(null))
    p.on('close', code => {
      if (code !== 0) return end(null)
      const i = out.indexOf('\n')
      if (i < 0) return end(null)
      const head = out.slice(0, i).split('\t')
      if (head.length < 4) return end(null)
      const h = parseInt(head[3]!, 10)
      const ansi = splitVisible(out.slice(i + 1), h)
      end({ cmd: head[0]!.trim(), inMode: head[1] === '1', path: head[2] ?? '', visibleAnsi: ansi.visible, visible: stripAnsi(ansi.visible),
        text: stripAnsi(ansi.scrollback ? `${ansi.scrollback}\n${ansi.visible}` : ansi.visible) })
    })
  })
}

/** the daemon's own pane, read in one place. look(): a capture now (callers at the same moment share it); fresh(maxAgeMs): the last look when it is at
 *  most that old, else a capture now; every look goes to the listeners */
export class PaneReader {
  private lastLook: PaneLook | null = null
  private inflight: { at: number; p: Promise<PaneLook | null> } | null = null
  private seq = 0
  private readonly listeners: Array<(l: PaneLook | null) => void> = []
  constructor(readonly tmux: string, private readonly snap: () => Promise<Snap | null>, private readonly now: () => number = Date.now) {}
  onLook(fn: (l: PaneLook | null) => void): void { this.listeners.push(fn) }
  last(): PaneLook | null { return this.lastLook }
  look(): Promise<PaneLook | null> {
    if (this.inflight) return this.inflight.p
    const at = this.now()
    const p = (async () => {
      let s: Snap | null = null
      try { s = await this.snap() } catch { s = null }
      const l = s ? { ...s, at, seq: ++this.seq } : null
      if (l) this.lastLook = l
      for (const fn of this.listeners) { try { fn(l) } catch {} }
      return l
    })()
    this.inflight = { at, p }
    void p.finally(() => { if (this.inflight?.p === p) this.inflight = null })
    return p
  }
  /** the last look if it was taken at most maxAgeMs ago; a capture already on its way that started within that window; else a capture now */
  async fresh(maxAgeMs: number): Promise<PaneLook | null> {
    const now = this.now()
    if (this.lastLook && now - this.lastLook.at <= maxAgeMs) return this.lastLook
    if (this.inflight && now - this.inflight.at <= Math.max(maxAgeMs, 0)) return this.inflight.p
    if (this.inflight) await this.inflight.p.catch(() => null)
    return this.look()
  }
}
