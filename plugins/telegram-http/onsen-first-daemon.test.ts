// WO-192 end to end (acceptance 1–5 and 7 of the ticket, lanes off): real Telegram daemons (server.ts) against their own Bot API stand-ins and one
// stand-in Onsen 0.31.0 (test-fixtures/onsen-standin.ts; nothing reaches core.kbro.ai or Telegram), in temp dirs (their HOME too).
//   on   (ONSEN_FIRST = adam, ONSEN_FILES = adam): 1 one sentence: the Onsen message is written before Telegram's, B gives it its Telegram id
//        (delivered), chat_history tg:<id> finds it, one Onsen message; 2 a long reply in two parts: one message, both ids lead to it; 3 two files:
//        one message carrying both files (uploaded before A), Telegram got three messages; 4 Telegram unreachable: 「已寫進 Onsen…會再送」 (not an
//        error), pending, then sent again → delivered; 5 Onsen 500: the tool fails 「Onsen 沒收下…」, nothing on Telegram
//   off  (no switch) and old (ONSEN_FIRST on, Onsen 0.30.2): the reply recorded after Telegram as before (/messages/batch with client_msg_id), no A, no B
//   7    the bench: the median of 10 reply calls, off vs on (stand-in Onsen answering at once, and after 80 ms), printed
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, freePort, type TgDaemon } from './test-fixtures/tg-daemon.ts'
import { startOnsenStandin, type OnsenStandin } from './test-fixtures/onsen-standin.ts'

const JOEY = 1828
const CRED = { on: 'mesh_FIRSTonSECRETsecretSECRETsecret0001', off: 'mesh_FIRSToffSECRETsecretSECRETsecret001', old: 'mesh_FIRSToldSECRETsecretSECRETsecret001' }
let apiOn: BotApiMock, apiOff: BotApiMock, apiOld: BotApiMock, on: TgDaemon, off: TgDaemon, old: TgDaemon, onsen: OnsenStandin, root: string
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const SENDS = new Set(['sendMessage', 'sendRichMessage', 'sendPhoto', 'sendDocument'])

beforeAll(async () => {
  apiOn = startBotApiMock({}, { pollHoldMs: 300 }); apiOff = startBotApiMock({}, { pollHoldMs: 300 }); apiOld = startBotApiMock({}, { pollHoldMs: 300 })
  onsen = startOnsenStandin({ [CRED.on]: 'on', [CRED.off]: 'off', [CRED.old]: 'old' }, await freePort())
  onsen.st.version.old = '0.30.2'
  root = mkdtempSync(join(tmpdir(), 'onsen-first-daemon-'))
  mkdirSync(join(root, 'cred'), { recursive: true })
  for (const [k, v] of Object.entries(CRED)) writeFileSync(join(root, 'cred', k), v + '\n')
  const env = { ONSEN_BASE: `http://127.0.0.1:${onsen.port}/api/onsen`, GENESIS_LANES: '0', ONSEN_PEER_LOOKUP: '0', ONSEN_CLAUDE_BIN: '/nonexistent/claude',
    ONSEN_FIRST_RETRY_MS: '100,100,100', ONSEN_FIRST_RESEND_MS: '500,500,500' }
  ;[on, off, old] = await Promise.all([
    startTgDaemon(apiOn, join(root, 'on'), JOEY, { ...env, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'on'), ONSEN_FIRST: 'someone-else, adam', ONSEN_FILES: 'adam' }),
    startTgDaemon(apiOff, join(root, 'off'), JOEY, { ...env, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'off') }),
    startTgDaemon(apiOld, join(root, 'old'), JOEY, { ...env, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'old'), ONSEN_FIRST: '*' }),
  ])
}, 90000)
afterAll(async () => { await Promise.all([on?.stop(), off?.stop(), old?.stop()]); apiOn?.stop(); apiOff?.stop(); apiOld?.stop(); onsen?.stop() })

const reply = (d: TgDaemon, text: string, o: Record<string, unknown> = {}) => d.call('reply', { chat_id: String(JOEY), text, ...o })
const written = (who: string, body: string) => onsen.writes(who).filter(m => m.item.body === body || String(m.item.body).includes(body))
const sendsOf = (api: BotApiMock, has: string) => api.calls.filter(c => SENDS.has(c.method) && JSON.stringify(c.body).includes(has))
const idOf = (text: string): number[] => (text.match(/\d+/g) ?? []).map(Number)
const delivered = (id: number) => onsen.msgs.find(m => m.id === id)?.delivery?.state === 'sent'

