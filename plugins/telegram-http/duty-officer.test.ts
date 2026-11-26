import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DutyOfficer, buildBundle, checkDo, classify, fit, numberedMenu, pendingIn, redact, scanTranscript, tailLines, thash,
  type Decision, type ModelResult, type OfficerDeps, type PaneInfo, type Sent, type Tmux,
} from './duty-officer.ts'

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
const MENU = ['This session is 3d old and 600k tokens.', '  1. Resume from summary', '❯ 2. Resume full session', '  3. Don\'t ask me again'].join('\n')

describe('screen', () => {
  test('classify: dialog hints win over the spinner and the footer', () => {
    expect(classify(tailLines(DIALOG), '2.1.322')).toBe('OTHER')
    expect(classify(tailLines(IDLE), '2.1.322')).toBe('IDLE')
    expect(classify(tailLines(WORKING), '2.1.322')).toBe('WORKING')
    expect(classify(tailLines(WORKING + '\nDo you want to proceed?'), '2.1.322')).toBe('OTHER')
    expect(classify(['$ '], 'zsh')).toBe('STARTING')
    expect(classify(tailLines(IDLE), 'python3')).toBe('OTHER')
    expect(classify(tailLines(IDLE), 'python3', new Set(['python3']))).toBe('IDLE')
  })
  test('thash masks digits only on status lines', () => {
    expect(thash(['✻ (12s · ↓ 300 tokens)', 'x'])).toBe(thash(['✻ (13s · ↓ 420 tokens)', 'x']))
    expect(thash(['rm file1'])).not.toBe(thash(['rm file2']))
  })
  test('tailLines keeps the last 12 non-empty lines', () => {
    const s = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n\n')
    expect(tailLines(s)).toEqual(Array.from({ length: 12 }, (_, i) => `l${i + 8}`))
  })
  test('numberedMenu: keys move from the live cursor', () => {
    const m = numberedMenu(MENU)!
    expect(m.map(o => o.button)).toEqual(['1. Resume from summary', '2. Resume full session', "3. Don't ask me again"])
    expect(m[0].keys).toEqual(['Up', 'Enter'])
    expect(m[1].keys).toEqual(['Enter'])
    expect(m[2].keys).toEqual(['Down', 'Enter'])
    expect(numberedMenu('1. a\n2. b')).toBeNull() // numbered prose without a cursor
  })
  test('fit keeps the suffix whole', () => {
    expect(fit('abc', 'XY', 10)).toBe('abcXY')
    const r = fit('a'.repeat(50), 'RESULT', 20)
    expect(r.endsWith('RESULT')).toBe(true)
    expect(r.length).toBe(20)
  })
})

describe('redact', () => {
  test('secrets hidden, paths and slugs kept, e-mail masked', () => {
    expect(redact('Authorization: Bearer abcdefghijklmnop123')).toContain('(hidden)')
    expect(redact('key sk-abcdefghijklmnop')).toBe('key (hidden)')
    expect(redact('bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawq')).toBe('bot (hidden)')
    expect(redact('password=hunter2hunter2')).toBe('password=(hidden)')
    expect(redact('/Users/btai/.claude/projects/-Users-btai-cc-workspaces-claude-epeius/x.jsonl'))
      .toBe('/Users/btai/.claude/projects/-Users-btai-cc-workspaces-claude-epeius/x.jsonl')
    expect(redact('mail joey@example.com')).toBe('mail jo***@example.com')
    expect(redact('tok Zx9QwErTyUiOpAsDfGhJkLzXcVbNm1234567')).toBe('tok (hidden)')
  })
})

