// A real telegram-http daemon (server.ts) with lanes on, in temp dirs (tests only). Nothing of the machine is touched: its HOME, state dir, workspace and
// ports are the test's; no lane runs a model (test-fixtures/no-claude.sh).
// WO-197 final (1.59.0): a daemon is a connector unless env has ROAMER_MODE=1. A connector gets no bot token and no Bot API root (it has no Telegram);
// what a test pushes on the Bot API stand-in (api.push: a Telegram update) reaches it as the bridge hands it over: the person_message (or person_edit)
// Onsen gives back for what the bridge wrote, POSTed to /onsen/person in push order (personItem below; the agent-inbox daemon's place). A roamer
// (ROAMER_MODE=1) polls the stand-in as every daemon did before.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
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
export type TgDaemon = { port: number; stateDir: string; ws: string; home: string; log: () => string; stop: () => Promise<void>
  /** WO-197: killed at once (SIGKILL: no shutdown handler runs), as a crash or a machine's restart */
  kill: () => Promise<void>
  client: () => Promise<Client>; call: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }> }

/** WO-197 final: a Telegram update (tg-bot-api-mock.ts dm() shape, or an edited_message) as the bridge hands it to a connector: the inbox item Onsen
 *  gives back (onsen_person.py's payload: client.chat / msg_id / user / user_id / thread are Telegram's; a topic's creation message is not a reply; a
 *  slash text is kind command). `n`: its Onsen message id. null: an update that is not a person's message (a button press: an Action's control) */