test('1 one sentence: Onsen first, then Telegram, then B; chat_history tg:<id> finds the same message; only one Onsen message', async () => {
  const text = '第一句：先寫進 Onsen'
  const r = await reply(on, text)
  expect(r.isError).toBe(false)
  expect(r.text).toMatch(/^sent \(id: \d+\)$/)                                       // the tool's answer as today
  const tg = idOf(r.text)[0]!
  const w = written('on', text)
  expect(w.length).toBe(1)                                                          // one Onsen message: the transformer recorded no copy
  expect(w[0]!.path).toBe('/messages')
  expect(w[0]!.item).toMatchObject({ idem_key: expect.stringMatching(/^tg:adam:1828:out:pre:[0-9a-f-]{36}$/), agent: 'adam', chat: '1828', direction: 'out',
    sender: 'main', body: text, kind: 'rich', status: 'ok', delivery: { client: 'telegram', state: 'pending' } })
  expect('client_msg_id' in w[0]!.item).toBe(false)
  const send = sendsOf(apiOn, text)
  expect(send.map(c => c.method)).toEqual(['sendRichMessage'])
  expect(w[0]!.at).toBeLessThanOrEqual(send[0]!.at)                                 // the Onsen message exists before Telegram is asked
  expect(await until(() => delivered(w[0]!.id), 5000)).toBe(true)
  const b = onsen.reports('on', w[0]!.id)
  expect(b.length).toBe(1)
  expect(b[0]!.body).toMatchObject({ client: 'telegram', state: 'sent', client_msg_ids: [String(tg)] })
  expect(Date.parse(b[0]!.body.at)).toBeGreaterThan(0)
  const h = await on.call('chat_history', { id: `tg:${tg}` })
  expect(h.text).toContain(`#${w[0]!.id}`)
  expect(h.text).toContain(text)
  expect(onsen.seen.filter(s => s.who === 'on' && s.path === '/messages/batch').flatMap(s => s.body.items).filter((i: any) => i.direction === 'out' && String(i.body).includes(text))).toEqual([])
}, 30000)

test('2 a long reply in two parts: one Onsen message (the whole text), both Telegram ids lead back to it', async () => {
  const p1 = `第一段 ${'甲'.repeat(3000)}`, p2 = `第二段 ${'乙'.repeat(3000)}`, text = `${p1}\n\n${p2}`
  const r = await reply(on, text)
  expect(r.text).toMatch(/^sent 2 parts \(ids: \d+, \d+\)$/)
  const [a, b] = idOf(r.text.replace(/^sent 2 parts/, ''))
  const w = onsen.writes('on').filter(m => String(m.item.body).includes('第一段'))
  expect(w.length).toBe(1)
  expect(w[0]!.item.body).toBe(text)
  expect(sendsOf(apiOn, '甲甲甲').length).toBe(1); expect(sendsOf(apiOn, '乙乙乙').length).toBe(1)
  expect(await until(() => delivered(w[0]!.id), 5000)).toBe(true)
  expect(onsen.reports('on', w[0]!.id)[0]!.body.client_msg_ids).toEqual([String(a), String(b)])
  for (const id of [a, b]) expect((await on.call('chat_history', { id: `tg:${id}` })).text).toContain(`#${w[0]!.id}`)
}, 30000)

test('3 a reply with two files: one Onsen message carrying both (stored before A), Telegram got three messages', async () => {
  const dir = join(root, 'files'); mkdirSync(dir, { recursive: true })
  const png = join(dir, 'chart.png'), md = join(dir, 'notes.md')
  writeFileSync(png, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])); writeFileSync(md, '# 筆記\n')
  const text = '附上兩個檔'
  const r = await reply(on, text, { files: [png, md] })
  expect(r.text).toMatch(/^sent 3 parts \(ids: \d+, \d+, \d+\)$/)
  const ids = idOf(r.text.replace(/^sent 3 parts/, ''))
  const w = written('on', text)
  expect(w.length).toBe(1)
  const idem = w[0]!.item.idem_key
  const f0 = onsen.files.get(`on:${idem}:0`)!, f1 = onsen.files.get(`on:${idem}:1`)!
  expect([!!f0, !!f1]).toEqual([true, true])
  expect(w[0]!.item.attachment_file_ids).toEqual([f0.id, f1.id])
  expect(w[0]!.item.attachments).toBeUndefined()                                    // each file once (as its Onsen file), not also as a name
  expect(Math.max(f0.at, f1.at)).toBeLessThanOrEqual(w[0]!.at)
  expect(new TextDecoder().decode(f1.bytes)).toBe('# 筆記\n')
  const tgCalls = apiOn.calls.filter(c => SENDS.has(c.method) && c.at >= w[0]!.at)
  expect(tgCalls.map(c => c.method)).toEqual(['sendRichMessage', 'sendPhoto', 'sendDocument'])
  expect(await until(() => delivered(w[0]!.id), 5000)).toBe(true)
  expect(onsen.reports('on', w[0]!.id)[0]!.body.client_msg_ids).toEqual(ids.map(String))
}, 30000)

