// WO-176 (daemon side): onsen-client.ts OnsenActions against a stand-in request function: the bodies Onsen's /v1/actions takes (fleet-core
// onsen_actions.py CREATE_FIELDS, RESOLVE_FIELDS, APPLIED_FIELDS, CANCEL_FIELDS: nothing else is sent), one Action's calls in order behind its create,
// a press in Telegram (resolve then applied; 409: applied with what was pressed), cancel (a version that moved: read once, tried again), retries on a
// transport failure / 5xx / 429 only, never a throw, the stop switch; and the helpers (control payload, members, ONSEN_ACTIONS).
import { describe, expect, test } from 'bun:test'
import { OnsenActions, actionControlOf, actionsOn, assigneesOf, memberOfTg, type ActionReq } from './onsen-client.ts'
import { composeRecord, regions, type ScreenVerdict } from './screen-status.ts'
import { checkObservation } from './test-fixtures/status-v1-check.ts'

type Call = { method: string; path: string; body: any; headers?: Record<string, string>; at: number }
const CREATE = new Set(['kind', 'source', 'requested_by', 'session_id', 'assignees', 'summary', 'body', 'options', 'expires_at', 'refs', 'menu_kind', 'state',
  'selected_option_id', 'resolved_by', 'note', 'opened_at', 'resolved_at'])
const RESOLVE = new Set(['option_id', 'expected_version', 'note', 'resolved_by', 'session_id', 'at']), APPLIED = new Set(['at', 'option_id', 'resolved_by']), CANCEL = new Set(['expected_version', 'reason'])
const tick = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 1)) }

