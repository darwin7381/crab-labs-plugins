// WO-168 item 5 (Chiron 05:24:56Z 「先修」): lanes told Joey 「選項已再傳給你」 and re-armed the startup-picker, which skips every pane the duty officer
// handles: 17 sentences with no buttons (11-25 22:40Z–11-26 00:07Z). The re-arm now goes through the duty officer (rearm()): its open question on the pane
// is sent again with its buttons, or the menu on the screen is put to Joey now (Telegram buttons and an Onsen Action), and nothing is pressed until he taps.
// No tmux: the officer's Tmux is a stand-in (as in duty-officer.test.ts).
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DutyOfficer, type Decision, type MenuActions, type ModelResult, type OfficerDeps, type PaneInfo, type Tmux } from './duty-officer.ts'

const LIMIT_MENU = ['● 前景 sleep 55 被系統擋下。', '  ⎿  You\'ve hit your weekly limit · resets Dec 1, 6am (Asia/Taipei)', '✻ Cogitated for 0s · done 上午7:06',
  '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔', '   What do you want to do?', '   ❯ 1. Stop and wait for limit to reset',
  '     2. Wait here, then continue automatically at Dec 1, 6am', '   Enter to confirm · Esc to cancel'].join('\n')
const DIALOG = ['────────────────────────────────────────', ' Bash command', '   rm -rf /tmp/build-cache && make', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No',
  ' Esc to cancel · Tab to amend'].join('\n')
const IDLE = ['╭────╮', '│ >  │', '╰────╯', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
const T0 = Date.parse('2026-11-26T06:00:00Z')
const decision = (over: Partial<Decision> = {}): Decision => ({
  what: '用量上限的選單', why_now: '撞上限', if_nobody_answers: '一直停著', covered_by: null, action: 'ask_joey', choose: '1. Stop', reason: '額度是 Joey 的',
  to_joey: 'claude-x 停在用量上限的選單，要你選。', unsure: [],
  options: [{ on_screen: '1. Stop and wait for limit to reset', means: '等', button: '1. Stop', keys: ['Enter'] },
    { on_screen: '2. Wait here, then continue automatically', means: '自動繼續', button: '2. Wait', keys: ['Down', 'Enter'] }], ...over })

function rig(o: { model?: () => ModelResult; enabled?: string[]; owner?: boolean; pane?: string; connector?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'do-rearm-')), rules = mkdtempSync(join(tmpdir(), 'do-rearm-rules-'))
  writeFileSync(join(rules, 'aide_prompt.md'), 'SYSTEM'); writeFileSync(join(rules, 'rulings.md'), 'RULINGS')
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ enabled: o.enabled ?? ['claude-x'] }))
  const pane = { pane: o.pane ?? LIMIT_MENU }
  const keys: string[] = [], sent: Array<{ text: string; buttons: any }> = [], acts: string[] = []
  let calls = 0, clock = T0
  const tmux: Tmux = { capture: async () => pane.pane, clientActivity: async () => null, info: async (): Promise<PaneInfo> => ({ cmd: '2.1.322', inMode: false, path: '/nowhere' }),
    sendKey: async (_t, k) => { keys.push(k); if (k === 'Enter') pane.pane = IDLE }, cancelMode: async () => {} }
  const actions: MenuActions = { pane: () => ({ session_id: 'main', menu_kind: 'usage_limit_options' }), assignees: c => c.map(() => 'joey'),
    open: (f, _k, made) => { acts.push(`open:${f.options.map(x => x.label).join('|')}:${f.summary}`); setTimeout(() => made('a1', 1), 0) },
    pressed: () => { acts.push('pressed') }, answered: (_r, id) => { acts.push(`answered:${id}`) }, applied: () => { acts.push('applied') },
    cancel: (_r, why) => { acts.push(`cancel:${why}`) } }
  const deps: OfficerDeps = { listTargets: async () => [{ label: 'claude-x', tmux: 'claude-x', projectsDir: null }], tmux,
    model: async () => { calls++; return o.model ? o.model() : { decision: decision(), meta: {}, fail: null } },
    // connector (WO-197): server.ts's send returns nothing (no Telegram; the bridge draws the Action)
    send: async (_c, text, buttons) => { if (o.connector) return []; sent.push({ text, buttons }); return [{ chat: '1828173984', msg: 100 + sent.length }] }, edit: async () => {},
    mail: async () => '#1', recipients: () => ['1828173984'], log: () => {}, now: () => clock, sleep: async ms => { clock += ms }, actions,
    ...(o.owner ? { owner: () => 'the lanes main-wall probe' } : {}) }
  const off = new DutyOfficer(deps, { dir, rulesDirs: [rules], home: dir, host: 'mini', limits: { claimFreshMs: 30_000 } })
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)) }
  const advance = async (ms: number) => { clock += ms; await off.tick(); await settle() }
  const log = () => readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  return { off, pane, keys, sent, acts, advance, settle, log, calls: () => calls }
}

