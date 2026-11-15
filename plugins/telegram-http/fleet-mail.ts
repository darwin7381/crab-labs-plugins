// fleet — the second MCP server of the agent-inbox plugin (WO-91 收件分級第一段).
//
// Why a second server: Claude Code silently truncates each MCP server's instructions at 2048 chars
// (measured 2026-11-06; see server.ts). agent-inbox's own instructions (trust, disclosure, closing) are
// ~1.9k already, and the fleet's main text (FLEET_TEXT, Chiron's words, verbatim) is ~1.3k. Each server
// gets its own budget, so the main text rides here, with the tools it talks about: call, mail, mailbox.
//
// Stateless streamable HTTP with JSON responses (POST /fleet on the agent-inbox daemon): no session,
// no SSE, never a channel — inbound delivery stays on the agent-inbox server alone, so nothing is
// dispatched twice. Mail lives in BTCC (/api/mesh/mail/*); the daemon calls it with this agent's own
// mesh credential, so the sender is whoever the credential says, never a name in the body.
import { FLEET_TEXT } from './fleet-text.ts'

export const FLEET_INSTRUCTIONS = FLEET_TEXT
const TITLE_MAX = 40

export type BtccCall = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; json: any }>
export type CallFn = (to: string, text: string, replyTo?: number, noReply?: boolean, op?: string) => Promise<string>
export interface FleetDeps { call: CallFn; btcc: BtccCall }

