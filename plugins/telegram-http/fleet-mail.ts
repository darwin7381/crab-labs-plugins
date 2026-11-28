// fleet — the second MCP server of the agent-inbox plugin (WO-91 收件分級第一段).
//
// Why a second server: Claude Code silently truncates each MCP server's instructions at 2048 chars
// (measured 2026-11-06; see server.ts). agent-inbox's own instructions (trust, disclosure, closing) were
// ~1.9k when this server was split off, and the fleet's main text (FLEET_TEXT, Chiron's words, verbatim) ~1.3k. Each server
// gets its own budget, so the main text rides here, with the tools it talks about: call, mail, mailbox.
//
// Stateless streamable HTTP with JSON responses (POST /fleet on the agent-inbox daemon): no session,
// no SSE, never a channel — inbound delivery stays on the agent-inbox server alone, so nothing is
// dispatched twice. Mail lives in BTCC (/api/mesh/mail/*); the feed wall (WO-92) lives in Fleet Core
// (core.kbro.ai /api/feed/*). The daemon calls both with this agent's own mesh credential, so the sender
// is whoever the credential says, never a name in the body. The wall never pushes: these tools are the
// only way anything on it reaches an agent, and only when the agent asks.
import { FLEET_TEXT, withOnsenFormat } from './fleet-text.ts'
import { recipientNote } from './onsen-inbox.ts'

export const FLEET_INSTRUCTIONS = FLEET_TEXT
const TITLE_MAX = 50   // Joey TG chiron:1407: 50, and longer is cut by the server, never refused
const CUT_NOTE = `標題超過 ${TITLE_MAX} 字，已截短，完整標題在內容第一行。`

export type BtccCall = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; json: any }>
export type CoreCall = (method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number) => Promise<{ status: number; json: any }>
export type CallFn = (to: string, text: string, replyTo?: number, noReply?: boolean, op?: string, call?: string) => Promise<string>
export type CallReply = { reply_to: string; call: string }
export interface FleetDeps {
  call: CallFn; btcc: BtccCall; core: CoreCall
  callReply?: (to: string, replyTo: unknown) => Promise<CallReply | null>
  /** WO-124: who opens mail through these tools. 'lane' = the agent's mail lane (lanes mode): its open is 車道讀過, not 主線已讀 */
  openBy?: 'lane'
  /** WO-126: the lane (lane.id) calling, when openBy is 'lane': a lane item or a card names it */
  lane?: string
  /** WO-126: hand the mail_decision event to the lane router (the agent-inbox daemon's mail-events queue). Absent = lanes off: the main does it itself */
  mailEvent?: (decided: any) => Promise<'handed' | 'queued'>
}
const TOUCH_MAX = 5

/** WO-167: the feed wall's primary is Onsen's (Fleet Core /api/onsen/feed/*: the same endpoints, request and response shapes, on the same host,
 *  with the same credential; fleet-core onsen_feed.py). The tools here always name /api/feed/*; server.ts coreFeed sends each call through
 *  this, with FEED_ONSEN=1 (machine config) as `onsen`. Off: the path as given, exactly as before. */
export function feedPath(path: string, onsen: boolean): string {
  if (!onsen || !/^\/api\/feed(?=$|[/?])/.test(path)) return path
  return `/api/onsen/feed${path.slice('/api/feed'.length)}`
}

