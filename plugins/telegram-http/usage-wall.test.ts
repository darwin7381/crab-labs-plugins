// WO-120: usage-wall.ts (reader rule, identity match, wallAte, held sidecar, enter/clear alerts).
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ALERTS_FILE, HeldSidecar, WallAlerts, WallReader, clearText, enterText, heldPath, heldTotal, isWallRecordLine,
  readHeld, readWallState, wallAte, wallCovers, wallKey, lanesEnterNote, wallKeeperAlive, type WallState,
} from './usage-wall.ts'

const NOW = Date.parse('2026-11-23T08:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

function wallDirWith(states: Record<string, any> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'uw-'))
  for (const [k, v] of Object.entries(states)) writeFileSync(join(dir, `${k}.json`), JSON.stringify(v))
  return dir
}
const st = (over: Record<string, unknown> = {}) => ({
  agent: 'nestor', tmux: 'claude-nestor', session: 's1', transcript: '/p/-ws-nestor/s1.jsonl', in_wall: true,
  episode: 'nestor-20261123T075000Z', since: iso(NOW - 600_000), kind: 'fable', text: "You're out of usage credits",
  resets_at: null, cleared_at: null, cleared_by: null, updated_at: iso(NOW - 30_000), ...over,
})
const env = (over: Record<string, string> = {}) => ({ ...over }) as NodeJS.ProcessEnv

describe('reader rule and identity', () => {
  test('tmux, agent or transcript dir picks this daemon\'s file', () => {
    const dir = wallDirWith({ 'claude-nestor': st(), 'claude-atlas': st({ agent: 'atlas', tmux: 'claude-atlas', transcript: '/p/-ws-atlas/a.jsonl' }) })
    const o = { dir, now: NOW, env: env() }
    expect(readWallState({ tmux: 'claude-nestor' }, o)?.agent).toBe('nestor')
    expect(readWallState({ agent: 'atlas' }, o)?.tmux).toBe('claude-atlas')
    expect(readWallState({ transcriptDirs: ['/p/-ws-atlas'] }, o)?.agent).toBe('atlas')
    expect(readWallState({ transcriptDirs: ['/p/-ws-atlas/'] }, o)?.agent).toBe('atlas')
    expect(readWallState({ agent: 'hermes', transcriptDirs: ['/p/-ws-hermes'] }, o)).toBeNull()
    expect(readWallState({}, o)).toBeNull()
    const w = readWallState({ tmux: 'claude-nestor' }, o)!
    expect(w.walled).toBe(true)
    expect(w.key).toBe('claude-nestor')
    expect(w.sinceMs).toBe(NOW - 600_000)
  })
  test('stale (≥180 s), far-future, OFF, USAGE_WALL_READ=0: null (behave as before)', () => {
    const dir = wallDirWith({ 'claude-nestor': st({ updated_at: iso(NOW - 181_000) }) })
    expect(readWallState({ tmux: 'claude-nestor' }, { dir, now: NOW, env: env() })).toBeNull()
    const fut = wallDirWith({ 'claude-nestor': st({ updated_at: iso(NOW + 3600_000) }) })
    expect(readWallState({ tmux: 'claude-nestor' }, { dir: fut, now: NOW, env: env() })).toBeNull()
    const off = wallDirWith({ 'claude-nestor': st() })
    expect(readWallState({ tmux: 'claude-nestor' }, { dir: off, now: NOW, env: env() })).not.toBeNull()
    writeFileSync(join(off, 'OFF'), '')
    expect(readWallState({ tmux: 'claude-nestor' }, { dir: off, now: NOW, env: env() })).toBeNull()
    const ok = wallDirWith({ 'claude-nestor': st() })
    expect(readWallState({ tmux: 'claude-nestor' }, { dir: ok, now: NOW, env: env({ USAGE_WALL_READ: '0' }) })).toBeNull()
    expect(readWallState({ tmux: 'claude-nestor' }, { dir: join(ok, 'missing'), now: NOW, env: env() })).toBeNull()
  })
  test('USAGE_WALL_DIR selects the directory; held sidecars and unreadable files are not states', () => {
    const dir = wallDirWith({ 'claude-nestor': st() })
    writeFileSync(join(dir, 'claude-nestor.held-inbox.json'), JSON.stringify({ count: 3, agent: 'nestor', episode: 'x', updated_at: iso(NOW) }))
    writeFileSync(join(dir, 'broken.json'), '{')
    const w = readWallState({ agent: 'nestor' }, { now: NOW, env: env({ USAGE_WALL_DIR: dir }) })
    expect(w?.key).toBe('claude-nestor')
  })
  test('a non-[A-Za-z0-9._-] tmux name maps to its key', () => {
    expect(wallKey('daddy claude:1')).toBe('daddy_claude_1')
    const dir = wallDirWith({ daddy_claude_1: st({ tmux: 'daddy claude:1' }) })
    expect(readWallState({ tmux: 'daddy claude:1' }, { dir, now: NOW, env: env() })?.key).toBe('daddy_claude_1')
  })
  test('WallReader caches for cacheMs and reports a change once, synchronously', () => {
    const dir = wallDirWith({ 'claude-nestor': st() })
    let t = NOW
    const changes: string[] = []
    const r = new WallReader({ tmux: 'claude-nestor' }, { dir, cacheMs: 5000, now: () => t, env: env(),
      onChange: (p, n) => changes.push(`${p?.walled ?? null}->${n?.walled ?? null}`) })
    expect(r.walled()).toBe(true)
    writeFileSync(join(dir, 'claude-nestor.json'), JSON.stringify(st({ in_wall: false, cleared_at: iso(NOW), cleared_by: 'ok_turn', updated_at: iso(NOW) })))
    t += 4000
    expect(r.walled()).toBe(true)             // cached
    t += 2000
    expect(r.walled()).toBe(false)
    expect(r.walled()).toBe(false)
    expect(changes).toEqual(['null->true', 'true->false'])
  })
})

