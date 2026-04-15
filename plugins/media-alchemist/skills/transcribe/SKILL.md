---
name: transcribe
description: >
  Transcribe audio via local Whisper CLI or OpenAI Whisper API.
  Optional second layer: Gemini audio-aware refinement for multilingual/mixed-language correction.
  Supports --mode local (offline) or --mode api (cloud).
  Outputs txt, srt, json. Optional: language hint, prompt hint, translate to English.
  Add --refine for LLM proofreading pass (requires GEMINI_API_KEY).
metadata:
  {
    "openclaw":
      {
        "emoji": "🎙️",
        "requires": { "bins": ["curl"], "env": [] },
        "optionalEnv": ["OPENAI_API_KEY", "GEMINI_API_KEY"],
      },
  }
---

# transcribe skill

兩層架構：
- **Layer 1（語音轉文字）**— 選一個 STT provider 拿到原始文字
- **Layer 2（校正，永遠加上）**— Gemini audio-aware 校正：加標點、修斷句、修英文術語、修專有名詞

**核心原則：不管 Layer 1 用哪個 provider，Layer 2 Gemini refine 永遠都要跑。它永遠會讓結果更好。**

## 鏈路能力總覽（最後更新：2026-04-15）

### Layer 1：STT Provider 選擇（按中文實測品質排序）

#### 1. ElevenLabs Scribe v2（中文最佳 + 多人場景首選）

腳本：`elevenlabs.sh`
需要：ELEVENLABS_API_KEY
檔案限制：3GB（無需壓縮）

能力：
- 中文 WER 5-10%（實測品質最好）
- Speaker diarization（最多 32 人，實測 3 人對話切換準確）
- Word-level timestamps（精確到每個中文字）
- keyterms 參數顯著提升專有名詞辨識
- Entity detection / redaction（PII 遮蔽）

缺陷：
- 無標點符號（Layer 2 Gemini refine 解決）
- keyterms 傳法有坑（每個 term 獨立 -F 欄位，不能用 JSON array）
- $0.22/hr + keyterms 加收 20%

#### 2. Whisper API（預設，便宜穩定）

腳本：`transcribe.sh`
需要：OPENAI_API_KEY
檔案限制：25MB（腳本自動壓縮繞過）

能力：
- 支援 99+ 語言
- SRT 直出
- 最便宜（$0.006/min）
- 穩定，很少 downtime

缺陷：
- 沒有 speaker diarization
- 中文品質不如 ElevenLabs（但加 Gemini refine 後差距縮小）
- 25MB 限制（已自動繞過）

#### 3. AssemblyAI Universal-2（英文首選 + LeMUR）

腳本：`assemblyai.sh`
需要：ASSEMBLYAI_API_KEY
檔案限制：無限制（URL 上傳到 CDN）

能力：
- Universal-3 Pro 英文 WER 5.6%（業界最強英文）
- LeMUR 框架（轉錄完直接問音訊內容）
- 無檔案大小限制
- 185 小時免費，$0.15/hr 最便宜

缺陷：
- U3 Pro 不支援中文（只有 6 歐洲語言，中文只能走 U2）
- U2 中文品質弱（WER 10-25%，英文全小寫黏一起）
- Diarization 在中文場景分段不準
- 參數是 speech_models（複數），speech_model 已棄用

### Layer 2：Gemini refine（永遠加上）

腳本：`refine.sh`
需要：GEMINI_API_KEY
Fallback chain：gemini-3-flash-preview → 2.5-flash → 2.5-pro → 3.1-pro → 3-pro

不管 Layer 1 用了什麼，Layer 2 都加上去：
- 加標點和斷句
- 修正 ASR 的聽錯字
- 修正英文術語大寫
- 修正語言偵測錯誤
- 處理 code-switching

### 完整 pipeline 示意

```
音訊檔案
  │
  ├── Layer 1 選擇：
  │   ├── 多人對話 → elevenlabs.sh（diarization）
  │   ├── 英文內容 → assemblyai.sh（U3 Pro）
  │   ├── 需要 LeMUR 分析 → assemblyai.sh
  │   └── 其他 → transcribe.sh（Whisper，預設）
  │
  ↓ 產出原始 SRT
  │
  └── Layer 2（永遠執行）：
      refine.sh → 加標點、修錯字、修術語
      ↓
      最終 .refined.srt
```

### 鏈路選擇邏輯（Agent 必須遵循）

```
收到轉錄任務
│
├── 有多個說話者嗎？（訪談、會議、多人 podcast）
│   └── YES → Layer 1 用 elevenlabs.sh + keyterms
│            → Layer 2 用 refine.sh
│
├── 是英文內容嗎？
│   └── YES → Layer 1 用 assemblyai.sh（U3 Pro）
│            → Layer 2 用 refine.sh
│
├── 需要 LeMUR 分析嗎？（「這場會議的結論是什麼」）
│   └── YES → Layer 1 用 assemblyai.sh
│            → Layer 2 用 refine.sh
│
└── 其他（中文單人影片、一般轉錄）
    └── Layer 1 用 transcribe.sh（Whisper）
         → Layer 2 用 refine.sh（--refine flag 自動觸發）
```

