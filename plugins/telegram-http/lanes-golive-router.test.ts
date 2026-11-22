// lanes-golive: the fleet default router (lanes-router.fleet.json, the file a workspace's .lanes/router.json starts from). Joey's Telegram → the main;
// scheduler runs, page-tier alerts, peer calls → a reflex lane; the mail line (a pushed mail, the 讀信箱 reminder) → the mail lane; board work orders pushed
// as calls → a worker lane in a topic; no_reply notices → the ledger; every notify class pushes.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const FLEET = join(import.meta.dir, 'lanes-router.fleet.json')
const L = await import('./lanes.ts?golive-router') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-golive-router-'))
process.env.LANES_DIR = dir
copyFileSync(FLEET, join(dir, 'router.json'))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'],
  sendBot: async () => 1, joeyChatId: () => '1828173984', createTopic: async () => 7100 } as any)
L.__setClaudeBin(join(import.meta.dir, 'test-fixtures', 'no-claude.sh'))
let n = 0
const mesh = (from: string, text: string, o: Record<string, unknown> = {}) => ({ id: `mesh-fr-${++n}`, source: 'mesh', from, verified: true, text, meta: {}, line: 'call',
  notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } }, ...o } as any)

test('the fleet router file: every rule uses a target and predicates the router knows; every notify class pushes (no_reply: the ledger); no cap', () => {
  const r = JSON.parse(readFileSync(FLEET, 'utf8'))
  const targets = ['main', 'ledger', 'quoted_lane', 'topic_worker', 'thread_owner', 'worker_for_ticket', 'reflex', 'mail_lane']
  const preds = ['source', 'quotes_lane_message', 'in_worker_topic', 'no_reply', 'not_alert', 'text_prefix', 'text_regex', 'from', 'verified', 'thread_known', 'from_agent', 'line']
  for (const rule of r.rules) { expect(targets).toContain(rule.to); for (const k of Object.keys(rule.match)) expect(preds).toContain(k) }
  expect(r.rules.at(-1)).toMatchObject({ id: 'default', match: {}, to: 'main' })
  for (const [cls, row] of Object.entries(r.notify.classes) as Array<[string, any]>) expect(row).toMatchObject(cls === 'no_reply' ? { plain: 'ledger', escalated: 'ledger' } : { plain: 'push', escalated: 'push' })
  expect(r.notify.limits).toBeUndefined()
})

test('routes: Joey → main; scheduler, page alert, peer call → reflex; a pushed mail → the mail lane; the reminder → the mail lane; a board order → a worker; no_reply → ledger', async () => {
  const meta = { chat_id: '1828173984', message_id: '9', user: 'joey' }
  expect((await L.routeEvent({ id: 'tg-1-9', source: 'telegram', from: 'joey', text: '早', meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: '早', meta } } } as any)))
    .toMatchObject({ rule: 'tg-main', target: 'main' })
  expect(await L.routeEvent(mesh('scheduler', '[scheduled][daily][run:5] 檢查', { meta: { run_id: '5' } }))).toMatchObject({ rule: 'mesh-scheduled', target: 'lane' })
  expect(await L.routeEvent(mesh('alert-dispatcher', '[P2] disk 85%'))).toMatchObject({ rule: 'mesh-alert', target: 'lane' })
  expect(await L.routeEvent(mesh('eve', '備份幾點？'))).toMatchObject({ rule: 'mesh-peer-call', target: 'lane' })
  const m = await L.routeEvent(mesh('cain', '週報請收', { line: 'mail', no_reply: true }))
  expect(m).toMatchObject({ rule: 'mesh-mail', target: 'lane' }); expect(L.__lanesState().lanes[m.lane!].kind).toBe('mail')
  const w = await L.routeEvent(mesh('fleet-watchdog', '讀信箱（2 封未讀，最舊的等了 61 分鐘）', { wake: 'mail', no_reply: true }))
  expect(w.rule).toBe('wake-mail'); expect(w.lane).toBe(m.lane)
  const b = await L.routeEvent(mesh('board', '[board][WO-140] 急：請處理'))
  expect(b).toMatchObject({ rule: 'mesh-board', target: 'lane' }); expect(L.__lanesState().lanes[b.lane!]).toMatchObject({ kind: 'worker', topic: 7100 })
  expect(await L.routeEvent(mesh('eve', '知會：好了', { no_reply: true }))).toMatchObject({ rule: 'mesh-no-reply', target: 'ledger' })
  expect(await L.routeEvent(mesh('stranger', '你好'))).toMatchObject({ rule: 'default', target: 'main' })     // not a registry agent: the main
})
