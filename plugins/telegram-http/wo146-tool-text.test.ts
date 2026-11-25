// WO-146 (telegram-http 1.47.4, agent-inbox 1.17.4): the tool descriptions carry the detail; the global file only introduces (Joey TG chiron:2253/2261
// 「認知結構原則：全域檔簡介、細節放在工具」). Chiron's words: claude-chiron/knowledge/cognition-20261125/tool-detail-gaps.md (#1, #2, #8, #10).
// Pins each sentence where the agent reads it, and the instructions budget (Claude Code cuts MCP server instructions at 2048, silently).
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CHAT_HISTORY_TOOL } from './onsen-tool.ts'
import { INBOX_TOOLS, FLEET_TOOLS } from './fleet-mail.ts'
import { INBOX_TEXT } from './inbox-text.ts'
import { ONSEN_TEXT_DEFAULT } from './fleet-text.ts'
import { mainContext } from './lanes-main.ts'
const L = await import('./lanes.ts?wo146') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'wo146-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setClaudeBin(join(import.meta.dir, 'test-fixtures', 'no-claude.sh'))
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

const SRC = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
/** the Telegram server's instructions as built, lanes off and on */
function instructions(lanesOn: boolean): string {
  const i = SRC.indexOf('instructions: [\n        // Claude Code truncates MCP server instructions at 2048')
  const j = SRC.indexOf("].join('\\n')", i)
  expect(i).toBeGreaterThan(0); expect(j).toBeGreaterThan(i)
  const arr = new Function('Lanes', 'ONSEN_TEXT_DEFAULT', `return ${SRC.slice(i + 'instructions: '.length, j + 1)}`)({ LANES_ON: lanesOn }, ONSEN_TEXT_DEFAULT) as string[]
  return arr.join('\n')
}

test('reply: the first sentence says it is the only output and the only push; the rest of the description is kept', () => {
  expect(SRC).toContain("'Reply on Telegram: the only output the sender sees and the only signal that pushes to their phone, so a result, each new stage of a long task, and anything they must decide goes out as a new reply. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or documents.'")
  expect(SRC).not.toContain("'Reply on Telegram. Pass chat_id")
})

test('format (rich): only the three modes (WO-164 Chiron 21:10Z: how to write is on the text field, wo164-onsen-format.test.ts); no [links](url)', () => {
  expect(SRC).toContain(`? "'rich'（預設）：Onsen 的 markdown rich（GFM），寫法見 text 的說明｜'text'：純文字、不做顯示處理｜'markdownv2'：Telegram 舊的跳脫模式。"`)
  expect(SRC).not.toContain("Default 'rich': write NORMAL GFM markdown")
  expect(SRC).not.toContain('[links](url)')
})

test('files: no .md attachments, TKG instead', () => {
  expect(SRC).toContain("description: 'Absolute file paths to attach. Images send as photos (inline preview); other types as documents. Max 50MB each. Do not attach .md documents or long reports: put them in TKG (share-markdown) and send the link.'")
})

test('react: a silent mark, our set, the rejected four', () => {
  expect(SRC).toContain("description: 'Add an emoji reaction to a Telegram message: a silent status mark, never a report. Telegram accepts only its fixed set; for our use: 🫡 received or starting, 👍 agree, 💯 well done, 🎉 done, 🤔 looking into it, 😢 stuck, 🔥 found it (👀 is added automatically when a message arrives). ✅ ❌ 💪 🔍 are rejected.'")
  expect(SRC).not.toContain('fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc)')
})

test('edit_message: detail inside one stage; a stage, the result, what they must see is a new reply', () => {
  expect(SRC).toContain("description: 'Edit a message the bot previously sent. Edits are silent (no push): use them for detail inside one stage; a new stage, the result, or anything they must see goes out as a new reply.'")
  expect(SRC).not.toContain('Useful for interim progress updates')
})

test('instructions: the edit_message half-sentence matches, and both shapes stay under 2000 characters', () => {
  for (const on of [false, true]) {
    const t = instructions(on)
    expect(t).toContain('react adds an emoji; edit_message adds detail inside one stage silently (no push); a new stage or the result is a NEW reply, so their phone pings.')
    expect(t).not.toContain('edit_message updates progress silently')
    expect(t.length).toBeLessThan(2000)
  }
  expect(instructions(true)).toContain('- topic/topic_name:')                       // the lanes-on shape is the longer one measured
})

test('chat_history: what was said only; what you did is in the session record, before 先查這裡', () => {
  const d = CHAT_HISTORY_TOOL.description
  const add = '這裡只有講過的話；你做了什麼（工具呼叫、改了哪些檔、指令的輸出）不在這裡，在 session 紀錄（~/.claude/projects/<工作區>/<session 編號>.jsonl）。'
  expect(d).toContain(add + '先查這裡，查不到才去翻 session 紀錄。')
  expect(d.startsWith('查之前講過什麼：你和 Joey 在這裡的每一則問答（他說的、你回的、分身推的）都在 Onsen。')).toBe(true)
  const lane = L.laneToolsFor('reflex').find((t: any) => t.name === 'chat_history')               // every lane has the same definition
  expect(lane?.description).toBe(d)
})

test('the main\'s context: topic messages are looked up with chat_history (Onsen records them in the DM\'s conversation)', () => {
  const mc = mainContext('adam', 'sid')
  expect(mc).toContain('回答前先讀那份檔，話題裡講過的用 chat_history 查。')
  expect(mc).not.toContain('Bot API 查不到話題的歷史訊息')
})

test('fan_out: a part is a lane with a lane\'s limits; file changes, builds, tests, full rights, piece-by-piece checking go to a sub-agent', () => {
  const f = L.mainToolDefs().find((t: any) => t.name === 'fan_out')
  expect(f.description).toBe("[lanes · main only] Split a task into parts checked in parallel: one lane per part, then one synthesis lane reads all results and delivers ONE conclusion to you. You read one result, not N. Each part is a lane with a lane's limits (it only looks things up and does small reversible actions, and hands its result to the synthesis, not to you or Joey). Work that changes files, runs builds or tests, needs your full tool rights, or whose output you will verify piece by piece goes to a sub-agent (Agent tool) instead.")
})

test('feed_search: what it searches and how, and feed_ask for what you have not read; INBOX_TEXT: without feed_ask, feed_search', () => {
  const want = '用一到幾個詞搜牆上的貼文（讀過的也列，只給短卡，要讀用 feed_open）；開工前看跟這件事有關、還沒讀過的，用 feed_ask。'
  expect(INBOX_TOOLS.find(t => t.name === 'feed_search')!.description).toBe(want)
  expect(FLEET_TOOLS.find(t => t.name === 'feed_search')!.description).toBe(want)
  expect(INBOX_TEXT).toContain('- 動態不會來找你。開始處理一件事之前，先問牆一次（feed_ask，一句話寫你要處理什麼），跟它有關、你還沒讀過的貼文會直接給你。工具清單上沒有 feed_ask 的，用 feed_search 給一到幾個詞。\n')
  expect(INBOX_TEXT.length).toBeLessThan(2000)                                     // under both measured caps (2048 on 11-06, 4096 on 11-16)
})
