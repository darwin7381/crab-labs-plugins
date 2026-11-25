// Onsen step 2 (WO-142), lanes on: Joey's edit of a message whose M1 item is still queued (the main has not seen it) rewrites that item; an item already
// offered / taken in is left alone (the edit then goes as a new message, server.ts). lanes-main.ts replaceQueued through lanes.ts replaceQueuedMain.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?onsen-step2') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-onsen2-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
const deps: any = { role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  notifySession: async () => false, streamOpen: () => false, sendBot: async () => 100, joeyChatId: () => '1' }
L.lanesInit(deps)
const M = () => L.__main()
async function joey(id: number, text: string): Promise<string> {
  const meta = { chat_id: '1', message_id: String(id), user: 'joey_lab' }
  const d = await L.routeEvent({ id: `tg-1-${id}`, source: 'telegram', from: 'joey', text, meta, verified: true,
    notif: { method: 'notifications/claude/channel', params: { content: text, meta } } } as any)
  expect(d.target).toBe('main')
  return M().items(r => r.event === `tg-1-${id}`)[0].id
}
const rw = (p: { content: string; meta: Record<string, string> }) => ({ content: `新：${p.content.length}`, meta: { ...p.meta, edited: 'true', edited_at: '2026-11-25T03:09:00.000Z' } })

test('a queued, never offered item takes the edit; the event id and the delivery fields stay; an offered or re-queued one does not; other messages untouched', async () => {
  const a = await joey(301, '原文 A')                                   // no main: queued (main gone), never offered
  const b = await joey(302, '原文 B')
  expect(M().items(r => r.id === a)[0].state).toBe('queued')
  expect(L.replaceQueuedMain('1', '301', rw)).toBe(true)
  const row = M().items(r => r.id === a)[0]
  expect(row.state).toBe('queued'); expect(row.event).toBe('tg-1-301')
  expect(row.notif.params.content).toBe('新：4')
  expect(row.notif.params.meta).toMatchObject({ chat_id: '1', message_id: '301', did: a, edited: 'true', edited_at: '2026-11-25T03:09:00.000Z' })
  expect(M().items(r => r.id === b)[0].notif.params.content).toBe('原文 B')
  expect(L.replaceQueuedMain('1', '999', rw)).toBe(false)                // not queued here
  expect(L.replaceQueuedMain('2', '302', rw)).toBe(false)                // another chat
  L.__journal().write('msg', b, 'offered', { gen: '4242' })              // the main was offered it: it may have read it
  expect(L.replaceQueuedMain('1', '302', rw)).toBe(false)
  L.__journal().write('msg', b, 'queued', { reason: 'offer_untaken', gen: null })   // put back: not "never seen" any more
  expect(L.replaceQueuedMain('1', '302', rw)).toBe(false)
  expect(M().items(r => r.id === b)[0].notif.params.content).toBe('原文 B')
})
