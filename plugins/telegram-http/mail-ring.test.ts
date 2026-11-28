import { test, expect, afterAll, describe } from 'bun:test'
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return true; await sleep(30) }
  return fn()
}
const RING_TEXT = '讀信箱（2 封未讀，最舊的等了 3 分鐘）：先用 mailbox_list（mcp__plugin_agent-inbox_agent-inbox__mailbox_list）看清單'
const KW_TEXT = '讀信箱（1 封未讀，最舊的等了 61 分鐘）：先用 mailbox_list（mcp__plugin_agent-inbox_agent-inbox__mailbox_list）看清單'

// ------------------------------------------------------------------ the router (lanes.ts, role tg)
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?mail-ring') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'mail-ring-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
const GO = join(dir, 'go'), bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, time
open('${dir}/prompts.log', 'a').write('run\\n')
t0 = time.time()
while time.time() - t0 < 30 and not os.path.exists('${GO}'): time.sleep(0.02)
try: os.remove('${GO}')
except OSError: pass
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restoreBin = L.__setClaudeBin(bin)
L.__setMailTool(async () => ({ text: '0 封未讀', isError: false }))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false,
  registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
let n = 0
const ringEv = () => ({ id: `mesh-ring-${++n}`, source: 'mesh', from: 'mailbox', verified: true, text: RING_TEXT, no_reply: true, wake: 'mail', line: 'mail',
  meta: { no_reply: 'true', ring: 'true', wake: 'mail', line: 'mail' }, notif: { method: 'notifications/claude/channel', params: { content: RING_TEXT, meta: {} } } } as any)
const kwEv = () => ({ id: `mesh-kw-${++n}`, source: 'mesh', from: 'fleet-watchdog', verified: true, text: KW_TEXT, no_reply: true, wake: 'mail', line: 'mail',
  meta: { no_reply: 'true', wake: 'mail' }, notif: { method: 'notifications/claude/channel', params: { content: KW_TEXT, meta: {} } } } as any)
const routing = (): any[] => { try { return readFileSync(join(dir, 'routing.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) } catch { return [] } }
const runs = (): number => { try { return readFileSync(join(dir, 'prompts.log'), 'utf8').trim().split('\n').filter(Boolean).length } catch { return 0 } }
const done = async (lane: string) => { writeFileSync(GO, 'ok'); await until(() => !L.__runTok(lane)); await sleep(30) }

describe('router', () => {
  test('lanes switched off: a ring is recorded and reaches no one; the watchdog\'s reminder (no ring) still goes to the main', async () => {
    const S = L.__lanesState()
    S.master_off = { since: new Date().toISOString(), by: 'test' }
    try {
      const ev = ringEv()
      const d = await L.routeEvent(ev)
      expect(d).toMatchObject({ rule: 'master-off-ring', target: 'ledger' })
      expect(routing().find(r => r.event === ev.id)).toMatchObject({ rule: 'master-off-ring', target: 'ledger', wake: 'mail' })
      expect(L.__journal().rows('msg', r => r.event === ev.id).length).toBe(0)            // no M1 item: the main is not woken
      const kw = kwEv()
      expect(await L.routeEvent(kw)).toMatchObject({ rule: 'master-off', target: 'main' })
      expect(L.__journal().rows('msg', r => r.event === kw.id).length).toBe(1)
    } finally { delete S.master_off }
  })

  test('lanes on: a ring dispatches the mail lane; rings while it runs make ONE follow-up run', async () => {
    const d1 = await L.routeEvent(ringEv())
    expect(d1).toMatchObject({ rule: 'wake-mail', target: 'lane' })
    const lane = d1.lane!
    expect(L.__lanesState().lanes[lane].kind).toBe('mail')
    expect(await until(() => !!L.__runTok(lane))).toBe(true)
    const d2 = await L.routeEvent(ringEv())                 // the run in progress may have listed the mailbox before this mail: one run after it
    const d3 = await L.routeEvent(ringEv())                 // a run already waits: it reads the whole mailbox
    const d4 = await L.routeEvent(kwEv())                   // the watchdog's safety-net reminder too
    expect(d2).toMatchObject({ target: 'lane', lane })
    expect(d3).toMatchObject({ rule: 'wake-mail', target: 'ledger', lane }); expect(d3.note).toContain('already waiting')
    expect(d4).toMatchObject({ rule: 'wake-mail', target: 'ledger', lane })
    await done(lane)
    expect(await until(() => !!L.__runTok(lane))).toBe(true)
    await done(lane)
    await sleep(300)
    expect(runs()).toBe(2)                                  // four wake-ups, two runs
    expect(L.__journal().rows('msg', r => String(r.event ?? '').startsWith('mesh-ring-')).length).toBe(0)   // the main never saw one
  }, 20000)
})

afterAll(() => {
  writeFileSync(GO, 'ok')
  L.__setClaudeBin(restoreBin)
  L.__setMailTool(null)
  delete process.env.LANES_FLOOD_CONTROL
})
