// WO-157 phase 1: decideWake (wake-decide.ts) against the fleet table (lanes-wake-rules.json). Pure: no daemon, no files but the two tables.
//   part 1: the table is well formed (every kind has a default urgency, every map covers every member state, every rule's destination is known)
//   part 2: one test per kind in its usual state, then the state rows of the design page (idle, busy, waiting/stuck, walled, offline)
//   part 3: what changed on purpose: no_reply decides nothing, an unmarked program notice goes to a lane, keep-warm on a busy main is recorded only
//   part 4: an agent's own rules (router.json wake_rules, and its older rules translated: the trading desk's scheduled → main, Iris's Slack waker → main)
import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { decideWake, legacyAgentRules, loadWakeTable, WAKE_KINDS, MEMBER_STATES, type WakeItem, type WakeState } from './wake-decide.ts'

const T = loadWakeTable()
const FLEET_ROUTER = JSON.parse(readFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), 'utf8'))
const idle: WakeState = { member: 'idle' }, busy: WakeState = { member: 'busy' }
const d = (item: WakeItem, state: WakeState, agent: any[] = []) => decideWake(item, state, T, agent)

describe('part 1: the table', () => {
  test('every kind has a default urgency', () => {
    for (const k of WAKE_KINDS) expect(['interrupt', 'ordered', 'silent', 'state']).toContain(T.urgency_default[k])
  })
  test('the main, joey and state maps cover every member state; the lane map only holds', () => {
    for (const m of ['main', 'joey', 'state']) for (const s of MEMBER_STATES) {
      const c = T.maps[m][s] ?? (s === 'gone' ? T.maps.main.gone : undefined)
      expect(c, `${m}.${s}`).toBeDefined()
    }
    for (const [s, c] of Object.entries(T.maps.lane)) if (s !== 'doc') expect(typeof c === 'string' ? c : c.target).toMatch(/^held:/)
  })
  test('every rule has an id, a known destination and says what it replaces; the last one matches everything', () => {
    const ids = new Set<string>()
    for (const r of T.rules) {
      expect(ids.has(r.id)).toBe(false); ids.add(r.id)
      expect(r.to).toMatch(/^(main|owner|ledger|lane:(reflex|mail|worker|fork|curator|synthesis))$/)
      expect(r.replaces?.length).toBeGreaterThan(0)
    }
    expect(T.rules.at(-1)).toMatchObject({ id: 'default', when: {} })
  })
})

