---
name: media-to-notes-workflow
description: >
  決策手冊：處理任何涉及影片、音訊、字幕、媒體內容分析的任務時，先讀這份文件再決定用哪個 skill。
  適用情境：使用者給的需求模糊（例如「深度解讀這個影片」「幫我整理這支 YT 的重點」「分析這個小紅書」），
  或任務涉及多個 skill 組合時。這份文件定義各 skill 的定位、優劣、重疊差異、以及任務深度判斷準則。
---

# Media to Notes Workflow 決策手冊

## 這份文件的用途

讀完這份文件，你應該能回答：

- 這個任務用哪個 skill
- 需要幾個 skill 組合
- 先做什麼後做什麼
- 現有方案不夠時怎麼升級

---

## Skill 能力總覽

### 下載工具層（取得媒體素材）

| 工具 | ⭐ Stars | 定位 | 覆蓋 | 安裝位置 |
|---|---|---|---|---|
| `yt-dlp` | 154K | **全平台影片主力** | YouTube/FB/IG/X/TikTok/抖音/B站/Vimeo/1000+站 | 系統 PATH |
| `gallery-dl` | 17K | **西方平台圖文主力** | FB圖文/IG圖文/X圖文/Pinterest/Bluesky/Reddit/170+站 | 系統 PATH (`brew`) |
| `MediaCrawler` | 47K | **中國平台全能主力** | 小紅書/抖音/微博/快手/B站/知乎/百度貼吧（影片+圖文+評論） | See `.claude/media-alchemist.local.md` for path (uv) |
| `lux` | 31K | **中國平台影片備援** | 小紅書/微博/快手/知乎/Threads/抖音/FB/IG | 系統 PATH (`brew`) |

### 處理工具層（分析/轉錄/提取）

| Skill | 定位 | 輸入 | 輸出 | 成本 |
|---|---|---|---|---|
| `youtube-transcript` | YouTube 直取結構化 transcript | YouTube URL | JSON + 完整文字 + timestamp | 極低 |
| `transcribe` | 精準音訊轉錄（3 種 Layer 1 + Gemini refine Layer 2） | 本地音訊/影片檔 | txt / srt / json | API 按量計費 |
| `ffmpeg` | 影片/音訊處理：抽幀、壓縮、裁切、轉檔、字幕等 | 本地影片/音訊檔 | jpg / png / mp4 / mp3 等 | 免費（本機） |

---

## 🔀 平台路由表（核心決策邏輯）

**原則：中國平台一律 MediaCrawler 優先，西方平台影片 yt-dlp、圖文 gallery-dl。**

### 中國平台 — MediaCrawler 優先

| 平台 | 內容 | 主力 | 備援 |
|---|---|---|---|
| 小紅書 | 影片+圖文 | **MediaCrawler** | lux（影片）|
| 抖音 | 影片 | **MediaCrawler** | yt-dlp |
| 微博 | 影片+圖文 | **MediaCrawler** | lux |
| 快手 | 影片 | **MediaCrawler** | lux |
| B站 | 影片 | **MediaCrawler** | yt-dlp |
| 知乎 | 影片+文 | **MediaCrawler** | lux |
| 百度貼吧 | 文+圖 | **MediaCrawler** | 無 |

### 西方平台 — yt-dlp(影片) + gallery-dl(圖文)

| 平台 | 內容 | 主力 | 備援 |
|---|---|---|---|
| YouTube | 影片 | **yt-dlp** | lux |
| Facebook | 影片 | **yt-dlp** | lux |
| Facebook | 圖文 | **gallery-dl**（需cookies） | 無 |
| Instagram | 影片 | **yt-dlp** | lux |
| Instagram | 圖文 | **gallery-dl**（需cookies） | 無 |
| Twitter/X | 影片 | **yt-dlp** | lux |
| Twitter/X | 圖文 | **gallery-dl** | 無 |
| Reddit | 影片+圖 | **yt-dlp**(影片) / **gallery-dl**(圖) | lux |
| Pinterest | 圖文 | **gallery-dl** | lux |
| Bluesky | 圖文 | **gallery-dl** | 無 |
| Threads | 影片+圖 | **lux** | yt-dlp |
| TikTok | 影片 | **yt-dlp** | lux |
| Vimeo | 影片 | **yt-dlp** | lux |
| Tumblr | 影片+圖 | **yt-dlp**(影片) / **gallery-dl**(圖) | lux |

### 路由決策樹

