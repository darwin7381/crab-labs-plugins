// WO-168 stage two, the duty officer on its own pane (Chiron 05:24:56Z; item 6 after his 05:54Z call):
//   it reads state, menu kind, options and freshness from the status record of the look it acts on (no capture of its own on that pane), and keeps
//   its rulings: /model, /resume and trust-folder menus judged and handled as before (ticket criterion 6)
//   program rules, as code, not for the model:
//     usage_limit_options  no option chosen, no key pressed, no leaning: the options as they are go to Joey (buttons and an Action); only his tap presses,
//                          and only that one; no ruling mail
//     switch_confirm       still up after the stall (no program took it): Esc (No, go back)
//     refusal_fallback     modal-guard's rule moved in: 120 s from first seen, then Esc and its notice; once per 5 min; the 3rd in 30 min: no Esc, no
//                          notice, the alert; left to modal-guard while its script is installed (one of them, never both)
//   before any key: the officer's tail hash AND the record's screen hash must still be the screen it decided on
// The record is screen-status.ts's real composition (no judge: the program's facts; or a verdict handed in); the screens are real (test-fixtures/wo168).
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DutyOfficer, REFUSAL, REFUSAL_NOTICE, optionButtons, stateOfRecord, type Decision, type MenuActions, type ModelResult, type OfficerDeps, type PaneInfo, type Tmux } from './duty-officer.ts'
import { composeRecord, regionParts, screenFacts, screenHash, type ScreenVerdict } from './screen-status.ts'
import { stripAnsi, type PaneLook } from './pane-look.ts'
import type { StatusView } from './onsen-status.ts'

const FX = join(import.meta.dir, 'test-fixtures', 'wo168')
const fx = (f: string): string => readFileSync(join(FX, f), 'utf8')
// the screens with their escapes (the dim suggestion in the idle box is not typed text); a plain fixture has none
const IDLE = fx('cc-02-idle.ansi').replace(/\n$/, ''), TYPED = fx('cc-03-typed.ansi').replace(/\n$/, '')
const T0 = Date.parse('2026-11-26T06:30:00Z')
const decision = (over: Partial<Decision> = {}): Decision => ({
  what: '模型選單', why_now: '有人開了 /model', if_nobody_answers: '一直停著', covered_by: '結果要等於登記的那一個', action: 'do', choose: 'Esc', reason: '維持登記的模型',
  to_joey: '', unsure: [], options: [{ on_screen: 'Esc to cancel', means: '關掉', button: 'Esc', keys: ['Esc'] }], ...over })