describe('wallAte', () => {
  const w = (over: Partial<WallState> = {}): WallState => ({ walled: true, episode: 'e', since: null, kind: null, text: null,
    resets_at: null, cleared_at: null, cleared_by: null, agent: 'a', tmux: 't', session: null, key: 't',
    sinceMs: NOW - 60_000, clearedMs: null, ...over })
  test('a push shortly before the flip, or inside the wall, was eaten', () => {
    expect(wallAte(w(), NOW - 65_000, 0, NOW)).toBe(true)
    expect(wallAte(w(), NOW - 30_000, 0, NOW)).toBe(true)
  })
  test('answered before the wall began: not eaten', () => {
    expect(wallAte(w(), NOW - 65_000, NOW - 62_000, NOW)).toBe(false)
  })
  test('after the clear: only pushes made before the clear', () => {
    const c = w({ walled: false, clearedMs: NOW - 10_000 })
    expect(wallAte(c, NOW - 65_000, NOW - 5_000, NOW)).toBe(true)     // a post-clear answer is not consumption of it
    expect(wallAte(c, NOW - 5_000, 0, NOW)).toBe(false)
  })
  test('unknown state: never', () => {
    expect(wallAte(null, NOW - 1000, 0, NOW)).toBe(false)
  })
})

describe('held sidecar', () => {
  const state = (dir: string, over: Record<string, unknown> = {}) => {
    writeFileSync(join(dir, 'claude-nestor.json'), JSON.stringify(st({ updated_at: iso(Date.now()), ...over })))
    return readWallState({ tmux: 'claude-nestor' }, { dir, env: env() })
  }
  test('written at the first wall, follows the count, snapshots at the clear, 0 after the drain, never removed', () => {
    const dir = wallDirWith()
    let held = { count: 0, oldestMs: null as number | null }
    const sc = new HeldSidecar({ dir: () => dir, role: 'inbox', held: () => held, redelivers: () => true, log: () => {} })
    const p = heldPath(dir, 'claude-nestor', 'inbox')
    sc.update(state(dir, { in_wall: false, cleared_at: iso(NOW - 3600_000), cleared_by: 'ok_turn' }))
    expect(existsSync(p)).toBe(false)                  // never walled here: no file
    const walled = state(dir)
    sc.update(walled)
    expect(readHeld(p)).toMatchObject({ redelivers: true, role: 'inbox', episode: walled!.episode, count: 0, held_at_clear: null })
    held = { count: 2, oldestMs: NOW - 120_000 }
    sc.update(walled)
    expect(readHeld(p)).toMatchObject({ count: 2, oldest: iso(NOW - 120_000) })
    expect(JSON.parse(readFileSync(p, 'utf8')).redelivers).toBe(true)
    const cleared = state(dir, { in_wall: false, cleared_at: iso(Date.now()), cleared_by: 'probe_after_reset' })
    sc.update(cleared, true)
    expect(readHeld(p)).toMatchObject({ count: 2, held_at_clear: 2, drained_at: null })
    held = { count: 0, oldestMs: null }
    sc.update(cleared)
    const after = readHeld(p)!
    expect(after).toMatchObject({ count: 0, held_at_clear: 2, oldest: null })
    expect(after.drained_at).not.toBeNull()
    expect(existsSync(p)).toBe(true)
    expect(heldTotal(dir, 'claude-nestor', walled!.episode)).toBe(2)
  })
  test('a copy the keeper saved over ours is put right at the next update', () => {
    const dir = wallDirWith()
    const sc = new HeldSidecar({ dir: () => dir, role: 'tg', held: () => ({ count: 4, oldestMs: null }), redelivers: () => true, log: () => {} })
    const walled = state(dir)
    sc.update(walled)
    const p = heldPath(dir, 'claude-nestor', 'tg')
    writeFileSync(p, JSON.stringify({ ...readHeld(p), count: 1, updated_at: iso(NOW) }))   // keeper's stale save
    sc.update(walled)
    expect(readHeld(p)!.count).toBe(4)
  })
  test('heldTotal: both roles, this episode only; held_at_clear wins over count', () => {
    const dir = wallDirWith()
    writeFileSync(heldPath(dir, 'k', 'tg'), JSON.stringify({ count: 1, episode: 'e1', held_at_clear: null }))
    writeFileSync(heldPath(dir, 'k', 'inbox'), JSON.stringify({ count: 0, episode: 'e1', held_at_clear: 3 }))
    expect(heldTotal(dir, 'k', 'e1')).toBe(4)
    expect(heldTotal(dir, 'k', 'e2')).toBe(0)
  })
})

