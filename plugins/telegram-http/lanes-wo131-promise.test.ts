// telegram-http 1.38.3 (WO-131 D): a report of what was done is not a commitment; an explicit promise for later still is. Every reply sonn's main sent Joey
// from 11-23 13:37Z to 11-24 01:25Z (and some of its mails) was in the ledger as kind commitment, from main-send, auto, with the whole message text:
// 19 of 42 sends checked, p 0.72-0.99. Jev's question (「Does `message` say that its sender will do or deliver something later?」) is answered right on a
// status report, which names its next steps. Now only the sentences with an explicit form of a promise for later are asked, and they are the record.
// The texts below are the real ones (sonn's transcript, the sends' ledger rows / jev-calls.jsonl of 11-23 / 11-24). Jev is a stand-in that answers as Jev
// did on them: 0.99 for everything (so the form is what decides).
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promiseSentences, commitmentFromReport } from './lanes-followup.ts'
let jev: any, jevCalls: any[] = []
beforeAll(() => {
  jev = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const b: any = await req.json(); jevCalls.push(b)
    return Response.json({ answers: { promises: { type: 'noul', noul: 0.99 }, deadline: { type: 'noul', noul: 0.05 } } })
  } })
  process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${jev.port}`; process.env.TYPESAFE_API_KEY = 'k'
})
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?wo131-promise') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-wo131p-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
L.lanesInit({ role: 'tg', agent: 'sonn', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => true, registryNames: () => ['chiron', 'mnemosyne'],
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
afterAll(() => { jev.stop(true); for (const k of ['LANES_FLOOD_CONTROL', 'LANES_PROMISE_FORM', 'TYPESAFE_BASE_URL', 'TYPESAFE_API_KEY']) delete process.env[k] })
const rows = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const commitments = () => rows().filter(r => r.kind === 'commitment')

// ------------------------------------------------------------------ the real texts
const T7901 = '進度：正在外掛裡加一項，讓話題裡的訊息送到 agent 時，標籤多帶「這條線的定錨檔路徑＋這條線還開著或已結束」（對應你問的「agent 能不能看到這條線的狀況」）。程式寫好了，卡在一個測試（說明文字超過 Claude Code 的 2000 字上限），正在縮。\n\n接下來：全套測試 → 推 1.35.0 → 回你兩題的完整答案（第 2 題我先對官方文件查數量上限再講）。'
const T7902 = '進度：話題標籤那一項做好了，全套測試 859 個裡 855 過、3 跳過（Linux 專用）、1 個失敗；失敗的那個（開機補跑的測試，跟話題無關）單獨重跑 3 次都過，是整套一起跑時的時間差。我現在提交、再整套跑一次確認，同時查官方文件回你第 2 題。'
const T7904 = '1.35.0 推上去了（整套測試 859 個：856 過、3 跳過、0 失敗）。現在三台機器拉新版、逐隻換 daemon（不重開任何 agent 的對話）；先換一隻當金絲雀，沒問題再換全部。換完給你結果。'
const T7905 = '## ✅ 1.35.0 全艦隊上線（22:03）\n\n三台都換好，沒有重開任何 agent 的對話：\n\n| 機器 | daemon | 結果 |\n|---|---|---|\n| Mac mini | 82 個 | 全部 1.35.0；40 隻車道主線都還在原對話 |\n| GPU 工作站 | 2 個 | 1.35.0；steropes 主線在原對話 |\n| MBP | 4 個 | 1.35.0；daddy 主線在原對話 |\n\n## 這版帶來什麼\n\n- **話題自動回覆**：你在哪個話題講，回覆就進哪個話題（話題模式開著的 bot 才看得到差別）。\n- **話題訊息帶那條線的狀況**：標籤多帶「開著／已結束」和那條線的定錨檔，主線先讀檔再回。\n- **送訊息不會再卡死**：一般訊息最多等 45 秒、傳檔最多等 300 秒，逾時直接回報錯誤（今天 19:19 我卡 120 秒那種）。\n- **分身的回報會正常排版**（表格、標題、粗體）。\n\n## 一個你要知道的改變\n\n工作線和分身線現在跟主線用同一個模型（之前固定 Sonnet）。主線是 Fable 的，它開的工作線也是 Fable，品質一致但比較吃額度。反射線、讀信線照舊 Sonnet。要某隻的工作線固定用別的模型，一個設定就能指定。\n\n## 還沒做、等你一句話\n\n- **正式 bot 的話題模式都沒開**（包括我這隻）。你在測試 bot 試得滿意，說一聲我就在我這隻開：只有我能開話題，你平常講話不會再被自動開話題。\n- 測試 bot 21:46 已經在你的私訊開了一個話題「T11 話題可見性測試」，你在裡面打一句，分身會在同一個話題回你。試完跟我說，我把測試 bot 收掉。'
const T7916 = '02:03 收到 Chiron 的信（你 17:13 要他解決「分身處理邊界」那件）。他要我做兩件事，我現在處理：\n\n1. **直接修兩個 bug**（他查到的，我核對過紀錄，都是真的）：\n   - 分身的一串指令被守門擋下，排程卻被記成「完成」，分身還跟你說「已記」，實際檔案沒寫進去（Elsa 的反射線，昨天 18:05）。\n   - 指示文字改了之後，**接續舊對話的分身拿不到新字**，只有新開的分身拿得到。這也是昨晚讀信線「沒打開信就交回」的真正原因。我昨晚回 Chiron 說「接續的也拿得到」是錯的，我只看了程式沒看實際送出去的內容，會跟他更正。\n2. **評估他的設計**（五樣東西）車道這一側做不做得到，回給他。設計本身等你裁，我不先動手。\n\n兩個 bug 我派一隻 Opus 子 agent 去修（不吃 Fable，脈絡小、每一步便宜），我自己看設計頁、回 Chiron。修好我驗過再上線，到時回報你。'
const T7931 = '讀信線交來 3 封，處理如下：\n\n**1. 分身邊界第三步（WO-128）接了**：等得起的事分身放進主線信箱、**不叫醒主線**，主線下次醒來一起看；快到期才單獨叫醒。這一步是最會讓不急的事變慢的，Chiron 上線前先量基準、上線後滿 100 趟重數，有過期的就關掉。程式先寫，上線要等 Epeius 那邊一件事解掉。\n\n**2. Chiron 抓到兩個正在發生的毛病，我先單獨修（1.38.1）：**\n- 你**多收的原文**：主線已經在處理、甚至已經回過你了，5 分鐘一到分流器還是把交接原文推給你（昨天 23:32 跟今天 08:53 各一則）。改成主線接手或回過你就不推。\n- 分身把排程交回主線時，自己先把排程記成「失敗」，主線做完反而交不了回執。改成交回的排程留給主線交。\n\n**3. Lynceus 開 bot 卡住**：Telegram 兩個帳號的 bot 名額都滿了。我同意 Mnemosyne 刪掉一隻我 7 月後就沒用過的測試 bot，空出名額給 Lynceus。\n\n兩件程式交給同一隻 Opus 子 agent，先出 1.38.1 修毛病、再寫第三步。修好我驗過再上，回報你。'
const M11028 = '可以讓出給 Lynceus。這隻我不用了：最後一次跑是 2026-07-10，之後的測試都在 @sonn_claude_lab_bot 和測試帳號上做，兩隻 bot 的對照測試也沒有排。\n\n你刪之前：它的 workspace `~/cc-workspaces/claude-lab-test/` 沒有 daemon 在跑（launchd 沒有它的 job），刪 bot 不會影響任何活的東西。刪完請在 `~/infra/testing/telegram-test-rig/INVENTORY.md` 把「兩隻」改成一隻、拿掉它那一段（`git add` 只加那個檔）；我這邊 `workspace-telegram/testing/tg-plugin/INVENTORY.md` 我自己改。\n\n之後真的要兩隻 bot 的測試，我再找 Joey 開，不會用「禁止新建第三隻」去擋你這次。'
// the promises among them (explicit, an action owed): TG 7910's last paragraph but one, mail #10900 to Chiron
const T7910 = '## ✅ 1.35.3 全艦隊上線（22:50），順便把信箱清空\n\n**這版最重要的一項：你傳的格式化訊息不會再被吃掉。**\n\n誠實講還沒驗的：測試用的是照官方格式做的假訊息，真的 Telegram rich 訊息這一版還沒收過。你下次轉寄或貼格式化內容時，我會看紀錄確認。\n\n## 信箱：打開 5 封，全部處理完\n\n| 信 | 誰 | 怎麼處理 |\n|---|---|---|\n| rich 訊息被丟掉 | Hestia | 修好上線，回信 |'
const M10900 = '更正：我 #10876 說「resume 的 session 也拿得到新卡」是錯的。我只看了程式每一趟都帶 `--append-system-prompt-file`，沒看實際送出的內容。\n\n兩個毛病：一隻 Opus 子 agent 正在修，我驗過才上，版號 1.36.2，上線後在這個 thread 回你一句。\n1. 守門先替被擋的指令完成回執：`lane-guard-hook.py` main() 的 Bash 分支，`receipt_cli_calls`／`complete_through_daemon` 排在寫入檢查前面。'
const C1623 = 'Sonn 在今晚的新版加了一道：讀信線一封都沒打開就想交回，第一次會被退回、告訴它先打開並整理；明天我數一次交回的樣子，把退回後仍整包交回的那幾趟交給 Sonn。'   // Chiron to Joey, 11-23 16:24Z
const C2100 = '觀察點我會跟著每一步同步記。'                                                                                                   // Chiron to Joey, 11-23 21:00Z

test('WO-131 D: the reports (TG 7901, 7902, 7904, 7905, 7916, 7931; mail #11028) hold no promise form; the promises (TG 7910, mail #10900, Chiron 16:24Z and 21:00Z) do, and only their promise sentence is kept', () => {
  for (const t of [T7901, T7902, T7904, T7905, T7916, T7931, M11028]) expect(promiseSentences(t)).toEqual([])
  expect(promiseSentences(T7910)).toEqual(['你下次轉寄或貼格式化內容時，我會看紀錄確認。'])
  expect(promiseSentences(M10900)).toEqual(['兩個毛病：一隻 Opus 子 agent 正在修，我驗過才上，版號 1.36.2，上線後在這個 thread 回你一句。'])
  expect(promiseSentences(C1623)).toEqual(['明天我數一次交回的樣子，把退回後仍整包交回的那幾趟交給 Sonn。'])          // the report before the 「；」 is not kept
  expect(promiseSentences(C2100)).toEqual([C2100])
  // the forms of the brief and of the earlier tests: 我會…, …前給你, 明天…, N 分鐘後…, a deadline passed on
  for (const t of ['我會再回你。', '我明天回你。', 'WO-27 規格我明天 10:00 前給你。', '週五 12:00 前給你完整報告。', '我稍後告訴你誰做。', 'p95 升到 900ms，我 10 分鐘後再查一次並回報。',
    'Joey 決定：/v2/orders/bulk 週五前會做好，他正在找人負責。', '30 分鐘內回你。', "I'll send it tomorrow.", 'I will check the logs.'])
    expect(promiseSentences(t)).toEqual([t])
  // not a promise: a question, a negation, a time stated as a fact, a report of what was done
  for (const t of ['你明天能給我嗎？', '明天不用給我。', 'mock-api 維護時段：每週三 02:00–03:00，下週三 11-18 為維護。', '今晚上線的三樣都是在修同一件事。', '我已經重啟了 mock-api。', '我會不會太慢'])
    expect(promiseSentences(t)).toEqual([])
})

test('WO-131 D: through the one promise check, with Jev saying 0.99 as it did: the main\'s reports to Joey are not asked and not recorded; TG 7910 is recorded with its one sentence (not the whole message); mail #10900 to Chiron likewise', async () => {
  const c0 = jevCalls.length, n0 = commitments().length
  for (const [t, id] of [[T7901, 7901], [T7902, 7902], [T7904, 7904], [T7905, 7905], [T7916, 7916], [T7931, 7931]] as const)
    expect(await L.promiseCheck({ who: 'main', to: 'joey', text: t, thread: null, ref: id })).toBe('no')
  expect(await L.promiseCheck({ who: 'main', to: 'mnemosyne', text: M11028, thread: null, ref: 'mail-11028' })).toBe('no')
  expect(jevCalls.length).toBe(c0); expect(commitments().length).toBe(n0)
  const log = readFileSync(join(dir, 'run', 'main-commitment.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  expect(log.filter(r => r.form === false).length).toBe(7)
  expect(await L.promiseCheck({ who: 'main', to: 'joey', text: T7910, thread: null, ref: 7910 })).toBe('written')
  expect(jevCalls.at(-1).state.message.text).toBe('你下次轉寄或貼格式化內容時，我會看紀錄確認。')            // Jev is asked about the promise, not the report
  const c = commitments().at(-1)
  expect(c).toMatchObject({ lane: 'main', kind: 'commitment', text: '答應 joey：你下次轉寄或貼格式化內容時，我會看紀錄確認。（時限：未說明）',
    refs: { from: 'main-send', auto: true, p: 0.99, who: 'joey', what: '你下次轉寄或貼格式化內容時，我會看紀錄確認。' } })
  expect(await L.promiseCheck({ who: 'main', to: 'chiron', text: M10900, thread: null, ref: 'mail-10900' })).toBe('written')
  expect(commitments().at(-1).refs.what).toBe('兩個毛病：一隻 Opus 子 agent 正在修，我驗過才上，版號 1.36.2，上線後在這個 thread 回你一句。')
  expect(log.length + 2).toBe(readFileSync(join(dir, 'run', 'main-commitment.jsonl'), 'utf8').trim().split('\n').length)
})

test('WO-131 D: LANES_PROMISE_FORM=0 is 1.38.2: the whole report is asked and recorded; 「第 1 點」 is never a deadline (it was 「時限：1 點」 on TG 7899)', async () => {
  process.env.LANES_PROMISE_FORM = '0'
  try {
    const c0 = jevCalls.length
    expect(await L.promiseCheck({ who: 'main', to: 'joey', text: T7901, thread: null, ref: 79011 })).toBe('written')
    expect(jevCalls.length).toBe(c0 + 1); expect(jevCalls.at(-1).state.message.text).toBe(T7901)
    expect(commitments().at(-1).refs.what).toBe(T7901.replace(/\s+/g, ' ').trim())
  } finally { delete process.env.LANES_PROMISE_FORM }
  const t7899 = '收到。第 1 點的「自動帶回覆」已經做在這一版裡了（你在哪個話題講，我就回在哪個話題），我現在就把這版推上艦隊。你問的另外兩件（agent 看不看得到那條線的狀況、✅ 話題累積太多），我查兩個地方再具體回你。'
  expect(commitmentFromReport(t7899, undefined, 'joey')!.by).toBe('未說明')
  expect(commitmentFromReport('明天 10:00 前給你', undefined, 'eve')!.by).toBe('明天 10:00 前')
  expect(promiseSentences(t7899)).toEqual([])
})