export function personItem(u: Record<string, any>, n: number): { kind: string; seq: number; dedupe: string; payload: any } | null {
  const edit = u.edited_message, m = u.message ?? edit
  if (!m?.chat || !m.from) return null
  const text = String(m.text ?? m.caption ?? '')
  const thread = m.message_thread_id != null && m.is_topic_message !== false ? String(m.message_thread_id) : undefined
  const client = { name: 'telegram', chat: String(m.chat.id), msg_id: String(m.message_id), user: m.from.username ?? m.from.first_name ?? String(m.from.id),
    user_id: String(m.from.id), ...(thread ? { thread } : {}) }
  if (edit) return { kind: 'person_edit', seq: n, dedupe: `pe:${n}`, payload: { message_id: String(n), client, text, edited_at: new Date((m.edit_date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString() } }
  const rt = m.reply_to_message
  const photo = Array.isArray(m.photo) && m.photo.length ? m.photo[m.photo.length - 1] : null
  const doc = m.document ?? m.video ?? m.audio ?? m.voice ?? m.animation ?? null
  const kind = photo ? 'photo' : m.document ? 'document' : m.video ? 'video' : m.audio ? 'audio' : m.voice ? 'voice' : /^\/[A-Za-z]/.test(text) ? 'command' : 'text'
  const attachments = photo ? [{ kind: 'photo', name: null, mime: 'image/jpeg', bytes: photo.file_size ?? null, url: null, client_ref: photo.file_id }]
    : doc ? [{ kind, name: doc.file_name ?? null, mime: doc.mime_type ?? null, bytes: doc.file_size ?? null, url: null, client_ref: doc.file_id }] : []
  return { kind: 'person_message', seq: n, dedupe: `pm:${n}`, payload: { message_id: String(n), conversation_id: '1', from: 'joey', via: 'telegram', text, kind,
    sent_at: new Date((m.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(), attachments, client,
    reply_to: rt && !rt.forum_topic_created ? { message_id: null, client_msg_id: String(rt.message_id), from: rt.from?.username ?? rt.from?.first_name ?? null, text: rt.text ?? rt.caption ?? null } : null,
    ...(rt?.forum_topic_created?.name ? { topic_name: String(rt.forum_topic_created.name) } : {}), ...(m.media_group_id ? { media_group_id: String(m.media_group_id) } : {}) } }
}
/** the connectors started on each Bot API stand-in: its push() hands every update to each of them, in order */
const handedTo = new WeakMap<BotApiMock, Array<{ port: number; chain: Promise<unknown> }>>()
/** the Onsen message ids the handed-over items get (unique in the test process) */
let personSeq = 50_000
function handOver(api: BotApiMock, port: number): () => void {
  let list = handedTo.get(api)
  if (!list) {
    list = []
    handedTo.set(api, list)
    const targets = list
    api.push = (u: Record<string, any>) => {
      for (const t of targets) {
        const it = personItem(u, ++personSeq)
        if (!it) continue
        t.chain = t.chain.then(async () => {
          for (let i = 0; i < 20; i++) {
            const r = await fetch(`http://127.0.0.1:${t.port}/onsen/person`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(it) }).catch(() => null)
            if (r && r.status !== 409) return
            await sleep(100)
          }
        })
      }
    }
  }
  const t = { port, chain: Promise.resolve() as Promise<unknown> }
  list.push(t)
  return () => { const i = list!.indexOf(t); if (i >= 0) list!.splice(i, 1) }
}

/** root: the test's temp dir (kept across a restart: the same root gives the same state); joey: the allowlisted Telegram user id. ready: by default a
 *  connector's /healthz answering, a roamer's long poll running */
export async function startTgDaemon(api: BotApiMock, root: string, joey: number, env: Record<string, string> = {},
  ready?: (h: any) => boolean): Promise<TgDaemon> {
  const roamer = env.ROAMER_MODE === '1'
  ready ??= roamer ? (h => h?.polling === true) : (h => h?.ok === true)
  const home = join(root, 'home'), ws = join(root, 'ws'), stateDir = join(ws, '.telegram-state')
  for (const d of [home, ws, stateDir, join(ws, '.lanes')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(stateDir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [String(joey)], groups: {}, pending: {}, ackReaction: '' }))
  try { copyFileSync(join(PLUGIN, 'lanes-router.fleet.json'), join(ws, '.lanes', 'router.json')) } catch {}
  const port = await freePort(), dead = await freePort()
  // a connector runs with test-fixtures/no-telegram-probe.ts preloaded: loading grammy or roamer-telegram.ts throws (its start fails), every daemon test
  // checks that no Telegram code is loaded
  const proc = Bun.spawn(['bun', ...(roamer ? [] : ['--preload', join(PLUGIN, 'test-fixtures', 'no-telegram-probe.ts')]), join(PLUGIN, 'server.ts')], {
    cwd: PLUGIN,
    env: {
      PATH: process.env.PATH ?? '', HOME: home, ...(roamer ? { TELEGRAM_BOT_TOKEN: api.token, TELEGRAM_API_ROOT: api.url } : {}), TELEGRAM_HTTP_PORT: String(port),
      TELEGRAM_STATE_DIR: stateDir, AGENT_WORKSPACE_DIR: ws, AGENT_INBOX_SELF: 'adam', GENESIS_LANES: '1', LANES_AGENT: 'adam',
      LANES_INBOX_PORT: String(dead), LANES_CLAUDE_BIN: join(PLUGIN, 'test-fixtures', 'no-claude.sh'), MCP_TOKEN_DIR: join(root, 'tok'),
      MCP_READY_DELAY_MS: '200', CRAB_LABS_PLUGINS_ENV: join(root, 'no-machine-config'), HUB_SYNC: '0', USAGE_WALL_READ: '0',
      TYPESAFE_KEY_FILE: '/nonexistent/typesafe.env', TYPESAFE_BASE_URL: `http://127.0.0.1:${dead}`, LANES_NOTIFY_PROFILE: 'default', ...env,
    },
    stdout: 'ignore', stderr: 'ignore',
  })
  const health = () => fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.json()).catch(() => null) as Promise<any>
  if (!await until(async () => ready!(await health()), 20000)) throw new Error(roamer ? 'tg daemon (roamer) did not start polling' : 'tg daemon did not start')
  const off = roamer ? () => {} : handOver(api, port)
  let c: Client | null = null
  const client = async (): Promise<Client> => {
    if (c) return c
    c = new Client({ name: 'lanes-topics-test', version: '0' }, { capabilities: {} })
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
    await sleep(400)
    return c
  }
  return {
    port, stateDir, ws, home,
    log: () => { try { return readFileSync(join(stateDir, 'server.log'), 'utf8') } catch { return '' } },
    stop: async () => { off(); try { await c?.close() } catch {}; c = null; proc.kill(); await proc.exited.catch(() => {}); await sleep(100) },
    kill: async () => { off(); proc.kill(9); await proc.exited.catch(() => {}); c = null; await sleep(100) },
    client,
    call: async (name, args) => {
      const r: any = await (await client()).callTool({ name, arguments: args })
      return { text: String(r.content?.[0]?.text ?? ''), isError: r.isError === true }
    },
  }
}
