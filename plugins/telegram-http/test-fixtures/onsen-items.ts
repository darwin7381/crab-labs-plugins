import type { InboxItem } from '../onsen-items.ts'
import type { ItemReport, Outcome } from '../onsen-receive.ts'

const intermediate = new Set<Outcome | 'deferred'>(['in_session', 'background', 'owed', 'stuck', 'deferred'])
const failures = new Set<Outcome>(['cut', 'cut_person', 'not_taken', 'error', 'stuck'])
type Row = InboxItem & { waiter: string; preview: string; line: string; created_at: string; completed_at: string | null; cancelled_at: string | null;
  about_item_id: string | null; edit_of_item_id: string | null; failures: number; released: boolean; expires_at: string | null; in_session_at: string | null
  response_message_ids: string[]; answered: boolean | null }
const iso = (ms: number) => new Date(ms).toISOString()
const memberName = /^[a-z0-9][a-z0-9_.-]{0,63}$/
const refKinds = new Set('ticket schedule run incident alert op mail call message form telegram item'.split(' '))
const timestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i
function validCreate(b: any): boolean {
  const fields = ['kind', 'session_id', 'body', 'not_before', 'deadline', 'expires_at', 'waiter', 'refs']
  return b && Object.keys(b).every(k => fields.includes(k)) && ['resume', 'self', 'keepwarm'].includes(b.kind)
    && (b.session_id == null || typeof b.session_id === 'string')
    && (b.waiter == null || typeof b.waiter === 'string' && memberName.test(b.waiter))
    && (b.body == null || b.body.format === 'markdown' && typeof b.body.text === 'string' && Object.keys(b.body).length === 2)
    && [b.not_before, b.deadline, b.expires_at].every(t => t == null || typeof t === 'string' && timestamp.test(t) && Number.isFinite(Date.parse(t)))
    && Array.isArray(b.refs) && b.refs.every((r: any) => refKinds.has(r?.kind) && typeof r.value === 'string' && Object.keys(r).length === 2)
}

