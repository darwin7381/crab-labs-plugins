// WO-190: the files of Telegram messages stored in Onsen itself, against a stand-in for Onsen (a fake fetch; nothing reaches core.kbro.ai or Telegram).
//   the switch (ONSEN_FILES), the upload (POST /v1/files: this agent's credential, Idempotency-Key, X-File-Name, the bytes, 25 MB, a failure → no id),
//   the record keeps its place and carries attachment_file_ids once stored (waiting for a running upload; late, lost with a restart, refused by Onsen →
//   without them, one log line), the sources (a local file, Telegram's 20 MB, the token never in a log line), storeFiles' order and keys.
import { test, expect, describe } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OnsenClient, inboundItem, outboundRecord, ONSEN_FILE_MAX, type OnsenItem } from './onsen-client.ts'
import { filesOn, wantsFiles, fileKey, mimeOf, localFile, telegramFile, storeFiles, PhotoCopies, TG_BOT_FILE_MAX } from './onsen-files.ts'

const CRED = 'mesh_FILESsecretSECRETsecretSECRETsecret'
const AGENT = 'adam'
const JOEY = 1828
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Call = { method: string; path: string; headers: Record<string, string>; body: any; raw?: Uint8Array }
/** a stand-in Onsen: /v1/files keeps the bytes (one File per uploader key, as Onsen's Idempotency-Key does), /messages/batch keeps the items; it can
 *  refuse attachment_file_ids on `in` (Onsen before 0.29.4), answer 500 to uploads, refuse a whole batch */
function fakeOnsen() {
  const calls: Call[] = []
  const files = new Map<string, { id: string; bytes: Uint8Array; name: string | null; type: string }>()
  const items: any[] = []
  const st = { files500: false, refuseInFiles: false, batch400: false, uploadDelayMs: 0, messagesDown: false }
  let next = 100
  const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } })
  const keep = (it: any) => {
    if (it.attachment_file_ids && it.direction === 'in' && st.refuseInFiles) return { error: 'attachment_file_ids: only on a message the agent sent (direction out, status ok)', status: 400 }
    items.push(it)
    return { id: next++, duplicate: false }
  }
  const f = (async (input: any, init?: any) => {
    const url = new URL(String(input)), path = url.pathname.replace(/^\/api\/onsen/, '')
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v)
    if (path === '/v1/files') {
      const raw = new Uint8Array(init.body)
      calls.push({ method: init.method, path, headers, body: null, raw })
      if (st.uploadDelayMs) await sleep(st.uploadDelayMs)
      if (headers.authorization !== `Bearer ${CRED}`) return json(401, { error: { code: 'not_authenticated', message: 'no' } })
      if (st.files500) return json(500, { error: { code: 'internal_error', message: 'R2 down' } })
      const key = headers['idempotency-key']!
      const had = files.get(key)
      if (had) return json(201, { data: { id: had.id, url: `https://onsen.test/api/onsen/v1/files/${had.id}` } })
      const id = String(next++)
      files.set(key, { id, bytes: raw, name: headers['x-file-name'] ? decodeURIComponent(headers['x-file-name']) : null, type: headers['content-type']! })
      return json(201, { api_version: 1, viewer: AGENT, data: { id, name: null, mime: 'x', bytes: raw.byteLength, url: `https://onsen.test/api/onsen/v1/files/${id}` } })
    }
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ method: init?.method ?? 'GET', path, headers, body })
    if (st.messagesDown) throw new TypeError('fetch failed: connect ECONNREFUSED')
    if (path === '/messages/batch') return st.batch400 ? json(400, { error: 'bad batch' }) : json(200, { results: body.items.map(keep) })
    if (path === '/messages') { const r = keep(body); return 'error' in r ? json(400, { detail: r.error }) : json(200, r) }
    return json(404, { error: 'no route' })
  }) as typeof fetch
  return { f, calls, files, items, st, uploads: () => calls.filter(c => c.path === '/v1/files'), posts: () => calls.filter(c => c.path.startsWith('/messages')) }
}
function client(dir: string, f: typeof fetch, logs: string[], o: { cred?: string | null; filesWaitMs?: number; record?: boolean } = {}) {
  return new OnsenClient({ dir, base: 'https://onsen.test/api/onsen', agent: AGENT, record: o.record ?? true, credential: () => o.cred === undefined ? CRED : o.cred,
    log: (l, m) => logs.push(`${l} ${m}`), fetch: f, intervalMs: 3_600_000, filesWaitMs: o.filesWaitMs })
}
const tmp = () => mkdtempSync(join(tmpdir(), 'onsen-files-'))
const photoMsg = (id: number, o: Record<string, unknown> = {}) => ({ message_id: id, date: 1764150000, chat: { id: JOEY, type: 'private' }, from: { id: JOEY, first_name: 'J' },
  photo: [{ file_id: 'small', file_unique_id: 's', width: 90, height: 90 }, { file_id: `photo-${id}`, file_unique_id: `u${id}`, width: 800, height: 600, file_size: 4 }], ...o })
