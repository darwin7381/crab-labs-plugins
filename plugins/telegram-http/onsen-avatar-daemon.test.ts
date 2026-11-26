// WO-172 item 3 end to end: a real Telegram daemon (server.ts) against the Bot API stand-in (its bot has a profile photo) and a stand-in Onsen that takes
// PUT /api/onsen/v1/members/<agent>/avatar (WO-170's shape: the image as the body). ONSEN_AVATAR lists the agent: the photo goes up once; a restart with
// the same photo sends nothing; a new photo goes up. ONSEN_AVATAR unset: no photo is even asked for. Temp dirs only; nothing reaches Telegram or Onsen.
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, freePort, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const CRED = 'mesh_AVATARsecretSECRETsecretSECRET0123456'
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3, 4, 5]), JPEG2 = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 9, 9, 9])
let api: BotApiMock, onsen: ReturnType<typeof Bun.serve> | null = null, root = '', onsenPort = 0
const puts: Array<{ agent: string; type: string; bytes: number[]; auth: string | null }> = []
beforeAll(async () => {
  api = startBotApiMock({}, { pollHoldMs: 300 })
  api.photo.bytes = JPEG
  onsenPort = await freePort()
  onsen = Bun.serve({ port: onsenPort, hostname: '127.0.0.1', async fetch(req) {
    const path = new URL(req.url).pathname.replace(/^\/api\/onsen/, '')
    const m = path.match(/^\/v1\/members\/([^/]+)\/avatar$/)
    if (m && req.method === 'PUT') {
      puts.push({ agent: m[1]!, type: req.headers.get('content-type') ?? '', bytes: [...new Uint8Array(await req.arrayBuffer())], auth: req.headers.get('authorization') })
      return Response.json({ api_version: '1', data: { name: m[1], avatar: { url: `/api/onsen/v1/members/${m[1]}/avatar?v=${puts.length}`, version: String(puts.length) } } })
    }
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    return Response.json({ results: (body?.items ?? []).map(() => ({ id: 1, duplicate: false })) })
  } })
  root = mkdtempSync(join(tmpdir(), 'onsen-avatar-daemon-'))
  mkdirSync(join(root, 'cred'), { recursive: true }); writeFileSync(join(root, 'cred', 'c'), CRED + '\n')
}, 30000)
afterAll(() => { api?.stop(); onsen?.stop(true) })
const env = (o: Record<string, string> = {}) => ({ GENESIS_LANES: '0', ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'c'),
  ONSEN_PEER_LOOKUP: '0', ONSEN_REGISTRY_CLI: '0', ONSEN_AVATAR_FIRST_MS: '0', ...o })

test("ONSEN_AVATAR on: the bot's largest photo goes up once (as the agent, with its credential); a restart with the same photo sends nothing; a new one goes up", async () => {
  let d: TgDaemon = await startTgDaemon(api, join(root, 'on'), JOEY, env({ ONSEN_AVATAR: 'adam' }))
  try {
    expect(await until(() => puts.length === 1, 10000)).toBe(true)
    expect(puts[0]).toEqual({ agent: 'adam', type: 'image/jpeg', bytes: [...JPEG], auth: `Bearer ${CRED}` })
    expect(api.of('getUserProfilePhotos')[0]!.body).toMatchObject({ user_id: api.me.id, limit: 1 })
    expect(api.of('getFile').map(c => c.body.file_id)).toEqual(['self-l'])                    // the largest size
    expect(d.log()).toContain('onsen: avatar on for adam')
  } finally { await d.stop() }
  d = await startTgDaemon(api, join(root, 'on'), JOEY, env({ ONSEN_AVATAR: 'adam' }))
  try {
    expect(await until(() => api.of('getFile').length === 2, 10000)).toBe(true)
    await new Promise(r => setTimeout(r, 500))
    expect(puts).toHaveLength(1)                                                              // the same bytes: not sent again
  } finally { await d.stop() }
  api.photo.bytes = JPEG2
  d = await startTgDaemon(api, join(root, 'on'), JOEY, env({ ONSEN_AVATAR: 'adam' }))
  try {
    expect(await until(() => puts.length === 2, 10000)).toBe(true)
    expect(puts[1]!.bytes).toEqual([...JPEG2])
  } finally { await d.stop() }
}, 60000)

test('ONSEN_AVATAR not listing the agent: no photo is asked for, nothing sent', async () => {
  const n = api.of('getUserProfilePhotos').length, p = puts.length
  const d = await startTgDaemon(api, join(root, 'off'), JOEY, env({ ONSEN_AVATAR: 'someone-else' }))
  try {
    await new Promise(r => setTimeout(r, 1500))
    expect(api.of('getUserProfilePhotos').length).toBe(n)
    expect(puts.length).toBe(p)
  } finally { await d.stop() }
}, 30000)
