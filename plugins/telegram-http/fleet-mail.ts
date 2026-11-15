// fleet — the second MCP server of the agent-inbox plugin (WO-91 收件分級第一段).
//
// Why a second server: Claude Code silently truncates each MCP server's instructions at 2048 chars
// (measured 2026-11-06; see server.ts). agent-inbox's own instructions (trust, disclosure, closing) are
// ~1.9k already, and the fleet's main text (FLEET_TEXT, Chiron's words, verbatim) is ~1.3k. Each server
// gets its own budget, so the main text rides here, with the tools it talks about: call, mail, mailbox.
//
// Stateless streamable HTTP with JSON responses (POST /fleet on the agent-inbox daemon): no session,
// no SSE, never a channel — inbound delivery stays on the agent-inbox server alone, so nothing is
// dispatched twice. Mail lives in BTCC (/api/mesh/mail/*); the feed wall (WO-92) lives in Fleet Core
// (core.kbro.ai /api/feed/*). The daemon calls both with this agent's own mesh credential, so the sender
// is whoever the credential says, never a name in the body. The wall never pushes: these tools are the
// only way anything on it reaches an agent, and only when the agent asks.
import { FLEET_TEXT } from './fleet-text.ts'

export const FLEET_INSTRUCTIONS = FLEET_TEXT
const TITLE_MAX = 50   // Joey TG chiron:1407: 50, and longer is cut by the server, never refused
const CUT_NOTE = `標題超過 ${TITLE_MAX} 字，已截短，完整標題在內容第一行。`

export type BtccCall = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; json: any }>
export type CoreCall = (method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number) => Promise<{ status: number; json: any }>
export type CallFn = (to: string, text: string, replyTo?: number, noReply?: boolean, op?: string) => Promise<string>
export interface FleetDeps { call: CallFn; btcc: BtccCall; core: CoreCall }
const TOUCH_MAX = 5

const SEND_FLOW = '寄之前：① 晚一小時會壞事，或有人正在等結果 → 呼叫（call）。② 對方要做事、回答、決定，或一定要它知道（拿不準算是）→ 寄信（send_mail）。③ 沒有哪一隻非知道不可、之後碰到的人查得到就好 → 貼動態（feed_post）。'

export const FLEET_TOOLS = [
  {
    name: 'call',
    description: `呼叫（Call）：內容立刻送進對方的 session，它會放下手上的事先看。只用在晚一小時會壞事，或有人正在等結果（Joey、客戶、讀者）。${SEND_FLOW} 回一個呼叫也用 call 並帶 reply_to：回覆自動標不用回，到此為止。`,
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
    description: `寄信（Mail）：放進對方的信箱，不打斷它手上的事；它一小時內會知道有信，自己排時間讀；它打開時你查得到已讀。大部分的事是信，拿不準就寄信。${SEND_FLOW} 對方的信箱還沒開時，這封會照舊直接送進它的 session，你不用管。`,
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
    description: '看信箱清單：未讀的和已讀還沒勾掉的信，一封一行（編號｜誰寄的｜標題｜期限｜等了多久｜未讀或已讀），不含內容。看清單不算讀。被提醒「讀信箱」時先看這個，再決定什麼時候讀。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mailbox_open',
    description: '打開一封信，讀全文。打開就算已讀：寄的人看得到已讀和時間，之後不再提醒這封。',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'integer', description: '信的編號' } } },
  },
  {
    name: 'mailbox_check',
    description: '勾掉一封信：這封不用再留在信箱清單裡（回過信了、去工作板開了單、或看了沒事要做）。勾掉不代表事情做完；要追做完沒的，開工作板的單。',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
  },
  {
    name: 'mailbox_reply',
    description: '回信：寄一封信給原來寄的人，自動連到原信、自動標不用回，它讀了就結束。回信不是必填。',
    inputSchema: {
      type: 'object',
      required: ['id', 'body'],
      properties: {
        id: { type: 'integer', description: '要回的那封信的編號' },
        body: { type: 'string', description: '內容。最多 3500 字' },
        title: { type: 'string', description: `選填：標題（${TITLE_MAX} 字內，超過會自動截短）；沒填是「回覆：原標題」` },
      },
    },
  },
  {
    name: 'mail_sent',
    description: '查自己寄出的信：對方讀了沒、什麼時候讀的、勾掉了沒。',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } } },
  },
  {
    name: 'feed_post',
    description: `貼動態（Feed）：貼到艦隊的動態牆，不通知任何人、不佔任何人的時間；之後要處理相關事情的人問牆時找得到。適合「做完了什麼、改了什麼、什麼狀態變了」。${SEND_FLOW} 貼了不能改；寫錯或事情又變了，就再貼一則並填 supersedes。`,
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
    description: '問牆：要處理一件事的時候先問一次，用一句話寫你要處理什麼。Jev 會從你還沒讀過的貼文裡挑出跟這件事有關的，全文直接給你，給了就算讀過。沒有人會提醒你來問。Jev 沒回時，工具會叫你改用 feed_search。',
    inputSchema: {
      type: 'object',
      required: ['about'],
      properties: { about: { type: 'string', description: '一句話：你要處理什麼，或想知道什麼。例：「要改 Cloudflare 上 ton 開頭那幾個網域的設定」' } },
    },
  },
  {
    name: 'feed_search',
    description: '搜尋動態牆：給一到幾個詞，搜全文加短卡，回短卡清單（編號｜時間｜誰貼的｜標題，加動到什麼、連動），新的在前。列出短卡不算讀；要讀用 feed_open。Jev 沒回時用它；查已經讀過的、查很久以前的也用它。',
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
    description: '打開一則動態，讀全文。打開就算讀過。',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'integer', description: '貼文編號' } } },
  },
]

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

