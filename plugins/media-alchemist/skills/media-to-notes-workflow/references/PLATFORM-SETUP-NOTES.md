# 平台工具設定筆記與踩雷紀錄

> 使用各平台下載工具時的注意事項和已知問題。

---

## MediaCrawler（中國平台爬蟲）

安裝位置：由 .local.md 的 mediacrawler_path 設定
Python 管理：uv（不是 venv）

### 小紅書 — 地區封鎖問題

部分地區封鎖了 xiaohongshu.com 網域，Playwright 連不上。
錯誤訊息：ERR_CERT_AUTHORITY_INVALID 或「此網域已經遭到封鎖」

解法：
1. config/base_config.py 改 XHS_INTERNATIONAL = True
   → 走 rednote.com（國際版）
2. media_platform/xhs/core.py 的 launch_browser 加 ignore_https_errors=True
3. .local.md 設 xiaohongshu_domain: rednote.com

### Playwright 反爬偵測

小紅書可能偵測到 Playwright 的自動化 Chromium。
解法選項：
- XHS_INTERNATIONAL = True（走國際版）
- ENABLE_CDP_MODE = True（用真實 Chrome，反偵測更強）

### 登入方式

每個平台第一次使用要 QR code 掃碼登入：
```bash
cd <mediacrawler_path> && uv run python main.py --platform <平台> --lt qrcode --keywords "test"
```
平台代碼：xhs / dy / bili / wb / ks / zhihu / tieba
登入後 cookie 快取在 browser_data/，之後不用再掃。

### 使用注意

- 爬完要 Ctrl+C 停
- keywords 用英文逗號分隔
- --type search / detail / creator
- 內建每抓一篇休眠 2 秒（防封）

---

## gallery-dl

安裝：brew install gallery-dl
用途：西方平台圖片/畫廊下載（389+ 網站）
注意：部分平台需要 cookies（IG、FB），用 --cookies-from-browser chrome

---

## lux

安裝：brew install lux
用途：中國平台影片下載（B站 VIP、抖音、快手等）
注意：跟 yt-dlp 互補。中國平台用 lux，西方平台用 yt-dlp。

---

## ElevenLabs + Gemini refine 組合注意

當 ElevenLabs 用 keyterms 正確辨識了專有名詞時，
Gemini refine 可能把正確的名詞「修正」成錯的（因為 refine prompt 沒帶 keyterms）。

解法（待實作）：refine.sh 需要支援傳入 keyterms。
目前：如果 refine 把名詞搞壞，以 ElevenLabs 原版為準。

---

## 工具選擇指南：普通 vs 進階

### 影片抽幀

| 場景 | 工具 |
|---|---|
| 簡易快速縮圖 | ffmpeg frame.sh |
| 批次/filmstrip/關鍵幀 | ffmpeg 直接指令 |

### 轉錄

| 場景 | 工具 |
|---|---|
| 一般影片 | Whisper + Gemini refine |
| 多人對話 | ElevenLabs + Gemini refine |
| 英文內容 | AssemblyAI + Gemini refine |

### 下載

| 場景 | 工具 |
|---|---|
| YouTube / 西方影片 | yt-dlp |
| 西方圖文 | gallery-dl |
| 中國平台 | MediaCrawler 或 lux |
