import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OnsenClient } from './onsen-client.ts'
import type { InboxItem } from './onsen-items.ts'

export type OwnItem = {
  kind: 'self' | 'keepwarm' | 'resume'; session_id?: string | null; waiter?: string | null
  body?: { format: 'markdown'; text: string }; refs: InboxItem['refs']
  not_before?: string | null; deadline?: string | null; expires_at?: string | null
}
/** The original request stays identical when its response is lost, including across a spool replay. */
export type ItemWrite = { key: string; item: OwnItem; complete?: true; outcome?: 'withdrawn' | 'completed' | 'superseded'; id?: string; expected_version?: number; pending_create?: true }
export type ItemWriter = (write: ItemWrite) => void
const epochSecond = (time?: string | null) => time ? Math.floor(Date.parse(time) / 1000) : null

function signatureOf(item: OwnItem): string {
  const body = JSON.stringify(item, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]]))
  })
  return createHash('sha256').update(body).digest('hex')
}

type Receipt = { id: string; signature: string; member?: string }
type Request = OnsenClient['request']
export function ownItem(kind: OwnItem['kind'], session: string, text: string, due: number | null,
  waiter?: string, deadline: number | null = null, refs: InboxItem['refs'] = []): OwnItem {
  const iso = (ms: number | null) => ms === null ? null : new Date(ms).toISOString()
  return { kind, session_id: session, body: { format: 'markdown', text }, refs,
    not_before: iso(due), deadline: iso(deadline), expires_at: null, ...(waiter ? { waiter } : {}) }
}

// The receipt is durable before the spool cursor advances. Only an unacknowledged creation may repeat its POST.
export class ItemWrites {
  private paths?: Map<string, Set<string>>
  private checkAfter = 0
  constructor(private readonly dir: string, private readonly member: string, private readonly req: Request) {}

  private receiptPath(key: string): string {
    return join(this.dir, createHash('sha256').update(JSON.stringify([this.member, key])).digest('hex'))
  }
  private receipt(key: string): Receipt | undefined {
    try { return JSON.parse(readFileSync(this.receiptPath(key), 'utf8')) as Receipt }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }
  id(key: string): string | undefined { return this.receipt(key)?.id }

  private indexPath(index: Map<string, Set<string>>, id: string, path: string): void {
    const paths = index.get(id) ?? new Set<string>()
    paths.add(path)
    index.set(id, paths)
  }

  private receiptPaths(): Map<string, Set<string>> {
    if (this.paths) return this.paths
    const index = new Map<string, Set<string>>()
    let names: string[] = []
    try { names = readdirSync(this.dir) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    for (const name of names) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue
      const path = join(this.dir, name)
      const receipt: Receipt = JSON.parse(readFileSync(path, 'utf8'))
      if (!receipt.member || receipt.member === this.member) this.indexPath(index, receipt.id, path)
    }
    return this.paths = index
  }

  observe(row?: InboxItem): void {
    if (row?.from !== this.member || !['completed', 'cancelled'].includes(row.state)) return
    const index = this.receiptPaths()
    for (const path of index.get(row.id) ?? []) rmSync(path, { force: true })
    index.delete(row.id)
  }

  /** A row can expire or be closed elsewhere while the connector is down. Check one outstanding id per idle interval. */
  async reconcile(): Promise<void> {
    if (Date.now() < this.checkAfter) return
    this.checkAfter = Date.now() + 15_000
    const index = this.receiptPaths()
    const next = index.entries().next()
    if (next.done) return
    const [id, paths] = next.value
    index.delete(id); index.set(id, paths)
    const r = await this.req('GET', '/v1/items/' + encodeURIComponent(id), undefined, 3000)
    if (r?.status === 200) this.observe(r.json?.data)
  }

