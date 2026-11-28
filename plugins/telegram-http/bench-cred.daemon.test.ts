import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freePort, until } from './test-fixtures/tg-daemon.ts'

const mesh = 'mesh_' + 'm'.repeat(32)
const bench = 'mesh_' + 'b'.repeat(32)
const rotated = 'mesh_' + 'r'.repeat(32)
const loopbackToken = 'local-test-'.repeat(4)

function standIn() {
  const headers = new Map<string, Headers>()
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    headers.set(path, req.headers)
    if (path.endsWith('/inbox')) {
      await Bun.sleep(50)
      return Response.json({ last_seq: 0, acked_seq: 0, items: [] })
    }
    if (path.endsWith('/due')) return Response.json({ due: [] })
    if (path.endsWith('/posts')) return Response.json({ id: 1 })
    if (path.endsWith('/inject')) return Response.json({ injected: true })
    return Response.json({})
  } })
  return { server, headers, base: server.url.origin }
}

test.each([
  { mode: 'named, Onsen mail and feed', named: true, onsenRoutes: true },
  { mode: 'named, BTCC mail and legacy Fleet Core feed', named: true, onsenRoutes: false },
  { mode: 'unset, Onsen mail and feed', named: false, onsenRoutes: true },
  { mode: 'unset, BTCC mail and legacy Fleet Core feed', named: false, onsenRoutes: false },
])('$mode', async ({ named, onsenRoutes }) => {
  const root = mkdtempSync(join(tmpdir(), 'bench-cred-'))
  const state = join(root, 'state'), tokens = join(root, 'tokens'), file = join(root, 'bench-token')
  for (const dir of [state, tokens]) mkdirSync(dir)
  writeFileSync(join(state, 'mesh-credential'), mesh + '\n')
  writeFileSync(file, bench + '\n')
  writeFileSync(join(root, 'machine-config'), '')
  const port = await freePort()
  writeFileSync(join(tokens, String(port)), loopbackToken)
  const inbox = standIn(), gateway = standIn()
  // Exercise both a mounted Fleet Core and identical Core/BTCC bases, with the inbox on another port.
  const fleetPath = onsenRoutes ? '/fleet' : ''
  const fleet = gateway.base + fleetPath, onsen = inbox.base + '/api/onsen'
  writeFileSync(join(root, 'registry.json'), JSON.stringify({
    peer: { url: inbox.base + '/api/onsen-peer/inject' },
    relay: { url: fleet + '/relay/inject' },
    mailbox: { url: gateway.base + '/api/mesh/mailbox/mailbox/inject' },
  }))
  const proc = Bun.spawn(['bun', '--no-env-file', join(import.meta.dir, '..', 'agent-inbox', 'server.ts')], {
    cwd: import.meta.dir, stdout: 'ignore', stderr: 'ignore',
    env: {
      PATH: process.env.PATH, HOME: root, TMPDIR: root, GIT_ALLOW_PROTOCOL: '', CRAB_LABS_PLUGINS_ENV: join(root, 'machine-config'),
      TELEGRAM_HTTP_PORT: String(port), TELEGRAM_STATE_DIR: state, MCP_TOKEN_DIR: tokens, AGENT_WORKSPACE_DIR: root,
      AGENT_INBOX_SELF: 'fixture', AGENT_INBOX_REGISTRY: join(root, 'registry.json'), GENESIS_LANES: '1', ONSEN_PULL: 'fixture',
      ONSEN_BASE: onsen + '/', FLEET_CORE_BASE: fleet + '/', BTCC_API_BASE: gateway.base,
      MAIL_ONSEN: onsenRoutes ? '1' : '0', FEED_ONSEN: onsenRoutes ? '1' : '0',
      ...(named ? { ONSEN_CREDENTIAL_FILE: file } : {}),
    },
  })
  const post = async (route: string, body: unknown = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}/lanes/${route}`, { method: 'POST',
      headers: { Authorization: `Bearer ${loopbackToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect(r.status).toBe(200)
    return r.json()
  }
  try {
    expect(await until(() => inbox.headers.has('/api/onsen/inbox'), 10000)).toBe(true)
    const fileAuth = `Bearer ${named ? bench : mesh}`, meshAuth = `Bearer ${mesh}`
    const mailPath = onsenRoutes ? fleetPath + '/api/onsen/mail' : '/api/mesh/mail'
    const mailAuth = onsenRoutes ? fileAuth : meshAuth
    const feedPath = fleetPath + (onsenRoutes ? '/api/onsen/feed/posts' : '/api/feed/posts')
    const pull = inbox.headers.get('/api/onsen/inbox')!
    expect(pull.get('authorization')).toBe(fileAuth)
    expect(pull.get('user-agent')).toBe('onsen-telegram/fixture')

    await post('mail-tool', { name: 'mailbox_list', args: {}, lane: 'fixture.mail.1' })
    expect(await post('mail-waiting')).toEqual({ ok: true, items: [] })
    expect(await post('send', { line: 'feed', title: 'Fixture', text: 'Local post', touches: ['fixture'] })).toMatchObject({ delivered: true })
    expect(await post('scheduler', { action: 'ack', run_id: 7 })).toMatchObject({ ok: true })
    for (const [path, auth] of [[mailPath + '/list', mailAuth], [mailPath + '/due', mailAuth], [feedPath, fileAuth]]) {
      const headers = gateway.headers.get(path)
      expect(headers?.get('authorization')).toBe(auth)
      expect(headers?.get('user-agent')).toBe('agent-inbox/fixture')
      expect(headers?.get('content-type')).toBe('application/json')
    }
    expect(gateway.headers.get('/api/scheduler/runs/7/ack')?.get('authorization')).toBe(meshAuth)

    for (const to of ['peer', 'relay', 'mailbox']) await post('send', { to, text: 'Local fixture' })
    expect(inbox.headers.get('/api/onsen-peer/inject')?.get('authorization')).toBe(meshAuth)
    expect(gateway.headers.get(fleetPath + '/relay/inject')?.get('authorization')).toBe(fileAuth)
    expect(gateway.headers.get('/api/mesh/mailbox/mailbox/inject')?.get('authorization')).toBe(meshAuth)
    expect(gateway.headers.get('/api/comms/log')?.get('authorization')).toBe(meshAuth)

    if (named && onsenRoutes) {
      writeFileSync(file, rotated + '\n')
      const later = new Date(Date.now() + 2000)
      utimesSync(file, later, later)
      expect(await post('mail-waiting')).toMatchObject({ ok: true })
      expect(gateway.headers.get(mailPath + '/due')?.get('authorization')).toBe(`Bearer ${rotated}`)
      rmSync(file)
      expect(await post('mail-waiting')).toMatchObject({ ok: true })
      expect(gateway.headers.get(mailPath + '/due')?.get('authorization')).toBeNull()
      writeFileSync(file, 'malformed')
      expect(await post('mail-waiting')).toMatchObject({ ok: true })
      expect(gateway.headers.get(mailPath + '/due')?.get('authorization')).toBeNull()
    }
  } finally {
    proc.kill()
    await proc.exited
    inbox.server.stop(true)
    gateway.server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 20000)
