// lanes-golive: defaults for the fleet. The lane model is Sonnet 5.5 unless LANES_MODEL says otherwise. The Jev (TypeSafe) key, approved by Joey for the
// outbound checks, is read where the fleet registers a key: the agent's workspace .secrets/typesafe.env (TYPESAFE_API_KEY and TYPESAFE_KEY_FILE still win);
// the lab's ~/.genesis/typesafe.env is not read. The main's hooks find the same file through CLAUDE_PROJECT_DIR.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const was = { model: process.env.LANES_MODEL, key: process.env.TYPESAFE_API_KEY, file: process.env.TYPESAFE_KEY_FILE, base: process.env.TYPESAFE_BASE_URL }
delete process.env.LANES_MODEL
const L = await import('./lanes.ts?golive-defaults') as typeof import('./lanes.ts')
const T = await import('./lanes-triage.ts') as typeof import('./lanes-triage.ts')
const ws = mkdtempSync(join(tmpdir(), 'golive-defaults-ws-'))
process.env.LANES_DIR = join(ws, '.lanes')
L.lanesInit({ role: 'inbox', agent: 'adam', workspaceDir: ws, transcriptDir: join(ws, 'proj'), httpPort: 0, log: () => {}, authOk: () => false } as any)
afterAll(() => {
  for (const [k, v] of [['LANES_MODEL', was.model], ['TYPESAFE_API_KEY', was.key], ['TYPESAFE_KEY_FILE', was.file], ['TYPESAFE_BASE_URL', was.base]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
})

test('the lane model defaults to claude-sonnet-5-5', () => {
  expect(L.LANE_MODEL_DEFAULT).toBe('claude-sonnet-5-5')
  expect(L.laneModel()).toBe('claude-sonnet-5-5')
})

test('the Jev key: <workspace>/.secrets/typesafe.env by default (the fleet registry\'s place), TYPESAFE_KEY_FILE wins; the key from that file is what Jev gets', async () => {
  const saved = process.env.TYPESAFE_KEY_FILE
  delete process.env.TYPESAFE_KEY_FILE; delete process.env.TYPESAFE_API_KEY
  expect(T.jevKeyFile()).toBe(join(ws, '.secrets', 'typesafe.env'))
  mkdirSync(join(ws, '.secrets'), { recursive: true }); writeFileSync(join(ws, '.secrets', 'typesafe.env'), 'TYPESAFE_API_KEY=test-key-from-workspace\n')
  let auth = ''
  const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => { auth = req.headers.get('authorization') ?? ''; return Response.json({ error: 'stand-in' }, { status: 500 }) } })
  process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${srv.port}`
  await T.jevAsk({ x: 1 }, { q: {} }, 'test/1', 2000)
  srv.stop(true)
  expect(auth).toBe('Bearer test-key-from-workspace')
  process.env.TYPESAFE_KEY_FILE = '/nonexistent/k'
  expect(T.jevKeyFile()).toBe('/nonexistent/k')
  if (saved === undefined) delete process.env.TYPESAFE_KEY_FILE; else process.env.TYPESAFE_KEY_FILE = saved
})

test('the main\'s hooks read the key from the workspace (CLAUDE_PROJECT_DIR) .secrets, not ~/.genesis', async () => {
  for (const f of ['main-answered-gate.py', 'main-summary-gate.py']) {
    const p = Bun.spawn(['python3', '-c', `import importlib.util,sys; s=importlib.util.spec_from_file_location('m', sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.KEY_FILE)`,
      join(import.meta.dir, 'lanes-hooks', f)], { env: { PATH: process.env.PATH ?? '', CLAUDE_PROJECT_DIR: ws }, stdout: 'pipe', stderr: 'pipe' })
    expect((await new Response(p.stdout).text()).trim()).toBe(join(ws, '.secrets', 'typesafe.env'))
  }
})