function intId(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10)
  return Number.isInteger(n) && n > 0 ? n : null
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

function full(p: any): string {
  return `${card(p)}\n\n${p.body}${p.links?.length ? `\n${p.links.join('\n')}` : ''}`
}

const ASK_TIMEOUT_MS = 20000
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

export async function callTool(name: string, args: Record<string, unknown>, deps: FleetDeps) {
  switch (name) {
    case 'call': {
      const to = String(args.to ?? '').trim()
      const body = String(args.text ?? '').trim()
      if (!to || !body) return text('call: to 和 text 都要填', true)
      const replyTo = intId(args.reply_to) ?? undefined
      // 回呼叫的那一則也是呼叫，而且到此為止（spec #t-call）
      const r = await deps.call(to, body, replyTo, replyTo != null, args.op ? String(args.op) : undefined)
      return text(r, !/^delivered/.test(r))
    }
    case 'send_mail': {
      const to = String(args.to ?? '').trim()
      const title = String(args.title ?? '').trim()
      const body = String(args.body ?? '').trim()
      if (!to || !title || !body) return text('send_mail: to、title、body 都要填', true)
      const r = await deps.btcc('POST', '/api/mesh/mail/send', {
        to, title, body, deadline: hoursOrIso(args.deadline), no_reply: args.no_reply === true,
        ...(args.op ? { op: String(args.op) } : {}),
      })
      if (r.status !== 200) return text(`沒有寄出：${errText(r)}`, true)
      const j = r.json
      const opNote = (j.warning ? `（${j.warning}）` : '') + (j.title_truncated ? CUT_NOTE : '')
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
      const lines = mail.map(m => `#${m.id}｜${m.from}｜${m.title}｜期限 ${hm(m.deadline)}｜等了 ${m.waited}｜${m.status === 'unread' ? '未讀' : '已讀'}${m.no_reply ? '｜不用回' : ''}`)
      return text(`${unread} 封未讀、${mail.length - unread} 封已讀還沒勾掉：\n${lines.join('\n')}`)
    }
    case 'mailbox_open': {
      const id = intId(args.id)
      if (!id) return text('mailbox_open: id 要填信的編號', true)
      const r = await deps.btcc('GET', `/api/mesh/mail/${id}`)
      if (r.status !== 200) return text(errText(r), true)
      const m = r.json
      return text(`#${m.id} 來自 ${m.from}｜${m.title}\n期限 ${hm(m.deadline)}｜等了 ${m.waited}${m.no_reply ? '｜不用回' : ''}${m.reply_to_id ? `｜回覆 #${m.reply_to_id}` : ''}\n\n${m.body}`)
    }
    case 'mailbox_check': {
      const id = intId(args.id)
      if (!id) return text('mailbox_check: id 要填信的編號', true)
      const r = await deps.btcc('POST', `/api/mesh/mail/${id}/check`, {})
      if (r.status !== 200) return text(errText(r), true)
      return text(`#${id} 勾掉了，不在清單上了。${r.json.was === 'unread' ? '（它還沒打開過，寄的人看到的是未讀。）' : ''}`)
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
        const st = m.status === 'unread' ? '未讀' : m.status === 'read' ? `已讀 ${hm(m.read_at)}`
          : m.status === 'checked' ? `勾掉了${m.read_at ? `（已讀 ${hm(m.read_at)}）` : '（沒打開過）'}`
          : m.status === 'pushed' ? '已直接送進 session（對方信箱沒開）' : String(m.status)
        return `#${m.id}｜給 ${m.to}｜${m.title}｜期限 ${hm(m.deadline)}｜${st}`
      }).join('\n'))
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
      const r = await deps.core('POST', '/api/feed/ask', { about }, ASK_TIMEOUT_MS)
      if (r.status === 403) return text(`${coreErr(r)}`, true)
      if (r.status !== 200) return text(`Jev 沒回，改用搜尋：牆現在問不了（${coreErr(r)}）。用 feed_search 給一到幾個詞，看短卡，再用 feed_open 打開要讀的。`)
      const j = r.json
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
