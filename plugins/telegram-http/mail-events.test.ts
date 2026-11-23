// WO-126: the mailbox's events for the lane router (mail-events.ts): shape, ids, the due window, waiting when the router is down.
import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MailEvents, decisionEvent, dueEvent, decisionWords } from './mail-events.ts'

const DEC = { id: 41, title: 'Lynx：維護時段', from: 'lynx', status: 'read', decision: 'changed', note: '改成週四 03:00',
  card: { decide: '週三 02:00 停機要不要照排', recommend: '照排', deadline: '2026-11-24T12:00:00+00:00' },
  lane: 'kot.mail.1', thread: 'kot#t-1', from_lane: null, card_lane: 'kot.mail.1', ref: null }
const DUE = { id: 42, title: 'Kot：重開 daemon', deadline: '2026-11-24T12:00:00+00:00', overdue: false, decide: '要不要重開', recommend: '重開',
  lane: 'kot.reflex.2', thread: 'kot#t-9', from_lane: 'kot.reflex.2', ref: 'ev-1' }

test('mail_decision: the seam v2 fields, id mail-decision-<id>, a readable text and notification for a router that does not know the kind', () => {
  const ev = decisionEvent(DEC)
  expect(ev).toMatchObject({ id: 'mail-decision-41', source: 'mail', kind: 'mail_decision', mail_id: 41, lane: 'kot.mail.1', thread: 'kot#t-1',
    decision: 'changed', note: '改成週四 03:00', title: 'Lynx：維護時段', ref: null, line: 'mail', no_reply: true, from: 'mailbox' })
  expect(ev.card).toEqual(DEC.card)
  expect(ev.text).toContain('改成：改成週四 03:00')
  expect(ev.text).toContain('kot.mail.1（kot#t-1）')
  expect(ev.notif.method).toBe('notifications/claude/channel')
  expect(ev.notif.params.content).toBe(ev.text)
  expect(Object.values(ev.notif.params.meta).every(v => typeof v === 'string')).toBe(true)
  expect(decisionWords('as_recommended')).toBe('照建議')
  expect(decisionWords('declined', '先不動')).toBe('不做（先不動）')
})

test('mail_due: id carries the deadline (a moved deadline is a new event); text says what to decide and how', () => {
  const ev = dueEvent(DUE)
  expect(ev).toMatchObject({ id: 'mail-due-42-2026-11-24T12:00:00+00:00', kind: 'mail_due', mail_id: 42, lane: 'kot.reflex.2', thread: 'kot#t-9',
    deadline: DUE.deadline, decide: '要不要重開', ref: 'ev-1', overdue: false })
  expect(ev.text).toContain('快到期')
  expect(ev.text).toContain('mailbox_decide')
  expect(dueEvent({ ...DUE, overdue: true }).text).toContain('已過期')
  expect(dueEvent({ ...DUE, deadline: '2026-11-24T13:00:00+00:00' }).id).not.toBe(ev.id)
})

test('router down: the event waits in the file, in order; the next tick hands it over; a new daemon reads the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-events-'))
  const file = join(dir, 'mail-events.json')
  let up = false
  const got: string[] = []
  const send = async (ev: any) => { if (!up) return false; got.push(ev.id); return true }
  const m = new MailEvents({ file, send, log: () => {} })
  expect(await m.emit(decisionEvent(DEC))).toBe('queued')
  expect(await m.emit(decisionEvent({ ...DEC, id: 43 }))).toBe('queued')
  expect(await m.emit(decisionEvent(DEC))).toBe('queued')                     // the same id waits once
  expect(m.pending.map(e => e.id)).toEqual(['mail-decision-41', 'mail-decision-43'])
  expect(JSON.parse(readFileSync(file, 'utf8')).pending.length).toBe(2)
  const m2 = new MailEvents({ file, send, log: () => {} })                    // the daemon restarted
  expect(m2.pending.length).toBe(2)
  up = true
  expect(await m2.tick(async () => [])).toEqual({ flushed: 2, due: 0 })
  expect(got).toEqual(['mail-decision-41', 'mail-decision-43'])
  expect(m2.pending).toEqual([])
  expect(await m2.emit(decisionEvent({ ...DEC, id: 44 }))).toBe('handed')
  expect(got.at(-1)).toBe('mail-decision-44')
})

test('due window: only items new to the window are handed over; BTCC not answering changes nothing; a thrown send counts as not taken', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-events-'))
  const got: string[] = []
  let t = 1_000_000
  let boom = false
  const m = new MailEvents({ file: join(dir, 'e.json'), send: async ev => { if (boom) throw new Error('reset'); got.push(ev.id); return true }, log: () => {}, now: () => t })
  expect(await m.tick(async () => [DUE])).toEqual({ flushed: 0, due: 1 })
  expect(await m.tick(async () => [DUE])).toEqual({ flushed: 0, due: 0 })
  expect(await m.tick(async () => null)).toEqual({ flushed: 0, due: 0 })
  const moved = { ...DUE, deadline: '2026-11-24T13:00:00+00:00' }
  boom = true
  expect(await m.tick(async () => [moved])).toEqual({ flushed: 0, due: 1 })
  expect(m.pending.map(e => e.id)).toEqual([`mail-due-42-${moved.deadline}`])
  boom = false
  expect((await m.tick(async () => [moved])).flushed).toBe(1)
  expect(got).toEqual([`mail-due-42-${DUE.deadline}`, `mail-due-42-${moved.deadline}`])
  t += 4 * 86400_000
  await m.tick(async () => [])
  expect(Object.keys(m.dueSent)).toEqual([])                                 // old keys pruned
})
