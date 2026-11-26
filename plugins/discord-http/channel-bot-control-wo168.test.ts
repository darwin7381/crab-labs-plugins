// WO-168 stage two item 8, the discord-http copy: with CHANNEL_BOT_STATUS_URL the state before a command is the agent's telegram daemon's status record
// (its /healthz onsen.status), when it is about a screen seen in the last 5 s; unset, unreadable, stale, or another pane: the screen rules as before.
import { afterAll, expect, test } from 'bun:test'

const OWN = 'dch-wo168-own'
process.env.CHANNEL_BOT_TMUX_SESSION = OWN
let status: any = null
const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => status ? Response.json({ ok: true, onsen: { status } }) : new Response('no', { status: 503 }) })
process.env.CHANNEL_BOT_STATUS_URL = `http://127.0.0.1:${srv.port}/healthz`
const C = await import('./channel-bot-control.ts?wo168') as any
afterAll(() => { srv.stop(true); delete process.env.CHANNEL_BOT_STATUS_URL; delete process.env.CHANNEL_BOT_TMUX_SESSION })
const fresh = () => ({ hash: 'h', seen_at: new Date().toISOString() })

test('the record when fresh: its state, its menu kind, its Yes/No options', async () => {
  const W = C.__wo168
  status = { state: 'idle', detail: { screen: fresh() } }
  expect(W.statusIdle(await W.statusRead(OWN))).toBe(true)
  status = { state: 'walled', detail: { screen: fresh(), waitingFor: 'usage_limit_options' } }
  expect(W.statusIdle(await W.statusRead(OWN))).toBe(false)
  status = { state: 'waiting', detail: { screen: fresh(), waitingFor: 'switch_confirm', waiting_text: 'Switch model?\nYour next response…',
    menu_options: [{ n: 1, text: 'Yes, switch to Fable 5', cursor: true }, { n: 2, text: 'No, go back', cursor: false }] } }
  const r = await W.statusRead(OWN)
  expect(W.statusYesNo(r, /Switch model\?/i)).toBe(true); expect(W.statusYesNo(r, /effort/i)).toBe(false)
})
test('no record to read: stale, not about a screen, unreadable, or another pane', async () => {
  const W = C.__wo168
  status = { state: 'idle', detail: { screen: { hash: 'h', seen_at: new Date(Date.now() - 60_000).toISOString() } } }
  expect(await W.statusRead(OWN)).toBeNull()
  status = { state: 'idle', detail: {} }
  expect(await W.statusRead(OWN)).toBeNull()
  status = null
  expect(await W.statusRead(OWN)).toBeNull()
  status = { state: 'idle', detail: { screen: fresh() } }
  expect(await W.statusRead('a-roamer-pane')).toBeNull()
})