```
URL 進來
│
├─ 判斷平台（domain matching）
│
├── 中國平台（xiaohongshu/xhslink/douyin/weibo/kuaishou/bilibili/zhihu/tieba）
│   → MediaCrawler（主）→ lux/yt-dlp（備）→ Playwright（終極備援）
│
├── 西方平台 — 判斷內容類型
│   ├── 影片（YouTube/TikTok/Vimeo/Reddit）
│   │   → yt-dlp（主）→ lux（備）
│   │
│   ├── Facebook 圖文
│   │   → Playwright headless（主，實測不需 cookies）→ gallery-dl+cookies（備）
│   │
│   ├── 圖文（IG/X/Pinterest/Bluesky/Reddit）
│   │   → gallery-dl（主）→ Playwright（備）
│   │
│   └── Threads
│       → lux（主）→ Playwright（備）
│
└── 未知平台 / 全部失敗
    → Playwright headless（萬能最終備援）
    → 仍失敗 → 報告魔王
```

### Playwright 萬能備援

Playwright headless Chromium 已隨 MediaCrawler 安裝，位於 MediaCrawler 的 `.venv` 中。

**用法**：當 CLI 工具全部失敗時，啟動 headless browser 直接打開 URL，提取 DOM 內容。

**優勢**：模擬真實瀏覽器，不容易被平台封鎖。Facebook 公開貼文實測不需要 cookies。
**劣勢**：較慢（要啟動瀏覽器），需要寫 JS selector 提取內容。

**適用場景**：
- 平台封鎖 HTTP 請求但允許瀏覽器（如 Facebook）
- CLI 工具不支援該平台的 URL pattern
- 任何有公開 URL 但其他工具都失敗的情況

### Layer 1 轉錄 Provider（全部在 transcribe 同一層，依場景路由）

| Provider | 場景 | 輸出格式 | Speaker Diarization | 備注 |
|---|---|---|---|---|
| OpenAI Whisper API（**預設**） | 單人、正常音質 | txt/srt/json | ❌ | `transcribe --mode auto` 的首選路徑 |
| 本地 Whisper large-v3 | API 失敗 / 超大檔 / 離線 | txt/srt/json | ❌ | MPS FP32 加速，約 5 分鐘/14 分鐘片 |
| gpt-4o-transcribe | 快速純文字草稿，不需 SRT | txt/json | ❌ | 精度略高於 whisper-1，但無 SRT、無 word timestamps |
| AssemblyAI | 多人訪談、會議、超長、要章節 | JSON（含 speaker labels） | ✅ | Auto Chapters、LeMUR 問答、99 種語言 |
| ElevenLabs Scribe v2 | 多人（最多 32 人）、word timestamps、即時字幕 | JSON（含 speaker + word timestamps） | ✅ | 150ms 即時延遲、56 種 entity detection |

**路由邏輯（進來就判斷，不是跑完失敗才換）：**

```
進來一個 URL / 音訊
↓
看 title / description / 平台類型 / 內容信號
├── 「訪談」「對談」「圓桌」「會議」「podcast 多主持人」→ AssemblyAI
├── 明確需要即時字幕 / word timestamps → ElevenLabs Scribe v2
├── 只要快速文字草稿、不需 SRT → gpt-4o-transcribe
├── 一般影片、無明顯多人信號 → OpenAI Whisper API（預設）
└── API 失敗 / quota / 離線 → 本地 Whisper large-v3
```

**如果 title 看不出單人/多人**：預設走 Whisper API。跑完後若轉錄結果明顯是多人對話混在一起，主動提示用 AssemblyAI 重跑加說話者標籤。

**完整問題紀錄：** `OpenClaw Clinic/Transcription & Media/` 資料夾（各 API 限制、已知坑、選型報告）

---

## 任務類型 → 判斷流程

### 類型 A：「了解影片內容」類
用戶說：「這支影片在講什麼」「幫我整理重點」「摘要這個 YT」

**判斷準則：**

```
是 YouTube？
├── YES
│   ├── 試 youtube-transcript
│   │   ├── 成功 → 有完整文字，用 LLM 整理，完成
│   │   └── 失敗（無字幕、被擋）→ 升級到 C 路線
│   └── 快速一次性，不需要保留 raw data → 可用 summarize 直接處理
└── 非 YouTube（Twitch、Bilibili、Instagram 等）
    └── 走 B 路線（yt-dlp 下載音訊 → transcribe）
```

---

### 類型 B：「需要精準文字 / 字幕檔」類
用戶說：「生成字幕」「做逐字稿」「我需要完整的 SRT」「多語字幕」

**判斷準則：**