function rig(o: { screen?: string; verdict?: (t: string) => ScreenVerdict | null; model?: () => ModelResult; config?: Record<string, unknown>; modalGuard?: boolean
  onKey?: (k: string, p: { screen: string }) => void; prog?: StatusView } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'do168-home-')), dir = join(home, 'do'), rules = mkdtempSync(join(tmpdir(), 'do168-rules-'))
  mkdirSync(dir, { recursive: true })
  if (o.modalGuard) { mkdirSync(join(home, '.claude', 'scripts'), { recursive: true }); writeFileSync(join(home, '.claude', 'scripts', 'ratelimit-modal-guard.sh'), '#!/bin/sh\n') }
  writeFileSync(join(rules, 'aide_prompt.md'), 'SYSTEM'); writeFileSync(join(rules, 'rulings.md'), 'RULINGS')
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ enabled: ['claude-x'], ...(o.config ?? {}) }))
  const pane = { screen: o.screen ?? IDLE }
  const keys: string[] = [], typed: string[] = [], sent: Array<{ text: string; buttons: any }> = [], mails: string[] = [], acts: string[] = [], alerts: any[] = []
  let calls = 0, captures = 0, looks = 0, clock = T0, seq = 0
  const prog = o.prog ?? { state: 'idle', detail: { queued_joey: 0 }, last_activity_at: null } as StatusView
  const tmux: Tmux = { capture: async () => { captures++; return pane.screen }, clientActivity: async () => null,
    info: async (): Promise<PaneInfo> => ({ cmd: '2.1.322', inMode: false, path: '/nowhere' }),
    sendKey: async (_t, k) => { keys.push(k); o.onKey?.(k, pane) }, sendText: async (_t, text) => { typed.push(text) }, cancelMode: async () => {} }
  const ownPane = {
    tmux: 'claude-x',
    look: async (): Promise<PaneLook> => { looks++; const v = stripAnsi(pane.screen); return { at: clock, seq: ++seq, cmd: '2.1.322', inMode: false, path: '/nowhere', visible: v, visibleAnsi: pane.screen, text: v } },
    recordOf: (l: PaneLook) => {
      const parts = regionParts(l.visible), hash = screenHash(parts)
      return { view: composeRecord(o.verdict?.(l.visible) ?? null, parts.st, prog, { alive: true }, { hash, seen_at: l.at, facts: screenFacts(l.visible, l.visibleAnsi, parts.st) }).view, hash }
    },
  }
  const actions: MenuActions = { pane: (_t, b) => ({ session_id: 'main', menu_kind: (b?._menu_kind as string) ?? null }), assignees: c => c.map(() => 'joey'),
    open: (f, _k, made) => { acts.push(`open:${f.menu_kind}:${f.options.map(x => x.label).join('|')}`); setTimeout(() => made('a1', 1), 0) },
    pressed: (f, id) => { acts.push(`pressed:${f.menu_kind}:${id}:${f.assignees.join(',')}`) }, answered: (_r, id) => { acts.push(`answered:${id}`) },
    applied: () => { acts.push('applied') }, cancel: (_r, why) => { acts.push(`cancel:${why}`) } }
  const deps: OfficerDeps = { listTargets: async () => [{ label: 'claude-x', tmux: 'claude-x', projectsDir: null }], tmux, ownPane, actions,
    model: async () => { calls++; return o.model ? o.model() : { decision: decision(), meta: {}, fail: null } },
    send: async (_c, text, buttons) => { sent.push({ text, buttons }); return [{ chat: '1828173984', msg: 100 + sent.length }] }, edit: async () => {},
    mail: async (title) => { mails.push(title); return '#1' }, recipients: () => ['1828173984'], log: () => {}, now: () => clock, sleep: async ms => { clock += ms },
    alert: async a => { alerts.push(a); return 'HTTP 200' } }
  const off = new DutyOfficer(deps, { dir, rulesDirs: [rules], home, host: 'mini', limits: { claimFreshMs: 30_000 } })
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 0)) }
  const advance = async (ms: number) => { clock += ms; await off.tick(); await settle() }
  const log = () => { try { return readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) } catch { return [] as any[] } }
  return { off, pane, keys, typed, sent, mails, acts, alerts, advance, settle, log, home, calls: () => calls, captures: () => captures, looks: () => looks, clock: () => clock }
}

describe('the record\'s state as the officer\'s', () => {
  test('stateOfRecord: a menu (waiting, or kept while walled or starting) is OTHER with its kind and options; busy/stuck WORKING; idle/walled IDLE; starting/offline STARTING', () => {
    expect(stateOfRecord({ state: 'waiting', detail: { waitingFor: 'model_picker', waiting_text: 'Select model', menu_options: [{ n: 1, text: 'a', cursor: true }] } }))
      .toEqual({ state: 'OTHER', menu: { kind: 'model_picker', options: [{ n: 1, text: 'a', cursor: true }], question: 'Select model' } })
    expect(stateOfRecord({ state: 'waiting', detail: { waitingFor: 'permission prompt' } }).menu!.kind).toBe('permission')   // statusOf's registry words
    expect(stateOfRecord({ state: 'walled', detail: { waitingFor: 'usage_limit_options' } }).state).toBe('OTHER')
    expect(stateOfRecord({ state: 'walled', detail: {} }).state).toBe('IDLE')
    expect(stateOfRecord({ state: 'busy' }).state).toBe('WORKING'); expect(stateOfRecord({ state: 'stuck' }).state).toBe('WORKING')
    expect(stateOfRecord({ state: 'idle' }).state).toBe('IDLE')
    expect(stateOfRecord({ state: 'starting' }).state).toBe('STARTING'); expect(stateOfRecord({ state: 'offline' }).state).toBe('STARTING')
  })
  test('optionButtons: a numbered menu\'s keys move from the cursor; an unnumbered list gets no keys (as numberedMenu)', () => {
    expect(optionButtons([{ n: 1, text: 'Stop', cursor: true }, { n: 2, text: 'Wait', cursor: false }])).toEqual([{ button: '1. Stop', keys: ['Enter'] }, { button: '2. Wait', keys: ['Down', 'Enter'] }])
    expect(optionButtons([{ n: null, text: 'No, exit', cursor: true }, { n: null, text: 'Yes', cursor: false }]).map(b => b.keys)).toEqual([null, null])
  })
})

