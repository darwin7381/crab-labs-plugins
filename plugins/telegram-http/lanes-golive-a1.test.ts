// lanes-golive A1: the scheduler sends the run number and the high-frequency mark only in the text header ([scheduled][tag][run:N]…[high-frequency]);
// the router read body fields nobody sends. The event's meta now gets them from the header (server.ts laneEventOf: fleetRunId, highFrequencyHeader), so a
// run a lane takes gets its start receipt and its receipt obligation, and a high-frequency run owes Joey nothing (ORG-CHART §0 #5, Joey 934).
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?golive-a1') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-golive-a1-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setClaudeBin(join(import.meta.dir, 'test-fixtures', 'no-claude.sh'))

test('highFrequencyHeader: only the bracket header of a [scheduled] line counts', () => {
  expect(L.highFrequencyHeader('[scheduled][inbox-poll][run:88][P2][ops][high-frequency] 看信')).toBe(true)
  expect(L.highFrequencyHeader('[scheduled][daily][run:89] 每日報告')).toBe(false)
  expect(L.highFrequencyHeader('[scheduled][daily][run:89] 內文提到 [high-frequency] 不算')).toBe(false)
  expect(L.highFrequencyHeader('[alert][high-frequency] not a schedule')).toBe(false)
})

const sched = (id: string, text: string, meta: Record<string, string>) => ({ id, source: 'mesh', from: 'scheduler', verified: true, text, meta,
  notif: { method: 'notifications/claude/channel', params: { content: text, meta } } } as any)

test('a run a lane takes owes its receipt (run id from the header); a high-frequency one owes Joey no line, an ordinary one does', async () => {
  const hf = await L.routeEvent(sched('mesh-a1-1', '[scheduled][inbox-poll][run:88][high-frequency] 看信', { run_id: '88', frequency: 'high' }))
  expect(hf.target).toBe('lane')
  const ob1 = (L.__events().get('mesh-a1-1')!.obligations as any[])
  expect(ob1.map(o => o.kind)).toEqual(['receipt']); expect(ob1[0].run_id).toBe('88')
  await L.routeEvent(sched('mesh-a1-2', '[scheduled][daily][run:89] 每日報告', { run_id: '89' }))
  expect((L.__events().get('mesh-a1-2')!.obligations as any[]).map(o => o.kind).sort()).toEqual(['joey', 'receipt'])
})

test('server.ts: the event meta takes the run id and frequency from the header when the body has no field', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  const f = src.slice(src.indexOf('function laneEventOf('), src.indexOf('async function laneDeliverMesh('))
  expect(f).toContain(': p.meta?.run_id || fleetRunId(n)')
  // WO-164: an agent in LANES_WAKE_DECIDE reads the run from the fields only (refs.run / refs.run_id, the body's run_id), never the header
  expect(f).toContain('const runId = Lanes.threadKeysOn() ? runOf(facts.refs, p.meta?.run_id) ?? undefined : p.meta?.run_id || fleetRunId(n)')
  expect(f).toContain("const frequency = p.meta?.frequency || (Lanes.highFrequencyHeader(text) ? 'high' : '')")
})