const SEND_FLOW = '寄之前：① 晚一小時會壞事，或有人正在等結果 → 呼叫（call）。② 對方要做事、回答、決定，或一定要它知道（拿不準算是）→ 寄信（send_mail）。③ 都不是 → 貼動態（還沒上線）。'

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
    description: `寄信（Mail）：放進對方的信箱，不打斷它手上的事；它一小時內會知道有信，自己排時間讀，每封信一定有一個結果寄回你的信箱。大部分的事是信，拿不準就寄信。${SEND_FLOW} 對方的信箱還沒開時，這封會照舊直接送進它的 session，你不用管。`,
    inputSchema: {
      type: 'object',
      required: ['to', 'title', 'body'],
      properties: {
        to: { type: 'string', description: '給誰。也可以寄給自己' },
        title: { type: 'string', description: `標題，${TITLE_MAX} 字內：誰、對什麼、要什麼。對方先看到的只有這一行。超過不收` },
        body: { type: 'string', description: '內容。最多 3500 字' },
        deadline: { type: 'string', description: '選填：期限，ISO-8601 時間或「幾小時後」的數字；沒填＝一天。到期還沒處理，你會收到一封信' },
        no_reply: { type: 'boolean', description: '只是要它知道（它不用做事、不用回答）就標 true：它完成時結果只記著，不寄回給你' },
        reply_to: { type: 'string', description: '選填：這封是在回哪一封信或哪一則訊息（編號）' },
      },
    },
  },
  {
    name: 'mailbox_list',
    description: '看信箱清單：待處理的信一封一行（編號｜誰寄的｜標題｜期限｜等了多久），不含內容。被提醒「讀信箱」時先看這個，再決定什麼時候讀。看過不等於處理了：每封信只有完成或延後兩種結局。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mailbox_open',
    description: '打開一封信，讀全文。',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'integer', description: '信的編號' } } },
  },
  {
    name: 'mailbox_done',
    description: '完成一封信，附一句結果給寄的人：做好了、答案是什麼、做不了、或不是你的事該找誰，都寫在這一句。結果寄回寄件者的信箱，自動標不用回。',
    inputSchema: {
      type: 'object',
      required: ['id', 'result'],
      properties: { id: { type: 'integer' }, result: { type: 'string', description: '一句結果' } },
    },
  },
  {
    name: 'mailbox_defer',
    description: '延後一封信到你會處理的時間；要做很久的，延到你預計做完的時候。不能超過這封信的期限。時間到它回到待處理，下一次提醒會再列出來。',
    inputSchema: {
      type: 'object',
      required: ['id', 'until'],
      properties: { id: { type: 'integer' }, until: { type: 'string', description: 'ISO-8601 時間，或「幾小時後」的數字' } },
    },
  },
  {
    name: 'mail_sent',
    description: '查自己寄出的信現在怎樣：待處理、延後到何時、完成和那一句結果。',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } } },
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
      if ([...title].length > TITLE_MAX) return text(`標題 ${[...title].length} 字，上限 ${TITLE_MAX}：寫誰、對什麼、要什麼。沒有寄出。`, true)
      const r = await deps.btcc('POST', '/api/mesh/mail/send', {
        to, title, body, deadline: hoursOrIso(args.deadline), no_reply: args.no_reply === true,
        reply_to_id: intId(args.reply_to),
      })
      if (r.status !== 200) return text(`沒有寄出：${errText(r)}`, true)
      const j = r.json
      if (j.stored) return text(`已放進 ${to} 的信箱（#${j.id}）。它一小時內會知道有信；完成時那一句結果會寄回你的信箱。`)
      if (j.delivered) return text(`${to} 的信箱還沒開，這封照舊直接送進它的 session（#${j.id}）。`)
      return text(`#${j.id} 記下了，但送不到 ${to}：${j.detail ?? '?'}`, true)
    }
    case 'mailbox_list': {
      const r = await deps.btcc('GET', '/api/mesh/mail/list')
      if (r.status !== 200) return text(`讀不到信箱：${errText(r)}`, true)
      const open = (r.json.open ?? []) as any[]
      const later = r.json.deferred_later ? `（另有 ${r.json.deferred_later} 封延後中）` : ''
      if (!open.length) return text(`信箱沒有待處理的信${later}。`)
      const lines = open.map(m => `#${m.id}｜${m.from}｜${m.title}｜期限 ${hm(m.deadline)}｜等了 ${m.waited}${m.no_reply ? '｜不用回' : ''}`)
      return text(`${open.length} 封待處理${later}：\n${lines.join('\n')}`)
    }
    case 'mailbox_open': {
      const id = intId(args.id)
      if (!id) return text('mailbox_open: id 要填信的編號', true)
      const r = await deps.btcc('GET', `/api/mesh/mail/${id}`)
      if (r.status !== 200) return text(errText(r), true)
      const m = r.json
      return text(`#${m.id} 來自 ${m.from}｜${m.title}\n期限 ${hm(m.deadline)}｜等了 ${m.waited}${m.no_reply ? '｜不用回' : ''}${m.status && m.status !== 'pending' ? `｜狀態 ${m.status}` : ''}\n\n${m.body}`)
    }
    case 'mailbox_done': {
      const id = intId(args.id)
      const result = String(args.result ?? '').trim()
      if (!id || !result) return text('mailbox_done: id 和 result（一句結果）都要填', true)
      const r = await deps.btcc('POST', `/api/mesh/mail/${id}/done`, { result })
      if (r.status !== 200) return text(errText(r), true)
      const back = r.json.result_to_sender
      return text(back ? `#${id} 完成，結果已寄回寄件者。` : `#${id} 完成。結果只記著（原信標了不用回，或是寄給你自己的）。`)
    }
    case 'mailbox_defer': {
      const id = intId(args.id)
      const until = hoursOrIso(args.until)
      if (!id || until === undefined) return text('mailbox_defer: id 和 until 都要填', true)
      const r = await deps.btcc('POST', `/api/mesh/mail/${id}/defer`, { until })
      if (r.status !== 200) return text(errText(r), true)
      return text(`#${id} 延後到 ${hm(r.json.until)}。到時候它回到待處理。`)
    }
    case 'mail_sent': {
      const lim = intId(args.limit) ?? 20
      const r = await deps.btcc('GET', `/api/mesh/mail/sent?limit=${Math.min(lim, 50)}`)
      if (r.status !== 200) return text(errText(r), true)
      const rows = (r.json.sent ?? []) as any[]
      if (!rows.length) return text('你還沒有寄出過信。')
      return text(rows.map(m => {
        const st = m.status === 'done' ? `完成：${m.result ?? ''}` : m.status === 'deferred' ? `延後到 ${hm(m.deferred_until)}`
          : m.status === 'pending' ? '待處理' : m.status === 'pushed' ? '已直接送進 session（對方信箱沒開）' : String(m.status)
        return `#${m.id}｜給 ${m.to}｜${m.title}｜期限 ${hm(m.deadline)}｜${st}`
      }).join('\n'))
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
    case 'tools/list':
      return ok({ tools: FLEET_TOOLS })
    case 'tools/call':
      try {
        return ok(await callTool(String(params.name ?? ''), params.arguments ?? {}, deps))
      } catch (e) {
        return ok(text(`tool error: ${String(e).slice(0, 200)}`, true))
      }
  }
  return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } }
}