describe('part 2: each kind, each state', () => {
  test('Joey: main now when idle, after this step when busy (statusOf only)', () => {
    expect(d({ kind: 'joey_tg' }, idle)).toMatchObject({ target: 'main_now', urgency: 'interrupt', rule: 'joey' })
    expect(d({ kind: 'joey_tg' }, busy)).toMatchObject({ target: 'main_after_step', rule: 'joey' })
    expect(d({ kind: 'joey_edit' }, { member: 'compacting' })).toMatchObject({ target: 'main_after_step' })
    expect(d({ kind: 'joey_form' }, idle)).toMatchObject({ target: 'main_now', rule: 'joey' })
  })
  test('Joey quoting a lane message or writing in a worker topic: that lane', () => {
    expect(d({ kind: 'joey_tg' }, { member: 'busy', owner: 'worker' })).toMatchObject({ target: 'lane:worker', rule: 'joey-owner' })
    expect(d({ kind: 'joey_tg' }, { member: 'idle', owner: 'reflex' })).toMatchObject({ target: 'lane:reflex', rule: 'joey-owner' })
  })
  test("Joey's message when the main waits on a button, is stuck, walled, offline: held; nobody gets an extra notice (decision 6)", () => {
    expect(d({ kind: 'joey_tg' }, { member: 'waiting' })).toMatchObject({ target: 'held:waiting', then: 'main' })
    expect(d({ kind: 'joey_tg' }, { member: 'stuck' })).toMatchObject({ target: 'held:stuck' })
    expect(d({ kind: 'joey_tg' }, { member: 'walled' })).toMatchObject({ target: 'held:wall', then: 'main' })
    expect(d({ kind: 'joey_tg' }, { member: 'offline' })).toMatchObject({ target: 'held:offline' })
    expect(d({ kind: 'joey_tg' }, { member: 'starting' })).toMatchObject({ target: 'held:starting' })
    for (const m of MEMBER_STATES) expect(d({ kind: 'joey_tg' }, { member: m }).tell).toBeUndefined()
  })
  test('decision 2 (13:46Z): statusOf alone, a cell for each of its seven states', () => {
    const want: Record<string, [string, string, string]> = {          // member: joey, a hand-over, a state wake
      idle: ['main_now', 'main_now', 'main_now'], busy: ['main_after_step', 'main_after_step', 'main_after_step'],
      waiting: ['held:waiting', 'held:waiting', 'main_after_step'], stuck: ['held:stuck', 'held:stuck', 'main_after_step'],
      compacting: ['main_after_step', 'main_after_step', 'main_after_step'], walled: ['held:wall', 'held:wall', 'held:wall'], offline: ['held:offline', 'held:offline', 'held:offline'] }
    for (const [m, [j, h, w]] of Object.entries(want)) {
      expect(d({ kind: 'joey_tg' }, { member: m }).target).toBe(j)
      expect(d({ kind: 'handoff', urgency: 'ordered' }, { member: m }).target).toBe(h)
      expect(d({ kind: 'wd_stall' }, { member: m }).target).toBe(w)
      expect(d({ kind: 'scheduled' }, { member: m }).target).toBe(m === 'walled' ? 'held:wall' : 'lane:reflex')
    }
  })
  test('a colleague: a call → a reflex lane; a mail → the mail lane; a reply in a conversation we own → its owner', () => {
    expect(d({ kind: 'peer_call', sender: 'eve' }, busy)).toMatchObject({ target: 'lane:reflex', urgency: 'interrupt', rule: 'peer-call' })
    expect(d({ kind: 'peer_mail', sender: 'eve' }, busy)).toMatchObject({ target: 'lane:mail', urgency: 'ordered', rule: 'mail' })
    expect(d({ kind: 'peer_call', sender: 'eve', refs: { thread: 'adam#t-1' } }, { member: 'busy', owner: 'main' })).toMatchObject({ target: 'main_after_step', rule: 'owner' })
    expect(d({ kind: 'peer_call', sender: 'eve' }, { member: 'idle', owner: 'reflex' })).toMatchObject({ target: 'lane:reflex', rule: 'owner' })
  })
  test('the mailbox ring and the watchdog reminder (until 4d retires them) → the mail lane', () => {
    expect(d({ kind: 'mail_ring', sender: 'mailbox' }, idle)).toMatchObject({ target: 'lane:mail', rule: 'mail' })
    expect(d({ kind: 'wd_mail', sender: 'fleet-watchdog' }, busy)).toMatchObject({ target: 'lane:mail', rule: 'mail' })
  })
  test("the mailbox's events: a decision → the lane that asked (the main when none); a card's due window → record only", () => {
    expect(d({ kind: 'mail_event', sub: 'decision' }, { member: 'busy', owner: 'mail' })).toMatchObject({ target: 'lane:mail', rule: 'mail-decision' })
    expect(d({ kind: 'mail_event', sub: 'decision' }, { member: 'idle' })).toMatchObject({ target: 'main_now', rule: 'mail-decision-main' })
    expect(d({ kind: 'mail_event', sub: 'due' }, busy)).toMatchObject({ target: 'ledger', rule: 'mail-due' })
    expect(d({ kind: 'mail_event', sub: 'something-else' }, busy)).toMatchObject({ target: 'main_after_step', rule: 'default' })
  })
  test('a scheduled run, a page alert → a reflex lane; an alert of an incident a lane already handles → that lane', () => {
    expect(d({ kind: 'scheduled', sender: 'scheduler', refs: { run_id: '7' } }, idle)).toMatchObject({ target: 'lane:reflex', urgency: 'ordered', rule: 'scheduled' })
    expect(d({ kind: 'alert', sender: 'alert-dispatcher' }, busy)).toMatchObject({ target: 'lane:reflex', urgency: 'interrupt', rule: 'alert' })
    expect(d({ kind: 'alert', sender: 'alert-dispatcher' }, { member: 'busy', owner: 'reflex' })).toMatchObject({ target: 'lane:reflex', rule: 'owner' })
  })
  test("an urgent work order: the ticket's worker, a new worker, or the main when topics are off", () => {
    expect(d({ kind: 'board', refs: { ticket: 'WO-9' } }, { member: 'busy', owner: 'worker' })).toMatchObject({ target: 'lane:worker', rule: 'owner' })
    expect(d({ kind: 'board', refs: { ticket: 'WO-9' } }, { member: 'busy' })).toMatchObject({ target: 'lane:worker', rule: 'board-worker' })
    expect(d({ kind: 'board', refs: { ticket: 'WO-9' } }, { member: 'busy', worker_topics: false })).toMatchObject({ target: 'main_after_step', rule: 'board-main' })
  })
  test('the main\'s own state crossings: keep-warm, stall, restart, resume → the main; a busy, waiting or stuck main gets it after this step', () => {
    expect(d({ kind: 'wd_keepwarm' }, idle)).toMatchObject({ target: 'main_now', urgency: 'state', rule: 'state-wake' })
    for (const k of ['wd_stall', 'wd_restart', 'wd_resume']) {
      expect(d({ kind: k }, idle)).toMatchObject({ target: 'main_now', rule: 'state-wake' })
      expect(d({ kind: k }, busy)).toMatchObject({ target: 'main_after_step' })
      expect(d({ kind: k }, { member: 'stuck' })).toMatchObject({ target: 'main_after_step' })
      expect(d({ kind: k }, { member: 'walled' })).toMatchObject({ target: 'held:wall' })
      expect(d({ kind: k }, { member: 'offline' })).toMatchObject({ target: 'held:offline' })
    }
  })
  test('hand-overs from the lanes: handoff, a card that cannot wait, the batch, a run that ended owing → the main; a card that can wait, a run that owed nothing → record only', () => {
    expect(d({ kind: 'handoff', urgency: 'ordered' }, idle)).toMatchObject({ target: 'main_now', rule: 'hand' })
    expect(d({ kind: 'card', urgency: 'interrupt' }, busy)).toMatchObject({ target: 'main_after_step', rule: 'hand' })
    expect(d({ kind: 'batch', urgency: 'ordered' }, { member: 'offline' })).toMatchObject({ target: 'held:offline', rule: 'hand' })
    expect(d({ kind: 'lane_exit', urgency: 'ordered' }, { member: 'walled' })).toMatchObject({ target: 'held:wall', rule: 'hand' })
    expect(d({ kind: 'card', urgency: 'silent' }, idle)).toMatchObject({ target: 'ledger', rule: 'hand-silent' })
    expect(d({ kind: 'lane_exit', urgency: 'silent' }, busy)).toMatchObject({ target: 'ledger', rule: 'hand-silent' })
  })
  test('a lane destination when walled: held, then the lane; offline: the lane runs (decision 3)', () => {
    expect(d({ kind: 'scheduled' }, { member: 'walled' })).toMatchObject({ target: 'held:wall', then: 'lane:reflex' })
    expect(d({ kind: 'peer_mail' }, { member: 'offline' })).toMatchObject({ target: 'lane:mail' })
    expect(d({ kind: 'scheduled' }, { member: 'gone' })).toMatchObject({ target: 'lane:reflex' })
    expect(d({ kind: 'peer_call' }, { member: 'stuck' })).toMatchObject({ target: 'lane:reflex' })
  })
  test('no free lane slot: still the lane (its queue), marked', () => {
    expect(d({ kind: 'peer_call' }, { member: 'busy', lane_free: false })).toMatchObject({ target: 'lane:reflex', wait: 'lane_slot' })
    expect(d({ kind: 'joey_tg' }, { member: 'busy', lane_free: false }).wait).toBeUndefined()
  })
  test("the main's own lane tools and a lane's follow-up: the lane they name", () => {
    expect(d({ kind: 'own' }, { member: 'busy', owner: 'fork' })).toMatchObject({ target: 'lane:fork', rule: 'own' })
    expect(d({ kind: 'own' }, { member: 'busy', owner: 'synthesis' })).toMatchObject({ target: 'lane:synthesis', rule: 'own' })
  })
  test('a gate that already said no, lanes switched off (the ring: recorded only)', () => {
    expect(d({ kind: 'peer_call' }, { member: 'idle', gate: 'peer_flood' })).toMatchObject({ target: 'ledger', rule: 'gate' })
    expect(d({ kind: 'alert' }, { member: 'busy', gate: 'alert_repeat' })).toMatchObject({ target: 'ledger', rule: 'gate' })
    expect(d({ kind: 'peer_call' }, { member: 'idle', lanes_off: true })).toMatchObject({ target: 'main_now', rule: 'lanes-off' })
    expect(d({ kind: 'mail_ring' }, { member: 'idle', lanes_off: true })).toMatchObject({ target: 'ledger', rule: 'lanes-off-ring' })
  })
  test('decision 5: an unverified colleague, scheduler or alert dispatcher → the main; a conversation we own still goes to its owner', () => {
    expect(d({ kind: 'peer_call', unverified: true }, idle)).toMatchObject({ target: 'main_now', rule: 'unverified' })
    expect(d({ kind: 'scheduled', unverified: true }, busy)).toMatchObject({ target: 'main_after_step', rule: 'unverified' })
    expect(d({ kind: 'alert', unverified: true }, busy)).toMatchObject({ rule: 'unverified' })
    expect(d({ kind: 'peer_call', unverified: true }, { member: 'busy', owner: 'reflex' })).toMatchObject({ target: 'lane:reflex', rule: 'owner' })
    expect(d({ kind: 'external', unverified: true }, busy)).toMatchObject({ target: 'lane:reflex', rule: 'external' })
    expect(d({ kind: 'board', unverified: true }, busy)).toMatchObject({ rule: 'board-worker' })
  })
  test('anything else → the main', () => {
    expect(d({ kind: 'other' }, busy)).toMatchObject({ target: 'main_after_step', rule: 'default' })
    expect(d({ kind: 'something-new' as any }, idle)).toMatchObject({ target: 'main_now', urgency: 'ordered', rule: 'default' })
  })
})

