// lanes-golive C8: one owner of a lanes main's usage-limit menu. WO-168 (Chiron 05:24:56Z): the owner is the duty officer now (its program rule asks Joey;
// lanes' reader is retired). The programs outside the plugin (ratelimit-modal-guard, the delivery watchdog's resume line) still read the ownership file:
// ~/.claude/lanes/menu-owner/<tmux>.json (mtime fresh, pid alive), written by the officer while it watches its own pane. The officer's generic `owner`
// hook (another program claims a screen) stays for any pane; server.ts no longer wires the lanes into it.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DutyOfficer, type OfficerDeps, type Tmux, type PaneInfo } from './duty-officer.ts'
import type { PaneLook } from './pane-look.ts'

const home = mkdtempSync(join(tmpdir(), 'golive-c8-home-'))
const was = { home: process.env.HOME, tmux: process.env.CHANNEL_BOT_TMUX_SESSION }
const TMUX = `golive-c8-${process.pid}`
process.env.HOME = home; process.env.CHANNEL_BOT_TMUX_SESSION = TMUX
const L = await import('./lanes.ts?golive-c8') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-golive-c8-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, sendBot: async () => 1, joeyChatId: () => '1' } as any)
afterAll(() => {
  if (was.home === undefined) delete process.env.HOME; else process.env.HOME = was.home
  if (was.tmux === undefined) delete process.env.CHANNEL_BOT_TMUX_SESSION; else process.env.CHANNEL_BOT_TMUX_SESSION = was.tmux
})

test('C8, WO-168: the duty officer watching its own pane publishes the menu-owner file (owner duty-officer, the fields its readers read); lanes publish none; switched off, the file goes', async () => {
  const f = join(home, '.claude', 'lanes', 'menu-owner', `${TMUX}.json`)
  expect(existsSync(f)).toBe(false)                                                                 // lanesInit wrote nothing
  expect((L as any).menuOwnerFile).toBeUndefined()
  const odir = mkdtempSync(join(tmpdir(), 'golive-c8-own-')), rules = mkdtempSync(join(tmpdir(), 'golive-c8-own-rules-'))
  writeFileSync(join(rules, 'aide_prompt.md'), 'SYSTEM'); writeFileSync(join(rules, 'rulings.md'), 'RULINGS')
  writeFileSync(join(odir, 'config.json'), JSON.stringify({ enabled: [TMUX] }))
  const look = (): PaneLook => ({ at: Date.now(), seq: 1, cmd: '2.1.322', inMode: false, path: '/nowhere', visible: 'x', visibleAnsi: 'x', text: 'x' })
  const tmux: Tmux = { capture: async () => 'x', clientActivity: async () => null, info: async (): Promise<PaneInfo> => ({ cmd: '2.1.322', inMode: false, path: '/nowhere' }), sendKey: async () => {}, cancelMode: async () => {} }
  const o = new DutyOfficer({ listTargets: async () => [{ label: TMUX, tmux: TMUX, projectsDir: null }], tmux, model: async () => ({ decision: null, meta: {}, fail: 'x' }),
    send: async () => [], edit: async () => {}, mail: async () => '#1', recipients: () => ['1'], log: () => {},
    ownPane: { tmux: TMUX, look: async () => look(), recordOf: () => ({ view: { state: 'idle', detail: {} }, hash: 'h' }) } }, { dir: odir, rulesDirs: [rules], home, host: 'mini' })
  await o.tick()
  expect(JSON.parse(readFileSync(f, 'utf8'))).toMatchObject({ owner: 'duty-officer', menus: ['usage-limit'], agent: TMUX, tmux: TMUX, pid: process.pid })
  writeFileSync(join(odir, 'config.json'), JSON.stringify({ enabled: [] }))
  await o.tick()
  expect(existsSync(f)).toBe(false)
})

test('C8: the duty officer leaves a screen another owner claims: not judged, not pressed, not sent; one log line naming the owner', async () => {
  const odir = mkdtempSync(join(tmpdir(), 'golive-c8-do-')), rules = mkdtempSync(join(tmpdir(), 'golive-c8-rules-'))
  writeFileSync(join(rules, 'aide_prompt.md'), 'SYSTEM'); writeFileSync(join(rules, 'rulings.md'), 'RULINGS')
  writeFileSync(join(odir, 'config.json'), JSON.stringify({ enabled: [TMUX] }))
  const pane = ['  What do you want to do?', '❯ 1. Stop and wait for limit to reset', '  2. Switch to usage credits', '  3. Upgrade your plan', '  Enter to confirm · Esc to cancel'].join('\n')
  const keys: string[] = [], sent: any[] = []
  let calls = 0, clock = Date.parse('2026-11-23T00:00:00Z')
  const tmux: Tmux = { capture: async () => pane, clientActivity: async () => null, info: async (): Promise<PaneInfo> => ({ cmd: '2.1.322', inMode: false, path: '/nowhere' }),
    sendKey: async (_t, k) => { keys.push(k) }, cancelMode: async () => {} }
  const deps: OfficerDeps = { listTargets: async () => [{ label: TMUX, tmux: TMUX, projectsDir: null }], tmux,
    model: async () => { calls++; return { decision: null, meta: {}, fail: 'x' } }, send: async (c, t) => { sent.push(t); return [] }, edit: async () => {}, mail: async () => '#1',
    recipients: () => ['1'], log: () => {}, now: () => clock, sleep: async ms => { clock += ms },
    owner: (t, lines) => t.tmux === TMUX && lines.some(l => /Stop and wait for limit/.test(l)) ? 'the lanes main-wall probe' : null }
  const o = new DutyOfficer(deps, { dir: odir, rulesDirs: [rules], home: odir, host: 'mini', limits: { claimFreshMs: 30_000 } })
  await o.tick(); clock += 9000; await o.tick()
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0))
  const log = readFileSync(join(odir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  expect(calls).toBe(0); expect(keys).toEqual([]); expect(sent).toEqual([])
  expect(log.filter(e => e.event === 'left_to_owner')).toEqual([expect.objectContaining({ owner: 'the lanes main-wall probe', tmux: TMUX })])
  expect(log.filter(e => e.event === 'left_to_modal_guard').length).toBe(0)
})

test('C8 server.ts, WO-168: the lanes no longer own the main\'s menu (no owner hook); the officer gets its own pane through the record', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  expect(src).not.toContain('Lanes.mainMenuOwned')
  expect(src).not.toContain("'the lanes main-wall probe'")
  expect(src).toContain('ownPane: { tmux: ownPaneTmux, look: (ms: number) => ownPaneReader.fresh(ms), recordOf: (l: PaneLook) => ownRecordOf ? ownRecordOf(l) : null }')
})
