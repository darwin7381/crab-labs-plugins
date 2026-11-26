// A stand-in for Onsen (tests only; WO-192): a local HTTP server with Onsen 0.31.0's answers for what a Telegram daemon calls. Messages written first
// (POST /messages with delivery pending) and the old records (POST /messages/batch, client_msg_id) are kept; POST /messages/<id>/delivery moves a
// message's delivery as Onsen does (sent: its numbers become aliases; the same state again: duplicate; sent → failed: 409); GET /alias/telegram/...
// and GET /messages/<id> answer from them (chat_history's tg:<id>); POST /v1/files keeps the bytes. Each daemon has its own credential (`who`).
export type Who = string
export type Msg = { id: number; who: Who; item: any; at: number; path: '/messages' | '/messages/batch'; aliases: string[]; files: string[]
  delivery: null | { state: 'pending' | 'sent' | 'failed'; delivered_at?: string; failed_at?: string; error?: string } }
export type Seen = { who: Who; method: string; path: string; body: any; headers: Record<string, string>; at: number }
export type OnsenStandin = {
  port: number; msgs: Msg[]; seen: Seen[]; files: Map<string, { id: string; bytes: Uint8Array; at: number }>
  /** per credential: Onsen's version (default 0.31.0), POST /messages answering 500, a delay before A is answered (ms) */
  st: { version: Record<Who, string>; a500: Record<Who, boolean>; aDelayMs: number }
  writes: (who: Who) => Msg[]
  reports: (who: Who, id?: number) => Seen[]
  stop: () => void
}

export function startOnsenStandin(creds: Record<string, Who>, port = 0): OnsenStandin {
  const msgs: Msg[] = [], seen: Seen[] = []
  const files = new Map<string, { id: string; bytes: Uint8Array; at: number }>()
  const st: OnsenStandin['st'] = { version: {}, a500: {}, aDelayMs: 0 }
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
    const body = req.method === 'POST' ? await req.json().catch(() => null) : undefined
    seen.push({ who, method: req.method, path, body, headers, at: Date.now() })
    if (path === '/v1/meta') return Response.json({ api_version: 1, data: { server_version: st.version[who] ?? '0.31.0', commit: 'test', deployed_at: '2026-11-26T10:00:43Z' } })
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
    if (path === '/events') return Response.json({ id: next++, duplicate: false })
    if (path === '/messages' && req.method === 'GET') return Response.json({ agent: u.searchParams.get('agent'), total: 0, messages: [] })
    return Response.json({ error: 'no route' }, { status: 404 })
  } })
  return {
    port: server.port!, msgs, seen, files, st,
    writes: who => msgs.filter(m => m.who === who),
    reports: (who, id) => seen.filter(s => s.who === who && /^\/messages\/\d+\/delivery$/.test(s.path) && (id == null || s.path === `/messages/${id}/delivery`)),
    stop: () => server.stop(true),
  }
}
