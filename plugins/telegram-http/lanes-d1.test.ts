// Universe 002k (D1): memory decisions are enforced by a program: proposal ids and their source, memory_decide (ledger memory_decision, the
// memory write the normal way), the digest that lists every open Joey-sourced proposal again. No network, no model.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { LEDGER_KINDS } from './lanes-digest.ts'
const L = await import('./lanes.ts?d1-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-d1-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const st = L.__lanesState()
const rows = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const mem = join(dir, 'memory')
let n = 0
/** a lane run whose event is `source`; returns its token */
function run(source: 'telegram' | 'mesh', from: string, trigger: string, kind: 'worker' | 'reflex' = 'worker'): any {
  n += 1
  const id = `adam.${kind}.${n}`, evId = `ev-d1-${n}`
  st.lanes[id] = { id, kind, n, session_id: 's', thread: `adam#t-d1${n}`, status: 'running', created: '', last: '', transcript: '/x', runs: 0, tokens_in: 0, tokens_out: 0 } as any
  st.threads[`adam#t-d1${n}`] = { id: `adam#t-d1${n}`, lane: id, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
  L.__putQueue({ ev: { id: evId, source, from, text: 'x', meta: {}, notif: { method: '', params: {} } }, lane: id, state: 'leased', lease_until: 0, attempts: 1, priority: 1, enqueued: '' })
  return { runId: `${id}.r1`, lane: id, evId, closers: [], critical: false, trigger, cls: trigger, escalated: false, pushed: false }
}
const idOf = (out: string): string => /id (mp-[0-9a-f]+)/.exec(out)![1]
const proposals = () => rows().filter(r => r.kind === 'memory_proposal')
const decide = (a: object) => L.callMainTool('memory_decide', a, 'mcp-main')
/** PL1: the open Joey proposals, from the M3 records (the ledger lines are only their audit) */
const openJoey = (): string[] => L.__events().rows(r => Array.isArray(r.proposals)).flatMap(r => r.proposals).filter((p: any) => p.joey && !p.decision).map((p: any) => p.id)
const RULE = 'Joey 在話題裡說：記住，mock 服務的例行排程一律 09:00，不要再改。'
const git = (...args: string[]) => spawnSync('git', ['-C', mem, ...args], { encoding: 'utf8' }).stdout.trim()

test('D1: a memory proposal gets an id; refs.joey / source / from are set by the daemon from the event, a lane cannot claim them', async () => {
  expect(LEDGER_KINDS).toContain('memory_decision')
  const j = run('telegram', 'joey', 'joey')
  const out = await L.callLaneTool(j, 'ledger_write', { kind: 'memory_proposal', text: RULE, refs: { joey: false, proposal_id: 'mp-forged' } })
  const pid = idOf(out)
  const r = proposals().find(x => x.refs.proposal_id === pid)!
  expect(r.refs).toMatchObject({ proposal_id: pid, joey: true, source: 'telegram', from: 'joey' })
  const e = run('mesh', 'eve', 'peer', 'reflex')
  const eo = await L.callLaneTool(e, 'ledger_write', { kind: 'memory_proposal', text: 'Eve 的稿件排程一律 10:00', refs: { joey: true } })    // a lane claiming joey: ignored
  expect(proposals().find(x => x.refs.proposal_id === idOf(eo))!.refs).toMatchObject({ joey: false, source: 'mesh', from: 'eve' })
  expect(openJoey()).toEqual([pid])
  await L.callLaneTool(j, 'ledger_write', { kind: 'action', text: '查了 config' })                                                            // other kinds carry no id
  expect(rows().find(x => x.kind === 'action')!.refs.proposal_id).toBeUndefined()
})

test('D1: memory_decide is a main-only tool; it refuses what it cannot do and says why', async () => {
  expect(L.mainToolDefs().map((t: any) => t.name)).toContain('memory_decide'); expect(L.isMainTool('memory_decide')).toBe(true)
  expect(L.LANE_TOOLS.map(t => t.name)).not.toContain('memory_decide')
  expect(await L.callMainTool('memory_decide', { proposal_id: 'x', decision: 'veto', reason: 'r' }, 'some-other-session')).toStartWith('refused:')
  const pid = proposals().find(x => x.refs.joey === true)!.refs.proposal_id
  expect(await decide({ proposal_id: pid, decision: 'maybe', reason: 'r' })).toContain('accept, rewrite or veto')
  expect(await decide({ proposal_id: pid, decision: 'accept', reason: '  ' })).toContain('reason is required')
  expect(await decide({ proposal_id: 'mp-nope', decision: 'accept', reason: 'r' })).toContain('no memory proposal mp-nope')
  expect(await decide({ proposal_id: pid, decision: 'rewrite', reason: 'r' })).toContain('rewrite needs `text`')
  expect(rows().filter(r => r.kind === 'memory_decision').length).toBe(0)                                  // nothing was recorded by a refusal
  expect(existsSync(mem)).toBe(false)                                                                      // and nothing was written
})

test('D1: accept writes the memory the normal way (file with frontmatter, MEMORY.md line, a commit in the main\'s name) and records memory_decision', async () => {
  writeFileSync(join(dir, 'ledger.jsonl'), '')                                                             // a clean ledger for this test
  const j = run('telegram', 'joey', 'joey')
  const pid = idOf(await L.callLaneTool(j, 'ledger_write', { kind: 'memory_proposal', text: RULE }))
  const out = await decide({ proposal_id: pid, decision: 'accept', reason: 'Joey 明說要記住，範圍就是他說的這句' })
  expect(out).toContain('accepted'); expect(out).toContain(`decision_${pid}.md`)
  const f = readFileSync(join(mem, `decision_${pid}.md`), 'utf8')
  expect(f).toStartWith(`---\nname: ${pid}\n`); expect(f).toContain('metadata:\n  type: feedback'); expect(f).toContain('一律 09:00'); expect(f).toContain('**Why:** Joey 明說要記住')
  expect(readFileSync(join(mem, 'MEMORY.md'), 'utf8')).toContain(`- [${pid}](decision_${pid}.md) — `)
  expect(git('log', '-1', '--format=%an|%s')).toBe(`adam.main|memory: decision_${pid}.md`)
  const d = rows().find(r => r.kind === 'memory_decision')!
  expect(d).toMatchObject({ lane: 'main', thread: j.lane.replace('adam.worker.', 'adam#t-d1'), refs: { proposal_id: pid, decision: 'accept', writer: 'adam.main', file: `decision_${pid}.md`, joey: true } })
  expect(d.text).toContain('採納')
  expect(openJoey()).not.toContain(pid)
  expect(await decide({ proposal_id: pid, decision: 'veto', reason: 'again' })).toContain('already decided (accept)')       // one decision per proposal
})

test('D1: rewrite writes the main\'s text instead; veto writes nothing and keeps the reason; the proposal text with a review note is cut at the note', async () => {
  const j = run('telegram', 'joey', 'joey')
  const p1 = idOf(await L.callLaneTool(j, 'ledger_write', { kind: 'memory_proposal', text: RULE }))
  expect(await decide({ proposal_id: p1, decision: 'rewrite', reason: '範圍只限 mock 服務的例行排程', text: 'mock 服務的例行排程固定在 09:00；維護窗口與備份時段不在此列。' })).toContain('rewritten')
  expect(readFileSync(join(mem, `decision_${p1}.md`), 'utf8')).toContain('維護窗口與備份時段不在此列'); expect(readFileSync(join(mem, `decision_${p1}.md`), 'utf8')).not.toContain('不要再改')
  expect(rows().find(r => r.kind === 'memory_decision' && r.refs.proposal_id === p1)!.refs).toMatchObject({ decision: 'rewrite', rewritten_from: expect.stringContaining('不要再改') })
  const p2 = idOf(await L.callLaneTool(j, 'ledger_write', { kind: 'memory_proposal', text: '以後所有備份都改成每小時' }))
  const before = git('rev-list', '--count', 'HEAD')
  expect(await decide({ proposal_id: p2, decision: 'veto', reason: '只有一個來源，且與 runbook 衝突' })).toContain('vetoed')
  expect(existsSync(join(mem, `decision_${p2}.md`))).toBe(false); expect(git('rev-list', '--count', 'HEAD')).toBe(before)
  expect(rows().find(r => r.kind === 'memory_decision' && r.refs.proposal_id === p2)!.refs).toMatchObject({ decision: 'veto', reason: '只有一個來源，且與 runbook 衝突', file: null })
  expect(L.mainToolDefs().find((t: any) => t.name === 'ledger_query').inputSchema.properties.kind.description).toContain('memory_decision')
})

test('D1: the digest lists every open Joey-sourced proposal again (no new activity needed) until a decision exists; it never wakes the main; a mesh proposal is not re-listed', async () => {
  writeFileSync(join(dir, 'ledger.jsonl'), '')
  // PL1: proposals live on M3 records, not in the ledger file: the earlier tests' open ones are decided first (the clean start this test needs)
  for (const r of L.__events().rows(x => Array.isArray(x.proposals))) for (const p of r.proposals) if (!p.decision) await decide({ proposal_id: p.id, decision: 'veto', reason: 'test reset' })
  { const t0 = L.__digest(); if (t0) L.__journal().write('msg', `dg-d1-reset`, 'done', { kind: 'digest', events: t0.fields.events }) }
  const j = run('telegram', 'joey', 'joey')
  const pid = idOf(await L.callLaneTool(j, 'ledger_write', { kind: 'memory_proposal', text: RULE }))
  const e = run('mesh', 'eve', 'peer', 'reflex')
  const eid = idOf(await L.callLaneTool(e, 'ledger_write', { kind: 'memory_proposal', text: 'Eve 的稿件排程一律 10:00' }))
  // the digest is M1 information (L.__digest: what rides the next delivery); an open Joey proposal is a line owed to the main in every digest until decided
  const ack = (t: any) => { if (t) L.__journal().write('msg', `dg-d1-${Date.now()}`, 'done', { kind: 'digest', events: t.fields.events }) }
  const t1 = L.__digest()!
  expect(t1.text).toContain(`記憶提案 ${pid}｜`); expect(t1.text).toContain('還沒決定（Joey 說的話）'); expect(t1.text).toContain('需主線：用 memory_decide 決定'); expect(t1.text).toContain('一律 09:00')
  expect(t1.text).toContain(`記憶提案待決定：${eid}`); expect(t1.text).not.toContain(`記憶提案 ${eid}｜`)      // 002u: Eve's shows its id on its event's line, once (not a standing line)
  ack(t1)
  expect(L.__main().items(r => r.kind !== 'digest').length).toBe(0)                                        // nothing is owed to the main: a proposal never wakes it
  expect(L.__digest()!.text).toContain(pid)                                                                // nothing new, but the next delivery carries it again
  expect(L.__digest()!.text).not.toContain(eid)                                                            // Eve's was not said by Joey: not re-listed
  await decide({ proposal_id: pid, decision: 'veto', reason: '先不記' })
  expect(L.__digest()).toBeNull()                                                                          // decided: gone, and a quiet record gives no digest
})

test('002u: every proposal shows the id memory_decide takes where its description says it is: the event\'s line (digest, activity list) and ledger_query(kind=memory_proposal)', async () => {
  // zero-token D01/D03 probe (u002t-Z93): Eve's proposal was 「記憶提案 1 筆待決定」 in the digest and the lane's text alone in ledger_query; no surface named
  // its id, so the main could not decide it (memory_decide refuses without one)
  writeFileSync(join(dir, 'ledger.jsonl'), '')
  const e = run('mesh', 'eve', 'peer', 'reflex')
  L.__events().open(e.evId, { class: 'peer', owner: e.lane, lane: e.lane, thread: st.lanes[e.lane].thread, from: 'eve', text: 'x', obligations: [] })
  const eid = idOf(await L.callLaneTool(e, 'ledger_write', { kind: 'memory_proposal', text: 'Eve 的稿件排程一律 10:00' }))
  expect(L.activityList(undefined)).toContain(`記憶提案待決定：${eid}`)
  const q = L.ledgerQueryTool({ kind: 'memory_proposal' })
  expect(q).toContain(`｜${eid}｜Eve 的稿件排程一律 10:00`)
  const out = await decide({ proposal_id: eid, decision: 'veto', reason: 'Eve 的稿件排程不是 adam 的規則' })
  expect(out).toContain(`vetoed: ${eid}`)
  expect(L.ledgerQueryTool({ kind: 'memory_decision' })).toContain(`｜${eid}｜記憶提案 ${eid}：否決`)       // the decision row names it too
  expect(L.activityList(undefined)).not.toContain(`記憶提案待決定：${eid}`)                               // decided: no longer open on its line
})

test('D1: while the curator holds the write right accept is refused and veto is not; when it hands the right back, the Joey-sourced proposals it was given are closed as curated', async () => {
  writeFileSync(join(dir, 'ledger.jsonl'), '')
  const j = run('telegram', 'joey', 'joey')
  const pid = idOf(await L.callLaneTool(j, 'ledger_write', { kind: 'memory_proposal', text: RULE }))
  const cid = 'adam.curator.9'
  st.lanes[cid] = { id: cid, kind: 'curator', n: 9, session_id: 's', thread: 'adam#t-cur9', status: 'running', created: '', last: '', transcript: '/x', runs: 0, tokens_in: 0, tokens_out: 0 } as any
  st.threads['adam#t-cur9'] = { id: 'adam#t-cur9', lane: cid, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
  st.curator = { lane: cid, since: new Date().toISOString(), given: [pid] } as any                         // PL1: the proposals it was given (M3 ids), not ledger line ranges
  const refused = await decide({ proposal_id: pid, decision: 'accept', reason: 'r' })
  expect(refused).toContain('curator lane adam.curator.9 holds the memory write right'); expect(existsSync(join(mem, `decision_${pid}.md`))).toBe(false)
  const ct = { runId: `${cid}.r1`, lane: cid, evId: 'ev-cur', closers: [], critical: false, trigger: 'curator', cls: 'curator', escalated: false, pushed: false } as any
  expect(await L.callLaneTool(ct, 'curator_done', { summary: '寫進 feedback_schedule.md' })).toContain('returned')
  const d = rows().find(r => r.kind === 'memory_decision')!
  expect(d).toMatchObject({ lane: cid, refs: { proposal_id: pid, decision: 'curated', writer: cid, joey: true } }); expect(d.refs.reason).toContain('feedback_schedule.md')
  expect(openJoey()).not.toContain(pid)
  expect(L.__events().get(j.evId)!.proposals.find((p: any) => p.id === pid)).toMatchObject({ decision: 'curated', writer: cid })   // PL1: its state is on the M3 record
})
