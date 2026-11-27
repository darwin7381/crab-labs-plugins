import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import childProcess from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from './agent.ts'
import { FakeOnsen, FakeTelegram, until } from './fakes.ts'
import { Poller } from './inbound.ts'
import { OnsenClient } from './onsen.ts'
import { StateStore } from './state.ts'
import { configFromEnv } from './telegram-bridge.ts'

const dir = mkdtempSync(join(tmpdir(), 'bridge-voice-'))
const token = '123:voice-test'
const sender = 42
let tg: FakeTelegram, onsen: FakeOnsen, poller: Poller

beforeAll(() => {
  tg = new FakeTelegram()
  onsen = new FakeOnsen()
  tg.addBot(token, 'voice_bot')
  onsen.creds.set('test', 'bridge')
  onsen.holders.set('alpha', 'bridge')
  onsen.identities.set(String(sender), 'tester')
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [String(sender)] }))
  const log = () => {}
  const client = new OnsenClient(onsen.base, '')
  client.token = () => 'test'
  const agent = new Agent('alpha', dir, 'test', { token, mtime: 0 }, { bridgeDir: dir, tgOptions: { apiRoot: tg.root }, log })
  poller = new Poller(agent, { onsen: client, state: new StateStore(dir), pollTimeoutS: 1, log })
  poller.start()
})
afterAll(async () => {
  await poller.stop()
  tg.stop()
  onsen.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('bridge configuration never reads the retired voice switches', () => {
  const env = { TELEGRAM_BRIDGE_MACHINE: 'test' }
  for (const key of ['TELEGRAM_BRIDGE_VOICE', 'CHANNEL_BOT_VOICE_TRANSCRIBE', 'CHANNEL_BOT_TRANSCRIBE_CMD', 'CHANNEL_BOT_WHISPER_BIN', 'CHANNEL_BOT_WHISPER_MODEL']) {
    Object.defineProperty(env, key, { get() { throw new Error(`bridge read ${key}`) } })
  }
  expect(configFromEnv(env)).not.toHaveProperty('voice')
})

test.each([
  { id: 803, caption: undefined, text: '' },
  { id: 807, caption: '聽這段', text: '聽這段' },
])('voice $id sends the original audio and "$text" without local transcription', async ({ id, caption, text }) => {
  const exec = spyOn(childProcess, 'execFile').mockImplementation(() => { throw new Error('unexpected transcriber') })
  try {
    const audio = new Uint8Array([4, 5, id % 256]), ref = `voice-${id}`
    tg.files.set(`f/${ref}`, audio)
    tg.push(token, { message: { message_id: id, from: { id: sender, is_bot: false, first_name: 'Tester' }, chat: { id: sender, type: 'private' },
      date: 1, caption, voice: { file_id: ref, file_unique_id: ref, duration: 2, mime_type: 'audio/ogg', file_size: audio.length } } })
    const message = () => onsen.messages.find(m => m.client_msg_id === String(id))
    await until(() => !!message(), 3000, 'voice written')
    const body = message()
    expect(body).toMatchObject({ kind: 'voice', text, attachments: [{ kind: 'voice', client_ref: ref, mime: 'audio/ogg', bytes: audio.length }] })
    expect(body).not.toHaveProperty('client_meta')
    expect(body.attachment_file_ids).toHaveLength(1)
    expect(onsen.files.get(body.attachment_file_ids[0])).toMatchObject({ bytes: audio, mime: 'audio/ogg', key: body.idem_key })
    expect(exec).not.toHaveBeenCalled()
    expect(onsen.bad).toEqual([])
  } finally { exec.mockRestore() }
})
