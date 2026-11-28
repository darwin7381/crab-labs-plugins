# telegram-bridge — the agents' Telegram bots, carried to and from Onsen (WO-196 part B)

Onsen is the fleet's messaging system. A person's message to an agent, and the agent's answer, go through Onsen; Telegram is one client of it. This program is Onsen's **Telegram bridge** (CONTRACT §7d, `~/rescue-site/onsen-ui/CONTRACT.md`). It holds the bots and only carries:
- what a person does in Telegram, written into Onsen as that person;
- what Onsen has for that person, drawn on the agent's bot as the daemon draws it today.

It never talks to an agent. The agents' daemons become connectors that never touch Telegram (WO-197, Sonn). The two programs meet only in Onsen.

**One per machine** (Mac mini, MBP, txmonster), not one per agent. One process holds every bot: one long poll per bot, one Onsen client, one feed. Measured memory: **~35 MB with 1 bot, ~44 MB with 27** (`measure-memory.ts`, txmonster, Bun 1.4.2). A telegram-http daemon on the Mac mini is ~75 MB each.

## Which bots

- **The list.** `ONSEN_BRIDGE` in the machine settings file `~/.config/crab-labs-plugins/env` (the same line the connectors read). It is a comma list of member names, or `*` for every agent on this machine. Unset, empty or `0` means none. It is read again every 30 s. An agent taken off is handed back: the bridge keeps carrying it (polling, drawing, its record `ok`) until Telegram answers its getUpdates with 409 (the agent's daemon polls the bot again), then lets go (one log line, the record leaves the list); with no 409 it lets go after `TELEGRAM_BRIDGE_HANDOVER_S` (60 s). Put back on the list meanwhile, it is simply kept. **Since telegram-http 1.59.0 (11-27) a non-roamer daemon no longer reads `ONSEN_BRIDGE`: it is a connector only and never polls Telegram itself.** Taking an agent off the list then leaves its bot with nobody polling it (after the 60 s). Rolling an agent back to the daemon polling Telegram itself means reinstalling telegram-http 1.58.33 for it, not editing this list (Chiron, WO-196 07:54Z). All three machines run `ONSEN_BRIDGE=*` since 11-27 07:48Z.
- **The map.** `ONSEN_BRIDGE_STATE_DIRS=member=/abs/dir,…` in the same file is used before discovery. For example, `codex=/Users/btai/cc-workspaces/claude-lab-test-v1/.telegram-state` puts a lab bot on `codex`, which has no daemon of its own. A mapped member is carried only when `ONSEN_BRIDGE` names it (or is `*`). The bridge's own environment, when it sets either variable, wins over the file.
- **Discovery.** An agent is on this machine when its Telegram daemon is installed here: a launchd plist in `~/Library/LaunchAgents` (macOS) or a systemd user unit with its drop-ins in `~/.config/systemd/user` (Linux) that sets `TELEGRAM_STATE_DIR`, and not `CHANNEL_INBOX_ONLY=1`. The member is the name the daemon itself reports to Onsen (`onsen-client.ts agentName`: `LANES_AGENT`, else `AGENT_INBOX_SELF`, else the workspace's `claude-<name>`). If two units give one member, neither is carried. A manifest whose daemon moved to another machine has no unit here.
- **Onsen's members.** A member Onsen doesn't list (`GET /v1/members`, every 5 min) isn't carried.
- **The token.** `TELEGRAM_BOT_TOKEN` in `<state dir>/.env`, read in place and kept in memory only. It is never copied, written or logged; every error text is scrubbed of `bot<id>:<secret>`. A changed `.env` is picked up at the next 30 s read.
- **`access.json`** is read from the same directory, as the daemon reads it.

## Endpoints (what Onsen's extensions page shows)

The bridge registers as the extension `telegram-bridge-<machine>`, kind `bridge`, `client: "telegram"`. Every 30 s, and whenever the list changes, it sends the collection `endpoints` (ttl 120 s) with one record per listed agent:

| field | value |
|---|---|
| `id` | the member |
| `member` | the member for `ok` and `conflict` (a `conflict` record claims nothing, Onsen 0.35.0); `null` for `error`, so Onsen routes nothing to a bot this bridge doesn't poll |
| `state` | `ok` (Onsen took it from this bridge; polled) · `conflict` (another bridge carries it) · `error` (no token, Telegram refuses the token, getMe failed, Onsen doesn't know the member) |
| `title` | `{display name}（@bot）` |
| `line` | `@bot｜member｜收發中 / 另一支橋接帶著 / 有問題｜why` (e.g. `由 telegram-bridge-mbp 帶`, `Telegram 409：另一支程式在收這個 bot`, `2 則等 Onsen 收`) |
| `attributes` | `bot_id, username, state_dir, found_by, last_update_at, error, telegram_conflict, held_by, writes_waiting, onsen_failing_since` |

**A bot is polled only after Onsen's list took its member from this bridge.**
- On 409 `endpoint_taken` (`error.taken: [{member, bridge}]`), that member is marked `conflict` and its bot is not polled. It is asked for again every 5 min.
- If the 409 doesn't say which member, the bridge asks one member at a time to find it.
- At start, if Onsen doesn't answer, the members Onsen took last time (`state.json`) are polled meanwhile, so the Onsen-down sentence still reaches people.

## In: Telegram → Onsen (`inbound.ts`)

- **Polling.** `getUpdates` with `allowed_updates` `message, edited_message, callback_query, message_reaction, my_chat_member`.
- **Confirming.** An update is confirmed to Telegram (the next offset passes it) only once it is done. The first update not done holds the offset, so a restart gets it again.
- **Gate.** That agent's `access.json`, ported from `server.ts`: DM allowlist, pairing codes (written into `access.json` as before; `approved/<id>` → "Paired! Say hi to Claude."), group allowlists and allowed senders. The bridge forwards mentions of its bots as member names. Onsen selects recipients. A corrupt `access.json` refuses everything for that bot; it is not moved aside.
- **A message.**
  1. Its file is fetched from Telegram (≤ 20 MB) and stored with `POST /v1/files`.
  2. A voice note carries the audio and its caption. Without a caption, `text` is the empty string. Onsen transcribes the audio on arrival.
  3. `POST /v1/bridge/messages`.
  4. `client_meta` carries the facts §7d's named fields don't, under the exact attribute names `server.ts` puts on the `<channel>` tag (the connector turns each key into that attribute): `reply_to_user_id`, `attachment_origin` (`reply`: the file is the replied-to message's, which comes with a text reply as the daemon's `replyAttachment` did), `forward_origin`, `forward_from_id`, `forward_from_username`, `forward_channel_message_id`, `image_error` (`download failed`: a photo not stored), `media_group_count` (album items wait 1.5 s after the newest one, as the daemon's album window did). It is sent only when non-empty. Onsen's limit is 4 KB. If Onsen answers 400 naming `client_meta` (before 0.35.4), the message goes again without it, and none is sent for 5 min.
  5. Only when Onsen answers 2xx: 👀 (`access.json ackReaction`; unset gives 👀, `''` gives none), and the update is done.
- **Order.** Writes go strictly in order, one at a time per bot.
- **Edits and reactions.** An edit goes to `POST /v1/bridge/messages/edit`; the person's reaction to `POST /v1/bridge/reactions`. Onsen answering 404 (a message it never had) drops it.
- **Onsen down** (no answer, 5xx, 429, 401, 404 `no_endpoint`):
  - The write is tried again after 2 s, 4 s, then every 5 s, and every later write of that bot waits behind it.
  - A message not written 15 s after it came gets one reply: 「Onsen 現在連不上，這一則還沒交給 \<agent\>；連上會自動補交，不用重傳。」 That happens once per message, remembered across restarts.
  - When Onsen is back, each bot resumes writing in order and acknowledges success with 👀. DMs use `tg:<member>:<chat>:<message_id>`. Supergroups use `tg:<chat>:<message_id>`. Basic groups use `tg:<chat>:<from.id>:<date>:<first 16 hex digits of SHA-256(text or caption)>`.
- **Refused for good.**
  - 403 `not_allowed` (the account is an agent or a system member), or `unknown_identity` (before Onsen 0.35.1; a stranger in a group becomes a guest). The update is done, nothing is answered, and one log line is written.
  - 400. The update isn't tried again; in a DM, one reply says it wasn't handed over.
- **Commands.** `/start` and `/help` in a DM are answered by the bridge (the daemon's text). Every other `/command` is written as a message with `kind: "command"`.
- **Buttons.**
  - An Action's option (`oa:<key>`) calls `POST /v1/bridge/actions/<id>/resolve`, and the toast says the result.
  - 「不要顯示這則」 under the pinned status stops it in that chat.
  - Only people `access.json` admits may press.

## Out: Onsen → Telegram (`outbound.ts`)

One long poll of `GET /v1/bridge/feed?after=<cursor>&wait=50&limit=100`. The cursor and the seqs of a half-drawn batch are kept in `state.json`, so a restart goes on from there. Each group has one drawing queue shared by its bots. Each DM has a queue per bot. Different chats can draw in parallel.

- **message**
  - **Text.** The text is split into parts (`access.json` `textChunkLimit` ≤ 4096). Each part is sent as a Rich Message, falling back to plain `sendMessage` when that fails. `author_label` is the first line.
  - **Files.** Each file follows as its own message (`sendPhoto` for a picture, else `sendDocument`). It is taken from Onsen with the bridge's credential, from Onsen's own address only.
  - **Reply and topic.** `reply_to_client_msg_id` goes on the first part (`replyToMode`); `client_thread` becomes the topic.
  - **Silent** when Onsen says so, when the item is older than 15 min, and for an echo. An echo is the person's own message from another client (`origin_client` not `telegram`), drawn as 「〔你在 Onsen 傳的〕」 plus the text.
  - **Delivery report.** Then `POST /api/onsen/v1/messages/<id>/delivery`.
  - **Retries.** A failed send is tried again 10 s, 30 s and 2 min later (a 429 waits its `retry_after`), sending only the parts not yet out; then the report is `failed`. A part Telegram didn't answer in time isn't sent again, since it may have arrived; it is `failed` at once, with an `error` starting `timeout` (Onsen records `bridge_unknown`). A report Onsen doesn't take is sent again every 10 s.
- **message_edit.** The parts are edited in place; extra old parts are deleted, and extra new parts are sent silently.
- **reaction.** The member's reaction goes on the person's message (one emoji, the bot limit). ✍ never lands on top of it.
- **receipt.**
  - `delivered` shows typing.
  - `in_session` sets ✍ (`onsen-visible.ts SeenReactor`) and shows typing.
  - Older than 15 min: dropped. Typing shows only within 10 s.
- **action** (one per assignee, in their DM). The summary and body (a `source: "menu"` Action is its body alone), with a button per option (or a link button for a form), as one message. An open Action whose `expires_at` is under 60 s away shows the seconds left on each button 「…（5）」, edited once a second; the buttons go at 0. A cancelled or expired Action with a `note` shows 「→ <note>」. Then `POST /v1/bridge/actions/<id>/delivery` reports the messages it became.
- **action_resolved** (`outcome` is the Action's state). The buttons give way to `→ <option_label>（<who>）`, or `→ 已取消` / `→ 已過期`. The messages come from `client_msg_ids`, else from `state.json`.
- **commands** (stage two). The bot's command menu: the bridge's `/start` and `/help` plus the connector's commands, in the fleet order (`/clear` first, `/model` second; `bot-menu.ts`). It is set with `setMyCommands` for the default scope and `all_private_chats`. An item has no chat.
- **thread** (stage two).
  - A thread opened with no topic yet: `createForumTopic` (the name without emoji, `lanes-topics.ts plainTopicName`), then `PUT /v1/bridge/threads`.
  - Renamed: `editForumTopic` with the new name.
  - Closed: the ✅ icon. A private chat has no `closeForumTopic`, and a topic is never deleted (that removes its messages).
  - Opened again: the icon is cleared.
  - A message with `client_thread` goes into that topic. A message typed in a topic carries `client_thread` and `topic_name`.
  - **No topic possible** (no topics mode; `createForumTopic` refused): the thread stays in Onsen. A message of it (`item.thread`) is drawn in the main chat under 「〔串：<name>〕」 and reported `sent`; nobody is told of an error. That chat isn't asked for a topic again for an hour (or until a restart).
- **restart_line** (stage two). A drawn line becomes a silent message 「已畫線：這之前的對話它看不到了（你引用的那一則照樣看得到）。」 with 「讓它看得到之前的」.
  - Pressing it calls `POST /v1/bridge/restart-lines/<id>/lift`.
  - `lifted: true`, from anywhere, turns the message into 「已拿掉線：它查得到之前的對話了。」.
  - With a `lift_until`, the button counts down once a second and then goes (the 1.58.19 `/clear` countdown). Onsen 0.35.0 always sends null, so the button stays.
- **observation.** The pinned status of that DM (`onsen-visible.ts StatusPin`, `PendingTracker`, `statusLine`). Onsen's status is mapped to the daemon's words, so it reads as today.
  - The first time, the daemon's own `<state dir>/onsen/status-pin.json` and its `status-pin-off-*` markers are copied into the bridge's state. The message already pinned is the one edited, and a chat Joey turned off stays off.
  - Only the newest observation of a batch is drawn; one older than 15 min is dropped.
  - **Onsen decides offline.** The pin draws `presence` / `presence_reason` as given. A kept observation past its `valid_until` (observations come only when they change) is not read as offline.
  - Each pin check (at most once a minute, before an edit) logs what Telegram's `getChat` says is pinned. If it is not the status message, the chat is turned off and the message is no longer edited.

## Onsen calls (exact)

| call | body |
|---|---|
| `PUT /api/onsen/v1/extensions/<name>` | `{kind:"bridge", client:"telegram", title, version, machine, collections:[{name:"endpoints", title, ttl_seconds:120}]}` |
| `PUT /api/onsen/v1/extensions/<name>/collections/endpoints` | `{reported_at, records:[{id, title, line, member, state, attributes}]}` |
| `GET /api/onsen/v1/members?limit=100[&cursor=]` | — |
| `POST /api/onsen/v1/files` | the bytes; `Content-Type`, `X-File-Name`, `Idempotency-Key: <idem_key>` |
| `POST /api/onsen/v1/bridge/messages` | §7d and §4c `{member, mentions, client_user_id, client_user:{username, display_name}, chat, client_msg_id, sent_at, text, kind, attachment_file_ids, attachments:[{kind, name, mime, bytes, client_ref}], reply_to_client_msg_id, reply_quote, reply_to_text, reply_to_user, client_thread, topic_name, forward_from, forward_date, media_group_id, idem_key}`; `Idempotency-Key: <idem_key>` |
| `PUT /api/onsen/v1/bridge/chats/<chat>/members/<member>` | `{state:"in"/"left", at}` |
| `PUT /api/onsen/v1/bridge/chats/<old chat>` | `{moved_to:"<new chat>"}` |
| `POST /api/onsen/v1/bridge/messages/edit` | `{member, chat, client_msg_id, text, edited_at}` |
| `POST /api/onsen/v1/bridge/reactions` | `{member, chat, client_msg_id, client_user_id, emojis, at}` |
| `POST /api/onsen/v1/bridge/actions/<id>/resolve` | `{client_user_id, option, at}` |
| `GET /api/onsen/v1/bridge/feed?after=&wait=50&limit=100` | answer `{items, next}` (no envelope; `next` kept as an opaque string) |
| `POST /api/onsen/v1/messages/<id>/delivery` | `{client:"telegram", state:"sent"/"failed", client_msg_ids, at, error}` (`error` null when sent; `timeout…` when Telegram didn't answer) |
| `POST /api/onsen/v1/bridge/actions/<id>/delivery` | `{client_user_id, client_msg_ids}` (after an Action's buttons are drawn; Onsen 0.35.1) |
| `PUT /api/onsen/v1/bridge/threads` | `{member, chat, thread, client_thread}`. In groups, `(chat, client_thread)` identifies the topic across bots. |
| `POST /api/onsen/v1/bridge/restart-lines/<id>/lift` | `{client_user_id}` (stage two) |

## Readings of §7d

The places where the bridge had to pick a reading, as checked against Onsen 0.35.0 (`fleet-core` `app/onsen_bridge.py`):
- **Files.** A Telegram message carries at most one file. If it can't be stored (over 20 MB, Telegram refused), `attachments` still describes it and `attachment_file_ids` is empty: the ids are a prefix of `attachments`.
- **The restart line.** Onsen has only "lift", and `lift_until` is null. So a line is drawn with 「讓它看得到之前的」 and the button lifts it. WO-185's default for `/clear` (no line; 「不要讓它看到之前的」 draws one) is the connector's to keep: it draws a line only when asked.
- **`author_label`.** Drawn verbatim as the first line. Onsen 0.35.0 sends the sender part (a lane id, `system:…`), so the label is what Onsen gives.
- **Echo label.** In a DM 「〔你在 Onsen 傳的〕」; in a group 「〔<display name> 在 Onsen 傳的〕」.
- **Stale.** "Old" is 15 min for messages (drawn silent), receipts and observations (dropped). Typing shows only within 10 s.

## Install (per machine)

**1. Credential.** Mint a **system** identity on BTCC named after the extension:

```sh
.venv/bin/python -m app.mesh_admin mint telegram-bridge-macmini --kind system    # -mbp, -txmonster
```

Put the token in `~/.config/mesh/telegram-bridge-<machine>.credential` (mode 600).

**2. Its own checkout.** It runs from `~/.claude/telegram-bridge`, pinned to a commit, not the live plugin checkout:

```sh
git clone https://github.com/darwin7381/crab-labs-plugins.git ~/.claude/telegram-bridge
git -C ~/.claude/telegram-bridge checkout --detach <commit>
```

**3. Choose the bots** in `~/.config/crab-labs-plugins/env`:

```sh
ONSEN_BRIDGE=codex
ONSEN_BRIDGE_STATE_DIRS=codex=/Users/btai/cc-workspaces/claude-lab-test-v1/.telegram-state
```

An agent's own daemon must not poll the same bot: Telegram allows one poller per token. That is the connector switch (WO-197).

**Check it**, from `~/.claude/telegram-bridge/plugins/telegram-http/telegram-bridge`:

```sh
TELEGRAM_BRIDGE_MACHINE=macmini bun telegram-bridge.ts --whoami   # "telegram-bridge-macmini (system)", exit 0
TELEGRAM_BRIDGE_MACHINE=macmini bun telegram-bridge.ts --once     # which agents it would carry; whether each token is there (never the token)
```

**4. Load it.**
- launchd: `sed -e "s#__HOME__#$HOME#g" -e "s#__MACHINE__#macmini#g" com.btai.telegram-bridge.plist.example > ~/Library/LaunchAgents/com.btai.telegram-bridge.plist`, then `launchctl bootstrap gui/$(id -u) …`. The log is `~/Library/Logs/telegram-bridge.log`.
- systemd: `install -m 644 telegram-bridge.service ~/.config/systemd/user/` and `systemctl --user enable --now telegram-bridge`.

**Stop.** `launchctl bootout gui/$(id -u)/com.btai.telegram-bridge` or `systemctl --user disable --now telegram-bridge`. On stop it confirms to Telegram what it finished. Onsen marks its list stale after 120 s. Taking an agent off `ONSEN_BRIDGE` releases that one bot within 30 s. (With 1.59.0 daemons that bot then has no poller; see the list above.)

## Environment

| Variable | Default | |
|---|---|---|
| `TELEGRAM_BRIDGE_MACHINE` | (required) | `macmini`, `mbp`, `txmonster` |
| `TELEGRAM_BRIDGE_NAME` | `telegram-bridge-<machine>` | the extension and identity name |
| `TELEGRAM_BRIDGE_CREDENTIAL_FILE` | `~/.config/mesh/<name>.credential` | read again when it changes |
| `TELEGRAM_BRIDGE_STATE_DIR` | `~/.local/state/telegram-bridge` | `state.json`, `pins/<member>/` |
| `ONSEN_BASE` | `https://core.kbro.ai/api/onsen` | |
| `ONSEN_BRIDGE`, `ONSEN_BRIDGE_STATE_DIRS` | settings file | see above |
| `CRAB_LABS_PLUGINS_ENV` | `~/.config/crab-labs-plugins/env` | the settings file |
| `TELEGRAM_API_ROOT` | `https://api.telegram.org` | tests point it at a fake |
| `TELEGRAM_RICH_MESSAGES` | on | `0` sends plain text |
| `TELEGRAM_BRIDGE_SORRY_S` | `15` | the Onsen-down sentence |
| `TELEGRAM_BRIDGE_RETRY_S` | `10,30,120` | send retries |
| `TELEGRAM_BRIDGE_SETTINGS_S` / `_ENDPOINTS_S` / `_REGISTER_S` / `_MEMBERS_S` / `_CONFLICT_RETRY_S` | 30 / 30 / 300 / 300 / 300 | |
| `TELEGRAM_BRIDGE_POLL_TIMEOUT_S` / `_FEED_WAIT_S` | 50 / 50 | |
| `TELEGRAM_BRIDGE_PIN_CHECK_S` / `TELEGRAM_BRIDGE_PIN_EDIT_MS` | 60 / 5000 | the pinned status's pin check and edit spacing (StatusPin's defaults; tests shorten them) |
| `TELEGRAM_SEND_TIMEOUT_S` / `TELEGRAM_UPLOAD_TIMEOUT_S` | 45 / 300 | |

## Tests

Run these on txmonster only, with `TMUX` unset. From `plugins/telegram-http/telegram-bridge`:

```sh
bun test *.test.ts                    # fake Bot API and Onsen (§7b / §7d)
bun measure-memory.ts                # RSS with 1 and with 27 fake bots
```

No test reaches the real Telegram or Onsen; every token is fake.

## Ported, not imported

`server.ts` cannot be imported (it builds a bot and exits without a port when it loads), and WO-197 takes its Telegram code out. So these are ported here with their `server.ts` line numbers in the comments:
- `tg-access.ts`: `gate`, `dmCommandGate`, `isMentioned`, pairing, approvals;
- `tg-format.ts`: `chunk`, the label line, `sendTextParts`, the rich edit;
- `inbound.ts`: the `/start` and `/help` text.
- `stage-two.ts`: the `/clear` countdown (`clearHooks`).

These are imported unchanged:
- `onsen-client.ts`: `inboundShape`, `forwardFrom`, `agentName`;
- `onsen-files.ts`: `telegramFile`, `mimeOf`;
- `onsen-visible.ts`: `SeenReactor`, `StatusPin`, `PendingTracker`, `SinceTracker`, `statusLine`, `pendingLine`;
- `bot-menu.ts`: `orderBotMenu`;
- `lanes-topics.ts`: `plainTopicName`;
- `rich-inbound.ts`, `entities.ts`.

No file outside this folder is changed.

## Debugging

`TELEGRAM_BRIDGE_DEBUG=1` in the unit's environment logs one line per Telegram update the bridge takes (its kinds, chat, sender, text length; never the text) and each one the allowlist drops. Off by default.