test('WO-168 item 5: a menu another owner held (the lanes probe): the re-arm puts it to Joey now with its options as buttons and an Action; nothing pressed', async () => {
  const r = rig({ owner: true })
  await r.advance(0); await r.advance(9000)
  expect(r.log().some(e => e.event === 'left_to_owner')).toBe(true)
  expect(r.sent).toEqual([])
  const out = await r.off.rearm('claude-x')
  await r.settle()
  expect(out).toEqual({ result: 'asked', options: ['1. Stop and wait for limit to reset', '2. Wait here, then continue automatically at Dec 1, 6am'] })
  expect(r.keys).toEqual([])
  expect(r.calls()).toBe(0)                                                           // no model: the options as they are
  expect(r.sent.length).toBe(1)
  expect(r.sent[0].buttons.map((row: any) => row[0].text)).toEqual(['1. Stop and wait for limit to reset', '2. Wait here, then continue automatically at Dec 1, 6am'])
  expect(r.acts).toEqual(['open:1. Stop and wait for limit to reset|2. Wait here, then continue automatically at Dec 1, 6am:claude-x 停在一個選單，等你選'])
  // the officer's own loop does not ask about the same screen again
  await r.advance(3000); await r.advance(3000)
  expect(r.sent.length).toBe(1)
  // his tap presses that option, and only it
  const res = await r.off.onTap(r.sent[0].buttons[1][0].callback_data, 'Advac777', 'joey')
  expect(r.keys).toEqual(['Down', 'Enter'])
  expect(res).toBe('按了，畫面已經往下走')
  expect(r.acts.slice(1)).toEqual(['answered:2'])
})

test('WO-168 item 5: the officer\'s question already open on the pane is sent again (same buttons); resend false leaves it as it is', async () => {
  const r = rig({ pane: DIALOG, model: () => ({ decision: decision({ choose: 'Yes', options: [{ on_screen: '1. Yes', means: '執行', button: '1. Stop', keys: ['Enter'] },
    { on_screen: '2. No', means: '不執行', button: '2. Wait', keys: ['Down', 'Enter'] }] }), meta: {}, fail: null }) })
  await r.advance(0); await r.advance(9000)
  expect(r.sent.length).toBe(1)
  expect(await r.off.rearm('claude-x', { resend: false })).toEqual({ result: 'open', options: ['1. Stop', '2. Wait'] })
  expect(r.sent.length).toBe(1)
  const out = await r.off.rearm('claude-x')
  expect(out.result).toBe('resent')
  expect(r.sent.length).toBe(2)
  expect(r.sent[1].text.startsWith('（選項再傳一次）')).toBe(true)
  expect(r.sent[1].buttons).toEqual(r.sent[0].buttons)
  expect(r.acts.filter(a => a.startsWith('open:')).length).toBe(1)                      // the Action stays the one already open
  expect(r.keys).toEqual([])
})

test('WO-168 × WO-197: a connector\'s open question is its Action: a re-arm sends nothing again and says it is open, not resent', async () => {
  const r = rig({ connector: true, pane: DIALOG, model: () => ({ decision: decision({ choose: 'Yes', options: [{ on_screen: '1. Yes', means: '執行', button: '1. Stop', keys: ['Enter'] },
    { on_screen: '2. No', means: '不執行', button: '2. Wait', keys: ['Down', 'Enter'] }] }), meta: {}, fail: null }) })
  await r.advance(0); await r.advance(9000)
  expect(r.acts.filter(a => a.startsWith('open:')).length).toBe(1)
  expect(await r.off.rearm('claude-x')).toEqual({ result: 'open', options: ['1. Stop', '2. Wait'] })
  expect(r.sent).toEqual([])
  expect(r.acts.filter(a => a.startsWith('open:')).length).toBe(1)
  expect(r.log().filter(e => e.event === 'rearm').map(e => e.how)).toEqual(['open'])
  expect(r.keys).toEqual([])
})

test('WO-168 item 5: no menu on the screen, or a pane the officer does not watch: nothing is sent and the caller hears why', async () => {
  const r = rig()
  r.pane.pane = IDLE
  await r.advance(0)
  expect(await r.off.rearm('claude-x')).toEqual({ result: 'no_menu', options: [] })
  expect(await r.off.rearm('claude-y')).toEqual({ result: 'off', options: [] })
  expect(r.sent).toEqual([])
})

test('WO-168 item 5 server.ts: the lanes\' re-arm of the main\'s menu goes through the duty officer when it watches the pane; the probe reads through the one capture', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  expect(src).toContain("if (!dutyOfficer?.handles(own)) { rearmStartupPicker(own); return }")
  expect(src).toContain('void dutyOfficer.rearm(own).then(')
  expect(src).toContain("capture: () => ownPaneReader ? ownPaneReader.fresh(MAIN_PICKER_LOOK_MS).then(l => l?.visible ?? '') : capturePane(process.env.CHANNEL_BOT_TMUX_SESSION!),")
  expect(src).toContain("ownPaneReader ? () => ownPaneReader.fresh(0).then(l => l?.visible ?? '') : undefined),")
})