describe('alerts: two per episode', () => {
  function rig() {
    const wdir = wallDirWith()
    const sdir = mkdtempSync(join(tmpdir(), 'uwa-'))
    const sent: string[] = []
    const make = () => new WallAlerts({ stateDir: sdir, dir: () => wdir, notify: t => sent.push(t), log: () => {}, now: () => NOW })
    const w = (over: Record<string, unknown> = {}) => {
      writeFileSync(join(wdir, 'claude-nestor.json'), JSON.stringify(st({ updated_at: iso(Date.now()), ...over })))
      return readWallState({ tmux: 'claude-nestor' }, { dir: wdir, env: env() })
    }
    return { wdir, sdir, sent, make, w }
  }
  test('enter once, nothing in between, clear once with the held count of both daemons', () => {
    const r = rig()
    const a = r.make()
    const walled = r.w()
    expect(a.tick(walled)).toBe('enter')
    for (let i = 0; i < 20; i++) expect(a.tick(r.w({ walls: 10 + i }))).toBeNull()
    expect(r.sent.length).toBe(1)
    expect(r.sent[0]).toBe(`⚠️ 系統警告（claude TUI 自身輸出，非 AI 回覆）\nYou're out of usage credits\n(usage-wall nestor)`)
    writeFileSync(heldPath(r.wdir, 'claude-nestor', 'tg'), JSON.stringify({ count: 1, episode: walled!.episode }))
    writeFileSync(heldPath(r.wdir, 'claude-nestor', 'inbox'), JSON.stringify({ count: 0, episode: walled!.episode, held_at_clear: 2 }))
    const cleared = r.w({ in_wall: false, cleared_at: '2026-11-23T07:59:00Z', cleared_by: 'probe_after_reset' })
    expect(a.tick(cleared)).toBe('clear')
    expect(a.tick(cleared)).toBeNull()
    expect(r.sent[1]).toBe('✅ nestor 用量上限解除（15:59，額度重置）；卡住期間累積 3 件，現在逐一送進去。')
    expect(r.sent.length).toBe(2)
  })
  test('a restarted daemon does not alert the same episode again', () => {
    const r = rig()
    r.make().tick(r.w())
    expect(r.make().tick(r.w())).toBeNull()
    const cleared = r.w({ in_wall: false, cleared_at: '2026-11-23T07:59:00Z', cleared_by: 'ok_turn' })
    expect(r.make().tick(cleared)).toBe('clear')
    expect(r.make().tick(cleared)).toBeNull()
    expect(r.sent.length).toBe(2)
    expect(JSON.parse(readFileSync(join(r.sdir, ALERTS_FILE), 'utf8'))[r.w().episode].clear_for).toBe('2026-11-23T07:59:00Z')
  })
  test('a reopened episode sends nothing until its next clear', () => {
    const r = rig()
    const a = r.make()
    a.tick(r.w())
    a.tick(r.w({ in_wall: false, cleared_at: '2026-11-23T07:40:00Z', cleared_by: 'probe_retry' }))
    expect(a.tick(r.w({ in_wall: true, reopened: 1 }))).toBeNull()          // walled again, same episode
    expect(a.tick(r.w({ in_wall: true, reopened: 1, walls: 9 }))).toBeNull()
    expect(a.tick(r.w({ in_wall: false, cleared_at: '2026-11-23T07:58:00Z', cleared_by: 'ok_turn' }))).toBe('clear')
    expect(r.sent.length).toBe(3)
    expect(r.sent[2]).toContain('恢復回應')
  })
  test('lanes already pushed this wall\'s enter (before the state existed): the enter is recorded, not pushed; the clear still goes', () => {
    const r = rig()
    const a = new WallAlerts({ stateDir: r.sdir, dir: () => r.wdir, notify: t => r.sent.push(t), log: () => {}, now: () => NOW,
      enterToldElsewhere: () => 'lanes main-wall-up' })
    expect(a.tick(r.w())).toBeNull()
    expect(a.tick(r.w())).toBeNull()
    expect(r.sent).toEqual([])
    expect(JSON.parse(readFileSync(join(r.sdir, ALERTS_FILE), 'utf8'))[r.w().episode].enter_by).toBe('lanes main-wall-up')
    expect(a.tick(r.w({ in_wall: false, cleared_at: '2026-11-23T07:59:00Z', cleared_by: 'ok_turn' }))).toBe('clear')
    expect(r.sent.length).toBe(1)
  })
  test('no fresh state, or a clear never seen walled: nothing', () => {
    const r = rig()
    const a = r.make()
    expect(a.tick(null)).toBeNull()
    expect(a.tick(r.w({ in_wall: false, cleared_at: '2026-11-23T07:00:00Z', cleared_by: 'ok_turn' }))).toBeNull()
    expect(r.sent).toEqual([])
  })
  test('texts: each way out; nothing held; no error line', () => {
    const base = readWallState({ tmux: 'claude-nestor' }, { dir: wallDirWith({ 'claude-nestor': st({ updated_at: iso(NOW) }) }), now: NOW, env: env() })!
    const c = (by: string) => clearText({ ...base, walled: false, cleared_by: by, clearedMs: Date.parse('2026-11-23T01:05:00Z') }, 0)
    expect(c('ok_turn')).toBe('✅ nestor 用量上限解除（09:05，恢復回應）；卡住期間沒有累積的件。')
    expect(c('probe_after_switch')).toContain('換帳號')
    expect(c('probe_retry')).toContain('重試通了')
    expect(enterText({ ...base, text: null, kind: 'weekly' })).toContain('用量上限（weekly）')
  })
})