// ---------------------------------------------------------------- transcript
const T0 = Date.parse('2026-11-16T10:00:00Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
function transcriptLines(): string[] {
  return [
    { type: 'user', timestamp: at(0), isMeta: true, origin: { kind: 'channel' }, message: { role: 'user', content: '<channel source="plugin:telegram-http:telegram-http" chat_id="1828173984" message_id="77" user="Advac777" user_id="1828173984">清一下暫存</channel>' } },
    { type: 'assistant', timestamp: at(5), requestId: 'r1', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: '好，我清掉 build cache。' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', timestamp: at(6), message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
    { type: 'assistant', timestamp: at(8), requestId: 'r2', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'rm -rf /tmp/build-cache && make', token: 'password=supersecret99' } }] } },
    { type: 'attachment', timestamp: at(9), attachment: { type: 'queued_command', prompt: '<channel source="x" user="Advac777" user_id="1828173984">順便跑測試</channel>', origin: { kind: 'channel' } } },
  ].map(r => JSON.stringify(r))
}

describe('transcript', () => {
  test('scan: pending call, channel messages (isMeta and queued), model', () => {
    const ev = scanTranscript(transcriptLines().join('\n'), T0 + 60_000)
    const p = pendingIn(ev)
    expect(p.live.map(u => u.id)).toEqual(['tu2'])
    expect(ev.users.map(u => u.channel)).toEqual([true, true])
    expect(ev.model?.[0]).toBe('claude-opus-5-5')
  })
  test('a call followed by a newer API response is stale, not pending', () => {
    const lines = transcriptLines()
    lines.push(JSON.stringify({ type: 'assistant', timestamp: at(20), requestId: 'r3', message: { content: [{ type: 'text', text: 'next' }] } }))
    const p = pendingIn(scanTranscript(lines.join('\n'), T0 + 60_000))
    expect(p.live).toEqual([])
    expect(p.stale).toBe(1)
  })
  test('bundle: pending tool call redacted, last Joey message, profile from manifest', () => {
    const home = mkdtempSync(join(tmpdir(), 'do-home-'))
    const ws = join(home, 'cc-workspaces', 'claude-x')
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, '.cc-agent.json'), JSON.stringify({ name: 'claude-x', tmux_session: 'claude-x', model: 'claude-opus-5-5' }))
    writeFileSync(join(ws, 'CLAUDE.md'), '# X — tester\n\n> 測試用 agent\n')
    const pdir = join(home, '.claude', 'projects', 'p')
    mkdirSync(pdir, { recursive: true })
    writeFileSync(join(pdir, 's.jsonl'), transcriptLines().join('\n') + '\n')
    const b: any = buildBundle({ target: { label: 'claude-x', tmux: 'claude-x', projectsDir: pdir }, at: T0 + 60_000, screen: DIALOG, panePath: ws, rulings: 'R', home })
    expect(b.agent_profile.model_registered).toBe('claude-opus-5-5')
    expect(b.agent_profile.role).toBe('X — tester — 測試用 agent')
    expect(b.pending_tool_call.tool).toBe('Bash')
    expect(b.pending_tool_call.input.token).toBe('password=(hidden)')
    expect(b.recent.last_joey_message.text).toBe('順便跑測試')
    expect(b.rulings).toBe('R')
    expect(b.screen).toContain('Do you want to proceed?')
  })
})

// ---------------------------------------------------------------- the officer
const decision = (over: Partial<Decision> = {}): Decision => ({
  what: '要刪 build cache 的許可', why_now: '它在清暫存', if_nobody_answers: '120 秒後自動拒絕', covered_by: '預設全放行',
  action: 'do', choose: 'Yes', reason: '自己的暫存', to_joey: '要選 Yes', unsure: [],
  options: [{ on_screen: '1. Yes', means: '執行', button: 'Yes', keys: ['Enter'] }, { on_screen: '2. No', means: '不執行', button: 'No', keys: ['Down', 'Enter'] }],
  ...over,
})

