// Universe 002k (H4): the E3 hook for runs a PEER started and for declines said with ask_joey / reply_agent: held once when the run made no ./bin/svc catalog or GET
// call; the output of ./bin/svc GET mock-api/config and GET mock-api/health is attached for a mock-api subject, the catalog when the subject is unknown.
// The hook is run as Claude Code runs it, against a stub ./bin/svc. No network, no model.
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const HOOK = join(import.meta.dir, 'lanes-hooks', 'lane-stop-hook.py')
const rec = (o: object) => JSON.stringify(o) + '\n'
const prompt = (t: string) => rec({ type: 'user', message: { role: 'user', content: t } })
const tool = (name: string, input: object) => rec({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })
const bash = (command: string) => tool('Bash', { command })
const notify = (text: string) => tool('mcp__lane__notify_joey', { text })
const ask = (text: string) => tool('mcp__lane__ask_joey', { text })
const replyTo = (to: string, text: string) => tool('mcp__lane__reply_agent', { to, text })
const PEER_API = '[車道事件 mesh-71｜來源 mesh｜寄件者 eve（verified=true relay=direct）｜btcc_msg_id 71]\nmock-api 的 log_level 現在是 debug 對不對？我要排明天的批次，順便確認 health 正常。'
const PEER_OTHER = '[車道事件 mesh-72｜來源 mesh｜寄件者 cain（verified=true relay=direct）｜btcc_msg_id 72]\n下週五的值班表是誰？'
const JOEY_API = '〔車道資訊〕\n[車道事件 tg-9｜來源 Telegram｜Joey]\nJoey：mock-api 現在的 replicas 是幾個？'
const CATALOG = '{"services":["mock-api","mock-backup","mock-posts","tickets"],"note":"catalog"}'
const CONFIG = '{"log_level":"info","maintenance_window":"wed 02:00-03:00","replicas":2}'
const HEALTH = '{"status":"degraded","p95_ms":2600,"error_rate":0.08}'
const SVC = `#!/bin/sh\nif [ "$#" -eq 0 ]; then echo '${CATALOG}'; exit 0; fi\ncase "$1 $2" in\n  "GET mock-api/config") echo '${CONFIG}' ;;\n  "GET mock-api/health") echo '${HEALTH}' ;;\n  *) echo '{}' ;;\nesac\n`

function setup(transcript: string, svc: string | null = SVC) {
  const d = mkdtempSync(join(tmpdir(), 'stop-h4-')); const ld = join(d, '.lanes'); mkdirSync(join(ld, 'run'), { recursive: true }); mkdirSync(join(d, 'bin'))
  writeFileSync(join(d, 't.jsonl'), transcript)
  if (svc !== null) { writeFileSync(join(d, 'bin', 'svc'), svc); chmodSync(join(d, 'bin', 'svc'), 0o755) }
  return { d, ld }
}
async function hook(s: { d: string; ld: string }) {
  const p = Bun.spawn(['python3', HOOK], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LANES_DIR: s.ld, LANE_ID: 'adam.reflex.4' } })
  p.stdin.write(JSON.stringify({ transcript_path: join(s.d, 't.jsonl'), session_id: 's1', cwd: s.d })); p.stdin.end()
  const out = (await new Response(p.stdout).text()).trim(); await p.exited
  return out ? JSON.parse(out) : null
}
const UNSURE = '我無法確認 log_level 現在是不是 debug：只能看 runbook，沒有查現況。'

test('H4: a run a peer started, ended with a reply_agent that declines and no svc call: held once, with GET mock-api/config and GET mock-api/health attached', async () => {
  const s = setup(prompt(PEER_API) + bash('grep -rn log_level docs/ | head') + replyTo('eve', UNSURE) + notify('已回覆 eve 的問題。'))
  const r = await hook(s)
  expect(r.decision).toBe('block')
  expect(r.reason).toContain('adam.reflex.4'); expect(r.reason).toContain('started by eve'); expect(r.reason).toContain('cannot (無法)'); expect(r.reason).toContain('with reply_agent'); expect(r.reason).toContain('program output')
  expect(r.reason).toContain('./bin/svc GET mock-api/config:\n' + CONFIG); expect(r.reason).toContain('./bin/svc GET mock-api/health:\n' + HEALTH)
  expect(r.reason).not.toContain('"note":"catalog"')                                    // a mock-api subject: the two GETs, not the catalog
  expect(r.reason).not.toMatch(/請你|you should|please/i)                                // facts and output only
  expect(await hook(s)).toBeNull()                                                       // once per run
})

