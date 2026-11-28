// WO-169 part 2: the rules of Onsen contract v1 §3 (rescue-site/onsen-ui/fixtures/v1/status_v1_check.py, the one copy validate.py calls) for what this
// daemon observes.
// Left out, as Onsen adds them or they need its data: valid_until, rollup, phrase / line, action_id's Action and the member / thread / message
// references. Returns the list of what is wrong ([] = it passes).
const KEYS = 'presence presence_reason lifecycle main_session_id sessions background queue last_activity_at reported_at evidence'
const SESSION = 'id kind thread_id activity activity_since turn doing blockers last_turn'
const T = (v: unknown): boolean => typeof v === 'string' && !Number.isNaN(Date.parse(v))
export function checkObservation(s: any): string[] {
  const bad: string[] = []
  const check = (ok: unknown, msg: string) => { if (!ok) bad.push(msg) }
  const keys = (o: any, want: string, what: string) => {
    const got = new Set(Object.keys(o ?? {})), w = new Set(want.split(' '))
    const diff = [...got].filter(k => !w.has(k)).concat([...w].filter(k => !got.has(k)))
    check(!diff.length, `${what}: keys differ ${JSON.stringify(diff)}`)
  }
  if ('connector' in s || 'held_item_ids' in s) {
    keys(s, KEYS + ' connector held_item_ids', 'observation')
    check(typeof s.connector === 'string' && s.connector.includes('/'), 'connector')
    check(Array.isArray(s.held_item_ids) && s.held_item_ids.every((id: unknown) => typeof id === 'string'), 'held_item_ids')
  } else keys(s, KEYS, 'observation')
  check(['online', 'offline'].includes(s.presence), `presence ${s.presence}`)                 // away is a person's; unknown is Onsen's
  check(['ready', 'starting', 'stopped'].includes(s.lifecycle), `lifecycle ${s.lifecycle}`)
  if (s.presence === 'online') check(s.presence_reason === null, 'online with a reason')
  else check(['disconnected', 'process_gone'].includes(s.presence_reason), `offline without evidence (${s.presence_reason})`)
  if (s.lifecycle === 'stopped') check(s.presence === 'offline', 'stopped but not offline')
  check(T(s.reported_at), 'reported_at')
  check(s.last_activity_at === null || T(s.last_activity_at), 'last_activity_at')
  keys(s.evidence, 'source confidence', 'evidence')
  check(['runtime', 'supervisor', 'classifier', 'none'].includes(s.evidence?.source), 'evidence source')
  check(s.evidence?.confidence === null || (s.evidence?.confidence >= 0 && s.evidence?.confidence <= 1), 'evidence confidence')
  if (s.background !== null) {
    keys(s.background, 'agents shells tasks monitors', 'background')
    check(Object.values(s.background ?? {}).every(v => v === null || (Number.isInteger(v) && (v as number) >= 0)), 'background counts')
  }
  keys(s.queue, 'pending unread_by_member', 'queue')
  check(Object.values(s.queue ?? {}).every(v => v === null || (Number.isInteger(v) && (v as number) >= 0)), 'queue counts')
  check(Array.isArray(s.sessions), 'sessions')
  const ids = (s.sessions ?? []).map((x: any) => x.id)
  check(new Set(ids).size === ids.length, 'session ids repeat')
  check(s.main_session_id === null || ids.includes(s.main_session_id), 'the main is not among the sessions')
  if (s.lifecycle === 'starting') { const m = (s.sessions ?? []).find((x: any) => x.id === s.main_session_id); check(m && m.activity === 'idle' && m.turn === null, 'starting: the main is not idle without a turn') }
  for (const x of s.sessions ?? []) {
    keys(x, SESSION, `session ${x.id}`)
    check(['idle', 'running', 'paused', 'stuck', 'unknown'].includes(x.activity), `activity ${x.activity}`)
    check(['main', 'lane'].includes(x.kind), `kind ${x.kind}`)
    check(x.activity_since === null || T(x.activity_since), 'activity_since')
    if (x.activity === 'idle' || x.activity === 'unknown') check(x.turn === null && x.doing === null, `${x.id}: ${x.activity} with a turn or doing`)
    else {
      keys(x.turn, 'id started_at trigger', `${x.id} turn`)
      check(T(x.turn?.started_at), 'turn.started_at')
      const tr = x.turn?.trigger
      check(['message', 'thread', 'schedule', 'other'].includes(tr?.kind), `trigger ${tr?.kind}`)
      if (tr) keys(tr, ({ message: 'kind conversation_id message_id', thread: 'kind thread_id', schedule: 'kind', other: 'kind' } as Record<string, string>)[tr.kind] ?? 'kind', `${x.id} trigger`)
      // status_v1_check.py 11-26 01:38Z (Chiron WO-169 01:47Z B): the open turn is not over, so it is not last_turn
      if (x.last_turn) check(x.last_turn.id !== x.turn?.id, `${x.id}: the open turn ${x.turn?.id} is also last_turn`)
    }
    if (x.activity === 'running') check(!x.blockers?.length && x.doing !== null, `${x.id}: running with a blocker or without doing`)
    else if (x.activity === 'paused' || x.activity === 'stuck') {
      check(x.doing === null && x.blockers?.length, `${x.id}: ${x.activity} without a blocker`)
      check(x.blockers?.some((b: any) => b.reason === 'stalled') === (x.activity === 'stuck'), `${x.id}: stalled blocker does not match ${x.activity}`)
    }
    // status_v1_check.py 11-26 03:59Z (Chiron WO-177 04:01Z item 1): online, a session's activity is never unknown (a compaction is running, doing compacting)
    if (s.presence === 'online') check(x.activity !== 'unknown', `${x.id}: online with activity unknown (a compaction is running, doing compacting)`)
    if (s.presence === 'offline') check(x.activity === 'unknown' && !x.blockers?.length, `${x.id}: offline with current work`)
    if (x.doing) {
      keys(x.doing, 'kind tool since', `${x.id} doing`)
      check(['thinking', 'tool', 'compacting', 'waiting_subagents'].includes(x.doing.kind), 'doing kind')
      check((x.doing.tool !== null) === (x.doing.kind === 'tool'), 'doing tool')
      check(T(x.doing.since), 'doing since')
    }
    if (x.last_turn) { keys(x.last_turn, 'id outcome ended_at', `${x.id} last_turn`); check(['done', 'interrupted', 'failed'].includes(x.last_turn.outcome), 'last_turn outcome') }
    for (const b of x.blockers ?? []) {
      keys(b, 'id reason since until menu_kind assignee action_id summary', `${x.id} blocker`)
      check(['permission', 'input_required', 'usage_limit', 'dependency', 'stalled'].includes(b.reason), `blocker reason ${b.reason}`)
      check(T(b.since) && (b.until === null || T(b.until)), 'blocker times')
      check([null, 'permission', 'model_picker', 'trust_folder', 'usage_limit_options', 'resume_picker', 'plan_or_question', 'login', 'other'].includes(b.menu_kind), 'menu_kind')
      if (b.menu_kind) {
        check(typeof b.assignee === 'string' && b.assignee, `${x.id}: a menu with no assignee`)
        check(b.reason === ({ permission: 'permission', usage_limit_options: 'usage_limit' } as Record<string, string>)[b.menu_kind] || (b.reason === 'input_required' && !['permission', 'usage_limit_options'].includes(b.menu_kind)), `${x.id}: menu ${b.menu_kind} with reason ${b.reason}`)
      }
      check(typeof b.summary === 'string' && !b.summary.includes('\n') && !/等你按/.test(b.summary), 'blocker summary')
    }
  }
  check(!/\d\s*%/.test(JSON.stringify(s)), 'a percentage in the observation')
  return bad
}
