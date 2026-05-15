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
| **claude code 2.1.140** | ⚠️ **不能用 2.1.141**（HTTP MCP transport regression，連線斷掉不 reconnect）。詳見 §11 |
| [Bun](https://bun.sh/) | `curl -fsSL https://bun.sh/install \| bash` |
| Telegram bot token | DM [@BotFather](https://t.me/BotFather) → `/newbot` |
| Discord bot token（若要 discord） | [Discord Developer Portal](https://discord.com/developers/applications) → Bot → Reset Token |
| launchd（macOS）/ systemd（Linux） | 系統內建 |
| tmux | `brew install tmux` |
| Joey 的 Telegram user ID | DM [@userinfobot](https://t.me/userinfobot) 取得 |

驗證 claude 路徑：

```bash
ls /Users/$(whoami)/.local/share/claude/versions/
# 應該看到至少 2.1.140
```

如果只有 2.1.141 沒有 2.1.140，先：

```bash
claude install 2.1.140   # 把 2.1.140 binary 拉下來
```

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

### 11.2 claude TUI 看似在 listen 但 `lsof -i :PORT` 顯示 0 ESTABLISHED

**現象**：claude pane 顯示 "Listening for channel messages from: ..."，但 daemon 都收到訊息了 claude 都不渲染。`lsof` 顯示 claude 跟 daemon 的 TCP 連線數 = 0。

**原因**：claude 2.1.141 MCP HTTP transport regression — SDK 連線斷掉 retry 3 次後 give up，process 還在 network 死了。

**修法**：把所有 supervisor manifest + 啟動指令 pin 到 2.1.140：

```json
"claude_command": "/Users/btai/.local/share/claude/versions/2.1.140 --channels plugin:telegram-http@crab-labs-plugins --dangerously-skip-permissions"
```

Kill 所有 stale 2.1.141 claude TUI，supervisor 自動 respawn。

詳見 memory `project_claude_2141_transport_regression.md`。

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
- 2026-05-14 事故報告（兩個 bug 修復全紀錄）：[HedgeDoc](https://md.blocktempo.ai/TFkYzCibQheCDaV2fyoaBg)
- Route B HTTP daemon 改造記錄：[HedgeDoc](https://md.blocktempo.ai/B_MVqPMbQsyLLxo7oGnTdg)
- Switchover SOP：[HedgeDoc](https://md.blocktempo.ai/StFH9rUCT2OmGW5T2EM61g)

License: Apache-2.0
