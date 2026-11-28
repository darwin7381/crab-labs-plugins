import { test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startOnsenStandin, type OnsenStandin } from './test-fixtures/onsen-standin.ts'
import { personRow, startTgDaemon, freePort, until, sleep, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const CRED = { c: 'mesh_ALBUMconnectorSECRETsecretSECRET0001', w: 'mesh_ALBUMswitchoffSECRETsecretSECRET0001' }
let root = '', apiC: BotApiMock, onsen: OnsenStandin, conn: TgDaemon

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'onsen-album-daemon-'))
  onsen = startOnsenStandin({ [CRED.c]: 'c', [CRED.w]: 'w' }, await freePort())
  onsen.st.version.c = '0.35.3'; onsen.st.version.w = '0.34.2'
  apiC = startBotApiMock({}, { pollHoldMs: 200 })
  const env = { ONSEN_BASE: `http://127.0.0.1:${onsen.port}/api/onsen`, ONSEN_PEER_LOOKUP: '0', ONSEN_CLAUDE_BIN: '/nonexistent/claude' }
  conn = await startTgDaemon(apiC, join(root, 'c'), JOEY, { ...env, TELEGRAM_BOT_TOKEN: '', ONSEN_BRIDGE: 'adam', FIXTURE_MEMBER_TOKEN: CRED.c })
}, 60000)
afterAll(async () => { await conn?.stop(); apiC?.stop(); onsen?.stop() })

/** the router's events for these Telegram message ids (its log line per event) */
const routes = (d: TgDaemon, ids: string[]) => d.log().split('\n').filter(l => ids.some(id => l.includes(`lanes: route item-${id}-v`)))
/** the <channel> tags the router queued for the main (no main is registered here: each waits in the journal with its notification) */
const queued = (d: TgDaemon, mgid: string): Array<{ content: string; meta: Record<string, string> }> => {
  const f = join(d.stateDir, 'lanes', 'state.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(l => l?.rec === 'msg' && l.state === 'queued' && l.notif?.params?.meta?.media_group_id === mgid).map(l => l.notif.params)
}

test('connector: three person_messages of one album (client_meta.media_group_count 3) handed over 3 s apart: one tag with three image paths, one router event; the album waits in Onsen until a session takes it', async () => {
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
    const row = personRow(conn, it.payload)
    expect(row.state).toBe('waiting')
  }
  expect(await until(() => queued(conn, 'mg-c').length >= 1, 10000)).toBe(true)
  await sleep(1500)
  const tags = queued(conn, 'mg-c')
  expect(tags).toHaveLength(1)
  expect(tags[0]!.meta).toMatchObject({ message_id: '1095', media_group_count: '3' })
  for (const k of ['image_path', 'image_path_2', 'image_path_3']) expect(existsSync(tags[0]!.meta[k]!)).toBe(true)
  expect(new Set([tags[0]!.meta.image_path, tags[0]!.meta.image_path_2, tags[0]!.meta.image_path_3]).size).toBe(3)
  expect(tags[0]!.content).toBe('(album: 3 photos)')
  expect(routes(conn, ['7001', '7002', '7003'])).toHaveLength(1)
  expect(conn.log()).toContain(`album ${JOEY}:mg-c: all 3 item(s) in; delivered as one tag`)
  expect(apiC.calls).toEqual([]); expect(apiC.polls).toEqual([])
  onsen.st.fileDelayMs = 0
}, 40000)
