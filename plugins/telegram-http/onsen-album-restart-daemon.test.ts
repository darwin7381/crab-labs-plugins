// WO-197 (Chiron mesh 12852): an album's items keep their facts until the album goes. A person_message of an album item is answered 200 (the inbox
// acks it) before its album is delivered (up to TELEGRAM_ALBUM_CAP_MS); a daemon killed in between (a fleet version change restarts every daemon)
// delivers the album after its restart, once, from what it kept on disk. Real daemons (server.ts, lanes on) against the Bot API stand-in and the Onsen
// stand-in, in temp dirs; the hand-over (POST /onsen/person) is the test's (the agent-inbox daemon's place); the kill is SIGKILL (no shutdown runs).
//   connector    (a) all three handed over, killed while their photos are fetched → restarted: one tag with the three, 1.5 s after (A.1's restart
//                path, ONSEN_INBOUND_BACK_MS); the inbox handing one again: a duplicate; killed again after it went → nothing delivered again
//                (b) two handed over, killed, restarted, the third handed over: one tag with the three in Telegram's order (the kept two join it)
//   switch off   ONSEN_INBOUND on, polling: an album of three from Telegram written into Onsen, two of its person_messages handed back, killed →
//                restarted: one tag with the three; the third's person_message, and the first's again: duplicates
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startOnsenStandin, type OnsenStandin } from './test-fixtures/onsen-standin.ts'
import { startTgDaemon, freePort, until, sleep, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const CRED = { c: 'mesh_ALBUMRESTARTconnSECRETsecretSECRET01', w: 'mesh_ALBUMRESTARToffSECRETsecretSECRET001' }
let root = '', onsen: OnsenStandin
const apis: BotApiMock[] = [], daemons: TgDaemon[] = []
const envBase = () => ({ ONSEN_BASE: `http://127.0.0.1:${onsen.port}/api/onsen`, ONSEN_PEER_LOOKUP: '0', ONSEN_CLAUDE_BIN: '/nonexistent/claude', TELEGRAM_ALBUM_CAP_MS: '30000' })
const api = () => { const a = startBotApiMock({}, { pollHoldMs: 200 }); apis.push(a); return a }
async function connector(dir: string, back: number): Promise<TgDaemon> {
  const d = await startTgDaemon(api(), join(root, dir), JOEY, { ...envBase(), TELEGRAM_BOT_TOKEN: '', ONSEN_BRIDGE: 'adam', ONSEN_CREDENTIAL_FILE: join(root, 'cred-c'),
    ONSEN_INBOUND_BACK_MS: String(back) }, h => h?.ok === true)
  daemons.push(d)
  return d
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'onsen-album-restart-'))
  onsen = startOnsenStandin({ [CRED.c]: 'c', [CRED.w]: 'w' }, await freePort())
  onsen.st.version.c = '0.35.3'; onsen.st.version.w = '0.34.2'
  writeFileSync(join(root, 'cred-c'), CRED.c + '\n'); writeFileSync(join(root, 'cred-w'), CRED.w + '\n')
}, 30000)
afterAll(async () => { await Promise.all(daemons.map(d => d.stop().catch(() => {}))); for (const a of apis) a.stop(); onsen?.stop() })