const docMsg = (id: number) => ({ message_id: id, date: 1764150000, chat: { id: JOEY, type: 'private' }, from: { id: JOEY, first_name: 'J' },
  document: { file_id: `doc-${id}`, file_unique_id: `d${id}`, file_name: '報告 v2.pdf', mime_type: 'application/pdf', file_size: 5 } })
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('the switch (ONSEN_FILES)', () => {
  test('unset, empty, 0 / off / false / no: off; a comma list or * names the agents', () => {
    for (const v of [undefined, '', '  ', '0', 'off', 'OFF', 'false', 'no']) expect(filesOn(v, AGENT)).toBe(false)
    expect(filesOn('*', AGENT)).toBe(true)
    expect(filesOn('eve, adam', AGENT)).toBe(true)
    expect(filesOn('eve,lab-relay', AGENT)).toBe(false)
  })
  test('what carries a file: a photo, document, video, voice sent ok; an incoming one names its Telegram file; never a sticker, a text or a failed send', () => {
    expect(wantsFiles(inboundItem(AGENT, photoMsg(1), ''))).toBe(true)
    expect(wantsFiles(inboundItem(AGENT, docMsg(2), ''))).toBe(true)
    expect(wantsFiles(inboundItem(AGENT, { ...docMsg(3), document: undefined, voice: { file_id: 'v', file_unique_id: 'v', duration: 2, mime_type: 'audio/ogg' } }, 'hi'))).toBe(true)
    expect(wantsFiles(inboundItem(AGENT, { ...docMsg(4), document: undefined, sticker: { file_id: 's', file_unique_id: 's', emoji: '👍' } }, ''))).toBe(false)
    expect(wantsFiles(inboundItem(AGENT, { ...docMsg(5), document: undefined, text: 'hi' }, 'hi'))).toBe(false)
    const out = outboundRecord(AGENT, { sender: 'main' }, 'sendDocument', { chat_id: JOEY, document: { filename: 'a.md' } }, { message_id: 9, date: 1 })!
    expect(out.k === 'm' && wantsFiles(out.r)).toBe(true)
    const failed = outboundRecord(AGENT, { sender: 'main' }, 'sendDocument', { chat_id: JOEY, document: { filename: 'a.md' } }, undefined, new Error('400'))!
    expect(failed.k === 'm' && wantsFiles(failed.r)).toBe(false)
  })
  test('the key: the message idem_key (one file); idem_key:<i> for several', () => {
    expect(fileKey('tg:adam:1828:in:7', 0, 1)).toBe('tg:adam:1828:in:7')
    expect(fileKey('tg:adam:1828:in:7', 1, 2)).toBe('tg:adam:1828:in:7:1')
    expect(mimeOf('notes.md')).toBe('text/markdown')
    expect(mimeOf('x.bin', 'application/pdf')).toBe('application/pdf')
    expect(mimeOf('noext')).toBeUndefined()
  })
})