test('4 Telegram unreachable: the tool says 已寫進 Onsen…會再送 (not an error), Onsen has it pending; Telegram back: sent again, delivered', async () => {
  const text = '第四句：Telegram 斷了'
  apiOn.fail.fn = m => SENDS.has(m); apiOn.fail.code = 502; apiOn.fail.desc = 'Bad Gateway'
  try {
    const r = await reply(on, text)
    expect(r.isError).toBe(false)
    expect(r.text.startsWith('已寫進 Onsen（網頁看得到）；Telegram 還沒送到：')).toBe(true)
    expect(r.text.endsWith('，會再送')).toBe(true)
    expect(r.text).toContain('502')
    const w = written('on', text)
    expect(w.length).toBe(1)
    expect(w[0]!.delivery).toEqual({ state: 'pending' })
    await sleep(200)
    expect(onsen.reports('on', w[0]!.id)).toEqual([])                              // nothing to report yet: once, at the end
  } finally { apiOn.fail.fn = null; apiOn.fail.code = undefined; apiOn.fail.desc = undefined }
  const w = written('on', text)[0]!
  expect(await until(() => delivered(w.id), 8000)).toBe(true)
  const ok = apiOn.calls.filter(c => c.method === 'sendRichMessage' && c.body.rich_message?.markdown === text)
  expect(ok.length).toBeGreaterThanOrEqual(2)                                       // the failed try and the resend
  const b = onsen.reports('on', w.id)
  expect(b.length).toBe(1)
  expect(b[0]!.body.state).toBe('sent')
  expect(written('on', text).length).toBe(1)
  expect(on.log()).toMatch(/onsen first: Onsen message \d+ .* sent again: Telegram has all 1 message/)
}, 30000)

test('5 Onsen answering 500: the tool fails 「Onsen 沒收下，這一則沒有送出」, after 4 tries; nothing on Telegram', async () => {
  const text = '第五句：Onsen 掛了'
  onsen.st.a500.on = true
  try {
    const r = await reply(on, text)
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Onsen 沒收下，這一則沒有送出')
    expect(onsen.seen.filter(s => s.who === 'on' && s.path === '/messages' && s.body?.body === text).length).toBe(4)
    expect(sendsOf(apiOn, text)).toEqual([])
  } finally { onsen.st.a500.on = false }
}, 30000)

test('off: no switch → recorded after Telegram as before (client_msg_id, /messages/batch); no A, no B', async () => {
  const text = '關著：照舊'
  const r = await reply(off, text)
  expect(r.text).toMatch(/^sent \(id: \d+\)$/)
  expect(await until(() => written('off', text).length === 1, 8000)).toBe(true)
  const w = written('off', text)[0]!
  expect(w.path).toBe('/messages/batch')
  expect(w.item.client_msg_id).toBe(String(idOf(r.text)[0]))
  expect(w.item.delivery).toBeUndefined()
  expect(onsen.reports('off')).toEqual([])
  expect(onsen.seen.some(s => s.who === 'off' && s.path === '/messages')).toBe(false)
  expect(onsen.seen.some(s => s.who === 'off' && s.path === '/v1/meta')).toBe(false)          // the switch off asks nothing new
}, 30000)

test('old Onsen (0.30.2) with the switch on: the path as before', async () => {
  const text = '舊的 Onsen：照舊'
  const r = await reply(old, text)
  expect(r.text).toMatch(/^sent \(id: \d+\)$/)
  expect(await until(() => written('old', text).length === 1, 8000)).toBe(true)
  expect(written('old', text)[0]!.path).toBe('/messages/batch')
  expect(onsen.seen.some(s => s.who === 'old' && s.path === '/v1/meta')).toBe(true)
  expect(onsen.seen.some(s => s.who === 'old' && s.path === '/messages')).toBe(false)
  expect(old.log()).toContain('older than 0.31.0')
}, 30000)

test('7 the bench: median of 10 reply calls, before (off) and after (on)', async () => {
  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2 }
  const bench = async (d: TgDaemon, tag: string): Promise<number> => {
    await reply(d, `${tag} warm-up`)
    const ms: number[] = []
    for (let i = 0; i < 10; i++) { const t0 = performance.now(); const r = await reply(d, `${tag} ${i}`); ms.push(performance.now() - t0); expect(r.isError).toBe(false) }
    return Math.round(median(ms) * 10) / 10
  }
  const before = await bench(off, 'bench-off')
  const after = await bench(on, 'bench-on')
  onsen.st.aDelayMs = 80
  const after80 = await bench(on, 'bench-on80')
  onsen.st.aDelayMs = 0
  console.log(`WO-192 bench (median of 10 reply tool calls, stand-in Bot API and Onsen on 127.0.0.1): before (ONSEN_FIRST off) ${before} ms; after ${after} ms; after with Onsen answering A in 80 ms ${after80} ms`)
  expect(after80).toBeGreaterThanOrEqual(80)                                        // A is on the path: Onsen's answer time is added once
  expect(after80).toBeLessThan(before + 80 + 250)
}, 60000)
