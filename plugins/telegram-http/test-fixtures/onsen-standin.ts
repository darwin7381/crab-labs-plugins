// A stand-in for Onsen (tests only; WO-192): a local HTTP server with Onsen 0.31.0's answers for what a Telegram daemon calls. Messages written first
// (POST /messages with delivery pending) and the old records (POST /messages/batch, client_msg_id) are kept; POST /messages/<id>/delivery moves a
// message's delivery as Onsen does (sent: its numbers become aliases; the same state again: duplicate; sent → failed: 409); GET /alias/telegram/...
// and GET /messages/<id> answer from them (chat_history's tg:<id>); POST /v1/files keeps the bytes. Each daemon has its own credential (`who`).
// WO-193 (Onsen 0.33.0, for WO-194): a message written `deliver: true` (direction in) puts one person_message item (dedupe pm:<id>) in the writer's
// inbox (GET /inbox long poll, POST /inbox/ack, as onsen5); a person's edit event (POST /events kind edit) of such a message puts a person_edit
// (pe:<event id>); say() puts a page message (via web). The payload is onsen_person.py's.
export type Who = string
export type Msg = { id: number; who: Who; item: any; at: number; path: '/messages' | '/messages/batch'; aliases: string[]; files: string[]
  delivery: null | { state: 'pending' | 'sent' | 'failed'; delivered_at?: string; failed_at?: string; error?: string } }
export type Seen = { who: Who; method: string; path: string; body: any; headers: Record<string, string>; at: number }
export type OnsenStandin = {
  port: number; msgs: Msg[]; seen: Seen[]; files: Map<string, { id: string; bytes: Uint8Array; at: number }>
  /** WO-193: each credential's inbox (the agent-inbox daemon of the same credential pulls it) */
  inbox: Array<{ who: Who; seq: number; kind: string; sender: string; payload: any; dedupe: string; acked: boolean; at: number }>
  /** WO-193: a page message (via web) for the agent of `who` */
  say: (who: Who, chat: string, text: string, attachments?: any[], reply_to?: any) => number
  /** any item into the inbox of `who` (a peer's call, for instance); its seq */
  put: (who: Who, kind: string, payload: any, dedupe: string) => number
  /** per credential: Onsen's version (default 0.31.0), POST /messages answering 500, a delay before A is answered (ms). WO-197: `bridge[who]`: a
   *  Telegram bridge carries that agent (its messages are written pending and reported sent after delayMs with the next Telegram numbers, one per
   *  ~4000 characters of text and one per file); off: they stay pending (bridgeOn() draws them later) */
  st: { version: Record<Who, string>; a500: Record<Who, boolean>; aDelayMs: number; bridge: Record<Who, { on: boolean; delayMs: number; next: number }>
    /** WO-197 (defect 3): a delay before a stored file is served (GET /v1/files/<id>: a large photo) */
    fileDelayMs?: number }
  /** WO-197: the connector's writes (POST /v1/messages), reactions (POST /v1/messages/<id>/reactions) and edits (PUT /v1/messages/<id>) */
  connector: Array<{ who: Who; kind: 'message' | 'reaction' | 'edit'; id: number; body: any }>
  /** WO-197: the bridge of `who` comes on: what waits pending is drawn now */
  bridgeOn: (who: Who) => void
  /** WO-197: the conversation of a chat (made the first time); a person's message in it from Telegram (as the bridge writes it: its number an alias) */
  conv: (chat: string) => string
  heard: (who: Who, chat: string, n: number, text: string) => number
  writes: (who: Who) => Msg[]
  reports: (who: Who, id?: number) => Seen[]
  stop: () => void
}

