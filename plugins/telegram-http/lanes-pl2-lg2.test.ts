// Universe 002m (LG2, RV5/RV6 G01 #6): a refused registration is told to Joey once, at once (G01: within 120 s), and filed in the ledger. Until 002l
// registerMain only logged it. notify 「要你馬上知道的 → 正常推播：…嚴重警報」. No network, no process.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?pl2-lg2-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-pl2-lg2-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const MAIN = 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', OTHER = '1e0f0a0e-0000-4000-8000-000000000002', THIRD = '1e0f0a0e-0000-4000-8000-000000000003'
writeFileSync(join(dir, 'main-expected'), MAIN)
const sent: Array<{ text: string; silent: boolean }> = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => [],
  sendBot: async (_c: string, text: string, o: { silent?: boolean }) => { sent.push({ text, silent: !!o.silent }); return 7000 + sent.length }, joeyChatId: () => '1' } as any)
const ledger = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const tick = () => new Promise(r => setTimeout(r, 20))

test('LG2: the second session\'s refused registration reaches Joey at once, as a push naming the session and the main; one ledger row', async () => {
  expect(L.__registerMainForTest(MAIN, join(dir, 'main.jsonl'), process.pid).accepted).toBe(true)
  expect(sent.length).toBe(0)                                                 // an accepted main tells nobody
  expect(L.__registerMainForTest(OTHER, join(dir, 'o.jsonl'), process.ppid).accepted).toBe(false)
  await tick()
  expect(sent.length).toBe(1)
  expect(sent[0].silent).toBe(false)
  expect(sent[0].text).toContain('〔adam·分流器〕')
  expect(sent[0].text).toContain('被我拒絕了（session 1e0f0a0e')
  expect(sent[0].text).toContain('主線還是 session a20fb7c0')
  const rows = ledger().filter(r => r.refs?.tier_rule === 'register-refused')
  expect(rows.length).toBe(1)
  expect(rows[0]).toMatchObject({ lane: 'router', kind: 'notify', refs: { tier: 'push', session: OTHER, pid: process.ppid } })
})

test('LG2: once per refused session: the same session registering again (a /clear, a hook retry) is not told twice; another session is', async () => {
  L.__registerMainForTest(OTHER, join(dir, 'o.jsonl'), process.ppid)
  L.__registerMainForTest(OTHER, join(dir, 'o.jsonl'), process.ppid)
  await tick()
  expect(sent.length).toBe(1)
  L.__registerMainForTest(THIRD, join(dir, 't.jsonl'), process.ppid)
  await tick()
  expect(sent.length).toBe(2)
  expect(sent[1].text).toContain('session 1e0f0a0e')
})
