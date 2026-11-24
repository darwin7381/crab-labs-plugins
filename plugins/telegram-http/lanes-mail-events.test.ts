// WO-126: the mailbox's events reach the router over /lanes/route (lanes.ts routeEvent). A router that does not know source 'mail' (1.37.x; with WO-127,
// LANES_DECISIONS=0) must give them to the main as one item: no lane, no ledger-only, no error, no Telegram line. WO-127's own rule: lanes-wo127.test.ts.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { decisionEvent, dueEvent } from './mail-events.ts'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?mail-events') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-mail-events-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
const sent: any[] = []
L.lanesInit({ role: 'tg', agent: 'kot', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['lynx'],
  sendBot: async (...a: any[]) => { sent.push(a); return 1 }, joeyChatId: () => '1' } as any)
afterAll(() => { delete process.env.LANES_FLOOD_CONTROL })

test('a mail_decision / mail_due the router has no rule for goes to the main, whole', async () => {
  process.env.LANES_DECISIONS = '0'
  try {
  const lanesBefore = Object.keys(L.__lanesState().lanes).length
  const d1 = await L.routeEvent(decisionEvent({ id: 41, title: 'Lynx：維護時段', decision: 'as_recommended', note: null, lane: 'kot.mail.1', thread: 'kot#t-1',
    card: { decide: 'x', recommend: 'y' }, ref: null }) as any)
  expect(d1).toMatchObject({ target: 'main' })
  const d2 = await L.routeEvent(dueEvent({ id: 42, title: 'Kot：重開', deadline: '2026-11-24T12:00:00+00:00', overdue: false, decide: '要不要重開',
    recommend: '重開', lane: 'kot.reflex.2', thread: 'kot#t-9', ref: 'ev-1' }) as any)
  expect(d2).toMatchObject({ target: 'main' })
  expect(Object.keys(L.__lanesState().lanes).length).toBe(lanesBefore)   // no lane was started for them
  expect(sent).toEqual([])                                                 // and nothing went to Telegram
  } finally { delete process.env.LANES_DECISIONS }
})
