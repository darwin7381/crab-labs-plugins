// A stand-in for the Telegram Bot API (tests only): server.ts talks to it through TELEGRAM_API_ROOT (grammy and callBotApi). Every call is recorded with
// its parsed body (JSON, or the fields of a multipart upload); updates the test queues are handed out by getUpdates. The bot's private-chat topic mode
// (getMe has_topics_enabled / allows_users_to_create_topics) is state that setMySettings changes, as on the real API.
export type Call = { method: string; body: Record<string, any>; at: number }
export type BotApiMock = {
  url: string; token: string; calls: Call[]; me: Record<string, any>
  push: (u: Record<string, any>) => void
  of: (method: string) => Call[]
  stop: () => void
}
export const ICON_CHECK = '5237699328843200968'

export function startBotApiMock(me: Record<string, any> = {}): BotApiMock {
  const token = '123456:TEST-not-a-real-token'
  const calls: Call[] = []
  const updates: Record<string, any>[] = []
  let nextUpdate = 1, nextMsg = 5000, nextTopic = 7000
  const state = { id: 999, is_bot: true, first_name: 'lab', username: 'lab_test_bot', has_topics_enabled: false, allows_users_to_create_topics: false, ...me }
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  const ok = (result: unknown) => Response.json({ ok: true, result })
  const sent = (b: Record<string, any>) => {
    const thread = b.message_thread_id != null ? Number(b.message_thread_id) : undefined
    return { message_id: ++nextMsg, date: Math.floor(Date.now() / 1000), chat: { id: Number(b.chat_id), type: 'private' }, from: { id: state.id, is_bot: true, first_name: 'lab' },
      ...(b.text != null ? { text: String(b.text) } : {}), ...(thread != null ? { message_thread_id: thread, is_topic_message: true } : {}) }
  }
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const m = new URL(req.url).pathname.match(/^\/bot([^/]+)\/(\w+)$/)
    if (!m || m[1] !== token) return Response.json({ ok: false, error_code: 404, description: 'Not Found' }, { status: 404 })
    const method = m[2]
    let body: Record<string, any> = {}
    const ct = req.headers.get('content-type') ?? ''
    try {
      if (ct.includes('multipart/form-data')) { const f = await req.formData(); for (const [k, v] of f.entries()) body[k] = typeof v === 'string' ? v : '[file]' }
      else if (ct.includes('json')) body = await req.json() as Record<string, any>
    } catch {}
    for (const k of ['reply_parameters', 'reply_markup', 'rich_message']) if (typeof body[k] === 'string') { try { body[k] = JSON.parse(body[k]) } catch {} }
    if (method !== 'getUpdates') calls.push({ method, body, at: Date.now() })
    switch (method) {
      case 'getMe': return ok({ ...state })
      case 'getUpdates': {
        const offset = Number(body.offset ?? 0)
        for (let i = 0; i < 10; i++) {
          const out = updates.filter(u => u.update_id >= offset)
          if (out.length) return ok(out)
          await sleep(50)
        }
        return ok([])
      }
      case 'setMySettings':
        for (const k of ['has_topics_enabled', 'allows_users_to_create_topics']) if (k in body) state[k as 'has_topics_enabled'] = body[k] === true || body[k] === 'true'
        return ok(true)
      case 'sendMessage': case 'sendRichMessage': case 'sendPhoto': case 'sendDocument': return ok(sent(body))
      case 'createForumTopic': return ok({ message_thread_id: ++nextTopic, name: String(body.name ?? ''), icon_color: 7322096 })
      case 'getForumTopicIconStickers': return ok([
        { file_id: 'f1', file_unique_id: 'u1', type: 'custom_emoji', width: 100, height: 100, is_animated: false, is_video: false, emoji: '💡', custom_emoji_id: '5312536423851630001' },
        { file_id: 'f2', file_unique_id: 'u2', type: 'custom_emoji', width: 100, height: 100, is_animated: false, is_video: false, emoji: '✅', custom_emoji_id: ICON_CHECK }])
      default: return ok(true)
    }
  } })
  return {
    url: `http://127.0.0.1:${server.port}`, token, calls, me: state,
    push: (u) => { updates.push({ update_id: nextUpdate++, ...u }) },
    of: (method) => calls.filter(c => c.method === method),
    stop: () => server.stop(true),
  }
}

/** a private-chat message of `from` (Telegram user id) as getUpdates carries it; `topic`: inside that topic (the reply_to is the topic's creation
 *  message, as a real client sends it: knowledge/topics-design.md A3) */
export function dm(from: number, message_id: number, text: string, o: { topic?: number; topicName?: string; command?: boolean } = {}): Record<string, any> {
  const chat = { id: from, type: 'private', first_name: 'J' }
  const date = Math.floor(Date.now() / 1000)
  return { message: { message_id, date, chat, from: { id: from, is_bot: false, first_name: 'J', username: 'joey' }, text,
    ...(o.command ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {}),
    ...(o.topic != null ? { message_thread_id: o.topic, is_topic_message: true,
      reply_to_message: { message_id: o.topic, date, chat, from: { id: 999, is_bot: true, first_name: 'lab' }, message_thread_id: o.topic, is_topic_message: true,
        forum_topic_created: { name: o.topicName ?? `topic ${o.topic}`, icon_color: 7322096 } } } : {}) } }
}
