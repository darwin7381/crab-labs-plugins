# 平台工具設定筆記與踩雷紀錄

> 每次遇到問題或發現重要注意事項都記在這裡。

---

## MediaCrawler（中國平台爬蟲）

安裝位置：~/Development/MediaCrawler/
Python 管理：uv（不是 venv）
Playwright chromium：已安裝

### 小紅書 — 台灣封鎖問題（2026-04-15）

問題：台灣政府封鎖了 xiaohongshu.com 網域，Playwright 連不上。
錯誤訊息：ERR_CERT_AUTHORITY_INVALID 或「此網域已經遭到封鎖」

解法：
1. config/base_config.py 改 XHS_INTERNATIONAL = True
   → 走 rednote.com（國際版）而不是 xiaohongshu.com
2. media_platform/xhs/core.py 的 launch_browser 加了 ignore_https_errors=True
   → 防止 SSL 相關錯誤

### Playwright 反爬偵測

問題：小紅書偵測到 Playwright 的自動化 Chromium 會封鎖
解法選項：
- XHS_INTERNATIONAL = True（目前用的，走 rednote.com 繞過）
- ENABLE_CDP_MODE = True（用真實 Chrome 瀏覽器，反偵測更強，但需要手動啟動 Chrome）
- 目前 standard mode + ignore_https_errors + international 就能跑

### 登入狀態

已登入的平台（cookie 快取在 browser_data/）：
- 小紅書 ✅（走 rednote.com）
- B站 ✅
- 微博 ✅
- 抖音 ✅
- 知乎 ✅

未登入：快手、百度貼吧

### 使用注意

- 每次跑完要 Ctrl+C 停，不然會一直爬
- keywords 用英文逗號分隔多個關鍵字
- --type search（搜尋）/ detail（指定貼文）/ creator（創作者主頁）
- 防封：內建每抓一篇休眠 2 秒

---

## gallery-dl

安裝：brew install gallery-dl（/opt/homebrew/bin/gallery-dl）
版本：1.31.10

用途：西方平台圖片/畫廊下載（389+ 網站）
注意：部分平台需要 cookies（IG、FB），用 --cookies-from-browser chrome 可以自動讀

---

## lux

安裝：brew install lux（/opt/homebrew/bin/lux）

用途：中國平台影片下載（B站 VIP、抖音、快手等）
注意：跟 yt-dlp 互補，不是替代。中國平台用 lux，西方平台用 yt-dlp。

---

## ElevenLabs + Gemini refine 組合問題（2026-04-15）

問題：ElevenLabs 用 keyterms 正確辨識了專有名詞（如 OpenClaw、Hermes Agent），
但 Gemini refine 不知道這些 keyterms，反而把正確的名詞「修正」成錯的
（OpenClaw → OpenDevin，Hermes Agent → Holmes Agent）

解法（待實作）：refine.sh 需要支援傳入 keyterms，在 prompt 裡告訴 Gemini
「以下是正確的專有名詞，不要修改它們：...」

目前狀態：未修，使用 ElevenLabs 時如果 refine 把名詞搞壞，以 ElevenLabs 原版為準。

---

## 工具選擇指南：普通 vs 進階

### 影片抽幀

| 場景 | 工具 | 說明 |
|---|---|---|
| OpenClaw 環境（簡易） | video-frames（OpenClaw 預載） | 只能抽單幀，夠用於快速縮圖 |
| Claude Code / Hermes / 進階需求 | ffmpeg skill | 批次抽幀、filmstrip、關鍵幀、GIF、裁切全部支援 |

### 影片摘要

| 場景 | 工具 | 說明 |
|---|---|---|
| OpenClaw 環境（快速） | summarize（OpenClaw 預載） | 黑盒一鍵處理，品質普通 |
| Claude Code / 進階需求 | transcribe skill（Layer 1 + Layer 2） | 精準逐字稿 + Gemini 校正，品質最高 |
| 多人對話場景 | transcribe → elevenlabs.sh + refine.sh | 有 speaker diarization |

### 影片下載

| 場景 | 工具 | 說明 |
|---|---|---|
| YouTube / 西方平台 | yt-dlp | 1000+ 網站 |
| 中國平台影片 | lux 或 MediaCrawler | lux 下載快，MediaCrawler 可抓圖文+留言 |
| 西方平台圖文 | gallery-dl | 389+ 網站，原始解析度圖片 |
| 中國平台圖文+留言 | MediaCrawler | 含留言、創作者 profile |

### 決策原則

- OpenClaw 用戶：用 summarize + video-frames（預載的，零設定）
- Claude Code / Hermes 用戶：用 transcribe + ffmpeg（品質更好，功能更多）
- 需要 speaker diarization：必須用 elevenlabs.sh
- 需要畫面分析：必須用 ffmpeg 抽幀 + Claude vision