  private remember(key: string, id: string, signature: string): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const path = this.receiptPath(key)
    writeFileSync(path + '.tmp', JSON.stringify({ id, signature, member: this.member } satisfies Receipt), { mode: 0o600 })
    renameSync(path + '.tmp', path)
    if (this.paths) this.indexPath(this.paths, id, path)
  }

  async sync(path: string, write: ItemWrite, mayWithdrawKeepwarm?: (row: InboxItem) => boolean) {
    const original = write.item
    const receipt = this.receipt(write.key)
    const outcome = write.outcome ?? (write.complete ? 'completed' : undefined)
    if (!outcome) {
      const ref = original.refs?.[0]
      const legacy = original.kind === 'self' && write.key.startsWith('fu-') && ref?.kind === 'item' && ref.value === write.key
      const item = legacy ? { ...original, refs: original.refs.slice(1) } : original
      if (legacy) delete item.waiter
      const signature = signatureOf(item)
      if (receipt) {
        if (receipt.signature !== signature) {
          if (!legacy || receipt.signature !== signatureOf(original)) return { status: 409, json: { error: 'Item creation key reused with a different body' } }
          this.remember(write.key, receipt.id, signature)
        }
        return { status: 200, json: { data: { id: receipt.id } } }
      }
      if (legacy) {
        // A previous connector may have created the row and lost its response. Only send the corrected body for an unsent row.
        const found = await this.findLegacy(path, write, true)
        if (found?.status === 200) {
          this.remember(write.key, found.json.data.id, signature)
          this.observe(found.json.data)
          return found
        }
        if (found?.status !== 204) return found
      }
      const created = await this.req('POST', path, item, undefined, { 'Idempotency-Key': write.key })
      if (!created || created.status < 200 || created.status >= 300) return created
      const id = created.json?.data?.id
      if (typeof id !== 'string' || !id) throw Error('missing Item id on creation')
      this.remember(write.key, id, signature)
      this.observe(created.json.data)
      return created
    }
    let id = write.id ?? receipt?.id
    if (!id) {
      // A row accepted by a pre-receipt connector has no local id. Find its waiting row without creating one.
      if (write.pending_create) return { status: 204, json: {} }
      const found = await this.findLegacy(path, write)
      if (found?.status !== 200) return found
      id = found.json.data.id as string
      this.remember(write.key, id, signatureOf(original))
    }
    const detail = '/v1/items/' + encodeURIComponent(id)
    const current = await this.req('GET', detail)
    if (current?.status !== 200) return current
    if (current.json.data.state !== 'waiting') { this.observe(current.json.data); return current }
    const row: InboxItem = current.json.data
    if (write.expected_version != null && write.expected_version !== row.version) return current
    if (original.kind === 'keepwarm' && outcome === 'withdrawn' && mayWithdrawKeepwarm && !mayWithdrawKeepwarm(row)) return current
    const result = await this.req('DELETE', detail, { expected_version: row.version, outcome })
    if (result?.status !== 409) {
      if (result?.status === 200) this.observe(result.json?.data)
      return result
    }
    const latest = await this.req('GET', detail)
    if (latest?.status === 200) this.observe(latest.json?.data)
    // A concurrent edit left it waiting. The next spool pass reads its new version.
    if (latest?.status === 200 && latest.json.data.state === 'waiting') return { status: 503, json: result.json }
    return latest
  }

  private async findLegacy(path: string, { item }: ItemWrite, includeReassigned = false) {
    const q = new URLSearchParams({ state: 'all', kind: item.kind, limit: '100' })
    if (!includeReassigned && item.session_id) q.set('session_id', item.session_id)
    let match: InboxItem | undefined
    for (;;) {
      const page = await this.req('GET', path + '?' + q)
      if (page?.status !== 200) return page
      if (!Array.isArray(page.json?.items)) throw Error('missing Items on legacy lookup')
      for (const row of page.json.items as InboxItem[]) {
        if (row.from !== this.member || row.kind !== item.kind || (!includeReassigned && row.session_id !== (item.session_id ?? null))) continue
        if (row.payload?.text !== (item.body?.text ?? '')
          || row.waiter !== (item.waiter ?? this.member) || epochSecond(row.not_before) !== epochSecond(item.not_before)
          || epochSecond(row.deadline) !== epochSecond(item.deadline)) continue
        if (match && match.id !== row.id) return { status: 409, json: { error: 'ambiguous pre-receipt Item' } }
        match = row
      }
      if (!page.json.next_cursor) break
      q.set('cursor', page.json.next_cursor)
    }
    return match ? { status: 200, json: { data: match } } : { status: 204, json: {} }
  }
}
