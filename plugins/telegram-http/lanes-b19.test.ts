// Universe 002k (B19): every lane of a kind gets the SAME appended system prompt, so the lanes share one cached prefix. What differs per
// lane (lane id, thread, focus card, critical flag, thread summary) is at the head of the event prompt. The lane process is a script
// that writes its argv to a file.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?b19-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-b19-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3\nimport sys, json\nopen('${dir}/argv.jsonl', 'a').write(json.dumps(sys.argv[1:]) + '\\n')\nprint('{"type":"result","subtype":"success","is_error":false,"result":"ok"}')\n`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => L.__setClaudeBin(restore))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const argvs = (): string[][] => { try { return readFileSync(join(dir, 'argv.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(30) } return f() }
const ev = (id: string, from: string, text: string, extra: object = {}) => ({ id, source: 'mesh', from, verified: true, text, meta: {}, notif: { method: '', params: {} }, ...extra } as any)
const after = (a: string[], flag: string): string => a[a.indexOf(flag) + 1]
const lane = (n: number, extra: object = {}) => ({ id: `adam.reflex.${n}`, kind: 'reflex', n, session_id: 's' + n, thread: `adam#t-b19${n}`, status: 'new', created: '', last: '', transcript: '', runs: 0, tokens_in: 0, tokens_out: 0, ...extra } as any)

test('B19: two lanes with different ids, threads and focus cards get identical system-prompt text', () => {
  writeFileSync(join(dir, 'focus.md'), '焦點：A 專案本週要上線')
  const a = L.identityCard(lane(1), { summary: undefined } as any)
  writeFileSync(join(dir, 'focus.md'), '焦點：完全不同的另一張卡 ZZZ-9912')
  const b = L.identityCard(lane(7, { critical: true, topic: 5, title: 'x' }), { summary: '舊帳本' } as any)
  expect(a).toBe(b)
  expect(a).not.toContain('adam.reflex.1'); expect(a).not.toContain('adam.reflex.7')
  expect(a).not.toContain('adam#t-b19'); expect(a).not.toContain('ZZZ-9912'); expect(a).not.toContain('焦點卡（主線寫的')
  // the per-lane data is in the lane context, and only there
  const ca = L.laneContext(lane(1), { summary: undefined, ev: {} } as any), cb = L.laneContext(lane(7, { critical: true }), { summary: '舊帳本', ev: {} } as any)
  expect(ca).toContain('adam.reflex.1'); expect(ca).toContain('adam#t-b19' + 1); expect(ca).toContain('ZZZ-9912')
  expect(cb).toContain('adam.reflex.7'); expect(cb).toContain('舊帳本'); expect(cb).toContain('分流器標記：嚴重警報')
  expect(ca).not.toContain('分流器標記：嚴重警報')
  // a kind with its own role keeps it in the card; kinds differ from each other, lanes of a kind do not
  expect(L.identityCard({ kind: 'curator' })).toContain('你是整理線')
  expect(L.identityCard({ kind: 'curator' })).not.toBe(a)
  expect(L.identityCard({ kind: 'curator' })).toBe(L.identityCard({ kind: 'curator' }))
})

test('B19: the started processes get the same --append-system-prompt; the lane data is in -p, in front of the event', async () => {
  writeFileSync(join(dir, 'focus.md'), '焦點：第一張卡 QQ-1')
  const d1 = await L.routeEvent(ev('mesh-b1', 'eve', '請問 mock-api 的 /v2/orders 逾時是多少？'))
  expect(d1.target).toBe('lane')
  writeFileSync(join(dir, 'focus.md'), '焦點：第二張卡 QQ-2')
  const d2 = await L.routeEvent(ev('mesh-b2', 'cain', '[P1][critical] mock-api 全部回 5xx', { from: 'alert-dispatcher' }))
  expect(d2.target).toBe('lane')
  expect(d2.lane).not.toBe(d1.lane)
  expect(await until(() => argvs().length >= 2)).toBe(true)
  const [x, y] = argvs()
  expect(after(x, '--append-system-prompt')).toBe(after(y, '--append-system-prompt'))
  const px = after(x, '-p'), py = after(y, '-p')
  expect(px).toContain(d1.lane!); expect(px).toContain('QQ-1'); expect(px).not.toContain('分流器標記：嚴重警報')
  expect(py).toContain(d2.lane!); expect(py).toContain('QQ-2'); expect(py).toContain('分流器標記：嚴重警報')
  expect(px.indexOf('QQ-1')).toBeLessThan(px.indexOf('/v2/orders'))                 // the lane data comes first, then the event
  expect(py.indexOf('分流器標記')).toBeLessThan(py.indexOf('全部回 5xx'))
  for (const a of [x, y]) { expect(after(a, '--append-system-prompt')).not.toContain(d1.lane!); expect(after(a, '--append-system-prompt')).not.toContain(d2.lane!) }
})
