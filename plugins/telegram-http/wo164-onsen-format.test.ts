// WO-164 (Chiron 21:10Z; Joey TG chiron:2523 20:59Z 「你要講的是我們 Onsen 的通訊軟體的文字格式預設是這種 markdown rich 的啊」): Onsen's text format, one constant
// (fleet-text.ts ONSEN_TEXT_FORMAT, Chiron's words verbatim), in the description of the field the words are written in (text; body for mailbox_reply) of
// every tool that writes words to Onsen, after what that field already said; the tools' own descriptions unchanged. `format` (rich) names only the three
// modes. Both servers' instructions: the one sentence ONSEN_TEXT_DEFAULT in their top paragraph.
import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ONSEN_TEXT_FORMAT, ONSEN_TEXT_DEFAULT, withOnsenFormat } from './fleet-text.ts'
import { INBOX_TOOLS, FLEET_TOOLS } from './fleet-mail.ts'
import { INBOX_TEXT } from './inbox-text.ts'
const L = await import('./lanes.ts?wo164-onsen-format') as typeof import('./lanes.ts')

const CHIRON = 'Onsen 的文字預設是 markdown rich（GFM）：這裡寫的字存成 markdown，各個客戶端（Telegram、Onsen 的畫面）照樣畫出來，不用跳脫。內容需要什麼就用什麼：`##`／`###` 標題分區塊；`-` 清單和編號清單；段落、區塊之間留空行；表格（| a | b |）放要對照的資料；**粗體** 標重點；`code` 和 ```程式區塊``` 放路徑、指令、名稱；> 引言。連結獨立一行、裸網址、前後不黏字或符號（不用 [文字](網址)）。'
const SRC = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
/** a Telegram tool in server.ts as the tools list builds it: its description and its text field's description */
function tgTool(name: string): { description: string; text: string } {
  const i = SRC.indexOf(`      name: '${name}',\n      description:`)
  expect(i).toBeGreaterThan(0)
  const from = SRC.indexOf('description:', i) + 'description:'.length
  const to = SRC.indexOf('\n      inputSchema:', from)
  const description = new Function(`return (${SRC.slice(from, to).trim().replace(/,\s*$/, '')})`)() as string
  const block = SRC.slice(to, SRC.indexOf('\n    },\n', to))
  const m = block.match(/\n {10}text: \{ type: 'string', description: (.*?) \},/)
  expect(m).toBeTruthy()
  return { description, text: new Function('withOnsenFormat', `return (${m![1]})`)(withOnsenFormat) as string }
}

test('the constant is Chiron\'s paragraph, word for word; one source', () => {
  expect(ONSEN_TEXT_FORMAT).toBe(CHIRON)
  expect(ONSEN_TEXT_DEFAULT).toBe('Onsen 的文字預設是 markdown rich。')
  for (const f of ['server.ts', 'lanes.ts', 'fleet-mail.ts', 'inbox-text.ts']) expect(readFileSync(join(import.meta.dir, f), 'utf8')).not.toContain('這裡寫的字存成 markdown')   // never copied
})
test('telegram-http reply and edit_message: the text field carries the format and the descriptions distinguish a reply from an edit', () => {
  const r = tgTool('reply'), e = tgTool('edit_message')
  expect(r.text).toBe(CHIRON)
  expect(e.text).toBe(CHIRON)
  expect(r.description).toBe('Reply on Telegram: the only output the sender sees and the only signal that pushes to their phone, so a result, each new stage of a long task, and anything they must decide goes out as a new reply. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or documents.')
  expect(e.description).toBe('改你先前說的一則。靜默（不推播）：只用在同一個階段裡補細節；新的階段、結果、對方一定要看到的事，發新的一則。')
})
test('format (rich): the three modes only; the plain branch as it was', () => {
  const i = SRC.indexOf('const formatSchema = {'), j = SRC.indexOf('\n }\n', i)
  const f = SRC.slice(i, j)
  expect(f).toContain(`? "'rich'（預設）：Onsen 的 markdown rich（GFM），寫法見 text 的說明｜'text'：純文字、不做顯示處理｜'markdownv2'：Telegram 舊的跳脫模式。"`)
  for (const mode of ["'rich'", "'text'", "'markdownv2'"]) expect(f.split('\n').find(l => l.trimStart().startsWith('? "'))!).toContain(mode)
  expect(f).toContain(`: "Rendering mode. 'markdownv2' enables Telegram formatting (bold, italic, code, links). Caller must escape special chars per MarkdownV2 rules. Default: 'text' (plain, no escaping needed).",`)
})
test('the lanes: notify_joey, ask_joey, reply_agent: the text field carries it; their own descriptions do not', () => {
  for (const name of ['notify_joey', 'ask_joey', 'reply_agent']) {
    const t = L.LANE_TOOLS.find(x => x.name === name)! as any
    expect(t.inputSchema.properties.text.description).toBe(CHIRON)
    expect(t.description).not.toContain('markdown rich')
  }
})
test('agent-inbox send_to_agent (every line writes `text`) and mailbox_reply (`body`): after what the field said; the mail lane\'s mailbox_reply is the same tool', () => {
  const send = INBOX_TOOLS.find(t => t.name === 'send_to_agent')! as any
  expect(send.inputSchema.properties.text.description).toBe(`必填。${CHIRON}`)
  expect(send.description).not.toContain('markdown rich')
  const rep = INBOX_TOOLS.find(t => t.name === 'mailbox_reply')! as any
  expect(rep.inputSchema.properties.body.description).toBe(`內容。最多 3500 字。${CHIRON}`)
  expect(FLEET_TOOLS.find(t => t.name === 'mailbox_reply')).toBe(rep)
  expect((L.MAIL_LANE_TOOLS.find(t => t.name === 'mailbox_reply') as any).inputSchema.properties.body.description).toBe(`內容。最多 3500 字。${CHIRON}`)
})
test('instructions: both servers\' top paragraph carries the one sentence (not the paragraph)', () => {
  const i = SRC.indexOf("        '這是你和對方的對話，存在 Onsen；")
  expect(SRC.slice(i, SRC.indexOf('\n', i))).toBe("        '這是你和對方的對話，存在 Onsen；對方用 Telegram 或 Onsen 的網頁看它，看不到你的 session。要讓對方看到的，只有 reply（chat_id 照進來那一則的填）。reply_to 只在要引用先前某一則時用。' + ONSEN_TEXT_DEFAULT,")
  const top = INBOX_TEXT.split('\n\n')[1]
  expect(top.startsWith('你要讓另一隻 agent 知道或去做任何事，都用 send_to_agent。')).toBe(true)
  expect(top.endsWith(`用了比需要更高的一條，就是濫用。${ONSEN_TEXT_DEFAULT}`)).toBe(true)
  expect(INBOX_TEXT).not.toContain('這裡寫的字存成 markdown')
  expect(INBOX_TEXT.split(ONSEN_TEXT_DEFAULT).length).toBe(2)
})
