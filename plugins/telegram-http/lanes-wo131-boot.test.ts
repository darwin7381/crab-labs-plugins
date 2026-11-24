// telegram-http 1.38.3 (WO-131 A): at daemon boot every open mail lane whose thread or last run is at or over the renewal thresholds is closed, so the next
// reminder opens a fresh one (no wait for the budget, no main call). A lane from before 1.38.3 has no last_fresh on its record: its last exit row in
// lanes.jsonl says it (chiron.mail.1.r17: tokens_fresh 138,489). A reminder the previous daemon had queued for it runs on the fresh lane. Reflex lanes stay.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?wo131boot') as typeof import('./lanes.ts')

const ws = mkdtempSync(join(tmpdir(), 'lanes-wo131b-ws-'))
const dir = join(ws, '.lanes'); mkdirSync(join(dir, 'lanes'), { recursive: true })
const tmp = mkdtempSync(join(tmpdir(), 'lanes-wo131b-'))
const tr = join(tmp, 'tr'); mkdirSync(tr)
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
const ARGV = join(tmp, 'argv.jsonl'), bin = join(tmp, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, sys, time
lid = os.environ.get('LANE_ID', 'x')
with open('${ARGV}', 'a') as f: f.write(json.dumps({'lane': lid, 'argv': sys.argv[1:]}) + '\\n')
go = os.path.join('${tmp}', 'go-' + lid)
t0 = time.time()
while time.time() - t0 < 60 and not os.path.exists(go): time.sleep(0.02)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
const at = '2026-11-24T06:18:03.474Z'
const lane = (id: string, kind: string, n: number, thread: string, status: string, runs: number) =>
  ({ id, kind, n, session_id: `00000000-0000-4000-8000-00000000000${n}${kind.length}`, thread, status, created: at, last: new Date().toISOString(), transcript: join(tr, `${id}.jsonl`), runs, tokens_in: 0, tokens_out: 0, title: kind === 'mail' ? '信箱' : undefined })
const thread = (id: string, l: string, fresh: number) => ({ id, lane: l, peer: null, hops: 0, tokens: fresh, fresh, created: at, last: at })
writeFileSync(join(dir, 'state.json'), JSON.stringify({
  counters: { mail: 2, reflex: 1 }, outbound: {}, botmsgs: {}, topics: {}, tickets: {}, pushes: {}, followups: {}, mail_lane: 'adam.mail.2',
  lanes: { 'adam.mail.1': lane('adam.mail.1', 'mail', 1, 'adam#t-m1', 'closed', 5), 'adam.mail.2': lane('adam.mail.2', 'mail', 2, 'adam#t-m2', 'idle', 17),
    'adam.reflex.1': lane('adam.reflex.1', 'reflex', 1, 'adam#t-r1', 'idle', 1) },
  threads: { 'adam#t-m1': thread('adam#t-m1', 'adam.mail.1', 990_000), 'adam#t-m2': thread('adam#t-m2', 'adam.mail.2', 300_000), 'adam#t-r1': thread('adam#t-r1', 'adam.reflex.1', 700_000) } }))
writeFileSync(join(dir, 'lanes.jsonl'), JSON.stringify({ ts: at, lane: 'adam.mail.2', kind: 'exit', run: 'adam.mail.2.r17', event: 'mail-decision-11058', reason: 'normal', calls: 3, tokens_in: 400000, tokens_out: 900, tokens_fresh: 138_489, tools: [], closers: [] }) + '\n')
const text = '讀信箱（2 封未讀，最舊的等了 60 分鐘）：先用 mailbox_list（mcp__plugin_agent-inbox_agent-inbox__mailbox_list）看清單'
const ev = { id: 'mesh-wo131b-1', source: 'mesh', from: 'fleet-watchdog', verified: true, text, meta: { no_reply: 'true' }, notif: { method: '', params: {} }, no_reply: true, wake: 'mail', trigger: 'mail', cls: 'mail' }
writeFileSync(join(dir, 'lanes', 'state.jsonl'), [
  { ts: at, rec: 'event', id: ev.id, state: 'closed', obligations: [], class: 'peer', owner: 'adam.mail.2', outcome: 'normal', thread: 'adam#t-m2', lane: 'adam.mail.2', from: ev.from, text },
  { ts: at, rec: 'run', id: `${ev.id}#boot1`, state: 'queued', event: ev.id, lane: 'adam.mail.2', attempt: 1, ev, priority: 5, summary: null, enqueued: at },
].map(r => JSON.stringify(r)).join('\n') + '\n')
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: ws, transcriptDir: tr, httpPort: 0, log: () => {}, authOk: () => true, registryNames: () => [],
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
afterAll(() => { for (const f of Object.keys(L.__lanesState().lanes)) try { writeFileSync(join(tmp, `go-${f}`), 'ok') } catch {}
  L.__setClaudeBin(restore); delete process.env.LANES_FLOOD_CONTROL
  rmSync(ws, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }) })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const jsonl = (p: string): any[] => { try { return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }

test('WO-131 A, boot: the open mail lane whose last run was 138,489 fresh tokens (its lanes.jsonl row) is closed at boot; the reminder the previous daemon queued for it runs on a fresh mail lane; the reflex lane at 700,000 stays; nothing for the main', async () => {
  const S = L.__lanesState()
  expect(S.lanes['adam.mail.2']).toMatchObject({ status: 'closed', rotated: { where: 'boot', why: expect.stringContaining('its last run used 138489 fresh tokens') } })
  expect(jsonl(join(dir, 'lanes.jsonl')).filter(x => x.kind === 'mail_lane_rotated')).toMatchObject([{ lane: 'adam.mail.2', where: 'boot', last_fresh: 138_489, thread_fresh: 300_000, to: null }])
  expect(S.lanes['adam.reflex.1'].status).toBe('idle')                                            // reflex lanes: unchanged
  expect(S.lanes['adam.mail.1'].rotated).toBeUndefined()                                          // already closed: left as it was
  // the queued reminder (restored from the journal) starts on the fresh lane at the first sweep
  expect(await until(() => jsonl(ARGV).some(x => x.lane === 'adam.mail.3'), 10_000)).toBe(true)
  expect(jsonl(join(dir, 'lanes.jsonl')).find(x => x.kind === 'mail_event_moved')).toMatchObject({ lane: 'adam.mail.2', event: ev.id, to: 'adam.mail.3', cut: false })
  expect(S.mail_lane).toBe('adam.mail.3')
  expect(S.lanes['adam.mail.3'].prev_thread).toBe('adam#t-m2')
  const argv = jsonl(ARGV).find(x => x.lane === 'adam.mail.3').argv
  expect(argv).toContain('--session-id')
  expect(L.__runTok('adam.mail.3')!.evId).toBe(ev.id)
  expect(L.__main().items(r => r.kind !== 'digest')).toEqual([])
  expect(jsonl(join(dir, 'ledger.jsonl')).some(x => x.kind === 'stop')).toBe(false)
}, 20000)
