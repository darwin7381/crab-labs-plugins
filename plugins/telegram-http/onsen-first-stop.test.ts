// WO-192 acceptance 4 (the main's half): a reply written into Onsen whose Telegram send failed is said; server.ts tells the lanes so with
// mainReplied(tier, 'onsen:<id>', …). The turn's Joey line is met on the Onsen message and the Stop check does not hold the turn (no second answer).
// Without the reply the same turn is held (the check is real).
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?onsen-first-stop') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'onsen-first-stop-'))
process.env.LANES_DIR = dir
copyFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), join(dir, 'router.json'))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => [],
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
afterAll(() => { delete process.env.LANES_FLOOD_CONTROL })
const joeyOb = (id: string) => ((L.__events().get(id)?.obligations ?? []) as any[]).find(o => o.kind === 'joey')

async function turnWith(msgId: number, prompt: string, fn: () => void): Promise<string> {
  const meta = { chat_id: '1', message_id: String(msgId), user: 'joey' }
  const id = `tg-1-${msgId}`
  await L.routeEvent({ id, source: 'telegram', from: 'joey', text: `問題 ${msgId}`, meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: `問題 ${msgId}`, meta } } } as any)
  const proc = Bun.spawn(['sleep', '600'])
  const sid = `00000000-0000-4000-8000-${String(proc.pid).padStart(12, '0')}`
  writeFileSync(join(dir, 'main-expected'), sid)
  await L.__mainEvent({ event: 'SessionStart', pid: proc.pid, session_id: sid })
  const dids = L.__main().items(r => r.state !== 'done' && r.kind !== 'digest' && String(r.event) === id).map(r => r.id)
  expect(dids.length).toBe(1)
  await L.__mainEvent({ event: 'UserPromptSubmit', pid: proc.pid, prompt_id: prompt, dids })
  try {
    fn()
    const r = await L.__mainEvent({ event: 'Stop', pid: proc.pid, prompt_id: prompt })
    return String(r.block ?? '')
  } finally {
    await L.__mainEvent({ event: 'Stop', pid: proc.pid, prompt_id: prompt, phase: 'final' }); await L.__mainEvent({ event: 'SessionEnd', pid: proc.pid }); proc.kill('SIGKILL')
  }
}

test('control: a turn whose Joey message got no reply is held by the Stop check', async () => {
  const block = await turnWith(701, 'p-of-1', () => {})
  expect(block).toContain('還欠事沒交代')
}, 20000)

test('the main\'s reply written into Onsen, Telegram still to come (onsen:<id>): the Joey line is met on it; the Stop check does not hold the turn', async () => {
  const block = await turnWith(702, 'p-of-2', () => L.mainReplied(null, 'onsen:4242', undefined, '好，我來處理', '1'))
  expect(joeyOb('tg-1-702')).toMatchObject({ state: 'met', by: 'main', ref: 'onsen:4242' })
  expect(block).not.toContain('還欠事沒交代')
}, 20000)
