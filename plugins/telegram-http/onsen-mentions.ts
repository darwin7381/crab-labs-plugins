// onsen-mentions.ts — WO-181, the plugin half (board WO-181, Chiron; Joey TG chiron:2532 「除了信箱之外，都有通訊軟體、也有通知佇列+動態牆」).
// A comment on a ticket that names the other side (Epeius's half, Onsen 0.25.0: posts carry mentions) is a `reason: mention` notification in Onsen's
// queue for that member; until now nothing on the agent's side read it (Chiron saw 「請你定」 comments 44 min to 28 h late). Now, when the main is woken
// or its turn is ending (lanes-main.ts: the offer, the pull at a tool boundary or Stop), in the same place and the same go as the lanes digest rides:
//   GET /v1/notifications?reason=mention&read=unread&limit=20 with this agent's own credential → one block: Chiron's title with N (counts.mention, every
//   unread mention) and one line per notification, the PostCard's `line` as Onsen made it (never composed here); more than shown: the last line says how
//   many more. Nothing unread: no block (not an empty title).
//   Once the delivery carrying it reached the main (offered into its session, or pulled into its turn), each post is marked read: PUT
//   /v1/posts/<id>/read {read: true} (Onsen's read for a notification: there is no PUT /notifications/<id>/read; it reads every reason of that post).
//   A delivery that failed marks nothing; the next delivery fetches them again.
// It wakes nobody: no timer, no wake, no Joey push; an idle main gets the block with whatever wakes it next (the mailbox batch included). Main only.
// Onsen down, slow (LANES_MENTION_TIMEOUT_MS, 2 s) or erroring: no block this time, one log line; the delivery goes on as it would have.
// Switch LANES_MENTION_CARDS: a comma list of agent names or `*` (server.ts reads it as JEV_SCREEN: the plist, else the machine config, every 30 s).

export const MENTION_LIMIT = 20
/** Chiron's title, verbatim, with the count */
export const mentionTitle = (n: number): string => `〔點名你的動態｜${n} 則。別人在你的單或你名下的串上說了什麼；只讓你知道，要看全文用 feed_open〕`
export const mentionMore = (n: number): string => `還有 ${n} 則沒列出，下一次附上`
/** the block the digest carries and the posts it names (marked read once it reached the main) */
export type MentionBlock = { text: string; posts: string[]; count: number }
export type MentionReq = (method: 'GET' | 'PUT', path: string, body: unknown, timeoutMs: number) => Promise<{ status: number; json: any } | null>
export const MENTIONS_PATH = `/v1/notifications?reason=mention&read=unread&limit=${MENTION_LIMIT}`

/** Onsen's answer (CONTRACT v1 §6, §9: P<Notification> + counts + cards) as the block; null: nothing unread, or not an answer of that shape */
export function mentionBlock(json: any): MentionBlock | null {
  const items = Array.isArray(json?.items) ? json.items as Array<Record<string, unknown>> : null
  const cards = Array.isArray(json?.cards) ? json.cards as Array<Record<string, unknown>> : []
  if (!items) return null
  const lineOf = new Map<string, string>()
  for (const c of cards) if (c && c.post_id != null && typeof c.line === 'string' && c.line) lineOf.set(String(c.post_id), c.line)
  const posts: string[] = [], lines: string[] = []
  for (const it of items) {
    if (!it || it.reason !== 'mention' || it.read_at) continue
    const p = String(it.post_id ?? '')
    const line = lineOf.get(p)
    if (!p || !line || posts.includes(p)) continue                       // a notification whose card is not in the answer: not shown, not marked
    posts.push(p); lines.push(line)
  }
  if (!posts.length) return null
  const counted = Number(json?.counts?.mention)
  const count = Number.isInteger(counted) && counted >= posts.length ? counted : posts.length
  return { text: [mentionTitle(count), ...lines, ...(count > posts.length ? [mentionMore(count - posts.length)] : [])].join('\n'), posts, count }
}

export class MentionCards {
  private stats = { fetched: 0, blocks: 0, lines: 0, read: 0, read_failed: 0, failed: 0, last_error: null as string | null, last_at: null as string | null }
  constructor(private readonly o: { on: () => boolean; req: MentionReq; log: (level: 'info' | 'warn', msg: string) => void; timeoutMs?: () => number }) {}
  private timeout(): number { const t = this.o.timeoutMs?.(); return t && Number.isFinite(t) && t > 0 ? t : 2_000 }
  /** the fetch for this delivery; null at once when switched off (the caller awaits nothing). It resolves null for nothing unread or no answer */
  fetchIfOn(): Promise<MentionBlock | null> | null {
    let on = false
    try { on = this.o.on() } catch {}
    return on ? this.fetch() : null
  }
  /** the block for this delivery; null: nothing unread, or Onsen did not answer (one log line). Never throws, never waits past the timeout */
  async fetch(): Promise<MentionBlock | null> {
    this.stats.fetched++; this.stats.last_at = new Date().toISOString()
    const t = this.timeout()
    let r: { status: number; json: any } | null | 'timeout' = null
    let err: string | null = null
    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      r = await Promise.race([this.o.req('GET', MENTIONS_PATH, undefined, t), new Promise<'timeout'>(res => { timer = setTimeout(() => res('timeout'), t + 250) })])
        .finally(() => clearTimeout(timer))
    } catch (e) { err = String(e).slice(0, 200) }
    if (!err && r === 'timeout') err = `no answer within ${t} ms`
    else if (!err && r == null) err = 'no credential'
    else if (!err && r && r !== 'timeout' && (r.status < 200 || r.status >= 300)) err = `HTTP ${r.status}${r.json?.error?.code ? ` ${r.json.error.code}` : ''}`
    if (err) {
      this.stats.failed++; this.stats.last_error = err
      this.o.log('warn', `lanes: mention cards: GET ${MENTIONS_PATH} failed (${err}); this delivery goes without them`)
      return null
    }
    const b = mentionBlock((r as { json: any }).json)
    if (b) { this.stats.blocks++; this.stats.lines += b.posts.length }
    return b
  }
  /** the delivery carrying these posts reached the main: each one read (in the background; a failure is one log line, the post shows again next time) */
  read(posts: string[]): void {
    for (const p of [...new Set(posts)]) {
      if (!/^\d{1,18}$/.test(p)) continue
      void this.o.req('PUT', `/v1/posts/${p}/read`, { read: true }, this.timeout()).then(r => {
        if (r && r.status >= 200 && r.status < 300) { this.stats.read++; return }
        this.stats.read_failed++
        this.o.log('warn', `lanes: mention cards: marking post ${p} read failed (${r ? `HTTP ${r.status}` : 'no credential'})`)
      }).catch(e => { this.stats.read_failed++; this.o.log('warn', `lanes: mention cards: marking post ${p} read failed (${String(e).slice(0, 120)})`) })
    }
  }
  health(): Record<string, unknown> {
    let on = false
    try { on = this.o.on() } catch {}
    return { on, ...this.stats }
  }
}
