/**
 * lanes-topics.ts — work topics in Joey's private chat (Bot API 9.3 private-chat topics, 9.4 the bot opens them and may forbid the user to, 10.5
 * setMySettings). Pure helpers: the decision on the bot's topic mode, names and links. The state (which message is in which topic, the topic names, the
 * worker lane of a topic) is lanes.ts's; the Bot API calls are server.ts's.
 *
 * Measured 2026-11-23 in a real client (Telegram Web A 13.0.2 and Web K, the test bot with the test account; the workspace anchor file
 * knowledge/topics-design.md, 「已查實的」):
 *  - has_topics_enabled=true with allows_users_to_create_topics=false: the user types in "All Messages" (its input says "Off-topic message"), the bot
 *    gets the message with no message_thread_id, no topic is created and the user has no "new topic" control. With allows_users_to_create_topics=true
 *    every message typed from the default view opens a new topic. setMySettings has_topics_enabled=true alone left allows_users_to_create_topics true.
 *  - A bot message is shown inside a topic only when it carries message_thread_id. reply_parameters alone puts it OUTSIDE the topic in the client,
 *    although the API's answer names the topic. Both together: inside, with the quote.
 *  - editForumTopic renames (plain text: emoji in a name are dropped by the server, which still answers true) and sets the icon (icon_custom_emoji_id,
 *    ids from getForumTopicIconStickers; ✅ is one). closeForumTopic does not exist for private chats (400). deleteForumTopic removes the topic WITH
 *    its messages: a work topic is never deleted.
 */

export type TopicMe = { has_topics_enabled?: unknown; allows_users_to_create_topics?: unknown; username?: unknown }
export type TopicMode = 'auto' | 'enable' | 'off'
/** LANES_WORKER_TOPICS: auto (default: use the bot's topic mode as it is; change nothing) | enable (set it at start) | off (never a worker topic) */
export function topicMode(v: unknown = process.env.LANES_WORKER_TOPICS): TopicMode {
  const s = String(v ?? 'auto').trim()
  return s === 'enable' || s === 'off' ? s : 'auto'
}
/** THE topic mode worker topics need, always sent as ONE setMySettings call: topics on, and only the bot opens them */
export const TOPIC_SETTINGS = Object.freeze({ has_topics_enabled: true, allows_users_to_create_topics: false })

/** can the bot open a work topic in this mode (getMe)? true: topics on and only the bot opens them; false: off, or on with the user opening a topic
 *  per message (the broken mode: worker topics are not used, the main does the work); null: getMe does not say (tried, as before) */
export type TopicVerdict = { usable: boolean | null; why: string }
export const USERS_CREATE_WHY = "the bot's private-chat topic mode lets the user open topics (has_topics_enabled=true, allows_users_to_create_topics=true): "
  + 'every message Joey types outside a topic opens a new one. Worker topics are not used in that mode (the main does the work); '
  + 'set it with LANES_WORKER_TOPICS=enable, or setMySettings has_topics_enabled=true and allows_users_to_create_topics=false in one call.'
export function topicVerdict(me: TopicMe | null | undefined): TopicVerdict {
  if (!me) return { usable: null, why: 'getMe was not read' }
  const on = me.has_topics_enabled, users = me.allows_users_to_create_topics
  if (on === true && users === false) return { usable: true, why: 'has_topics_enabled=true, allows_users_to_create_topics=false' }
  if (on === true && users === true) return { usable: false, why: USERS_CREATE_WHY }
  if (on === false) return { usable: false, why: "the bot's private-chat topic mode is off (has_topics_enabled=false)" }
  return { usable: null, why: `getMe says has_topics_enabled=${String(on)}, allows_users_to_create_topics=${String(users)}` }
}

export type TopicApi = { setMySettings: (p: typeof TOPIC_SETTINGS) => Promise<unknown>; getMe: () => Promise<TopicMe> }
export type TopicStart = { mode: TopicMode; verdict: TopicVerdict; set: boolean; warn: string | null }
/** the daemon's start: `enable` sets TOPIC_SETTINGS (one call) unless getMe already shows exactly that, and checks both fields with getMe after it;
 *  `auto` changes nothing and warns once when getMe shows the broken mode (users open topics); `off` asks nothing. Never throws. */
export async function topicModeAtStart(mode: TopicMode, me: TopicMe | null, api: TopicApi): Promise<TopicStart> {
  if (mode === 'off') return { mode, verdict: { usable: false, why: 'LANES_WORKER_TOPICS=off' }, set: false, warn: null }
  const v0 = topicVerdict(me)
  if (mode === 'auto') return { mode, verdict: v0, set: false, warn: v0.usable === false && me?.has_topics_enabled === true ? USERS_CREATE_WHY : null }
  if (v0.usable === true) return { mode, verdict: v0, set: false, warn: null }
  try {
    await api.setMySettings({ ...TOPIC_SETTINGS })
    const v = topicVerdict(await api.getMe())
    if (v.usable === true) return { mode, verdict: v, set: true, warn: null }
    const warn = `LANES_WORKER_TOPICS=enable: setMySettings(has_topics_enabled=true, allows_users_to_create_topics=false) did not take (getMe after it: ${v.why}). `
      + 'Worker topics are not used; the main does the work.'
    return { mode, verdict: { usable: false, why: warn }, set: true, warn }
  } catch (e) {
    const warn = `LANES_WORKER_TOPICS=enable: setMySettings failed (${String(e).slice(0, 200)}). Worker topics are not used; the main does the work.`
    return { mode, verdict: { usable: false, why: warn }, set: true, warn }
  }
}