### 已知問題追蹤

| 問題 | 狀態 | 影響 |
|---|---|---|
| AssemblyAI U3 Pro 不支援中文 | 等他們擴展語言 | 中文只能 U2 |
| ElevenLabs + refine.sh 組合未自動化 | 需手動串接 | elevenlabs.sh 跑完後手動跑 refine.sh |
| Gemini 高流量拒絕 | 5 模型 fallback chain | 偶爾全部忙 |
| Whisper API 25MB 限制 | 自動壓縮繞過 | 壓縮後品質幾乎無損 |

詳細測試數據見 `references/STT-PROVIDERS-TEST-LOG.md`

---

## When to use this skill (vs alternatives)

Before transcribing audio, check if a faster path exists:

| Situation | Best approach |
|-----------|---------------|
| YouTube video, subtitles likely exist | Try `youtube-transcript` skill first |
| YouTube video, no subtitles / auto-CC only | `yt-dlp` (audio-only) → Layer 1 + Layer 2 |
| Local audio/video file | Layer 1 + Layer 2 directly |
| Multi-speaker conversation | `elevenlabs.sh` → `refine.sh` |
| English content | `assemblyai.sh` → `refine.sh` |
| Mixed language (Chinese/English/etc.) | Any Layer 1 → `refine.sh` |
| Need translation | Any Layer 1 → `refine.sh --refine-mode zh` |

**Decision rule for AI:** 選 Layer 1 provider 後，永遠接 Layer 2 refine。不要跳過 refine。

## ⚠️ Common Mistakes (read this)

1. **Always use `--mode auto`. Never manually skip API.** If `--mode auto` hits a SIGTERM, that's an exec timeout problem (increase timeout to 300s+), NOT an API failure. Only switch to `--mode local` if the API returns an explicit error code like `insufficient_quota` or `401`. SIGTERM ≠ API broken.

2. **Don't pre-announce estimated durations.** "Should take ~5 minutes" is useless noise. Start the task, wait for completion, report the result. The machine decides how long it takes, not you.