const hand = async (d: TgDaemon, it: { kind: string; seq: number; dedupe: string; payload: any }) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/onsen/person`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(it) })
  return { status: r.status, json: await r.json() as any }
}
/** the router's events for these Telegram message ids (its log line per event; the log is kept across the restart) */
const routes = (d: TgDaemon, ids: string[]) => d.log().split('\n').filter(l => ids.some(id => l.includes(`lanes: route tg-${JOEY}-${id} `)))
const queued = (d: TgDaemon, mgid: string): Array<{ content: string; meta: Record<string, string> }> => {
  const f = join(d.stateDir, 'lanes', 'state.jsonl')
  if (!existsSync(f)) return []
  const seen = new Set<string>()
  return readFileSync(f, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(l => l?.rec === 'msg' && l.notif?.params?.meta?.media_group_id === mgid).map(l => l.notif.params)
    .filter(p => { const k = p.meta.message_id; if (seen.has(k)) return false; seen.add(k); return true })
}
/** one album item as the bridge writes it (client_meta media_group_count 3), its photo stored in Onsen as file `fid` */
const item = (mg: string, i: number, fid: string) => ({ kind: 'person_message', seq: Number(fid), dedupe: `pm:${fid}`, payload: { message_id: fid,
  conversation_id: onsen.conv(String(JOEY)), from: 'joey', via: 'telegram', text: '', kind: 'photo', sent_at: new Date().toISOString(), reply_to: null, media_group_id: mg,
  attachments: [{ kind: 'photo', name: null, mime: 'image/png', bytes: 4, url: `http://127.0.0.1:${onsen.port}/api/onsen/v1/files/${fid}`, client_ref: `Ag${mg}${i}` }],
  client: { name: 'telegram', chat: String(JOEY), msg_id: String(Number(fid) - 7000), user: 'joey', user_id: String(JOEY), meta: { media_group_count: '3', media_group_id: mg } } } })
const store = (fid: string, b: number) => onsen.files.set(`c:f${fid}`, { id: fid, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, b]), at: Date.now() })

test('connector (a): three handed over, killed while their photos are fetched; restarted: one tag with the three, once; handed again: duplicate; killed after it went: nothing again', async () => {
  const fids = ['8101', '8102', '8103']
  fids.forEach((f, i) => store(f, i))
  onsen.st.fileDelayMs = 4000                                            // the flush waits for the photos: the kill comes first
  let d = await connector('ca', 1500)
  for (const [i, f] of fids.entries()) expect((await hand(d, item('mgA', i + 1, f))).status).toBe(200)
  await sleep(500)
  expect(routes(d, ['1101', '1102', '1103'])).toHaveLength(0)
  await d.kill()
  onsen.st.fileDelayMs = 0
  d = await connector('ca', 1500)
  expect(await until(() => routes(d, ['1101', '1102', '1103']).length >= 1, 12000)).toBe(true)
  await sleep(1500)
  expect(routes(d, ['1101', '1102', '1103'])).toHaveLength(1)
  const tags = queued(d, 'mgA')
  expect(tags).toHaveLength(1)
  expect(tags[0]!.meta).toMatchObject({ message_id: '1101', media_group_count: '3' })
  expect(tags[0]!.meta.image_path).toContain('onsen-8101')
  expect(tags[0]!.meta.image_path_2).toContain('onsen-8102')
  expect(tags[0]!.meta.image_path_3).toContain('onsen-8103')
  for (const k of ['image_path', 'image_path_2', 'image_path_3']) expect(existsSync(tags[0]!.meta[k]!)).toBe(true)
  expect(d.log()).toContain('3 album item(s) whose album did not go')
  const again = await hand(d, item('mgA', 2, '8102'))
  expect(again).toMatchObject({ status: 200, json: { duplicate: true } })
  // the album went: its facts are gone; a restart delivers nothing again
  await d.kill()
  d = await connector('ca', 1500)
  await sleep(3500)
  expect(routes(d, ['1101', '1102', '1103'])).toHaveLength(1)
}, 60000)