function rig(opts: { model?: (n: number) => ModelResult; enabled?: unknown; onKey?: (k: string, p: { pane: string }) => void; limits?: any } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'do-dir-'))
  const rules = mkdtempSync(join(tmpdir(), 'do-rules-'))
  writeFileSync(join(rules, 'aide_prompt.md'), 'SYSTEM')
  writeFileSync(join(rules, 'rulings.md'), 'RULINGS')
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ enabled: opts.enabled ?? ['claude-x'] }))
  const pane = { pane: DIALOG, cmd: '2.1.322', inMode: false, path: '/nowhere', activity: null as number | null }
  const keys: string[] = []
  const sent: Array<{ chats: string[]; text: string; buttons: any }> = []
  const edits: Array<{ s: Sent; text: string }> = []
  const mails: Array<{ title: string; body: string }> = []
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
    mail: async (title, body) => { mails.push({ title, body }); return '#555' },
    recipients: () => ['1828173984'],
    log: () => {},
    now: () => clock,
    sleep: async ms => { clock += ms },
  }
  const o = new DutyOfficer(deps, { dir, rulesDirs: [rules], home: dir, host: 'mini', limits: { claimFreshMs: 30_000, ...(opts.limits ?? {}) } })
  const advance = async (ms: number) => { clock += ms; await o.tick(); await new Promise(r => setTimeout(r, 0)) }
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)) }
  const log = () => readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  return { o, dir, pane, keys, sent, edits, mails, advance, settle, log, calls: () => calls, clock: () => clock }
}