describe('the upload (POST /v1/files)', () => {
  test('this agent\'s credential, the bytes as the body, Idempotency-Key, the name percent-encoded; an image\'s type is left to Onsen', async () => {
    const o = fakeOnsen(), logs: string[] = [], c = client(tmp(), o.f, logs)
    const r = await c.uploadFile(PNG, { key: 'tg:adam:1828:in:7', name: '截圖 1.png', mime: 'image/png' })
    expect(r).toEqual({ id: '100', url: 'https://onsen.test/api/onsen/v1/files/100' })
    const u = o.uploads()[0]!
    expect(u.method).toBe('POST')
    expect(u.headers.authorization).toBe(`Bearer ${CRED}`)
    expect(u.headers['idempotency-key']).toBe('tg:adam:1828:in:7')
    expect(u.headers['x-file-name']).toBe(encodeURIComponent('截圖 1.png'))
    expect(u.headers['content-type']).toBe('application/octet-stream')
    expect([...u.raw!]).toEqual([...PNG])
    // a document keeps its type; the same key answers the same File (a retry stores nothing twice)
    await c.uploadFile(new TextEncoder().encode('# hi'), { key: 'k2', name: 'a.md', mime: 'text/markdown' })
    expect(o.uploads()[1]!.headers['content-type']).toBe('text/markdown')
    expect(await c.uploadFile(PNG, { key: 'tg:adam:1828:in:7' })).toMatchObject({ id: '100' })
    expect(o.files.size).toBe(2)
    expect(c.stats.files_uploaded).toBe(3)
  })
  test('over 25 MB or empty: not sent; 500, no answer, no credential: an error, never a throw', async () => {
    const o = fakeOnsen(), logs: string[] = []
    const c = client(tmp(), o.f, logs)
    expect(await c.uploadFile(new Uint8Array(ONSEN_FILE_MAX + 1), { key: 'big' })).toEqual({ error: `over Onsen's 25 MB (${ONSEN_FILE_MAX + 1} bytes)` })
    expect(await c.uploadFile(new Uint8Array(0), { key: 'empty' })).toEqual({ error: 'the file is empty' })
    expect(o.uploads().length).toBe(0)
    o.st.files500 = true
    expect(await c.uploadFile(PNG, { key: 'k' })).toEqual({ error: 'POST /v1/files answered HTTP 500 (R2 down)' })
    const down = client(tmp(), (async () => { throw new TypeError('fetch failed') }) as any, logs)
    expect('error' in await down.uploadFile(PNG, { key: 'k' })).toBe(true)
    const none = client(tmp(), o.f, logs, { cred: null })
    expect(await none.uploadFile(PNG, { key: 'k' })).toEqual({ error: 'no mesh credential' })
    expect(JSON.stringify(logs)).not.toContain(CRED)
  })
})

