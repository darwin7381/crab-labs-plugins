// The digest: a renderer over M3, not a mechanism. One line per event changed since the last digest that was done; at most 8 lines, in this order:
// owed to the main, waiting on Joey's decision, the rest; the overflow named on one line. The failures of class F (002e separator, 002k B15, 002m L6B5,
// inv F(2) 8-line limit exceeded, F(3) open proposals dropped, F(4) the separator lies, F(5) two "happened" chains) are played on the event records.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { renderEvents, DIGEST_MAX_LINES } from './lanes-digest.ts'
const L = await import('./lanes.ts?digest-m3-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-digest-m3-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'] } as any)
const st = L.__lanesState(), E = () => L.__events()
let n = 0
function lane(): string {
  const id = `adam.reflex.${++n}`
  st.lanes[id] = { id, kind: 'reflex', n, session_id: 's', thread: `adam#t-${n}`, status: 'idle', created: '', last: '', transcript: '/x', runs: 1, tokens_in: 0, tokens_out: 0 } as any
  return id
}
function event(o: { from?: string; text: string; obligations: any[]; cls?: any; did?: string }): string {
  const l = lane(), id = `ev-dg-${n}`
  E().open(id, { class: o.cls ?? 'peer', owner: l, lane: l, from: o.from ?? 'eve', text: o.text, obligations: o.obligations })
  if (o.did) E().note(id, { did: o.did })
  return id
}
const content = (text: string) => text.split('\n').slice(1, -1)                                  // without the header and the footnote
// a digest that reached the main and ended done: a digest item in the journal (what digestInfo reads what was shown from)
let dgN = 0
const done = (t: any) => L.__journal().write('msg', `dg-test-${++dgN}`, 'done', { kind: 'digest', events: t.fields.events })
const seen = (): Record<string, number> => { const o: Record<string, number> = {}; for (const r of L.__main().items(r => r.kind === 'digest' && r.state === 'done')) for (const [k, v] of Object.entries(r.events ?? {})) o[k] = Math.max(o[k] ?? 0, Number(v)); return o }