test('H4: the subject is not known: the catalog is attached instead', async () => {
  const r = await hook(setup(prompt(PEER_OTHER) + replyTo('cain', '我沒辦法查到值班表。') + notify('回覆了 cain')))
  expect(r.decision).toBe('block'); expect(r.reason).toContain('started by cain'); expect(r.reason).toContain('./bin/svc:\n' + CATALOG)
  expect(r.reason).not.toContain(CONFIG)
})

test('H4: ask_joey and notify_joey declines: in a peer run and in a Joey run; the E3 case (a Joey run, notify_joey) still gets the catalog', async () => {
  const a = await hook(setup(prompt(PEER_API) + ask(UNSURE)))
  expect(a.decision).toBe('block'); expect(a.reason).toContain('with ask_joey'); expect(a.reason).toContain(CONFIG)
  const b = await hook(setup(prompt(JOEY_API) + ask('replicas 的數字我 cannot 確認，要你決定。')))
  expect(b.decision).toBe('block'); expect(b.reason).toContain('started by Joey'); expect(b.reason).toContain('with ask_joey'); expect(b.reason).toContain(CONFIG); expect(b.reason).toContain(HEALTH)
  const c = await hook(setup(prompt(JOEY_API) + notify('replicas 我無法確認。')))                // E3: Joey run + notify_joey: the catalog, whatever the subject
  expect(c.decision).toBe('block'); expect(c.reason).toContain('./bin/svc:\n' + CATALOG); expect(c.reason).not.toContain(CONFIG)
  const d = await hook(setup(prompt(PEER_API) + notify('mock-api 的設定我 unable to read。')))
  expect(d.decision).toBe('block'); expect(d.reason).toContain('with notify_joey'); expect(d.reason).toContain(CONFIG)
})

test('H4: not held: a svc catalog or GET call in the run, no decline, an automated sender, a peer run with only a plain answer', async () => {
  expect(await hook(setup(prompt(PEER_API) + bash('./bin/svc GET mock-api/config') + replyTo('eve', UNSURE) + notify('回覆了 eve')))).toBeNull()
  expect(await hook(setup(prompt(PEER_API) + bash('./bin/svc') + ask(UNSURE)))).toBeNull()
  expect(await hook(setup(prompt(PEER_API) + replyTo('eve', 'log_level 現在是 info。') + notify('回覆了 eve：log_level 是 info。')))).toBeNull()
  for (const who of ['scheduler', 'alert-dispatcher', 'main'])
    expect(await hook(setup(prompt(`[車道事件 mesh-9｜來源 mesh｜寄件者 ${who}（verified=true）]\n查 mock-api config`) + replyTo('eve', UNSURE) + notify('x')))).toBeNull()
  expect((await hook(setup(prompt(PEER_API) + bash("./bin/svc POST tickets '{}'") + replyTo('eve', UNSURE) + notify('x')))).decision).toBe('block')   // a POST is not a look
})

test('H4: one hold per run across the paths; a failing GET attaches what works; nothing to attach = no hold; the never-silent rule is unchanged', async () => {
  const s = setup(prompt(PEER_API) + replyTo('eve', UNSURE) + notify('已回覆 eve') + ask('我 cannot 確認'))
  expect((await hook(s)).decision).toBe('block'); expect(await hook(s)).toBeNull()
  const half = await hook(setup(prompt(PEER_API) + ask(UNSURE), `#!/bin/sh\ncase "$1 $2" in\n  "GET mock-api/health") echo '${HEALTH}' ;;\n  *) exit 3 ;;\nesac\n`))
  expect(half.reason).toContain('./bin/svc GET mock-api/health:'); expect(half.reason).not.toContain('./bin/svc GET mock-api/config:')
  const catalogOnly = await hook(setup(prompt(PEER_API) + ask(UNSURE), `#!/bin/sh\nif [ "$#" -eq 0 ]; then echo '${CATALOG}'; else exit 3; fi\n`))
  expect(catalogOnly.reason).toContain('./bin/svc:\n' + CATALOG)                          // both GETs failed: the catalog
  expect(await hook(setup(prompt(PEER_API) + ask(UNSURE), null))).toBeNull()              // no ./bin/svc at all: nothing to attach, no hold
  expect((await hook(setup(prompt(PEER_API) + bash('ls')))).reason).toContain('has not left Joey a line yet')
})