describe('the own pane through the record', () => {
  test('an idle screen whose footer is pushed off the last 12 lines (a false stall before): IDLE by the record, no model call; no capture of its own', async () => {
    const r = rig({ screen: IDLE + '\n' + Array.from({ length: 14 }, (_, i) => `  ◼ task ${i}`).join('\n') })
    await r.advance(0); await r.advance(9000); await r.advance(9000)
    expect(r.calls()).toBe(0); expect(r.sent).toEqual([]); expect(r.keys).toEqual([])
    expect(r.captures()).toBe(0)                                                        // every look is the record's capture (ownPane.look)
    expect(r.looks()).toBeGreaterThan(0)
  })
  test('criterion 6: the /model picker is judged as before (the model, its rulings); the bundle\'s screen is the look\'s; Esc pressed on the same screen', async () => {
    const r = rig({ screen: fx('cc-05-model.plain'), verdict: t => /Select model/.test(t) ? { state: 'waiting_for_human', menu: 'model_picker', p: 0.98, by: 'jev' } : null, onKey: (k, p) => { if (k === 'Escape') p.screen = IDLE } })
    await r.advance(0); await r.advance(9000)
    expect(r.calls()).toBe(1); expect(r.keys).toEqual(['Escape']); expect(r.captures()).toBe(0)
    expect(r.log().find(e => e.event === 'pressed')).toMatchObject({ resolved: true, after_state: 'IDLE' })
    expect(r.acts).toEqual(['pressed:model_picker:1:duty-officer'])                     // its Action carries the record's kind
  })
  test('criterion 6: the trust prompt and the resume list go to the model as before; a failed model gives Joey the raw screen (no buttons for an unnumbered list, as before)', async () => {
    for (const s of ['cc-01-start.plain', 'lab-resume-picker.txt']) {
      const r = rig({ screen: fx(s), model: () => ({ decision: null, meta: {}, fail: 'timeout 60s' }) })
      await r.advance(0); await r.advance(9000)
      expect(r.calls()).toBe(1); expect(r.keys).toEqual([])
      expect(r.sent.length).toBe(1); expect(r.sent[0]!.text).toContain('判斷不了（timeout 60s）')
    }
  })
  test('freshness: the record\'s screen changed between the decision and the key (the tail the same): nothing pressed', async () => {
    let flip = false
    const r = rig({ screen: fx('cc-05-model.plain'), verdict: t => /Select model/.test(t) ? { state: 'waiting_for_human', menu: 'model_picker', p: 0.98, by: 'jev' } : null,
      model: () => { flip = true; return { decision: decision(), meta: {}, fail: null } } })
    const base = fx('cc-05-model.plain')
    r.pane.screen = base
    // the model's answer comes back; before the key the screen above the last 12 lines changed (the tail hash cannot see it, the record's hash does)
    const lookBefore = (r.off as any).d.ownPane.look
    ;(r.off as any).d.ownPane.look = async () => { const l = await lookBefore(); if (flip) { const v = 'Switch model?\n' + base; return { ...l, visible: v, text: v } } return l }
    await r.advance(0); await r.advance(9000)
    expect(r.calls()).toBe(1); expect(r.keys).toEqual([])
    expect(r.log().some(e => e.event === 'aborted' && e.why === 'screen changed before pressing')).toBe(true)
  })
})