test('one line per event, from its record: who handled it, what happened, where each obligation stands; the main\'s own events are not in it', () => {
  const a = event({ text: '下週維護幾點？', did: '回覆 Eve：週三 02:00', obligations: [{ kind: 'joey', level: 'line', state: 'met' }, { kind: 'peer', level: 'answer', to: 'eve', state: 'met' }] })
  E().note(a, { joey_tier: 'silent', answered: '週三 02:00' })
  E().note(a, { said: 'Eve 問維護，回 02:00' })                                                  // several writes on one event: still one line (F(5))
  E().open('ev-dg-main', { class: 'joey', owner: 'main', from: 'joey', text: 'Joey 問主線的事', obligations: [{ kind: 'main', level: 'handed', owner: 'main' }] })
  const d = L.__digest()!
  const lines = content(d.text)
  expect(lines.length).toBe(1)
  expect(lines[0]).toMatch(/^• \d\d-\d\d \d\d:\d\d｜反射線#\d+｜/); expect(lines[0]).toContain('回覆 Eve：週三 02:00')
  expect(lines[0]).toContain('已通知 Joey（靜默），不要重複通知他'); expect(lines[0]).toContain('已回 eve')
  expect(d.text).not.toContain('Joey 問主線的事')
  done(d)
  expect(L.__digest()).toBeNull()                                                                   // done: not shown again until it changes
  E().note(a, { did: '又問了一次，同樣回 02:00' })
  expect(content(L.__digest()!.text)[0]).toContain('又問了一次')
  done(L.__digest())
})

test('a change in the same millisecond as the digest is still a change: the digest compares record versions, not timestamps', () => {
  const a = event({ text: '同一毫秒', obligations: [{ kind: 'joey', level: 'line', state: 'met' }] })
  const d = L.__digest()!; done(d)
  for (let i = 0; i < 50; i++) { E().note(a, { did: `第 ${i} 次` }); expect(content(L.__digest()!.text)[0]).toContain(`第 ${i} 次`); done(L.__digest()) }
  expect(E().get(a)!.version).toBe(1 + 50)                                                        // the fold counts the record's lines
  expect(seen()[a]).toBe(51)
})

test('002k B15, 002m L6B5, inv F(2): at most 8 lines however many events changed; the order is owed to the main, waiting on Joey, the rest; the overflow is named on one line', () => {
  const ids: string[] = []
  for (let i = 0; i < 9; i++) ids.push(event({ text: `例行 ${i}`, cls: 'scheduled', obligations: [{ kind: 'joey', level: 'line', state: 'met' }] }))
  const ask = event({ text: '憑證要續約嗎？', cls: 'scheduled', obligations: [{ kind: 'joey', level: 'decision', state: 'met' }] })
  const hand = event({ text: 'Eve 要主線答應週五', obligations: [{ kind: 'main', level: 'handed', owner: 'main', state: 'open', handoff: 'ho-abc', what: 'Eve 要主線答應週五交報告' }] })
  const d = L.__digest()!
  const lines = content(d.text)
  expect(lines.length).toBe(DIGEST_MAX_LINES)
  expect(lines[0]).toContain('需主線：〔ho-abc〕Eve 要主線答應週五交報告')
  expect(lines[1]).toContain('已請 Joey 決定，不要重複通知他')
  expect(lines.at(-1)).toMatch(/^另有 \d+ 件沒列出：/)
  expect(lines.filter(l => l.startsWith('•')).length).toBe(DIGEST_MAX_LINES - 1)
  done(d)
  for (const id of [...ids, ask, hand]) expect(d.fields.events[id]).toBe(E().get(id)!.version)
})

test('inv F(3): an open proposal from Joey is a line owed to the main in every digest until it is decided, and is never the line that is cut', () => {
  // PL1: a proposal lives on the M3 record of the event whose run filed it (the ledger line is only its audit)
  const pe = event({ text: 'Joey：記住週報', obligations: [] })
  E().push(pe, 'proposals', { id: 'mp-f3', text: '記住：週報一律 09:00', joey: true, at: new Date().toISOString(), lane: 'adam.worker.1' })
  for (let i = 0; i < 12; i++) event({ text: `事件 ${i}`, obligations: [] })
  const d = L.__digest()!
  const lines = content(d.text)
  expect(lines.length).toBe(DIGEST_MAX_LINES)
  expect(lines.some(l => l.includes('記憶提案 mp-f3') && l.includes('需主線'))).toBe(true)
  done(d)
  expect(L.__digest()!.text).toContain('mp-f3')                                                     // still listed with nothing else new
  E().note(pe, { proposals: [{ id: 'mp-f3', text: '記住：週報一律 09:00', joey: true, at: new Date().toISOString(), lane: 'adam.worker.1', decision: 'veto' }] })
})

test('002e, inv F(4): no separator that can lie: what is the main\'s says 需主線 on its own line, the rest says what Joey already has; the summary gate\'s parser reads the items', () => {
  const r = renderEvents([{ id: 'a', group: 2, label: 'x', line: '• 11-17 10:00｜反射線#1｜...｜來自 eve｜已通知 Joey（靜默），不要重複通知他' }, { id: 'b', group: 0, label: 'y', line: '• 11-17 10:01｜反射線#2｜...｜來自 eve｜需主線：〔ho-1〕答應 Eve' }], [], 'digest')!
  expect(r.text).not.toContain('以下只是讓你知道')
  expect(r.text.split('\n')[1]).toContain('需主線'); expect(r.text.split('\n')[0]).toStartWith('〔車道摘要｜')
  const py = `import importlib.util,sys\nspec=importlib.util.spec_from_file_location('g','${join(import.meta.dir, 'lanes-hooks', 'main-summary-gate.py')}')\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nprint(len(m.digest_items(sys.stdin.read())))`
  const out = Bun.spawnSync(['python3', '-c', py], { stdin: new TextEncoder().encode(r.text), env: { PATH: process.env.PATH ?? '', PYTHONIOENCODING: 'utf-8' } })
  expect(out.stdout.toString().trim()).toBe('1')                                                    // the lanes' own item; the 需主線 one is the main's to report
})

// ------------------------------------------------------------------ the activity list: the same renderer, the day view
const ITEM = /^• (\d\d-\d\d) (\d\d:\d\d)｜([^｜]+)｜(.*)$/                                        // main-summary-gate.py's ITEM: how the gate reads the list

test('the activity list is the M3 renderer: ledger_query() gives the digest\'s own lines for every event of the day, with no 8-line limit; the main\'s events are not in it', () => {
  const ids: string[] = []
  for (let i = 0; i < 12; i++) ids.push(event({ text: `活動 ${i}：例行檢查`, cls: 'scheduled', did: `第 ${i} 件做完`, obligations: [{ kind: 'joey', level: 'line', state: 'met' }] }))
  const hand = event({ text: 'Eve 要主線決定稿件排程', obligations: [{ kind: 'main', level: 'handed', owner: 'main', state: 'open', handoff: 'ho-act', what: 'Eve 要主線決定稿件排程' }] })
  E().open('ev-act-main', { class: 'joey', owner: 'main', from: 'joey', text: 'Joey 直接問主線的事', obligations: [{ kind: 'main', level: 'handed', owner: 'main' }] })
  const digest = L.__digest()!
  const day = L.ledgerQueryTool({})
  const lines = day.split('\n')
  const all = E().rows(e => e.owner !== 'main' && !!e.lane)
  expect(lines[0]).toStartWith(`活動清單：${all.length} 件事（最近 24 小時）`)
  const body = lines.filter(l => l.startsWith('• '))
  expect(body.length).toBe(all.length)                                                              // every event, past 8
  expect(body.length).toBeGreaterThan(DIGEST_MAX_LINES)
  expect(day).not.toContain('另有 ')
  expect(day).not.toContain('Joey 直接問主線的事')
  for (let i = 0; i < ids.length; i++) expect(day).toContain(`第 ${i} 件做完`)
  for (const l of content(digest.text).filter(l => l.startsWith('• '))) expect(body).toContain(l)   // the digest's lines, word for word
  const owed = body.findIndex(l => !l.includes('需主線：'))                                            // the same order: owed to the main first
  expect(body.slice(0, owed).some(l => l.includes('需主線：〔ho-act〕'))).toBe(true); expect(body.slice(owed).some(l => l.includes('需主線：'))).toBe(false)
  for (const l of body) expect(ITEM.test(l)).toBe(true)                                              // the summary gate can read every line
  done(digest)
  expect(L.ledgerQueryTool({}).split('\n').filter(l => l.startsWith('• ')).length).toBe(all.length)    // a done digest does not shorten the day
})

test('the activity list window: since narrows it (ISO or relative), a bad since is explained; a filtered query still reads the ledger entries', () => {
  expect(L.ledgerQueryTool({ since: new Date(Date.now() + 60_000).toISOString() })).toMatch(/^活動清單：0 件事（\d\d-\d\d \d\d:\d\d 起）/)
  expect(L.ledgerQueryTool({ since: '-1h' }).split('\n')[0]).toMatch(/^活動清單：\d+ 件事/)
  expect(L.ledgerQueryTool({ since: 'yesterday' })).toContain('since 格式不對')
  expect(L.ledgerQueryTool({ kind: 'receipt' })).not.toStartWith('活動清單')
})
