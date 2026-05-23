# telegram-http + discord-http — 完整 Setup 教學

> 從零開始把 Route B HTTP MCP Telegram / Discord plugin 跑起來。涵蓋 plugin install、bot 設定（含 ackReaction emoji 原則）、managed-settings.json 政策、launchd daemon、claude TUI 啟動、配對、測試、supervisor agent 整合、排錯。

**Plugin repo**：https://github.com/darwin7381/crab-labs-plugins
- `plugins/telegram-http/` — Telegram bridge plugin
- `plugins/discord-http/` — Discord bridge plugin
- 兩個 plugin 同 source / 同 architecture，只差 bot 平台

**直接連結**：
- [telegram-http/SETUP.md](https://github.com/darwin7381/crab-labs-plugins/blob/main/plugins/telegram-http/SETUP.md) — 本檔的 GitHub 版本
- [telegram-http/README.md](https://github.com/darwin7381/crab-labs-plugins/blob/main/plugins/telegram-http/README.md) — 架構 + Quick start
- [telegram-http/ARCHITECTURE.md](https://github.com/darwin7381/crab-labs-plugins/blob/main/plugins/telegram-http/ARCHITECTURE.md) — Route B 設計原理 + stdio death cycle 分析
- [telegram-http/CHANGELOG.md](https://github.com/darwin7381/crab-labs-plugins/blob/main/plugins/telegram-http/CHANGELOG.md) — 版本變更

---

## 0. 這份 fork 解決什麼

官方 `telegram@claude-plugins-official` plugin 把 bot 跑在 claude TUI 的 stdio child process — claude TUI 重啟 / 任何 stdio glitch → bot 跟著死。實測 2-244 秒就死一次。

這份 fork（**Route B**）把 bot 拆成獨立 HTTP MCP daemon：
- daemon 由 launchd 監管，常駐
- claude TUI 透過 `StreamableHTTPClientTransport` 連 daemon
- claude TUI 重啟 daemon 不動，重連即可
- 訊息在 claude 斷線期間有 disk + memory **replay queue**，不掉資料

詳細架構：[ARCHITECTURE.md](./ARCHITECTURE.md)。設計原理 + 為何官方 stdio 必死：HedgeDoc [Route B 完整記錄](https://md.blocktempo.ai/B_MVqPMbQsyLLxo7oGnTdg)。

---

## 1. 前置需求

| 需求 | 安裝 |
|---|---|
| macOS（測過）或 Linux | — |
| **claude code 2.1.140（pinned，不能跟 symlink）** | ⚠️ **2.1.141 ~ 2.1.148 全部有 HTTP MCP transport silent disconnect regression** — bot 看起來活但收不到訊息。詳見 §11.2 + 下方版本鎖定流程 |
| [Bun](https://bun.sh/) | `curl -fsSL https://bun.sh/install \| bash` |
| Telegram bot token | DM [@BotFather](https://t.me/BotFather) → `/newbot` |
| Discord bot token（若要 discord） | [Discord Developer Portal](https://discord.com/developers/applications) → Bot → Reset Token |
| launchd（macOS）/ systemd（Linux） | 系統內建 |
| tmux | `brew install tmux` |
| Joey 的 Telegram user ID | DM [@userinfobot](https://t.me/userinfobot) 取得 |

### 🔴 必做：claude 版本鎖定 + 關閉自動更新

> ⚠️ **不要被本 plugin 1.0.2 的 keepalive patch 誤導**：那個 patch 解的是 **daemon 端**「不知道客戶端死了、繼續廣播到死信箱」的問題。Plugin 1.0.2 + claude 2.1.148 一起跑 **bot 還是會壞** — 因為 claude TUI 端 transport 自己死掉之後**不會自動重連**（這是 client side bug、daemon 無能為力）。
>
> **Pin 到 2.1.140 是必做、不是 belt-and-suspenders、不是 optional**。 Plugin 1.0.2 是加保險、不是替代品。詳見 §11.2 problem A vs problem B 拆分。

Anthropic claude-code 自帶 auto-updater，背景偷偷把 symlink 升到 npm latest（截至 2026-05-22 是 2.1.148）。**2.1.141~2.1.148 全部有 regression bug、會把你 bot 變成「看起來活但收不到訊息」**。

兩層防護必須做：

**(a) Pin claude binary 到 2.1.140**（從 npm registry 拉、永久保存到 auto-updater 摸不到的位置）：

```bash
# 1. 抓 2.1.140 binary（npm registry 還在保留所有歷史版本）
cd /tmp && rm -rf claude-2.1.140 && mkdir claude-2.1.140 && cd claude-2.1.140
npm pack @anthropic-ai/claude-code-darwin-arm64@2.1.140  # 或 linux-x64 / darwin-x64 ...
tar xzf anthropic-ai-claude-code-darwin-arm64-2.1.140.tgz
chmod +x package/claude
./package/claude --version  # 應輸出: 2.1.140 (Claude Code)

# 2. 保存到 auto-updater 摸不到的位置
mkdir -p ~/.local/share/claude-pinned
cp package/claude ~/.local/share/claude-pinned/2.1.140
chmod +x ~/.local/share/claude-pinned/2.1.140

# 後續所有 claude TUI / supervisor manifest / wrapper script 都指這個 explicit 路徑
# 不要用 bare `claude` 指令、不要用 ~/.local/bin/claude symlink
```

**(b) 關閉 auto-updater**（只擋背景升、`claude update` 手動指令仍能用）：

```bash
# 1. launchctl 全域（活著的 launchd procs 立即生效）
launchctl setenv DISABLE_AUTOUPDATER 1

# 2. ~/.zshrc export（新 terminal 也有）
echo "export DISABLE_AUTOUPDATER=1" >> ~/.zshrc

# 3. LaunchAgent plist（重開機後自動再 setenv）
cat > ~/Library/LaunchAgents/com.btai.disable-autoupdater.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.btai.disable-autoupdater</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/launchctl</string>
    <string>setenv</string>
    <string>DISABLE_AUTOUPDATER</string>
    <string>1</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.btai.disable-autoupdater.plist
```

差別：
- `DISABLE_AUTOUPDATER=1` 只擋背景、`claude update` 手動仍可用 — 適合「我們想自己決定何時升」的場景
- `DISABLE_UPDATES=1` 兩個都擋（連手動 `claude update` 也擋）— 更激進

### 📡 等待 Anthropic 修復這個 regression（最終解）

追蹤上游看這條 issue：[anthropics/claude-code#60061](https://github.com/anthropics/claude-code/issues/60061)（2026-05-17 開、狀態 OPEN、最直接對應症狀）

其他相關 issue（佐證 bug 嚴重性 / 跨多版本確認）：
- [#21721](https://github.com/anthropics/claude-code/issues/21721) — "MCP HTTP transport fails after ~89 minutes without automatic reconnection"
- [#59956](https://github.com/anthropics/claude-code/issues/59956) — "HTTP MCP servers working in 2.1.140 and broken in 2.1.142"
- [#36308](https://github.com/anthropics/claude-code/issues/36308) — auto-reconnect feature request
- [#43177](https://github.com/anthropics/claude-code/issues/43177) — stdio 同類問題

Anthropic 官方 docs（[Automatic reconnection](https://code.claude.com/docs/en/mcp#automatic-reconnection)）承諾 5x exponential backoff reconnect、**實作沒做到**。

Anthropic 修了之後（會出現在 2.1.149+ changelog 含 MCP / transport / SSE / reconnect 修補字眼）→ 跑 §11.2 升 pin SOP。

---

驗證 binary 已備好 + auto-updater 已關：

```bash
ls -la ~/.local/share/claude-pinned/2.1.140                     # 200MB 左右
~/.local/share/claude-pinned/2.1.140 --version                  # → 2.1.140 (Claude Code)
launchctl getenv DISABLE_AUTOUPDATER                            # → 1
```

### 🚫 多機器部署規則：每台一個 bot token（**禁止兩台 share token**）

### ⚠️ MUST: disable official `telegram@claude-plugins-official` plugin everywhere

If you have BOTH the official `telegram` plugin AND this fork (`telegram-http`) enabled in
`~/.claude/settings.json` `enabledPlugins`, **every claude TUI session that starts will spawn
the official plugin's stdio child process** — which polls Telegram with whatever bot token sits
in `~/.claude/channels/telegram/.env`. If the same token is being polled by your `telegram-http`
HTTP daemon, you get **persistent `409 Conflict` from Telegram** and inbound messages stop
reaching the daemon entirely. **This is independent of the bot-token-collision case below**;
it happens with a SINGLE token too, because two callers (one in this machine alone) are
polling the same token.

```bash
# Verify + auto-fix in user-level settings.json:
python3 -c "
import json
p = '/Users/$(whoami)/.claude/settings.json'
with open(p) as f: s = json.load(f)
ep = s.setdefault('enabledPlugins', {})
changed = False
for k in ['telegram@claude-plugins-official', 'discord@claude-plugins-official']:
    if ep.get(k) is True:
        ep[k] = False
        changed = True
        print(f'disabled: {k}')
if changed:
    with open(p, 'w') as f: json.dump(s, f, indent=2)
"
```

Restart any claude TUI that's already running so it doesn't keep its existing official-plugin
child alive. Migration history: 2026-05-13 we kept both enabled as fallback during Route B
rollout; 2026-05-23 a new agent triggered the 409 loop and we made disable mandatory.

---

如果你的 Mac mini + MBP 都想跑 channel-bot daemon（兩台都 always-on），**絕對不能讓兩個 daemon 用同一個 Telegram bot token / Discord bot token**：

```
場景：兩台機器、同一個 @MyBot token
  ↓
兩個 daemon 同時 Telegram getUpdates long-poll
  ↓
Telegram 回 409 Conflict — 「another instance is polling」
  ↓
兩邊互相 race、訊息只給最後 poll 的那個、不一致 / 不可預期
  ↓
Discord gateway 同樣場景：兩個 discord.js client 用同 token connect
  → 互相斷對方（gateway 只允許一條 active connection）
```

**正確做法 — 二選一**：

| 方案 | 適用情境 |
|---|---|
| **A. 每台機器自己一個 bot 帳號**（不同 token） | 兩台都要 always-on、各自獨立識別、Joey 視為兩條 bot 切換 |
| **B. 只有 Mac mini 跑 daemon、MBP SSH 進去用** | 主機是 Mac mini、MBP 是出門備援、不重複跑 |

我們目前部署是 **方案 B**（Mac mini 在台灣家裡常駐、Joey 從日本 Parsec/SSH 過去）。如果要走方案 A，每台機器：
- 另開一個 bot（BotFather `/newbot`）→ 拿不同 token
- 不同 `STATE_DIR`（譬如 `~/.claude/channels/telegram-mbp/`）
- 不同 launchd label（譬如 `com.btai.telegram-daemon.channel-mbp`）
- 不同 HTTP port（譬如 17731 vs Mac mini 的 17631）
- Joey TG client 同時看到兩條 bot 對話、切換時注意是哪台

**Plugin 本身完全支援 multi-instance**（advisory lock + STATE_DIR 隔離），**限制在 Telegram / Discord API 那一邊 — 同 token 只能一個 poller**。

---

## 2. 安裝 plugin

在 claude TUI 裡：

```
/plugin marketplace add darwin7381/crab-labs-plugins
/plugin install telegram-http@crab-labs-plugins
/plugin install discord-http@crab-labs-plugins   # 若需要 discord
```

驗證 cache 已下載：

```bash
ls ~/.claude/plugins/cache/crab-labs-plugins/telegram-http/1.0.0/
# 應該看到 .claude-plugin/  .mcp.json  server.ts  skills/  package.json ...
```

確認 `.mcp.json` 含 `?v=crab-labs` URL 差異化（避免被官方 plugin 的 dedup 邏輯 suppress）：

```bash
cat ~/.claude/plugins/cache/crab-labs-plugins/telegram-http/1.0.0/.mcp.json
```

期待輸出：

```json
{
  "mcpServers": {
    "telegram-http": {
      "type": "http",
      "url": "http://127.0.0.1:${TELEGRAM_HTTP_PORT}/mcp?v=crab-labs"
    }
  }
}
```

> ⚠️ 沒有 `?v=crab-labs` 的話，claude TUI 會把這 plugin 跟官方 `telegram` plugin 視為 duplicate 並 suppress 掉。詳見 §11.1。

---

## 3. 設定 bot — 每個 bot 一份 STATE_DIR

每個 bot（不同 Telegram bot username）需要獨立 state dir。範例：

| Bot 用途 | STATE_DIR | HTTP PORT |
|---|---|---|
| channel bot（你自己跟 claude 對話） | `~/.claude/channels/telegram/` | 17631 |
| supervisor agent: builder | `~/cc-workspaces/claude-builder/.telegram-state/` | 17634 |
| supervisor agent: research | `~/cc-workspaces/claude-research/.telegram-state/` | 17633 |
| supervisor agent: video-master | `~/cc-workspaces/claude-video-master/.telegram-state/` | 17632 |

端口要互相不同。channel bot 用 17631（傳統），其他從 17632 開始。

### 3.1 寫 token

```bash
STATE_DIR=~/.claude/channels/telegram   # 換成你的目標目錄
mkdir -p "$STATE_DIR"
echo "TELEGRAM_BOT_TOKEN=123456789:AAHxxxxxxxxxxxx" > "$STATE_DIR/.env"
chmod 600 "$STATE_DIR/.env"
```

Discord 對應 `DISCORD_BOT_TOKEN`。

### 3.2 寫 access.json

`access.json` 控制誰可以跟這 bot 對話 + 互動行為（ackReaction emoji、dmPolicy 等）。

```bash
cat > "$STATE_DIR/access.json" <<'EOF'
{
  "dmPolicy": "approved-only",
  "ackReaction": "👀",
  "approved": [
    { "user_id": "1828173984", "username": "Advac777", "added_at": "2026-05-14T00:00:00Z" }
  ],
  "groups": {}
}
EOF
chmod 600 "$STATE_DIR/access.json"
```

#### 3.2.1 ackReaction emoji 原則

`ackReaction` 是「daemon 收到訊息後自動加在使用者訊息上的 emoji」。提供「我收到了」的即時訊號（plugin 自動處理，不需 claude 介入）。

**推薦設 `"👀"`**：

| 原因 | 解釋 |
|---|---|
| 即時 | daemon 收到訊息瞬間就加 emoji，比 claude reply 快 |
| 非阻塞 | claude 還在思考，使用者已知道訊息有進來 |
| 留檔 | reaction 顯示在訊息旁，永久可見，不像 typing indicator 5 秒就消失 |
| 不打擾 | reaction 不會 push 通知 |

Claude 自己回應時應該挑**不一樣的** emoji（語境特定），避免重複跟 ackReaction 一樣的：

| 情境 | Claude 用的 emoji |
|---|---|
| 收到指令、馬上動 | 🫡 |
| 完全認同 | 💯 |
| 完成 / 成功 | ✅ / 👌 |
| 思考中 / 研究中 | 🤔 |
| 失敗 / 卡住 | ❌ |
| 重大發現 | 🔥 |
| 執行中 | 💪 |
| 檢查中 | 🔍 |

> ⚠️ Telegram 只接受官方 whitelist 的 emoji 作為 reaction。不在 whitelist 的會回 `REACTION_INVALID`，daemon swallow。`👀` `🫡` `💯` `✅` `🤔` `❌` `🔥` `💪` 都在 whitelist。`👌` 可以。冷門 emoji 不行。

#### 3.2.2 dmPolicy 選項

```json
"dmPolicy": "approved-only"   // 推薦：只有 approved 名單可以 DM
"dmPolicy": "pairing"         // 任何人 DM 都會收到 pairing code，回 /telegram:access pair <code> 才能加入
"dmPolicy": "open"            // 任何人都可 DM（不推薦，spam 風險）
```

---

## 4. managed-settings.json — 啟用 channels 政策

⚠️ 這步是 **必須**（claude 2.1.141+ 強制檢查）。沒做的話 channel notification 會被 policy gate 攔下，pane 不會 render。

### 4.1 路徑

macOS：`/Library/Application Support/ClaudeCode/managed-settings.json`（root:admin 擁有）

### 4.2 創建

```bash
sudo mkdir -p '/Library/Application Support/ClaudeCode'
sudo tee '/Library/Application Support/ClaudeCode/managed-settings.json' <<'EOF'
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "claude-plugins-official", "plugin": "telegram" },
    { "marketplace": "claude-plugins-official", "plugin": "discord" },
    { "marketplace": "crab-labs-plugins",       "plugin": "telegram-http" },
    { "marketplace": "crab-labs-plugins",       "plugin": "discord-http" }
  ]
}
EOF
```

驗證：

```bash
cat '/Library/Application Support/ClaudeCode/managed-settings.json'
```

四個 plugin 全部進 allowlist。連官方一起加進去，避免日後切回時還要再 sudo。

### 4.3 為什麼用 managed-settings.json 而不是 `~/.claude/settings.json`？

`allowedChannelPlugins` 是 **managed-only** 設定（org policy scope）。Anthropic 不允許 user-level settings 自行解鎖 channels — 必須由 `/Library/Application Support/ClaudeCode/` 那個 root-owned 檔案 gate。這是 design choice（防 prompt-injection 自我授權）。

---

## 5. 啟用 plugins + 在 settings.json 標 enabled

`~/.claude/settings.json` 要包含這四個 plugin：

```json
{
  "enabledPlugins": {
    "telegram@claude-plugins-official":      true,
    "discord@claude-plugins-official":       true,
    "telegram-http@crab-labs-plugins":       true,
    "discord-http@crab-labs-plugins":        true
  },
  "extraKnownMarketplaces": {
    "crab-labs-plugins": {
      "source": { "source": "github", "repo": "darwin7381/crab-labs-plugins" }
    }
  }
}
```

> 註：保留官方 telegram/discord plugin enabled 不影響 crab-labs 版本（URL dedup 已用 `?v=crab-labs` 避開）。同時保留兩邊可以彈性回切。

---

## 6. 設定 daemon — launchd plist

每個 bot 一份 plist。範例給 channel bot (port 17631)：

### 6.1 寫 plist

```bash
USERNAME=$(whoami)
PLIST=~/Library/LaunchAgents/com.btai.telegram-daemon.channel.plist
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.btai.telegram-daemon.channel</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/${USERNAME}/.bun/bin/bun</string>
    <string>run</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/${USERNAME}/.claude/plugins/cache/crab-labs-plugins/telegram-http/1.0.0</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/Users/${USERNAME}/.bun/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>/Users/${USERNAME}</string>
    <key>TELEGRAM_STATE_DIR</key><string>/Users/${USERNAME}/.claude/channels/telegram</string>
    <key>TELEGRAM_HTTP_PORT</key><string>17631</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/Users/${USERNAME}/.claude/channels/telegram/launchd.out.log</string>
  <key>StandardErrorPath</key><string>/Users/${USERNAME}/.claude/channels/telegram/launchd.err.log</string>
</dict>
</plist>
EOF
```

### 6.2 啟動

```bash
launchctl bootstrap gui/$(id -u) "$PLIST"
# 之後修改要 reload 用：
# launchctl bootout gui/$(id -u) "$PLIST" && launchctl bootstrap gui/$(id -u) "$PLIST"
```

### 6.3 驗證

```bash
# daemon process 在
launchctl list | grep telegram-daemon

# 監聽 port
lsof -i :17631 | grep LISTEN

# 健康端點
curl -s http://127.0.0.1:17631/healthz | python3 -m json.tool
```

期待 `/healthz` 回：

```json
{
  "ok": true,
  "plugin": "telegram-http",
  "bot_username": "your_bot_username",
  "uptime_s": 12,
  "active_sessions": 0,
  "polling": true,
  "pid": 12345
}
```

### 6.4 Discord daemon

完全一樣，路徑換成 `discord-http`，env 換成 `DISCORD_HTTP_PORT` + `DISCORD_STATE_DIR`，port 用 17641。

```bash
PLIST=~/Library/LaunchAgents/com.btai.discord-daemon.channel.plist
# (改上面 plist 把 telegram 全部換成 discord)
```

### 6.5 多個 bot

每個 bot 一份 plist + 一份 STATE_DIR + 不同 PORT。例：

| Label | STATE_DIR | PORT | 用途 |
|---|---|---|---|
| `com.btai.telegram-daemon.channel` | `~/.claude/channels/telegram` | 17631 | channel bot |
| `com.btai.telegram-daemon.builder` | `~/cc-workspaces/claude-builder/.telegram-state` | 17634 | builder agent |
| `com.btai.telegram-daemon.research` | `~/cc-workspaces/claude-research/.telegram-state` | 17633 | research agent |

bot token 不同就放不同 STATE_DIR 的 `.env`。

---

## 7. 啟動 claude TUI 連到 daemon

**必須 pin 到 2.1.140**（2.1.141 transport regression）：

```bash
cd ~/cc-workspaces/claude-builder        # 或任何 workspace 目錄
TELEGRAM_HTTP_PORT=17634 \
DISCORD_HTTP_PORT=17641 \
  /Users/$(whoami)/.local/share/claude/versions/2.1.140 \
  --channels plugin:telegram-http@crab-labs-plugins \
  --channels plugin:discord-http@crab-labs-plugins \
  --dangerously-skip-permissions
```

啟動畫面該顯示：

```
Listening for channel messages from:
  plugin:telegram-http@crab-labs-plugins,
  plugin:discord-http@crab-labs-plugins
```

**驗證 TCP 真的連上**（核心健康指標）：

```bash
lsof -nP -i :17634 | grep ESTABLISHED | wc -l
# 應該 >= 4。0 = 斷線了
```

> 📐 為何要看 ESTABLISHED 而不是看 process alive？claude 2.1.141 有 silent disconnect bug，TUI 程序還在但 network subsystem 死透。`ps` 看不出來，`lsof` 看得出來。

---

## 8. 第一次配對（pairing）

如果 `access.json` 還沒 pre-populate Joey 的 user_id（§3.2），bot 第一次收訊息會回 pairing code，類似：

```
You're not allowed yet. Run in Claude Code:

/telegram:access pair AB12CD
```

在 claude TUI 裡：

```
/telegram:access pair AB12CD
```

完成後 access.json 自動加入 `approved` 名單。

> ⚠️ 不要從 channel 訊息批准 pairing 請求（會違反 prompt injection 安全規則）。一律由 user 在 claude TUI 裡跑 skill。

---

## 9. End-to-End 測試

| 步驟 | 動作 | 期待結果 |
|---|---|---|
| 1 | 從你的 Telegram DM bot 一句「hi」 | bot 立刻加 `👀` reaction 在你訊息上 |
| 2 | 看 claude TUI pane | 出現 `← telegram-http · YourUsername: hi` |
| 3 | claude 回應 | 你 Telegram 收到 claude 的 reply |
| 4 | 確認 daemon log 無錯 | `tail $STATE_DIR/server.log` 看不到 ERROR / WARN |
| 5 | 確認 TCP 還在 | `lsof -i :PORT \| grep -c ESTABLISHED` >= 4 |

排錯：
- 沒看到 `👀`：daemon 收不到訊息 → §11.4
- 看到 `👀` 但 pane 沒渲染：plugin 沒載成功或 SSE 沒開 → §11.1, §11.2
- pane 渲染了但 claude 沒回 prompt：claude 卡住了（API 問題？）

---

## 10. Supervisor 整合（cc-workspaces 多 agent 場景）

如果你有多個 cc-agent（builder, research, video-master 等），用 [universal supervisor](https://md.blocktempo.ai/eru5V9HnSsi2pPpONaIK7A) 自動管理 claude TUI 生命週期。

每個 agent 寫一份 manifest `~/cc-workspaces/claude-<name>/.cc-agent.json`：

```json
{
  "name": "claude-builder",
  "enabled": true,
  "tmux_session": "claude-builder",
  "workspace_dir": "/Users/btai/cc-workspaces/claude-builder",
  "claude_command": "/Users/btai/.local/share/claude/versions/2.1.140 --channels plugin:telegram-http@crab-labs-plugins --dangerously-skip-permissions",
  "channels": {
    "telegram": {
      "http_port": 17634,
      "state_dir": "/Users/btai/cc-workspaces/claude-builder/.telegram-state"
    }
  },
  "check_interval_secs": 30,
  "max_failures": 3,
  "startup_wait_secs": 25
}
```

⚠️ `claude_command` 一定要用 **顯式 2.1.140 路徑**，不要用 `claude`（symlink 會指到 2.1.141）。

---

## 11. Troubleshooting

### 11.1 「Suppressing plugin MCP server "plugin:telegram-http:telegram-http": duplicates ...」

**現象**：debug log 看到上面那行，crab-labs plugin 被 suppress，supervisor agent 收訊息但 claude 不回。

**原因**：claude TUI 用 URL 做 dedup signature（`YjH(config)`）。如果 `.mcp.json` URL 跟其他 plugin 一樣，會被當 duplicate。

**修法**：cache + marketplace 的 `.mcp.json` URL 加 `?v=crab-labs` query string：

```bash
# Cache（claude 實際讀的）
for plugin in telegram-http discord-http; do
  env_var=$(echo $plugin | tr 'a-z-' 'A-Z_'  | sed 's/HTTP/HTTP_PORT/')
  jq --arg url "http://127.0.0.1:\${$env_var}/mcp?v=crab-labs" \
    --arg key $plugin \
    '.mcpServers = {($key): {type:"http", url: $url}}' \
    ~/.claude/plugins/cache/crab-labs-plugins/$plugin/1.0.0/.mcp.json \
    > /tmp/$plugin.mcp.json && mv /tmp/$plugin.mcp.json \
    ~/.claude/plugins/cache/crab-labs-plugins/$plugin/1.0.0/.mcp.json
done
```

驗證：跑 `claude --debug-file /tmp/x.log --print "ok" --channels plugin:telegram-http@crab-labs-plugins`，`grep -E 'Suppressing|Channel notifications re-registered' /tmp/x.log`，應該看到 "Channel notifications re-registered after reconnect" 且**沒有** Suppressing 行。

詳見 memory `project_plugin_url_dedup.md`。

### 11.2 claude TUI 看似在 listen 但 `lsof -i :PORT` 顯示 0 ESTABLISHED（**最常見 regression 症狀**）

**現象**：
- claude pane 顯示 "Listening for channel messages from: ..."
- daemon 收到訊息（`lastUpdate` 在遞增、log 有 broadcast 嘗試）
- 但 claude 端永遠不渲染
- `lsof -p <claude_pid> -i :PORT` 顯示 0 ESTABLISHED（process 還在、network 死了）

**根本原因**：**claude-code 2.1.141 ~ 2.1.148 全部有 HTTP MCP transport silent disconnect regression**（不是只有 2.1.141）。Anthropic docs（[Automatic reconnection](https://code.claude.com/docs/en/mcp#automatic-reconnection)）承諾 5x exponential backoff reconnect、實作沒做到 → SDK 連線斷掉短暫嘗試後 give up、process 還在 network 死了。

**已驗證的 GitHub issues**：
- [#60061](https://github.com/anthropics/claude-code/issues/60061) — 2026-05-17 開、OPEN、Anthropic 還沒回。**watch this for the fix**。
- [#21721](https://github.com/anthropics/claude-code/issues/21721) — "MCP HTTP transport fails after ~89 minutes without automatic reconnection"（時間跟症狀完全對得上）
- [#59956](https://github.com/anthropics/claude-code/issues/59956) — "HTTP MCP servers working in 2.1.140 and broken in 2.1.142"（regression boundary 確認）
- [#36308](https://github.com/anthropics/claude-code/issues/36308) / [#43177](https://github.com/anthropics/claude-code/issues/43177) — 其他相關

**主要修法**：pin 到 2.1.140（不在 regression 範圍內、唯一已驗證 stable 的版本）。**參考 §1 的「STRONG RECOMMENDATION：版本鎖定 + 關閉自動更新」section**。`/Users/$(whoami)/.local/share/claude-pinned/2.1.140` 在所有 supervisor manifest / channel-bot wrapper / 任何 `claude --channels` 啟動指令都用 explicit 路徑、不要用 bare `claude`。

**次要保險（daemon-side mitigation）**：plugin v1.0.2 加了 daemon dead-transport detection（TCP keepalive + SSE comment heartbeat）— daemon 30-90s 偵測死客戶端、清 zombie session、不再廣播到死信箱。**但這不解決「claude 端不重連」這個 root cause**，只解決 daemon side 殭屍累積問題（v1.0.1 daemon 1 週累積 2269 / 2332 殭屍 session、v1.0.2 daemon `active_sessions` 應穩定維持在小範圍）。詳見 CHANGELOG.md 1.0.2 章節 + ARCHITECTURE.md「Dead-transport detection」段。

**怎麼知道 Anthropic 修了**：
1. Watch [#60061](https://github.com/anthropics/claude-code/issues/60061) — closed + linked PR / mentioned version = 修了
2. `npm view @anthropic-ai/claude-code version` 看到 2.1.149+ + 該版 changelog 含 MCP / HTTP / transport / SSE / reconnect 字眼
3. 修了之後跑下面升 pin SOP

**升 pin SOP（when Anthropic ships fix）**：

```bash
# 1. 假設新版是 2.1.149，從 npm 抓
cd /tmp && rm -rf test-249 && mkdir test-249 && cd test-249
npm pack @anthropic-ai/claude-code-darwin-arm64@2.1.149
tar xzf anthropic-ai-claude-code-darwin-arm64-2.1.149.tgz
chmod +x package/claude
./package/claude --version  # 確認 2.1.149

# 2. 1 小時 sandbox 測試（在一個非 production tmux 跑、確認 fix 真的修了）
tmux new -d -s claude-test "cd /tmp && /tmp/test-249/package/claude --channels plugin:telegram-http@crab-labs-plugins --dangerously-skip-permissions"
# 等 1+ 小時
TUI_PID=$(pgrep -f "test-249/package/claude" | head -1)
lsof -p $TUI_PID -i :17631 | grep -c ESTABLISHED  # 應 >= 1（沒掉到 0）

# 3. fix 確認 → 升 pin（覆蓋同檔名最簡單）
cp /tmp/test-249/package/claude ~/.local/share/claude-pinned/2.1.140
# 或改用新檔名 + 改 wrapper（更乾淨）:
# cp ... ~/.local/share/claude-pinned/2.1.149
# sed -i '' 's|claude-pinned/2.1.140|claude-pinned/2.1.149|g' ~/.claude/workspace-telegram/scripts/restore-channel-bot.sh

# 4. 重啟讓新 binary 上身
launchctl kickstart -k gui/$(id -u)/com.btai.channel-bot-wrapper
```

舊 pin（`/claude-pinned/2.1.140` 或舊版號）建議保留作 rollback。

詳見 memory `project_claude_2141_transport_regression.md` + `project_plugin_keepalive_patch.md`。

### 11.3 「server X not in --channels list for this session」

**現象**：debug log 看到這行，channel notifications register 失敗。

**原因**：claude TUI 啟動沒帶 `--channels` flag，或 plugin name / marketplace 拼錯。

**修法**：確認啟動指令包含：

```
--channels plugin:telegram-http@crab-labs-plugins
```

兩個 `:` 一個 `@` 不能少。

### 11.4 daemon `/healthz` 回 200 但 lastUpdate 一直 0

**現象**：daemon 起來了，但 bot 收不到 Telegram 訊息（你發訊息沒反應）。

**檢查**：
1. `cat $STATE_DIR/.env` 看 token 是否正確
2. `tail $STATE_DIR/server.log` 找 `polling as @YourBot` 行 — 沒有 → token 有問題或網路斷
3. `tail $STATE_DIR/server.log | grep error` — 看是否有 Telegram API 錯誤（401 = token 錯，409 = 另一個 instance 在 poll）
4. Mac mini 在 NAT 後面網路斷掉？`curl https://api.telegram.org/bot$TOKEN/getMe`

### 11.5 daemon 啟動立刻 exit code != 0

```bash
tail ~/.claude/channels/telegram/launchd.err.log
```

常見：
- `bot.lock exists`：另一個 daemon 還在跑同 STATE_DIR。`ps | grep bun` 找出來 kill 掉，或檢查 PORT 衝突
- bun 路徑錯：改 plist 裡的 `/Users/.../.bun/bin/bun`
- TOKEN 沒設：補 `.env`

### 11.6 「plugin not on approved channels allowlist」

**修法**：§4 的 managed-settings.json 沒做 / 沒含這個 plugin。補上後 claude TUI 重啟。

### 11.7 claude TUI 卡在 picker dialog（AskUserQuestion / ExitPlanMode）— **必踩雷**

**現象**：你 TG DM bot 沒回，TUI process 還活著，daemon 收到訊息但 broadcast 全部 queue 在「SSE not yet open」。`tmux capture-pane` 看到 claude 在跑一個有 1/2/3 選項的 picker，下方寫「Enter to select · Tab/Arrow keys to navigate · Esc to cancel」。

**原因**：[Anthropic GitHub issue #40644](https://github.com/anthropics/claude-code/issues/40644) — `AskUserQuestion` / `ExitPlanMode` 等需要 keyboard 的 picker 工具，在 `--channels` 模式底下**沒有被自動 disable**（明明 `claude -p` 模式有 disable 邏輯）。claude 跑到要決策的地方就直接 spawn picker → 鎖死 main thread → channel notification 不消化。

**修法**：在 claude 啟動指令加 `--disallowedTools AskUserQuestion ExitPlanMode`：

```
claude --channels plugin:telegram-http@crab-labs-plugins \
       --disallowedTools AskUserQuestion ExitPlanMode \
       --dangerously-skip-permissions
```

claude 看到這些 tool 被 deny 就會 fallback 成 text question（直接在訊息裡用文字問「請選 1/2/3」），text 走正常 channel reply → TG 看得到 → TG 回答 → claude 處理。

**已套用**：本 repo 內 5 個 supervisor agent manifest + channel bot wrapper 全部都加。等 Anthropic 修 #40644 之後可以拿掉。

**如何救已經卡住的 session**：
- 不能 TG 救（plugin 沒有 raw stdin 送鍵盤的能力）
- SSH/Parsec 進 mac mini → `tmux attach -t <session>` → 按 picker
- 或 kill claude TUI process，supervisor respawn 用新 flag

**順便確認其他 tool 也安全**：
- 普通 tool（`Bash`、`Edit`、`Read`、`Write`、`Grep`、`Glob`）— ✅ 不需要 keyboard
- `--dangerously-skip-permissions` 已 cover permission prompt
- `AskUserQuestion`、`ExitPlanMode` — ⚠️ disable
- 之後 anthropic 加新的 keyboard tool 也要評估

---

## 12. 收尾 & References

設定完之後：

- [ ] daemon plist 全部 bootstrap（`launchctl list | grep telegram-daemon`）
- [ ] managed-settings.json 有四個 plugin
- [ ] 每個 daemon 的 access.json 含 ackReaction 跟 approved 名單
- [ ] supervisor manifest 用 2.1.140 顯式路徑
- [ ] end-to-end 測試通（§9 全部 ✓）
- [ ] 寫進團隊 Obsidian 留檔

相關文件：
- 設計文件：[ARCHITECTURE.md](./ARCHITECTURE.md)
- 變更紀錄：[CHANGELOG.md](./CHANGELOG.md)
- Access 管理：[ACCESS.md](./ACCESS.md)
- **🤖 進階：channel-bot TUI 控制台（1.1.0+）：[ADVANCED-SETUP.md](./ADVANCED-SETUP.md)** — 把 Telegram 變成你 claude TUI 的鍵盤（`/clear`、`/resume`、`/restart`、`/model` 等指令直接從手機操控）
- 2026-05-14 事故報告（兩個 bug 修復全紀錄）：[HedgeDoc](https://md.blocktempo.ai/TFkYzCibQheCDaV2fyoaBg)
- Route B HTTP daemon 改造記錄：[HedgeDoc](https://md.blocktempo.ai/B_MVqPMbQsyLLxo7oGnTdg)
- Switchover SOP：[HedgeDoc](https://md.blocktempo.ai/StFH9rUCT2OmGW5T2EM61g)
- 2026-05-22 TUI control plane 範式：[HedgeDoc](https://md.blocktempo.ai/cy8iIB95QPqgrBqI480kKg)

License: Apache-2.0