describe('part 3: what changed on purpose', () => {
  test('decision 1: a no_reply reply with reply_to wakes the line that asked; the daemon\'s own notice (urgency silent) is recorded only, owner or not', () => {
    expect(d({ kind: 'peer_call', no_reply: true, refs: { reply_to: '11835' } }, { member: 'busy', owner: 'main' })).toMatchObject({ target: 'main_after_step', rule: 'owner' })
    expect(d({ kind: 'peer_call', no_reply: true, refs: { reply_to: '11835' } }, { member: 'idle', owner: 'reflex' })).toMatchObject({ target: 'lane:reflex', rule: 'owner' })
    expect(d({ kind: 'peer_call', no_reply: true, urgency: 'silent', refs: { reply_to: '11835' } }, { member: 'idle', owner: 'main' })).toMatchObject({ target: 'ledger', rule: 'record-only' })
  })
  test('no_reply decides nothing: a colleague\'s no_reply call is still a call; only urgency silent is record only', () => {
    expect(d({ kind: 'peer_call', no_reply: true }, idle)).toMatchObject({ target: 'lane:reflex', urgency: 'interrupt' })
    expect(d({ kind: 'peer_call', no_reply: true }, { member: 'busy', owner: 'main' })).toMatchObject({ target: 'main_after_step', rule: 'owner' })
    expect(d({ kind: 'peer_call', urgency: 'silent' }, idle)).toMatchObject({ target: 'ledger', rule: 'record-only' })
    expect(d({ kind: 'peer_mail', no_reply: true }, idle)).toMatchObject({ target: 'lane:mail' })
  })
  test('a program outside the roster with no urgency (the Iris case): a reflex lane, not the ledger', () => {
    expect(d({ kind: 'external', sender: 'iris-slack', no_reply: true }, busy)).toMatchObject({ target: 'lane:reflex', urgency: 'ordered', rule: 'external' })
    expect(d({ kind: 'external', sender: 'reply-watch', urgency: 'silent' }, busy)).toMatchObject({ target: 'ledger', rule: 'record-only' })
  })
  test('keep-warm on a busy main is recorded only (the turn writes the cache)', () => {
    expect(d({ kind: 'wd_keepwarm' }, busy)).toMatchObject({ target: 'ledger', rule: 'keepwarm-busy' })
    expect(d({ kind: 'wd_keepwarm' }, { member: 'compacting' })).toMatchObject({ target: 'ledger' })
  })
  test('the kind is a field: the same text decides nothing', () => {
    expect(d({ kind: 'peer_call', sender: 'eve' }, idle).rule).toBe('peer-call')
    expect(d({ kind: 'scheduled', sender: 'eve' }, idle).rule).toBe('scheduled')
  })
})

