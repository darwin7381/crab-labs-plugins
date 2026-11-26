// fakes.ts: the two servers telegram-bridge's tests talk to (WO-196 part B). No test reaches the real Telegram or the real Onsen.
//   FakeTelegram  the Bot API calls the bridge makes, per token; getUpdates as Telegram does it (an offset confirms everything below it; a long
//                 poll waits for an update; a second getUpdates on one token ends the first with 409 Conflict); file downloads; failure modes.
//   FakeOnsen     CONTRACT §7b/§7d as written: the extension and its endpoints list (409 endpoint_taken when another bridge carries a member),
//                 POST /v1/files, the five /bridge writes with their exact request shapes, the feed (a long poll, `after`/`next`), delivery reports,
//                 members; `down` answers 503 or drops the connection.

type Bot = { token: string; id: number; username: string; updates: any[]; nextUpdate: number; confirmed: number; waiters: Array<() => void>
  polling: { ac: AbortController | null }; getUpdatesCalls: number; conflicts: number; pinned: Map<string, number> }
export type Sent = { method: string; token: string; chat: string; message_id: number; text?: string; markdown?: string; params: any; file?: { name: string; size: number } }

export class FakeTelegram {
  server: ReturnType<typeof Bun.serve>
  bots = new Map<string, Bot>()
  sent: Sent[] = []
  calls: Array<{ token: string; method: string; params: any }> = []
  files = new Map<string, Uint8Array>()
  private msgId = 1000
  /** method → how to fail the next calls: {code, description, retry_after, times} */
  fail = new Map<string, { code: number; description: string; retry_after?: number; times: number }>()
  /** the rich send is refused (the plain fallback runs) */
  refuseRich = false
  constructor() {
    this.server = Bun.serve({ port: 0, fetch: req => this.handle(req) })
  }
  get root(): string { return `http://127.0.0.1:${this.server.port}` }
  stop(): void { this.server.stop(true) }
  addBot(token: string, username: string): Bot {
    const b: Bot = { token, id: Number(token.split(':')[0]), username, updates: [], nextUpdate: 1, confirmed: 0, waiters: [], polling: { ac: null }, getUpdatesCalls: 0, conflicts: 0, pinned: new Map() }
    this.bots.set(token, b)
    return b
  }
  /** a new update for a bot (its update_id assigned here) */
  push(token: string, u: any): number {
    const b = this.bots.get(token)!
    const id = b.nextUpdate++
    b.updates.push({ update_id: id, ...u })
    for (const w of b.waiters.splice(0)) w()
    return id
  }
  /** a person's text message to a bot */
  text(token: string, from: number, text: string, extra: any = {}): number {
    const msg = { message_id: ++this.msgId, from: { id: from, is_bot: false, first_name: 'Joey', username: 'joey' }, chat: { id: from, type: 'private' }, date: Math.floor(Date.now() / 1000), text, ...extra }
    this.push(token, { message: msg })
    return msg.message_id
  }
  unconfirmed(token: string): number { const b = this.bots.get(token)!; return b.updates.filter(u => u.update_id >= b.confirmed).length }
  sentTo(token: string, chat?: string): Sent[] { return this.sent.filter(s => s.token === token && (chat == null || s.chat === chat)) }
  callsOf(token: string, method: string): any[] { return this.calls.filter(c => c.token === token && c.method === method).map(c => c.params) }
  private ok(result: unknown): Response { return Response.json({ ok: true, result }) }
  private err(code: number, description: string, retry_after?: number): Response {
    return Response.json({ ok: false, error_code: code, description, ...(retry_after != null ? { parameters: { retry_after } } : {}) }, { status: code })
  }
  async handle(req: Request): Promise<Response> {
    const u = new URL(req.url)
    const fm = /^\/file\/bot([^/]+)\/(.+)$/.exec(u.pathname)
    if (fm) { const bytes = this.files.get(fm[2]!); return bytes ? new Response(bytes) : new Response('no', { status: 404 }) }
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(u.pathname)
    if (!m) return new Response('not found', { status: 404 })
    const token = decodeURIComponent(m[1]!), method = m[2]!
    const b = this.bots.get(token)
    if (!b) return this.err(401, 'Unauthorized')
    let params: any = {}
    const ct = req.headers.get('content-type') ?? ''
    let file: { name: string; size: number } | undefined
    if (ct.includes('multipart/form-data')) {
      const fd = await req.formData()
      for (const [k, v] of fd.entries()) {
        if (typeof v === 'string') { try { params[k] = /^[\[{]/.test(v) ? JSON.parse(v) : v } catch { params[k] = v } }
        else file = { name: (v as File).name, size: (v as File).size }
      }
    } else { try { params = await req.json() } catch {} }
    this.calls.push({ token, method, params })
    const f = this.fail.get(method)
    if (f && f.times > 0 && method !== 'getUpdates') { f.times--; return this.err(f.code, f.description, f.retry_after) }
    switch (method) {
      case 'getMe': return this.ok({ id: b.id, is_bot: true, username: b.username, first_name: b.username })
      case 'getUpdates': return this.getUpdates(b, params, req.signal)
      case 'sendRichMessage':
        if (this.refuseRich) return this.err(400, 'Bad Request: rich messages are not supported here')
        return this.record(b, method, params, { markdown: params.rich_message?.markdown })
      case 'sendMessage': return this.record(b, method, params, { text: params.text })
      case 'sendPhoto': case 'sendDocument': return this.record(b, method, params, { file })
      case 'editMessageText': case 'editMessageReplyMarkup': case 'setMessageReaction': case 'sendChatAction': case 'deleteMessage':
      case 'answerCallbackQuery': case 'setMyCommands': case 'editForumTopic':
        return this.ok(true)
      case 'pinChatMessage': b.pinned.set(String(params.chat_id), Number(params.message_id)); return this.ok(true)
      case 'getChat': return this.ok({ id: Number(params.chat_id), type: 'private', ...(b.pinned.has(String(params.chat_id)) ? { pinned_message: { message_id: b.pinned.get(String(params.chat_id)) } } : {}) })
      case 'getFile': return this.files.has(`f/${params.file_id}`) ? this.ok({ file_id: params.file_id, file_path: `f/${params.file_id}`, file_size: this.files.get(`f/${params.file_id}`)!.byteLength }) : this.err(400, 'Bad Request: invalid file_id')
      case 'createForumTopic': return this.ok({ message_thread_id: ++this.msgId, name: params.name })
      case 'getForumTopicIconStickers': return this.ok([{ emoji: '✅', custom_emoji_id: '5237699328843200968' }])
      default: return this.err(404, `Not Found: method ${method}`)
    }
  }
  private record(b: Bot, method: string, params: any, x: { text?: string; markdown?: string; file?: { name: string; size: number } }): Response {
    const message_id = ++this.msgId
    this.sent.push({ method, token: b.token, chat: String(params.chat_id), message_id, params, ...x })
    return this.ok({ message_id, date: Math.floor(Date.now() / 1000), chat: { id: Number(params.chat_id) } })
  }
  private async getUpdates(b: Bot, p: any, signal: AbortSignal): Promise<Response> {
    b.getUpdatesCalls++
    if (b.polling.ac) { b.polling.ac.abort(); b.conflicts++ }          // Telegram: the newer getUpdates ends the older one with 409
    const ac = new AbortController()
    b.polling.ac = ac
    if (p.offset != null) b.confirmed = Math.max(b.confirmed, Number(p.offset))
    const ready = () => b.updates.filter(u => u.update_id >= b.confirmed).slice(0, Number(p.limit ?? 100))
    let got = ready()
    const deadline = Date.now() + Number(p.timeout ?? 0) * 1000
    while (!got.length && Date.now() < deadline && !ac.signal.aborted && !signal.aborted) {
      await new Promise<void>(r => { const t = setTimeout(r, Math.max(1, deadline - Date.now())); b.waiters.push(() => { clearTimeout(t); r() }); ac.signal.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true }) })
      got = ready()
    }
    if (b.polling.ac === ac) b.polling.ac = null
    if (ac.signal.aborted) return this.err(409, 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running')
    return this.ok(got)
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
type Endpoint = { extension: string; records: any[] }
const BRIDGE_MSG_KEYS = ['member', 'client_user_id', 'client_user', 'chat', 'client_msg_id', 'sent_at', 'text', 'kind', 'attachment_file_ids', 'attachments',
  'reply_to_client_msg_id', 'reply_quote', 'reply_to_text', 'reply_to_user', 'client_thread', 'topic_name', 'forward_from', 'forward_date', 'media_group_id', 'idem_key']
const NULLABLE = new Set(['reply_to_client_msg_id', 'reply_quote', 'reply_to_text', 'reply_to_user', 'client_thread', 'topic_name', 'forward_from', 'forward_date', 'media_group_id'])

export class FakeOnsen {
  server: ReturnType<typeof Bun.serve>
  /** credential → identity name */
  creds = new Map<string, string>()
  extensions = new Map<string, any>()
  lists = new Map<string, any[]>()
  /** member → the extension that carries it */
  holders = new Map<string, string>()
  /** a 409 that names the member (false: only a message without it, the bridge probes) */
  namesMember = true
  /** (client_user_id) → member */
  identities = new Map<string, string>([['1828173984', 'joey']])
  notPeople = new Set<string>()
  actionDeliveries: Array<{ id: string; body: any }> = []
  members: Array<{ name: string; display_name: string; kind: string }> = []
  messages: any[] = []
  edits: any[] = []
  reactions: any[] = []
  resolves: Array<{ id: string; body: any }> = []
  lifts: Array<{ id: string; body: any }> = []
  threads: any[] = []
  reports: Array<{ id: string; body: any }> = []
  files = new Map<string, { bytes: Uint8Array; name: string | null; mime: string; key: string | null }>()
  feed: any[] = []
  private seq = 0
  private fileSeq = 0
  private feedWaiters: Array<() => void> = []
  /** 'up' | '503' (every call answers 503) | 'drop' (the connection is closed) */
  mode: 'up' | '503' | 'drop' = 'up'
  /** paths whose next calls answer this (once each) */
  answers: Array<{ path: RegExp; status: number; json: any }> = []
  bad: string[] = []
  requests: Array<{ method: string; path: string; who: string }> = []
  constructor() { this.server = Bun.serve({ port: 0, fetch: (req, srv) => this.handle(req, srv) }) }
  get base(): string { return `http://127.0.0.1:${this.server.port}/api/onsen` }
  stop(): void { this.server.stop(true) }
  /** a BridgeItem into the feed (seq assigned here) */
  push(item: any): string {
    const seq = `7.${++this.seq}`                                           // opaque to the bridge, like Onsen's "<txid>.<id>"
    this.feed.push({ seq, at: new Date().toISOString(), ...item })
    for (const w of this.feedWaiters.splice(0)) w()
    return seq
  }
  private e(status: number, code: string, message: string, extra: any = {}): Response {
    return Response.json({ error: { code, message, retryable: status >= 500 || status === 429, ...extra } }, { status })
  }
  private d(data: any, status = 200): Response { return Response.json({ api_version: '1', as_of: new Date().toISOString(), viewer: 'x', read_by: null, data }, { status }) }
  private check(cond: boolean, what: string): void { if (!cond) this.bad.push(what) }

  async handle(req: Request, srv: any): Promise<Response> {
    const u = new URL(req.url)
    const who = this.creds.get((req.headers.get('authorization') ?? '').replace(/^Bearer /, '')) ?? ''
    this.requests.push({ method: req.method, path: u.pathname, who })
    if (this.mode === 'drop') return new Promise<Response>(r => req.signal.addEventListener('abort', () => r(new Response('', { status: 499 })), { once: true }))
    if (this.mode === '503') return this.e(503, 'service_unavailable', 'down for the test')
    if (!who) return this.e(401, 'not_authenticated', 'no credential')
    const forced = this.answers.findIndex(a => a.path.test(`${req.method} ${u.pathname}`))
    if (forced >= 0) { const a = this.answers.splice(forced, 1)[0]!; return Response.json(a.json, { status: a.status }) }
    const p = u.pathname.replace(/^\/api\/onsen/, '')
    let body: any = null
    if (req.method !== 'GET' && !p.startsWith('/v1/files')) { try { body = await req.json() } catch {} }
    let m: RegExpExecArray | null
    if (req.method === 'GET' && p === '/v1/me') return this.d({ name: who, kind: 'system', permissions: {} })
    if (req.method === 'GET' && p === '/v1/members') return Response.json({ api_version: '1', items: this.members, next_cursor: null })
    if ((m = /^\/v1\/extensions\/([^/]+)$/.exec(p)) && req.method === 'PUT') {
      const name = m[1]!
      if (name !== who) return this.e(403, 'not_authorized', 'an extension writes only its own')
      const keys = Object.keys(body ?? {}).sort().join(',')
      this.check(keys === 'client,collections,kind,machine,title,version', `register keys ${keys}`)
      this.check(body.kind === 'bridge' && body.client === 'telegram', 'register kind/client')
      this.check(Array.isArray(body.collections) && body.collections.length === 1 && body.collections[0].name === 'endpoints' && body.collections[0].ttl_seconds >= 5, 'register collections')
      const first = !this.extensions.has(name)
      this.extensions.set(name, body)
      return this.d({ name, ...body }, first ? 201 : 200)
    }
    if ((m = /^\/v1\/extensions\/([^/]+)\/collections\/([^/]+)$/.exec(p)) && req.method === 'PUT') {
      const name = m[1]!
      if (name !== who) return this.e(403, 'not_authorized', 'an extension writes only its own')
      if (!this.extensions.has(name) || m[2] !== 'endpoints') return this.e(404, 'not_found', 'register first')
      const recs: any[] = body?.records ?? []
      this.check(typeof body?.reported_at === 'string', 'reported_at')
      for (const r of recs) {
        this.check(Object.keys(r).sort().join(',') === 'attributes,id,line,member,state,title', `record keys ${Object.keys(r).sort().join(',')}`)
        this.check(typeof r.id === 'string' && r.id.length >= 1 && r.id.length <= 200, 'record id')
        this.check(typeof r.title === 'string' && r.title.length >= 1 && r.title.length <= 200 && !/[\n\r]/.test(r.title), 'record title')
        this.check(typeof r.line === 'string' && r.line.length >= 1 && r.line.length <= 500 && !/[\n\r]/.test(r.line), 'record line')
        this.check(['ok', 'conflict', 'error'].includes(r.state), `record state ${r.state}`)
        this.check(r.member === null || typeof r.member === 'string', 'record member')
        this.check(Object.keys(r.attributes ?? {}).length <= 50 && JSON.stringify(r.attributes).length <= 4096, 'record attributes')
      }
      const claims = recs.filter(r => r.member && r.state !== 'conflict')          // Onsen 0.35.0: a conflict record claims nothing
      const taken = claims.filter(r => this.holders.has(r.member) && this.holders.get(r.member) !== name)
      if (taken.length) {
        const held = taken.map(r => ({ member: r.member, bridge: this.holders.get(r.member) }))
        return this.e(409, 'endpoint_taken', held.map(h => `${h.member} 在 telegram 上已經由橋接 ${h.bridge} 帶著`).join('、'), this.namesMember ? { taken: held } : {})
      }
      for (const [mem, ext] of [...this.holders]) if (ext === name) this.holders.delete(mem)
      for (const r of claims) this.holders.set(r.member, name)
      this.lists.set(name, recs)
      return this.d({ name })
    }
    if (p === '/v1/files' && req.method === 'POST') {
      const key = req.headers.get('idempotency-key')
      for (const [id, f] of this.files) if (key && f.key === key) return this.d({ id, name: f.name, mime: f.mime, bytes: f.bytes.byteLength, url: `/api/onsen/v1/files/${id}` })
      const bytes = new Uint8Array(await req.arrayBuffer())
      const id = String(++this.fileSeq)
      const name = req.headers.get('x-file-name')
      this.files.set(id, { bytes, name: name ? decodeURIComponent(name) : null, mime: req.headers.get('content-type') ?? 'application/octet-stream', key })
      return this.d({ id, name, mime: req.headers.get('content-type'), bytes: bytes.byteLength, url: `/api/onsen/v1/files/${id}` }, 201)
    }
    if ((m = /^\/v1\/files\/(\d+)$/.exec(p)) && req.method === 'GET') {
      const f = this.files.get(m[1]!)
      return f ? new Response(f.bytes, { headers: { 'content-type': f.mime } }) : this.e(404, 'not_found', 'no file')
    }
    if (p === '/v1/bridge/messages' && req.method === 'POST') {
      const keys = Object.keys(body ?? {}).sort()
      this.check(keys.join(',') === [...BRIDGE_MSG_KEYS].sort().join(','), `bridge message keys ${keys.join(',')}`)
      for (const k of BRIDGE_MSG_KEYS) this.check(body[k] !== undefined && (body[k] !== null || NULLABLE.has(k)), `bridge message ${k} missing or null`)
      this.check(typeof body.text === 'string' && typeof body.kind === 'string' && Array.isArray(body.attachments) && Array.isArray(body.attachment_file_ids), 'bridge message types')
      this.check(typeof body.client_user === 'object' && 'username' in body.client_user && 'display_name' in body.client_user, 'client_user shape')
      for (const a of body.attachments ?? []) this.check(Object.keys(a).sort().join(',') === 'bytes,client_ref,kind,mime,name', `attachment keys ${Object.keys(a).sort().join(',')}`)
      if (this.holders.get(body.member) !== who) return this.e(404, 'no_endpoint', `${who} 沒有帶 ${body.member}`)
      let from = this.identities.get(String(body.client_user_id))
      if (!from && body.chat !== body.client_user_id) { from = `tg-${body.client_user_id}`; this.identities.set(String(body.client_user_id), from) }   // a group: a guest
      if (!from) return this.e(403, 'unknown_identity', '不認得這個帳號')
      if (this.notPeople.has(String(body.client_user_id))) return this.e(403, 'not_allowed', '這個帳號是 agent')
      const dup = this.messages.find(x => x.idem_key === body.idem_key)
      if (dup) return this.d({ message_id: dup.id, conversation_id: `cv_${body.member}`, from, duplicate: true })
      const id = String(9000 + this.messages.length + 1)
      this.messages.push({ id, ...body, at: Date.now() })
      return this.d({ message_id: id, conversation_id: `cv_${body.member}`, from, duplicate: false }, 201)
    }
    if (p === '/v1/bridge/messages/edit' && req.method === 'POST') {
      this.check(Object.keys(body ?? {}).sort().join(',') === 'chat,client_msg_id,edited_at,member,text', `edit keys ${Object.keys(body ?? {}).sort().join(',')}`)
      const msg = this.messages.find(x => x.member === body.member && x.chat === body.chat && x.client_msg_id === body.client_msg_id)
      if (!msg) return this.e(404, 'not_found', 'no such message')
      this.edits.push(body)
      return this.d({ message_id: msg.id, changed: true })
    }
    if (p === '/v1/bridge/reactions' && req.method === 'POST') {
      this.check(Object.keys(body ?? {}).sort().join(',') === 'at,chat,client_msg_id,client_user_id,emojis,member', `reaction keys ${Object.keys(body ?? {}).sort().join(',')}`)
      this.reactions.push(body)
      return this.d({ message_id: 'x' })
    }
    if ((m = /^\/v1\/bridge\/actions\/([^/]+)\/resolve$/.exec(p)) && req.method === 'POST') {
      this.check(Object.keys(body ?? {}).sort().join(',') === 'at,client_user_id,option', `resolve keys ${Object.keys(body ?? {}).sort().join(',')}`)
      if (this.resolves.some(r => r.id === m![1] && r.body.option !== body.option)) return this.e(409, 'version_conflict', 'answered already')
      this.resolves.push({ id: decodeURIComponent(m[1]!), body })
      return this.d({ id: m[1], state: 'resolved' })
    }
    if ((m = /^\/v1\/bridge\/restart-lines\/([^/]+)\/lift$/.exec(p)) && req.method === 'POST') {
      this.check(Object.keys(body ?? {}).sort().join(',') === 'client_user_id', `lift keys ${Object.keys(body ?? {}).sort().join(',')}`)
      this.lifts.push({ id: decodeURIComponent(m[1]!), body })
      return this.d({ id: m[1], lifted: true })
    }
    if (p === '/v1/bridge/threads' && req.method === 'PUT') {
      this.check(Object.keys(body ?? {}).sort().join(',') === 'chat,client_thread,member,thread', `threads keys ${Object.keys(body ?? {}).sort().join(',')}`)
      this.threads.push(body)
      return this.d(body)
    }
    if (p === '/v1/bridge/feed' && req.method === 'GET') {
      const after = u.searchParams.get('after'), wait = Math.min(55, Number(u.searchParams.get('wait') ?? 0)), limit = Math.min(100, Number(u.searchParams.get('limit') ?? 100))
      for (const k of u.searchParams.keys()) this.check(['after', 'wait', 'limit'].includes(k), `feed param ${k}`)
      const mine = (it: any) => this.holders.get(it.member) === who
      const num = (c: string) => Number(c.split('.')[1])
      const from = after == null ? this.seq : num(after)          // no `after`: from now on
      const ready = () => this.feed.filter(it => num(it.seq) > from && mine(it)).slice(0, limit)
      let items = ready()
      const deadline = Date.now() + wait * 1000
      while (!items.length && Date.now() < deadline && !req.signal.aborted) {
        await new Promise<void>(r => { const t = setTimeout(r, Math.max(1, deadline - Date.now())); this.feedWaiters.push(() => { clearTimeout(t); r() }) })
        items = ready()
      }
      const next = items.length ? items[items.length - 1].seq : `7.${from}`
      return Response.json({ items, next })
    }
    if ((m = /^\/v1\/bridge\/actions\/([^/]+)\/delivery$/.exec(p)) && req.method === 'POST') {
      this.check(Object.keys(body ?? {}).sort().join(',') === 'client_msg_ids,client_user_id', `action delivery keys ${Object.keys(body ?? {}).sort().join(',')}`)
      this.actionDeliveries.push({ id: decodeURIComponent(m[1]!), body })
      return this.d({ id: m[1] })
    }
    if ((m = /^(?:\/v1)?\/messages\/([^/]+)\/delivery$/.exec(p)) && req.method === 'POST') {
      this.check(Object.keys(body ?? {}).sort().join(',') === 'at,client,client_msg_ids,error,state', `delivery keys ${Object.keys(body ?? {}).sort().join(',')}`)
      this.check(body.client === 'telegram' && ['sent', 'failed'].includes(body.state), 'delivery client/state')
      this.reports.push({ id: m[1]!, body })
      return Response.json({ id: m[1], state: body.state, duplicate: false })
    }
    return this.e(404, 'not_found', `no route ${req.method} ${p}`)
  }
}

/** wait until `f` is true (polls every 20 ms) */
export async function until(f: () => boolean | Promise<boolean>, ms = 5000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await f()) return; await Bun.sleep(20) }
  throw new Error(`timed out waiting for ${what}`)
}
