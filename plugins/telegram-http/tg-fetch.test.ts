// WO-197 (Chiron 16:1xZ): TelegramFetch, against a local server that never closes an idle connection (as Telegram keeps them); this process's own
// connections to it counted with lsof
import { test, expect, afterAll } from 'bun:test'
import { spawnSync } from 'child_process'
import { TelegramFetch, type FetchFn } from './tg-fetch.ts'

const HAS_LSOF = spawnSync('lsof', ['-v'], { encoding: 'utf8' }).error == null
const seen: Array<{ path: string; method: string; connection: string | null; type: string | null }> = []
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', idleTimeout: 0, async fetch(req) {
  const u = new URL(req.url)
  seen.push({ path: u.pathname, method: req.method, connection: req.headers.get('connection'), type: req.headers.get('content-type') })
  if (u.pathname === '/slow') await Bun.sleep(400)
  return new Response('ok')
} })
afterAll(() => server.stop(true))
const root = `http://127.0.0.1:${server.port}`
const sockets = (): number => spawnSync('lsof', ['-nP', '-a', '-p', String(process.pid), `-iTCP:${server.port}`, '-sTCP:ESTABLISHED'], { encoding: 'utf8' }).stdout
  .split('\n').filter(l => l.includes(`->127.0.0.1:${server.port}`)).length

test.skipIf(!HAS_LSOF)('requests keep their connections; the hand-over (Connection: close on what it lets through, then the drain) leaves none; reopened: kept again', async () => {
  const t = new TelegramFetch({ root })
  const f = t.fetch
  await Promise.all([1, 2, 3].map(() => f(`${root}/slow`).then(r => r.text())))
  await f(`${root}/fast`).then(r => r.text())
  await Bun.sleep(200)
  expect(t.peak).toBe(3)
  expect(sockets()).toBe(3)                                        // kept alive: the fourth reused one
  // a request on its way when the hand-over begins (no Connection: close) and one let through after (with it)
  const early = f(`${root}/slow`).then(r => r.text())
  await Bun.sleep(50)
  t.beginClose()
  await f(`${root}/fast`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', agent: { keepAlive: true } } as any).then(r => r.text())
  const last = seen.at(-1)!
  expect(last).toMatchObject({ path: '/fast', method: 'POST', connection: 'close', type: 'application/json' })
  expect(await t.endClose()).toBeGreaterThanOrEqual(3)               // waited for `early`, then drained
  await early
  await Bun.sleep(200)
  expect(sockets()).toBe(0)
  expect(seen.filter(s => s.method === 'HEAD' && s.path === '/').every(s => s.connection === 'close')).toBe(true)
  expect(t.stats.drains).toBe(1)
  // taken off the list: as before
  t.reopen()
  await f(`${root}/fast`).then(r => r.text())
  await Bun.sleep(200)
  expect(seen.at(-1)!.connection).not.toBe('close')
  expect(sockets()).toBe(1)
})

test('the wrapped fetch: grammy\'s agent dropped, headers kept; a fetch given to wrap is the one called', async () => {
  const calls: any[] = []
  const under: FetchFn = async (input, init) => { calls.push({ input: String(input), init }); return new Response('x') }
  const t = new TelegramFetch({ root, fetch: under })
  await t.wrap(under)(`${root}/a`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=b' }, agent: {} } as any)
  expect('agent' in calls[0].init).toBe(false)
  expect(calls[0].init.headers['content-type']).toBe('multipart/form-data; boundary=b')
  t.beginClose()
  await t.wrap(under)(`${root}/b`, { headers: { 'content-type': 'application/json' } })
  expect(new Headers(calls[1].init.headers).get('connection')).toBe('close')
  expect(new Headers(calls[1].init.headers).get('content-type')).toBe('application/json')
  await t.endClose()
  expect(calls.slice(2).map(c => [c.input, c.init.method, new Headers(c.init.headers).get('connection')])).toEqual([[`${root}/`, 'HEAD', 'close']])
})
