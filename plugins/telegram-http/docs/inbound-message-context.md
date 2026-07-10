# Inbound message context — reply / forward / album attributes (1.13.0+, hardened 1.14.0)

Every Telegram message the daemon delivers to claude arrives as a
`notifications/claude/channel` notification, rendered in the session as:

```
<channel source="telegram" chat_id="..." message_id="..." user="..." user_id="..." ts="...">
message text (or caption, or a type label like "(location: 35.68, 139.76)")
</channel>
```

Since **1.13.0** the tag also carries the context Telegram knows but the agent
previously never saw: what a reply points at, who originally wrote a forward,
and which messages belong to one album.

## Attribute reference

### Always present

| Attribute | Meaning |
|---|---|
| `chat_id` | chat to pass back to the `reply` tool |
| `message_id` | Bot-API id of THIS message (usable as `reply_to` in `reply`) |
| `user` / `user_id` | sender (the person whose account delivered the message — for forwards this is the FORWARDER, see `forward_*`) |
| `ts` | send time, ISO 8601 |

### Attachments (any media message)

| Attribute | Meaning |
|---|---|
| `image_path` | photo already downloaded — just `Read` this path |
| `image_error="download failed"` (1.14.0) | the photo could NOT be downloaded. The tag also carries `attachment_kind="photo"` + `attachment_file_id` (+ `attachment_size`) so you can retry via `download_attachment`. **Tell the sender explicitly the image didn't come through — never answer as if you saw it.** |
| `attachment_kind` | `photo` (only on download failure) / `document` / `video` / `audio` / `voice` / `video_note` / `sticker` / `animation` |
| `attachment_file_id` | pass to the `download_attachment` tool, then `Read` the returned path (bot downloads cap at 20MB) |
| `attachment_size` / `attachment_mime` / `attachment_name` | as reported by Telegram (name is sanitized) |
| `voice_transcript` (1.14.0, opt-in) | local speech-to-text of a `voice`/`audio` attachment, ≤500 chars (truncation marked with a trailing `…`). Present only when the daemon runs with `CHANNEL_BOT_VOICE_TRANSCRIBE=1`. Treat it as what the sender said; download the audio only if you need the original. Transcription failure never blocks delivery — the message just arrives without the attribute. |

### Reply context (message is a Telegram reply)

| Attribute | Meaning |
|---|---|
| `reply_to_message_id` | id of the ROOT message being replied to |
| `reply_to_user` / `reply_to_user_id` | who wrote the root message (may be the bot itself — that means the user is replying to one of YOUR messages) |
| `reply_to_text` | root message's text/caption, ≤200 chars; media-only roots show a label like `(photo)` or `(document: report.pdf)` |
| `reply_quote` | the specific passage the user quoted (Telegram partial-quote), ≤200 chars |
| `attachment_origin="reply"` | the `attachment_*` / `image_path` on this tag came from the ROOT message, not the reply itself (user replied to a file and the file rides along) |

### Forward context (message was forwarded)

| Attribute | Meaning |
|---|---|
| `forward_origin` | `user` \| `hidden_user` \| `chat` \| `channel` |
| `forward_from` | original author: person's name/username, or chat/channel title (`hidden_user` ⇒ display name only, per Telegram privacy) |
| `forward_from_id` / `forward_from_username` | original author's id / @username when Telegram exposes them |
| `forward_date` | when the ORIGINAL message was sent (ISO) — not the forward time |
| `forward_channel_message_id` | for channel forwards: the original post's id in that channel |

### Album context

Since **1.14.0** a PHOTO album is aggregated daemon-side (items buffered
~1.5s after the last one) and delivered as **ONE** `<channel>` message:

| Attribute | Meaning |
|---|---|
| `media_group_id` | Telegram's album correlation id |
| `media_group_count` | how many photos were aggregated into this message |
| `image_path`, `image_path_2`, … `image_path_N` | the downloaded photos, in album order — `Read` them all |
| `image_error[_k]` + `attachment_file_id[_k]` | item k failed to download; its file_id is preserved for `download_attachment` retry |

Body = the album's caption(s) joined, or `(album: N photos)` when uncaptioned.
Base attributes (`message_id`, `ts`, reply/forward context) come from the
FIRST item. Single photos (no `media_group_id`) are unaffected. Non-photo
album items (e.g. video/document albums) still arrive as separate messages
each carrying `media_group_id`, as in 1.13.0.

## How the agent should read these

- **Reply to your own message**: `reply_to_user` equals the bot's username —
  the user is responding to something you said; `reply_to_text` tells you which
  message, so don't ask "reply to what?".
- **Forwarded content**: attribute the CONTENT to `forward_from`, not to
  `user`. `user` merely relayed it. A `forward_origin="channel"` with
  `forward_from="Telegram News"` means the text is a channel post, not the
  sender's words.
- **Album**: collect messages with the same `media_group_id` before answering
  "what are these photos?" — more items of the album may arrive within a
  second of each other.
- **Reply-with-file root**: `attachment_origin="reply"` + `reply_to_text="(document: invoice.pdf)"`
  means "the user replied to invoice.pdf and is talking about THAT file" —
  download via `attachment_file_id` as usual.

## Message types with no file payload (rendered as text)

| Type | Content rendering |
|---|---|
| location (incl. venue) | `(location: <lat>, <lon> — <venue title>, <address>)` |
| contact | `(contact: <name>, <phone>)` |

Both previously had no handler at all (silently dropped). `animation` (GIF /
silent MPEG4) is a proper attachment (`attachment_kind="animation"`).

## Integrity notes

- All sender-controlled values (names, excerpts, quotes) are sanitized so
  they cannot break out of the `<channel>` tag. Since 1.14.0 the delimiter
  chars `<>[];` are replaced with readable FULL-WIDTH lookalikes（＜＞［］；）
  instead of `_`, so `re[port]<v2>.txt` stays legible as
  `re［port］＜v2＞.txt`; `\r\n` become spaces. Quote/paren characters pass
  through untouched.
- Excerpts (`reply_to_text`, `reply_quote`, media-kind labels) are capped at
  200 chars; `voice_transcript` at 500. Since 1.14.0 a value that was
  actually cut ends with `…` so truncation is visible.
- Attributes appear only when applicable — absence of `forward_origin` means
  the message is not a forward.
- Not independently verified in lab: `forward_origin="hidden_user"` and
  `forward_origin="chat"` (anonymous group admin) sub-shapes — same code path
  as the verified `user`/`channel` shapes.
