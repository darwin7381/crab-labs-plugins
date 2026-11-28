// Menus offered in Onsen share the open Action with the permission prompt. Screen answers only cancel it.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DutyOfficer, askBody, hourlyCapFor, optionIdOf, optionIndexOf, permOptionOf, type Decision, type MenuActions, type ModelResult, type OfficerDeps, type PaneInfo, type Sent, type Tmux } from './duty-officer.ts'

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
function fakeActions(o: { pane?: MenuActions['pane']; throws?: boolean; shared?: MenuActions['shared']
  bind?: MenuActions['bindPermission'] } = {}) {
  const calls: ACall[] = []
  let next = 40
  const guard = (op: string) => { if (o.throws) throw new Error(`boom ${op}`) }
  const acts: MenuActions = {
    pane: (t, bundle) => { calls.push({ op: 'pane', tmux: t.tmux, test: !!t.test, bundle: !!bundle }); guard('pane'); return o.pane ? o.pane(t, bundle) : { session_id: 'sess-1', menu_kind: 'permission' } },
    assignees: chats => chats.map(c => c === '1828173984' ? 'joey' : c === '6736970916' ? 'joey-test' : 'joey'),
    open: (f, key, made) => { guard('open'); calls.push({ op: 'open', f, key }); const id = String(++next); setTimeout(() => made(id, 1), 0) },
    ...(o.bind ? { bindPermission: (t: { tmux: string; test?: boolean }, b?: Record<string, unknown>) => { const r = o.bind!(t, b); calls.push({ op: 'bind', tmux: t.tmux, r }); return r } } : {}),
    permissionGone: bound => { calls.push({ op: 'permissionGone', bound }) },
    applied: (ref, x) => { guard('applied'); calls.push({ op: 'applied', ref, ...x }) },
    cancel: (ref, reason) => { guard('cancel'); calls.push({ op: 'cancel', ref, reason }) },
    ...(o.shared ? { shared: (t: { tmux: string; test?: boolean }, menu: string | null, assignees: string[], joined: (v: number) => void) => {
      calls.push({ op: 'shared', tmux: t.tmux, menu, assignees }); return o.shared!(t, menu, assignees, joined) } } : {}),
  }
  return { acts, calls, ops: () => calls.filter(c => c.op !== 'pane' && c.op !== 'shared' && c.op !== 'bind').map(c => c.op) }
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
  for (const menu_kind of ['model_picker', 'permission']) test('an officer pressing ' + menu_kind + ' writes no Action', async () => {
    const f = fakeActions({ pane: () => ({ session_id: 'main', menu_kind }) })
    const r = rig({ onKey: (key, pane) => { if (key === 'Enter') pane.pane = WORKING }, actions: f.acts })
    await r.advance(0); await r.advance(9000); await r.settle()
    expect(r.keys).toEqual(['Enter'])
    expect(r.log().some(e => e.event === 'pressed' && e.resolved)).toBe(true)
    expect(f.ops()).toEqual([])
  })

  test('a local press closes only the permission already on screen before the next request appeared', async () => {
    let key = 'first-permission'
    const f = fakeActions({ bind: () => ({ key }) })
    const r = rig({ onKey: (_, pane) => { key = 'next-permission'; pane.pane = WORKING }, actions: f.acts })
    await r.advance(0); await r.advance(9000); await r.settle()
    expect(r.keys).toEqual(['Enter'])
    expect(f.ops()).toEqual(['permissionGone'])
    expect(f.calls.at(-1)).toEqual({ op: 'permissionGone', bound: { key: 'first-permission' } })
  })

  test('WO-180 (Chiron 04:42Z, 1): openAskFor names the question\'s Action and the first person it went to while it is open; its own press, another menu, or answered: none', async () => {
    const own = fakeActions({ pane: () => ({ session_id: 'main', menu_kind: 'model_picker' }) })
    const p = rig({ onKey: (k, x) => { if (k === 'Enter') x.pane = WORKING }, actions: own.acts })
    await p.advance(0); await p.advance(9000); await p.settle()
    expect(own.ops()).toEqual([])                              // r4: no screenPressed hook any more (no blanket end of other prompts)
    expect(p.o.openAskFor('claude-x', 'model_picker')).toBeNull()                                            // its own press: no question to anybody
    const g = fakeActions({ pane: () => ({ session_id: 'main', menu_kind: 'model_picker' }) })
    const r = await asked(g)
    expect(r.o.openAskFor('claude-x', 'model_picker')).toEqual({ action_id: '41', assignee: 'joey' })      // recipients 1828173984, 6736970916 → joey, joey-test
    expect(r.askFile().assignees).toEqual(['joey', 'joey-test'])
    expect(r.o.openAskFor('claude-x', 'resume_picker')).toBeNull()
    expect(r.o.openAskFor('claude-y', 'model_picker')).toBeNull()
    expect(r.o.openActionFor('claude-x', 'model_picker')).toBe('41')
    await r.o.onTap(r.sent[0]!.buttons[0][0].callback_data, '@Advac777', 'joey')
    expect(r.o.openAskFor('claude-x', 'model_picker')).toBeNull()                                            // answered: the menu is nobody's question now
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

  test('a question to Joey: an open Action after the message went out; the ask file keeps its id; a screen answer cancels the open Action', async () => {
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
    expect(f.calls.filter(c => c.op === 'cancel')).toEqual([{ op: 'cancel', ref: { key: o.key, id: '41', version: 1 }, reason: '在別處按了' }])
    expect(f.ops()).toEqual(['open', 'cancel'])
    expect(r.edits).toHaveLength(2)
    expect(r.edits.every(e => e.text.includes('@Advac777 選了「No」') && !e.text.includes('從 Onsen 按的'))).toBe(true)   // Telegram's text as before
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

  test('a late Onsen control cannot apply an external answer', async () => {
    const f = fakeActions()
    const r = await asked(f)
    await r.o.onTap(r.sent[0]!.buttons[0][0].callback_data, '@Advac777', 'joey')
    expect(r.keys).toEqual(['Enter'])
    expect(await r.o.onOnsen('41', '2', 2)).toBe('gone')
    expect(r.keys).toEqual(['Enter'])
    expect(f.calls.filter(c => c.op === 'applied')).toEqual([])
  })

  test('nothing pressed: the screen changed (a tap or Onsen), or left the menu on its own: cancel', async () => {
    const f = fakeActions()
    const r = await asked(f)
    r.pane.pane = DIALOG.replace('build-cache', 'other-dir')
    expect(await r.o.onOnsen('41', '1', 2, Promise.resolve('joey'))).toBe('畫面已經變了，沒有按')
    expect(r.keys).toEqual([])
    expect(f.calls.filter(c => c.op === 'cancel')).toEqual([{ op: 'cancel', ref: expect.objectContaining({ id: '41', version: 2 }), reason: '在別處按了' }])
    expect(r.edits.every(e => e.text.includes('畫面已經變了，沒有按') && e.text.endsWith('\n從 Onsen 按的'))).toBe(true)
    // the screen leaves the menu on its own (another question): closeGone cancels it
    const f2 = fakeActions()
    const r2 = await asked(f2)
    r2.pane.pane = IDLE
    await r2.advance(3000)
    await r2.settle()
    expect(r2.edits[0]!.text).toContain('不用選了')
    expect(f2.calls.filter(c => c.op === 'cancel').map(c => c.reason)).toEqual(['在別處按了'])
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

  // ---- WO-176 r2 (CONTRACT §6 「畫面上同一個詢問只有一個 Action」): a question about a permission prompt uses the channel's Action for it
  const PERM_KEY = 'perm:adam:abcde:1700000000000'
  const sharing = (o: { id?: string; joinTo?: number; async?: boolean } = { id: '7' }) => fakeActions({ shared: (_t, menu, _as, joined) => {
    const r = menu === 'permission' ? { key: PERM_KEY, ...(o.id ? { id: o.id, version: 1 } : {}) } : null
    if (r && o.joinTo) setTimeout(() => joined(o.joinTo!), 5)                 // the join moved its version
    return o.async ? Promise.resolve(r) : r
  } })
  const permDecision = (extra: any[] = []) => decision({ action: 'ask_joey', to_joey: 'claude-x 要刪 build cache，要你決定。',
    options: [{ on_screen: '1. Yes', means: '執行', button: '可以', keys: ['Enter'] }, { on_screen: "2. Yes, and don't ask again for rm commands", means: '以後都可以', button: '以後都可以', keys: ['Down', 'Enter'] },
      { on_screen: '3. No, and tell Claude what to do differently (esc)', means: '不執行', button: '不要', keys: ['Down', 'Down', 'Enter'] }, ...extra] })
  async function sharedAsk(f = sharing(), extra: any[] = []) {
    const r = rig({ model: () => ({ decision: permDecision(extra), meta: {}, fail: null }), onKey: (k, p) => { if (k === 'Enter') p.pane = IDLE }, actions: f.acts })
    await r.advance(0); await r.advance(9000); await r.settle()
    return r
  }

  test('r2: a question about the permission prompt the channel made an Action for opens no second Action; the ask uses that one (key, id)', async () => {
    const f = sharing()
    const r = await sharedAsk(f)
    expect(r.sent).toHaveLength(1)                                       // Telegram exactly as before
    expect(f.ops()).toEqual([])                                          // no open
    expect(f.calls.find(c => c.op === 'shared')).toEqual({ op: 'shared', tmux: 'claude-x', menu: 'permission', assignees: ['joey', 'joey-test'] })   // the people it asks
    expect(r.askFile()).toMatchObject({ action_key: PERM_KEY, action_id: '7', action_version: 1, action_shared: 'permission', menu_kind: 'permission' })
    expect(r.log().some(e => e.event === 'action' && e.action_id === '7' && e.shared === 'permission')).toBe(true)
    expect(r.o.openActionFor('claude-x', 'permission')).toBe('7')
  })

  test('r2: found after a restart (async), joined by the people it asks: the ask follows the version the join returned; the screen answer cancels at that version', async () => {
    const f = sharing({ id: '7', joinTo: 2, async: true })
    const r = await sharedAsk(f)
    await new Promise(x => setTimeout(x, 20)); await r.settle()
    expect(r.askFile()).toMatchObject({ action_id: '7', action_version: 2, action_shared: 'permission' })
    await r.o.onTap(r.sent[0]!.buttons[0][0].callback_data, '@Advac777', 'joey-test')
    expect(f.calls.find(c => c.op === 'cancel')).toMatchObject({ ref: { key: PERM_KEY, id: '7', version: 2 }, reason: '在別處按了' })
  })

  test('r2: its tap closes the shared Action (the screen\'s Yes… / No…); Telegram\'s text as before', async () => {
    for (const [i, want] of [[0, 'allow'], [1, 'allow'], [2, 'deny']] as const) {
      const f = sharing()
      const r = await sharedAsk(f)
      expect(await r.o.onTap(r.sent[0]!.buttons[i][0].callback_data, '@Advac777', 'joey')).toBe('按了，畫面已經往下走')
      expect(f.calls.filter(c => c.op === 'cancel')).toEqual([{ op: 'cancel', ref: { key: PERM_KEY, id: '7', version: 1 }, reason: '在別處按了' }])
      expect(f.calls.some(c => c.op === 'open' || c.op === 'applied')).toBe(false)
      expect(r.askFile().closed).toMatchObject({ how: 'answered', option_id: want, via: 'telegram' })
      expect(r.edits.every(e => e.text.includes('@Advac777 選了') && !e.text.includes('從 Onsen 按的'))).toBe(true)
    }
  })

  test('r2: an option that is neither allow nor deny: the prompt is over on the screen, so the shared Action is cancelled (once)', async () => {
    const f = sharing()
    const r = await sharedAsk(f, [{ on_screen: '4. Explain this command', means: '解釋', button: '解釋', keys: ['Down', 'Down', 'Down', 'Enter'] }])
    await r.o.onTap(r.sent[0]!.buttons[3][0].callback_data, '@Advac777', 'joey')
    expect(f.calls.filter(c => c.op === 'cancel')).toEqual([{ op: 'cancel', ref: expect.objectContaining({ key: PERM_KEY, id: '7' }), reason: '在別處按了' }])
    expect(f.calls.some(c => c.op === 'answered')).toBe(false)
  })

  test('r2: the screen leaves the prompt: one cancel of the shared Action (the daemon reports it once, whoever sees the end first)', async () => {
    const f = sharing()
    const r = await sharedAsk(f)
    r.pane.pane = IDLE
    await r.advance(3000); await r.settle()
    expect(f.calls.filter(c => c.op === 'cancel')).toEqual([{ op: 'cancel', ref: expect.objectContaining({ key: PERM_KEY, id: '7' }), reason: '在別處按了' }])
    expect(r.edits[0]!.text).toContain('不用選了')                          // Telegram as before
  })

  test('r2: the channel\'s Action not made yet (no id): the ask follows it by key; Onsen\'s control for it (the channel prompt gone) presses the matching option', async () => {
    const f = sharing({})
    const r = await sharedAsk(f)
    expect(r.askFile()).toMatchObject({ action_key: PERM_KEY, action_shared: 'permission' })
    expect(r.askFile().action_id).toBeUndefined()
    await r.o.onTap(r.sent[0]!.buttons[2][0].callback_data, '@Advac777', 'joey')
    expect(f.calls.find(c => c.op === 'cancel')).toMatchObject({ ref: { key: PERM_KEY }, reason: '在別處按了' })
    // with an id: Onsen pressed allow on it and the daemon had no channel prompt left for it → the officer presses the Yes option
    const f2 = sharing()
    const r2 = await sharedAsk(f2)
    expect(await r2.o.onOnsen('7', 'allow', 2, Promise.resolve('joey'))).toBe('按了，畫面已經往下走')
    expect(r2.keys).toEqual(['Enter'])
    expect(f2.calls.filter(c => c.op === 'applied')).toEqual([{ op: 'applied', ref: expect.objectContaining({ id: '7', version: 2 }), at: expect.any(String), option_id: 'allow' }])
    expect(r2.edits.every(e => e.text.endsWith('\n從 Onsen 按的'))).toBe(true)
    const f3 = sharing()
    const r3 = await sharedAsk(f3)
    expect(await r3.o.onOnsen('7', '1', 2)).toBe('no such option')    // the shared Action's options are allow / deny
    expect(r3.keys).toEqual([])
  })

  test('r2: no channel Action for it (shared null), or not a permission prompt: its own Action as before; a restart hands a shared one\'s cancel to MenuActions', async () => {
    const f = fakeActions({ shared: () => null })
    const r = await sharedAsk(f)
    expect(f.ops()).toEqual(['open'])
    expect(r.askFile().action_shared).toBeUndefined()
    const f2 = fakeActions({ pane: () => ({ session_id: 'main', menu_kind: 'model_picker' }), shared: () => ({ key: PERM_KEY, id: '7', version: 1 }) })
    await sharedAsk(f2)
    expect(f2.calls.some(c => c.op === 'shared')).toBe(false)           // asked only for a permission prompt
    expect(f2.ops()).toEqual(['open'])
    // a restart: a shared ask's cancel goes to MenuActions too, which leaves it alone while it is still the channel's (server.ts: the restart grace)
    const r3 = await sharedAsk(sharing())
    const f4 = sharing()
    expect(rig({ dir: r3.dir, actions: f4.acts }).o.cancelOrphans()).toBe(1)
    expect(f4.calls.filter(c => c.op === 'cancel')).toEqual([{ op: 'cancel', ref: expect.objectContaining({ key: PERM_KEY, id: '7' }), reason: expect.stringContaining('常駐程式重開了') }])
  })

  test('permOptionOf: Claude Code\'s permission options as allow / deny', () => {
    expect(permOptionOf({ screen: '1. Yes' })).toBe('allow')
    expect(permOptionOf({ screen: "❯ 2. Yes, and don't ask again for git commands in /repo" })).toBe('allow')
    expect(permOptionOf({ screen: '3. No, and tell Claude what to do differently (esc)' })).toBe('deny')
    expect(permOptionOf({ button: '允許' })).toBe('allow')
    expect(permOptionOf({ button: 'Deny' })).toBe('deny')
    expect(permOptionOf({ screen: '4. Explain', button: '解釋' })).toBeNull()
    expect(permOptionOf({ screen: '', button: '2. No' })).toBe('deny')
    expect(permOptionOf(undefined)).toBeNull()
  })

  test('r4: DUTY_OFFICER_HOURLY_CAP_AGENTS: this agent\'s cap a pane, else none (the default stays)', () => {
    expect(hourlyCapFor('lab-relay:60', 'lab-relay')).toBe(60)
    expect(hourlyCapFor('chiron:20, lab-relay:60', 'lab-relay')).toBe(60)
    expect(hourlyCapFor('lab-relay:60', 'epeius')).toBeNull()
    expect(hourlyCapFor(undefined, 'lab-relay')).toBeNull()
    expect(hourlyCapFor('lab-relay:0', 'lab-relay')).toBeNull()
    expect(hourlyCapFor('lab-relay:9999', 'lab-relay')).toBeNull()
    expect(hourlyCapFor('lab-relay=60', 'lab-relay')).toBeNull()
  })

  test('helpers: option ids are index + 1; the body puts the screen in code blocks', () => {
    expect([optionIdOf(0), optionIdOf(9)]).toEqual(['1', '10'])
    expect([optionIndexOf('1'), optionIndexOf('10'), optionIndexOf('0'), optionIndexOf('allow'), optionIndexOf('100')]).toEqual([0, 9, -1, -1, -1])
    const b = askBody('note\n\n— 畫面最後幾行 —\nline ```x```\n\n— 等待中的工具呼叫 —\nBash {"c":1}')
    expect(b).toBe("note\n\n畫面最後幾行：\n```\nline '''x'''\n```\n\n等待中的工具呼叫：\n```\nBash {\"c\":1}\n```")
    expect(askBody('plain')).toBe('plain')
  })
})
