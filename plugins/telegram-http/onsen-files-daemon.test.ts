// WO-190 end to end: real Telegram daemons (server.ts, lanes off) against their own Bot API stand-ins and one stand-in Onsen (a local HTTP server; nothing
// reaches core.kbro.ai or Telegram), in temp dirs (their HOME too).
//   on  (ONSEN_FILES = adam): a photo from Joey → POST /v1/files with the inbox copy's bytes (Telegram asked once), the `in` record carries its id; a
//       document → the daemon fetches it from Telegram once, uploads it, the agent gets only attachment_file_id (nothing in its inbox); a voice note → the
//       audio uploaded, the transcript stays the text; an album → each photo's record its own file; the reply tool with an image and a .md → Telegram
//       got both, two uploads (the originals), the out records carry their ids; Onsen's /v1/files answering 500 → Telegram unchanged, one log line,
//       no ids
//   off (no switch): the same messages and reply: no /v1/files, no fetch of a document, the records as before
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, freePort, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const CRED_ON = 'mesh_FILESonSECRETsecretSECRETsecret0001', CRED_OFF = 'mesh_FILESoffSECRETsecretSECRETsecret001'
type Who = 'on' | 'off'
type Got = { who: Who; method: string; path: string; body: any; headers: Record<string, string>; raw?: Uint8Array }
const got: Got[] = []
const stored = new Map<string, { id: string; bytes: Uint8Array; name: string | null; type: string }>()   // `${who}:${Idempotency-Key}`
const st = { files500: false }
let apiOn: BotApiMock, apiOff: BotApiMock, on: TgDaemon, off: TgDaemon, onsenPort: number, root: string
let up: ReturnType<typeof Bun.serve> | null = null
let next = 1
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function startOnsen(): void {
  up = Bun.serve({ port: onsenPort, hostname: '127.0.0.1', idleTimeout: 60, async fetch(req) {
    const u = new URL(req.url), path = u.pathname.replace(/^\/api\/onsen/, '')
    const auth = req.headers.get('authorization')
    const who: Who | null = auth === `Bearer ${CRED_ON}` ? 'on' : auth === `Bearer ${CRED_OFF}` ? 'off' : null
    if (!who) return Response.json({ error: 'auth' }, { status: 401 })
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => { headers[k] = v })
    if (path === '/v1/files' && req.method === 'POST') {
      const raw = new Uint8Array(await req.arrayBuffer())
      got.push({ who, method: 'POST', path, body: null, headers, raw })
      if (st.files500) return Response.json({ error: { code: 'internal_error', message: 'R2 down' } }, { status: 500 })
      const key = `${who}:${headers['idempotency-key']}`
      const had = stored.get(key) ?? { id: String(900 + next++), bytes: raw, name: headers['x-file-name'] ? decodeURIComponent(headers['x-file-name']) : null, type: headers['content-type'] ?? '' }
      stored.set(key, had)
      return Response.json({ api_version: 1, viewer: 'adam', data: { id: had.id, name: had.name, mime: had.type, bytes: raw.length, url: `http://127.0.0.1:${onsenPort}/api/onsen/v1/files/${had.id}` } }, { status: 201 })
    }
    const body = req.method === 'POST' ? await req.json().catch(() => null) : undefined
    got.push({ who, method: req.method, path, body, headers })
    if (path === '/messages/batch' || path === '/deliveries/batch' || path === '/status/batch') return Response.json({ results: body.items.map(() => ({ id: next++, duplicate: false })) })
    if (path === '/events') return Response.json({ id: next++, duplicate: false })
    return Response.json({ error: 'no route' }, { status: 404 })
  } })
}
const msgs = (who: Who) => got.filter(g => g.who === who && g.path === '/messages/batch').flatMap(g => g.body.items)
const rec = (who: Who, dir: 'in' | 'out', id: number | string) => msgs(who).find((m: any) => m.direction === dir && m.client_msg_id === String(id))
const uploads = (who: Who) => got.filter(g => g.who === who && g.path === '/v1/files')
const file = (who: Who, key: string) => stored.get(`${who}:${key}`)