```
來源是 YouTube，且平台有現成字幕？
├── YES → yt-dlp --write-subs 直接抓，品質夠就完成
└── NO（無字幕、auto-CC 品質差、非 YouTube）
    └── yt-dlp 下載音訊（-x --audio-format m4a）
        └── transcribe
            ├── 一般語言 → 直接跑，輸出 srt
            ├── 中英夾雜 / 複雜語言 → --refine（Gemini 校正）
            └── 需要翻譯 → --refine --refine-mode zh / bilingual-zh
```

---

### 類型 C：「深度分析影片」類
用戶說：「深度解讀」「分析這個影片的表達手法」「這個小紅書畫面在幹嘛」

**判斷準則：**

```
任務需要「畫面理解」？
├── YES（視覺、動作、UI、圖文、肢體、場景）
│   └── yt-dlp 下載影片
│       ├── video-frames 抽關鍵幀
│       ├── transcribe 拿文字（如果有語音）
│       └── 兩者一起送給視覺模型分析
└── NO（純內容、語言表達、觀點分析）
    └── 走 A 路線拿文字 → LLM 深度分析
```

---

### 類型 D：「只需要下載媒體」類
用戶說：「下載這個影片」「幫我抓 MP3」「存這個 playlist」

```
直接走 yt-dlp，不需要其他 skill
```

---

### 類型 E：「本地音訊 / 影片轉文字」類
用戶給的是本地檔案路徑

```
直接走 transcribe，不經過 yt-dlp 或 youtube-transcript
```

---

## Skill 重疊分析

### 🔴 `summarize` vs `youtube-transcript`（YouTube 路徑高度重疊）

兩個都能處理 YouTube → 文字。

| 選 `summarize` 的時機 | 選 `youtube-transcript` 的時機 |
|---|---|
| 只需要快速了解影片大意 | 需要完整 transcript，不能壓縮 |
| 一次性，不需要二次處理 | 需要 timestamp、逐字對照 |
| 不在意底層提取方式 | 需要可靠提取（有 proxy 繞過封鎖） |

**這兩個是風格差異，不是強弱差異。選錯不會報錯，但輸出結果會不同。**

---

### 🟡 `summarize` vs `transcribe`（YouTube 轉錄路徑）

`summarize` 有 best-effort YouTube 轉錄，`transcribe` 是走 Whisper 精準轉錄。

| 選 `summarize` 的時機 | 選 `transcribe` 的時機 |
|---|---|
| 不需要逐字、有摘要就夠 | 需要完整精準逐字稿 |
| 純英文或單一語言 | 多語、中英夾雜、需要 refine |
| 不需要 srt 格式 | 需要字幕檔（srt / json） |

**任務需要精準度 → 一律走 transcribe 路線，不走 summarize。**

---

### 🟢 `yt-dlp` — 不是分析工具，是下載工具

`yt-dlp` 本身不產生文字，也不分析內容。
它的角色永遠是：**拿到媒體檔案，然後交給下游 skill 處理**。

別讓 `yt-dlp` 承擔判斷任務。

---

### 🟢 `video-frames` — 視覺任務的必要前置，但容易被忽略

只要任務涉及「畫面上有什麼」，就一定需要 `video-frames`。
transcript / summarize 拿到的是語音轉文字，**不包含視覺資訊**。

畫面相關關鍵字：
- 「分析畫面」「畫面在做什麼」「圖文排版」
- 「小紅書」「Instagram Reels」「TikTok」「產品展示影片」
- 「這個 UI」「這個動作」「這個表情」

遇到這些關鍵字，一定要搭配 `video-frames`。

---

## 任務深度等級

| 深度 | 說明 | Skill 組合 |
|---|---|---|
| L1 快速了解 | 影片在講什麼、大意 | `summarize` 或 `youtube-transcript` |
| L2 完整文字 | 逐字稿、完整 transcript、字幕 | `youtube-transcript` 或 `yt-dlp + transcribe` |
| L3 精準字幕 | 多語、需要 refine、高準確度 | `yt-dlp + transcribe --refine` |
| L4 深度內容分析 | 觀點、論述結構、語言風格 | L2/L3 拿文字 + LLM 深度分析 |
| L5 視覺分析 | 畫面、動作、圖文、UI | `yt-dlp + video-frames + transcribe` |

---

## Fallback / Escalation 規則

| 情況 | 下一步 |
|---|---|
| `youtube-transcript` 失敗（無字幕、被擋） | `yt-dlp` 下載音訊 → `transcribe` |
| `summarize` 輸出不夠精準 | 換 `youtube-transcript` 拿 raw transcript |
| transcript 有了但語言不對或品質差 | `transcribe --refine` |
| 文字分析完但使用者說「還有畫面」 | 補做 `video-frames` + 視覺模型 |
| 平台不是 YouTube，transcript 取不到 | 直接 `yt-dlp` 下載音訊 → `transcribe` |