export const FLEET_TOOLS = [
  {
    name: 'call',
    description: '呼叫。內容立刻送進對方的 session，它會放下手上的事先看。回一則呼叫時帶 reply_to，回覆自動標不用回。只在有結果、做不了、或要對方補東西時回；只是『收到、我會做』就不送（對方會被叫醒一個回合，卻沒有東西可用）。',
    inputSchema: {
      type: 'object',
      required: ['to', 'text'],
      properties: {
        to: { type: 'string', description: '給誰（艦隊名冊裡的 agent 名）' },
        text: { type: 'string', description: '一句話。最多 3500 字' },
        reply_to: { type: 'string', description: '回覆某一則呼叫時，帶那一則的 btcc_msg_id（回覆自動不用回）' },
        op: { type: 'string', description: '選填：任務站（OP-3、3 或 slug）' },
      },
    },
  },
  {
    name: 'send_mail',
    description: '寄信。放進對方的信箱，它一小時內會讀；它打開時你查得到已讀。標題 50 字內（誰、對什麼、要它做什麼），超過自動截短。沒填期限是一天，到期它還沒讀你會收到一封信。對方信箱還沒開時會直接送進它的 session。',
    inputSchema: {
      type: 'object',
      required: ['to', 'title', 'body'],
      properties: {
        to: { type: 'string', description: '給誰。也可以寄給自己' },
        title: { type: 'string', description: `標題，${TITLE_MAX} 字內：誰、對什麼、要什麼。對方先看到的只有這一行。超過會自動截短，完整標題放進內容第一行` },
        body: { type: 'string', description: '內容。最多 3500 字' },
        deadline: { type: 'string', description: '選填：期限，ISO-8601 時間或「幾小時後」的數字；沒填＝一天。到期對方還沒讀，你會收到一封信' },
        no_reply: { type: 'boolean', description: '只是要它知道（它不用做事、不用回答）就標 true' },
        op: { type: 'string', description: '選填：跟任務站有關的信帶它的編號（OP-3、3 或 slug），信會出現在那個任務站的時間軸上' },
      },
    },
  },
  {
    name: 'mailbox_list',
    description: '看信箱清單，一封一行，不含內容；看清單不算讀。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mailbox_open',
    description: '打開一封信讀全文；打開就算已讀，寄的人看得到。',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'integer', description: '信的編號' } } },
  },
  {
    name: 'mailbox_check',
    description: '勾掉一封信，從清單收起來；不代表事情做完。',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
  },
  {
    name: 'mailbox_reply',
    description: '回信給原寄件人，自動連到原信、自動標不用回。',
    inputSchema: {
      type: 'object',
      required: ['id', 'body'],
      properties: {
        id: { type: 'integer', description: '要回的那封信的編號' },
        body: { type: 'string', description: withOnsenFormat('內容。最多 3500 字') },   // WO-164 (Chiron 21:10Z): Onsen's text format (fleet-text.ts)
        title: { type: 'string', description: `選填：標題（${TITLE_MAX} 字內，超過會自動截短）；沒填是「回覆：原標題」` },
      },
    },
  },
  {
    name: 'mail_sent',
    description: '查自己寄出的信對方讀了沒。',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } } },
  },
  {
    name: 'feed_post',
    description: '貼動態。貼到牆上，不通知任何人。填標題（50 字內）、動到什麼（touches，最多 5 個詞）、連動的工單（ref）、取代哪一則（supersedes）。貼了不能改，寫錯就再貼一則並填 supersedes。',
    inputSchema: {
      type: 'object',
      required: ['title', 'body'],
      properties: {
        title: { type: 'string', description: `標題，${TITLE_MAX} 字內：誰、對什麼、做了什麼或什麼變了。別人和 Jev 先靠這一行判斷跟自己有沒有關。超過會自動截短，完整標題放進全文第一行` },
        body: { type: 'string', description: '全文：內容、細節、數字。打開才讀得到' },
        touches: { type: 'array', items: { type: 'string' }, maxItems: TOUCH_MAX, description: `選填：動到什麼，最多 ${TOUCH_MAX} 個詞（機器、服務、網域、檔名）。搜尋和 Jev 最常靠這一欄對上` },
        ref: { type: 'string', description: '選填：連動的工作，一個編號（WO-n、OP-n 或警報編號）' },
        supersedes: { type: 'integer', description: '選填：這一則取代哪一則（編號）。舊的那一則會標成被取代，不再交給 Jev' },
        links: { type: 'array', items: { type: 'string' }, maxItems: 10, description: '選填：連結' },
      },
    },
  },
  {
    name: 'feed_ask',
    description: '問牆。一句話寫你要處理什麼；跟它有關、你還沒讀過的貼文會給你：少的直接給全文（給了就算讀過）；多的先給一行一則的短卡，要讀哪幾則用 feed_open 打開（打開才算讀過）。',   // WO-167 (Chiron 01:14Z, his words)
    inputSchema: {
      type: 'object',
      required: ['about'],
      properties: {
        about: { type: 'string', description: '一句話：你要處理什麼，或想知道什麼。例：「要改 Cloudflare 上 ton 開頭那幾個網域的設定」' },
        cursor: { type: 'string', description: '看下一頁短卡時帶上一頁給的那個值。' },   // WO-167 section four (c); words: Chiron 01:14Z
      },
    },
  },
  {
    name: 'feed_search',
    description: '用一到幾個詞搜牆上的貼文（讀過的也列，只給短卡，要讀用 feed_open）；開工前看跟這件事有關、還沒讀過的，用 feed_ask。',   // WO-146 (Chiron)
    inputSchema: {
      type: 'object',
      required: ['q'],
      properties: {
        q: { type: 'string', description: '一到幾個詞，空白分隔，全部都要對上' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多列幾則（預設 20）' },
      },
    },
  },
  {
    name: 'feed_open',
    description: '打開一則。',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'integer', description: '貼文編號' } } },
  },
]

