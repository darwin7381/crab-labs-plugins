// Metadata carried by the bridge and used to build the channel notification.
export type Facts = {
  item?: import('./onsen-items.ts').ItemRef
  chat_id: string
  msgId?: number
  /** the content as the agent reads it (entities expanded; a file's placeholder such as (photo) when it has no caption) */
  text: string
  from: { id: number; username?: string }
  /** Telegram's date, seconds */
  date: number
  /** a photo to take (its own, or the replied-to message's): taken when the tag is built */
  image?: { file_id: string; file_unique_id: string; size?: number }
  attachment?: { kind: string; file_id: string; size?: number; mime?: string; name?: string }
  fromReply: boolean
  voiceTranscript?: string
  inTopic?: number
  /** the reply / forward / album attributes (server.ts replyForwardMeta), as the arrival computed them */
  rfm: Record<string, string>
  mgid?: string
  /** the caption an album item contributes (its own caption, entities expanded) */
  caption?: string
  /** not from Telegram's own message: built from a person_message payload (its picture may be in Onsen only) */
  onsenId?: string
  onsenFiles?: Array<{ kind?: string | null; name?: string | null; mime?: string | null; bytes?: number | null; url?: string | null }>
  /** WO-197 (Chiron 15:27Z; 16:1xZ mesh-12795, rule A): the person_message's client.meta (what the bridge sent as client_meta; Onsen does not read
   *  it): each key an attribute of the tag of the same name, as is; it overrides what the tag derived from the person_message (reply_to_*, forward_*,
   *  attachment_*, voice_transcript, …), except the attributes of CLIENT_META_FIXED; a key the tag does not have comes last */
  clientMeta?: Record<string, string>
  /** WO-197 segment 2: a connector's message in a topic: inTopic is Onsen's thread (the router's, the lanes'); the tag's topic stays the one the
   *  person's message carried (client.thread) and its name (person_message.topic_name) */
  clientTopic?: string
  topicName?: string
}
/** WO-197: an item of an album (photos or documents sharing a media_group_id; never a replied-to message's file): buffered, delivered with its album */
export const albumItem = (f: Pick<Facts, 'mgid' | 'image' | 'attachment' | 'fromReply'>): boolean => !!(f.mgid && (f.image || f.attachment) && !f.fromReply)
/** Telegram albums contain 2–10 items. The bridge supplies the count when it has one. */
export function albumCountOf(f: Pick<Facts, 'clientMeta'>): number | null {
  const count = f.clientMeta?.media_group_count
  const n = count && /^\d{1,2}$/.test(count) ? Number(count) : NaN
  return Number.isInteger(n) && n >= 2 && n <= 10 ? n : null
}

/** WO-197 (Chiron 16:1xZ, mesh-12795): the tag attributes client.meta never overrides, the one exclusion list. They say where the message is and
 *  whose it is, what the tools and the router act on, so a bad client_meta can never redirect a reply or pass a message off as another:
 *  chat_id, message_id (reply / react / edit_message target them; the router's event id), ts (with chat_id and message_id, the key receipt.ts finds
 *  the delivered copy by), source (the tag's origin, Claude Code's), topic (the reply tool's topic and the router's lane: a reply lands there), user_id
 *  (whose message it is: the allowlist check of its delivery facts). Everything else the bridge sends wins over what the connector derived */
export const CLIENT_META_FIXED: ReadonlySet<string> = new Set(['chat_id', 'message_id', 'ts', 'source', 'topic', 'user_id'])
/** and image_path, image_path_<n>: a file on this machine the agent is told to Read, written only by this daemon (sonn, 16:3xZ): a client_meta that
 *  named one could point the agent at any local file. The bridge never sends it */
export const CLIENT_META_LOCAL = /^image_path(_\d+)?$/
export const clientMetaFixed = (k: string): boolean => CLIENT_META_FIXED.has(k) || CLIENT_META_LOCAL.test(k)
/** WO-197 (rule A): client.meta onto a tag, last, by whatever builds it (finishInbound; an album's flushAlbum, with its first item's): each key as is,
 *  over the tag's own value (a new key comes last), except CLIENT_META_FIXED and a local image path */
export function applyClientMeta(meta: Record<string, string>, cm: Record<string, string> | null | undefined): void {
  for (const [k, v] of Object.entries(cm ?? {})) if (!clientMetaFixed(k)) meta[k] = v
}

/** WO-197: client.meta as tag attributes: every key shaped as an attribute name (letters, digits, _; not starting with a digit), its value as is (a
 *  string; another JSON value as its JSON text). Which keys is the bridge's business: none is named here. null: none */
export function clientMetaOf(client: unknown): Record<string, string> | null {
  const m = (client as any)?.meta
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(m)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) || v == null) continue
    out[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return Object.keys(out).length ? out : null
}
/** WO-197 (lab 1007): the name a file is stored under in Onsen when the person's Telegram message gave it none: Telegram's own, the last part of its
 *  file path (voice/file_7.oga → file_7.oga; onsen-files.ts telegramFile). Not a name the person gave: no attachment_name on the tag */
export const TG_OWN_FILE_NAME = /^file_\d+(\.[A-Za-z0-9]+)?$/