/** a stand-in Onsen: one Action store, the fields each route takes (anything else: 400, as body_json) */
function standIn(o: { fail?: (c: Call, n: number) => 'throw' | 503 | 429 | null; delayMs?: number } = {}) {
  const calls: Call[] = []
  const acts = new Map<string, any>()
  let next = 0, n = 0
  const req: ActionReq = async (method, path, body, _t, headers) => {
    const c: Call = { method, path, body, headers, at: Date.now() }
    calls.push(c)
    n++
    if (o.delayMs) await new Promise(r => setTimeout(r, o.delayMs))
    const f = o.fail?.(c, n)
    if (f === 'throw') throw new Error('connect ECONNREFUSED')
    if (f) return { status: f, json: { error: { code: 'service_unavailable', message: 'x' } } }
    // Onsen 0.24.3's fields (create also opened_at / resolved_at, resolve also at); any other field: 400 as body_json gives it
    const allowed = path === '/v1/actions' ? (body?.action_id != null ? new Set(['action_id', 'assignees', 'requested_by']) : CREATE) : path.endsWith('/resolve') ? RESOLVE : path.endsWith('/applied') ? APPLIED : path.endsWith('/cancel') ? CANCEL : null
    const bad = method === 'POST' && allowed ? Object.keys(body ?? {}).filter(k => !allowed.has(k)) : []
    if (bad.length) return { status: 400, json: { error: { code: 'invalid_request', message: `不收的欄位：${bad.join('、')}；收：${[...allowed!].join('、')}` } } }
    if (method === 'POST' && path === '/v1/actions' && body?.action_id != null) {   // Onsen 0.24.0 join
      const a = acts.get(String(body.action_id))
      if (!a) return { status: 404, json: { error: { code: 'not_found', message: 'no' } } }
      if (a.state !== 'open') return { status: 409, json: { error: { code: 'version_conflict', message: 'not open' } } }
      const add = (body.assignees ?? []).filter((x: string) => !a.assignees.includes(x))
      if (add.length) Object.assign(a, { assignees: [...a.assignees, ...add], version: a.version + 1 })
      return { status: 200, json: { data: a } }
    }
    if (method === 'GET' && path.startsWith('/v1/actions?')) {
      const q = new URLSearchParams(path.split('?')[1])
      return { status: 200, json: { items: [...acts.values()].filter(a => (!q.get('state') || a.state === q.get('state')) && (!q.get('requested_by') || (a.requested_by ?? 'adam') === q.get('requested_by'))), next_cursor: null } }
    }
    if (method === 'POST' && path === '/v1/actions') {
      const id = String(++next)
      const a = { id, version: 1, state: body.state ?? 'open', applied_at: body.state === 'resolved' ? new Date().toISOString() : null, selected_option_id: body.selected_option_id ?? null,
        resolved_by: body.resolved_by ?? null, ...body }
      acts.set(id, a)
      return { status: 201, json: { data: a } }
    }
    const m = /^\/v1\/actions\/(\d+)(?:\/(\w+))?$/.exec(path)
    const a = m ? acts.get(m[1]!) : null
    if (!a) return { status: 404, json: { error: { code: 'not_found', message: 'no' } } }
    if (method === 'GET') return { status: 200, json: { data: a } }
    const conflict = (msg: string) => ({ status: 409, json: { error: { code: 'version_conflict', message: msg } } })
    if (m![2] === 'resolve') {
      if (a.state !== 'open') return conflict('already')
      if (body.expected_version !== a.version) return conflict('version')
      Object.assign(a, { state: 'resolved', selected_option_id: body.option_id, resolved_by: body.resolved_by, version: a.version + 1 })
      return { status: 200, json: { data: a } }
    }
    if (m![2] === 'applied') {
      if (a.state !== 'resolved') return conflict('not resolved')
      if (!a.applied_at) Object.assign(a, { applied_at: body.at ?? new Date().toISOString(), version: a.version + 1, ...(body.option_id ? { selected_option_id: body.option_id, resolved_by: body.resolved_by } : {}) })
      return { status: 200, json: { data: a } }
    }
    if (m![2] === 'cancel') {
      if (!(a.state === 'open' || (a.state === 'resolved' && !a.applied_at))) return conflict('over')
      if (body.expected_version !== a.version) return conflict('version')
      Object.assign(a, { state: 'cancelled', version: a.version + 1 })
      return { status: 200, json: { data: a } }
    }
    return { status: 404, json: {} }
  }
  return { req, calls, acts }
}
const perm = { source: 'permission' as const, menu_kind: 'permission', session_id: 'main', assignees: ['joey'], summary: 'Bash：git push origin main',
  body: '**Bash** `git push`', options: [{ id: 'allow', label: '允許' }, { id: 'deny', label: '拒絕' }] }
const logs: string[] = []
const log = (_l: string, m: string) => { logs.push(m) }