// ── WO-126: decision cards (seam claude-epeius/knowledge/lane-mailbox-seam.md v2; Joey TG chiron:2095) ──────────────────
// The main's mailbox is the one list of what waits on the main's decision. A lane opens an item there (decide_later) or the mail lane puts a
// card on a colleague's mail (mailbox_card); the main answers once (mailbox_decide); the agent-inbox daemon hands the answer to the router.
const CARD_PROPS = {
  decide: { type: 'string', description: '要主線決定什麼，一句' },
  deadline: { type: 'string', description: '選填：決定的期限，ISO-8601 或「幾小時後」；沒填＝分身的件 1 小時、同事的信照信的期限' },
  facts: { type: 'string', description: '關鍵事實與出處；長的寫成檔，這裡放檔案位置' },
  recommend: { type: 'string', description: '你的建議，一句' },
  basis: { type: 'string', description: '建議的根據' },
  then: { type: 'string', description: '主線說好之後你會做什麼' },
}
export const CARD_SCHEMA = { type: 'object', required: ['decide', 'recommend'], properties: CARD_PROPS }
export const DECIDE_TOOL = {
  name: 'mailbox_decide',
  description: '回一件等你決定的事（信箱清單上帶「要你決定」的那幾件）：照建議、改成…、或不做。只能回一次；回了，放這件的分身接著做完並向 Joey 回報。',
  inputSchema: {
    type: 'object',
    required: ['id', 'decision'],
    properties: {
      id: { type: 'integer', description: '那一件的編號' },
      decision: { type: 'string', enum: ['as_recommended', 'changed', 'declined'], description: 'as_recommended 照建議｜changed 改成（note 寫改成什麼）｜declined 不做' },
      note: { type: 'string', description: 'changed 必填：改成什麼；另外兩種可以補一句' },
    },
  },
}
/** the lanes' two calls (Sonn's decide_later and mailbox_card reach them through /lanes/mail-tool with openBy 'lane') */
export const LANE_DECIDE_LATER_TOOL = {
  name: 'decide_later',
  description: '把一件要主線決定的事放進主線的信箱（附決定卡），主線回決定後交回你這條線接著做。同一件事只開一次（ref）。',
  inputSchema: {
    type: 'object',
    required: ['title', 'card'],
    properties: {
      title: { type: 'string', description: '50 字內：誰、對什麼、要主線決定什麼' },
      card: CARD_SCHEMA,
      deadline: { type: 'string', description: '選填：期限，ISO-8601 或「幾小時後」；沒填是 1 小時' },
      ref: { type: 'string', description: '這件事的事件 id；同一個 ref 只能開一件' },
      thread: { type: 'string', description: '這條線的對話 id（決定回來時照它找接手的線）' },
    },
  },
}
export const MAILBOX_CARD_TOOL = {
  name: 'mailbox_card',
  description: '在一封要主線決定的同事來信上附決定卡。每封只能附一張；寄件人看到的狀態不會因此多任何字。',
  inputSchema: {
    type: 'object',
    required: ['id', 'card'],
    properties: { id: { type: 'integer', description: '信的編號' }, card: CARD_SCHEMA, thread: { type: 'string', description: '這條線的對話 id' } },
  },
}
const DECISION_WORDS: Record<string, string> = { as_recommended: '照建議', changed: '改成', declined: '不做' }
const decisionText = (d: string, note?: string | null) => d === 'changed' ? `改成：${note ?? ''}` : `${DECISION_WORDS[d] ?? d}${note ? `（${note}）` : ''}`
/** one card, the five boxes, for mailbox_open */
function cardBlock(m: any): string {
  const c = m.card ?? {}
  const who = m.from_lane ? `分身 ${m.from_lane} 放的件` : `${m.card_lane ?? '車道'} 附的卡`
  const out = [`── 決定卡（${who}，${hm(m.card_at)}）──`, `要你決定：${c.decide ?? ''}`, `期限：${hm(c.deadline)}`]
  if (c.facts) out.push(`關鍵事實：${c.facts}`)
  out.push(`建議：${c.recommend ?? ''}`)
  if (c.basis) out.push(`根據：${c.basis}`)
  if (c.then) out.push(`說好之後：${c.then}`)
  out.push(m.decision ? `已決定（${hm(m.decided_at)}）：${decisionText(m.decision, m.note)}` : '用 mailbox_decide 回：照建議（as_recommended）、改成…（changed＋note）、不做（declined）。')
  return out.join('\n')
}

const text = (s: string, isError = false) => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) })

