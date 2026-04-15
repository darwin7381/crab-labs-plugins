# STT Providers 測試紀錄

> 每次測試新模型或新參數都記在這裡，作為 skill 開發的 baseline 比較。
> 新模型出來時對照這份紀錄決定是否升級。

---

## 測試音訊

| 檔案 | 長度 | 語言 | 內容 | 說話者 |
|---|---|---|---|---|
| hermes.m4a | 13:32 (812s) | 中文（中英夾雜） | Hermes Agent 技術介紹 | 單人 |

---

## 2026-04-14 測試結果

### OpenAI Whisper API (whisper-1)

| 參數 | 值 |
|---|---|
| mode | api (--mode auto) |
| model | whisper-1 |
| format | srt |
| 檔案限制 | 25MB（腳本自動壓縮繞過） |

結果：
- 1565 行 SRT
- 中文內容基本正確
- 英文術語辨識不佳（"openclose" 而非 OpenClaw）
- "homies agent" 而非 Hermes Agent
- 有基本標點和斷句

加 Gemini refine 後：
- 標點完整、斷句自然
- 英文術語大寫正確（GitHub, Stars, AI Agent）
- 仍然把 "Hermes" 聽成 "Homies"
- **目前中文科技內容的最佳組合**

---

### AssemblyAI

#### Universal-3 Pro 測試

| 參數 | 值 | 結果 |
|---|---|---|
| speech_models: ["universal-3-pro"], language_code: "zh" | 指定中文 | **ERROR: zh is not supported by universal-3-pro** |
| speech_models: ["universal-3-pro"], language_detection: true | 自動偵測 | 偵測到 zh 後 **ERROR: 同上** |

**結論：Universal-3 Pro 不支援中文，不管指定還是 auto detect 都會失敗。**
U3 Pro 只支援 6 語言：EN, ES, PT, FR, DE, IT。

#### Universal-2 測試

| 參數 | 值 |
|---|---|
| speech_models | ["universal-2"] 或 ["universal-3-pro", "universal-2"] (fallback) |
| language_code | "zh" 或 auto detect（結果相同） |
| speaker_labels | true |
| speakers_expected | 1 |
| 檔案限制 | 無限制（URL 上傳） |

結果：
- 2553 words
- 1 utterance（整段話沒分段）
- "aiagent" 黏在一起無空格
- "openclose"（應為 OpenClaw）
- "homiesagent"（應為 Hermes Agent）
- 無標點符號
- 英文全小寫
- Speaker diarization 只偵測到 1 人（正確但無分段）

**中文品質明顯不如 Whisper + Gemini refine。**
**強項在 diarization（多人場景）、LeMUR 分析、無檔案大小限制。**

#### 重要 API 注意事項

- 參數是 `speech_models`（複數），不是 `speech_model`（單數，已棄用）
- `best` 和 `nano` 值已棄用，用 `universal-3-pro` 和 `universal-2`
- `auto_chapters` 對中文會 500 error
- 免費額度：185 小時
- 定價：$0.15/hr (U2), diarization +$0.02/hr

---

### ElevenLabs Scribe v2

#### 無 keyterms 測試

| 參數 | 值 |
|---|---|
| model_id | scribe_v2 |
| language_code | zho |
| diarize | true |
| num_speakers | 1 |
| timestamps_granularity | word |
| tag_audio_events | true |
| 檔案限制 | 3GB（直接上傳）/ 2GB（cloud URL） |

結果：
- 4123 words（比 AssemblyAI 更細粒度）
- "Homie"（應為 Hermes Agent）
- "OpenCall"（應為 OpenClaw）
- "AI Agent" 正確大寫
- "GitHub" 正確大寫
- 無標點
- Speaker 1 正確偵測
- Word-level timestamps 精確到每個中文字

#### 有 keyterms 測試

| 額外參數 | 值 |
|---|---|
| keyterms | Hermes Agent, OpenClaw, Claude Code, GitHub, SQLite, ChromaDB, AI Agent, Telegram, Discord |

結果：
- **"Hermes Agent" 正確辨識**（keyterms 生效）
- "OpenClaude"（接近但仍不完全對，應為 OpenClaw）
- 其他英文術語大寫正確
- 4123 words
- 無標點（需 LLM 後處理）

**keyterms 對專有名詞辨識有顯著效果，建議必帶。**
**中文品質優於 AssemblyAI U2，但不如 Whisper + Gemini refine（缺標點）。**

#### API 注意事項

- keyterms 用 multipart form 傳，每個 term 一個 `-F "keyterms=XXX"`
- 不能用 JSON array 傳 keyterms（會報 invalid_keyword_length）
- 每個 keyterm < 50 字元，最多 1000 個
- keyterms 加收 20%（$0.05/hr）
- entity_detection 加收 30%
- max speakers: 32
- 定價：$0.22/hr

---

## 中文科技內容品質排名（2026-04-14 baseline）

| 排名 | Provider | 品質描述 | 標點 | 專有名詞 | diarization |
|---|---|---|---|---|---|
| 1 | Whisper + Gemini refine | 最完整，有標點斷句 | ✅ | ⚠️ Gemini 可修正部分 | ❌ |
| 2 | ElevenLabs Scribe v2 + keyterms | 好，無標點但術語好 | ❌ 需後處理 | ✅ keyterms 有效 | ✅ max 32 |
| 3 | AssemblyAI Universal-2 | 弱，英文全小寫黏一起 | ❌ | ❌ | ✅ max 30 |

## 待測試（未來）

- [ ] Qwen3-ASR-1.7B（阿里開源 SOTA，超過 Whisper）
- [ ] 科大訊飛 iFlytek API（商用最強中文 STT）
- [ ] SenseVoice（阿里開源，快 15x）
- [ ] Gladia Solaria-1（100+ 語言 code-switching）
- [ ] AssemblyAI 新模型（U3 Pro 未來可能支援中文）
- [ ] ElevenLabs 新版本
