// WO-164 points 7 and 8 (Chiron, WO-164 15:56Z, his words; fleet-wide, not behind LANES_WAKE_DECIDE):
//   7  after the original sentence of a send_to_agent call / mail (and a lane's reply_agent) the recipient's state as Onsen's /send answers it (0.12.2:
//      results[].recipient {state, reporting, reported_s_ago, walled_until?, waiting_for?}): one sentence for a wall, an offline main, a main on a menu,
//      a daemon that stopped reporting; nothing for any other state (idle, busy, stuck, none)
//   8  the lane card opens with when to answer. The connector fills the reference to the incoming call.
// (the daemon end to end: onsen-pull-daemon.test.ts (g))
import { test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { recipientNote } from './onsen-inbox.ts'

const L = await import('./lanes.ts?recipient-note') as typeof import('./lanes.ts')
const ws = mkdtempSync(join(tmpdir(), 'recipient-note-'))
L.lanesInit({ role: 'inbox', agent: 'adam', workspaceDir: ws, transcriptDir: ws, httpPort: 0, log: () => {}, authOk: () => false } as any)

test('point 7: a wall — with the time it ends (HH:MM in the lanes\' zone), and without one', () => {
  // 2026-11-25T07:30:00Z = 15:30 in Asia/Taipei (LANES_TZ default)
  expect(recipientNote('eve', { state: 'busy', reporting: 'live', reported_s_ago: 3, walled_until: '2026-11-25T07:30:00Z' }))
    .toBe('eve 現在撞到用量上限，約 15:30 恢復。你的訊息排著，它恢復後才會看到。')
  expect(recipientNote('eve', { state: 'idle', reporting: 'live', walled_until: Date.parse('2026-11-25T07:30:00Z') }))
    .toBe('eve 現在撞到用量上限，約 15:30 恢復。你的訊息排著，它恢復後才會看到。')
  expect(recipientNote('eve', { state: 'busy', reporting: 'live', walled: { until: null } })).toBe('eve 現在撞到用量上限。你的訊息排著，它恢復後才會看到。')
  expect(recipientNote('eve', { state: 'walled', reporting: 'live' })).toBe('eve 現在撞到用量上限。你的訊息排著，它恢復後才會看到。')
})
test('point 7: the main offline; the main on a menu; the daemon not reporting (N seconds)', () => {
  expect(recipientNote('adam', { state: 'offline', reporting: 'live', reported_s_ago: 4 }))
    .toBe('adam 的主線現在不在線上。例行的事它的分身照常處理；要主線決定的，等它回來才會看到。')
  expect(recipientNote('adam', { state: 'waiting', reporting: 'live', reported_s_ago: 4, waiting_for: 'permission prompt' }))
    .toBe('adam 的主線停在一個選單上等 Joey 按，按完之前看不到你的訊息；例行的事它的分身照常處理。')
  expect(recipientNote('adam', { state: 'idle', reporting: 'lost', reported_s_ago: 187 })).toBe('adam 已經 187 秒沒有回報狀態，可能沒在跑。訊息排著。')
  // not reporting: the state shown is the last one sent, not the present: that sentence, not the state's
  expect(recipientNote('adam', { state: 'offline', reporting: 'lost', reported_s_ago: 61.6 })).toBe('adam 已經 62 秒沒有回報狀態，可能沒在跑。訊息排著。')
})
test('point 7: every other state adds nothing (idle, busy, stuck, reporting unknown, no status row, no block)', () => {
  for (const r of [{ state: 'idle', reporting: 'live', reported_s_ago: 2 }, { state: 'busy', reporting: 'live', reported_s_ago: 2 }, { state: 'stuck', reporting: 'live' },
    { state: 'idle', reporting: 'unknown', reported_s_ago: 900 }, null, undefined, 'x'])
    expect(recipientNote('eve', r)).toBe('')
})
// WO-177 (六, last point; Chiron 02:22Z): 「要不要送」 moved to the head of the reply_agent line, for all three lines; the call parenthesis lost its half-sentence
test('point 8 (WO-177): the lane card\'s reply_agent line opens with 「先判要不要送」 (Chiron 02:22Z, verbatim); reply attribution belongs to the connector', () => {
  for (const kind of ['reflex', 'mail', 'worker', 'fork'] as const) {
    const card = L.identityCard({ kind })
    expect(card).toContain('  - reply_agent(line, to, text, …)：找別的 agent。**先判要不要送**。只有三種情況才送：有結果要交給它、你做不了、要它補東西。對方標了不用回（no_reply），或來件只是知會、測試，而你沒有要交給它的東西，就不送：「收到」「已讀」「依指示未處理」都不是一則要送的內容，它會被叫醒一個回合卻沒有東西可用。這一趟做了什麼，寫在 receipt 和給 Joey 的那一句裡。要送的時候，再判走哪一條線：三條線的規則跟艦隊的 send_to_agent 一樣，先判「要不要它動手、回答或決定？等一小時會不會壞？」。不需要誰動＝line=feed')
    expect(card).toContain('line=call（填 to、because、text）。呼叫會自動帶 thread 與 hop。')
    expect(card).not.toContain('回一則呼叫時帶 reply_to')
    expect(card).not.toContain('只在有結果、做不了、或要對方補東西時回')                    // one place keeps the rule
    expect(card.split('先判要不要送').length).toBe(2)
  }
})
