// WO-157c (Chiron, WO-157 comment 15:25Z, item 1): an item whose turn was interrupted (Esc: statusIdle closes the turn; a turn that never got Stop: the
// next prompt's beginTurn) does not open a turn on its own. It rides the next thing the main is given, after it, with Chiron's line in front:
//   - nothing sent after Esc: no offer, no alarm (1.55.1 offered it again and the main began a new turn 4 s after Esc)
//   - a message that came in after Esc (or during the cut turn) is offered at once, the cut item riding; one offer, one turn
//   - a turn the main starts by itself pulls the cut item at its first boundary, with the line
//   - a colleague's / scheduler's / alert's cut item that no new turn took within MAIN_STUCK_MS goes the untaken path (Joey told, offered once more);
//     Joey's own never does
//   - an offer nobody took gives the rider its hold back (the lease)
// M1 + M2 alone (createMain over a fresh journal): no daemon, no network.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createMain, INTERRUPTED_LINE, MAIN_STUCK_MS, OFFER_LEASE_MS, __setMainIdleConfirmMs } from './lanes-main.ts'
import { Journal } from './lanes-state.ts'

__setMainIdleConfirmMs(0)
afterAll(() => __setMainIdleConfirmMs(4_000))
const SID = 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', PID = 424242
let np = 0, nm = 500

async function bench() {
  const offers: any[] = [], told: Array<{ text: string; rule: string }> = []
  const E = { journal: new Journal(join(mkdtempSync(join(tmpdir(), 'esc-hold-')), 'state.jsonl')), agent: 'adam', log: () => {},
    offer: async (notif: any) => { offers.push(notif); return true }, streamOpen: () => true, info: () => null, done: () => {}, undone: () => {},
    tellJoey: (text: string, rule: string) => { told.push({ text, rule }) }, expectedSession: () => [SID], pidAlive: () => true, refused: () => {},
    genChanged: () => {}, context: () => 'rules' }
  const M = createMain(E as any)
  M.initMain()
  await M.mainEvent({ event: 'SessionStart', pid: PID, session_id: SID, source: 'startup' })
  const hook = (event: string, o: Record<string, unknown> = {}) => M.mainEvent({ event, pid: PID, session_id: SID, ...o } as any)
  const send = async (kind: 'joey' | 'peer', text: string): Promise<string> => {
    const mid = String(++nm)
    const meta = kind === 'joey' ? { chat_id: '1', message_id: mid, user: 'joey' } : { chat_id: 'eve', user: 'eve', btcc_msg_id: mid }
    const id = M.enqueue(kind, { method: 'notifications/claude/channel', params: { content: text, meta } }, { via: kind === 'joey' ? 'tg' : 'inbox', event: `ev-${mid}` })
    await M.pump()
    return id
  }
  const row = (id: string) => M.items(r => r.id === id)[0]
  const dids = (n: any): string[] => String(n.params.meta.did).split(',')
  /** the main takes the offer in (its prompt names the dids), opens a tool, and Joey presses Esc: statusOf idle twice, no hook event between */
  const takeAndEsc = async (): Promise<string> => {
    const p = `p-${++np}`
    await hook('UserPromptSubmit', { prompt_id: p, dids: dids(offers.at(-1)) })
    await hook('PreToolUse', { prompt_id: p, tool_name: 'Bash', tool_input: { command: 'sleep 60' } })
    expect(M.statusIdle(true)).toBe(false)
    expect(M.statusIdle(true)).toBe(true)
    expect(M.mainPhase()).toBe('idle')
    return p
  }
  return { M, offers, told, hook, send, row, dids, takeAndEsc }
}

test('Esc, then nothing: the cut item is held (queued, reason interrupted, cut_at); no offer and no alarm, even past MAIN_STUCK_MS', async () => {
  const b = await bench()
  const a = await b.send('joey', '數 60 秒的 sha256')
  expect(b.offers.length).toBe(1)
  await b.takeAndEsc()
  expect(b.row(a)).toMatchObject({ state: 'queued', reason: 'interrupted' })
  expect(typeof b.row(a).cut_at).toBe('string')
  await b.M.pump(); await b.M.tick()
  await b.M.tick(Date.now() + MAIN_STUCK_MS + 60_000)
  expect(b.offers.length).toBe(1)                                          // the main is not woken to do again what Joey stopped
  expect(b.told).toEqual([])                                               // Joey's own item: neither the untaken path nor 主線收不到訊息
})

test('Esc, then a new message: offered within the same pump, the cut item riding after it with Chiron\'s line in front; one prompt binds both', async () => {
  const b = await bench()
  const a = await b.send('joey', '數 60 秒的 sha256')
  await b.takeAndEsc()
  const c = await b.send('joey', '收到 2 嗎')
  expect(b.offers.length).toBe(2)
  const n = b.offers[1], text = String(n.params.content)
  expect(b.dids(n)).toEqual([c, a])
  expect(n.params.meta.message_id).toBe(String(nm))                        // the offer is the new message's own
  expect(text.startsWith('收到 2 嗎\n')).toBe(true)
  expect(text).toContain(`\n${INTERRUPTED_LINE}\n<channel source="telegram" `)
  expect(text.indexOf(INTERRUPTED_LINE)).toBeLessThan(text.indexOf('數 60 秒的 sha256'))
  expect(text).toContain(`did="${a}"`)
  const p = `p-${++np}`
  await b.hook('UserPromptSubmit', { prompt_id: p, dids: b.dids(n) })
  expect([b.row(a).state, b.row(c).state]).toEqual(['bound', 'bound'])
  expect([b.row(a).prompt_id, b.row(c).prompt_id]).toEqual([p, p])
})

