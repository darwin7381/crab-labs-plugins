// lanes-golive C8: one owner of a lanes main's usage-limit menu, the lanes main-wall probe. The duty officer (WO-97) in the same daemon stands aside by
// its new `owner` hook (absent = the fleet's behaviour); the programs outside the plugin (ratelimit-modal-guard, the delivery watchdog's resume line)
// read the ownership file the daemon publishes: ~/.claude/lanes/menu-owner/<tmux>.json, fresh while the daemon runs.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DutyOfficer, type OfficerDeps, type Tmux, type PaneInfo } from './duty-officer.ts'

const home = mkdtempSync(join(tmpdir(), 'golive-c8-home-'))
const was = { home: process.env.HOME, tmux: process.env.CHANNEL_BOT_TMUX_SESSION }
const TMUX = `golive-c8-${process.pid}`
process.env.HOME = home; process.env.CHANNEL_BOT_TMUX_SESSION = TMUX
const L = await import('./lanes.ts?golive-c8') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-golive-c8-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, sendBot: async () => 1, joeyChatId: () => '1',
  mainPicker: { capture: async () => '', detect: () => null, drive: async () => 'gone', rearm: () => {} } } as any)
afterAll(() => {
  if (was.home === undefined) delete process.env.HOME; else process.env.HOME = was.home
  if (was.tmux === undefined) delete process.env.CHANNEL_BOT_TMUX_SESSION; else process.env.CHANNEL_BOT_TMUX_SESSION = was.tmux
})

test('C8: a lanes tg daemon that knows its main\'s pane publishes itself as the owner of that pane\'s usage-limit menu', () => {
  const f = L.menuOwnerFile(TMUX, home)
  expect(f).toBe(join(home, '.claude', 'lanes', 'menu-owner', `${TMUX}.json`))
  expect(existsSync(f)).toBe(true)
  expect(JSON.parse(readFileSync(f, 'utf8'))).toMatchObject({ owner: 'lanes-wall', menus: ['usage-limit'], agent: 'adam', tmux: TMUX, pid: process.pid })
  expect(L.menuOwnerOf(TMUX)).toBe('lanes-wall')
  expect(L.menuOwnerOf('another-pane')).toBeNull()
  writeFileSync(join(home, '.claude', 'lanes', 'menu-owner', 'dead.json'), JSON.stringify({ owner: 'lanes-wall', pid: 999999 }))
  expect(L.menuOwnerOf('dead')).toBeNull()                                              // a dead owner owns nothing
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

test('C8 server.ts: the duty officer\'s owner hook is wired with lanes on only, for the main\'s pane and a limit menu', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  expect(src).toContain("...(Lanes.LANES_ON && !INBOX_ONLY ? { owner: (t: { tmux: string }, lines: string[]) => {")
  expect(src).toContain("return isRateLimitMenu(lines) || (pk && Lanes.mainMenuOwned(pk.options)) ? 'the lanes main-wall probe' : null")
})
