// A real telegram-http daemon (server.ts) with lanes on, against the Bot API stand-in (tg-bot-api-mock.ts), in temp dirs (tests only). Nothing of the
// machine is touched: its HOME, state dir, workspace and ports are the test's; no lane runs a model (test-fixtures/no-claude.sh).
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

/** root: the test's temp dir (kept across a restart: the same root gives the same state); joey: the allowlisted Telegram user id */
export async function startTgDaemon(api: BotApiMock, root: string, joey: number, env: Record<string, string> = {},
  ready: (h: any) => boolean = h => h?.polling === true): Promise<TgDaemon> {   // WO-197: a connector never polls (ready: its /healthz answers)
  const home = join(root, 'home'), ws = join(root, 'ws'), stateDir = join(ws, '.telegram-state')
  for (const d of [home, ws, stateDir, join(ws, '.lanes')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(stateDir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [String(joey)], groups: {}, pending: {}, ackReaction: '' }))
  try { copyFileSync(join(PLUGIN, 'lanes-router.fleet.json'), join(ws, '.lanes', 'router.json')) } catch {}
  const port = await freePort(), dead = await freePort()
  const proc = Bun.spawn(['bun', join(PLUGIN, 'server.ts')], {
    cwd: PLUGIN,
    env: {
      PATH: process.env.PATH ?? '', HOME: home, TELEGRAM_BOT_TOKEN: api.token, TELEGRAM_API_ROOT: api.url, TELEGRAM_HTTP_PORT: String(port),
      TELEGRAM_STATE_DIR: stateDir, AGENT_WORKSPACE_DIR: ws, AGENT_INBOX_SELF: 'adam', GENESIS_LANES: '1', LANES_AGENT: 'adam',
      LANES_INBOX_PORT: String(dead), LANES_CLAUDE_BIN: join(PLUGIN, 'test-fixtures', 'no-claude.sh'), MCP_TOKEN_DIR: join(root, 'tok'),
      MCP_READY_DELAY_MS: '200', CRAB_LABS_PLUGINS_ENV: join(root, 'no-machine-config'), HUB_SYNC: '0', USAGE_WALL_READ: '0',
      TYPESAFE_KEY_FILE: '/nonexistent/typesafe.env', TYPESAFE_BASE_URL: `http://127.0.0.1:${dead}`, LANES_NOTIFY_PROFILE: 'default', ...env,
    },
    stdout: 'ignore', stderr: 'ignore',
  })
  const health = () => fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.json()).catch(() => null) as Promise<any>
  if (!await until(async () => ready(await health()), 20000)) throw new Error('tg daemon did not start polling')
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
    stop: async () => { try { await c?.close() } catch {}; c = null; proc.kill(); await proc.exited.catch(() => {}); await sleep(100) },
    kill: async () => { proc.kill(9); await proc.exited.catch(() => {}); c = null; await sleep(100) },
    client,
    call: async (name, args) => {
      const r: any = await (await client()).callTool({ name, arguments: args })
      return { text: String(r.content?.[0]?.text ?? ''), isError: r.isError === true }
    },
  }
}
