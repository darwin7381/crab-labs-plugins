// A real telegram-http daemon (server.ts) with lanes on, in temp dirs (tests only). Nothing of the machine is touched: its HOME, state dir, workspace and
// ports are the test's; no lane runs a model (test-fixtures/no-claude.sh).
// Every member receives bridge updates through Onsen Items.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { fakeItems } from './onsen-items.ts'
import type { BotApiMock } from './tg-bot-api-mock.ts'

const PLUGIN = join(import.meta.dir, '..')
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
export async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return true; await sleep(50) }
  return false
}
export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)) })
    s.on('error', rej)
  })
}
export type TgDaemon = { items: ReturnType<typeof fakeItems>; port: number; stateDir: string; ws: string; home: string; log: () => string; stop: () => Promise<void>
  /** WO-197: killed at once (SIGKILL: no shutdown handler runs), as a crash or a machine's restart */
  kill: () => Promise<void>
  client: () => Promise<Client>; call: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }> }

export function personRow(d: TgDaemon, payload: Record<string, any>) {
  const id = String(payload.message_id)
  return d.items.add(id, payload.kind === 'command' ? 'control' : 'message', { from: payload.from, message_id: id, payload })
}
export function peerRow(d: TgDaemon, number: number, from: string, text: string, opts: {
  kind?: string; unverified?: boolean; payload?: Record<string, unknown>; refs?: Array<{ kind: string; value: string }>
} = {}) {
  return d.items.add(String(number), opts.kind ?? 'call', { from, unverified: opts.unverified, refs: opts.refs ?? [],
    payload: { text, msg_id: number, logged: true, ...opts.payload } })
}

export function actionRow(d: TgDaemon, payload: { action_id: string; option_id: string; version: number }) {
  return d.items.add('press-' + payload.action_id + '-' + payload.version, 'control', { action_id: payload.action_id, payload })
}
export function queuedTags(d: TgDaemon): Array<{ content: string; meta: Record<string, string> }> {
  const f = join(d.stateDir, 'lanes', 'state.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').trim().split('\n').flatMap(line => {
    const r = JSON.parse(line)
    return r.rec === 'msg' && r.notif ? [r.notif.params] : []
  })
}

