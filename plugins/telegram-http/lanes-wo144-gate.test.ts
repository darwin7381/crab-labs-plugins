// WO-144 point 8 (telegram-http 1.46.0): the program gate behind the boundary card's 但書 (Joey TG chiron:2263: 「主線正在回合中而且在處理同一件事（看上面
// 「此刻」），交給主線，不跟它同時動手」). Lab acceptance row 8 (wo144-lab RESULTS.md; lab-relay.mail.6 / mail.7): the main was in a turn on Joey's 「週報那件事你
// 來處理」, the lane's 此刻 line and conversation block said so, and both times the mail lane checked the 週報 mail off itself and told Joey. Now an action on the
// matter (mailbox_check, mailbox_reply, reply_agent) is not done while the main is in a turn (the 此刻 line's source) on the same matter (Jev, one Noul per run
// and subject; the subject of a mail-lane action is the mail as the lane saw it). The main is a stand-in process driven through its hook events; Jev is a local
// stand-in that answers 「same matter」 when the event is about the 週報 (the lab's matter); the mailbox is a stand-in with the lab's two mails.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
process.env.LANES_FLOOD_CONTROL = '0'

// ------------------------------------------------------------------ Jev stand-in: same_matter = 0.9 when the event is about the 週報, else 0.1; 'error' = HTTP 500
let jevMode: 'weekly' | 'error' = 'weekly'
const sameCalls: any[] = []
const jev = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const body = await req.json() as any
  const keys = Object.keys(body.questions ?? {})
  if (keys.includes('same_matter')) {
    sameCalls.push(body)
    if (jevMode === 'error') return new Response('upstream error', { status: 500 })
    return Response.json({ model: 'jev-1.14.0', answers: { same_matter: { type: 'noul', noul: JSON.stringify(body.state?.event ?? '').includes('週報') ? 0.9 : 0.1 } } })
  }
  const answers: Record<string, unknown> = {}
  for (const k of keys) answers[k] = { type: 'noul', noul: 0.03 }                // the peer-disclosure check, the promise check: nothing found
  return Response.json({ model: 'jev-1.14.0', answers })
} })
process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${jev.port}`; process.env.TYPESAFE_API_KEY = 'k'

const L = await import('./lanes.ts?wo144gate') as typeof import('./lanes.ts')
const B = await import('./lanes-boundary.ts')
const ws = mkdtempSync(join(tmpdir(), 'lanes-wo144g-ws-'))
const dir = join(ws, '.lanes'); mkdirSync(dir)
const tmp = mkdtempSync(join(tmpdir(), 'lanes-wo144g-'))
mkdirSync(join(tmp, 'tr'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
// the lane process: a stand-in that waits until the test says END
const bin = join(tmp, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, time
lid = os.environ.get('LANE_ID', 'x')
end = os.path.join('${tmp}', 'end-' + lid)
t0 = time.time()
while time.time() - t0 < 60 and not os.path.exists(end): time.sleep(0.02)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restoreBin = L.__setClaudeBin(bin)

// ------------------------------------------------------------------ the mailbox: the lab's two mails (fleet-mail.ts's list and open formats)
const LIST = '2 封未讀、0 封已讀還沒勾掉：\n'
  + '#90003｜lab-peer｜請決定：測試台要不要改成每天重開一次｜要你：回覆要不要每天 06:00Z 重開｜期限 11-26 12:00Z｜等了 3 分鐘｜未讀\n'
  + '#90006｜lab-peer｜週報 W48 補充：失敗那 2 趟的細節｜要你：看一下週報補充｜期限 —｜等了 0 分鐘｜未讀'
const OPEN: Record<number, string> = {
  90006: '#90006 來自 lab-peer｜週報 W48 補充：失敗那 2 趟的細節\n要你：看一下週報補充\n期限 —｜等了 0 分鐘｜車道讀過（寄件人看到的是車道讀過，不是主線已讀）\n\nlab-peer：補充週報 W48，失敗的 2 趟都是 Onsen 逾時（01:11Z、01:18Z），已自動重試成功。請看一下。',
  90003: '#90003 來自 lab-peer｜請決定：測試台要不要改成每天重開一次\n要你：回覆要不要每天 06:00Z 重開\n期限 11-26 12:00Z｜等了 3 分鐘｜車道讀過（寄件人看到的是車道讀過，不是主線已讀）\n\nlab-peer：測試台要不要改成每天 06:00Z 重開 daemon 和主線？',
}
const mailCalls: any[] = []
L.__setMailTool(async b => {
  mailCalls.push(b)
  if (b.name === 'mailbox_list') return { text: LIST, isError: false }
  if (b.name === 'mailbox_open') return { text: OPEN[Number(b.args.id)] ?? '沒有這封信', isError: !OPEN[Number(b.args.id)] }
  if (b.name === 'mailbox_check') return { text: `#${b.args.id} 勾掉了，不在清單上了。`, isError: false }
  if (b.name === 'mailbox_reply') return { text: `已回 #${b.args.id}`, isError: false, to: 'lab-peer' }
  return { text: 'ok', isError: false }
})
const meshed: any[] = []
L.__setMeshSend(async b => { meshed.push(b); return { msgId: 95000 + meshed.length, text: `sent to ${b.to}`, delivered: true } })
// the main's conversation with Joey, as chat_history answers it (the run's block is built from it once, before the run starts)
const CHAT = ['共 3 則，顯示 3 則',
  '11-25 01:48Z｜Joey｜#39230 tg:125｜測試台現在有信箱了，信由分身處理。我們講定：之後標題有『週報』的信一律勾掉，不用問我。',
  '11-25 01:53Z｜Joey｜#39241 tg:132｜週報那件事你來處理：先用 Bash（前台、不要背景）跑這一行 python3 -c "import time; time.sleep(100)" ，跑完再跟我說週報信你打算怎麼處理',
  '11-25 01:54Z｜main｜#39242 tg:133｜收到。先前台跑 100 秒，跑完再回你週報信的處理。'].join('\n')
