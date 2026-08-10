// Inbound-entity expansion (1.19.0, 2026-08-10 — Joey hit it live, relayed via Lily).
// Telegram carries formatting as (text, entities[]) pairs; forwarding the visible
// text alone loses any entity payload that isn't printed. The painful case:
// TG-desktop pastes render links as display-text + hidden URL (text_link) — the
// bridge forwarded only the display text, so the agent lost every URL in an
// 11-link document list and the boss had to re-paste. Expand hidden-payload
// entities inline as [label](target) so channel text is self-contained.
//
// Only entity types whose payload is INVISIBLE in the visible text are expanded:
//   text_link    → [label](url)
//   text_mention → [label](tg://user?id=N)   (mention of a user with no @username)
// url / mention / hashtag / bold / … are left alone — their text already says
// everything; expanding them would only duplicate content.
//
// Entity offset/length are UTF-16 code units (Bot API spec) — the same unit JS
// string indexing uses, so direct slicing is emoji/astral-safe, no conversion.

export type InboundEntity = {
  type: string
  offset: number
  length: number
  url?: string
  user?: { id: number }
}

export function expandHiddenEntities(text: string, entities?: readonly InboundEntity[]): string {
  if (!text || !entities?.length) return text
  const hidden = entities
    .filter(e => (e.type === 'text_link' && e.url) || (e.type === 'text_mention' && e.user))
    .sort((a, b) => a.offset - b.offset)
  if (hidden.length === 0) return text
  let out = ''
  let pos = 0
  for (const e of hidden) {
    if (e.offset < pos) continue // overlapping entities — first one wins
    if (e.offset + e.length > text.length) continue // malformed offsets — skip rather than slice garbage
    const label = text.slice(e.offset, e.offset + e.length)
    const target = e.type === 'text_link' ? e.url! : `tg://user?id=${e.user!.id}`
    out += text.slice(pos, e.offset)
    // Some clients emit text_link whose label IS the url — [x](x) adds nothing.
    out += label === target ? label : `[${label}](${target})`
    pos = e.offset + e.length
  }
  return out + text.slice(pos)
}