describe('officer', () => {
  test('a stalled dialog is judged and pressed; the screen after is checked', async () => {
    const r = rig({ onKey: (k, p) => { if (k === 'Enter') p.pane = WORKING } })
    await r.advance(0)
    await r.advance(4000)
    expect(r.calls()).toBe(0) // not stalled yet
    await r.advance(5000)
    await r.settle()
    expect(r.calls()).toBe(1)
    expect(r.keys).toEqual(['Enter'])
    const pressed = r.log().find(e => e.event === 'pressed')
    expect(pressed.resolved).toBe(true)
    expect(pressed.after_state).toBe('WORKING')
    expect(r.sent).toEqual([])
  })

  test('the screen changed before pressing: nothing is pressed', async () => {
    const r = rig({ model: () => { r.pane.pane = IDLE; return { decision: decision(), meta: {}, fail: null } } })
    await r.advance(0)
    await r.advance(9000)
    await r.settle()
    expect(r.keys).toEqual([])
    expect(r.log().some(e => e.event === 'aborted')).toBe(true)
  })

  test('ask_joey: buttons go out; his tap presses, edits the message, mails the ruling', async () => {
    const r = rig({
      model: () => ({ decision: decision({ action: 'ask_joey', to_joey: 'claude-x 要刪 build cache，要你決定。', choose: 'Yes' }), meta: {}, fail: null }),
      onKey: (k, p) => { if (k === 'Enter') p.pane = IDLE },
    })
    await r.advance(0)
    await r.advance(9000)
    await r.settle()
    expect(r.keys).toEqual([])
    expect(r.sent.length).toBe(1)
    expect(r.sent[0].text.startsWith('claude-x 要刪 build cache，要你決定。')).toBe(true)
    const btn = r.sent[0].buttons.map((row: any) => row[0])
    expect(btn.map((b: any) => b.text)).toEqual(['Yes', 'No'])
    const res = await r.o.onTap(btn[1].callback_data, 'Advac777')
    expect(r.keys).toEqual(['Down', 'Enter'])
    expect(res).toBe('按了，畫面已經往下走')
    expect(r.edits.length).toBe(1)
    expect(r.edits[0].text).toContain('Advac777 選了「No」')
    await r.settle()
    expect(r.mails.length).toBe(1)
    expect(r.mails[0].title.startsWith('裁決：claude-x｜')).toBe(true)
    expect(r.mails[0].title.length).toBeLessThanOrEqual(50)
    expect(await r.o.onTap(btn[0].callback_data, 'Advac777')).toContain('已經處理過了')
    expect(r.keys).toEqual(['Down', 'Enter'])
  })

  test('a tap on a screen that has changed presses nothing', async () => {
    const r = rig({ model: () => ({ decision: decision({ action: 'ask_joey' }), meta: {}, fail: null }) })
    await r.advance(0)
    await r.advance(9000)
    await r.settle()
    const cb = r.sent[0].buttons[0][0].callback_data
    r.pane.pane = DIALOG.replace('build-cache', 'other-dir')
    expect(await r.o.onTap(cb, 'Advac777')).toBe('畫面已經變了，沒有按')
    expect(r.keys).toEqual([])
    expect(r.mails).toEqual([])
  })

  test('the question is closed when the screen leaves the menu on its own', async () => {
    const r = rig({ model: () => ({ decision: decision({ action: 'ask_joey' }), meta: {}, fail: null }) })
    await r.advance(0)
    await r.advance(9000)
    await r.settle()
    r.pane.pane = IDLE
    await r.advance(3000)
    await r.settle()
    expect(r.edits.length).toBe(1)
    expect(r.edits[0].text).toContain('不用選了')
    expect(await r.o.onTap(r.sent[0].buttons[0][0].callback_data, 'Advac777')).toContain('不用選了')
  })

  test('do with typing is downgraded to Joey; the typing option gets no button', async () => {
    const r = rig({ model: () => ({ decision: decision({ choose: 'Other', options: [...decision().options, { on_screen: '3. Type', means: '打字', button: 'Other', keys: [{ type: 'hi' }] }] }), meta: {}, fail: null }) })
    await r.advance(0)
    await r.advance(9000)
    await r.settle()
    expect(r.keys).toEqual([])
    expect(r.sent.length).toBe(1)
    expect(r.sent[0].buttons.length).toBe(2)
    expect(r.sent[0].text).toContain('要打字的選項沒有按鈕（Other）')
    expect(r.log().find(e => e.event === 'decision').downgraded_from).toBe('do')
  })

  test('model failure: Joey gets the raw screen, with buttons for a numbered menu', async () => {
    const r = rig({ model: () => ({ decision: null, meta: {}, fail: 'timeout 60s' }) })
    r.pane.pane = MENU
    await r.advance(0)
    await r.advance(9000)
    await r.settle()
    expect(r.sent.length).toBe(1)
    expect(r.sent[0].text).toContain('判斷不了（timeout 60s）')
    expect(r.sent[0].buttons.map((x: any) => x[0].text)).toEqual(['1. Resume from summary', '2. Resume full session', "3. Don't ask me again"])
    await r.o.onTap(r.sent[0].buttons[2][0].callback_data, 'Advac777')
    expect(r.keys).toEqual(['Down', 'Enter', 'Down', 'Enter'])                // WO-97: this fake menu never moves: the same keys once more, then 「按了兩次」
  })

  test('over the per-pane budget: no model call, raw screen to Joey', async () => {
    const r = rig({ limits: { callsPerTargetHour: 0 } })
    await r.advance(0)
    await r.advance(9000)
    await r.settle()
    expect(r.calls()).toBe(0)
    expect(r.sent[0].text).toContain('over the hourly budget')
  })

  test('switched off: nothing watched, no claim', async () => {
    const r = rig({ enabled: [] })
    await r.advance(0)
    await r.advance(9000)
    await r.settle()
    expect(r.calls()).toBe(0)
    expect(r.o.handles('claude-x')).toBe(false)
    expect(existsSync(join(r.dir, 'claims', 'claude-x'))).toBe(false)
  })

  test('a pane claimed by another live process is left alone', async () => {
    const r = rig()
    writeFileSync(join(r.dir, 'claims', 'claude-x'), String(process.ppid))
    await r.advance(0)
    await r.advance(9000)
    await r.settle()
    expect(r.calls()).toBe(0)
    expect(r.o.handles('claude-x')).toBe(false)
  })

  test('claims the pane while on; dry_keys logs without pressing', async () => {
    const r = rig()
    writeFileSync(join(r.dir, 'config.json'), JSON.stringify({ enabled: '*', dry_keys: true }))
    await r.advance(0)
    expect(readFileSync(join(r.dir, 'claims', 'claude-x'), 'utf8')).toBe(String(process.pid))
    expect(r.o.handles('claude-x')).toBe(true)
    await r.advance(9000)
    await r.settle()
    expect(r.keys).toEqual([])
    expect(r.log().find(e => e.event === 'pressed').dry_keys).toBe(true)
  })

  test('a test target: its question goes to the test recipients, its ruling to test_rulings_to', async () => {
    const r = rig({
      enabled: [],
      model: () => ({ decision: decision({ action: 'ask_joey', to_joey: '測試題' }), meta: {}, fail: null }),
      onKey: (k, p) => { if (k === 'Enter') p.pane = IDLE },
    })
    writeFileSync(join(r.dir, 'config.json'), JSON.stringify({ enabled: [], test_targets: { 'dotest-1': 'claude-x' }, test_recipients: ['6736970916'], test_rulings_to: 'epeius' }))
    const mailsTo: any[] = []
    ;(r.o as any).d.mail = async (title: string, _b: string, to?: string) => { mailsTo.push({ title, to }); return '#1' }
    await r.advance(0)
    expect(r.o.handles('dotest-1')).toBe(true)
    expect(r.o.handles('claude-x')).toBe(false)
    await r.advance(9000)
    await r.settle()
    expect(r.sent[0].chats).toEqual(['6736970916'])
    const cb = r.sent[0].buttons[0][0].callback_data
    expect(r.o.mayAnswer(cb, '6736970916')).toBe(true)
    expect(r.o.mayAnswer(cb, '999')).toBe(false)
    await r.o.onTap(cb, '@tester')
    await r.settle()
    expect(mailsTo).toEqual([{ title: expect.stringMatching(/^（測試）裁決：dotest-1 \(test\)｜/), to: 'epeius' }])
  })

  test('the rate-limit menu is left to modal-guard, no model call', async () => {
    const r = rig()
    r.pane.pane = ['  What do you want to do?', '❯ 1. Stop and wait for limit to reset', '  2. Switch to usage credits', '  3. Upgrade your plan', '  Enter to confirm · Esc to cancel'].join('\n')
    await r.advance(0)
    await r.advance(9000)
    await r.settle()
    expect(r.calls()).toBe(0)
    expect(r.sent).toEqual([])
    expect(r.log().filter(e => e.event === 'left_to_modal_guard').length).toBe(1)
  })

  test('raw notices: one per machine per hour, the next pane is held and looked at again after the hour', async () => {
    let fail = true
    const r = rig({ model: () => fail ? { decision: null, meta: {}, fail: 'timeout 60s' } : { decision: decision({ action: 'none' }), meta: {}, fail: null } })
    writeFileSync(join(r.dir, 'raw-last'), 'other daemon') // another daemon on this machine just sent one
    await r.advance(0)
    await r.advance(9000)
    await r.settle()
    expect(r.sent).toEqual([])
    expect(r.log().some(e => e.event === 'raw_suppressed')).toBe(true)
    fail = false
    await r.advance(3_600_000)
    await r.settle()
    expect(r.calls()).toBe(2)
    expect(r.log().filter(e => e.event === 'decision').length).toBe(1)
  })

  test('switched off while the model is thinking: no key is pressed, no message sent', async () => {
    const r = rig({ model: () => {
      writeFileSync(join(r.dir, 'config.json'), JSON.stringify({ enabled: [] }))
      return { decision: decision(), meta: {}, fail: null }
    } })
    await r.advance(0)
    await r.advance(9000)
    await r.settle()
    expect(r.calls()).toBe(1)
    expect(r.keys).toEqual([])
    expect(r.sent).toEqual([])
    expect(r.log().find(e => e.event === 'aborted').why).toBe('switched off while judging')
  })

  test('switched off after the question went out: Joey\'s tap presses nothing', async () => {
    const r = rig({ model: () => ({ decision: decision({ action: 'ask_joey' }), meta: {}, fail: null }) })
    await r.advance(0)
    await r.advance(9000)
    await r.settle()
    writeFileSync(join(r.dir, 'config.json'), JSON.stringify({ enabled: [] }))
    expect(await r.o.onTap(r.sent[0].buttons[0][0].callback_data, 'Advac777')).toBe('值班員已經關掉，沒有按。')
    expect(r.keys).toEqual([])
    expect(r.mails).toEqual([])
  })

  test('someone at the terminal: nothing judged, pressed or sent; handled once nobody has typed for 120 s', async () => {
    const r = rig({ onKey: (k, p) => { if (k === 'Enter') p.pane = IDLE } })
    r.pane.activity = r.clock() - 10_000 // an attached client pressed a key 10 s ago
    await r.advance(0)
    await r.advance(9000)
    await r.advance(3000)
    await r.settle()
    expect(r.calls()).toBe(0)
    expect(r.keys).toEqual([])
    expect(r.sent).toEqual([])
    expect(r.log().filter(e => e.event === 'attended').length).toBe(1)
    await r.advance(110_000) // 129 s since the last key: the person left, the menu is still up
    await r.settle()
    expect(r.calls()).toBe(1)
    expect(r.keys).toEqual(['Enter'])
  })

  test('a person starts typing while the model is thinking: no key, no message', async () => {
    const r = rig({ model: () => { r.pane.activity = r.clock(); return { decision: decision(), meta: {}, fail: null } } })
    await r.advance(0)
    await r.advance(9000)
    await r.settle()
    expect(r.calls()).toBe(1)
    expect(r.keys).toEqual([])
    expect(r.sent).toEqual([])
    expect(r.log().find(e => e.event === 'attended').why).toBe('a person started typing while judging')
  })

  test("Joey's tap is his decision: a client at the terminal does not hold it back", async () => {
    const r = rig({ model: () => ({ decision: decision({ action: 'ask_joey' }), meta: {}, fail: null }), onKey: (k, p) => { if (k === 'Enter') p.pane = IDLE } })
    await r.advance(0)
    await r.advance(9000)
    await r.settle()
    r.pane.activity = r.clock()
    expect(await r.o.onTap(r.sent[0].buttons[0][0].callback_data, 'Advac777')).toBe('按了，畫面已經往下走')
    expect(r.keys).toEqual(['Enter'])
  })

  test('a safeguards refusal is retried once with the fallback model; with none set, Joey gets the raw screen', async () => {
    const models: Array<string | undefined> = []
    const refused = { decision: null, meta: { refused: true, model: 'claude-opus-5-5' }, fail: "refused by claude-opus-5-5's safeguards" }
    const r = rig({ onKey: (k, p) => { if (k === 'Enter') p.pane = IDLE } })
    ;(r.o as any).d.model = async (_b: any, _p: any, _t: any, m?: string) => { models.push(m); return m ? { decision: decision(), meta: { model: m }, fail: null } : refused }
    await r.advance(0)
    await r.advance(9000)
    await r.settle()
    expect(models).toEqual([undefined, 'claude-sonnet-5-5'])
    expect(r.keys).toEqual(['Enter'])
    expect(r.log().find(e => e.event === 'model_refused').retry_with).toBe('claude-sonnet-5-5')

    const r2 = rig()
    writeFileSync(join(r2.dir, 'config.json'), JSON.stringify({ enabled: ['claude-x'], fallback_model: null }))
    const models2: Array<string | undefined> = []
    ;(r2.o as any).d.model = async (_b: any, _p: any, _t: any, m?: string) => { models2.push(m); return refused }
    await r2.advance(0)
    await r2.advance(9000)
    await r2.settle()
    expect(models2).toEqual([undefined])
    expect(r2.keys).toEqual([])
    expect(r2.sent[0].text).toContain('safeguards')
  })

  test('checkDo', () => {
    expect(checkDo(decision())).toEqual({ keys: ['Enter'] })
    expect(checkDo(decision({ choose: 'Maybe' }))).toEqual({ bad: "choose matches no option's button" })
    expect('bad' in checkDo(decision({ options: [{ on_screen: '', means: '', button: 'Yes', keys: Array(13).fill('Down') }] }))).toBe(true)
  })
})
