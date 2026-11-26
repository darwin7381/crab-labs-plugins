// WO-197 (Chiron 16:1xZ, mesh-12795; lab 15:4xZ): every HTTP request this daemon makes to Telegram (grammy's Bot API calls, callBotApi, file
// downloads) goes through one TelegramFetch, so handing the bot over to the bridge can end with no connection to Telegram left open.
//
// Where the connections live (measured, Bun 1.3.11 and 1.4.2, connector-handover-sockets.test.ts and the scratch probes noted in the anchor): a
// finished request's connection stays in Bun's own fetch pool (process-wide, keyed by host) and the next request to that host reuses it. grammy's
// https.Agent({ keepAlive: true }) is not that pool (Bun's fetch ignores `agent`; its destroy() closes nothing), and no API empties the pool. Two
// things close a pooled connection: a request sent with `Connection: close` (it takes an idle one and closes it after the answer), and a request
// aborted on it (bot.stop() aborts the long poll). So the hand-over (close()) puts `Connection: close` on every request it lets through (grammy's
// last getUpdates), waits for the requests already on their way, then sends as many `Connection: close` requests at once as this daemon ever had in
// flight to Telegram (every pooled connection was opened by one of them; one that finds no idle connection opens one and closes it): none is left.
// Polling as usual keeps its connection (nothing changes while not closing).
export type FetchFn = (input: string | URL | Request, init?: RequestInit & Record<string, unknown>) => Promise<Response>

export const DRAIN_MAX = 32
export const SETTLE_MS = 15_000

export class TelegramFetch {
  private inflight = 0
  /** the most requests in flight to Telegram at once since the last drain: the most connections Bun's pool can hold for it */
  peak = 0
  /** handing over: every request carries Connection: close */
  closing = false
  readonly stats = { requests: 0, drains: 0, drain_requests: 0, last_drain_at: null as string | null }
  private idleWaiters: Array<() => void> = []
  constructor(private o: { root: string; fetch?: FetchFn; log?: (m: string) => void; now?: () => number }) {}

  /** a fetch over `under` (grammy: the node-fetch shim it uses; else the global fetch). grammy's `agent` is dropped: Bun ignores it, and the one pool
   *  is Bun's own either way */
  wrap(under?: FetchFn): FetchFn {
    return async (input, init) => {
      const base = under ?? this.o.fetch ?? (globalThis.fetch as FetchFn)
      let opts: (RequestInit & Record<string, unknown>) | undefined = init ? { ...init } : undefined
      if (opts && 'agent' in opts) delete opts.agent
      const close = this.closing
      if (close) { const h = new Headers((opts?.headers ?? undefined) as HeadersInit | undefined); h.set('connection', 'close'); opts = { ...(opts ?? {}), headers: h } }
      this.inflight++
      this.stats.requests++
      if (this.inflight > this.peak) this.peak = this.inflight
      try { return await base(input, opts) } finally {
        this.inflight--
        if (this.inflight === 0) { const w = this.idleWaiters.splice(0); for (const f of w) f() }
        // a request that left before the hand-over and came back after its drain: its connection went back to the pool; take it out
        if (this.closing && !close && this.stats.last_drain_at) void this.drain(1)
      }
    }
  }
  /** the global-fetch entry (callBotApi, file downloads) */
  readonly fetch: FetchFn = this.wrap()

  /** the hand-over begins: from now every request carries Connection: close */
  beginClose(): void { this.closing = true; this.stats.last_drain_at = null }
  /** the hand-over's end (after bot.stop()): the requests on their way are waited for (at most settleMs), then the pool is drained */
  async endClose(settleMs = SETTLE_MS): Promise<number> {
    if (this.inflight > 0) await new Promise<void>(r => { const t = setTimeout(r, settleMs); this.idleWaiters.push(() => { clearTimeout(t); r() }) })
    return this.drain(this.peak)
  }
  /** polling again (taken off the list): requests keep their connections as usual */
  reopen(): void { this.closing = false }
  get inFlight(): number { return this.inflight }

  /** n requests at once with Connection: close to the API root (no token, no method: not a Bot API call), redirects not followed; each takes an idle
   *  pooled connection and closes it. Errors ignored (an unreachable Telegram has closed them already) */
  async drain(n: number): Promise<number> {
    const k = Math.max(1, Math.min(DRAIN_MAX, Math.floor(n)))
    const base = this.o.fetch ?? (globalThis.fetch as FetchFn)
    const url = `${this.o.root.replace(/\/+$/, '')}/`
    await Promise.all(Array.from({ length: k }, () => base(url, { method: 'HEAD', redirect: 'manual', headers: { connection: 'close' }, signal: AbortSignal.timeout(10_000) })
      .then(r => r.arrayBuffer().catch(() => null)).catch(() => null)))
    this.stats.drains++
    this.stats.drain_requests += k
    this.stats.last_drain_at = new Date((this.o.now ?? Date.now)()).toISOString()
    this.peak = this.inflight
    this.o.log?.(`telegram: ${k} Connection: close request(s) to ${url} — the pool of connections to Telegram drained`)
    return k
  }
}
