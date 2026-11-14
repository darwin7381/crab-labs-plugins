// Universe 002k (E3): the lane stop hook holds a Joey-class run once when it ends with a notify_joey that declines and the run never looked at
// the service catalog; the output of ./bin/svc is attached as program output. The hook is run as Claude Code runs it. No network, no model.
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const HOOK = join(import.meta.dir, 'lanes-hooks', 'lane-stop-hook.py')
const rec = (o: object) => JSON.stringify(o) + '\n'
const JOEY = '〔車道資訊｜系統寫的〕\n[車道事件 tg-1｜來源 Telegram｜Joey]\nJoey：mock-api 昨天 14:00 到 15:00 之間有哪些請求 id 回了 5xx？給我 id。'
const PEER = '[車道事件 mesh-9｜來源 mesh｜寄件者 eve（verified=true）]\n請問維護時段？'
const prompt = (t: string) => rec({ type: 'user', message: { role: 'user', content: t } })
const tool = (name: string, input: object) => rec({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })
const bash = (command: string) => tool('Bash', { command })
const notify = (text: string) => tool('mcp__lane__notify_joey', { text })
const CATALOG = '{"services":["mock-api","mock-backup","mock-posts","tickets"],"paths":["mock-api/health","mock-api/metrics","mock-api/requests?status=5xx&from=..&to=.."]}'

function setup(transcript: string, svc: string | null = `#!/bin/sh\necho '${CATALOG}'\n`) {
  const d = mkdtempSync(join(tmpdir(), 'stop-e3-')); const ld = join(d, '.lanes'); mkdirSync(join(ld, 'run'), { recursive: true }); mkdirSync(join(d, 'bin'))
  writeFileSync(join(d, 't.jsonl'), transcript)
  if (svc !== null) { writeFileSync(join(d, 'bin', 'svc'), svc); chmodSync(join(d, 'bin', 'svc'), 0o755) }
  return { d, ld }
}
async function hook(s: { d: string; ld: string }, sid = 's1') {
  const p = Bun.spawn(['python3', HOOK], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LANES_DIR: s.ld, LANE_ID: 'adam.worker.1' } })
  p.stdin.write(JSON.stringify({ transcript_path: join(s.d, 't.jsonl'), session_id: sid, cwd: s.d })); p.stdin.end()
  const out = (await new Response(p.stdout).text()).trim(); await p.exited
  return out ? JSON.parse(out) : null
}
const DECLINE = '我沒辦法提供請求 id：只查到 access log 的筆數，沒有每筆請求的 id。'

test('E3: a Joey-class run that ends with a decline and never looked at the catalog is held once; the reason carries the ./bin/svc output', async () => {
  const s = setup(prompt(JOEY) + bash('grep -rn "request_id" docs/ | head') + bash('ls logs/') + notify(DECLINE))
  const r = await hook(s)
  expect(r.decision).toBe('block')
  expect(r.reason).toContain('adam.worker.1'); expect(r.reason).toContain('沒辦法'); expect(r.reason).toContain('program output')
  expect(r.reason).toContain(CATALOG)                                                    // the catalog the wrapper prints, verbatim
  expect(r.reason).not.toMatch(/請你|you should|please/i)                                // no new instructions: a fact and the output
  expect(await hook(s)).toBeNull()                                                       // once: the second Stop of this run ends it
})

test('E3: each decline word; the last notify_joey of the run is the one that counts', async () => {
  for (const t of ['I can\'t give request ids from the logs.', 'I cannot list them.', 'Unable to find ids in what I have.', '我無法取得請求 id。']) {
    expect((await hook(setup(prompt(JOEY) + notify(t)))).decision).toBe('block')
  }
  expect(await hook(setup(prompt(JOEY) + notify(DECLINE) + notify('找到了：req-9f2a、req-77c1。')))).toBeNull()   // it corrected itself: the last message does not decline
  expect(await hook(setup(prompt(JOEY) + notify('mock-api 昨天 14:00–15:00 有 3 筆 5xx，id：req-1、req-2、req-3。')))).toBeNull()
})

test('E3: a catalog call or a GET call in the run means it looked: no hold. A POST or another command does not count', async () => {
  for (const c of ['./bin/svc', './bin/svc GET', './bin/svc GET mock-api/health', 'cd /x && ./bin/svc get mock-api/requests', 'GENESIS_ACTOR=x ./bin/svc GET mock-backup/status | jq .', 'bin/svc GET tickets']) {
    expect(await hook(setup(prompt(JOEY) + bash(c) + notify(DECLINE)))).toBeNull()
  }
  for (const c of ["./bin/svc POST tickets '{\"title\":\"x\"}'", 'cat bin/svc', 'ls bin/']) {
    expect((await hook(setup(prompt(JOEY) + bash(c) + notify(DECLINE)))).decision).toBe('block')
  }
})

test('E3: a run started by the scheduler or an alert is not covered; a message that does not decline is not held (peer runs and ask_joey / reply_agent are H4: lanes-h4.test.ts)', async () => {
  const SCHED = '[車道事件 mesh-3｜來源 mesh｜寄件者 scheduler（verified=true）]\n[scheduled][hourly-backup-check][run:47][normal][ops] 查備份'
  const ALERT = '[車道事件 mesh-4｜來源 mesh｜寄件者 alert-dispatcher（verified=true）]\n[P2][warning] mock-api p95 > 2s'
  expect(await hook(setup(prompt(SCHED) + notify(DECLINE)))).toBeNull()
  expect(await hook(setup(prompt(ALERT) + notify(DECLINE)))).toBeNull()
  expect(await hook(setup(prompt(JOEY) + notify('收到，我會查。')))).toBeNull()
  expect(await hook(setup(prompt(PEER) + notify('收到，維護時段是每週三 02:00–03:00。')))).toBeNull()
})

test('E3: no catalog to attach (./bin/svc missing, failing or silent) = no hold; a hold needs its own state to be remembered', async () => {
  expect(await hook(setup(prompt(JOEY) + notify(DECLINE), null))).toBeNull()
  expect(await hook(setup(prompt(JOEY) + notify(DECLINE), '#!/bin/sh\nexit 3\n'))).toBeNull()
  expect(await hook(setup(prompt(JOEY) + notify(DECLINE), '#!/bin/sh\n:\n'))).toBeNull()
})

test('E3: the existing never-silent rule is unchanged; the hold is per run (a new prompt is a new run)', async () => {
  const quiet = setup(prompt(JOEY) + bash('ls'))
  expect((await hook(quiet)).reason).toContain('has not left Joey a line yet')           // no notify at all: the old block
  const s = setup(prompt(JOEY) + notify(DECLINE))
  expect((await hook(s)).decision).toBe('block'); expect(await hook(s)).toBeNull()
  writeFileSync(join(s.d, 't.jsonl'), prompt(JOEY) + notify(DECLINE) + prompt(JOEY.replace('tg-1', 'tg-2')) + notify(DECLINE))
  expect((await hook(s)).decision).toBe('block')                                         // the next Joey message: held once again
  expect(existsSync(join(s.ld, 'run', 'stop-blocks.json'))).toBe(true)
})