export function startOnsenStandin(creds: Record<string, Who>, port = 0): OnsenStandin {
  const msgs: Msg[] = [], seen: Seen[] = []
  const files = new Map<string, { id: string; bytes: Uint8Array; at: number }>()
  const inbox: OnsenStandin['inbox'] = []
  const put = (who: Who, kind: string, payload: any, dedupe: string): number => {
    const had = inbox.find(i => i.who === who && i.dedupe === dedupe)
    if (had) return had.seq
    const seq = inbox.filter(i => i.who === who).length + 1
    inbox.push({ who, seq, kind, sender: 'joey', payload, dedupe, acked: false, at: Date.now() })
    return seq
  }
  const person = (m: Msg): any => {
    const it = m.item, uid = String(it.sender ?? '').replace(/^tg:/, '')
    const rt = it.reply_to_client_msg_id != null ? msgs.find(x => x.who === m.who && String(x.item.chat) === String(it.chat) && x.aliases.includes(String(it.reply_to_client_msg_id))) : undefined
    return { message_id: String(m.id), conversation_id: '1', from: 'joey', via: 'telegram', text: it.body ?? '', kind: it.kind, sent_at: it.sent_at,
      attachments: (it.attachments ?? []).map((a: any) => ({ kind: it.kind === 'photo' ? 'photo' : it.kind, name: a.name ?? null, mime: a.mime ?? null, bytes: a.size ?? null, url: null, client_ref: a.file_id ?? null })),
      client: { name: 'telegram', chat: String(it.chat), msg_id: it.client_msg_id, user: it.meta?.user ?? uid, user_id: uid, ...(it.thread ? { thread: String(it.thread) } : {}) },
      reply_to: it.reply_to_client_msg_id == null ? null : rt ? { message_id: String(rt.id), client_msg_id: String(it.reply_to_client_msg_id), from: 'joey', text: String(rt.item.body ?? '').slice(0, 500) }
        : { message_id: null, client_msg_id: String(it.reply_to_client_msg_id), from: it.meta?.reply_to_user ?? null, text: it.meta?.reply_to_text ?? null },
      ...(it.meta?.reply_quote ? { reply_quote: it.meta.reply_quote } : {}), ...(it.meta?.topic_name ? { topic_name: it.meta.topic_name } : {}),
      ...(it.forward_from ? { forward_from: it.forward_from } : {}), ...(it.meta?.forward_date ? { forward_date: it.meta.forward_date } : {}),
      ...(it.meta?.media_group_id ? { media_group_id: it.meta.media_group_id } : {}) }
  }
  const st: OnsenStandin['st'] = { version: {}, a500: {}, aDelayMs: 0, bridge: {} }
  const connector: OnsenStandin['connector'] = []
  // WO-197: a connector's conversations: one per chat (id 700 + n); `onsen:<id>` chats have no client (nothing draws them)
  const convs: string[] = []
  const convOf = (chat: string): number => { let i = convs.indexOf(chat); if (i < 0) { convs.push(chat); i = convs.length - 1 } return 700 + i }
  const chatOf = (cid: number): string | undefined => convs[cid - 700]
  const draw = (m: Msg): void => {
    const b = st.bridge[m.who]
    if (!b || !b.on || m.delivery?.state !== 'pending') return
    setTimeout(() => {
      if (m.delivery?.state !== 'pending') return
      const n = Math.max(1, Math.ceil(String(m.item.body ?? '').length / 4000)) + (m.item.attachment_file_ids?.length ?? 0)
      for (let i = 0; i < n; i++) m.aliases.push(String(b.next++))
      m.delivery = { state: 'sent', delivered_at: new Date().toISOString() }
    }, b.delayMs)
  }
  let next = 4000
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  const full = (m: Msg) => ({ id: m.id, agent: m.item.agent, chat: m.item.chat, at: m.item.sent_at, direction: m.item.direction, sender: m.item.direction === 'out' ? `agent:${m.item.agent}` : m.item.sender,
    sender_part: m.item.direction === 'out' ? m.item.sender : null, kind: m.item.kind, body: m.item.body, status: m.item.status, meta: { ...(m.item.meta ?? {}), ...(m.aliases[0] ? { client_msg_id: m.aliases[0] } : {}) },
    aliases: m.aliases.map(a => ({ client: 'telegram', scope: m.item.agent, client_ref: `${m.item.chat}:${a}` })), attachments: m.item.attachments ?? [], events: [], delivery: m.delivery })
  const write = (who: Who, it: any, path: Msg['path']): any => {
    const had = msgs.find(m => m.who === who && m.item.idem_key === it.idem_key)
    if (had) return { id: had.id, duplicate: true }
    if (it.delivery) {
      if (it.client_msg_id) return { status: 400, detail: 'delivery: the message is written before the client has it, so no client_msg_id' }
      if (it.direction !== 'out' || it.status !== 'ok') return { status: 400, detail: "delivery: only on an agent's own reply" }
    }
    const m: Msg = { id: next++, who, item: it, at: Date.now(), path, aliases: it.client_msg_id ? [String(it.client_msg_id)] : [], files: it.attachment_file_ids ?? [],
      delivery: it.delivery ? { state: 'pending' } : null }
    msgs.push(m)
    if (it.deliver === true && it.direction === 'in' && it.status === 'ok') put(who, 'person_message', person(m), `pm:${m.id}`)
    return { id: m.id, duplicate: false, ...(m.files.length ? { attachments: m.files.length } : {}) }
  }
  const server = Bun.serve({ port, hostname: '127.0.0.1', idleTimeout: 60, async fetch(req) {
    const u = new URL(req.url), path = u.pathname.replace(/^\/api\/onsen/, '')
    const who = creds[(req.headers.get('authorization') ?? '').replace(/^Bearer /, '')]
    if (!who) return Response.json({ error: 'auth' }, { status: 401 })
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => { headers[k] = v })
    if (path === '/v1/files' && req.method === 'POST') {
      const raw = new Uint8Array(await req.arrayBuffer())
      seen.push({ who, method: 'POST', path, body: null, headers, at: Date.now() })
      const key = `${who}:${headers['idempotency-key']}`
      const had = files.get(key) ?? { id: String(next++), bytes: raw, at: Date.now() }
      files.set(key, had)
      return Response.json({ api_version: 1, data: { id: had.id, bytes: raw.length, url: `http://127.0.0.1:${server.port}/api/onsen/v1/files/${had.id}` } }, { status: 201 })
    }
    const gf = req.method === 'GET' ? path.match(/^\/v1\/files\/(\d+)$/) : null      // WO-197: a stored file, as the bridge stored it
    if (gf) {
      const f = [...files.values()].find(x => x.id === gf[1])
      seen.push({ who, method: 'GET', path, body: null, headers, at: Date.now() })
      if (st.fileDelayMs) await sleep(st.fileDelayMs)
      return f ? new Response(f.bytes, { headers: { 'content-type': 'application/octet-stream' } }) : Response.json({ error: { message: 'no file' } }, { status: 404 })
    }
    const body = req.method === 'POST' || req.method === 'PUT' ? await req.json().catch(() => null) : undefined
    seen.push({ who, method: req.method, path, body, headers, at: Date.now() })
    if (path === '/v1/meta') return Response.json({ api_version: 1, data: { server_version: st.version[who] ?? '0.31.0', commit: 'test', deployed_at: '2026-11-26T10:00:43Z' } })
    // WO-197: the connector's side of CONTRACT §7d (Onsen 0.35.2)
    const bc = path.match(/^\/v1\/conversations\/by-chat\/([^/]+)$/)
    if (bc) {
      const chat = decodeURIComponent(bc[1]!)
      if (!msgs.some(m => m.who === who && String(m.item.chat) === chat) && !convs.includes(chat)) return Response.json({ error: { code: 'not_found', message: `no ${chat}` } }, { status: 404 })
      return Response.json({ api_version: 1, data: { id: String(convOf(chat)), kind: 'direct' } })
    }
    const bm = path.match(/^\/v1\/conversations\/(\d+)\/messages\/by-client-id\/([^/]+)$/)
    if (bm) {
      const chat = chatOf(Number(bm[1])), n = decodeURIComponent(bm[2]!)
      const m = chat == null ? undefined : msgs.find(x => x.who === who && String(x.item.chat) === chat && (x.aliases.includes(n) || `form-${x.id}` === n))
      return m ? Response.json({ api_version: 1, data: { id: String(m.id), conversation_id: bm[1] } }) : Response.json({ error: { code: 'not_found', message: `no ${n}` } }, { status: 404 })
    }
    if (path === '/v1/messages' && req.method === 'POST') {
      if (st.a500[who]) return Response.json({ error: { message: 'database is down' } }, { status: 500 })
      const bad = ['client', 'chat', 'delivery', 'client_msg_id', 'backfilled', 'deliver'].filter(k => k in (body ?? {}))
      if (bad.length || (body?.conversation_id == null) === (body?.to == null)) return Response.json({ error: { message: `with conversation_id / to, no ${bad.join(', ')}` } }, { status: 400 })
      const had = msgs.find(m => m.who === who && m.item.idem_key === body.idem_key)
      if (had) return Response.json({ api_version: 1, data: { message_id: String(had.id), conversation_id: String(body.conversation_id), duplicate: true, delivery: had.delivery?.state ?? 'sent' } })
      const cid = Number(body.conversation_id), chat = chatOf(cid) ?? `onsen-${cid}`
      const drawn = chatOf(cid) != null && !!st.bridge[who]
      const m: Msg = { id: next++, who, item: { ...body, chat, agent: 'adam', direction: 'out', status: 'ok' }, at: Date.now(), path: '/messages', aliases: [],
        files: body.attachment_file_ids ?? [], delivery: drawn ? { state: 'pending' } : { state: 'sent', delivered_at: new Date().toISOString() } }
      msgs.push(m)
      connector.push({ who, kind: 'message', id: m.id, body })
      draw(m)
      return Response.json({ api_version: 1, data: { message_id: String(m.id), conversation_id: String(cid), duplicate: false, delivery: m.delivery!.state } }, { status: 201 })
    }
    const cr = path.match(/^\/v1\/messages\/(\d+)\/reactions$/)
    if (cr && req.method === 'POST') { connector.push({ who, kind: 'reaction', id: Number(cr[1]), body }); return Response.json({ api_version: 1, data: { message_id: cr[1], emojis: body?.emojis } }) }
    const ce = path.match(/^\/v1\/messages\/(\d+)$/)
    if (ce && req.method === 'PUT') { connector.push({ who, kind: 'edit', id: Number(ce[1]), body }); return Response.json({ api_version: 1, data: { message_id: ce[1], changed: true } }) }
    if (path === '/messages' && req.method === 'POST') {
      if (st.aDelayMs) await sleep(st.aDelayMs)
      if (st.a500[who]) return Response.json({ detail: 'database is down' }, { status: 500 })
      const r = write(who, body, '/messages')
      return r.status ? Response.json({ detail: r.detail }, { status: r.status }) : Response.json(r)
    }
    if (path === '/messages/batch') return Response.json({ results: body.items.map((it: any) => { const r = write(who, it, '/messages/batch'); return r.status ? { error: r.detail, status: r.status } : r }) })
    const dm = path.match(/^\/messages\/(\d+)\/delivery$/)
    if (dm && req.method === 'POST') {
      const m = msgs.find(x => x.id === Number(dm[1]))
      if (!m) return Response.json({ detail: `no message ${dm[1]}` }, { status: 404 })
      if (!m.delivery) return Response.json({ detail: `message ${m.id} was not written for delivery` }, { status: 409 })
      if (!body?.at) return Response.json({ detail: 'at: required' }, { status: 400 })
      if (body.state === m.delivery.state) return Response.json({ id: m.id, state: m.delivery.state, duplicate: true })
      if (m.delivery.state === 'sent') return Response.json({ detail: `message ${m.id} was already delivered` }, { status: 409 })
      for (const n of (body.client_msg_ids ?? []).map(String)) if (!m.aliases.includes(n)) m.aliases.push(n)
      if (body.state === 'sent') m.delivery = { ...m.delivery, state: 'sent', delivered_at: body.at }
      else m.delivery = { state: 'failed', failed_at: body.at, error: body.error }
      return Response.json({ id: m.id, state: body.state, duplicate: false, aliases: m.aliases })
    }
    const am = path.match(/^\/alias\/telegram\/([^/]+)\/([^/]+)\/(\d+)$/)
    if (am) {
      const m = msgs.find(x => x.who === who && x.item.agent === am[1] && String(x.item.chat) === am[2] && x.aliases.includes(am[3]!))
      return m ? Response.json(full(m)) : Response.json({ detail: 'no telegram message' }, { status: 404 })
    }
    const gm = path.match(/^\/messages\/(\d+)$/)
    if (gm) { const m = msgs.find(x => x.id === Number(gm[1])); return m ? Response.json(full(m)) : Response.json({ detail: 'no message' }, { status: 404 }) }
    if (path === '/deliveries/batch' || path === '/status/batch' || path === '/wake/batch' || path === '/threads/events') return Response.json({ results: (body?.items ?? body?.events ?? []).map(() => ({ id: next++, duplicate: false })) })
    if (path === '/events') {
      const eid = next++
      const t = body?.kind === 'edit' ? msgs.find(x => x.who === who && String(x.item.chat) === String(body.chat) && x.aliases.includes(String(body.target_client_msg_id))) : undefined
      const given = t && inbox.find(i => i.who === who && i.dedupe === `pm:${t.id}`)
      if (t && given && body.actor === t.item.sender) put(who, 'person_edit', { message_id: String(t.id), client: given.payload.client, text: body.body ?? '', edited_at: body.at }, `pe:${eid}`)
      return Response.json({ id: eid, duplicate: false })
    }
    if (path === '/inbox' && req.method === 'GET') {
      const after = Number(u.searchParams.get('after') ?? 0), wait = Math.min(1, Number(u.searchParams.get('wait') ?? 0))
      const mine = () => inbox.filter(i => i.who === who)
      const last = mine().length
      if (after > last) return Response.json({ agent: who, items: [], reset: true, continue_after: last, last_seq: last })
      const end = Date.now() + wait * 1000
      let rows = mine().filter(i => i.seq > after)
      while (!rows.length && Date.now() < end) { await sleep(10); rows = mine().filter(i => i.seq > after) }
      return Response.json({ agent: who, last_seq: mine().length, acked_seq: 0, items: rows.map(i => ({ seq: i.seq, sender: i.sender, relay: null, kind: i.kind, payload: i.payload,
        dedupe: i.dedupe, unverified: false, at: new Date(i.at).toISOString(), given: 1 })) })
    }
    if (path === '/inbox/ack' && req.method === 'POST') {
      for (const i of inbox) if (i.who === who && i.seq <= Number(body?.upto ?? 0)) i.acked = true
      return Response.json({ acked: true })
    }
    if (path === '/messages' && req.method === 'GET') return Response.json({ agent: u.searchParams.get('agent'), total: 0, messages: [] })
    return Response.json({ error: 'no route' }, { status: 404 })
  } })
  return {
    port: server.port!, msgs, seen, files, st, inbox, put, connector,
    conv: chat => String(convOf(chat)),
    heard: (who, chat, n, text) => { convOf(chat); const m: Msg = { id: next++, who, item: { chat, agent: 'adam', direction: 'in', sender: `tg:${chat}`, body: text, kind: 'text' }, at: Date.now(),
      path: '/messages', aliases: [String(n)], files: [], delivery: null }; msgs.push(m); return m.id },
    bridgeOn: who => { const b = st.bridge[who] ?? (st.bridge[who] = { on: true, delayMs: 50, next: 900 }); b.on = true; for (const m of msgs) if (m.who === who) draw(m) },
    say: (who, chat, text, attachments = [], reply_to = null) => {
      const id = next++
      return put(who, 'person_message', { message_id: String(id), conversation_id: '1', from: 'joey', via: 'web', text, kind: 'text', sent_at: new Date().toISOString(), attachments,
        client: { name: 'telegram', chat, msg_id: `form-${id}`, user: 'joey', user_id: chat }, reply_to }, `pm:${id}`)
    },
    writes: who => msgs.filter(m => m.who === who),
    reports: (who, id) => seen.filter(s => s.who === who && /^\/messages\/\d+\/delivery$/.test(s.path) && (id == null || s.path === `/messages/${id}/delivery`)),
    stop: () => server.stop(true),
  }
}