/** Translate a bridge update into the payload of a waiting Item. */
function personPayload(u: Record<string, any>, n: number): Record<string, any> | null {
  const edit = u.edited_message, m = u.message ?? edit
  if (!m?.chat || !m.from) return null
  const text = String(m.text ?? m.caption ?? '')
  const thread = m.message_thread_id != null && m.is_topic_message !== false ? String(m.message_thread_id) : undefined
  const client = { name: 'telegram', chat: String(m.chat.id), msg_id: String(m.message_id), user: m.from.username ?? m.from.first_name ?? String(m.from.id),
    user_id: String(m.from.id), ...(thread ? { thread } : {}) }
  if (edit) return { message_id: String(n), client, text, edited_at: new Date((m.edit_date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString() }
  const rt = m.reply_to_message
  const photo = Array.isArray(m.photo) && m.photo.length ? m.photo[m.photo.length - 1] : null
  const doc = m.document ?? m.video ?? m.audio ?? m.voice ?? m.animation ?? null
  const kind = photo ? 'photo' : m.document ? 'document' : m.video ? 'video' : m.audio ? 'audio' : m.voice ? 'voice' : /^\/[A-Za-z]/.test(text) ? 'command' : 'text'
  const attachments = photo ? [{ kind: 'photo', name: null, mime: 'image/jpeg', bytes: photo.file_size ?? null, url: null, client_ref: photo.file_id }]
    : doc ? [{ kind, name: doc.file_name ?? null, mime: doc.mime_type ?? null, bytes: doc.file_size ?? null, url: null, client_ref: doc.file_id }] : []
  return { message_id: String(n), conversation_id: '1', from: 'joey', via: 'telegram', text, kind,
    sent_at: new Date((m.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(), attachments, client,
    reply_to: rt && !rt.forum_topic_created ? { message_id: null, client_msg_id: String(rt.message_id), from: rt.from?.username ?? rt.from?.first_name ?? null, text: rt.text ?? rt.caption ?? null } : null,
    ...(rt?.forum_topic_created?.name ? { topic_name: String(rt.forum_topic_created.name) } : {}), ...(m.media_group_id ? { media_group_id: String(m.media_group_id) } : {}) }
}
const feeds = new WeakMap<BotApiMock, Set<ReturnType<typeof fakeItems>>>()
let personSeq = 50_000
function feedUpdates(api: BotApiMock, items: ReturnType<typeof fakeItems>) {
  let targets = feeds.get(api)
  if (!targets) {
    targets = new Set()
    feeds.set(api, targets)
    api.push = (u: Record<string, any>) => {
      const p = personPayload(u, ++personSeq)
      if (!p) return
      for (const store of targets!) {
        if (u.edited_message) {
          const prior = [...store.rows.values()].find(r => r.payload.client?.chat === p.client.chat && r.payload.client?.msg_id === p.client.msg_id)
          if (prior?.state === 'waiting') { prior.payload.text = p.text; store.change(prior, 'edited'); continue }
        }
        store.add(p.message_id, p.kind === 'command' ? 'control' : 'message', { message_id: p.message_id, payload: p })
      }
    }
  }
  targets.add(items)
  return () => targets.delete(items)
}

/** root: the test's temp dir (kept across a restart: the same root gives the same state); joey: the allowlisted Telegram user id. ready: by default the
 *  connector's /healthz answering */
export async function startTgDaemon(api: BotApiMock, root: string, joey: number, env: Record<string, string> = {},
  ready?: (h: any) => boolean, sharedItems?: ReturnType<typeof fakeItems>): Promise<TgDaemon> {
  ready ??= h => h?.ok === true
  const home = join(root, 'home'), ws = join(root, 'ws'), stateDir = join(ws, '.telegram-state')
  for (const d of [home, ws, stateDir, join(ws, '.lanes')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(stateDir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [String(joey)], groups: {}, pending: {}, ackReaction: '' }))
  try { copyFileSync(join(PLUGIN, 'lanes-router.fleet.json'), join(ws, '.lanes', 'router.json')) } catch {}
  const items = sharedItems ?? fakeItems(env.LANES_AGENT ?? 'adam', 'test-member', undefined, true)
  const dead = await freePort(), port = await freePort()

  // a connector runs with test-fixtures/no-telegram-probe.ts preloaded: loading grammy or roamer-telegram.ts throws (its start fails), every daemon test
  // checks that no Telegram code is loaded
  const proc = Bun.spawn([process.execPath, '--no-env-file', ...(env.FIXTURE_MEMBER_TOKEN ? ['--preload', join(PLUGIN, 'test-fixtures', 'item-daemon.ts')] : []), '--preload', join(PLUGIN, 'test-fixtures', 'no-telegram-probe.ts'), join(PLUGIN, 'server.ts')], {
    cwd: PLUGIN,
    env: {
      GIT_ALLOW_PROTOCOL: 'file', PATH: process.env.PATH ?? '', HOME: home, TMPDIR: root, FIXTURE_ITEM_BASE: items.base,
      ONSEN_BASE: 'http://127.0.0.1:' + dead, TELEGRAM_HTTP_PORT: String(port),
      TELEGRAM_STATE_DIR: stateDir, AGENT_WORKSPACE_DIR: ws, AGENT_INBOX_SELF: 'adam', GENESIS_LANES: '1', LANES_AGENT: 'adam',
      LANES_INBOX_PORT: String(dead), LANES_CLAUDE_BIN: join(PLUGIN, 'test-fixtures', 'no-claude.sh'), MCP_TOKEN_DIR: join(root, 'tok'),
      MCP_READY_DELAY_MS: '200', CRAB_LABS_PLUGINS_ENV: join(root, 'no-machine-config'), HUB_SYNC: '0', USAGE_WALL_READ: '0',
      TYPESAFE_KEY_FILE: join(root, 'no-key'), TYPESAFE_BASE_URL: `http://127.0.0.1:${dead}`, LANES_NOTIFY_PROFILE: 'default', ...env,
    },
    stdout: 'ignore', stderr: 'ignore',
  })
  const health = () => fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.json()).catch(() => null) as Promise<any>
  if (!await until(async () => ready!(await health()), 20000)) {
    proc.kill()
    await proc.exited
    if (!sharedItems) await items.stop()
    throw new Error(`test daemon at 127.0.0.1:${port} failed readiness (exit ${proc.exitCode})`)
  }
  const disconnect = feedUpdates(api, items)
  const off = async () => { disconnect(); if (!sharedItems) await items.stop() }
  let c: Client | null = null
  const client = async (): Promise<Client> => {
    if (c) return c
    c = new Client({ name: 'lanes-topics-test', version: '0' }, { capabilities: {} })
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
    await sleep(400)
    return c
  }
  return {
    items, port, stateDir, ws, home,
    log: () => { try { return readFileSync(join(stateDir, 'server.log'), 'utf8') } catch { return '' } },
    stop: async () => { await off(); try { await c?.close() } catch {}; c = null; proc.kill(); await proc.exited.catch(() => {}); await sleep(100) },
    kill: async () => { await off(); proc.kill(9); await proc.exited.catch(() => {}); c = null; await sleep(100) },
    client,
    call: async (name, args) => {
      const r: any = await (await client()).callTool({ name, arguments: args })
      return { text: String(r.content?.[0]?.text ?? ''), isError: r.isError === true }
    },
  }
}
