// WO-197 defect 3 (lab 17:12Z, 1.58.26; Chiron mesh 12823): an album that comes back from Onsen one person_message at a time is ONE <channel> tag
// and one router event, however far apart its items are handed over; real daemons (server.ts, lanes on) against the Bot API stand-in and the Onsen
// stand-in, in temp dirs; the hand-over (POST /onsen/person) is the test's, 3 s apart (the agent-inbox daemon's place).
//   connector    the count is the bridge's client_meta.media_group_count; the hand-over is answered before the photo is fetched
// (1.59.0: the 「switch off, ONSEN_INBOUND on」 case, an album from Telegram written into Onsen by this daemon, is gone: no daemon but a roamer takes
// Telegram updates, and a roamer records nothing into Onsen)
// The 2-of-3 cap: onsen-connector-daemon.test.ts 14.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startOnsenStandin, type OnsenStandin } from './test-fixtures/onsen-standin.ts'
import { startTgDaemon, freePort, until, sleep, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const CRED = { c: 'mesh_ALBUMconnectorSECRETsecretSECRET0001', w: 'mesh_ALBUMswitchoffSECRETsecretSECRET0001' }
let root = '', apiC: BotApiMock, onsen: OnsenStandin, conn: TgDaemon

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'onsen-album-daemon-'))
  onsen = startOnsenStandin({ [CRED.c]: 'c', [CRED.w]: 'w' }, await freePort())
  onsen.st.version.c = '0.35.3'; onsen.st.version.w = '0.34.2'
  writeFileSync(join(root, 'cred-c'), CRED.c + '\n'); writeFileSync(join(root, 'cred-w'), CRED.w + '\n')
  apiC = startBotApiMock({}, { pollHoldMs: 200 })
  const env = { ONSEN_BASE: `http://127.0.0.1:${onsen.port}/api/onsen`, ONSEN_PEER_LOOKUP: '0', ONSEN_CLAUDE_BIN: '/nonexistent/claude' }
  conn = await startTgDaemon(apiC, join(root, 'c'), JOEY, { ...env, TELEGRAM_BOT_TOKEN: '', ONSEN_BRIDGE: 'adam', ONSEN_CREDENTIAL_FILE: join(root, 'cred-c') })
}, 60000)
afterAll(async () => { await conn?.stop(); apiC?.stop(); onsen?.stop() })

const hand = async (d: TgDaemon, it: { kind: string; seq: number; dedupe: string; payload: any }) => {
  const t0 = Date.now()
  const r = await fetch(`http://127.0.0.1:${d.port}/onsen/person`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(it) })
  return { status: r.status, ms: Date.now() - t0, json: await r.json() as any }
}
/** the router's events for these Telegram message ids (its log line per event) */
const routes = (d: TgDaemon, ids: string[]) => d.log().split('\n').filter(l => ids.some(id => l.includes(`lanes: route tg-${JOEY}-${id} `)))
/** the <channel> tags the router queued for the main (no main is registered here: each waits in the journal with its notification) */
const queued = (d: TgDaemon, mgid: string): Array<{ content: string; meta: Record<string, string> }> => {
  const f = join(d.stateDir, 'lanes', 'state.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(l => l?.rec === 'msg' && l.state === 'queued' && l.notif?.params?.meta?.media_group_id === mgid).map(l => l.notif.params)
}

test('connector: three person_messages of one album (client_meta.media_group_count 3) handed over 3 s apart: one tag with three image paths, one router event; each hand-over answered before its photo is fetched', async () => {
  onsen.st.fileDelayMs = 1500                                            // a large photo: Onsen takes 1.5 s to serve each
  const items = [1, 2, 3].map(i => {
    const fid = String(9000 + i)
    onsen.files.set(`c:alb${i}`, { id: fid, bytes: new Uint8Array([0xff, 0xd8, 0xff, i]), at: Date.now() })
    return { kind: 'person_message', seq: 100 + i, dedupe: `pm:${7000 + i}`, payload: { message_id: String(7000 + i), conversation_id: onsen.conv(String(JOEY)), from: 'joey',
      via: 'telegram', text: '', kind: 'photo', sent_at: new Date().toISOString(), reply_to: null, media_group_id: 'mg-c',
      attachments: [{ kind: 'photo', name: null, mime: 'image/png', bytes: 4, url: `http://127.0.0.1:${onsen.port}/api/onsen/v1/files/${fid}`, client_ref: `AgC${i}` }],
      client: { name: 'telegram', chat: String(JOEY), msg_id: String(1094 + i), user: 'joey', user_id: String(JOEY), meta: { media_group_count: '3', media_group_id: 'mg-c' } } } }
  })
  for (const [i, it] of items.entries()) {
    if (i) await sleep(3000)
    const r = await hand(conn, it)
    expect(r.status).toBe(200)
    expect(r.json.delivered).toBe(true)
    expect(r.ms).toBeLessThan(1000)                                      // not the 1.5 s fetch: the inbox hands the next item on at once
  }
  expect(await until(() => queued(conn, 'mg-c').length >= 1, 10000)).toBe(true)
  await sleep(1500)
  const tags = queued(conn, 'mg-c')
  expect(tags).toHaveLength(1)
  expect(tags[0]!.meta).toMatchObject({ message_id: '1095', media_group_count: '3' })
  for (const k of ['image_path', 'image_path_2', 'image_path_3']) expect(existsSync(tags[0]!.meta[k]!)).toBe(true)
  expect(new Set([tags[0]!.meta.image_path, tags[0]!.meta.image_path_2, tags[0]!.meta.image_path_3]).size).toBe(3)
  expect(tags[0]!.content).toBe('(album: 3 photos)')
  expect(routes(conn, ['1095', '1096', '1097'])).toHaveLength(1)
  expect(conn.log()).toContain(`album ${JOEY}:mg-c: all 3 item(s) in; delivered as one tag`)
  expect(apiC.calls).toEqual([]); expect(apiC.polls).toEqual([])
  onsen.st.fileDelayMs = 0
}, 40000)