describe('program rule: the usage-limit options (Chiron\'s rule, verbatim, as code)', () => {
  test('no model, no key, no leaning: the options as they are go to Joey with buttons and an Action; only his tap presses, and only that one; no ruling mail', async () => {
    const r = rig({ screen: fx('lab-limit-options-menu.txt'), onKey: (k, p) => { if (k === 'Enter') p.screen = IDLE } })
    await r.advance(0); await r.advance(4000)
    expect(r.sent).toEqual([])                                                          // the stall time first, as for any menu
    await r.advance(5000)
    expect(r.calls()).toBe(0); expect(r.keys).toEqual([])
    expect(r.sent.length).toBe(1)
    expect(r.sent[0]!.text).toContain('額度怎麼用是你的決定：值班員不選、不按任何鍵')
    expect(r.sent[0]!.buttons.map((row: any) => row[0].text)).toEqual(['1. Stop and wait for limit to reset', '2. Wait here, then continue automatically at Dec 1, 6am'])
    expect(r.acts).toEqual(['open:usage_limit_options:1. Stop and wait for limit to reset|2. Wait here, then continue automatically at Dec 1, 6am'])
    for (let i = 0; i < 20; i++) await r.advance(60_000)                               // nobody answers: still nothing pressed (no default after a while)
    expect(r.keys).toEqual([])
    const res = await r.off.onTap(r.sent[0]!.buttons[1][0].callback_data, 'Advac777', 'joey')
    expect(r.keys).toEqual(['Down', 'Enter'])
    expect(res).toBe('按了，畫面已經往下走')
    await r.settle()
    expect(r.mails).toEqual([])                                                         // his resource decision, not a ruling
  })
  test('the same with Jev\'s verdict naming it (v7 and v8 both have the kind); while walled the record still names the menu', async () => {
    const r = rig({ screen: fx('lab-limit-options-menu.txt'), verdict: () => ({ state: 'waiting_for_human', menu: 'usage_limit_options', p: 1, by: 'jev' }),
      prog: { state: 'idle', detail: { queued_joey: 0, walled: { until: '2026-12-01T06:00:00Z', kind: 'weekly' } }, last_activity_at: null } })
    await r.advance(0); await r.advance(9000)
    expect(r.calls()).toBe(0); expect(r.keys).toEqual([]); expect(r.sent.length).toBe(1)
    expect(r.log().find(e => e.event === 'usage_limit_asked')).toBeTruthy()
  })
})

describe('program rule: switch_confirm (Chiron\'s rulings 4)', () => {
  test('a /model confirm still up after the stall (no program is taking it): Esc, model unchanged; recorded as the officer\'s press', async () => {
    const r = rig({ screen: fx('yes-no-confirm-2.txt'), onKey: (k, p) => { if (k === 'Escape') p.screen = IDLE } })
    await r.advance(0); await r.advance(4000)
    expect(r.keys).toEqual([])                                                          // the switch command presses Yes within a second or two: not the officer's yet
    await r.advance(5000)
    expect(r.calls()).toBe(0); expect(r.keys).toEqual(['Escape']); expect(r.sent).toEqual([])
    expect(r.log().find(e => e.event === 'pressed')).toMatchObject({ rule: 'switch_confirm', keys: ['Esc'] })
    expect(r.acts).toEqual(['pressed:switch_confirm:1:duty-officer'])
  })
})

