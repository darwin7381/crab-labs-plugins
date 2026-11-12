// Universe 002: the notify tier is decided by the router (router.json notify), never by the lane.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { lanesInit, notifyDecision, triggerClass } from './lanes.ts'

const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-notify-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: () => {}, authOk: () => false } as any)
const cfg = JSON.parse(await Bun.file(ROUTER).text())
const alert = cfg.rules.find((r: any) => r.id === 'mesh-alert')
const ev = (text: string) => ({ id: 'x', source: 'mesh', from: 'alert-dispatcher', text, meta: {}, notif: { method: '', params: {} } }) as any

test('trigger classes from router.json', () => {
  expect(triggerClass(alert, ev('[P1][critical] mock-backup 連續兩次失敗'))).toBe('alert-critical')
  expect(triggerClass(alert, ev('[P4][info] mock-tickets 佇列延遲 40s'))).toBe('alert-info')
  expect(triggerClass(alert, ev('[P2][warning] mock-api p95 2.4s > 2s'))).toBe('alert')
})

test('tier = router.json notify (trigger x kind), default push', () => {
  expect(notifyDecision('alert', 'escalation', 't1').tier).toBe('push')
  expect(notifyDecision('alert-info', 'result', 't2').tier).toBe('silent')
  expect(notifyDecision('alert-critical', 'routine', 't3').tier).toBe('push')
  expect(notifyDecision('scheduled', 'routine', 't4').tier).toBe('silent')
  expect(notifyDecision('scheduled', 'result', 't5').tier).toBe('push')
  expect(notifyDecision('peer', 'info', 't6').tier).toBe('silent')
  expect(notifyDecision('other', 'unknown-kind', 't7').tier).toBe('push')
})
