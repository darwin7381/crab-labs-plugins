// tg.ts: the few Telegram Bot API calls telegram-bridge makes, one client per bot (WO-196 part B). Plain fetch, no grammy: the bridge decides
// itself when an update is confirmed (getUpdates' offset), and one process holds 27 of these.
//
// The token lives only in this object's private field. It is in every request URL, so no URL is ever logged or thrown: every error message
// goes through scrub(), which replaces bot<id>:<secret> with bot<token>. The API root (TELEGRAM_API_ROOT) is a fake server in tests.
//
// Bounds (server.ts:342-347, item 7 there): a send gets TELEGRAM_SEND_TIMEOUT_S (45 s), a file upload TELEGRAM_UPLOAD_TIMEOUT_S (300 s); on expiry
// the call fails with TgTimeout, which says the message MAY have been delivered (the bridge does not send that part again). getUpdates gets its
// long-poll time plus 15 s.

export const scrub = (s: string): string => s.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<token>')
export const errText = (e: unknown): string => scrub((e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ')).slice(0, 300)

/** Telegram answered ok:false (or HTTP failed): its error_code, description and, for 429, parameters.retry_after (seconds) */
export class TgError extends Error {
  constructor(readonly method: string, readonly code: number, readonly description: string, readonly retryAfter?: number) {
    super(scrub(`${method}: ${code} ${description}`))
  }
}
/** no answer in time: the message may or may not have been delivered */
export class TgTimeout extends Error {
  constructor(readonly method: string, readonly ms: number) {
    super(`${method}: no answer from Telegram within ${Math.round(ms / 1000)} s; it may or may not have been delivered`)
  }
}

export type TgOptions = { apiRoot?: string; fetch?: typeof fetch; sendTimeoutMs?: number; uploadTimeoutMs?: number; callTimeoutMs?: number }
const SENDS = new Set(['sendMessage', 'sendRichMessage', 'sendChatAction', 'editMessageText', 'editMessageReplyMarkup', 'setMessageReaction',
  'createForumTopic', 'editForumTopic', 'pinChatMessage', 'deleteMessage', 'answerCallbackQuery'])
const UPLOADS = new Set(['sendPhoto', 'sendDocument'])

export class Tg {
  readonly #token: string
  readonly apiRoot: string
  private f: typeof fetch
  constructor(token: string, readonly o: TgOptions = {}) {
    this.#token = token
    this.apiRoot = (o.apiRoot ?? 'https://api.telegram.org').replace(/\/+$/, '')
    this.f = o.fetch ?? fetch
  }
  /** the bot's numeric id (the part before the colon; not secret) */
  get botId(): string { return this.#token.split(':')[0] ?? '' }
  private boundOf(method: string): number {
    if (UPLOADS.has(method)) return this.o.uploadTimeoutMs ?? 300_000
    if (SENDS.has(method)) return this.o.sendTimeoutMs ?? 45_000
    return this.o.callTimeoutMs ?? 30_000
  }
  private async go(method: string, init: RequestInit, boundMs: number, outer?: AbortSignal): Promise<any> {
    const ac = new AbortController()
    const onOuter = () => ac.abort()
    outer?.addEventListener('abort', onOuter)
    const t = setTimeout(() => ac.abort(), boundMs)
    let data: any
    try {
      const r = await this.f(`${this.apiRoot}/bot${this.#token}/${method}`, { ...init, signal: ac.signal })
      try { data = await r.json() } catch { data = { ok: false, error_code: r.status, description: `HTTP ${r.status}` } }
    } catch (e) {
      if (ac.signal.aborted && !outer?.aborted) throw new TgTimeout(method, boundMs)
      if (outer?.aborted) throw new Error(`${method}: aborted`)
      throw new Error(scrub(`${method}: ${errText(e)}`))
    } finally { clearTimeout(t); outer?.removeEventListener('abort', onOuter) }
    if (!data?.ok) throw new TgError(method, Number(data?.error_code ?? 0), String(data?.description ?? 'unknown error'), data?.parameters?.retry_after != null ? Number(data.parameters.retry_after) : undefined)
    return data.result
  }
  /** one JSON call */
  call<T = any>(method: string, params: Record<string, unknown> = {}, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    return this.go(method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }, o.timeoutMs ?? this.boundOf(method), o.signal)
  }
  /** sendPhoto / sendDocument with the file's bytes (multipart) */
  upload<T = any>(method: 'sendPhoto' | 'sendDocument', params: Record<string, unknown>, bytes: Uint8Array, name: string, mime?: string | null): Promise<T> {
    const fd = new FormData()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
    fd.append(method === 'sendPhoto' ? 'photo' : 'document', new Blob([bytes], mime ? { type: mime } : {}), name)
    return this.go(method, { method: 'POST', body: fd }, this.boundOf(method))
  }
  /** long poll: the updates from `offset` (confirming every update below it) */
  getUpdates(offset: number | undefined, timeoutS: number, allowed: string[], signal?: AbortSignal): Promise<any[]> {
    return this.call('getUpdates', { ...(offset != null ? { offset } : {}), timeout: timeoutS, allowed_updates: allowed, limit: 100 }, { timeoutMs: (timeoutS + 15) * 1000, signal })
  }
  getFile(file_id: string): Promise<{ file_path?: string; file_size?: number }> { return this.call('getFile', { file_id }) }
  /** a file's download address (carries the token: only ever passed to fetch, never logged) */
  fileUrl(path: string): string { return `${this.apiRoot}/file/bot${this.#token}/${path}` }
}