describe('the record carries attachment_file_ids', () => {
  test('the line keeps its place in the spool; the batch item carries the ids once stored (the sync waits for a running upload)', async () => {
    const o = fakeOnsen(), logs: string[] = [], dir = tmp(), c = client(dir, o.f, logs)
    o.st.uploadDelayMs = 300
    const item = inboundItem(AGENT, photoMsg(7), '')
    c.recordWithFiles(item, () => storeFiles(item, [async () => ({ bytes: PNG, name: 'p.jpg' })], (b, x) => c.uploadFile(b, x), (l, m) => logs.push(`${l} ${m}`)))
    c.recordMessage(inboundItem(AGENT, { ...docMsg(8), document: undefined, text: 'after' }, 'after'))
    // the spool has both lines in their order, the first marked (fw) and without ids (they are never written into the spool)
    const spool = readFileSync(join(dir, 'spool.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(spool.map(l => [l.r.client_msg_id, l.fw ?? null, l.r.attachment_file_ids ?? null])).toEqual([['7', 1, null], ['8', null, null]])
    await c.syncNow(true)
    expect(o.items.map(i => [i.client_msg_id, i.attachment_file_ids ?? null])).toEqual([['7', ['100']], ['8', null]])
    expect(o.items[0].attachments).toEqual([{ mime: 'image/jpeg', size: 4, file_id: 'photo-7' }])      // the Telegram file_id stays (client_ref)
    expect(o.files.get('tg:adam:1828:in:7')!.bytes).toEqual(PNG)
    expect(o.items[0]).not.toHaveProperty('fw')
    expect(logs.filter(l => l.startsWith('warn'))).toEqual([])
    expect(logs).toContain('info onsen: files: tg:adam:1828:in:7 stored as Onsen file 100 (11 bytes)')
  })
  test('the upload fails (Onsen 500): the record as before WO-190, no ids, one log line', async () => {
    const o = fakeOnsen(), logs: string[] = [], c = client(tmp(), o.f, logs)
    o.st.files500 = true
    const item = inboundItem(AGENT, docMsg(9), '')
    c.recordWithFiles(item, () => storeFiles(item, [async () => ({ bytes: PNG })], (b, x) => c.uploadFile(b, x), (l, m) => logs.push(`${l} ${m}`)))
    await c.syncNow(true)
    expect(o.items.length).toBe(1)
    expect(o.items[0].attachment_file_ids).toBeUndefined()
    expect(o.items[0].attachments).toEqual([{ name: '報告 v2.pdf', mime: 'application/pdf', size: 5, file_id: 'doc-9' }])
    expect(logs.filter(l => l.startsWith('warn'))).toEqual(['warn onsen: files: tg:adam:1828:in:9 (document 報告 v2.pdf) not stored in Onsen: POST /v1/files answered HTTP 500 (R2 down); recorded with the name and Telegram id only'])
  })
  test('an upload still running past the wait: the record goes without its ids (one log line); a restart loses a running upload the same way', async () => {
    const o = fakeOnsen(), logs: string[] = [], dir = tmp(), c = client(dir, o.f, logs, { filesWaitMs: 200 })
    const item = inboundItem(AGENT, docMsg(10), '')
    c.recordWithFiles(item, () => new Promise<string[]>(() => {}))
    const t0 = Date.now()
    await c.syncNow(true)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150)
    expect(o.items.map(i => [i.client_msg_id, i.attachment_file_ids ?? null])).toEqual([['10', null]])
    expect(logs.filter(l => l.startsWith('warn'))).toEqual([`warn onsen: files: tg:adam:1828:in:10: not stored within 0 s; recorded with the name and Telegram id only (a late file is left to Onsen's 24 h sweep)`])
    // a restart: a new client on the same spool (the cursor did not move: Onsen down), the upload's daemon is gone
    const o2 = fakeOnsen(), logs2: string[] = [], dir2 = tmp(), c1 = client(dir2, o2.f, logs2)
    o2.st.messagesDown = true
    const item2 = inboundItem(AGENT, docMsg(11), '')
    c1.recordWithFiles(item2, () => new Promise<string[]>(() => {}))
    const c2 = client(dir2, o2.f, logs2)
    o2.st.messagesDown = false
    await c2.syncNow(true)
    expect(o2.items.map(i => [i.client_msg_id, i.attachment_file_ids ?? null])).toEqual([['11', null]])
    expect(logs2.filter(l => l.includes('files:'))).toEqual(['warn onsen: files: tg:adam:1828:in:11: its upload did not finish in this daemon (a restart); recorded with the name and Telegram id only'])
  })
  test('Onsen refuses the item with its files (before 0.29.4 on `in`): the same message again without them, one log line; the rest of the batch stands', async () => {
    const o = fakeOnsen(), logs: string[] = [], dir = tmp(), c = client(dir, o.f, logs)
    o.st.refuseInFiles = true
    const a = inboundItem(AGENT, photoMsg(12), ''), b = inboundItem(AGENT, { ...docMsg(13), document: undefined, text: 'x' }, 'x')
    c.recordWithFiles(a, async () => ['555'])
    c.recordMessage(b)
    await c.syncNow(true)
    expect(o.posts().map(p => [p.path, (p.body.items ?? [p.body]).map((i: any) => `${i.client_msg_id}${i.attachment_file_ids ? '+files' : ''}`).join(',')]))
      .toEqual([['/messages/batch', '12+files,13'], ['/messages', '12']])
    expect(o.items.map(i => i.client_msg_id)).toEqual(['13', '12'])
    expect(c.stats.rejected).toBe(0)
    expect(c.pendingBytes()).toBe(0)
    expect(logs.filter(l => l.startsWith('warn'))).toEqual(['warn onsen: files: tg:adam:1828:in:12: Onsen refused it with its files (item refused: attachment_file_ids: only on a message the agent sent (direction out, status ok)); recorded again without them (name and Telegram id only)'])
    // a whole batch refused (4xx): one by one, the files' fallback the same
    const o2 = fakeOnsen(), logs2: string[] = [], c2 = client(tmp(), o2.f, logs2)
    o2.st.batch400 = true; o2.st.refuseInFiles = true
    c2.recordWithFiles(inboundItem(AGENT, photoMsg(14), ''), async () => ['556'])
    await c2.syncNow(true)
    expect(o2.posts().map(p => [p.path, p.body.attachment_file_ids ?? null])).toEqual([['/messages/batch', null], ['/messages', ['556']], ['/messages', null]])
    expect(o2.items.map(i => i.client_msg_id)).toEqual(['14'])
  })
  test('an outgoing file: the record of the send carries the id; a reply\'s .md keeps its type', async () => {
    const o = fakeOnsen(), logs: string[] = [], dir = tmp(), c = client(dir, o.f, logs)
    const path = join(dir, 'notes.md')
    writeFileSync(path, '# 筆記\n')
    const line = outboundRecord(AGENT, { sender: 'main', file: path }, 'sendDocument', { chat_id: JOEY, document: { filename: 'notes.md' } }, { message_id: 5001, date: 1764150001 })!
    if (line.k !== 'm') throw new Error('not a message')
    const item = line.r
    c.recordWithFiles(item, () => storeFiles(item, [async () => localFile(path)], (b, x) => c.uploadFile(b, x), (l, m) => logs.push(`${l} ${m}`)))
    await c.syncNow(true)
    expect(o.items.map(i => [i.direction, i.client_msg_id, i.attachment_file_ids])).toEqual([['out', '5001', ['100']]])
    const f = o.files.get('tg:adam:1828:out:5001')!
    expect(new TextDecoder().decode(f.bytes)).toBe('# 筆記\n')
    expect([f.name, f.type]).toEqual(['notes.md', 'text/markdown'])
  })
  test('recording off: nothing recorded, nothing uploaded', async () => {
    const o = fakeOnsen(), logs: string[] = [], dir = tmp(), c = client(dir, o.f, logs, { record: false })
    let ran = false
    c.recordWithFiles(inboundItem(AGENT, photoMsg(15), ''), async () => { ran = true; return ['1'] })
    await sleep(20)
    expect(ran).toBe(false)
    expect(o.calls.length).toBe(0)
  })
})

describe('the sources', () => {
  test('a local file: its bytes and name; over 25 MB or missing: why', () => {
    const dir = tmp(), p = join(dir, 'a.png')
    writeFileSync(p, PNG)
    const got = localFile(p)
    expect('bytes' in got && [...got.bytes]).toEqual([...PNG])
    expect('bytes' in got && got.name).toBe('a.png')
    expect(localFile(join(dir, 'none'))).toMatchObject({ why: expect.stringContaining('not read') })
    expect(localFile(dir)).toEqual({ why: 'not a file' })
  })
  test('Telegram: getFile then its path; over 20 MB never asked for; the bot token never in the reason', async () => {
    const TOKEN = '123456:SECRET-token_x'
    const asked: string[] = []
    const getFile = async (id: string) => { asked.push(id); return id === 'big' ? { file_path: 'documents/big.pdf', file_size: TG_BOT_FILE_MAX + 1 } : { file_path: 'documents/file_3.pdf', file_size: 5 } }
    const fileUrl = (p: string) => `https://api.telegram.test/file/bot${TOKEN}/${p}`
    const ok = await telegramFile({ fileId: 'd', size: 5, getFile, fileUrl, fetch: (async (u: any) => { expect(String(u)).toBe(fileUrl('documents/file_3.pdf')); return new Response(PNG) }) as any })
    expect('bytes' in ok && [...ok.bytes]).toEqual([...PNG])
    expect('bytes' in ok && ok.name).toBe('file_3.pdf')
    expect(await telegramFile({ fileId: 'x', size: TG_BOT_FILE_MAX + 1, getFile, fileUrl })).toEqual({ why: `over the 20 MB a bot may download from Telegram (${TG_BOT_FILE_MAX + 1} bytes)` })
    expect(asked).toEqual(['d'])
    expect(await telegramFile({ fileId: 'big', getFile, fileUrl })).toMatchObject({ why: expect.stringContaining('over the 20 MB') })
    expect(await telegramFile({ fileId: 'd', getFile, fileUrl, fetch: (async () => new Response('no', { status: 404 })) as any })).toEqual({ why: 'Telegram answered HTTP 404' })
    const bad = await telegramFile({ fileId: 'd', getFile, fileUrl, fetch: (async (u: any) => { throw new Error(`could not reach ${u}`) }) as any })
    expect('why' in bad && bad.why).toContain('bot<token>')
    expect(JSON.stringify(bad)).not.toContain('SECRET')
  })
  test('storeFiles: ids in order, a file not stored left out with one line, keys :<i> for several', async () => {
    const logs: string[] = [], keys: string[] = []
    const item = inboundItem(AGENT, photoMsg(20), '')
    item.attachments = [{ name: 'a.png' }, { name: 'b.pdf' }, { name: 'c.md' }]
    const ids = await storeFiles(item, [async () => ({ bytes: PNG }), async () => ({ why: 'gone' }), async () => { throw new Error('boom') }],
      async (_b, o) => { keys.push(o.key); return { id: `f${keys.length}` } }, (l, m) => logs.push(`${l} ${m}`))
    expect(ids).toEqual(['f1'])
    expect(keys).toEqual(['tg:adam:1828:in:20:0'])
    expect(logs.filter(l => l.startsWith('warn')).length).toBe(2)
  })
  test('PhotoCopies: the download settles the copy; a message handled without one: null', async () => {
    const pc = new PhotoCopies(), a = {}, b = {}, c = {}
    pc.open(a); pc.open(b)
    expect(await pc.track(a, Promise.resolve('/inbox/1.jpg'))).toBe('/inbox/1.jpg')
    pc.done(a)
    expect(await pc.of(a)).toBe('/inbox/1.jpg')
    pc.done(b)
    expect(await pc.of(b)).toBeNull()
    expect(await pc.of(c)).toBeNull()
    const d = {}
    pc.open(d)
    await pc.track(d, Promise.reject(new Error('x'))).catch(() => {})
    expect(await pc.of(d)).toBeNull()
  })
})