function hm(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return String(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`
}

function hoursOrIso(v: unknown): string | number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v === 'number') return v
  const s = String(v).trim()
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s
}

/** WO-173: a lane's read of a mail names the lane, so Onsen records which session read it first (v1 read_by_session). Onsen 0.17.1+ reads `lane`;
 *  an older Onsen or BTCC ignores it, and the read itself never depends on it. */
export const laneOpenQuery = (lane?: string): string => lane ? `?by=lane&lane=${encodeURIComponent(lane)}` : '?by=lane'

/** WO-128 (telegram-http 1.41.0, Chiron on the ticket 2026-11-24 13:00Z): the card always carries a deadline, since the due wake is 15 minutes before it:
 *  the card's own; else the mail's (BTCC falls back to it); a mail without one (a program's mail, e.g. a board notice: 「期限 —」): `hours` from now. BTCC
 *  would give that card `mail_deadline_h` (24) and the main would not be woken for a day. Only when the lanes ask for it (`default_deadline_h`, sent with
 *  LANES_DEFER_DECISIONS on); the mail is read by=lane (the card makes it lane_read anyway). Unreadable: `hours` from now (an early wake, never none). */
async function cardDeadline(id: number, card: any, hours: unknown, deps: FleetDeps): Promise<any> {
  const h = Number(hours)
  if (!(h > 0) || (card.deadline != null && String(card.deadline).trim() !== '')) return card
  const m = await deps.btcc('GET', `/api/mesh/mail/${id}${laneOpenQuery(deps.lane)}`).catch(() => null)
  if (m?.status === 200 && m.json?.deadline) return card
  return { ...card, deadline: new Date(Date.now() + h * 3600_000).toISOString() }
}

function intId(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10)
  return Number.isInteger(n) && n > 0 ? n : null
}
/** WO-175 item 2 (Chiron 10:27Z): a call's reply_to names what it answers in any of the three forms an agent sees: a BTCC number, an event id (mesh-…),
 *  a delivery's did (m-…). Each is a reply alike: no `because`, marked no_reply; the router finds the Call from it (lanes.ts callAnswered) */
export function isReplyRef(v: unknown): boolean {
  return intId(v) != null || /^(mesh|m|item)-[A-Za-z0-9_-]{1,80}$/.test(String(v ?? '').trim())
}

function errText(r: { status: number; json: any }): string {
  const d = r.json?.detail
  return typeof d === 'string' ? d : `BTCC ${r.status}`
}

function coreErr(r: { status: number; json: any }): string {
  const d = r.json?.detail
  return typeof d === 'string' ? d : `艦隊核心 ${r.status}`
}

function card(p: any): string {
  const extra: string[] = []
  if (p.touches?.length) extra.push(`動到：${p.touches.join('、')}`)
  if (p.ref) extra.push(`連動：${p.ref}`)
  if (p.supersedes) extra.push(`取代 #${p.supersedes}`)
  let s = `#${p.id}｜${hm(p.time)}｜${p.author}｜${p.title}`
  if (p.superseded_by) s += `｜已被 #${p.superseded_by}（${p.superseded_by_author}）取代`
  if (p.read === true && !('body' in p)) s += '｜讀過'
  return extra.length ? `${s}\n　${extra.join('　')}` : s
}

/** WO-167 (Chiron 01:14Z item 18): the full text's first line is the post's own `line`, the same as on the card route, so a post has one
 *  number and one way of writing time. An Onsen that doesn't send `line` yet: the old card. */
function full(p: any): string {
  const head = typeof p.line === 'string' && p.line.trim() ? p.line : card(p)
  return `${head}\n\n${p.body}${p.links?.length ? `\n${p.links.join('\n')}` : ''}`
}

const ASK_TIMEOUT_MS = 20000

/** WO-167 section four (c), Chiron 00:27Z (Joey TG 1263: first the notices, then the full text): more related posts than the wall gives in
 *  full (give_max) → Onsen answers with each one's line only (newest first, a page at a time), nothing given in full and nothing marked;
 *  the agent opens what it needs with feed_open. A server before this answers without `mode`, and the old rendering below is used. */
function askLines(j: any): string {
  const lines = (j.lines ?? []) as any[]
  const from = Number(j.offset ?? 0)
  const head = from === 0
    ? `跟這件事有關的有 ${j.related} 則，比一次給全文的 ${j.give_max} 則多，先給短卡（新的在前；列出短卡不算讀）：`
    : `接著的短卡（第 ${from + 1}–${from + lines.length} 則，共 ${j.related} 則）：`
  const tail = ['要讀哪幾則，用 feed_open 打開（打開才算讀過）。']
  if (j.next_cursor) tail.push(`還有 ${Math.max(0, j.related - from - lines.length)} 則短卡：再用 feed_ask，about 照填，加 cursor「${j.next_cursor}」看下一頁。`)
  if (from === 0 && j.unjudged) tail.push(`另外 ${j.unjudged} 則 Jev 沒判到，可以用 feed_search 找。`)
  return [head, ...lines.map((x: any) => String(x.line)), '', ...tail].join('\n')
}
// A post counts as read only when its text reached the agent. The tool result carries an `_afterSend`
// hook instead of marking anything; the /fleet route runs it only after the HTTP response has been
// handed to the agent's socket ('finish'). A request the agent dropped (timeout, interrupt, disconnect)
// never finishes, so nothing it did not get is marked; worst case a post is offered twice.
export type AfterSend = () => Promise<void>
function afterSendRead(deps: FleetDeps, ids: number[], via: 'ask' | 'open'): AfterSend {
  return async () => {
    const r = await deps.core('POST', '/api/feed/read', { ids, via })
    if (r.status !== 200) throw new Error(`feed read-mark ${via} ${ids.join(',')}: ${r.status}`)
  }
}
const withAfter = (result: any, after?: AfterSend) => (after ? Object.assign(result, { _afterSend: after }) : result)

/** Pull the after-send hooks out of RPC responses (so they never reach the wire). */
export function takeAfterSend(responses: any[]): AfterSend[] {
  const out: AfterSend[] = []
  for (const r of responses) {
    const f = r?.result?._afterSend
    if (typeof f === 'function') { out.push(f); delete r.result._afterSend }
  }
  return out
}

/** a call's answer that is not an error: delivered, or (WO-158) queued in the recipient's Onsen inbox while its daemon is not polling (server.ts sendToAgent) */
const SENT_RE = /^(delivered|queued in )/
async function sendCall(args: Record<string, unknown>, deps: FleetDeps) {
  const to = String(args.to ?? '').trim(), message = String(args.text ?? '').trim()
  const match = to ? await deps.callReply?.(to, args.reply_to) : null
  const ref = has(args.reply_to) ? args.reply_to : match?.reply_to
  const answers = !!match || isReplyRef(ref)
  if (args.line === 'call' && !has(args.because) && !answers) return text(BECAUSE_MISSING, true)
  if (!to || !message) return text(args.line === 'call' ? 'line=call 要填 to、because、text。' : 'call: to 和 text 都要填', true)
  const body = args.line === 'call' && has(args.because) ? `因為：${String(args.because).trim()}\n${message}` : message
  const r = await deps.call(to, body, intId(ref) ?? undefined, answers || (args.line !== 'call' && args.no_reply === true), args.op ? String(args.op) : undefined, match?.call)
  return text(r, !SENT_RE.test(r))
}

export async function callTool(name: string, args: Record<string, unknown>, deps: FleetDeps) {
  switch (name) {
    case 'call': return sendCall({ to: args.to, text: args.text, reply_to: args.reply_to, op: args.op }, deps)
    case 'send_mail': {
      const to = String(args.to ?? '').trim()
      const title = String(args.title ?? '').trim()
      const body = String(args.body ?? '').trim()
      if (!to || !title || !body) return text('send_mail: to、title、body 都要填', true)
      const r = await deps.btcc('POST', '/api/mesh/mail/send', {
        to, title, body, deadline: hoursOrIso(args.deadline), no_reply: args.no_reply === true,
        ...(args.ask ? { ask: String(args.ask).trim() } : {}),
        ...(args.op ? { op: String(args.op) } : {}),
      })
      if (r.status !== 200) return text(`沒有寄出：${errText(r)}`, true)
      const j = r.json
      // WO-164 point 7 (Chiron 15:56Z): the recipient's state when the mail's answer carries it (onsen-inbox.ts recipientNote; nothing for other states)
      const opNote = (j.warning ? `（${j.warning}）` : '') + (j.title_truncated ? CUT_NOTE : '') + recipientNote(to, j.recipient)
      if (j.stored) return text(`已放進 ${to} 的信箱（#${j.id}）。它一小時內會知道有信；讀了沒用 mail_sent 查。${opNote}`)
      if (j.delivered) return text(`${to} 的信箱還沒開，這封照舊直接送進它的 session（#${j.id}）。${opNote}`)
      return text(`#${j.id} 記下了，但送不到 ${to}：${j.detail ?? '?'}`, true)
    }
    case 'mailbox_list': {
      const r = await deps.btcc('GET', '/api/mesh/mail/list')
      if (r.status !== 200) return text(`讀不到信箱：${errText(r)}`, true)
      const mail = (r.json.mail ?? []) as any[]
      if (!mail.length) return text('信箱是空的。')
      const unread = mail.filter(m => m.status === 'unread').length
      const laneRead = mail.filter(m => m.status === 'lane_read').length   // WO-124: the lane opened it, the main has not
      const st = (m: any) => m.status === 'unread' ? '未讀' : m.status === 'lane_read' ? `車道讀過 ${hm(m.lane_read_at)}（主線還沒打開）` : '已讀'
      // WO-126: a card's line says what to decide, by when, and the recommendation (the card's deadline, not the mail's)
      const line = (m: any) => m.card
        ? `#${m.id}｜${m.from_lane ? `${m.from}（分身 ${m.from_lane}）` : m.from}｜${m.title}｜要你決定：${m.card.decide}｜決定期限 ${hm(m.card.deadline)}｜建議：${m.card.recommend}`
          + (m.decision ? `｜已決定：${DECISION_WORDS[m.decision] ?? m.decision}` : '') + `｜等了 ${m.waited}${m.from_lane ? '' : `｜${st(m)}`}`
        : `#${m.id}｜${m.from}｜${m.title}${m.ask ? `｜要你：${m.ask}` : ''}｜期限 ${hm(m.deadline)}｜等了 ${m.waited}｜${st(m)}${m.no_reply ? '｜不用回' : ''}`
      const lines = mail.map(line)
      const head = laneRead
        ? `${unread} 封未讀、${laneRead} 封車道讀過（等主線）、${mail.length - unread - laneRead} 封已讀還沒勾掉：`
        : `${unread} 封未讀、${mail.length - unread} 封已讀還沒勾掉：`
      const waiting = mail.filter(m => m.card && !m.decision).length
      return text(`${head}${waiting ? `\n其中 ${waiting} 件等你決定（mailbox_decide 回）。` : ''}\n${lines.join('\n')}`)
    }
    case 'mailbox_open': {
      const id = intId(args.id)
      if (!id) return text('mailbox_open: id 要填信的編號', true)
      // WO-124: the mail lane's open is 車道讀過 (by=lane); the main's own open makes it read, even after the lane read it
      const r = await deps.btcc('GET', `/api/mesh/mail/${id}${deps.openBy === 'lane' ? laneOpenQuery(deps.lane) : ''}`)
      if (r.status !== 200) return text(errText(r), true)
      const m = r.json
      const who = deps.openBy === 'lane' ? '｜車道讀過（寄件人看到的是車道讀過，不是主線已讀）'
        : m.lane_read_at ? `｜車道 ${hm(m.lane_read_at)} 先讀過` : ''
      // a lane item's ask is its card's decide: shown once, on the card
      const head = `#${m.id} 來自 ${m.from}｜${m.title}\n${m.ask && !m.from_lane ? `要你：${m.ask}\n` : ''}期限 ${hm(m.deadline)}｜等了 ${m.waited}${m.no_reply ? '｜不用回' : ''}${m.reply_to_id ? `｜回覆 #${m.reply_to_id}` : ''}${who}`
      // WO-126: the card and the original; a lane item's body is its card, shown once
      if (m.card) return text(m.from_lane ? `${head}\n\n${cardBlock(m)}` : `${head}\n\n${cardBlock(m)}\n\n── 原信 ──\n${m.body}`)
      return text(`${head}\n\n${m.body}`)
    }
    case 'mailbox_check': {
      const id = intId(args.id)
      if (!id) return text('mailbox_check: id 要填信的編號', true)
      const r = await deps.btcc('POST', `/api/mesh/mail/${id}/check`, {})
      if (r.status !== 200) return text(errText(r), true)
      return text(`#${id} 勾掉了，不在清單上了。${r.json.was === 'unread' ? '（它還沒打開過，寄的人看到的是未讀。）' : r.json.was === 'lane_read' && deps.openBy !== 'lane' ? '（只有車道讀過，主線沒打開。）' : ''}`)
    }
    case 'mailbox_reply': {
      const id = intId(args.id)
      const body = String(args.body ?? '').trim()
      if (!id || !body) return text('mailbox_reply: id 和 body 都要填', true)
      const title = args.title ? String(args.title).trim() : undefined
      const r = await deps.btcc('POST', `/api/mesh/mail/${id}/reply`, { body, ...(title ? { title } : {}) })
      if (r.status !== 200) return text(`沒有寄出：${errText(r)}`, true)
      const j = r.json
      const cut = j.title_truncated ? CUT_NOTE : ''
      if (j.stored) return text(`回信放進對方信箱了（#${j.id}，不用回）。${cut}`)
      if (j.delivered) return text(`對方信箱還沒開，回信直接送進它的 session（#${j.id}，不用回）。${cut}`)
      return text(`回信 #${j.id} 記下了，但送不到對方：${j.detail ?? '?'}`, true)
    }
    case 'mail_sent': {
      const lim = intId(args.limit) ?? 20
      const r = await deps.btcc('GET', `/api/mesh/mail/sent?limit=${Math.min(lim, 50)}`)
      if (r.status !== 200) return text(errText(r), true)
      const rows = (r.json.sent ?? []) as any[]
      if (!rows.length) return text('你還沒有寄出過信。')
      return text(rows.map(m => {
        // WO-124: say who read it. A recipient without lanes never has lane_read_at: its lines are as before.
        const st = m.status === 'unread' ? '未讀'
          : m.status === 'lane_read' ? `車道讀過 ${hm(m.lane_read_at)}，主線還沒看`
          : m.status === 'read' ? (m.lane_read_at ? `主線已讀 ${hm(m.read_at)}（車道 ${hm(m.lane_read_at)} 先讀）` : `已讀 ${hm(m.read_at)}`)
          : m.status === 'checked' ? `勾掉了${m.read_at ? `（${m.lane_read_at ? '主線' : ''}已讀 ${hm(m.read_at)}）` : m.lane_read_at ? `（車道讀過 ${hm(m.lane_read_at)}，主線沒打開）` : '（沒打開過）'}`
          : m.status === 'pushed' ? '已直接送進 session（對方信箱沒開）' : String(m.status)
        return `#${m.id}｜給 ${m.to}｜${m.title}｜期限 ${hm(m.deadline)}｜${st}`
      }).join('\n'))
    }
    case 'mailbox_decide': {
      if (deps.openBy === 'lane') return text('只有主線回決定。這件做不下去，整件交給主線（handoff_main）；不能再開第二張卡。', true)
      const id = intId(args.id)
      const decision = String(args.decision ?? '').trim()
      if (!id || !decision) return text('mailbox_decide: id 和 decision 都要填（as_recommended｜changed｜declined）', true)
      const note = args.note != null && String(args.note).trim() ? String(args.note).trim() : undefined
      const r = await deps.btcc('POST', `/api/mesh/mail/${id}/decide`, { decision, ...(note ? { note } : {}) })
      if (r.status !== 200) return text(`沒有記下：${errText(r)}`, true)
      const j = r.json
      const said = `#${id} 記下決定：${decisionText(j.decision, j.note)}。`
      if (!deps.mailEvent) return text(`${said}車道沒開：照這個決定自己做完（回信、勾掉）。`)
      const how = await deps.mailEvent(j).catch(() => 'queued' as const)
      const who = j.lane ? `${j.lane}${j.thread ? `（${j.thread}）` : ''}` : '分身'
      return text(how === 'handed' ? `${said}已交給 ${who} 接著做完，它會向 Joey 回報。`
        : `${said}分流器現在連不上，決定排著，連上就交給 ${who}；不用再回一次。`)
    }
    case 'decide_later': case 'mailbox_card': {
      if (deps.openBy !== 'lane' || !deps.lane) return text(`${name} 是車道的工具；主線直接決定，或寄信給自己。`, true)
      const card = args.card && typeof args.card === 'object' ? args.card : null
      if (!card) return text(`${name}: card 要填（decide、recommend 必填；facts、basis、then、deadline 選填）`, true)
      const thread = args.thread ? String(args.thread).trim() : undefined
      if (name === 'decide_later') {
        const title = String(args.title ?? '').trim()
        const r = await deps.btcc('POST', '/api/mesh/mail/lane-item?by=lane', { lane: deps.lane, ...(thread ? { thread } : {}), title, card,
          ...(hoursOrIso(args.deadline) !== undefined ? { deadline: hoursOrIso(args.deadline) } : {}), ...(args.ref ? { ref: String(args.ref) } : {}) })
        if (r.status !== 200) return text(`沒有放進信箱：${errText(r)}`, true)
        return text(`放進主線的信箱了（#${r.json.id}，期限 ${hm(r.json.deadline)}）。主線回決定後，這件會交回 ${thread ?? deps.lane} 接著做。${r.json.title_truncated ? CUT_NOTE : ''}${r.json.card_truncated ? '卡上有格子超過 600 字，已截短；長的寫成檔、放位置。' : ''}`)
      }
      const id = intId(args.id)
      if (!id) return text('mailbox_card: id 要填信的編號', true)
      const r = await deps.btcc('POST', `/api/mesh/mail/${id}/card?by=lane`, { lane: deps.lane, ...(thread ? { thread } : {}), card: await cardDeadline(id, card, args.default_deadline_h, deps) })
      if (r.status !== 200) return text(`沒有附上：${errText(r)}`, true)
      return text(`#${id} 附上決定卡了（決定期限 ${hm(r.json.deadline)}）。主線的清單會列出它；主線回決定後交回這條線做完。${r.json.card_truncated ? '卡上有格子超過 600 字，已截短；長的寫成檔、放位置。' : ''}`)
    }
    case 'feed_post': {
      const title = String(args.title ?? '').trim()
      const body = String(args.body ?? '').trim()
      if (!title || !body) return text('feed_post: title 和 body 都要填', true)
      const touches = Array.isArray(args.touches) ? (args.touches as unknown[]).map(String).filter(Boolean) : []
      if (touches.length > TOUCH_MAX) return text(`「動到什麼」最多 ${TOUCH_MAX} 個詞（現在 ${touches.length} 個）。沒有貼出。`, true)
      const supersedes = args.supersedes != null && args.supersedes !== '' ? intId(args.supersedes) : undefined
      if (supersedes === null) return text('supersedes 要填貼文編號', true)
      const r = await deps.core('POST', '/api/feed/posts', {
        title, body, touches, ref: args.ref ? String(args.ref) : undefined, supersedes,
        links: Array.isArray(args.links) ? (args.links as unknown[]).map(String) : [],
      })
      if (r.status !== 200) return text(r.json?.detail && String(r.json.detail).startsWith('沒貼出') ? r.json.detail : `沒有貼出：${coreErr(r)}`, true)
      return text(`已貼出 #${r.json.id}${supersedes ? `（取代 #${supersedes}）` : ''}。不會通知任何人；之後處理相關事情的人問牆時找得到。${r.json.title_truncated ? CUT_NOTE : ''}`)
    }
    case 'feed_ask': {
      const about = String(args.about ?? '').trim()
      if (!about) return text('feed_ask: about 要填一句話：你要處理什麼', true)
      const cursor = args.cursor != null && String(args.cursor).trim() ? String(args.cursor).trim() : undefined
      // two_step: tells Onsen this daemon renders lines (a daemon that does not send it gets the full texts as before; an Onsen before it ignores it)
      const r = await deps.core('POST', '/api/feed/ask', { about, two_step: true, ...(cursor ? { cursor } : {}) }, ASK_TIMEOUT_MS)
      if (r.status === 403) return text(`${coreErr(r)}`, true)
      if (cursor && r.status === 400) return text(`${coreErr(r)}`, true)
      if (r.status !== 200) return text(`Jev 沒回，改用搜尋：牆現在問不了（${coreErr(r)}）。用 feed_search 給一到幾個詞，看短卡，再用 feed_open 打開要讀的。`)
      const j = r.json
      if (j.mode === 'lines') return text(askLines(j))      // nothing to mark: no full text was given
      if (!j.candidates) return text('牆上沒有你還沒讀過的貼文。')
      if (!['ok', 'partial'].includes(j.jev)) {
        return text('Jev 沒回，改用搜尋：用 feed_search 給一到幾個詞（搜全文加短卡），先看短卡，再用 feed_open 打開要讀的。')
      }
      const tail: string[] = []
      if (j.more) tail.push(`另有 ${j.more} 則有關的，再問一次接著給。`)
      if (j.unjudged) tail.push(`另外 ${j.unjudged} 則 Jev 沒判到，可以用 feed_search 找。`)
      if (!j.given?.length) return text([`Jev 看了 ${j.judged} 則你還沒讀過的貼文，沒有跟這件事有關的。`, ...tail].join('\n'))
      const head = `跟這件事有關的 ${j.given.length} 則（全文，新的在前；給了就算讀過）：`
      const body = [head, ...j.given.map(full)].join('\n\n———\n\n') + (tail.length ? `\n\n${tail.join('\n')}` : '')
      return withAfter(text(body), afterSendRead(deps, j.given.map((g: any) => g.id), 'ask'))
    }
    case 'feed_search': {
      const q = String(args.q ?? '').trim()
      if (!q) return text('feed_search: q 要填一到幾個詞', true)
      const lim = Math.min(intId(args.limit) ?? 20, 50)
      const r = await deps.core('GET', `/api/feed/search?q=${encodeURIComponent(q)}&limit=${lim}`)
      if (r.status !== 200) return text(`搜不到：${coreErr(r)}`, true)
      const cards = (r.json.cards ?? []) as any[]
      if (!cards.length) return text(`牆上沒有對上「${q}」的貼文。`)
      const head = r.json.total > cards.length ? `${r.json.total} 則對上，列出最新的 ${cards.length} 則：` : `${cards.length} 則：`
      return text(`${head}\n${cards.map(card).join('\n')}\n（列出短卡不算讀；要讀用 feed_open。）`)
    }
    case 'feed_open': {
      const id = intId(args.id)
      if (!id) return text('feed_open: id 要填貼文編號', true)
      const r = await deps.core('GET', `/api/feed/posts/${id}`)
      if (r.status !== 200) return text(coreErr(r), true)
      return withAfter(text(full(r.json)), r.json.read === true ? undefined : afterSendRead(deps, [id], 'open'))
    }
  }
  return text(`unknown tool: ${name}`, true)
}

// ── agent-inbox server tools (WO-99 v3, Joey TG chiron:1503) ─────────────────────────────────────────────────
// 「應該跟原本一樣叫 send to agent…只是這下面從一條線變成三條支線」: ONE sending tool, send_to_agent, whose
// required `line` picks feed / mail / call; mail must say what it asks for (ask), a call why it can't wait (because).
// The receiving tools stay, on the same server. Texts: Chiron's knowledge/a2a-rewrite-20261116/v3/, verbatim.
// The fleet server (/fleet, FLEET_TOOLS above) stays only for sessions started before this version (transition).
export const LINE_MISSING = '先填 line：這件事要不要某一隻動手、回答或決定？等一小時會不會壞？不需要誰動＝feed；要某一隻動、等得起＝mail；現在就要動＝call'
export const ASK_MISSING = '信要填 ask：要它做什麼、回答什麼、或決定什麼。填不出來，這一則是動態（line=feed）'
export const BECAUSE_MISSING = '呼叫要填 because：晚一小時什麼會壞，或誰正在等。填不出來，這一則是信（line=mail）'

export const SEND_TOOL = {
  name: 'send_to_agent',
  description: [
    '找別隻 agent 的唯一工具。每一次都要先填 line，走三條線的哪一條；怎麼判寫在 agent-inbox 的說明裡。',
    '- line=feed 動態：貼到牆上，不通知任何人。填 title（50 字內）、text；可填 touches（動到什麼，最多 5 個詞）、ref（連動的工單）、supersedes（取代哪一則）。貼了不能改，寫錯就再貼一則並填 supersedes。',
    '- line=mail 信：放進對方信箱，它一小時內會讀。填 to、title（50 字內：誰、對什麼、要它做什麼）、ask（要它做什麼、回答什麼、或決定什麼，一句）、text。可填 deadline（沒填是一天，到期它還沒讀你會收到一封信）、no_reply（它照做就好、不用回）。',
    '- line=call 呼叫：立刻送進對方的 session，它會放下手上的事先看。填 to、because（晚一小時什麼會壞，或誰正在等，一句）、text。回一則呼叫時帶 reply_to，回覆自動標不用回。只在有結果、做不了、或要對方補東西時回；只是『收到、我會做』就不送（對方會被叫醒一個回合，卻沒有東西可用）。',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    required: ['line', 'text'],
    properties: {
      line: { type: 'string', enum: ['feed', 'mail', 'call'], description: '必填，feed｜mail｜call。' },
      to: { type: 'string', description: 'mail、call 必填；feed 不填。' },
      title: { type: 'string', description: 'feed、mail 必填，50 字內，超過自動截短。' },
      text: { type: 'string', description: withOnsenFormat('必填。') },   // WO-164 (Chiron 21:10Z): Onsen's text format, every line (fleet-text.ts)
      ask: { type: 'string', description: 'mail 必填（一句）。' },
      because: { type: 'string', description: 'call 必填（一句）；帶 reply_to 的回覆不用填。' },
      deadline: { type: 'string', description: 'mail 選填。' },
      no_reply: { type: 'boolean', description: 'mail 選填。' },
      touches: { type: 'array', items: { type: 'string' }, maxItems: TOUCH_MAX, description: 'feed 選填。' },
      ref: { type: 'string', description: 'feed 選填。' },
      supersedes: { type: 'integer', description: 'feed 選填。' },
      reply_to: { type: 'string', description: 'call 選填。' },
      op: { type: 'string', description: '選填：任務站（OP-3、3 或 slug）。' },
    },
  },
}
const RECEIVE_NAMES = ['mailbox_list', 'mailbox_open', 'mailbox_check', 'mailbox_reply', 'mail_sent', 'feed_ask', 'feed_search', 'feed_open']
export const INBOX_TOOLS = [
  SEND_TOOL,
  ...FLEET_TOOLS.filter(t => RECEIVE_NAMES.includes(t.name)).map(t => t.name === 'mailbox_open'
    ? { ...t, description: '打開一封信讀全文；打開就算已讀，寄的人看得到。信的開頭顯示寄件人填的 ask。' } : t),
]

const has = (v: unknown) => v != null && String(v).trim() !== ''

/** send_to_agent: one tool, three lines. legacy = sessions started before WO-99 v3 are still around. */
export async function sendToAgent(args: Record<string, unknown>, deps: FleetDeps, legacy: boolean) {
  const line = String(args.line ?? '').trim()
  if (!line) {
    // a session started before this version holds the old send_to_agent (to, text, no_reply): a call, as before
    if (legacy && has(args.to) && has(args.text)) return sendCall(args, deps)
    return text(LINE_MISSING, true)
  }
  if (line === 'feed') {
    if (!has(args.title) || !has(args.text)) return text('line=feed 要填 title 和 text。', true)
    return callTool('feed_post', { title: args.title, body: args.text, touches: args.touches, ref: args.ref, supersedes: args.supersedes, links: args.links }, deps)
  }
  if (line === 'mail') {
    if (!has(args.ask)) return text(ASK_MISSING, true)
    if (!has(args.to) || !has(args.title) || !has(args.text)) return text('line=mail 要填 to、title、ask、text。', true)
    return callTool('send_mail', { to: args.to, title: args.title, body: args.text, ask: args.ask, deadline: args.deadline, no_reply: args.no_reply, op: args.op }, deps)
  }
  if (line === 'call') return sendCall({ ...args, line }, deps)
  return text(LINE_MISSING, true)
}

/** The agent-inbox server's tools/call. Old names (call, send_mail, feed_post) only while legacy is on. */
export async function callInboxTool(name: string, args: Record<string, unknown>, deps: FleetDeps, legacy: boolean) {
  if (name === 'send_to_agent') return sendToAgent(args, deps, legacy)
  if (RECEIVE_NAMES.includes(name)) return callTool(name, args, deps)
  if (name === DECIDE_TOOL.name || name === 'decide_later' || name === 'mailbox_card') return callTool(name, args, deps)   // WO-126 (the tool checks who calls)
  if (legacy && (name === 'call' || name === 'send_mail' || name === 'feed_post')) return callTool(name, args, deps)
  return text(`unknown tool: ${name}`, true)
}

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

/** One JSON-RPC message → its response, or null for a notification. */
export async function handleFleetRpc(m: any, deps: FleetDeps): Promise<any | null> {
  if (!m || typeof m !== 'object' || typeof m.method !== 'string') {
    return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'invalid request' } }
  }
  if (!('id' in m)) return null
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result })
  const params = m.params ?? {}
  switch (m.method) {
    case 'initialize': {
      const want = params.protocolVersion
      return ok({
        protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fleet', version: '1.0.0' },
        instructions: FLEET_INSTRUCTIONS,
      })
    }
    case 'ping':
      return ok({})
    case 'tools/list': {
      // feed_ask only for agents on the wall's ask list: the main text tells every agent to ask first,
      // so a tool that is listed but refused would cost each of them a wasted call per task.
      let ask = false
      try {
        const r = await deps.core('GET', '/api/feed/me', undefined, 1500)
        ask = r.status === 200 && r.json?.ask === true
      } catch {}
      return ok({ tools: FLEET_TOOLS.filter(t => t.name !== 'feed_ask' || ask) })
    }
    case 'tools/call':
      try {
        return ok(await callTool(String(params.name ?? ''), params.arguments ?? {}, deps))
      } catch (e) {
        return ok(text(`tool error: ${String(e).slice(0, 200)}`, true))
      }
  }
  return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } }
}
