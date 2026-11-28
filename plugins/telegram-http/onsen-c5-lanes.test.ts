import { afterAll, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OnsenClient } from './onsen-client.ts'
import { TakeMode } from './onsen-take.ts'
import { ItemReceiver } from './onsen-receive.ts'
import { Claims } from './onsen-claims.ts'
import { fakeItems } from './test-fixtures/onsen-items.ts'
import { promiseTime } from './onsen-promises.ts'

const dir = mkdtempSync(join(tmpdir(), 'c5-lanes-'))
const f = fakeItems()
const jev = Bun.serve({ hostname: '127.0.0.1', port: 0,
  fetch: () => Response.json({ answers: { promises: { type: 'noul', noul: 0.99 } } }) })
const env = { LANES_DIR: dir, TYPESAFE_API_KEY: 'test', TYPESAFE_BASE_URL: 'http://127.0.0.1:' + jev.port }
const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
Object.assign(process.env, env)
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
const L = await import('./lanes.ts?onsen-c5') as typeof import('./lanes.ts')
const pushes: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {},
  authOk: () => false, registryNames: () => ['eve'], joeyChatId: () => '6736970916',
  sendBot: async (_chat: string, text: string) => { pushes.push(text); return 1 } } as any)
L.__setMainConnected('test-main')
const client = new OnsenClient({ dir, agent: 'adam', record: true, base: f.base, credential: () => 'test-member', log: () => {} })
const mode = new TakeMode('adam', client.request.bind(client), () => {}, () => {})
const claims = new Claims(join(dir, 'claims.json'), client, () => {}, () => {}, f.now)
L.useItemReceiver(new ItemReceiver(mode, claims, () => {}), write => client.recordSelfWrite(write))
await mode.probe()
afterAll(() => {
  mode.stop(); claims.stop(); client.stop(); f.stop(); jev.stop(true)
  L.useItemReceiver(undefined)
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  rmSync(dir, { recursive: true, force: true })
})
const selfRows = () => [...f.rows.values()].filter(r => r.kind === 'self')
const notices = (id: string) => [...f.rows.values()].filter(r => r.kind === 'notice' && r.about_item_id === id)

test('a sent Telegram promise creates one self for the test account and only Onsen notifies that waiter', async () => {
  const at = Date.now()
  L.mainReplied(null, 'onsen:42', undefined, '10 分鐘後回報', '6736970916')
  L.mainReplied(null, 'onsen:42', undefined, '10 分鐘後回報', '6736970916')
  for (let i = 0; i < 100 && !selfRows().length; i++) { await Bun.sleep(10); await client.syncNow(true) }
  expect(selfRows()).toHaveLength(1)
  const row = selfRows()[0]!
  expect(row).toMatchObject({ from: 'adam', waiter: 'joey-test', session_id: 'main', deadline: row.not_before })
  expect(Date.parse(row.deadline!)).toBeGreaterThanOrEqual(at + 600_000)
  expect(Date.parse(row.deadline!)).toBeLessThanOrEqual(Date.now() + 600_000)
  f.advance(Date.parse(row.deadline!) - f.now() - 1)
  expect(notices(row.id)).toHaveLength(0)
  f.advance(2); L.dueTick(f.now())
  f.advance(60_000); L.dueTick(f.now())
  expect(notices(row.id)).toHaveLength(1)
  expect(notices(row.id)[0]).toMatchObject({ member: 'joey-test', reason: 'promise_due' })
  expect(pushes).toHaveLength(0)
})

test('the main tool and a handed peer answer keep their actual waiter and finish early', async () => {
  const due = new Date(f.now() + 600_000).toISOString()
  const reply = await L.callMainTool('commitment', { who: 'eve', what: '寄圖', due }, 'test-main')
  const id = /\(id (cm-[^;]+)/.exec(reply)![1]!
  await client.syncNow(true)
  const row = selfRows().find(r => r.waiter === 'eve')!
  expect(row).toMatchObject({ deadline: due, not_before: due, state: 'waiting' })
  expect(await L.callMainTool('commitment_done', { commitment_id: id }, 'test-main')).toContain('marked done')
  L.__events().open('handed', { class: 'peer', owner: 'main', thread: 't', obligations: [
    { kind: 'peer', level: 'answer', state: 'handed', what: '回信', to: 'cain', due_at: Date.parse(due) }] })
  await L.mainSentTo('cain', 't', null, '已寄出', '33', true)
  await client.syncNow(true)
  expect(row.state).toBe('completed')
  const peer = selfRows().find(r => r.waiter === 'cain')!
  expect(peer.state).toBe('completed')
  f.advance(700_000)
  expect(notices(row.id)).toHaveLength(0)
  expect(notices(peer.id)).toHaveLength(0)
})

test('only definite times become deadlines', () => {
  const at = Date.parse('2026-11-28T23:50:00+08:00')
  expect(promiseTime('12 分鐘後回報', at)).toBe(at + 720_000)
  expect(promiseTime('明天 10:15 前回報', at)).toBe(Date.parse('2026-11-29T10:15:00+08:00'))
  expect(promiseTime('稍後回報', at)).toBeNull()
  expect(promiseTime('第 1 點', at)).toBeNull()
})
