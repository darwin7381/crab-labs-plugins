// 1.52.0 (WO-158): hub sync is gone; what is left is handing an older process's parked doorbells to the delivery once.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DOORBELL_DIR, drainLeftoverDoorbells, type Notif } from './hub-sync.ts'

const injectNotif = (id: number, text = 'from /inject'): Notif => ({ method: 'notifications/claude/channel',
  params: { content: text, meta: { chat_id: 'owner', user: 'chiron', ts: '2026-11-17T15:00:01.000Z', btcc_msg_id: String(id) } } })

describe('leftover doorbells', () => {
  test('a doorbell an older process parked is handed to the delivery once and its file removed; no directory: nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-sync-'))
    mkdirSync(join(dir, DOORBELL_DIR))
    writeFileSync(join(dir, DOORBELL_DIR, '60.json'), JSON.stringify({ chatId: 'owner', notif: injectNotif(60) }))
    const got: Array<[string, Notif]> = [], logs: string[] = []
    expect(await drainLeftoverDoorbells(dir, async (c, n) => { got.push([c, n]) }, (_l, m) => logs.push(m))).toBe(1)
    expect(got).toEqual([['owner', injectNotif(60)]])
    expect(readdirSync(join(dir, DOORBELL_DIR))).toEqual([])
    expect(logs.join('\n')).toContain('hub sync was removed in 1.52.0 — 1 doorbell(s)')
    expect(await drainLeftoverDoorbells(dir, async () => { throw new Error('not again') }, () => {})).toBe(0)
    expect(await drainLeftoverDoorbells(join(dir, 'nope'), async () => {}, () => {})).toBe(0)
  })
  test('an unreadable or undeliverable file is logged and kept; the others go', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-sync-'))
    mkdirSync(join(dir, DOORBELL_DIR))
    writeFileSync(join(dir, DOORBELL_DIR, '1.json'), '{not json')
    writeFileSync(join(dir, DOORBELL_DIR, '2.json'), JSON.stringify({ chatId: 'owner', notif: injectNotif(2) }))
    const logs: string[] = []
    expect(await drainLeftoverDoorbells(dir, async () => {}, (_l, m) => logs.push(m))).toBe(1)
    expect(readdirSync(join(dir, DOORBELL_DIR))).toEqual(['1.json'])
    expect(readFileSync(join(dir, DOORBELL_DIR, '1.json'), 'utf8')).toBe('{not json')
    expect(logs.some(l => l.includes('leftover doorbell 1.json unreadable'))).toBe(true)
  })
})
