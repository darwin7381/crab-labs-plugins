// WO-197 (lab 19:23–19:25Z on 1.58.28, the switch off, ONSEN_INBOUND on): an album of three, the daemon killed 3 ms after its first item came back
// from the inbox. The restarted daemon got the three Telegram updates again; the inbox had the first two to hand again (its 30 s retry) and handed the
// third at once. 1.58.28 delivered a1 + a3 at the cap with media_group_count 2, then a2 alone 20 s later (A.1): the second item's facts were held
// here but it was not in the album (the writer still had it queued at the kill, so the restart did not count it as left over). Now a flush takes
// every item of the album whose facts this daemon holds, and the album's count is the largest its items knew. A real daemon (server.ts, lanes on)
// against the Bot API stand-in and the Onsen stand-in (A answered after 1.5 s in the first run, so the kill falls while the writer is busy).
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startOnsenStandin, type OnsenStandin } from './test-fixtures/onsen-standin.ts'
import { startTgDaemon, freePort, until, sleep, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const CRED = 'mesh_ALBUMCRASHswitchoffSECRETsecretSEC01'
let root = '', onsen: OnsenStandin
const apis: BotApiMock[] = [], daemons: TgDaemon[] = []
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'onsen-album-crash-'))
  onsen = startOnsenStandin({ [CRED]: 'w' }, await freePort())
  onsen.st.version.w = '0.34.2'
  writeFileSync(join(root, 'cred'), CRED + '\n')
}, 30000)
afterAll(async () => { await Promise.all(daemons.map(d => d.stop().catch(() => {}))); for (const a of apis) a.stop(); onsen?.stop() })

const date = Math.floor(Date.now() / 1000)
const chat = { id: JOEY, type: 'private', first_name: 'J' }, from = { id: JOEY, is_bot: false, first_name: 'J', username: 'joey' }
/** a Bot API stand-in that has the album's three updates (a restarted daemon is given them again: their offset was never confirmed) */
const telegram = () => {
  const a = startBotApiMock({}, { pollHoldMs: 200 }); apis.push(a)
  for (const i of [1, 2, 3]) {
    a.files.set(`AgX${i}`, { path: `photos/x${i}.jpg`, bytes: new Uint8Array([0xff, 0xd8, 0xff, i]) })
    a.push({ message: { message_id: 1452 + i, date, chat, from, media_group_id: 'mg-x', photo: [{ file_id: `AgX${i}`, file_unique_id: `ux${i}`, width: 90, height: 90, file_size: 4 }] } })
  }
  return a
}
const start = async (back: number) => {
  const d = await startTgDaemon(telegram(), join(root, 'w'), JOEY, { ONSEN_BASE: `http://127.0.0.1:${onsen.port}/api/onsen`, ONSEN_PEER_LOOKUP: '0',
    ONSEN_CLAUDE_BIN: '/nonexistent/claude', ONSEN_INBOUND: 'adam', ONSEN_INBOUND_BACK_MS: String(back), TELEGRAM_ALBUM_CAP_MS: '4000', ONSEN_CREDENTIAL_FILE: join(root, 'cred') })
  daemons.push(d)
  return d
}
const hand = async (d: TgDaemon, it: any) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/onsen/person`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: it.kind, seq: it.seq, dedupe: it.dedupe, payload: it.payload }) })
  return { status: r.status, json: await r.json() as any }
}
const pm = (n: number) => onsen.inbox.find(i => i.who === 'w' && i.kind === 'person_message' && i.payload?.client?.msg_id === String(1452 + n))
const ids = ['1453', '1454', '1455']
const routes = (d: TgDaemon) => d.log().split('\n').filter(l => ids.some(id => l.includes(`lanes: route tg-${JOEY}-${id} `)))
const tags = (d: TgDaemon) => {
  const f = join(d.stateDir, 'lanes', 'state.jsonl')
  if (!existsSync(f)) return []
  const seen = new Set<string>()
  return readFileSync(f, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(l => l?.rec === 'msg' && l.notif?.params?.meta?.media_group_id === 'mg-x').map(l => l.notif.params)
    .filter(p => { const k = p.meta.message_id; if (seen.has(k)) return false; seen.add(k); return true })
}

test('killed right after the first item came back (the writer still busy); restarted, Telegram gives the three again, the inbox hands the third at once and the first two later: one tag, three files, media_group_count 3, nothing twice', async () => {
  onsen.st.aDelayMs = 1500                                                   // Onsen takes A slowly: the second and third are still being written at the kill
  let d = await start(120000)
  expect(await until(() => !!pm(1), 15000)).toBe(true)
  expect((await hand(d, pm(1)!)).status).toBe(200)                          // buffered in its album (count 3 from the arrival)
  await sleep(3)
  await d.kill()
  await sleep(4000)                                                         // the stand-in finishes the write it had started
  onsen.st.aDelayMs = 0
  d = await start(6000)                                                     // A.1 after 6 s here (20 s in the fleet)
  expect(await until(() => !!pm(3), 15000)).toBe(true)
  await sleep(500)
  expect((await hand(d, pm(3)!)).status).toBe(200)                          // the third, at once
  expect(await until(() => routes(d).length >= 1, 12000)).toBe(true)        // at most the cap (4 s here) after it
  for (const n of [1, 2]) expect(await until(() => !!pm(n), 5000)).toBe(true)
  for (const n of [1, 2]) expect((await hand(d, pm(n)!)).json).toMatchObject({ duplicate: true })   // the inbox's retry: delivered already
  await sleep(8000)                                                         // past A.1 for every item
  expect(routes(d)).toHaveLength(1)
  const t = tags(d)
  expect(t).toHaveLength(1)
  expect(t[0]!.meta).toMatchObject({ message_id: '1453', media_group_count: '3', media_group_id: 'mg-x' })
  for (const k of ['image_path', 'image_path_2', 'image_path_3']) expect(t[0]!.meta[k]).toBeTruthy()
  expect(new Set([t[0]!.meta.image_path, t[0]!.meta.image_path_2, t[0]!.meta.image_path_3]).size).toBe(3)
  expect(t[0]!.content).toBe('(album: 3 photos)')
}, 90000)
