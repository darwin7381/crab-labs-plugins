import type { InboxItem } from '../onsen-items.ts'
import type { ItemReport, Outcome } from '../onsen-receive.ts'

const intermediate = new Set<Outcome>(['in_session', 'background', 'owed', 'stuck'])
const failures = new Set<Outcome>(['cut', 'cut_person', 'not_taken', 'error', 'stuck'])
type Row = InboxItem & { failures: number; released: boolean; expires_at: string | null; in_session_at: string | null
  response_message_ids: string[]; answered: boolean | null }
const iso = (ms: number) => new Date(ms).toISOString()

/** A disposable member inbox. Server time, ownership, versions and idempotency live on this side of HTTP. */
export function fakeItems(member = 'adam', token = 'test-member', extra?: (req: Request) => Promise<Response | null>, realtime = false) {
  let now = Date.now(), seq = 0, claimSeq = 0, owner = '', seen = 0
  const tick = () => { if (realtime) now = Math.max(now, Date.now()) }
  const rows = new Map<string, Row>(), writes = new Map<string, Response>(), terminal = new Map<string, string>()
  const calls: Array<{ path: string; query: URLSearchParams; body: any; key: string | null }> = []
  const issued = new Set<string>(), reports = new Set<string>()
  const history: ItemReport[] = [], waiters = new Set<() => void>()
  const scheduleCalls = new Map<string, { id: string; run: string; result: any }>()
  let mode = 200, unavailable = false, holdReports = false, delayTake = 0
  const detail = (data: unknown, status = 200) => Response.json({ api_version: '1', as_of: iso(now), viewer: member, read_by: null, data }, { status })
  const error = (status: number, code: string, extra = {}) => Response.json({ error: { code, message: code, retryable: status >= 500, ...extra } }, { status })
  const change = (r: Row, kind: string, note = '', updatedAt?: string) => {
    now++
    r.version++; r.updated_at = updatedAt ?? iso(now); r.events!.push({ kind, note, at: iso(now), session_id: r.session_id })
    for (const wake of waiters) wake()
  }
  const expire = () => {
    for (const row of rows.values()) {
      if (row.state === 'claimed' && Date.parse(row.claim!.expires_at) <= now) {
        Object.assign(row, { claim: null, state: 'waiting', reason: 'cut' }); change(row, 'lease_expired')
      }
      if (row.state === 'waiting' && Date.parse(row.expires_at ?? '') <= now) {
        Object.assign(row, { state: 'cancelled', reason: 'expired' }); change(row, 'expired')
      }
    }
  }
  const add = (id: string, kind = 'message', extra: Partial<Row> = {}): Row => {
    tick()
    const number = ++seq
    const payload = kind === 'message' ? { message_id: 'm' + number, conversation_id: 'conv', kind: 'text', from: 'joey',
      via: 'telegram', text: id, client: { name: 'telegram', chat: '1', msg_id: String(number), user_id: '1', user: 'Joey' }, sent_at: iso(now) } : { text: id }
    const row: Row = { id, number, member: member, from: 'joey', session_id: null, kind, refs: [], state: 'waiting', reason: null,
      half_done: false, not_before: null, deadline: null, expires_at: null, failures: 0, released: false, version: 0, events: [], claim: null,
      message_id: kind === 'message' ? 'm' + number : null, action_id: null, call_id: null, mail_id: null,
      answered: null, response_message_ids: [], in_session_at: null, created_at: iso(now), updated_at: iso(now), payload, ...extra }
    rows.set(id, row); change(row, 'created', '', extra.updated_at)
    return row
  }
  const eligible = (r?: Row) => !!r && r.state === 'waiting' && !(Date.parse(r.not_before ?? '') > now) && !(r.reason === 'parked' && !r.released)
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 60, async fetch(req) {
    tick()
    const url = new URL(req.url), path = url.pathname, q = url.searchParams
    if (req.headers.get('authorization') !== 'Bearer ' + token) return error(401, 'not_authenticated')
    if (extra) {
      const response = await extra(req)
      if (response) return response
    }
    const b = req.method === 'GET' ? {} : await req.json() as any, key = req.headers.get('Idempotency-Key')
    calls.push({ path, query: q, body: b, key })
    if (unavailable || holdReports && path.endsWith('/report')) return error(503, 'service_unavailable')
    expire()
    // Existing resources used by the real tg daemon alongside the Item API.
    if (path === '/v1/calls' && req.method === 'GET') return Response.json({ items: [...scheduleCalls.values()].filter(c => c.run === q.get('ref_value')) })
    if (path.startsWith('/v1/calls/') && path.endsWith('/state') && req.method === 'PUT') {
      const call = scheduleCalls.get(path.split('/')[3]!)
      if (!call) return error(404, 'not_found')
      if (!b.result || Object.keys(b).length !== 1 || Object.keys(b.result).some(k => !['outcome', 'body', 'preview', 'attachment_file_ids'].includes(k))) return error(400, 'invalid_request')
      call.result = b.result; return detail(call)
    }
    if (path.endsWith('/batch')) return Response.json({ results: (b.items ?? []).map(() => ({ id: ++seq })) })
    if (path === '/v1/conversations/by-chat/1') return detail({ id: 'conv', members: ['joey', member] })
    if (path === '/v1/messages' && req.method === 'POST') return detail({ id: String(++seq), delivery: 'sent' })
    if (path.endsWith('/observation') && b.connector === undefined) return detail({ name: member, kind: 'agent' })
    if (path.endsWith('/commands')) return detail({ name: member, kind: 'agent' })
    const base = '/v1/members/' + member + '/items'
    const connector = b.connector ?? q.get('connector')
    if (connector && (path.startsWith(base) || path.endsWith('/observation')) && mode !== 200) return error(mode, mode === 409 ? 'not_take_member' : mode === 400 ? 'invalid_request' : 'not_found')
    if (connector) {
      if (owner && owner !== connector && now < seen + 45_000) return error(409, 'not_current_connector', { current: owner })
      owner = connector; seen = now
    }
    if (path === base && req.method === 'GET') {
      const after = q.get('changed_after')
      const since = after === null ? -Infinity : Date.parse(after)
      const select = () => [...rows.values()].filter(r => r.state === (q.get('state') ?? 'waiting') && Date.parse(r.updated_at) >= since)
      const wait = Number(q.get('wait'))
      const until = Date.now() + wait * 1000
      while (!select().length && Date.now() < until && !req.signal.aborted) await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); waiters.delete(wake); req.signal.removeEventListener('abort', wake); resolve() }
        const timer = setTimeout(wake, until - Date.now())
        waiters.add(wake); req.signal.addEventListener('abort', wake, { once: true })
      })
      const all = select(), start = Number(q.get('cursor')), end = start + Number(q.get('limit') ?? 50)
      return Response.json({ api_version: '1', as_of: iso(now), viewer: member, read_by: null, items: all.slice(start, end),
        next_cursor: end < all.length ? String(end) : null,
        ...(connector ? { changed_after: iso(now - 1000).replace('Z', '+00:00') } : {}) })
    }
    if (req.method !== 'GET' && !key) return error(400, 'invalid_request')
    const idem = path + '|' + key
    if (key && writes.has(idem)) return writes.get(idem)!.clone()
    let answer: Response
    if (path === base && req.method === 'POST') {
      if ('note' in b || b.kind !== 'self' || b.body?.format !== 'markdown' || typeof b.body.text !== 'string' || !Array.isArray(b.refs)) return error(400, 'invalid_request')
      answer = detail(add(crypto.randomUUID(), 'self', { from: member, refs: b.refs, payload: { ...b.body } }), 201)
    } else if (path === base + '/take' && req.method === 'POST') {
      if (!b.connector || b.wait !== 0 || !Array.isArray(b.item_ids) || b.limit !== b.item_ids.length || b.limit > 100 || b.session_id !== undefined) return error(400, 'invalid_request')
      const asked: Row[] = b.item_ids.map((id: string) => rows.get(id)).filter(eligible)
      const given = asked.filter(r => r.reason !== 'cut_person' || asked.some(o => o !== r && o.from === r.from && o.kind === 'message' && o.reason !== 'cut_person'))
      const claim_id = given.length ? 'claim-' + ++claimSeq : null
      for (const row of given) {
        Object.assign(row, { state: 'claimed', reason: null, in_session_at: null, claim: { id: claim_id, connector, session_id: null, taken_at: iso(now), expires_at: iso(now + 45_000) } })
        issued.add(row.id + '/' + claim_id)
        change(row, 'taken')
      }
      const waiting = [...rows.values()].filter(r => r.state === 'waiting')
      answer = detail({ claim_id, items: given, waiting: waiting.length, next_not_before: waiting.map(r => r.not_before).filter(Boolean).sort()[0] ?? null })
    } else if (path === '/v1/members/' + member + '/observation' && req.method === 'PUT') {
      if (!Array.isArray(b.held_item_ids)) return error(400, 'invalid_request')
      for (const id of b.held_item_ids) { const r = rows.get(id); if (r?.claim?.connector === connector) r.claim.expires_at = iso(now + 45_000) }
      answer = detail({ name: member, kind: 'agent' })
    } else {
      const row = rows.get(decodeURIComponent(path.split('/')[3] ?? ''))
      if (!row) return error(404, 'not_found')
      if (req.method === 'GET') return detail(row)
      if (req.method !== 'PUT' || !path.endsWith('/report') || !b.claim_id || !b.at || 'answered' in b) return error(400, 'invalid_request')
      const k = row.id + '/' + b.claim_id, prior = terminal.get(k)
      if (prior) return prior === b.outcome ? detail(row) : error(409, 'version_conflict')
      if (!issued.has(k)) return error(400, 'invalid_request')
      if (reports.has(k + '/' + b.outcome)) return detail(row)
      reports.add(k + '/' + b.outcome)
      history.push({ item_id: row.id, body: b })
      if (row.claim && row.claim.id !== b.claim_id && b.outcome !== 'completed') { change(row, 'late_report', b.note); return detail(row) }
      if (b.outcome === 'in_session' && row.claim) { row.claim.session_id = b.session_id; row.session_id = b.session_id; row.in_session_at = b.at }
      if (typeof b.half_done === 'boolean') row.half_done = b.half_done
      if (b.outcome === 'error') row.not_before = iso(now + (row.failures + 1) * 300_000)
      if (failures.has(b.outcome) && !(b.outcome === 'cut' && row.reason === 'stuck')) row.failures++
      if (intermediate.has(b.outcome)) row.reason = b.outcome === 'in_session' ? null : b.outcome
      else {
        terminal.set(k, b.outcome); row.claim = null
        if (b.outcome === 'completed') {
          row.state = 'completed'; row.response_message_ids = b.response_message_ids ?? []; row.answered = row.response_message_ids.length > 0
          row.reason = row.reason === 'owed' && !row.answered ? 'not_answered' : null
          for (const p of rows.values()) if (p.reason === 'parked' && !p.released) { p.reason = null; p.released = true; change(p, 'released') }
        } else if (['stopped', 'not_applied'].includes(b.outcome)) { row.state = 'cancelled'; row.reason = b.outcome }
        else { row.state = 'waiting'; row.reason = b.outcome; if (b.outcome === 'reassigned') row.session_id = 'main' }
      }
      if (failures.has(b.outcome) && row.failures >= 3) {
        row.state = row.released ? 'cancelled' : 'waiting'; row.reason = row.released ? 'gave_up' : 'parked'; row.claim = null
      }
      change(row, b.outcome, b.note); answer = detail(row)
    }
    writes.set(idem, answer.clone())
    if (delayTake && path === base + '/take') await Bun.sleep(delayTake)
    return answer
  } })
  return { base: 'http://127.0.0.1:' + server.port, rows, calls, scheduleCalls, history, add, change, polling: () => waiters.size, now: () => now,
    advance(ms: number) { now += ms; expire() }, mode(status: number) { mode = status }, down(on: boolean) { unavailable = on },
    holdReports(on: boolean) { holdReports = on }, delayTake(ms: number) { delayTake = ms }, stop() { for (const wake of waiters) wake(); return server.stop(true) } }
}
