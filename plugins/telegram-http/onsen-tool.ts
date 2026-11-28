// Onsen (WO-139): the chat_history tool's definition, shared by the main's Telegram server (server.ts) and every lane (lanes.ts LANE_TOOLS).
// A definition only: the query itself is onsen-client.ts (OnsenClient.queryHistory), handed to lanes.ts through LanesDeps.chatHistory.

export const HISTORY_ID_HINT = '標籤上的 message_id 用純數字或 tg:N，清單上的 Onsen 編號用 #N'

export const CHAT_HISTORY_TOOL = {
  name: 'chat_history',
  description: `查之前講過什麼：你和 Joey 在這裡的每一則問答（他說的、你回的、分身推的）都在 Onsen。不帶參數是最新 20 則；limit 指定幾則；since／until 看一段時間；q 搜內容；id 取某一則全文（${HISTORY_ID_HINT}）。這裡只有講過的話；你做了什麼（工具呼叫、改了哪些檔、指令的輸出）不在這裡，在 session 紀錄（~/.claude/projects/<工作區>/<session 編號>.jsonl）。先查這裡，查不到才去翻 session 紀錄。不用請 Joey 再貼一次。`,
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: '幾則（預設 20，最多 200）' },
      since: { type: 'string', description: '從什麼時候起：ISO 時間，或往回算的相對時間（30m、2h、3d）' },
      until: { type: 'string', description: '到什麼時候：ISO 時間或相對時間' },
      q: { type: 'string', description: '搜內容（文字）' },
      id: { type: 'string', description: '3114 或 tg:3114 查指定聊天的 message_id，#47192 查 Onsen 編號（也接受 onsen:N、form-N）' },
      chat: { type: 'string', description: '哪個聊天（標籤上的 chat_id）；不填 = 你和 Joey 的私訊' },
    },
  },
}

// WO-153 (Chiron): close a page form the agent sent (Onsen POST /forms/close, the daemon's own mesh credential). The main's server (server.ts) and every lane
// (lanes.ts, through LanesDeps.formClose) list it only when Onsen recording is on for the agent. The description is one constant: Chiron owns its wording.
export const FORM_CLOSE_DESC = "關掉你發給 Joey 的一張表單：他用別的方式回了，或這件事不用他定了。關了它就不再列在他的『等你決定』；他之後點舊連結會看到『這一題已經關了』。給 `id`，或給 `url`（關那一頁最新、還開著的那一筆）；`reason` 寫一句為什麼關。只關得了自己發的。"   // Chiron's wording (WO-153 10:16Z)
export const FORM_CLOSE_TOOL = {
  name: 'form_close',
  description: FORM_CLOSE_DESC,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'number', description: 'the form id (Onsen)' },
      url: { type: 'string', description: 'the page url as you sent it' },
      reason: { type: 'string', description: 'why it is closed (optional)' },
    },
  },
}
type FormCloseRequest = (method: 'POST', path: string, body: unknown, timeoutMs?: number) => Promise<{ status: number; json: any } | null>
/** form_close: one of id / url (reason optional) → POST /forms/close → Onsen's answer as text. Never throws: a refusal or a failure is the text (isError). */
export async function formClose(request: FormCloseRequest | null, a: Record<string, unknown>, timeoutMs = 10_000): Promise<{ text: string; isError: boolean }> {
  const id = a?.id == null || a.id === '' ? null : Number(a.id)
  const url = typeof a?.url === 'string' && a.url.trim() ? a.url.trim() : null
  const reason = typeof a?.reason === 'string' && a.reason.trim() ? a.reason.trim().slice(0, 500) : null
  if (id != null && !(Number.isInteger(id) && id > 0)) return { text: 'form_close: id must be a positive integer (the form id).', isError: true }
  if (id == null && !url) return { text: 'form_close: give the form id or the page url.', isError: true }
  if (!request) return { text: 'form_close: this daemon is not connected to Onsen.', isError: true }
  const body = { ...(id != null ? { id } : {}), ...(url ? { url } : {}), ...(reason ? { reason } : {}) }
  let r: { status: number; json: any } | null
  try { r = await request('POST', '/forms/close', body, timeoutMs) } catch (e) {
    return { text: `form_close: Onsen did not answer (${String(e instanceof Error ? e.message : e).slice(0, 160)}); nothing was closed.`, isError: true }
  }
  if (!r) return { text: 'form_close: no mesh credential for Onsen; nothing was closed.', isError: true }
  const ans = JSON.stringify(r.json ?? {})
  if (r.status >= 200 && r.status < 300) return { text: ans, isError: false }
  if (r.status === 404) return { text: `form_close: no such open form (404) ${ans}`, isError: true }
  if (r.status === 403) return { text: `form_close: not your form (403) ${ans}`, isError: true }
  return { text: `form_close: Onsen answered HTTP ${r.status} ${ans}`, isError: true }
}