describe("part 4: an agent's own rules", () => {
  const desk = { ...FLEET_ROUTER, rules: FLEET_ROUTER.rules.map((r: any) => r.id === 'mesh-scheduled' ? { ...r, to: 'main', note: 'trading desk' } : r) }
  const iris = { ...FLEET_ROUTER, rules: [{ id: 'iris-slack-wake', match: { source: 'mesh', from: ['iris-slack'] }, to: 'main' }, ...FLEET_ROUTER.rules] }
  test('a router.json equal to the fleet adds nothing', () => {
    expect(legacyAgentRules(FLEET_ROUTER, FLEET_ROUTER)).toEqual([])
  })
  test("the trading desk's scheduled runs stay with the main", () => {
    const rules = legacyAgentRules(desk, FLEET_ROUTER)
    expect(rules).toMatchObject([{ id: 'legacy:mesh-scheduled', when: { kind: ['scheduled'] }, to: 'main' }])
    expect(d({ kind: 'scheduled', sender: 'scheduler' }, idle, rules)).toMatchObject({ target: 'main_now', rule: 'legacy:mesh-scheduled', origin: 'legacy:mesh-scheduled' })
    expect(d({ kind: 'scheduled', sender: 'scheduler' }, busy, rules)).toMatchObject({ target: 'main_after_step' })
    expect(d({ kind: 'peer_call' }, idle, rules).rule).toBe('peer-call')
  })
  test("Iris's Slack waker goes to her main (no_reply or not)", () => {
    const rules = legacyAgentRules(iris, FLEET_ROUTER)
    expect(d({ kind: 'external', sender: 'iris-slack', no_reply: true }, busy, rules)).toMatchObject({ target: 'main_after_step', rule: 'legacy:iris-slack-wake' })
    expect(d({ kind: 'external', sender: 'reply-watch' }, busy, rules).rule).toBe('external')
  })
  test('wake_rules in router.json come first, as written', () => {
    const rules = legacyAgentRules({ ...FLEET_ROUTER, wake_rules: [{ id: 'mine', when: { kind: ['alert'] }, to: 'main' }] }, FLEET_ROUTER)
    expect(d({ kind: 'alert' }, idle, rules)).toMatchObject({ target: 'main_now', rule: 'mine', origin: 'agent' })
  })
})
