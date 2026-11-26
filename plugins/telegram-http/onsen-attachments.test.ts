// WO-189 (Chiron, ruling A 09:21Z): Joey's files from Onsen's page reach the agent as a Telegram message's do. The client's getFile (Onsen's own address
// only, this agent's credential, the size limit) and attachmentMeta (the <channel> attributes, each file taken now).
import { test, expect } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OnsenClient } from './onsen-client.ts'
import { attachmentMeta, fileIdOf, localName, takeOne, type GetFile } from './onsen-attachments.ts'

const BASE = 'https://onsen.test/api/onsen'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const seen: { url: string; auth: string | null }[] = []
const fakeFetch = (async (url: string, init?: RequestInit) => {
  const h = new Headers(init?.headers)
  seen.push({ url: String(url), auth: h.get('authorization') })
  const id = /\/files\/(\d+)$/.exec(String(url))?.[1]
  if (id === '403') return new Response('{"error":"not_authorized"}', { status: 403, headers: { 'content-type': 'application/json' } })
  if (id === '999') return new Response(new Uint8Array(30), { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': '30' } })
  if (id === '11') return new Response('# 標題\n內容', { status: 200, headers: { 'content-type': 'text/markdown' } })
  return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
}) as unknown as typeof fetch
const mk = (cred: string | null = 'tok-1') => new OnsenClient({ dir: mkdtempSync(join(tmpdir(), 'wo189-c-')), base: BASE, agent: 'lab', record: true,
  credential: () => cred, log: () => {}, fetch: fakeFetch, intervalMs: 3_600_000 } as any)

test('getFile: this agent\'s credential, only to Onsen\'s own address; no credential: null; a status other than 2xx: no bytes; over the limit: throws', async () => {
  const c = mk()
  const r = await c.getFile(`${BASE}/v1/files/7`, 1000)
  expect(r).toMatchObject({ status: 200, mime: 'image/png' })
  expect([...r!.bytes!]).toEqual([...PNG])
  expect(seen.at(-1)).toEqual({ url: `${BASE}/v1/files/7`, auth: 'Bearer tok-1' })
  const n = seen.length
  await expect(c.getFile('https://elsewhere.test/api/onsen/v1/files/7', 1000)).rejects.toThrow("not Onsen's own address")
  await expect(c.getFile('https://onsen.test/other/v1/files/7', 1000)).rejects.toThrow("not Onsen's own address")
  expect(seen.length).toBe(n)                                                        // nothing sent: the credential never left
  expect(await mk(null).getFile(`${BASE}/v1/files/7`, 1000)).toBeNull()
  expect(await c.getFile(`${BASE}/v1/files/403`, 1000)).toMatchObject({ status: 403, bytes: null })
  await expect(c.getFile(`${BASE}/v1/files/999`, 10)).rejects.toThrow('too large')
})

test('attachmentMeta: two pictures and a .md: image_path, image_path_2 by position, the third the attachment set with onsen:<id>; all taken now', async () => {
  const c = mk(), dir = mkdtempSync(join(tmpdir(), 'wo189-in-')), saved = new Map<string, string>()
  const get: GetFile = (u, m) => c.getFile(u, m)
  const meta = await attachmentMeta([
    { kind: 'photo', name: '網頁傳的圖.png', mime: 'image/png', bytes: 7, url: `${BASE}/v1/files/21` },
    { kind: 'photo', name: 'b.jpg', mime: 'image/jpeg', bytes: 7, url: `${BASE}/v1/files/22` },
    { kind: 'document', name: 'notes.md', mime: 'text/markdown', bytes: 12, url: `${BASE}/v1/files/11` },
  ], { get, dir, saved, now: () => 1_000 })
  expect(meta.image_path).toBe(join(dir, '1000-onsen-21.png'))
  expect(meta.image_path_2).toBe(join(dir, '1000-onsen-22.jpg'))
  expect(meta).toMatchObject({ attachment_kind_3: 'document', attachment_file_id_3: 'onsen:11', attachment_name_3: 'notes.md', attachment_mime_3: 'text/markdown',
    attachment_size_3: '12', media_group_count: '3' })
  expect(meta.image_error).toBeUndefined()
  expect([...readFileSync(meta.image_path)]).toEqual([...PNG])
  expect(readFileSync(saved.get('onsen:11')!, 'utf8')).toBe('# 標題\n內容')               // download_attachment("onsen:11") answers this path
  expect(saved.get('onsen:21')).toBe(meta.image_path)
})

test('attachmentMeta: one picture, no suffix, no media_group_count; a picture not taken: image_error and its onsen: id to retry with; too large by its size: not asked for', async () => {
  const c = mk(), dir = mkdtempSync(join(tmpdir(), 'wo189-in-')), saved = new Map<string, string>()
  const get: GetFile = (u, m) => c.getFile(u, m)
  expect(await attachmentMeta([{ kind: 'photo', name: 'x.png', mime: 'image/png', bytes: 7, url: `${BASE}/v1/files/5` }], { get, dir, saved, now: () => 2 }))
    .toEqual({ image_path: join(dir, '2-onsen-5.png') })
  expect(await attachmentMeta([{ kind: 'photo', name: 'x.png', mime: 'image/png', bytes: 7, url: `${BASE}/v1/files/403` }], { get, dir, saved }))
    .toEqual({ image_error: 'HTTP 403', attachment_kind: 'photo', attachment_file_id: 'onsen:403', attachment_size: '7' })
  const n = seen.length
  expect(await attachmentMeta([{ kind: 'photo', name: 'big.png', mime: 'image/png', bytes: 26 * 1024 * 1024, url: `${BASE}/v1/files/6` }], { get, dir, saved }))
    .toMatchObject({ image_error: 'too large (over 25 MB)', attachment_file_id: 'onsen:6' })
  expect(seen.length).toBe(n)
  expect(await attachmentMeta([{ kind: 'photo', name: 'x.png', mime: 'image/png', url: `${BASE}/v1/files/7` }], { get: (u, m) => mk(null).getFile(u, m), dir, saved }))
    .toMatchObject({ image_error: 'no credential' })
  expect(await attachmentMeta([{ kind: 'photo', name: 'x.png', mime: 'image/png', url: 'https://elsewhere.test/v1/files/7' }], { get, dir, saved }))
    .toMatchObject({ image_error: "not Onsen's own address" })
})

test('fileIdOf, localName, takeOne (download_attachment\'s path when the copy is gone)', async () => {
  expect(fileIdOf(`${BASE}/v1/files/123`)).toBe('123')
  expect(fileIdOf('https://x/y')).toBeNull()
  expect(localName('9', 'a b.PDF', null, 5)).toBe('5-onsen-9.PDF')
  expect(localName('9', 'noext', 'text/markdown', 5)).toBe('5-onsen-9.md')
  expect(localName('9', null, 'application/x-weird', 5)).toBe('5-onsen-9.bin')
  const dir = mkdtempSync(join(tmpdir(), 'wo189-in-'))
  const got = await takeOne((u, m) => mk().getFile(u, m), `${BASE}/v1/files/11`, '11', null, null, dir, undefined, 7)
  expect(got).toEqual({ path: join(dir, '7-onsen-11.md') })
  expect(existsSync(join(dir, '7-onsen-11.md'))).toBe(true)
  expect(await takeOne((u, m) => mk().getFile(u, m), `${BASE}/v1/files/403`, '403', null, null, dir)).toEqual({ why: 'HTTP 403' })
})