/** The S2 fields of a row the member wrote through POST /members/<m>/items: its preview and line, and offline when unobserved (settled 41). */
function writtenFields(row: Row, now: number, online: boolean) {
  const preview = String(row.payload.text ?? '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim()
  const stage = ({ waiting: '等著', claimed: '領走', completed: '做完', cancelled: '作廢' } as Record<string, string>)[row.state]
  const why = row.reason && ({ withdrawn: '寄件方撤回', expired: '過了作廢時間', superseded: 'Claude Code 自己接著跑了' } as Record<string, string>)[row.reason]
  const kind = ({ self: '自己留的', keepwarm: '保溫', resume: '接著做' } as Record<string, string>)[row.kind]
  const line = [`收件 #${row.number}`, row.member + '/' + (row.session_id ?? '未定'), kind, row.from + ' → 等的人 ' + row.waiter,
    stage + (why ? '（' + why + '）' : ''), '失敗 ' + row.failures, preview]
  const local = (ms: number) => iso(ms + 8 * 3600_000)
  for (const [label, time] of [['最早', row.not_before], ['該回', row.deadline], ['作廢', row.expires_at], ['領走', row.claim?.taken_at]]) {
    if (!time) continue
    const t = local(Date.parse(time)), year = t.slice(0, 4) === local(now).slice(0, 4) ? 5 : 0
    line.push(label + ' ' + t.slice(year, 16).replace('T', ' ') + ' 台北')
  }
  return { preview, line: line.join('｜'), retry_after: null, offline: !online }
}

/** A disposable member inbox. Server time, ownership, versions and idempotency live on this side of HTTP. */
export function fakeItems() {
  let now = Date.now(), seq = 0, claimSeq = 0, owner = '', seen = 0
  const rows = new Map<string, Row>(), writes = new Map<string, { body: unknown; response: Response }>(), terminal = new Map<string, string>()
  const scheduleCalls = new Map<string, { id: string; run: string; result: unknown }>()
  const creates = new Map<string, { id: string; body: unknown; result: Response }>()
  const takes = new Map<string, { claim: string; body: unknown; result: Response }>()
  // lastClaim: the claim a row's later events and late reports belong to; expired: a lease ran out (true = without a stuck report, settled 55)
  const lastClaim = new Map<string, string>(), expired = new Map<string, boolean>()
  // written: rows the member wrote itself (S2 POST); elsewhere: notices the fake writes into another member's inbox
  const overdue = new Set<string>(), written = new Set<string>(), elsewhere = new Set<string>()
  const givenByPull = new Set<Row>()
  let pullAcked = 0
  const calls: Array<{ path: string; query: URLSearchParams; body: any; key: string | null }> = []
  const issued = new Set<string>(), reports = new Set<string>()
  const history: ItemReport[] = [], waiters = new Set<() => void>()
  let mode = 200, unavailable = false, holdReports = false, delayTake = 0, observedAt = 0
  const error = (status: number, code: string, extra = {}) => Response.json({ error: { code, message: code, retryable: status >= 500, ...extra } }, { status })
  const change = (r: Row, kind: string, note = '', updatedAt?: string) => {
    now++
    r.version++; r.updated_at = updatedAt ?? iso(now); r.events!.push({ at: r.updated_at, kind, claim_id: r.claim?.id ?? lastClaim.get(r.id) ?? null, session_id: r.session_id, state: r.state, reason: r.reason, note: note || null })
    for (const wake of waiters) wake()
  }
  const expire = () => {
    for (const row of rows.values()) {
      if (row.state === 'claimed' && Date.parse(row.claim!.expires_at) <= now) {
        expired.set(row.id, !reports.has(row.id + '/' + row.claim!.id + '/stuck'))
        Object.assign(row, { claim: null, state: 'waiting', reason: 'cut' }); change(row, 'lease_expired')
      }
      if (row.state === 'waiting' && Date.parse(row.expires_at ?? '') <= now) {
        Object.assign(row, { state: 'cancelled', reason: 'expired', cancelled_at: iso(now) }); change(row, 'expired')
      }
    }
  }
  const add = (id: string, kind = 'message', extra: Partial<Row> = {}): Row => {
    const number = ++seq
    const payload = kind === 'message' ? { message_id: 'm' + number, conversation_id: 'conv', kind: 'text', from: 'joey',
      via: 'telegram', text: id, client: { name: 'telegram', chat: '1', msg_id: String(number), user_id: '1', user: 'Joey' }, sent_at: iso(now) } : { text: id }
    const row: Row = { id, number, member: 'adam', from: 'joey', session_id: kind === 'message' || extra.message_id ? 'main' : null, note: null, kind, refs: [], state: 'waiting', reason: null,
      waiter: extra.from ?? 'joey', relay: null, preview: String(extra.payload?.text ?? payload.text), line: id,
      created_at: iso(now), completed_at: null, cancelled_at: null, about_item_id: null, edit_of_item_id: null,
      half_done: false, not_before: null, deadline: null, expires_at: null, failures: 0, released: false, version: 0, events: [], claim: null,
      message_id: kind === 'message' ? 'm' + number : null, action_id: null, call_id: null, mail_id: null,
      answered: null, response_message_ids: [], in_session_at: null, updated_at: iso(now), payload, ...extra }
    rows.set(id, row); change(row, 'created', '', extra.updated_at)
    return row
  }
  const eligible = (r?: Row) => !!r && r.state === 'waiting' && !(Date.parse(r.not_before ?? '') > now) && !(r.reason === 'parked' && !r.released)
  /** Details carry the history; a list or a take gives the Item without it. */
  const view = (row: Row, history = true) => {
    const { offline, ...s2 } = written.has(row.id) ? writtenFields(row, now, now - observedAt < 45_000) : { offline: false }
    let why = null
    if (row.state === 'waiting') {
      if (Date.parse(row.not_before ?? '') > now) why = 'not_before'
      else if (row.reason === 'parked' && !row.released) why = 'parked'
      else if (row.reason === 'cut_person') why = 'rides_next'
      else if (offline) why = 'offline'
    }
    const { events, ...item } = { ...row, ...s2 }
    return { ...item, takeable: { now: row.state === 'waiting' && !why, why }, ...(history ? { events } : {}) }
  }
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 60, async fetch(req) {
    const url = new URL(req.url), path = url.pathname, q = url.searchParams
    const b = req.method === 'GET' ? {} : await req.json().catch(() => null) as any, key = req.headers.get('Idempotency-Key')
    const connector = b?.connector ?? q.get('connector')
    const envelope = () => ({ api_version: '1', as_of: iso(now), viewer: 'adam', read_by: null,
      ...(connector ? { changed_after: iso(now - 1000).replace('Z', '+00:00') } : {}) })
    const detail = (data: unknown, status = 200) => Response.json({ ...envelope(), data }, { status })
    calls.push({ path, query: q, body: b, key })
    if (req.headers.get('authorization') !== 'Bearer test-member') return error(401, 'not_authenticated')
    if (!b || typeof b !== 'object' || Array.isArray(b)) return error(400, 'invalid_request')
    if (unavailable || holdReports && path.endsWith('/report')) return error(503, 'service_unavailable')
    expire()
    // Existing resources used by the real tg daemon alongside the Item API.
    if (path === '/v1/calls' && req.method === 'GET' && q.get('ref_kind') === 'run')
      return Response.json({ items: [...scheduleCalls.values()].filter(c => c.run === q.get('ref_value')) })
    const callId = /^\/v1\/calls\/([^/]+)\/state$/.exec(path)?.[1]
    if (callId && req.method === 'PUT') {
      const call = scheduleCalls.get(callId)
      if (!call) return error(404, 'not_found')
      if (Object.keys(b).length !== 1 || !b.result) return error(400, 'invalid_request')
      call.result = b.result
      return detail(call)
    }
    if (path.endsWith('/batch')) return Response.json({ results: (b.items ?? []).map(() => ({ id: ++seq })) })
    if (path === '/v1/conversations/by-chat/1') return detail({ id: 'conv', members: ['joey', 'adam'] })
    if (path === '/v1/conversations/by-chat/6736970916') return detail({ id: 'test-account-dm', participants: ['joey-test', 'adam'] })
    const quoted = /^\/v1\/conversations\/([^/]+)\/messages\/by-client-id\/(.+)$/.exec(path)
    if (quoted) {
      const match = [...rows.values()].find(r => r.payload.conversation_id === quoted[1] && r.payload.client?.msg_id === decodeURIComponent(quoted[2]!))
      return match ? detail({ id: match.message_id }) : error(404, 'not_found')
    }
    if (path === '/v1/messages' && req.method === 'POST') return detail({ id: String(++seq), delivery: 'sent' })
    if (path.endsWith('/observation') && b.connector === undefined) return detail({ name: 'adam', kind: 'agent' })
    if (path.endsWith('/commands')) return detail({ name: 'adam', kind: 'agent' })
    if (path === '/inbox' && req.method === 'GET') {
      if (mode === 200) return Response.json({ detail: { code: 'take_member' } }, { status: 409 })
      const after = Number(q.get('after'))
      const given = [...rows.values()].filter(r => r.state === 'waiting' && r.number > after).slice(0, Number(q.get('limit') ?? 100))
      for (const row of given) givenByPull.add(row)
      return Response.json({ items: given.map(r => ({ seq: r.number, sender: r.from, kind: r.kind, payload: r.payload })),
        last_seq: seq, acked_seq: pullAcked })
    }
    if (path === '/inbox/ack' && req.method === 'POST') {
      for (const row of givenByPull) {
        if (row.number > b.upto) continue
        row.state = 'completed'; change(row, 'acked'); givenByPull.delete(row)
      }
      pullAcked = Math.max(pullAcked, b.upto)
      return Response.json({ acked: 1 })
    }
    const base = '/v1/members/adam/items'
    if (req.method === 'POST' && /^\/v1\/members\/[^/]+\/items$/.test(path)) {
      if (path !== base) return error(403, 'not_authorized')
      if (!key || !validCreate(b)) return error(400, 'invalid_request')
      const old = creates.get(key)
      if (old && rows.has(old.id)) return Bun.deepEquals(old.body, b) ? old.result.clone() : error(409, 'version_conflict')
      const id = crypto.randomUUID()
      written.add(id)
      const row = add(id, b.kind, { from: 'adam', waiter: b.waiter ?? 'adam', session_id: b.session_id ?? null,
        refs: b.refs, not_before: b.not_before ?? null, deadline: b.deadline ?? null, expires_at: b.expires_at ?? null,
        payload: b.body ? { text: b.body.text, format: b.body.format } : { text: '' } })
      const result = detail(view(row), 201)
      creates.set(key, { id: row.id, body: b, result: result.clone() })
      return result
    }
    if (req.method === 'DELETE' && /^\/v1\/items\/[^/]+$/.test(path)) {
      const row = rows.get(decodeURIComponent(path.slice('/v1/items/'.length)))
      if (!row) return error(404, 'not_found')
      if (row.from !== 'adam') return error(403, 'not_authorized')
      if (!b || Object.keys(b).some(k => k !== 'outcome' && k !== 'expected_version')) return error(400, 'invalid_request')
      const outcome = b.outcome === undefined ? 'withdrawn' : b.outcome
      if (!Number.isInteger(b.expected_version) || !['withdrawn', 'superseded', 'completed'].includes(outcome)
        || outcome === 'completed' && row.kind !== 'self' || outcome === 'superseded' && row.kind !== 'resume') return error(400, 'invalid_request')
      if (row.version !== b.expected_version || row.state !== 'waiting') return error(409, 'version_conflict')
      if (outcome === 'completed') Object.assign(row, { state: 'completed', completed_at: iso(now), reason: null })
      else Object.assign(row, { state: 'cancelled', cancelled_at: iso(now), reason: outcome })
      change(row, outcome)
      return detail(view(row))
    }
    if (connector && path.startsWith(base) && mode !== 200) return error(mode, mode === 409 ? 'not_take_member' : mode === 400 ? 'invalid_request' : 'not_found')
    if (connector) {
      if (owner && owner !== connector && now < seen + 45_000) return error(409, 'not_current_connector', { current: owner })
      owner = connector; seen = now
    }
    if (path === base && req.method === 'GET') {
      const after = q.get('changed_after')
      const since = after === null ? -Infinity : Date.parse(after)
      const select = () => [...rows.values()].filter(r => !elsewhere.has(r.id) && (q.get('state') === 'all' || r.state === (q.get('state') ?? 'waiting'))
        && ['kind', 'reason', 'session_id'].every(k => !q.has(k) || r[k as keyof Row] === q.get(k)) && Date.parse(r.updated_at) >= since)
      const wait = Number(q.get('wait'))
      const until = Date.now() + wait * 1000
      while (!select().length && Date.now() < until && !req.signal.aborted) await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); waiters.delete(wake); req.signal.removeEventListener('abort', wake); resolve() }
        const timer = setTimeout(wake, until - Date.now())
        waiters.add(wake); req.signal.addEventListener('abort', wake, { once: true })
      })
      const all = select(), start = Number(q.get('cursor')), end = start + Number(q.get('limit') ?? 50)
      return Response.json({ ...envelope(), items: all.slice(start, end).map(r => view(r, false)),
        next_cursor: end < all.length ? String(end) : null })
    }
    if (req.method !== 'GET' && !key) return error(400, 'invalid_request')
    const idem = req.method + '|' + path + '|' + key
    const cached = key && writes.get(idem)
    if (cached) return Bun.deepEquals(b, cached.body) ? cached.response.clone() : error(409, 'version_conflict')
    let answer: Response
    if (path === base + '/take' && req.method === 'POST') {
      if (!b.connector || b.wait !== 0 || !Array.isArray(b.item_ids) || b.limit !== b.item_ids.length || b.limit > 100 || b.session_id !== undefined) return error(400, 'invalid_request')
      // Ruling 14: a take's key lives as long as the claim it created.
      const prior = takes.get(idem)
      if (prior && [...rows.values()].some(r => r.claim?.id === prior.claim)) {
        return Bun.deepEquals(prior.body, b) ? prior.result.clone() : error(409, 'version_conflict')
      }
      takes.delete(idem)
      const asked: Row[] = b.item_ids.map((id: string) => rows.get(id)).filter(eligible).filter((r: Row) => !elsewhere.has(r.id))
      const given = asked.filter(r => {
        if (r.reason === 'cut_person' && !asked.some(o => o !== r && o.from === r.from && o.kind === 'message' && o.reason !== 'cut_person')) return false
        const missed = expired.get(r.id)
        expired.delete(r.id)
        if (missed && ++r.failures >= 3) {
          Object.assign(r, r.released ? { state: 'cancelled', reason: 'gave_up', cancelled_at: iso(now) } : { reason: 'parked' })
          change(r, r.reason!); return false
        }
        return true
      })
      const claim_id = given.length ? 'claim-' + ++claimSeq : null
      for (const row of given) {
        Object.assign(row, { state: 'claimed', reason: null, note: null, in_session_at: null, claim: { id: claim_id, connector, session_id: null, taken_at: iso(now), expires_at: iso(now + 45_000) } })
        issued.add(row.id + '/' + claim_id)
        lastClaim.set(row.id, claim_id!)
        change(row, 'taken')
      }
      const waiting = [...rows.values()].filter(r => !elsewhere.has(r.id) && r.state === 'waiting')
      answer = detail({ claim_id, items: given.map(r => view(r, false)), waiting: waiting.length, next_not_before: waiting.map(r => r.not_before).filter(Boolean).sort()[0] ?? null })
      if (claim_id) takes.set(idem, { claim: claim_id, body: b, result: answer.clone() })
      if (delayTake) await Bun.sleep(delayTake)
      return answer
    } else if (path === '/v1/members/adam/observation' && req.method === 'PUT') {
      if (!Array.isArray(b.held_item_ids)) return error(400, 'invalid_request')
      observedAt = now
      for (const id of b.held_item_ids) { const r = rows.get(id); if (r?.claim?.connector === connector) r.claim.expires_at = iso(now + 45_000) }
      answer = detail({ name: 'adam', kind: 'agent' })
    } else {
      const row = rows.get(decodeURIComponent(path.split('/')[3] ?? ''))
      if (!row) return error(404, 'not_found')
      if (req.method === 'GET') return detail(view(row))
      if (req.method !== 'PUT' || !path.endsWith('/report') || !b.claim_id || !b.at || 'answered' in b) return error(400, 'invalid_request')
      if (b.outcome === 'superseded' && row.kind !== 'resume') return error(400, 'invalid_request')
      const k = row.id + '/' + b.claim_id, prior = terminal.get(k)
      if (prior) return prior === b.outcome ? detail(view(row)) : error(409, 'version_conflict')
      if (!issued.has(k)) return error(400, 'invalid_request')
      if (reports.has(k + '/' + b.outcome)) return detail(view(row))
      reports.add(k + '/' + b.outcome)
      history.push({ item_id: row.id, body: b })
      if (['cancelled', 'completed'].includes(row.state) || lastClaim.get(row.id) !== b.claim_id && b.outcome !== 'completed'
        || expired.has(row.id) && intermediate.has(b.outcome)) { change(row, 'late_report', b.note); return detail(view(row)) }
      if (b.outcome === 'in_session' && row.claim) { row.claim.session_id = b.session_id; row.session_id ??= b.session_id; row.in_session_at = b.at }
      if (typeof b.half_done === 'boolean') row.half_done = b.half_done
      if (b.outcome === 'error') row.not_before = iso(now + (row.failures + 1) * 300_000)
      if (failures.has(b.outcome) && !(b.outcome === 'cut' && row.reason === 'stuck')) row.failures++
      if (intermediate.has(b.outcome)) row.reason = b.outcome === 'in_session' ? null : b.outcome
      else {
        terminal.set(k, b.outcome); row.claim = null
        expired.delete(row.id)
        if (b.outcome === 'completed') {
          row.state = 'completed'; row.completed_at = b.at; row.response_message_ids = b.response_message_ids ?? []
          row.answered = ['resume', 'self', 'keepwarm'].includes(row.kind) ? null : row.response_message_ids.length > 0
          row.reason = row.reason === 'owed' && !row.answered ? 'not_answered' : null
          for (const p of rows.values()) if (p.reason === 'parked' && !p.released) { p.reason = null; p.released = true; change(p, 'released') }
        } else if (['stopped', 'not_applied', 'superseded'].includes(b.outcome)) { row.state = 'cancelled'; row.reason = b.outcome; row.cancelled_at = b.at }
        else { row.state = 'waiting'; row.reason = b.outcome; if (b.outcome === 'reassigned') Object.assign(row, { session_id: 'main', note: b.note }) }
      }
      if (failures.has(b.outcome) && row.failures >= 3) {
        row.state = row.released ? 'cancelled' : 'waiting'; row.reason = row.released ? 'gave_up' : 'parked'; row.claim = null
        if (row.state === 'cancelled') row.cancelled_at ??= iso(now)
      }
      change(row, b.outcome, b.note); answer = detail(view(row))
    }
    if (key) writes.set(idem, { body: b, response: answer.clone() })
    return answer
  } })
  return { base: 'http://127.0.0.1:' + server.port, rows, calls, scheduleCalls, history, add, change, now: () => now,
    advance(ms: number) {
      now += ms; expire()
      // The S4 promise_due notice to the waiter of a self row whose deadline passed while it was still open.
      for (const row of rows.values()) {
        if (row.kind !== 'self' || !row.deadline || Date.parse(row.deadline) >= now || overdue.has(row.id)
          || (row.state !== 'waiting' && row.state !== 'claimed')) continue
        overdue.add(row.id)
        const id = crypto.randomUUID(), member = row.waiter ?? row.from
        if (member !== 'adam') elsewhere.add(id)
        add(id, 'notice', { member, from: 'system', about_item_id: row.id, reason: 'promise_due' })
      }
    }, mode(status: number) { mode = status }, down(on: boolean) { unavailable = on },
    holdReports(on: boolean) { holdReports = on }, delayTake(ms: number) { delayTake = ms }, stop() { for (const wake of waiters) wake(); return server.stop(true) } }
}