test('a message that came in during the cut turn (never in the conversation) is offered as soon as the turn is closed, the cut item riding', async () => {
  const b = await bench()
  const a = await b.send('joey', '第一則')
  const p = `p-${++np}`
  await b.hook('UserPromptSubmit', { prompt_id: p, dids: b.dids(b.offers[0]) })
  await b.hook('PreToolUse', { prompt_id: p, tool_name: 'Bash' })
  const c = await b.send('joey', '第二則')                                  // the main is in its turn: queued, not offered
  expect(b.offers.length).toBe(1)
  expect(b.M.statusIdle(true)).toBe(false); expect(b.M.statusIdle(true)).toBe(true)
  await b.M.pump()
  expect(b.offers.length).toBe(2)
  expect(b.dids(b.offers[1])).toEqual([c, a])
  expect(String(b.offers[1].params.content)).toMatch(new RegExp(`^第二則\\n${INTERRUPTED_LINE.replace(/[()（）]/g, '.')}\\n<channel `))
})

test('a turn the main starts by itself pulls the cut item at its first boundary, the line in front of it', async () => {
  const b = await bench()
  const a = await b.send('joey', '第一則')
  await b.takeAndEsc()
  const p = `p-${++np}`
  await b.hook('UserPromptSubmit', { prompt_id: p })                      // Joey typed on the screen (no item named)
  expect(b.row(a).state).toBe('queued')
  const r: any = await b.hook('PostToolUse', { prompt_id: p, tool_name: 'Read' })
  expect(String(r.additionalContext)).toContain('〔交給主線｜')
  expect(String(r.additionalContext)).toContain(`${INTERRUPTED_LINE}\n<channel source="telegram" `)
  expect(b.row(a)).toMatchObject({ state: 'bound', prompt_id: p })
  expect(b.offers.length).toBe(1)
})

test('a turn that never got its Stop (the next prompt began): its items are held and pulled into the new turn with the line, never offered alone', async () => {
  const b = await bench()
  const a = await b.send('joey', '第一則')
  const p1 = `p-${++np}`, p2 = `p-${++np}`
  await b.hook('UserPromptSubmit', { prompt_id: p1, dids: b.dids(b.offers[0]) })
  await b.hook('PreToolUse', { prompt_id: p1, tool_name: 'Bash' })
  await b.hook('UserPromptSubmit', { prompt_id: p2 })
  expect(b.row(a)).toMatchObject({ state: 'queued', reason: 'interrupted' })
  const r: any = await b.hook('Stop', { prompt_id: p2 })
  expect(String(r.block)).toContain(`${INTERRUPTED_LINE}\n<channel source="telegram" `)
  expect(b.offers.length).toBe(1)
})

test('a colleague\'s cut item no new turn took within MAIN_STUCK_MS: the untaken path (Joey told in its words, offered once more, the line first); Joey\'s cut item rides it', async () => {
  const b = await bench()
  const a = await b.send('peer', 'eve：幫我跑一下備份')
  await b.takeAndEsc()
  await b.M.tick(Date.now() + MAIN_STUCK_MS - 60_000)
  expect(b.offers.length).toBe(1); expect(b.told).toEqual([])             // within MAIN_STUCK_MS: held
  const later = Date.now() + MAIN_STUCK_MS + 1_000
  await b.M.tick(later)
  expect(b.told.length).toBe(1)
  expect(b.told[0].rule).toBe('main-stuck')
  expect(b.told[0].text).toMatch(/^主線疑似卡死：交給它的訊息 \d+ 分鐘沒有被接手（行程還活著，但沒有開始新的回合）。有 1 則訊息等它，我再交給它一次。$/)
  expect(b.offers.length).toBe(2)
  expect(b.dids(b.offers[1])).toEqual([a])
  expect(String(b.offers[1].params.content)).toBe(`${INTERRUPTED_LINE}\neve：幫我跑一下備份`)
  expect(b.row(a)).toMatchObject({ state: 'offered', reason: 'interrupted_untaken' })
  await b.M.tick(later + 1_000)
  expect(b.told.length).toBe(1)                                            // one notice per episode

  const j = await bench()                                                  // Joey's and a colleague's item cut in one turn
  const x = await j.send('joey', 'Joey 的')
  const p = `p-${++np}`
  await j.hook('UserPromptSubmit', { prompt_id: p, dids: j.dids(j.offers[0]) })
  const y = await j.send('peer', '同事的')
  await j.hook('PostToolUse', { prompt_id: p, tool_name: 'Read' })        // pulled into the turn
  await j.hook('PreToolUse', { prompt_id: p, tool_name: 'Bash' })
  expect(j.M.statusIdle(true)).toBe(false); expect(j.M.statusIdle(true)).toBe(true)
  await j.M.pump()                                                         // the pump statusIdle started (one offer at a time) is over
  expect(j.offers.length).toBe(1)
  await j.M.tick(Date.now() + MAIN_STUCK_MS + 1_000)
  expect(j.dids(j.offers[1])).toEqual([y, x])                              // the colleague's leads; Joey's rides it, never alone
  expect(j.row(x).reason).toBe('interrupted')
})

test('an offer nobody took: the lease writes the rider back held, so the next offer carries it again', async () => {
  const b = await bench()
  const a = await b.send('joey', '第一則')
  await b.takeAndEsc()
  const c = await b.send('joey', '第二則')
  expect(b.dids(b.offers[1])).toEqual([c, a])
  await b.M.tick(Date.now() + OFFER_LEASE_MS + 1_000)
  expect(b.row(a).reason).not.toBe('offer_untaken')
  expect(b.offers.length).toBe(3)
  expect(b.dids(b.offers[2])).toEqual([c, a])
})
