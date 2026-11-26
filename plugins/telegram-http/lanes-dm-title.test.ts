// 1.58.13: a DM thread is named after the person on that Telegram account (lanes-threads.ts threadTitle `person`), not a fixed 「Joey 私訊」 (lab-relay's
// test account was titled 「Joey 私訊」 too). The person: the Onsen member the account is (onsen-client.ts memberOfTg, the mapping the blockers' person
// uses), by its display name, else its member name (MemberNames, asked once). A topic keeps 「／<話題名>」. TITLE_V 4 retitles the open DM threads once;
// a DM whose person is not known yet waits for refreshDmTitles (server.ts calls it when Onsen answered); no other thread changes.
import { test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { threadTitle, TITLE_V } from './lanes-threads.ts'
import { MemberNames } from './onsen-client.ts'

test('the title: 「<person> 私訊」, 「<person> 私訊／<話題名>」 in a topic; no person: 「Joey 私訊」 as before; a group keeps its first line; TITLE_V 4', () => {
  expect(TITLE_V).toBe(4)
  expect(threadTitle('tg', 'tg:6736970916', { kind: 'joey_tg', text: '請只回：收到', person: 'Joey 測試帳號' })).toBe('Joey 測試帳號 私訊')
  expect(threadTitle('tg', 'tg:6736970916:77', { kind: 'joey_tg', text: 'x', topic_name: 'Onsen 設計', person: 'Joey 測試帳號' })).toBe('Joey 測試帳號 私訊／Onsen 設計')
  expect(threadTitle('tg', 'tg:6736970916:78', { kind: 'joey_tg', text: 'x', person: 'joey-test' })).toBe('joey-test 私訊／#78')
  expect(threadTitle('tg', 'tg:1828173984', { kind: 'joey_tg', text: '在嗎' })).toBe('Joey 私訊')
  expect(threadTitle('tg', 'tg:-1001234', { kind: 'joey_tg', text: '群組裡的第一句', person: 'Joey 測試帳號' })).toBe('群組裡的第一句')
})

test('the person: the account\'s Onsen member by its display name, asked once; else the member name; an account that is no member: tg-<id>', async () => {
  const asked: string[] = []
  let changed = 0
  const names: Record<string, { status: number; json: any } | Error> = {
    'joey-test': { status: 200, json: { data: { name: 'joey-test', display_name: '  Joey  測試帳號 ' } } },
    joey: { status: 200, json: { data: { name: 'joey', display_name: '' } } },
    'tg-555': new Error('connect ECONNREFUSED'),
  }
  const m = new MemberNames({ get: async n => { asked.push(n); const r = names[n]; if (r instanceof Error) throw r; return r ?? { status: 404, json: {} } }, changed: () => { changed++ } })
  expect(m.personOf('6736970916')).toBeNull()                                     // not known yet
  expect(m.personOf('6736970916')).toBeNull()
  await new Promise(r => setTimeout(r, 10))
  expect(m.personOf('6736970916')).toBe('Joey 測試帳號')
  expect(m.personOf('1828173984')).toBeNull(); await new Promise(r => setTimeout(r, 10))
  expect(m.personOf('1828173984')).toBe('joey')                                   // no display name: the member name
  expect(m.personOf('555')).toBeNull(); await new Promise(r => setTimeout(r, 10))
  expect(m.personOf('555')).toBe('tg-555')                                         // Onsen did not answer: the (guest) member name
  expect(asked).toEqual(['joey-test', 'joey', 'tg-555'])                          // once each
  expect(changed).toBe(3)
})

test('the start retitles the open DM threads once their person is known (refreshDmTitles), the topic\'s name kept; no other thread changes', async () => {
  const d = mkdtempSync(join(tmpdir(), 'lanes-dm-title-'))
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'router.json'), readFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), 'utf8'))
  const th = (id: string, kk: string, key: string, title: string, extra: Record<string, unknown> = {}) =>
    ({ id, lane: 'main', peer: null, hops: 0, tokens: 0, created: '2026-11-26T05:00:00Z', last: '2026-11-26T05:00:00Z', key_kind: kk, key, title, title_v: 3, state: 'open', ...extra })
  const threads: Record<string, any> = {
    'r#t-dm': th('r#t-dm', 'tg', 'tg:6736970916', 'Joey 私訊'),
    'r#t-topic': th('r#t-topic', 'tg', 'tg:6736970916:77', 'Joey 私訊／Onsen 設計'),
    'r#t-grp': th('r#t-grp', 'tg', 'tg:-1001234', '群組裡的第一句'),
    'r#t-tick': th('r#t-tick', 'ticket', '181', 'WO-181 點名你的動態'),
    'r#t-closed': th('r#t-closed', 'tg', 'tg:6736970916:9', 'Joey 私訊／舊話題', { state: 'closed' }),
  }
  const sent: Record<string, any> = Object.fromEntries(Object.keys(threads).map(id => [id, { owner: 'main', state: threads[id].state, item: null, n: 2 }]))
  writeFileSync(join(d, 'state.json'), JSON.stringify({ threads, thread_sent: sent, thread_epoch: 'ep0', thread_sync_at: '2026-11-26T05:01:00.000Z' }))
  let person: string | null = null
  const prev = process.env.LANES_DIR
  process.env.LANES_DIR = d; process.env.LANES_WAKE_DECIDE = 'r'
  try {
    const R = await import('./lanes.ts?lanes-dm-title') as typeof import('./lanes.ts')
    R.lanesInit({ role: 'tg', agent: 'r', workspaceDir: d, transcriptDir: d, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => [],
      sendBot: async () => 1, joeyChatId: () => '6736970916', mainStatus: () => ({ state: 'idle', detail: {} }), dmPerson: () => person } as any)
    const S = R.__lanesState()
    // at start the person is not known yet: the DMs wait; the ticket is version 4 now and keeps its title
    expect(S.threads['r#t-dm']).toMatchObject({ title: 'Joey 私訊', title_v: 3 })
    expect(S.threads['r#t-tick']).toMatchObject({ title: 'WO-181 點名你的動態', title_v: TITLE_V })
    person = 'Joey 測試帳號'
    expect(R.refreshDmTitles()).toBe(2)
    expect(S.threads['r#t-dm']).toMatchObject({ title: 'Joey 測試帳號 私訊', title_v: TITLE_V })
    expect(S.threads['r#t-topic']).toMatchObject({ title: 'Joey 測試帳號 私訊／Onsen 設計', title_v: TITLE_V })
    expect(S.threads['r#t-grp'].title).toBe('群組裡的第一句')
    expect(S.threads['r#t-closed'].title).toBe('Joey 私訊／舊話題')
    expect(S.thread_sent!['r#t-dm'].title).toBe('Joey 私訊')                           // what Onsen holds: the old title, so the sync tells it the new one
    const row = readFileSync(join(d, 'lanes.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(r => r.kind === 'thread_retitled')
    expect(row).toMatchObject({ why: 'person', n: 2 })
    expect(R.refreshDmTitles()).toBe(0)                                             // once
  } finally { if (prev === undefined) delete process.env.LANES_DIR; else process.env.LANES_DIR = prev; delete process.env.LANES_WAKE_DECIDE }
})