describe('jsonl helpers', () => {
  test('isWallRecordLine: limit answers only', () => {
    const wall = JSON.stringify({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', message: { content: [] } })
    const r429 = JSON.stringify({ type: 'assistant', isApiErrorMessage: true, apiErrorStatus: 429, message: { content: [] } })
    const e500 = JSON.stringify({ type: 'assistant', isApiErrorMessage: true, apiErrorStatus: 500, message: { content: [] } })
    expect(isWallRecordLine(wall)).toBe(true)
    expect(isWallRecordLine(r429)).toBe(true)
    expect(isWallRecordLine(e500)).toBe(false)
    expect(isWallRecordLine('{"type":"user"}')).toBe(false)
  })
  test('wallCovers: a record from this episode', () => {
    const w = { sinceMs: NOW, walled: true, clearedMs: null } as WallState
    expect(wallCovers(w, NOW + 1000)).toBe(true)
    expect(wallCovers(w, NOW - 60_000)).toBe(true)
    expect(wallCovers(w, NOW - 600_000)).toBe(false)
    expect(wallCovers({ ...w, walled: false, clearedMs: NOW + 5000 } as WallState, NOW + 1000)).toBe(true)
    expect(wallCovers({ ...w, walled: false, clearedMs: NOW + 5000 } as WallState, NOW + 60_000)).toBe(false)
    expect(wallCovers(null, NOW)).toBe(false)
  })
})

describe('lanes enter note (Sonn #10731) and keeper liveness', () => {
  test('lanesEnterNote: N held → both sentences; 0 → only the second', () => {
    expect(lanesEnterNote(3)).toBe('給主線的 3 則訊息先保留，一件都沒有丟；主線一能用就交給它。車道照常處理警報與同事的事。')
    expect(lanesEnterNote(0)).toBe('車道照常處理警報與同事的事。')
  })
  test('WallAlerts enterNote: an extra line under the enter alert; none → text unchanged', () => {
    const state = mkdtempSync(join(tmpdir(), 'uwa-'))
    const w = { walled: true, episode: 'ep-note', since: iso(NOW), kind: 'fable', text: 'You have reached your Fable limit',
      resets_at: null, cleared_at: null, cleared_by: null, agent: 'nestor', tmux: 'claude-nestor', session: 's1', key: 'claude-nestor',
      sinceMs: NOW, clearedMs: null } as WallState
    const sent: string[] = []
    new WallAlerts({ stateDir: state, log: () => {}, now: () => NOW, enterNote: () => lanesEnterNote(2) }).tick(w, t => sent.push(t))
    expect(sent.length).toBe(1)
    expect(sent[0]).toBe(enterText(w) + '\n' + lanesEnterNote(2))
    const state2 = mkdtempSync(join(tmpdir(), 'uwa-'))
    const sent2: string[] = []
    new WallAlerts({ stateDir: state2, log: () => {}, now: () => NOW }).tick(w, t => sent2.push(t))
    expect(sent2).toEqual([enterText(w)])
  })
  test('wallKeeperAlive: fresh .keeper → true; stale, OFF, USAGE_WALL_READ=0, missing → false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uwk-'))
    const env = { USAGE_WALL_DIR: dir } as NodeJS.ProcessEnv
    expect(wallKeeperAlive(env)).toBe(false)
    writeFileSync(join(dir, '.keeper'), 'x')
    expect(wallKeeperAlive(env)).toBe(true)
    expect(wallKeeperAlive(env, Date.now() + 200_000)).toBe(false)
    expect(wallKeeperAlive({ ...env, USAGE_WALL_READ: '0' })).toBe(false)
    writeFileSync(join(dir, 'OFF'), '')
    expect(wallKeeperAlive(env)).toBe(false)
  })
})