describe('OnsenActions', () => {
  test('create: only the fields Onsen takes, the Idempotency-Key, the handle follows id / version / state', async () => {
    const s = standIn()
    const a = new OnsenActions({ req: s.req, log, retryMs: [5, 5] })
    let made = ''
    const h = a.open(perm, 'perm:adam:abcde:1', x => { made = x.id! })!
    expect(h.id).toBeNull()                                          // returns at once
    await h.tail
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]).toMatchObject({ method: 'POST', path: '/v1/actions', headers: { 'Idempotency-Key': 'perm:adam:abcde:1' } })
    expect(s.calls[0]!.body).toEqual({ source: 'permission', menu_kind: 'permission', session_id: 'main', assignees: ['joey'], summary: 'Bash：git push origin main',
      body: { format: 'markdown', text: '**Bash** `git push`' }, options: [{ id: 'allow', label: '允許' }, { id: 'deny', label: '拒絕' }] })
    expect([h.id, h.version, h.state, made]).toEqual(['1', 1, 'open', '1'])
    expect(a.find('perm:adam:abcde:1')).toBe(h)
    expect(a.find(null, '1')).toBe(h)
  })

  test('the duty officer\'s own press is made resolved; summary and labels cut to one line', async () => {
    const s = standIn()
    const a = new OnsenActions({ req: s.req, log })
    const h = a.open({ source: 'menu', menu_kind: 'model_picker', session_id: null, assignees: ['duty-officer'], summary: '模型\n選單 ' + 'x'.repeat(300), body: null,
      options: [{ id: '1', label: 'Opus\n5.5' }, { id: '2', label: 'Sonnet' }], resolved: { option_id: '1', by: 'duty-officer' } }, 'menu:k')!
    await h.tail
    const b = s.calls[0]!.body
    expect(b).toMatchObject({ state: 'resolved', selected_option_id: '1', resolved_by: 'duty-officer', menu_kind: 'model_picker', options: [{ id: '1', label: 'Opus 5.5' }, { id: '2', label: 'Sonnet' }] })
    expect(b.summary.length).toBe(200)
    expect(b.summary.includes('\n')).toBe(false)
    expect('session_id' in b || 'body' in b).toBe(false)              // null: not sent
    expect(h.state).toBe('resolved')
  })

  test('pressed in Telegram: resolve (the presser, an assignee), then applied; the calls wait for the create', async () => {
    const s = standIn({ delayMs: 20 })
    const a = new OnsenActions({ req: s.req, log })
    const h = a.open({ ...perm, assignees: ['joey', 'joey-test'] }, 'k1')!
    a.pressedElsewhere(h, 'allow', 'joey-test', '2026-11-26T03:00:00.000Z')   // before the create answered
    await h.tail; await h.tail
    expect(s.calls.map(c => c.path)).toEqual(['/v1/actions', '/v1/actions/1/resolve', '/v1/actions/1/applied'])
    expect(s.calls[1]!.body).toEqual({ option_id: 'allow', expected_version: 1, resolved_by: 'joey-test', at: '2026-11-26T03:00:00.000Z' })   // r3: when it was pressed
    expect(s.calls[2]!.body).toEqual({ at: '2026-11-26T03:00:00.000Z' })
    expect(s.acts.get('1')).toMatchObject({ state: 'resolved', selected_option_id: 'allow', resolved_by: 'joey-test' })
    // a presser who is not an assignee: the first assignee
    const h2 = a.open(perm, 'k2')!
    a.pressedElsewhere(h2, 'deny', '', undefined)
    await h2.tail
    expect(s.calls.find(c => c.path === '/v1/actions/2/resolve')!.body.resolved_by).toBe('joey')
  })

  test('Onsen answered first (409 on resolve): applied with what was pressed in Telegram, and by whom', async () => {
    const s = standIn()
    const a = new OnsenActions({ req: s.req, log })
    const h = a.open(perm, 'k')!
    await h.tail
    Object.assign(s.acts.get('1'), { state: 'resolved', selected_option_id: 'deny', resolved_by: 'joey', version: 2 })   // a press in Onsen, its control on the way
    a.pressedElsewhere(h, 'allow', 'joey')
    await h.tail
    expect(s.calls.slice(1).map(c => [c.path, c.body])).toEqual([
      ['/v1/actions/1/resolve', { option_id: 'allow', expected_version: 1, resolved_by: 'joey' }],
      ['/v1/actions/1/applied', { option_id: 'allow', resolved_by: 'joey' }]])
    expect(s.acts.get('1')).toMatchObject({ selected_option_id: 'allow' })
    expect(a.stats.conflicts).toBe(1)
  })

  test('cancel: open, or answered in Onsen and not applied (the version that moved is read once); an Action that is over is left alone', async () => {
    const s = standIn()
    const a = new OnsenActions({ req: s.req, log })
    const h = a.open(perm, 'k')!
    await h.tail
    Object.assign(s.acts.get('1'), { state: 'resolved', selected_option_id: 'allow', resolved_by: 'joey', version: 2 })
    a.cancel(h, 'the session closed')
    await h.tail
    expect(s.calls.slice(1).map(c => `${c.method} ${c.path} ${c.body ? JSON.stringify(c.body) : ''}`)).toEqual([
      'POST /v1/actions/1/cancel {"expected_version":1,"reason":"the session closed"}',
      'GET /v1/actions/1 ',
      'POST /v1/actions/1/cancel {"expected_version":2,"reason":"the session closed"}'])
    expect(h.state).toBe('cancelled')
    const n = s.calls.length
    a.cancel(h, 'again')
    await h.tail
    expect(s.calls.length).toBe(n)                                   // cancelled already: no call
    // an adopted Action (a control item for one this process did not make) at the control's version
    const h2 = a.open(perm, 'k2')!
    await h2.tail
    Object.assign(s.acts.get('2'), { state: 'resolved', version: 2 })
    const ad = a.adopt('2', 2)
    expect(ad).toBe(h2)
    expect(ad.version).toBe(2)
    a.cancel(ad, 'gone')
    await ad.tail
    expect(s.calls.at(-1)!.body).toEqual({ expected_version: 2, reason: 'gone' })
    const fresh = a.adopt('77', 3)
    expect([fresh.id, fresh.version, fresh.state]).toEqual(['77', 3, 'open'])
  })

  test('a transport failure, a 5xx or a 429 is tried twice more; a 4xx is not; a call never throws; an Action Onsen never made takes no other call', async () => {
    const s = standIn({ fail: (c, n) => n === 1 ? 'throw' : n === 2 ? 503 : null })
    const a = new OnsenActions({ req: s.req, log, retryMs: [5, 5] })
    const h = a.open(perm, 'k')!
    await h.tail
    expect(s.calls.map(c => c.headers?.['Idempotency-Key'])).toEqual(['k', 'k', 'k'])   // the same key every try
    expect(h.id).toBe('1')
    const down = standIn({ fail: () => 503 })
    const b = new OnsenActions({ req: down.req, log, retryMs: [5, 5] })
    const h2 = b.open(perm, 'k')!
    b.pressedElsewhere(h2, 'allow', 'joey')
    b.cancel(h2, 'x')
    await h2.tail
    expect(down.calls).toHaveLength(3)                               // the create's three tries; nothing after it
    expect(h2.state).toBe('failed')
    expect(b.stats.failed).toBe(1)
    expect(b.stats.last_error).toContain('HTTP 503')
    const bad = standIn({ fail: () => null })
    const c = new OnsenActions({ req: async (...x) => { const r = await bad.req(...x); return x[1] === '/v1/actions' ? { status: 400, json: { error: { code: 'invalid_request', message: 'nope' } } } : r }, log, retryMs: [5, 5] })
    const h3 = c.open(perm, 'k')!
    await h3.tail
    expect(bad.calls).toHaveLength(1)                                // a 400 is not tried again
    const thrower = new OnsenActions({ req: async () => { throw new Error('boom') }, log, retryMs: [1, 1] })
    const h4 = thrower.open(perm, 'k')!
    await h4.tail                                                    // resolves: never rejects
    expect(h4.state).toBe('failed')
    const nocred = new OnsenActions({ req: async () => null, log })
    const h5 = nocred.open(perm, 'k')!
    await h5.tail
    expect(h5.state).toBe('failed')
  })

  test('off (ONSEN_ACTIONS): no new Action; not a valid one (no option, more than 10, no assignee): none', async () => {
    const s = standIn()
    expect(new OnsenActions({ req: s.req, log, on: false }).open(perm, 'k')).toBeNull()
    const a = new OnsenActions({ req: s.req, log })
    expect(a.open({ ...perm, options: [] }, 'k')).toBeNull()
    expect(a.open({ ...perm, options: Array.from({ length: 11 }, (_, i) => ({ id: String(i + 1), label: 'x' })) }, 'k')).toBeNull()
    expect(a.open({ ...perm, assignees: [] }, 'k')).toBeNull()
    await tick()
    expect(s.calls).toEqual([])
    expect(a.stats.skipped).toBe(3)
  })

  test('applied is reported once (WO-176 r2): the same answer again makes no call; another option than the recorded one still does', async () => {
    const s = standIn()
    const a = new OnsenActions({ req: s.req, log })
    const h = a.open(perm, 'k')!
    await h.tail
    Object.assign(s.acts.get('1'), { state: 'resolved', selected_option_id: 'deny', resolved_by: 'joey', version: 2 })
    a.applied(h, { at: '2026-11-26T04:10:00.000Z' })
    a.applied(h, {})
    a.applied(h, { option_id: 'deny', resolved_by: 'joey' })
    await h.tail
    expect(s.calls.filter(c => c.path === '/v1/actions/1/applied')).toHaveLength(1)
    expect(h.selected).toBe('deny')
    a.applied(h, { option_id: 'allow', resolved_by: 'joey' })          // what was really pressed differs: Onsen hears it (and answers 409: applied already)
    await h.tail
    expect(s.calls.filter(c => c.path === '/v1/actions/1/applied')).toHaveLength(2)
    // two cancels queued for one Action (the officer's closeGone and the channel's close): one call
    const h2 = a.open(perm, 'k2')!
    a.cancel(h2, 'menu gone'); a.cancel(h2, 'session closed')
    await h2.tail
    expect(s.calls.filter(c => c.path === '/v1/actions/2/cancel')).toHaveLength(1)
  })

  test('join (Onsen 0.24.0): only the people not assignees yet, behind the create; the handle follows the new version and assignees; nothing to add: no call', async () => {
    const s = standIn({ delayMs: 10 })
    const a = new OnsenActions({ req: s.req, log })
    const h = a.open(perm, 'k')!                                        // assignees [joey]
    let seen = -1
    a.join(h, ['joey'], x => { seen = x.version })
    await h.tail
    expect(s.calls.filter(c => c.body?.action_id != null)).toHaveLength(0)
    expect(seen).toBe(1)
    a.join(h, ['joey', 'joey-test'], x => { seen = x.version })
    await h.tail
    const j = s.calls.filter(c => c.body?.action_id != null)
    expect(j).toHaveLength(1)
    expect(j[0]!.body).toEqual({ action_id: '1', assignees: ['joey', 'joey-test'] })
    expect([h.version, h.assignees, seen]).toEqual([2, ['joey', 'joey-test'], 2])
    // the next resolve carries the joined version; the presser joey-test is an assignee now
    a.pressedElsewhere(h, 'allow', 'joey-test')
    await h.tail
    expect(s.calls.find(c => c.path === '/v1/actions/1/resolve')!.body).toEqual({ option_id: 'allow', expected_version: 2, resolved_by: 'joey-test' })
    // not open any more: no join call
    const n = s.calls.length
    a.join(h, ['someone'])
    await h.tail
    expect(s.calls.length).toBe(n)
  })

  test('findOpen: the newest open Action of this agent that the test takes, as a handle (one GET, 3 s); none: null', async () => {
    const s = standIn()
    const a = new OnsenActions({ req: s.req, log })
    const h1 = a.open(perm, 'k1')!; await h1.tail
    const h2 = a.open({ ...perm, session_id: 'adam.lane.3' }, 'k2')!; await h2.tail
    const h3 = a.open({ ...perm, source: 'menu', menu_kind: 'model_picker' }, 'k3')!; await h3.tail
    const b = new OnsenActions({ req: s.req, log })                    // a restarted daemon: it holds none of them
    const f = await b.findOpen('adam', d => d.source === 'permission' && (d.session_id ?? 'main') === 'main', 'perm:adam:adopted:')
    expect(f).toMatchObject({ id: '1', version: 1, state: 'open', key: 'perm:adam:adopted:1', source: 'permission', assignees: ['joey'] })
    expect(s.calls.at(-1)).toMatchObject({ method: 'GET', path: '/v1/actions?requested_by=adam&state=open' })
    expect(b.find(null, '1')).toBe(f!)
    expect(await b.findOpen('adam', d => d.source === 'card')).toBeNull()
    expect(await new OnsenActions({ req: async () => { throw new Error('down') }, log }).findOpen('adam', () => true)).toBeNull()
  })

  test('r3 press times (Onsen 0.24.3): the officer\'s own record carries resolved_at / opened_at, a requester\'s resolve and applied carry at; any other unknown field is still refused', async () => {
    const T = { at: '2026-11-26T04:18:03.388Z', opened_at: '2026-11-26T04:17:42.000Z' }
    const s = standIn()
    const a = new OnsenActions({ req: s.req, log })
    const h = a.open({ source: 'menu', menu_kind: 'model_picker', assignees: ['duty-officer'], summary: 'm', options: [{ id: '1', label: 'Opus' }], resolved: { option_id: '1', by: 'duty-officer', ...T } }, 'k')!
    await h.tail
    expect(s.calls).toHaveLength(1)                                     // taken as sent: no second try
    expect(s.calls[0]!.body).toMatchObject({ state: 'resolved', selected_option_id: '1', resolved_by: 'duty-officer', resolved_at: T.at, opened_at: T.opened_at })
    expect(h.state).toBe('resolved')
    const h2 = a.open(perm, 'k2')!
    a.pressedElsewhere(h2, 'allow', 'joey', T.at)
    await h2.tail
    expect(s.calls.filter(c => c.path === '/v1/actions/2/resolve').map(c => c.body)).toEqual([{ option_id: 'allow', expected_version: 1, resolved_by: 'joey', at: T.at }])
    expect(s.calls.find(c => c.path === '/v1/actions/2/applied')!.body).toEqual({ at: T.at })
    const bad = await s.req('POST', '/v1/actions', { ...perm, pressed_at: T.at })   // the stand-in still refuses a field Onsen does not take
    expect(bad!.status).toBe(400)
  })

  test('r3: the duty officer pressing on the screen resolves as duty-officer as it is (no join: the assignees stay who was asked)', async () => {
    const s = standIn()
    const a = new OnsenActions({ req: s.req, log })
    const h = a.open(perm, 'k')!
    a.pressedElsewhere(h, 'deny', 'duty-officer', '2026-11-26T04:30:00.000Z', true)
    await h.tail
    expect(s.calls.map(c => c.path)).toEqual(['/v1/actions', '/v1/actions/1/resolve', '/v1/actions/1/applied'])
    expect(s.calls[1]!.body).toEqual({ option_id: 'deny', expected_version: 1, resolved_by: 'duty-officer', at: '2026-11-26T04:30:00.000Z' })
    expect(s.acts.get('1')).toMatchObject({ state: 'resolved', resolved_by: 'duty-officer', selected_option_id: 'deny', assignees: ['joey'] })
    // without asIs a name that is not an assignee is taken for the first assignee (a Telegram presser Onsen has no name for)
    const h2 = a.open(perm, 'k2')!
    a.pressedElsewhere(h2, 'allow', 'duty-officer')
    await h2.tail
    expect(s.calls.find(c => c.path === '/v1/actions/2/resolve')!.body.resolved_by).toBe('joey')
  })

  test('newestOpen: the newest Action still open of a kind', async () => {
    const s = standIn()
    const a = new OnsenActions({ req: s.req, log })
    const h1 = a.open(perm, 'k1')!; await h1.tail
    await new Promise(r => setTimeout(r, 3))
    const h2 = a.open(perm, 'k2')!; await h2.tail
    expect(a.newestOpen(h => h.source === 'permission')).toBe(h2)
    a.pressedElsewhere(h2, 'allow', 'joey'); await h2.tail
    expect(a.newestOpen(h => h.source === 'permission')).toBe(h1)
    expect(a.newestOpen(h => h.source === 'menu')).toBeNull()
  })
})

