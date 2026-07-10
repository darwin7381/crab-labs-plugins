# Inbound message context — reply / forward attributes (1.13.0+)

Every Discord message the daemon delivers to claude arrives as a
`notifications/claude/channel` notification, rendered in the session as:

```
<channel source="discord" chat_id="..." message_id="..." user="..." user_id="..." ts="...">
message text (or a type label like "(sticker: pepe_think)" / "(poll: lunch?)")
</channel>
```

Since **1.13.0** the tag also carries the context Discord knows but the agent
previously never saw: what a reply points at, that a message is a forward (and
its origin when resolvable), and sticker/poll payloads that used to arrive as
an EMPTY body.

This is the Discord adaptation of
[telegram-http docs/inbound-message-context.md](../../telegram-http/docs/inbound-message-context.md)
— same idea, mapped to Discord semantics (see "TG → DC mapping" at the end).

## Attribute reference

### Always present

| Attribute | Meaning |
|---|---|
| `chat_id` | channel to pass back to the `reply` tool |
| `message_id` | id of THIS message (usable as `reply_to` in `reply`, or in `download_attachment`) |
| `user` / `user_id` | sender (for forwards this is the FORWARDER, see `forward_*`) |
| `ts` | send time, ISO 8601 |

### Attachments (any media message)

| Attribute | Meaning |
|---|---|
| `attachment_count` | number of files on this message |
| `attachments` | `name (mime, KB)` list — call `download_attachment(chat_id, message_id)` to fetch, then `Read` the returned paths |

### Reply context (message is a Discord reply)

| Attribute | Meaning |
|---|---|
| `reply_to_message_id` | id of the ROOT message being replied to |
| `reply_to_user` / `reply_to_user_id` | who wrote the root message (may be the bot itself — that means the user is replying to one of YOUR messages) |
| `reply_to_text` | root message's text, ≤200 chars; media-only roots show a label like `(2 attachments: report.pdf, +1 more)` or `(sticker: …)` |
| `reply_to_attachment_count` / `reply_to_attachments` | files on the ROOT message — fetch with `download_attachment(chat_id, reply_to_message_id)` |

If the root message was deleted (or unreadable), only `reply_to_message_id`
appears — the id alone still marks the message as a reply.

### Forward context (message is a Discord forward)

Discord puts forwarded content in a *message snapshot*, not in `content` —
before 1.13.0 a forward arrived as an **empty** message. Now the snapshot text
becomes the message body and these attributes appear:

| Attribute | Meaning |
|---|---|
| `forward_origin` | `user` \| `bot` \| `webhook` \| `unknown`. Discord's forward payload deliberately omits the original author; the daemon best-effort resolves it by fetching the source message, which only works when the bot can read the source channel — otherwise `unknown` |
| `forward_from` / `forward_from_id` | original author when resolvable |
| `forward_channel` / `forward_channel_id` / `forward_guild_id` | where the original message lives (name only when resolvable) |
| `forward_message_id` | the original message's id in its channel |
| `forward_date` | when the ORIGINAL message was sent (ISO) — not the forward time |
| `forward_attachment_count` / `forward_attachments` | files inside the forward — `download_attachment(chat_id, message_id)` on the forward message itself retrieves them (the tool falls through to snapshot attachments) |

### Sticker / poll messages (previously an empty body)

| Type | Content rendering | Meta |
|---|---|---|
| sticker | `(sticker: <names>)` | `sticker_count`, `stickers` |
| poll | `(poll: <question>)` | `poll` (question excerpt) |

The meta copy is the trusted one — an in-content label alone is forgeable by
any sender typing that string.

## How the agent should read these

- **Reply to your own message**: `reply_to_user` equals the bot's username —
  the user is responding to something you said; `reply_to_text` tells you which
  message, so don't ask "reply to what?".
- **Forwarded content**: attribute the CONTENT to `forward_from` (or "an
  unresolvable original author" when `forward_origin="unknown"`), not to
  `user`. `user` merely relayed it.
- **Reply-with-file root**: `reply_to_attachments` + `reply_to_message_id`
  means "the user replied to that file and is talking about THAT file" —
  `download_attachment(chat_id, reply_to_message_id)` fetches it.

## TG → DC mapping notes (why some TG attributes don't exist here)

| telegram-http attribute | discord-http equivalent |
|---|---|
| `reply_quote` (partial quote) | none — Discord has no partial-quote feature |
| `attachment_origin="reply"` (root file smuggled onto the reply) | not needed — Discord's `download_attachment` is pull-by-message-id, so the agent fetches root files via `reply_to_message_id` instead of receiving a smuggled copy |
| `media_group_id` (album correlation) | not needed — Discord multi-attachment is natively ONE message (one notification, `attachment_count` > 1) |
| `forward_origin=user\|hidden_user\|chat\|channel` | `user\|bot\|webhook\|unknown` — Discord snapshots omit the author entirely, so origin is a best-effort fetch, and hidden-vs-visible is replaced by resolvable-vs-`unknown` |
| `image_path` (photos pre-downloaded) | none (pre-existing DC design) — all files are pull-based via `download_attachment` |

## Integrity notes

- All sender-controlled values that land in meta attributes (names, excerpts)
  are sanitized (`<>[]\r\n;` stripped) so they cannot break out of the
  `<channel>` tag, and excerpts are capped at 200 chars.
- Attributes appear only when applicable — absence of `forward_origin` means
  the message is not a forward.
- **Verification status (2026-07-10)**: logic ported from telegram-http 1.13.0
  (lab-verified there) and adapted to Discord's reply/forward/snapshot API;
  verified by strict typecheck + daemon smoke-boot. NOT yet exercised against
  a live Discord bot — no DC lab bot exists on this machine. Treat the
  forward-resolution sub-shapes (`webhook`, cross-guild `unknown`) as
  untested until a lab pass happens.