async function connect(d: TgDaemon, inbound: Array<{ content: string; meta: any }>): Promise<Client> {
  const c = new Client({ name: 'onsen-files-test', version: '0' }, { capabilities: {} })
  c.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') inbound.push({ content: String((n.params as any)?.content ?? ''), meta: (n.params as any)?.meta ?? {} }) }
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${d.port}/mcp`)))
  return c
}
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const r: any = await c.callTool({ name, arguments: args })
  return { text: String(r.content?.[0]?.text ?? ''), isError: r.isError === true }
}
const base = (id: number) => ({ message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: JOEY, type: 'private', first_name: 'J' }, from: { id: JOEY, is_bot: false, first_name: 'J', username: 'joey' } })
const JPEG = (n: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, n, n, 0xff, 0xd9])
const PDF = new TextEncoder().encode('%PDF-1.4 報告\n%%EOF')
const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 4, 6])
/** Joey's photo `id` (its file behind photo-<id>), in `api`'s file store */
function photo(api: BotApiMock, id: number, o: Record<string, unknown> = {}): Record<string, any> {
  api.files.set(`photo-${id}`, { path: `photos/file_${id}.jpg`, bytes: JPEG(id % 250) })
  return { message: { ...base(id), photo: [{ file_id: `thumb-${id}`, file_unique_id: `t${id}`, width: 90, height: 90 }, { file_id: `photo-${id}`, file_unique_id: `p${id}`, width: 800, height: 600, file_size: 9 }], ...o } }
}
function doc(api: BotApiMock, id: number): Record<string, any> {
  api.files.set(`doc-${id}`, { path: `documents/file_${id}.pdf`, bytes: PDF })
  return { message: { ...base(id), document: { file_id: `doc-${id}`, file_unique_id: `d${id}`, file_name: '報告.pdf', mime_type: 'application/pdf', file_size: PDF.length } } }
}
function voice(api: BotApiMock, id: number): Record<string, any> {
  api.files.set(`voice-${id}`, { path: `voice/file_${id}.oga`, bytes: OGG })
  return { message: { ...base(id), voice: { file_id: `voice-${id}`, file_unique_id: `v${id}`, duration: 2, mime_type: 'audio/ogg', file_size: OGG.length } } }
}

beforeAll(async () => {
  apiOn = startBotApiMock({}, { pollHoldMs: 300 }); apiOff = startBotApiMock({}, { pollHoldMs: 300 })
  onsenPort = await freePort()
  startOnsen()
  root = mkdtempSync(join(tmpdir(), 'onsen-files-daemon-'))
  mkdirSync(join(root, 'cred'), { recursive: true })
  writeFileSync(join(root, 'cred', 'on'), CRED_ON + '\n'); writeFileSync(join(root, 'cred', 'off'), CRED_OFF + '\n')
  // a stand-in transcriber (CHANNEL_BOT_TRANSCRIBE_CMD): the voice note's text
  const tr = join(root, 'transcribe.sh')
  writeFileSync(tr, '#!/bin/sh\necho "這是語音的逐字稿"\n'); chmodSync(tr, 0o755)
  const env = { ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, GENESIS_LANES: '0', ONSEN_PEER_LOOKUP: '0', ONSEN_CLAUDE_BIN: '/nonexistent/claude',
    CHANNEL_BOT_VOICE_TRANSCRIBE: '1', CHANNEL_BOT_TRANSCRIBE_CMD: tr }
  on = await startTgDaemon(apiOn, join(root, 'on'), JOEY, { ...env, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'on'), ONSEN_FILES: 'someone-else, adam' })
  off = await startTgDaemon(apiOff, join(root, 'off'), JOEY, { ...env, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'off') })
}, 90000)
afterAll(async () => { await on?.stop(); await off?.stop(); apiOn?.stop(); apiOff?.stop(); up?.stop(true) })

test('on: Joey\'s photo, document, voice note and album go into Onsen; the agent gets what it got before', async () => {
  const inbound: Array<{ content: string; meta: any }> = []
  const c = await connect(on, inbound)
  // a photo: the inbox copy the agent reads is the one uploaded; Telegram is asked for it once
  apiOn.push(photo(apiOn, 8101, { caption: '看這張' }))
  expect(await until(() => !!rec('on', 'in', 8101), 10000)).toBe(true)
  const r1 = rec('on', 'in', 8101)
  const f1 = file('on', 'tg:adam:1828:in:8101')!
  expect(f1.bytes).toEqual(JPEG(8101 % 250))
  expect(r1.attachment_file_ids).toEqual([f1.id])
  expect(r1.attachments).toEqual([{ mime: 'image/jpeg', size: 9, file_id: 'photo-8101' }])      // the Telegram file_id stays (client_ref)
  expect(r1.body).toBe('看這張')
  expect(await until(() => inbound.some(x => x.meta.message_id === '8101'), 10000)).toBe(true)
  const m1 = inbound.find(x => x.meta.message_id === '8101')!
  expect(new Uint8Array(readFileSync(m1.meta.image_path))).toEqual(f1.bytes)
  expect(apiOn.downloads.filter(p => p === 'photos/file_8101.jpg').length).toBe(1)
  expect(uploads('on')[0]!.headers['content-type']).toBe('application/octet-stream')            // an image's type is Onsen's to read from the bytes
  // a document: fetched from Telegram once by the daemon, only for Onsen; the agent gets attachment_file_id as before, nothing in its inbox
  const inboxBefore = existsSync(join(on.stateDir, 'inbox')) ? readdirSync(join(on.stateDir, 'inbox')).length : 0
  apiOn.push(doc(apiOn, 8102))
  expect(await until(() => !!rec('on', 'in', 8102), 10000)).toBe(true)
  const f2 = file('on', 'tg:adam:1828:in:8102')!
  expect(new TextDecoder().decode(f2.bytes)).toBe(new TextDecoder().decode(PDF))
  expect([f2.name, f2.type]).toEqual(['報告.pdf', 'application/pdf'])
  expect(rec('on', 'in', 8102).attachment_file_ids).toEqual([f2.id])
  expect(apiOn.of('getFile').filter(x => x.body.file_id === 'doc-8102').length).toBe(1)
  expect(apiOn.downloads.filter(p => p === 'documents/file_8102.pdf').length).toBe(1)
  expect(await until(() => inbound.some(x => x.meta.message_id === '8102'), 10000)).toBe(true)
  const m2 = inbound.find(x => x.meta.message_id === '8102')!
  expect(m2.meta).toMatchObject({ attachment_kind: 'document', attachment_file_id: 'doc-8102', attachment_name: '報告.pdf' })
  expect(m2.meta.image_path).toBeUndefined()
  expect(m2.content).toBe('(document: 報告.pdf)')
  expect(existsSync(join(on.stateDir, 'inbox')) ? readdirSync(join(on.stateDir, 'inbox')).length : 0).toBe(inboxBefore)
  // a voice note: the audio goes in, the transcript stays the text (the record's body, the agent's voice_transcript)
  apiOn.push(voice(apiOn, 8103))
  expect(await until(() => !!rec('on', 'in', 8103), 15000)).toBe(true)
  const r3 = rec('on', 'in', 8103), f3 = file('on', 'tg:adam:1828:in:8103')!
  expect(r3.body).toBe('這是語音的逐字稿')
  expect(r3.kind).toBe('voice')
  expect(f3.bytes).toEqual(OGG)
  expect(r3.attachment_file_ids).toEqual([f3.id])
  expect(await until(() => inbound.some(x => x.meta.message_id === '8103'), 10000)).toBe(true)
  expect(inbound.find(x => x.meta.message_id === '8103')!.meta.voice_transcript).toBe('這是語音的逐字稿')
  // an album: one delivery for the agent, each photo's record its own file
  apiOn.push(photo(apiOn, 8104, { media_group_id: 'alb1' })); apiOn.push(photo(apiOn, 8105, { media_group_id: 'alb1' }))
  expect(await until(() => !!rec('on', 'in', 8104) && !!rec('on', 'in', 8105), 10000)).toBe(true)
  const a1 = file('on', 'tg:adam:1828:in:8104')!, a2 = file('on', 'tg:adam:1828:in:8105')!
  expect(a1.id).not.toBe(a2.id)
  expect(rec('on', 'in', 8104).attachment_file_ids).toEqual([a1.id])
  expect(rec('on', 'in', 8105).attachment_file_ids).toEqual([a2.id])
  expect([a1.bytes, a2.bytes]).toEqual([JPEG(8104 % 250), JPEG(8105 % 250)])
  expect(await until(() => inbound.some(x => x.meta.media_group_count === '2'), 10000)).toBe(true)
  expect(on.log()).not.toContain(apiOn.token)
  await c.close()
}, 60000)

test('on: the reply tool\'s image and .md go to Telegram as before and into Onsen; the out records carry their ids', async () => {
  const c = await connect(on, [])
  const dir = join(root, 'reply-files'); mkdirSync(dir, { recursive: true })
  const png = join(dir, 'chart.png'), md = join(dir, 'notes.md')
  const PNGB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7])
  writeFileSync(png, PNGB); writeFileSync(md, '# 筆記\n第二行\n')
  const before = uploads('on').length
  const r = await call(c, 'reply', { chat_id: String(JOEY), text: '附上圖和筆記', files: [png, md] })
  expect(r.isError).toBe(false)
  const ids = [...r.text.matchAll(/\d+/g)].map(x => x[0])
  const photoCall = apiOn.of('sendPhoto').at(-1)!, docCall = apiOn.of('sendDocument').at(-1)!
  expect([photoCall.body.photo, docCall.body.document].map(x => String(x).slice(0, 9))).toEqual(['attach://', 'attach://'])   // Telegram got both files, as before
  expect(await until(() => uploads('on').length >= before + 2, 10000)).toBe(true)
  expect(await until(() => msgs('on').filter((m: any) => m.direction === 'out' && m.attachment_file_ids).length >= 2, 10000)).toBe(true)
  const outs = msgs('on').filter((m: any) => m.direction === 'out' && (m.kind === 'photo' || m.kind === 'document'))
  expect(outs.length).toBe(2)
  for (const m of outs) {
    const f = file('on', m.idem_key)!
    expect(m.attachment_file_ids).toEqual([f.id])
    expect(ids).toContain(m.client_msg_id)
    expect(m.sender).toBe('main')
  }
  const fp = file('on', outs.find((m: any) => m.kind === 'photo').idem_key)!, fd = file('on', outs.find((m: any) => m.kind === 'document').idem_key)!
  expect(fp.bytes).toEqual(PNGB)
  expect(new TextDecoder().decode(fd.bytes)).toBe('# 筆記\n第二行\n')
  expect([fp.name, fd.name, fd.type]).toEqual(['chart.png', 'notes.md', 'text/markdown'])
  // the text part of the reply carries no file
  expect(msgs('on').find((m: any) => m.direction === 'out' && m.body === '附上圖和筆記').attachment_file_ids).toBeUndefined()
  await c.close()
}, 30000)

test('on: Onsen\'s /v1/files answers 500: Telegram as before, the record without ids, one log line each', async () => {
  st.files500 = true
  try {
    const inbound: Array<{ content: string; meta: any }> = []
    const c = await connect(on, inbound)
    const n = uploads('on').length
    apiOn.push(doc(apiOn, 8106))
    expect(await until(() => !!rec('on', 'in', 8106), 10000)).toBe(true)
    expect(rec('on', 'in', 8106).attachment_file_ids).toBeUndefined()
    expect(rec('on', 'in', 8106).attachments).toEqual([{ name: '報告.pdf', mime: 'application/pdf', size: PDF.length, file_id: 'doc-8106' }])
    expect(uploads('on').length).toBe(n + 1)
    expect(await until(() => inbound.some(x => x.meta.message_id === '8106'), 10000)).toBe(true)
    const p = join(root, 'reply-files', 'late.md'); writeFileSync(p, 'x')
    const sentBefore = apiOn.of('sendDocument').length
    const r = await call(c, 'reply', { chat_id: String(JOEY), text: '一個檔', files: [p] })
    expect(r.isError).toBe(false)
    expect(apiOn.of('sendDocument').length).toBe(sentBefore + 1)
    const lastId = [...r.text.matchAll(/\d+/g)].map(x => x[0]).at(-1)!
    expect(await until(() => uploads('on').length === n + 2, 10000)).toBe(true)
    expect(await until(() => !!rec('on', 'out', lastId), 10000)).toBe(true)
    const lastOut = rec('on', 'out', lastId)
    expect(lastOut.kind).toBe('document')
    expect(lastOut.status).toBe('ok')
    expect(lastOut.attachment_file_ids).toBeUndefined()
    const lines = on.log().split('\n').filter(l => l.includes('not stored in Onsen'))
    expect(lines.length).toBe(2)
    expect(lines[0]).toContain('tg:adam:1828:in:8106 (document 報告.pdf) not stored in Onsen: POST /v1/files answered HTTP 500 (R2 down)')
    expect(lines[1]).toContain(`${lastOut.idem_key} (document`)
    await c.close()
  } finally { st.files500 = false }
}, 30000)

test('off (no ONSEN_FILES): the same photo, document and reply: no /v1/files, no fetch of the document, the records as before', async () => {
  const inbound: Array<{ content: string; meta: any }> = []
  const c = await connect(off, inbound)
  apiOff.push(photo(apiOff, 8201)); apiOff.push(doc(apiOff, 8202))
  expect(await until(() => !!rec('off', 'in', 8201) && !!rec('off', 'in', 8202), 10000)).toBe(true)
  expect(await until(() => inbound.some(x => x.meta.message_id === '8202'), 10000)).toBe(true)
  const p = join(root, 'reply-files', 'off.md'); mkdirSync(join(root, 'reply-files'), { recursive: true }); writeFileSync(p, 'x')
  expect((await call(c, 'reply', { chat_id: String(JOEY), text: 'off', files: [p] })).isError).toBe(false)
  expect(await until(() => msgs('off').some((m: any) => m.direction === 'out' && m.kind === 'document'), 10000)).toBe(true)
  await sleep(1000)
  expect(uploads('off').length).toBe(0)
  expect(msgs('off').filter((m: any) => m.attachment_file_ids).length).toBe(0)
  expect(apiOff.of('getFile').filter(x => x.body.file_id === 'doc-8202').length).toBe(0)
  expect(apiOff.downloads.filter(x => x.startsWith('documents/')).length).toBe(0)
  expect(apiOff.downloads.filter(x => x === 'photos/file_8201.jpg').length).toBe(1)        // the agent's copy, as before
  expect(off.log()).not.toContain('onsen: files:')
  await c.close()
}, 30000)
