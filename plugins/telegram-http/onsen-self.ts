import type { ActionReq, OnsenClient } from './onsen-client.ts'
import type { InboxItem } from './onsen-items.ts'

export type OwnItem = {
  kind: 'self' | 'keepwarm'; session_id: string; waiter?: string
  body: { format: 'markdown'; text: string }; refs: InboxItem['refs']
  not_before: string | null; deadline: string | null; expires_at: string | null
}
/** The original request stays identical when its response is lost, including across a spool replay. */
export type SelfWrite = { key: string; item: OwnItem; complete?: true }
export type SelfWriter = (write: SelfWrite) => void
type Request = OnsenClient['request']
export function ownItem(kind: OwnItem['kind'], session: string, text: string, due: number | null,
  waiter?: string, deadline: number | null = null, refs: InboxItem['refs'] = []): OwnItem {
  const iso = (ms: number | null) => ms === null ? null : new Date(ms).toISOString()
  return { kind, session_id: session, body: { format: 'markdown', text }, refs,
    not_before: iso(due), deadline: iso(deadline), expires_at: null, ...(waiter ? { waiter } : {}) }
}

export function postOwnItem(req: ActionReq, path: string, write: SelfWrite) {
  return req('POST', path, write.item, undefined, { 'Idempotency-Key': write.key })
}

/** The creation key also resolves an opaque id after a restart. Read the current version before closing.
 * A claimed Item is already in C1's receive/report path. Replaying after a successful DELETE is harmless. */
export async function syncSelfWrite(req: Request, path: string, write: SelfWrite) {
  const created = await postOwnItem(req, path, write)
  if (!write.complete || !created?.json?.data?.id || created.status >= 300) return created
  const detail = '/v1/items/' + encodeURIComponent(created.json.data.id)
  const current = await req('GET', detail)
  if (current?.status !== 200 || current.json.data.state !== 'waiting') return current
  const result = await req('DELETE', detail, { expected_version: current.json.data.version, outcome: 'completed' })
  if (result?.status !== 409) return result
  const latest = await req('GET', detail)
  // A concurrent edit left it waiting. Let the spool read the new version on its next attempt.
  if (latest?.status === 200 && latest.json.data.state === 'waiting') return { status: 503, json: result.json }
  return latest
}