describe('program rule: the refusal-fallback picker (Chiron\'s rulings 3; modal-guard\'s numbers)', () => {
  const refusal = (o: { modalGuard?: boolean; config?: Record<string, unknown> } = {}) => rig({ screen: fx('refusal-fallback-2.txt'), config: o.config, modalGuard: o.modalGuard,
    onKey: (k, p) => { if (k === 'Escape') p.screen = IDLE } })
  test('Esc only after 120 s from first seen; then its notice typed into the input box and sent; never Switch, never Edit and retry; no model', async () => {
    const r = refusal({ config: { refusal_fallback: 'officer' } })
    await r.advance(0)
    await r.advance(60_000); expect(r.keys).toEqual([])
    await r.advance(59_000); expect(r.keys).toEqual([])
    await r.advance(3000)
    expect(r.keys).toEqual(['Escape', 'Enter'])                                         // Esc; the notice is typed, then Enter
    expect(r.typed).toEqual([REFUSAL_NOTICE])
    expect(r.calls()).toBe(0); expect(r.sent).toEqual([])
    expect(r.acts).toEqual(['pressed:refusal_fallback:1:duty-officer'])
    expect(r.log().map(e => e.event)).toContain('refusal_notice')
  })
  test('one Esc per 5 min on the pane; the 3rd picker within 30 min: no Esc, no notice, the alert (session.flagged); gone, the count starts anew', async () => {
    const r = refusal({ config: { refusal_fallback: 'officer' } })
    const back = async () => { r.pane.screen = fx('refusal-fallback-2.txt'); await r.advance(1000) }
    await r.advance(0); await r.advance(121_000)
    expect(r.keys.filter(k => k === 'Escape').length).toBe(1)
    await r.advance(3000); await back()                                                // the picker again 2 min later
    await r.advance(121_000)
    expect(r.keys.filter(k => k === 'Escape').length).toBe(1)                          // within 5 min of the last Esc
    await r.advance(REFUSAL.debounceMs)
    expect(r.keys.filter(k => k === 'Escape').length).toBe(2)
    await r.advance(3000); await back(); await r.advance(REFUSAL.debounceMs + 1000)
    expect(r.keys.filter(k => k === 'Escape').length).toBe(2)                          // the 3rd in 30 min: no Esc
    expect(r.typed.length).toBe(2)
    expect(r.alerts).toEqual([expect.objectContaining({ chart: 'session.flagged', severity: 'critical', node: 'agent:x', value: '3 refusal pickers in 30 min' })])
    await r.advance(REFUSAL.debounceMs)
    expect(r.keys.filter(k => k === 'Escape').length).toBe(2)                          // hands off until the picker is gone
    r.pane.screen = IDLE; await r.advance(3000)
    expect(r.log().map(e => e.event)).toContain('refusal_reset')
  })
  test('the notice is never typed into a menu or over typed text', async () => {
    const r = rig({ screen: fx('refusal-fallback-3.txt'), config: { refusal_fallback: 'officer' }, onKey: (k, p) => { if (k === 'Escape') p.screen = TYPED } })
    await r.advance(0); await r.advance(121_000)
    expect(r.keys).toEqual(['Escape']); expect(r.typed).toEqual([])
    expect(r.log().find(e => e.event === 'refusal_notice_skipped')).toBeTruthy()
  })
  test('while modal-guard is installed on this machine it keeps the picker (one of them, never both); nothing pressed, no model', async () => {
    const r = refusal({ modalGuard: true })
    await r.advance(0); await r.advance(200_000)
    expect(r.keys).toEqual([]); expect(r.calls()).toBe(0); expect(r.sent).toEqual([])
    expect(r.log().filter(e => e.event === 'left_to_modal_guard').length).toBe(1)
  })
  test('layout 1 (Switch automatically / Stay on): the same rule', async () => {
    const r = rig({ screen: fx('refusal-fallback-1.txt'), config: { refusal_fallback: 'officer' }, onKey: (k, p) => { if (k === 'Escape') p.screen = IDLE } })
    await r.advance(0); await r.advance(121_000)
    expect(r.keys).toEqual(['Escape', 'Enter']); expect(r.typed).toEqual([REFUSAL_NOTICE])
  })
})

describe('the menu-owner file and the re-arm on the own pane', () => {
  test('the re-arm of a usage-limit menu on the own pane uses the record\'s options and asks with the usage rule\'s words', async () => {
    const r = rig({ screen: fx('lab-limit-options-menu.txt') })
    await r.advance(0)
    const out = await r.off.rearm('claude-x')
    expect(out).toEqual({ result: 'asked', options: ['1. Stop and wait for limit to reset', '2. Wait here, then continue automatically at Dec 1, 6am'] })
    expect(r.sent[0]!.text).toContain('額度怎麼用是你的決定'); expect(r.keys).toEqual([])
  })
  test('the officer writes ~/.claude/lanes/menu-owner/<tmux>.json for its own pane (fields modal-guard and the watchdog read: mtime, pid)', async () => {
    const r = rig()
    await r.advance(0)
    const j = JSON.parse(readFileSync(join(r.home, '.claude', 'lanes', 'menu-owner', 'claude-x.json'), 'utf8'))
    expect(j).toMatchObject({ owner: 'duty-officer', menus: ['usage-limit'], tmux: 'claude-x', pid: process.pid })
  })
})