describe('helpers', () => {
  test('actionControlOf: {action_id, option_id, version} as Onsen sends it; anything else null', () => {
    expect(actionControlOf({ action_id: '12', option_id: 'allow', version: 2 })).toEqual({ action_id: '12', option_id: 'allow', version: 2 })
    expect(actionControlOf({ action_id: 12, option_id: '1', version: 3 })).toEqual({ action_id: '12', option_id: '1', version: 3 })
    for (const bad of [null, {}, { action_id: 'x', option_id: 'a', version: 1 }, { action_id: '1', option_id: '', version: 1 }, { action_id: '1', option_id: 'a b', version: 1 },
      { action_id: '1', option_id: 'a', version: 0 }, { action_id: '1', option_id: 'a', version: 1.5 }, { action_id: '1', option_id: 'a', version: '2' }]) expect(actionControlOf(bad)).toBeNull()
  })
  test('members: Joey and his test account by Telegram id (Onsen HUMAN_ALIASES); a question to nobody Onsen knows is assigned to joey', () => {
    expect(memberOfTg('1828173984')).toBe('joey')
    expect(memberOfTg(6736970916)).toBe('joey-test')
    expect(memberOfTg('42')).toBeNull()
    expect(assigneesOf(['1828173984', '42', '6736970916', '1828173984'])).toEqual(['joey', 'joey-test'])
    expect(assigneesOf(['42'])).toEqual(['joey'])
  })
  test('ONSEN_ACTIONS: unset on; 0 / off off; a list of agents or *', () => {
    expect(actionsOn({}, 'adam')).toBe(true)
    expect(actionsOn({ ONSEN_ACTIONS: ' ' }, 'adam')).toBe(true)
    expect(actionsOn({ ONSEN_ACTIONS: '0' }, 'adam')).toBe(false)
    expect(actionsOn({ ONSEN_ACTIONS: 'off' }, 'adam')).toBe(false)
    expect(actionsOn({ ONSEN_ACTIONS: 'lab-relay, adam' }, 'adam')).toBe(true)
    expect(actionsOn({ ONSEN_ACTIONS: 'lab-relay' }, 'adam')).toBe(false)
    expect(actionsOn({ ONSEN_ACTIONS: '*' }, 'adam')).toBe(true)
  })
})

