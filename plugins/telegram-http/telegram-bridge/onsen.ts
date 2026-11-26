// onsen.ts: telegram-bridge's Onsen client (WO-196 part B), with the bridge's own credential (a BTCC system identity telegram-bridge-<machine>,
// ~/.config/mesh/telegram-bridge-<machine>.credential; read again when the file changes, never logged; claude-code-host's Onsen class is the
// pattern). Every call is bounded; a network error or the timeout throws; any HTTP answer comes back as {status, json}.
import { readFileSync, statSync } from 'node:fs'
import { errText } from './tg.ts'

export type Answer = { status: number; json: any }
/** Onsen's error code of an answer: v1's {error:{code}} or FastAPI's {detail} (the older /api/onsen routes) */
export const errCode = (a: Answer | null): string => String(a?.json?.error?.code ?? (typeof a?.json?.detail === 'string' ? 'detail' : '') ?? '')
export const errSaid = (a: Answer | null): string => String(a?.json?.error?.message ?? a?.json?.detail ?? '').replace(/\s+/g, ' ').slice(0, 200)
/** retry later: no credential (0), 401 (a credential being replaced), 404 no_endpoint (Onsen lost the endpoint list: registered again), 408, 425,
 *  429, 5xx */
export const retryable = (a: Answer): boolean => a.status === 0 || a.status === 401 || a.status === 408 || a.status === 425 || a.status === 429 || a.status >= 500
  || (a.status === 404 && errCode(a) === 'no_endpoint')

/** X-File-Name as Onsen reads it: ASCII as is, anything else percent-encoded UTF-8 (app/onsen_files.py) */
export function headerName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200)
  return /^[\x20-\x7e]*$/.test(clean) ? clean : encodeURIComponent(clean)
}

export class OnsenClient {
  private tok: { mtime: number; value: string | null } = { mtime: -1, value: null }
  readonly v1: string
  readonly origin: string
  constructor(readonly base: string, readonly credentialFile: string, readonly timeoutMs = 15_000, readonly fetchImpl: typeof fetch = fetch, readonly ua = 'telegram-bridge/1') {
    this.base = base.replace(/\/+$/, '')
    this.v1 = this.base + '/v1'
    this.origin = new URL(this.base).origin
  }
  /** the credential, read again when the file changes; null when missing or not a mesh credential. Never logged. */
  token(): string | null {
    try {
      const m = statSync(this.credentialFile).mtimeMs
      if (m !== this.tok.mtime) { const v = readFileSync(this.credentialFile, 'utf8').trim(); this.tok = { mtime: m, value: v.startsWith('mesh_') ? v : null } }
    } catch { this.tok = { mtime: -1, value: null } }
    return this.tok.value
  }
  /** one JSON request. `path` under /v1 unless `root` (then under the base, /api/onsen). status 0 = no credential. Throws on a network error. */
  async req(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown, o: { root?: boolean; timeoutMs?: number; idem?: string; signal?: AbortSignal } = {}): Promise<Answer> {
    const t = this.token()
    if (!t) return { status: 0, json: null }
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? this.timeoutMs)
    const onOuter = () => ac.abort()
    o.signal?.addEventListener('abort', onOuter)
    try {
      const r = await this.fetchImpl((o.root ? this.base : this.v1) + path, {
        method, signal: ac.signal,
        headers: { Authorization: `Bearer ${t}`, 'User-Agent': this.ua, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(o.idem ? { 'Idempotency-Key': o.idem.slice(0, 200) } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      let json: any = null
      try { json = await r.json() } catch {}
      return { status: r.status, json }
    } catch (e) {
      throw new Error(ac.signal.aborted && !o.signal?.aborted ? `${method} ${path.split('?')[0]}: no answer in ${Math.round((o.timeoutMs ?? this.timeoutMs) / 1000)} s` : `${method} ${path.split('?')[0]}: ${errText(e)}`)
    } finally { clearTimeout(timer); o.signal?.removeEventListener('abort', onOuter) }
  }
  /** POST /v1/files (CONTRACT §4): the file's bytes; Idempotency-Key = `key` (a resend answers the same File) */
  async upload(bytes: Uint8Array, o: { key: string; name?: string | null; mime?: string | null }): Promise<{ id: string } | { error: string; retry: boolean }> {
    const t = this.token()
    if (!t) return { error: `no mesh credential in ${this.credentialFile}`, retry: true }
    const declared = String(o.mime ?? '').split(';')[0]!.trim().toLowerCase()
    const type = !declared || /^image\/(png|jpe?g|pjpeg|gif|webp)$/.test(declared) ? 'application/octet-stream' : declared   // Onsen knows these by their bytes
    try {
      const r = await this.fetchImpl(`${this.v1}/files`, {
        method: 'POST', body: bytes, signal: AbortSignal.timeout(90_000),
        headers: { Authorization: `Bearer ${t}`, 'User-Agent': this.ua, 'Content-Type': type, 'Idempotency-Key': o.key.slice(0, 200),
          ...(o.name && headerName(o.name) ? { 'X-File-Name': headerName(o.name) } : {}) },
      })
      let json: any = null
      try { json = await r.json() } catch {}
      const d = json?.data ?? json
      if (r.status >= 200 && r.status < 300 && d?.id != null) return { id: String(d.id) }
      return { error: `POST /v1/files answered HTTP ${r.status} ${errSaid({ status: r.status, json })}`.trim(), retry: retryable({ status: r.status, json }) }
    } catch (e) { return { error: `POST /v1/files: ${errText(e)}`, retry: true } }
  }
  /** a file Onsen keeps (a Message's attachments[].url), only from Onsen's own origin, at most `max` bytes */
  async getFile(url: string, max: number): Promise<{ bytes: Uint8Array; mime: string | null } | { error: string; retry: boolean }> {
    let u: URL
    try { u = new URL(url, this.origin) } catch { return { error: 'not a URL', retry: false } }
    if (u.origin !== this.origin) return { error: `not Onsen's own address (${u.origin})`, retry: false }
    const t = this.token()
    if (!t) return { error: `no mesh credential in ${this.credentialFile}`, retry: true }
    try {
      const r = await this.fetchImpl(u.href, { headers: { Authorization: `Bearer ${t}`, 'User-Agent': this.ua }, signal: AbortSignal.timeout(90_000) })
      if (!r.ok) { try { await r.body?.cancel() } catch {} return { error: `GET ${u.pathname} answered HTTP ${r.status}`, retry: r.status >= 500 || r.status === 429 } }
      const len = Number(r.headers.get('content-length') ?? NaN)
      if (Number.isFinite(len) && len > max) { try { await r.body?.cancel() } catch {} return { error: `over ${max} bytes (${len})`, retry: false } }
      const bytes = new Uint8Array(await r.arrayBuffer())
      if (bytes.byteLength > max) return { error: `over ${max} bytes (${bytes.byteLength})`, retry: false }
      return { bytes, mime: r.headers.get('content-type') }
    } catch (e) { return { error: `GET ${u.pathname}: ${errText(e)}`, retry: true } }
  }
}
