import { fakeItems } from './test-fixtures/onsen-items.ts'
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startOnsenStandin, type OnsenStandin } from './test-fixtures/onsen-standin.ts'
import { personRow, startTgDaemon, freePort, until, sleep, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const CRED = { c: 'mesh_ALBUMRESTARTconnSECRETsecretSECRET01', w: 'mesh_ALBUMRESTARToffSECRETsecretSECRET001' }
let root = '', onsen: OnsenStandin
const apis: BotApiMock[] = [], daemons: TgDaemon[] = []
const envBase = () => ({ ONSEN_BASE: `http://127.0.0.1:${onsen.port}/api/onsen`, ONSEN_PEER_LOOKUP: '0', ONSEN_CLAUDE_BIN: '/nonexistent/claude', TELEGRAM_ALBUM_CAP_MS: '30000' })
const api = () => { const a = startBotApiMock({}, { pollHoldMs: 200 }); apis.push(a); return a }
const stores = new Map<string, ReturnType<typeof fakeItems>>()
async function connector(dir: string): Promise<TgDaemon> {
  const items = stores.get(dir) ?? fakeItems()
  stores.set(dir, items)
  const d = await startTgDaemon(api(), join(root, dir), JOEY, { ...envBase(), FIXTURE_MEMBER_TOKEN: CRED.c }, undefined, items)
  daemons.push(d)
  return d
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'onsen-album-restart-'))
  onsen = startOnsenStandin({ [CRED.c]: 'c', [CRED.w]: 'w' }, await freePort())
  onsen.st.version.c = '0.35.3'; onsen.st.version.w = '0.34.2'
}, 30000)
afterAll(async () => { await Promise.all(daemons.map(d => d.stop().catch(() => {}))); for (const a of apis) a.stop(); for (const items of stores.values()) await items.stop(); onsen?.stop() })

/** the router's events for these Telegram message ids (its log line per event; the log is kept across the restart) */
const routes = (d: TgDaemon, ids: string[]) => d.log().split('\n').filter(l => ids.some(id => l.includes(`lanes: route item-${id}-v`)))
const queued = (d: TgDaemon, mgid: string): Array<{ content: string; meta: Record<string, string> }> => {
  const f = join(d.stateDir, 'lanes', 'state.jsonl')
  if (!existsSync(f)) return []
  const seen = new Set<string>()
  return readFileSync(f, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(l => l?.rec === 'msg' && l.notif?.params?.meta?.media_group_id === mgid).map(l => l.notif.params)
    .filter(p => { const k = p.meta.message_id; if (seen.has(k)) return false; seen.add(k); return true })
}
/** one album item as the bridge writes it (client_meta media_group_count 3), its photo stored in Onsen as file `fid` */
const item = (mg: string, i: number, fid: string) => ({ message_id: fid,
  conversation_id: onsen.conv(String(JOEY)), from: 'joey', via: 'telegram', text: '', kind: 'photo', sent_at: new Date().toISOString(), reply_to: null, media_group_id: mg,
  attachments: [{ kind: 'photo', name: null, mime: 'image/png', bytes: 4, url: `http://127.0.0.1:${onsen.port}/api/onsen/v1/files/${fid}`, client_ref: `Ag${mg}${i}` }],
  client: { name: 'telegram', chat: String(JOEY), msg_id: String(Number(fid) - 7000), user: 'joey', user_id: String(JOEY), meta: { media_group_count: '3', media_group_id: mg } } })
const store = (fid: string, b: number) => onsen.files.set(`c:f${fid}`, { id: fid, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, b]), at: Date.now() })

test('a connector killed during photo download routes one album across two restarts', async () => {
  const fids = ['8101', '8102', '8103']
  fids.forEach((f, i) => store(f, i))
  onsen.st.fileDelayMs = 4000                                            // the flush waits for the photos: the kill comes first
  let d = await connector('ca')
  for (const [i, f] of fids.entries()) personRow(d, item('mgA', i + 1, f))
  await sleep(500)
  expect(routes(d, ['8101', '8102', '8103'])).toHaveLength(0)
  await d.kill()
  onsen.st.fileDelayMs = 0
  d = await connector('ca')
  expect(await until(() => routes(d, ['8101', '8102', '8103']).length >= 1, 12000)).toBe(true)
  await sleep(1500)
  expect(routes(d, ['8101', '8102', '8103'])).toHaveLength(1)
  const tags = queued(d, 'mgA')
  expect(tags).toHaveLength(1)
  expect(tags[0]!.meta).toMatchObject({ message_id: '1101', media_group_count: '3' })
  expect(tags[0]!.meta.image_path).toContain('onsen-8101')
  expect(tags[0]!.meta.image_path_2).toContain('onsen-8102')
  expect(tags[0]!.meta.image_path_3).toContain('onsen-8103')
  for (const k of ['image_path', 'image_path_2', 'image_path_3']) expect(existsSync(tags[0]!.meta[k]!)).toBe(true)
  expect([...d.items.rows.values()].every(row => row.state === 'waiting')).toBe(true)
  // A journalled waiting album stays a single notification across another restart.
  await d.kill()
  d = await connector('ca')
  await sleep(3500)
  expect(routes(d, ['8101', '8102', '8103'])).toHaveLength(1)
}, 60000)

test('two waiting photos and a third arriving after restart route once in Telegram order', async () => {
  const fids = ['8201', '8202', '8203']
  fids.forEach((f, i) => store(f, 10 + i))
  let d = await connector('cb')
  for (const [i, f] of fids.slice(0, 2).entries()) personRow(d, item('mgB', i + 1, f))
  await sleep(800)
  await d.kill()
  d = await connector('cb')
  personRow(d, item('mgB', 3, '8203'))
  expect(await until(() => routes(d, ['8201', '8202', '8203']).length >= 1, 10000)).toBe(true)
  await sleep(1500)
  expect(routes(d, ['8201', '8202', '8203'])).toHaveLength(1)
  const tags = queued(d, 'mgB')
  expect(tags).toHaveLength(1)
  expect(tags[0]!.meta).toMatchObject({ message_id: '1201', media_group_count: '3' })
  expect(tags[0]!.meta.image_path).toContain('onsen-8201')
  expect(tags[0]!.meta.image_path_2).toContain('onsen-8202')
  expect(tags[0]!.meta.image_path_3).toContain('onsen-8203')
}, 60000)