3. **NEVER set artificial token/output limits on external API calls.** Do not add `max_output_tokens`, `max_tokens`, or any similar caps in API requests unless the API itself requires it. Let the model use its full capacity. Any such limit is sabotage — it silently truncates output and causes data loss. The only acceptable size limits are those imposed by the API provider itself (e.g., OpenAI Whisper's 25MB upload limit).

4. **Never split/chunk SRT for refine.** Splitting SRT into segments for separate refine calls increases error rate and wastes more tokens. Always send the complete SRT in a single refine call. Gemini 2.5 Flash supports 65K output tokens and 1M input — one call handles any video under ~2 hours.

5. **"Long video" = over 1 hour.** Anything under 1 hour is a normal video. Do not treat 20-minute or 45-minute videos as "long" or apply any special handling. The refine pipeline handles them in a single pass without issues.

## Quick start

```bash
# Basic transcription (Layer 1 only)
{baseDir}/scripts/transcribe.sh /path/to/audio.m4a --format srt

# With Gemini refinement (Layer 1 + 2), preserve all languages as spoken
{baseDir}/scripts/transcribe.sh /path/to/audio.m4a --format srt --refine

# Refine + translate everything to Chinese
{baseDir}/scripts/transcribe.sh /path/to/audio.m4a --format srt --refine --refine-mode zh

# Bilingual output (original + Chinese translation)
{baseDir}/scripts/transcribe.sh /path/to/audio.m4a --format srt --refine --refine-mode bilingual-zh

# Use refine.sh standalone on an existing SRT
{baseDir}/scripts/refine.sh /path/to/audio.m4a /path/to/subtitles.srt --mode preserve
```

## All flags

### Layer 1 — Whisper

| Flag | Default | Description |
|------|---------|-------------|
| --mode local/api/auto | auto | Backend: local Whisper CLI or OpenAI API |
| --model MODEL | **large-v3 (local)** / whisper-1 (api) | tiny/base/small/medium/**large-v3** (local); whisper-1 (api). Never use tiny/base/small unless explicitly asked. |
| --language LANG | auto-detect | e.g. zh, en, ja (omit for multilingual auto-detect) |
| --prompt TEXT | — | Hint for proper nouns / terminology |
| --task transcribe/translate | transcribe | Use translate to get English output |
| --format txt/srt/json | txt | Output format (--refine forces srt automatically) |
| --out PATH | \<input\>.\<format\> | Output file path |

### Layer 2 — Gemini refinement (optional)

| Flag | Default | Description |
|------|---------|-------------|
| --refine | off | Enable Gemini audio-aware refinement pass |
| --refine-model MODEL | gemini-3-flash-preview | Gemini model. Auto-fallback chain: gemini-3-flash-preview → gemini-2.5-flash → gemini-2.5-pro → gemini-3.1-pro-preview → gemini-3-pro-preview |
| --refine-mode MODE | preserve | Language behavior (see below) |
| --refine-key KEY | $GEMINI_API_KEY | Gemini API key |

### --refine-mode options

| Mode | Behaviour |
|------|-----------|
| `preserve` | Keep every language exactly as spoken — Chinese stays Chinese, English stays English, mixed stays mixed |
| `zh` / `en` / `ja` / `ko` / `fr` / … | Translate everything to that language |
| `bilingual-zh` / `bilingual-en` / … | Each block: original language + translation |

Works with any language Gemini supports (90+). No language pre-configuration needed.

## Mode: auto (Layer 1) — API-first
- If `OPENAI_API_KEY` is set → uses OpenAI Whisper API (faster, no local resource usage)
- If no key but `whisper` CLI is available → fallback to local large-v3
- Otherwise → error with instructions

## 完整問題紀錄（Obsidian 參照）

遇到問題先查：
- **限制 / 已知坑** → `OpenClaw Clinic/Transcription & Media/Transcription Workflow — Known Limits & Gotchas.md`
- **API 選型與多說話者場景** → `OpenClaw Clinic/Transcription & Media/Speech-to-Text 完整技術報告：現有缺陷與替代方案.md`
- **各 API 功能比較** → `OpenClaw Clinic/Transcription & Media/Speech-to-Text API 全面比較報告 2026.md`

---

## Known Limits & Auto-handling

### OpenAI API 25MB file size limit
OpenAI Whisper API 硬限制 25MB。超過會回傳 HTTP 413 錯誤。

**`transcribe.sh` 已內建自動處理（`--mode api` 或 `--mode auto` 走 API 時）：**
- 偵測到檔案 >25MB → 自動 `ffmpeg -ac 1 -ar 16000 -b:a 64k` 壓縮成 mono mp3
- 壓縮後典型大小：29MB m4a → 6.4MB mp3（↓78%）
- 壓縮對轉錄品質幾乎無影響（Whisper 本身就用 16kHz mono 處理）
- 壓縮完成後上傳，原始檔不動

### Apple Silicon MPS — large-v3 speed（已修，2026-03-25）

**問題根因：** `whisper` CLI 預設 `--device cpu`，即使 Apple Silicon 有 MPS GPU 也不使用。
加 `--device mps` 雖然可以用 GPU，但 CLI 強制 FP16，導致 large-v3 在 MPS 上產生全 NaN 輸出（PyTorch MPS + FP16 的已知 bug）。

**解法：** 改用 Python API 直接調用，強制 FP32（`model.float()` + `fp16=False`）。

**決策（2026-03-25）：whisper CLI 全面退場，不留 fallback。**
- `whisper` CLI 是 OpenAI 官方套件（v20250625），不 fork 修它
- CLI 的 `--device mps` 強制 FP16，無任何參數可覆蓋，屬於結構性缺陷
- CPU 路徑雖然正確，但維護兩套路徑（CLI + Python API）風險高
- 決定：local mode 100% 走 Python API，MPS 和 CPU 使用同一套程式碼

`transcribe.sh` 現在的 local mode：
- MPS 可用 → Python API + `model.float()` + `fp16=False`（MPS FP32）
- MPS 不可用 → Python API + CPU + `fp16=False`（行為完全一致）

**實測速度對比（14 分 57 秒影片，Mac mini Apple Silicon）：**

| 方式 | 耗時 | 狀態 |
|------|------|------|
| Whisper CLI（CPU FP32，舊） | ~20 分鐘 | 已退場 |
| Whisper CLI（MPS FP16）| 崩潰，NaN 輸出 | 已退場 |
| **Python API（MPS FP32，現在）** | **~5 分鐘（4x 加速）** | ✅ 現役 |
| Python API（CPU FP32，fallback）| ~20 分鐘 | ✅ 現役 |

## How refinement works

1. Whisper generates SRT with accurate timestamps (Layer 1)
2. Audio file is uploaded to Gemini Files API
3. Gemini receives both the audio and the Whisper draft simultaneously
4. Gemini proofreads by listening — corrects wrong words, wrong language detection, code-switching errors
5. Timestamps are preserved exactly; only content is corrected
6. Output: `<name>.refined.srt`

## Cost estimate (Layer 2, Gemini 2.5 Flash)

| Audio length | Approx. cost |
|-------------|-------------|
| 5 min | ~$0.001 |
| 30 min | ~$0.005 |
| 60 min | ~$0.01 |