test('connector (b): two handed over, killed; restarted, the third handed over: one tag with the three in Telegram\'s order (the kept two join it), once', async () => {
  const fids = ['8201', '8202', '8203']
  fids.forEach((f, i) => store(f, 10 + i))
  let d = await connector('cb', 20000)                                    // A.1's restart path out of the way: the third item pulls the two in
  for (const [i, f] of fids.slice(0, 2).entries()) expect((await hand(d, item('mgB', i + 1, f))).status).toBe(200)
  await sleep(800)
  await d.kill()
  d = await connector('cb', 20000)
  expect((await hand(d, item('mgB', 3, '8203'))).status).toBe(200)
  expect(await until(() => routes(d, ['1201', '1202', '1203']).length >= 1, 10000)).toBe(true)
  await sleep(1500)
  expect(routes(d, ['1201', '1202', '1203'])).toHaveLength(1)
  const tags = queued(d, 'mgB')
  expect(tags).toHaveLength(1)
  expect(tags[0]!.meta).toMatchObject({ message_id: '1201', media_group_count: '3' })
  expect(tags[0]!.meta.image_path).toContain('onsen-8201')
  expect(tags[0]!.meta.image_path_2).toContain('onsen-8202')
  expect(tags[0]!.meta.image_path_3).toContain('onsen-8203')
  expect(d.log()).toContain('joins its album now')
}, 60000)

test('switch off, ONSEN_INBOUND on: an album of three from Telegram, two of its person_messages handed back, killed; restarted: one tag with the three, once; the rest come as duplicates', async () => {
  const opts = (back: number) => ({ ...envBase(), ONSEN_INBOUND: 'adam', ONSEN_INBOUND_BACK_MS: String(back), ONSEN_CREDENTIAL_FILE: join(root, 'cred-w') })
  const withFiles = () => { const a = api(); for (const i of [1, 2, 3]) a.files.set(`AgR${i}`, { path: `photos/r${i}.jpg`, bytes: new Uint8Array([0xff, 0xd8, 0xff, i]) }); return a }
  const a1 = withFiles()
  let d = await startTgDaemon(a1, join(root, 'w'), JOEY, opts(120000)); daemons.push(d)
  const date = Math.floor(Date.now() / 1000)
  const chat = { id: JOEY, type: 'private', first_name: 'J' }, from = { id: JOEY, is_bot: false, first_name: 'J', username: 'joey' }
  for (const i of [1, 2, 3]) a1.push({ message: { message_id: 2300 + i, date, chat, from, media_group_id: 'mg-r',
    photo: [{ file_id: `AgR${i}`, file_unique_id: `ur${i}`, width: 90, height: 90, file_size: 4 }] } })
  const pms = () => onsen.inbox.filter(i => i.who === 'w' && i.kind === 'person_message' && i.payload?.media_group_id === 'mg-r').sort((x, y) => x.seq - y.seq)
  expect(await until(() => pms().length === 3, 15000)).toBe(true)
  expect(await until(() => d.log().includes(`album ${JOEY}:mg-r: 3 item(s) came from Telegram`), 5000)).toBe(true)
  for (const it of pms().slice(0, 2)) expect((await hand(d, { kind: it.kind, seq: it.seq, dedupe: it.dedupe, payload: it.payload })).status).toBe(200)
  await sleep(800)
  expect(routes(d, ['2301', '2302', '2303'])).toHaveLength(0)            // waiting for the third
  await d.kill()
  // Telegram does not give the album again (its updates were confirmed): a fresh Bot API stand-in
  d = await startTgDaemon(withFiles(), join(root, 'w'), JOEY, opts(1500)); daemons.push(d)
  expect(await until(() => routes(d, ['2301', '2302', '2303']).length >= 1, 12000)).toBe(true)
  await sleep(1500)
  expect(routes(d, ['2301', '2302', '2303'])).toHaveLength(1)
  const tags = queued(d, 'mg-r')
  expect(tags).toHaveLength(1)
  expect(tags[0]!.meta).toMatchObject({ message_id: '2301', media_group_count: '3', media_group_id: 'mg-r' })
  for (const k of ['image_path', 'image_path_2', 'image_path_3']) expect(tags[0]!.meta[k]).toBeTruthy()
  for (const it of [pms()[2]!, pms()[0]!]) expect(await hand(d, { kind: it.kind, seq: it.seq, dedupe: it.dedupe, payload: it.payload })).toMatchObject({ status: 200, json: { duplicate: true } })
  await sleep(500)
  expect(routes(d, ['2301', '2302', '2303'])).toHaveLength(1)
}, 60000)