let chatAsked = 0
const logs: string[] = []
const open = new Set<string>()
L.lanesInit({ role: 'tg', agent: 'lab-relay', workspaceDir: ws, transcriptDir: join(tmp, 'tr'), httpPort: 0, log: (lvl: string, m: string) => { logs.push(`${lvl} ${m}`) },
  authOk: () => true, registryNames: () => ['lab-peer', 'eve'], notifySession: async (sid: string) => open.has(sid), streamOpen: (sid: string) => open.has(sid), toolsChanged: () => {},
  sendBot: async () => 700, joeyChatId: () => '1', mainChat: async () => { chatAsked++; return CHAT } } as any)
const procs: any[] = []
const ENVS = ['LANES_FLOOD_CONTROL', 'LANES_MAIN_SAME_MATTER', 'LANES_MAIN_CHAT', 'TYPESAFE_BASE_URL', 'TYPESAFE_API_KEY']
afterAll(() => {
  for (const id of Object.keys(L.__lanesState().lanes)) try { writeFileSync(join(tmp, `end-${id}`), 'END') } catch {}
  for (const p of procs) try { p.kill('SIGKILL') } catch {}
  jev.stop(true); L.__setClaudeBin(restoreBin); L.__setMailTool(null); L.__setMeshSend(null); for (const k of ENVS) delete process.env[k]
  rmSync(ws, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 10000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const jsonl = (p: string): any[] => { try { return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const M = () => L.__main(), st = () => L.__lanesState()
async function mainUp(): Promise<{ pid: number; hook: (event: string, o?: object) => Promise<any>; kill: () => Promise<void> }> {
  const p = Bun.spawn(['sleep', '600']); procs.push(p)
  const sid = randomUUID(); writeFileSync(join(dir, 'main-expected'), sid); open.add(`mcp-${p.pid}`); L.__noteMcpPid(`mcp-${p.pid}`, p.pid)
  const hook = (event: string, o: object = {}) => L.__mainEvent({ event, pid: p.pid, session_id: sid, ...o } as any)
  await hook('SessionStart', { source: 'startup' })
  return { pid: p.pid, hook, kill: async () => { await hook('SessionEnd'); p.kill('SIGKILL') } }
}
const JOEY_WEEKLY = '週報那件事你來處理：先用 Bash（前台、不要背景）跑這一行 python3 -c "import time; time.sleep(100)" ，跑完再跟我說週報信你打算怎麼處理'
/** a lane's run as the router leaves it (no process): its lane, its event in the queue, its token */
let n = 0
function fakeRun(kind: 'mail' | 'reflex' | 'worker', ev: Record<string, unknown>, extra: Record<string, unknown> = {}): any {
  n += 1
  const id = `lab-relay.${kind}.g${n}`, thread = `lab-relay#t-g${n}`
  st().lanes[id] = { id, kind, n, session_id: randomUUID(), thread, status: 'running', created: '', last: '', transcript: join(tmp, `g${n}.jsonl`), runs: 0, tokens_in: 0, tokens_out: 0 } as any
  st().threads[thread] = { id: thread, lane: id, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
  const e: any = { id: `mesh-wo144g-${n}`, source: 'mesh', from: 'mailbox', verified: false, text: '讀信箱（2 封未讀）：先用 mailbox_list 看清單', meta: {}, notif: { method: '', params: {} }, ...ev }
  L.__putQueue({ ev: e, lane: id, state: 'leased', lease_until: 0, attempts: 1, priority: 1, enqueued: '' })
  return { runId: `${id}.r1`, lane: id, evId: e.id, closers: [], critical: false, trigger: kind === 'mail' ? 'mail' : 'peer', cls: kind === 'mail' ? 'mail' : 'peer',
    chatLines: CHAT.split('\n').slice(1), ...extra }
}
const sent = (name: string) => mailCalls.filter(c => c.name === name)
let m: Awaited<ReturnType<typeof mainUp>>

test('the main idle: no Jev call, mailbox_check goes through', async () => {
  m = await mainUp()
  expect(L.mainNowLine()).toBe('主線：閒著'); expect(L.mainTurnNow()).toBeNull()
  const tok = fakeRun('mail', {})
  await L.callLaneTool(tok, 'mailbox_open', { id: 90006 })
  const k = sent('mailbox_check').length
  expect(await L.callLaneTool(tok, 'mailbox_check', { id: 90006 })).toBe('#90006 勾掉了，不在清單上了。')
  expect(sent('mailbox_check').length).toBe(k + 1)
  expect(sameCalls.length).toBe(0)
})

test('replay of lab row 8: the main in a turn on Joey\'s 週報 matter; the mail lane\'s mailbox_check / mailbox_reply / reply_agent on the 週報 mail are not done (one Jev call), the other mail goes through, handoff_main works', async () => {
  // the main takes Joey's 「週報那件事你來處理」 into a turn (the lab's tg:132)
  const item = M().enqueue('joey', { method: 'notifications/claude/channel', params: { content: JOEY_WEEKLY, meta: { chat_id: '1', user: 'joey' } } }, { event: null })
  await m.hook('UserPromptSubmit', { prompt_id: 'p-weekly', dids: [item] })
  expect(M().currentGen()!.state).toBe('in_turn')
  const now = L.mainTurnNow()!
  expect(now.doing).toContain('週報那件事你來處理')
  expect(L.mainNowLine()).toContain(`在處理：${now.doing}`)                       // the 此刻 line's own source
  // the 讀信箱 reminder starts the mail lane's run (its conversation block is fetched once, before it starts)
  const asked0 = chatAsked
  const d = await L.routeEvent({ id: 'mesh-wo144g-weekly', source: 'mesh', from: 'fleet-watchdog', verified: true, text: '讀信箱（1 封未讀，最舊的等了 0 分鐘）：先用 mailbox_list 看清單',
    meta: { no_reply: 'true' }, no_reply: true, wake: 'mail', line: 'mail', notif: { method: 'notifications/claude/channel', params: { content: '讀信箱', meta: {} } } } as any)
  expect(d).toMatchObject({ target: 'lane' })
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  const tok = L.__runTok(d.lane!)!
  expect(chatAsked).toBe(asked0 + 1)
  expect(tok.chatLines).toEqual(CHAT.split('\n').slice(1))                       // the block's message lines, as in the prompt
  const prompt = (jsonl(join(dir, 'lanes.jsonl')).filter(r => r.kind === 'spawn').at(-1))
  expect(prompt).toMatchObject({ lane: d.lane, main_chat: 'onsen', main_chat_n: 3 })
  // list, open: read only, never gated, no Jev call
  expect(await L.callLaneTool(tok, 'mailbox_list', {})).toBe(LIST)
  expect(await L.callLaneTool(tok, 'mailbox_open', { id: 90006 })).toBe(OPEN[90006])
  expect(sameCalls.length).toBe(0)
  // the 週報 mail: checking it off is not done
  const checks = sent('mailbox_check').length, replies = sent('mailbox_reply').length, mesh0 = meshed.length
  const refusal = B.mainSameMatterRefusal(now.doing)
  expect(now.doing.length).toBeLessThanOrEqual(80)                               // mainDoing's own cut (the 此刻 line's)
  expect(refusal).toBe(`沒有做：主線正在回合中處理同一件事（在處理：${now.doing}）。照邊界卡的但書，這件交給主線：用 handoff_main 交過去（寫你查到的、你本來要做什麼），不要自己動手。`)
  expect(await L.callLaneTool(tok, 'mailbox_check', { id: 90006 })).toBe(refusal)
  expect(sent('mailbox_check').length).toBe(checks)                               // nothing reached the mailbox
  expect(sameCalls.length).toBe(1)
  const q = sameCalls[0]
  expect(Object.keys(q.questions)).toEqual(['same_matter'])
  expect(q.state.main_doing).toBe(now.doing)
  expect(q.state.conversation).toEqual(CHAT.split('\n').slice(1))
  expect(q.state.event).toMatchObject({ id: 90006 }); expect(q.state.event.text).toContain('週報 W48 補充'); expect(q.state.event.text).toContain('Onsen 逾時')
  // a reply on it, and a reply_agent to its sender: refused too, the same verdict (one Jev call for the run's 週報 mail)
  expect(await L.callLaneTool(tok, 'mailbox_reply', { id: 90006, body: '收到，週報補充看過了。' })).toBe(refusal)
  expect(await L.callLaneTool(tok, 'reply_agent', { to: 'lab-peer', title: '週報 W48 補充收到', ask: '不用回', text: '補充看過了。' })).toBe(refusal)
  expect(sent('mailbox_reply').length).toBe(replies); expect(meshed.length).toBe(mesh0)
  expect(sameCalls.length).toBe(1)
  // the record: a ledger line and a lanes.jsonl row per refusal, the Jev call in run/jev-calls.jsonl
  const led = jsonl(join(dir, 'ledger.jsonl')).filter(r => r.refs?.main_same_matter === 'refused' && r.lane === d.lane)
  expect(led.map(r => r.refs.tool)).toEqual(['mailbox_check', 'mailbox_reply', 'reply_agent'])
  expect(led[0]).toMatchObject({ kind: 'action', event: tok.evId, refs: { subject: 'mail:90006', p: 0.9, prompt: 'p-weekly' } })
  expect(led[0].text).toStartWith('mailbox_check #90006 擋下：主線正在回合中處理同一件事（在處理：週報那件事你來處理')
  expect(jsonl(join(dir, 'lanes.jsonl')).filter(r => r.kind === 'main_same_matter_refused' && r.lane === d.lane).map(r => r.tool)).toEqual(['mailbox_check', 'mailbox_reply', 'reply_agent'])
  const jc = jsonl(join(dir, 'run', 'jev-calls.jsonl')).filter(r => r.site === 'main-same-matter-WO144')
  expect(jc.length).toBe(1); expect(jc[0]).toMatchObject({ p: 0.9, err: null, inputs: { lane: d.lane, tool: 'mailbox_check', subject: 'mail:90006', prompt: 'p-weekly', conversation: 3 } })
  // the other mail (the test bench's restart question): another matter, one more call, it goes through
  await L.callLaneTool(tok, 'mailbox_open', { id: 90003 })
  expect(await L.callLaneTool(tok, 'mailbox_check', { id: 90003 })).toBe('#90003 勾掉了，不在清單上了。')
  expect(sent('mailbox_check').length).toBe(checks + 1)
  expect(sameCalls.length).toBe(2); expect(sameCalls[1].state.event).toMatchObject({ id: 90003 })
  // handoff_main is not gated: the 週報 mail goes to the main
  expect(await L.callLaneTool(tok, 'handoff_main', { text: '#90006 lab-peer「週報 W48 補充」：失敗 2 趟都是 Onsen 逾時、已自動重試成功。本來要照講定勾掉；主線正在處理週報，交給你。' }))
    .toStartWith('handed to the main:')
  expect(sameCalls.length).toBe(2)
  writeFileSync(join(tmp, `end-${d.lane}`), 'END')
  expect(await until(() => !L.__runTok(d.lane!))).toBe(true)
}, 30000)

test('a reflex lane on a peer\'s call about the same matter: reply_agent is not done, twice, with one Jev call; nothing reaches the peer', async () => {
  expect(L.mainTurnNow()).not.toBeNull()
  const tok = fakeRun('reflex', { from: 'lab-peer', text: '週報 W48 你們那邊數字對了嗎？我要今天發。', line: 'call', btcc_msg_id: '11500' })
  const k = sameCalls.length, mesh0 = meshed.length
  const a = { to: 'lab-peer', text: '週報 W48 數字對了，可以發。' }
  expect(await L.callLaneTool(tok, 'reply_agent', a)).toBe(B.mainSameMatterRefusal(L.mainTurnNow()!.doing))
  expect(await L.callLaneTool(tok, 'reply_agent', a)).toBe(B.mainSameMatterRefusal(L.mainTurnNow()!.doing))
  expect(sameCalls.length).toBe(k + 1); expect(meshed.length).toBe(mesh0)
  expect(sameCalls.at(-1).state.event).toMatchObject({ from: 'lab-peer', text: '週報 W48 你們那邊數字對了嗎？我要今天發。' })
  // the same lane on another matter: it goes out
  const tok2 = fakeRun('reflex', { from: 'eve', text: 'mock-api 現在 p95 多少？', line: 'call', btcc_msg_id: '11501' })
  expect(await L.callLaneTool(tok2, 'reply_agent', { to: 'eve', text: 'mock-api p95 180ms。' })).toBe('sent to eve')
  expect(meshed.at(-1)).toMatchObject({ to: 'eve', line: 'call', reply_to: '11501' })
})

test('a failed Jev call lets the action through and is logged (run/jev-calls.jsonl, the daemon log); the failure is the run\'s verdict (no second call)', async () => {
  jevMode = 'error'
  try {
    const tok = fakeRun('mail', {})
    await L.callLaneTool(tok, 'mailbox_open', { id: 90006 })
    const k = sameCalls.length, checks = sent('mailbox_check').length
    expect(await L.callLaneTool(tok, 'mailbox_check', { id: 90006 })).toBe('#90006 勾掉了，不在清單上了。')
    expect(await L.callLaneTool(tok, 'mailbox_reply', { id: 90006, body: '看過了' })).toBe('已回 #90006')
    expect(sent('mailbox_check').length).toBe(checks + 1)
    expect(sameCalls.length).toBe(k + 1)
    const jc = jsonl(join(dir, 'run', 'jev-calls.jsonl')).filter(r => r.site === 'main-same-matter-WO144').at(-1)
    expect(jc).toMatchObject({ answer: null, p: null, inputs: { lane: tok.lane, subject: 'mail:90006' } }); expect(jc.err).toContain('HTTP 500')
    expect(logs.some(l => l.startsWith('warn') && l.includes(`main-same-matter check for ${tok.runId} (mail:90006) failed`) && l.includes('the action goes through'))).toBe(true)
  } finally { jevMode = 'weekly' }
})

test('the main\'s own runs are not gated: a decision coming back to the mail lane, a worker lane; no Jev call', async () => {
  const k = sameCalls.length
  const dec = fakeRun('mail', {}, { decision: { mail_id: 90006, decision: 'as_recommended', note: '' } })
  await L.callLaneTool(dec, 'mailbox_open', { id: 90006 })
  expect(await L.callLaneTool(dec, 'mailbox_check', { id: 90006 })).toBe('#90006 勾掉了，不在清單上了。')
  const w = fakeRun('worker', { from: 'lab-peer', text: '週報 W48 的數字要不要重算？', line: 'mail' })
  expect(await L.callLaneTool(w, 'reply_agent', { to: 'lab-peer', title: '週報 W48', ask: '照這個發', text: '週報 W48 不用重算。' })).toBe('sent to lab-peer')
  expect(sameCalls.length).toBe(k)
})

test('switches: LANES_MAIN_SAME_MATTER=0, or LANES_MAIN_CHAT=0: no gate, no Jev call', async () => {
  for (const env of ['LANES_MAIN_SAME_MATTER', 'LANES_MAIN_CHAT']) {
    process.env[env] = '0'
    try {
      expect(B.mainSameMatterOn()).toBe(false)
      const tok = fakeRun('mail', {})
      await L.callLaneTool(tok, 'mailbox_open', { id: 90006 })
      const k = sameCalls.length
      expect(await L.callLaneTool(tok, 'mailbox_check', { id: 90006 })).toBe('#90006 勾掉了，不在清單上了。')
      expect(sameCalls.length).toBe(k)
    } finally { delete process.env[env] }
  }
  expect(B.mainSameMatterOn()).toBe(true)
  // threshold: LANES_MAIN_SAME_MATTER_P above the stand-in's 0.9 lets the same matter through
  process.env.LANES_MAIN_SAME_MATTER_P = '0.95'
  try {
    const tok = fakeRun('mail', {})
    await L.callLaneTool(tok, 'mailbox_open', { id: 90006 })
    expect(await L.callLaneTool(tok, 'mailbox_check', { id: 90006 })).toBe('#90006 勾掉了，不在清單上了。')
  } finally { delete process.env.LANES_MAIN_SAME_MATTER_P }
})

test('the main gone: no gate, no Jev call', async () => {
  await m.kill()
  expect(L.mainTurnNow()).toBeNull()
  const tok = fakeRun('mail', {})
  await L.callLaneTool(tok, 'mailbox_open', { id: 90006 })
  const k = sameCalls.length
  expect(await L.callLaneTool(tok, 'mailbox_check', { id: 90006 })).toBe('#90006 勾掉了，不在清單上了。')
  expect(sameCalls.length).toBe(k)
})