describe('status blockers name their Action (screen-status.ts RecordFacts.actionFor)', () => {
  const MENU = regions(['', '   Select model', '   ❯ 1. Default', '   Enter to set as default · Esc to cancel', ''].join('\n'))
  const V = (state: ScreenVerdict['state'], menu: ScreenVerdict['menu']): ScreenVerdict => ({ state, menu, p: 0.9, by: 'jev' })
  const prog = { state: 'idle' as const, detail: { queued_joey: 0, dialog_open: true }, last_activity_at: '2026-11-26T00:59:00.000Z' }
  const f = (actionFor?: (m: string) => string | null) => ({ now: Date.parse('2026-11-26T01:00:00.000Z'), session_id: 'sess-1', ...(actionFor ? { actionFor } : {}) })
  const blocker = (v: ScreenVerdict, af?: (m: string) => string | null) => {
    const o = composeRecord(v, MENU, prog, f(af)).observation
    expect(checkObservation(o)).toEqual([])
    return o.sessions[0]!.blockers[0]!
  }
  test('the open Action the daemon made for that menu; none known, no actionFor, or actionFor throwing: null', () => {
    const seen: string[] = []
    expect(blocker(V('waiting_for_human', 'model_picker'), m => { seen.push(m); return m === 'model_picker' ? '41' : null })).toMatchObject({ menu_kind: 'model_picker', action_id: '41' })
    expect(seen).toEqual(['model_picker'])
    expect(blocker(V('waiting_for_human', 'resume_picker'), () => null).action_id).toBeNull()
    expect(blocker(V('waiting_for_human', 'resume_picker')).action_id).toBeNull()
    expect(blocker(V('waiting_for_human', 'login'), () => { throw new Error('x') }).action_id).toBeNull()
  })
})
