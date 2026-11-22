// Universe 002k (K1): the lanes are not handed the service address, and their card says in one sentence how the services are reached.
// The lane process is a script that writes its environment to a file; the stand-in Logos is up before lanes.ts is imported (it reads GENESIS_LOGOS_URL once).
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const server = Bun.serve({ port: 0, fetch: () => new Response('{}') })
process.env.GENESIS_LOGOS_URL = `http://127.0.0.1:${server.port}`
const L = await import('./lanes.ts?k1-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-k1-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3\nimport os, json\nopen('${dir}/env.json', 'w').write(json.dumps(dict(os.environ)))\nprint('{"type":"result","subtype":"success","is_error":false,"result":"ok"}')\n`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => { L.__setClaudeBin(restore); server.stop(true); delete process.env.GENESIS_LOGOS_URL })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(30) } return f() }
const env = (): Record<string, string> | null => { try { return JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8')) } catch { return null } }

test('K1: a lane process is not handed the service address (neither name), though the daemon knows it; its identity variables are still there', async () => {
  const d = await L.routeEvent({ id: 'mesh-k1', source: 'mesh', from: 'eve', verified: true, text: '請問 mock-api 的逾時是多少？', meta: {}, notif: { method: '', params: {} } } as any)
  expect(d.target).toBe('lane')
  expect(await until(() => env() !== null)).toBe(true)
  const e = env()!
  expect(process.env.GENESIS_LOGOS_URL).toContain('127.0.0.1')
  expect('LANES_LOGOS_URL' in e).toBe(false)
  expect('GENESIS_LOGOS_URL' in e).toBe(false)
  expect(JSON.stringify(e)).not.toContain(String(server.port))
  expect(e.LANE_ID).toBe(d.lane); expect(e.GENESIS_ACTOR).toBe(d.lane); expect(e.LANE_KIND).toBe('reflex'); expect(e.LANES_DIR).toBe(dir)
})

test('K1: the lane card says in one sentence that services are reached only through ./bin/svc <METHOD> <path>, and ./bin/svc alone prints the catalog', () => {
  for (const kind of ['reflex', 'worker', 'fork', 'curator', 'synthesis'] as const) {
    const lines = L.identityCard({ kind }).split('\n').filter(l => l.includes('./bin/svc'))
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('只能經由 ./bin/svc <METHOD> <path>')
    expect(lines[0]).toContain('不帶任何參數的 ./bin/svc 會印出服務目錄')
    expect(lines[0].split('。').filter(Boolean).length).toBe(1)                     // one sentence
  }
  expect(L.identityCard({ kind: 'reflex' })).toBe(L.identityCard({ kind: 'reflex' }))   // still the same text for every lane of a kind (B19)
})
