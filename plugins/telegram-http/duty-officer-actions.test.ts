// WO-176 (daemon side): the duty officer's menus as Onsen Actions (duty-officer.ts MenuActions), with a recording stand-in for the Onsen half.
//   its own press        one Action made resolved (assignees duty-officer, the option it pressed, the menu as it was before the keys)
//   a question to Joey   an open Action after the Telegram message went out: the options with keys (the buttons), the people it went to; the ask file
//                        keeps its id. A tap: answered (resolve, then applied). The screen changed under a tap, or left the menu: cancel
//   a press in Onsen     onOnsen: the same keys as a tap, every copy edited the same way ending 「從 Onsen 按的」, applied; already answered in Telegram:
//                        applied with what was pressed there; gone: cancel, nothing pressed; an Action that is not one of its asks: 'unknown'
//   no Actions           a pane that is not this agent's, or MenuActions throwing: the officer works exactly as before
// No tmux: the officer's Tmux is a stand-in (as in duty-officer.test.ts).
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DutyOfficer, askBody, optionIdOf, optionIndexOf, type Decision, type MenuActions, type ModelResult, type OfficerDeps, type PaneInfo, type Sent, type Tmux } from './duty-officer.ts'

const DIALOG = [
  '╭──────────────────────────────────────────────╮',
  '│ Bash command                                 │',
  '│   rm -rf /tmp/build-cache && make            │',
  '│ Do you want to proceed?                      │',
  '│ ❯ 1. Yes                                     │',
  '│   2. No, and tell Claude what to do (esc)    │',
  '╰──────────────────────────────────────────────╯',
].join('\n')
const IDLE = ['╭────╮', '│ >  │', '╰────╯', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
const WORKING = ['✻ Thinking… (12s · ↓ 300 tokens · esc to interrupt)', '╭────╮', '│ >  │', '╰────╯'].join('\n')
const T0 = Date.parse('2026-11-26T03:00:00Z')
const decision = (over: Partial<Decision> = {}): Decision => ({
  what: '要刪 build cache 的許可', why_now: '它在清暫存', if_nobody_answers: '120 秒後自動拒絕', covered_by: '預設全放行',
  action: 'do', choose: 'Yes', reason: '自己的暫存', to_joey: '要選 Yes', unsure: [],
  options: [{ on_screen: '1. Yes', means: '執行', button: 'Yes', keys: ['Enter'] }, { on_screen: '2. No', means: '不執行', button: 'No', keys: ['Down', 'Enter'] }],
  ...over,
})

type ACall = { op: string; [k: string]: any }
function fakeActions(o: { pane?: MenuActions['pane']; throws?: boolean } = {}) {
  const calls: ACall[] = []
  let next = 40
  const guard = (op: string) => { if (o.throws) throw new Error(`boom ${op}`) }
  const acts: MenuActions = {
    pane: (t, bundle) => { calls.push({ op: 'pane', tmux: t.tmux, test: !!t.test, bundle: !!bundle }); guard('pane'); return o.pane ? o.pane(t, bundle) : { session_id: 'sess-1', menu_kind: 'permission' } },
    assignees: chats => chats.map(c => c === '1828173984' ? 'joey' : c === '6736970916' ? 'joey-test' : 'joey'),
    open: (f, key, made) => { guard('open'); calls.push({ op: 'open', f, key }); const id = String(++next); setTimeout(() => made(id, 1), 0) },
    pressed: (f, option_id, key) => { guard('pressed'); calls.push({ op: 'pressed', f, option_id, key }) },
    answered: (ref, option_id, member, at) => { guard('answered'); calls.push({ op: 'answered', ref, option_id, member, at }) },
    applied: (ref, x) => { guard('applied'); calls.push({ op: 'applied', ref, ...x }) },
    cancel: (ref, reason) => { guard('cancel'); calls.push({ op: 'cancel', ref, reason }) },
    screenPressed: (tmux, menu) => { calls.push({ op: 'screen', tmux, menu }) },
  }
  return { acts, calls, ops: () => calls.filter(c => c.op !== 'pane').map(c => c.op) }
}

function rig(opts: { model?: (n: number) => ModelResult; onKey?: (k: string, p: { pane: string }) => void; actions?: MenuActions; dir?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'doa-dir-'))
  const rules = mkdtempSync(join(tmpdir(), 'doa-rules-'))
  writeFileSync(join(rules, 'aide_prompt.md'), 'SYSTEM')
  writeFileSync(join(rules, 'rulings.md'), 'RULINGS')
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ enabled: ['claude-x'] }))
  const pane = { pane: DIALOG, cmd: '2.1.322', inMode: false, path: '/nowhere', activity: null as number | null }
  const keys: string[] = []
  const sent: Array<{ chats: string[]; text: string; buttons: any }> = []
  const edits: Array<{ s: Sent; text: string }> = []
  let calls = 0
  let clock = T0
  const tmux: Tmux = {
    capture: async () => pane.pane,
    clientActivity: async () => pane.activity,
    info: async (): Promise<PaneInfo> => ({ cmd: pane.cmd, inMode: pane.inMode, path: pane.path }),
    sendKey: async (_t, k) => { keys.push(k); opts.onKey?.(k, pane) },
    cancelMode: async () => { pane.inMode = false },
  }
  const deps: OfficerDeps = {
    listTargets: async () => [{ label: 'claude-x', tmux: 'claude-x', projectsDir: null }],
    tmux,
    model: async () => { calls++; return opts.model ? opts.model(calls) : { decision: decision(), meta: { seconds: 1 }, fail: null } },
    send: async (chats, text, buttons) => { sent.push({ chats, text, buttons }); return chats.map((c, i) => ({ chat: c, msg: 100 + sent.length * 10 + i })) },
    edit: async (s, text) => { edits.push({ s, text }) },
    mail: async () => '#555',
    recipients: () => ['1828173984', '6736970916'],
    log: () => {},
    now: () => clock,
    sleep: async ms => { clock += ms },
    ...(opts.actions ? { actions: opts.actions } : {}),
  }
  const o = new DutyOfficer(deps, { dir, rulesDirs: [rules], home: dir, host: 'mini', limits: { claimFreshMs: 30_000 } })
  const advance = async (ms: number) => { clock += ms; await o.tick(); await new Promise(r => setTimeout(r, 0)) }
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)) }
  const log = () => readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const askFile = () => { const f = readdirSync(join(dir, 'ask')).find(n => n.endsWith('.json'))!; return JSON.parse(readFileSync(join(dir, 'ask', f), 'utf8')) }
  return { o, dir, pane, keys, sent, edits, advance, settle, log, askFile }
}
const askJoey = () => ({ decision: decision({ action: 'ask_joey', to_joey: 'claude-x 要刪 build cache，要你決定。' }), meta: {}, fail: null })
async function asked(f = fakeActions(), onKey: (k: string, p: { pane: string }) => void = (k, p) => { if (k === 'Enter') p.pane = IDLE }) {
  const r = rig({ model: askJoey, onKey, actions: f.acts })
  await r.advance(0)
  await r.advance(9000)
  await r.settle()
  return r
}

describe('the duty officer\'s menus as Actions', () => {
  test('its own press: one Action made resolved (duty-officer, the option it pressed, the menu before the keys); the channel\'s permission prompt is told', async () => {
    const f = fakeActions({ pane: () => ({ session_id: 'sess-1', menu_kind: 'model_picker' }) })
    const r = rig({ onKey: (k, p) => { if (k === 'Enter') p.pane = WORKING }, actions: f.acts })
    await r.advance(0)
    await r.advance(9000)
    await r.settle()
    expect(r.keys).toEqual(['Enter'])
    expect(f.ops()).toEqual(['pressed', 'screen'])
    const p = f.calls.find(c => c.op === 'pressed')!
    expect(p.option_id).toBe('1')
    expect(p.key).toMatch(/^menu:mini:press:claude-x:/)
    expect(p.f).toMatchObject({ menu_kind: 'model_picker', session_id: 'sess-1', assignees: ['duty-officer'], summary: 'claude-x：要刪 build cache 的許可',
      options: [{ id: '1', label: 'Yes' }, { id: '2', label: 'No' }] })
    expect(p.f.body).toContain('值班員照規矩按了「Yes」')
    // the pane was asked before the keys went (the menu as it was), once
    const paneAt = f.calls.findIndex(c => c.op === 'pane'), pressedAt = f.calls.findIndex(c => c.op === 'pressed')
    expect(paneAt).toBeGreaterThanOrEqual(0)
    expect(paneAt).toBeLessThan(pressedAt)
    expect(f.calls.find(c => c.op === 'screen')).toEqual({ op: 'screen', tmux: 'claude-x', menu: 'model_picker' })
    expect(r.sent).toEqual([])                                         // Telegram: nothing, as before
  })

  test('its own press that did not move the screen: no resolved Action (it goes to Joey as a question, with its own Action)', async () => {
    const f = fakeActions()
    const r = rig({ onKey: () => {}, actions: f.acts })
    await r.advance(0)
    await r.advance(9000)
    await r.settle()
    expect(r.keys).toEqual(['Enter'])
    expect(f.ops()).toEqual(['open'])
    expect(r.sent).toHaveLength(1)
  })

  test('a question to Joey: an open Action after the message went out; the ask file keeps its id; a tap: answered (resolve, then applied)', async () => {
    const f = fakeActions()
    const r = await asked(f)
    expect(r.sent).toHaveLength(1)
    const o = f.calls.find(c => c.op === 'open')!
    expect(o.f).toMatchObject({ menu_kind: 'permission', session_id: 'sess-1', assignees: ['joey', 'joey-test'], summary: 'claude-x：要刪 build cache 的許可',
      options: [{ id: '1', label: 'Yes' }, { id: '2', label: 'No' }] })
    expect(o.f.body).toContain('claude-x 要刪 build cache，要你決定。')
    expect(o.f.body).toContain('畫面最後幾行：\n```\n')
    const a = r.askFile()
    expect(o.key).toBe(`menu:mini:ask:${a.id}`)
    expect(a).toMatchObject({ action_key: o.key, action_id: '41', action_version: 1, menu_kind: 'permission', session_id: 'sess-1' })
    expect(r.log().some(e => e.event === 'action' && e.action_id === '41')).toBe(true)
    const btn = r.sent[0]!.buttons.map((row: any) => row[0])
    expect(await r.o.onTap(btn[1].callback_data, '@Advac777', 'joey')).toBe('按了，畫面已經往下走')
    expect(r.keys).toEqual(['Down', 'Enter'])
    const ans = f.calls.find(c => c.op === 'answered')!
    expect(ans).toMatchObject({ ref: { key: o.key, id: '41', version: 1 }, option_id: '2', member: 'joey' })
    expect(typeof ans.at).toBe('string')
    expect(r.edits).toHaveLength(2)
    expect(r.edits.every(e => e.text.includes('@Advac777 選了「No」') && !e.text.includes('從 Onsen 按的'))).toBe(true)   // Telegram's text as before
    expect(f.calls.find(c => c.op === 'screen')).toEqual({ op: 'screen', tmux: 'claude-x', menu: 'permission' })
    expect(r.askFile().closed).toMatchObject({ how: 'answered', option_id: '2', member: 'joey', via: 'telegram' })
  })

  test('pressed in Onsen: the same keys as a tap, every copy edited the same way ending 「從 Onsen 按的」, applied; a second control: applied again, no key', async () => {
    const f = fakeActions()
    const r = await asked(f)
    const out = await r.o.onOnsen('41', '2', 2, Promise.resolve('joey'))
    expect(out).toBe('按了，畫面已經往下走')
    expect(r.keys).toEqual(['Down', 'Enter'])
    expect(r.edits).toHaveLength(2)
    for (const e of r.edits) {
      expect(e.text).toContain('— joey 選了「No」')
      expect(e.text.endsWith('\n從 Onsen 按的')).toBe(true)
    }
    const ap = f.calls.filter(c => c.op === 'applied')
    expect(ap).toHaveLength(1)
    expect(ap[0]).toMatchObject({ ref: { id: '41', version: 2 } })
    expect(typeof ap[0]!.at).toBe('string')
    expect(f.calls.some(c => c.op === 'answered')).toBe(false)         // not a Telegram press: no resolve
    expect(r.askFile().closed).toMatchObject({ how: 'answered', via: 'onsen', member: 'joey', option_id: '2' })
    // the same control again (a redelivery): what was pressed is reported, nothing is pressed twice
    expect(await r.o.onOnsen('41', '2', 2)).toBe('answered in onsen before (2)')
    expect(r.keys).toEqual(['Down', 'Enter'])
    expect(f.calls.filter(c => c.op === 'applied').at(-1)).toMatchObject({ option_id: '2', resolved_by: 'joey' })
    // a tap after that: already handled, as before
    expect(await r.o.onTap(r.sent[0]!.buttons[0][0].callback_data, '@Advac777', 'joey')).toContain('已經處理過了')
  })

  test('Telegram pressed before Onsen\'s control came: Onsen hears what was really pressed, and by whom; nothing pressed twice', async () => {
    const f = fakeActions()
    const r = await asked(f)
    await r.o.onTap(r.sent[0]!.buttons[0][0].callback_data, '@Advac777', 'joey')
    expect(r.keys).toEqual(['Enter'])
    expect(await r.o.onOnsen('41', '2', 2)).toBe('answered in telegram before (1)')
    expect(r.keys).toEqual(['Enter'])
    expect(f.calls.filter(c => c.op === 'applied')).toEqual([{ op: 'applied', ref: { key: expect.any(String), id: '41', version: 2 }, option_id: '1', resolved_by: 'joey' }])
  })

  test('nothing pressed: the screen changed (a tap or Onsen), or left the menu on its own: cancel', async () => {
    const f = fakeActions()
    const r = await asked(f)
    r.pane.pane = DIALOG.replace('build-cache', 'other-dir')
    expect(await r.o.onOnsen('41', '1', 2, Promise.resolve('joey'))).toBe('畫面已經變了，沒有按')
    expect(r.keys).toEqual([])
    expect(f.calls.filter(c => c.op === 'cancel')).toEqual([{ op: 'cancel', ref: expect.objectContaining({ id: '41', version: 2 }), reason: '畫面已經變了，沒有按' }])
    expect(r.edits.every(e => e.text.includes('畫面已經變了，沒有按') && e.text.endsWith('\n從 Onsen 按的'))).toBe(true)
    // the screen leaves the menu on its own (another question): closeGone cancels it
    const f2 = fakeActions()
    const r2 = await asked(f2)
    r2.pane.pane = IDLE
    await r2.advance(3000)
    await r2.settle()
    expect(r2.edits[0]!.text).toContain('不用選了')
    expect(f2.calls.filter(c => c.op === 'cancel').map(c => c.reason)).toEqual(['畫面已經離開這個選單（現在閒著）'])
    // and a control that comes after: cancel again (at its version), no key
    expect(await r2.o.onOnsen('41', '1', 2)).toBe('gone')
    expect(r2.keys).toEqual([])
    expect(f2.calls.filter(c => c.op === 'cancel').at(-1)).toMatchObject({ ref: { id: '41', version: 2 } })
  })

  test('an Action that is not one of its asks: unknown (the daemon cancels it); after a restart the ask file is found and pressed', async () => {
    const f = fakeActions()
    const r = await asked(f)
    expect(await r.o.onOnsen('999', '1', 2)).toBe('unknown')
    expect(r.keys).toEqual([])
    // a new officer on the same directory (the daemon restarted): the ask is read from its file
    const f2 = fakeActions()
    const r2 = rig({ dir: r.dir, actions: f2.acts, onKey: (k, p) => { if (k === 'Enter') p.pane = IDLE } })
    expect(await r2.o.onOnsen('41', '1', 2, Promise.resolve('joey'))).toBe('按了，畫面已經往下走')
    expect(r2.keys).toEqual(['Enter'])
    expect(f2.calls.filter(c => c.op === 'applied')).toHaveLength(1)
    expect(r2.edits).toHaveLength(2)
  })

  test('an option without keys, or an Onsen option id that is no option: cancel, nothing pressed', async () => {
    const f = fakeActions()
    const r = rig({ model: () => ({ decision: decision({ action: 'ask_joey', options: [...decision().options, { on_screen: '3. Type', means: '打字', button: 'Other', keys: [{ t: 'x' }] as any }] }), meta: {}, fail: null }),
      actions: f.acts })
    await r.advance(0); await r.advance(9000); await r.settle()
    expect(f.calls.find(c => c.op === 'open')!.f.options).toEqual([{ id: '1', label: 'Yes' }, { id: '2', label: 'No' }])   // only the buttons
    expect(await r.o.onOnsen('41', '3', 2)).toBe('no such option')
    expect(await r.o.onOnsen('41', 'allow', 2)).toBe('no such option')
    expect(r.keys).toEqual([])
    expect(f.calls.filter(c => c.op === 'cancel')).toHaveLength(2)
  })

  test('a question with no button at all (a raw screen without a numbered menu): no Action', async () => {
    const f = fakeActions()
    const r = rig({ model: () => ({ decision: null, meta: {}, fail: 'model down' }), actions: f.acts })
    r.pane.pane = DIALOG.replace('❯ 1. Yes', '  Yes')                 // no live cursor: not a numbered menu
    await r.advance(0); await r.advance(9000); await r.settle()
    expect(r.sent).toHaveLength(1)
    expect(f.ops()).toEqual([])
    expect(r.log().some(e => e.event === 'action_skipped')).toBe(true)
  })

  test('not this agent\'s pane (pane() null), no MenuActions, or MenuActions throwing: the officer works as before', async () => {
    for (const actions of [fakeActions({ pane: () => null }).acts, undefined, fakeActions({ throws: true }).acts]) {
      const r = rig({ model: askJoey, onKey: (k, p) => { if (k === 'Enter') p.pane = IDLE }, ...(actions ? { actions } : {}) })
      await r.advance(0); await r.advance(9000); await r.settle()
      expect(r.sent).toHaveLength(1)
      expect(r.askFile().action_key).toBeUndefined()
      expect(await r.o.onTap(r.sent[0]!.buttons[1][0].callback_data, '@Advac777', 'joey')).toBe('按了，畫面已經往下走')
      expect(r.keys).toEqual(['Down', 'Enter'])
      expect(r.edits).toHaveLength(2)
    }
    const f = fakeActions({ throws: true })
    const r = rig({ onKey: (k, p) => { if (k === 'Enter') p.pane = WORKING }, actions: f.acts })
    await r.advance(0); await r.advance(9000); await r.settle()
    expect(r.keys).toEqual(['Enter'])                                  // its own press too
  })

  test('a restart: the questions its panes had open get their Actions cancelled once (Telegram untouched); a control for one of them presses nothing', async () => {
    const f = fakeActions()
    const r = await asked(f)
    const f2 = fakeActions()
    const r2 = rig({ dir: r.dir, actions: f2.acts, onKey: (k, p) => { if (k === 'Enter') p.pane = IDLE } })
    expect(r2.o.cancelOrphans()).toBe(1)
    expect(f2.calls.filter(c => c.op === 'cancel')).toEqual([{ op: 'cancel', ref: expect.objectContaining({ id: '41' }), reason: expect.stringContaining('常駐程式重開了') }])
    expect(r2.edits).toEqual([])
    expect(r2.o.cancelOrphans()).toBe(0)                                // once
    expect(await r2.o.onOnsen('41', '1', 2)).toBe('gone')
    expect(r2.keys).toEqual([])
    // not this daemon's pane: left alone
    const f3 = fakeActions({ pane: () => null })
    const r3 = await asked(fakeActions())
    expect(rig({ dir: r3.dir, actions: f3.acts }).o.cancelOrphans()).toBe(0)
    // a Telegram tap still works as before
    expect(await r2.o.onTap(r.sent[0]!.buttons[0][0].callback_data, '@Advac777', 'joey')).toBe('按了，畫面已經往下走')
  })

  test('openActionFor: the newest open ask with an Action on that pane, for that menu (a status blocker\'s action_id)', async () => {
    const f = fakeActions()
    const r = await asked(f)
    expect(r.o.openActionFor('claude-x', 'permission')).toBe('41')
    expect(r.o.openActionFor('claude-x', 'model_picker')).toBeNull()
    expect(r.o.openActionFor('other', 'permission')).toBeNull()
    await r.o.onTap(r.sent[0]!.buttons[0][0].callback_data, '@Advac777', 'joey')
    expect(r.o.openActionFor('claude-x', 'permission')).toBeNull()
  })

  test('helpers: option ids are index + 1; the body puts the screen in code blocks', () => {
    expect([optionIdOf(0), optionIdOf(9)]).toEqual(['1', '10'])
    expect([optionIndexOf('1'), optionIndexOf('10'), optionIndexOf('0'), optionIndexOf('allow'), optionIndexOf('100')]).toEqual([0, 9, -1, -1, -1])
    const b = askBody('note\n\n— 畫面最後幾行 —\nline ```x```\n\n— 等待中的工具呼叫 —\nBash {"c":1}')
    expect(b).toBe("note\n\n畫面最後幾行：\n```\nline '''x'''\n```\n\n等待中的工具呼叫：\n```\nBash {\"c\":1}\n```")
    expect(askBody('plain')).toBe('plain')
  })
})
