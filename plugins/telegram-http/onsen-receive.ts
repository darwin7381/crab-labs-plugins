import { randomUUID } from 'crypto'
import type { InboxItem, ItemRef } from './onsen-items.ts'
import type { TakeMode } from './onsen-take.ts'

export type Outcome = 'in_session' | 'not_taken' | 'completed' | 'owed' | 'background' | 'not_applied'
  | 'usage_limit' | 'usage_limit_probe' | 'error' | 'cut' | 'cut_person' | 'stopped' | 'stuck' | 'reassigned'
export type ReportFields = { session_id?: string; response_message_ids?: string[]; retry_after?: string | null
  half_done?: boolean; command_message_id?: string; note?: string }
export type ItemReport = { item_id: string; body: { claim_id: string; at: string; outcome: Outcome } & ReportFields }
export type ReceiveResult = { given: Set<string>; gone: Set<string> }
const empty = (): ReceiveResult => ({ given: new Set(), gone: new Set() })
export const itemIds = (refs: ItemRef[]) => refs.map(r => r.onsen_item_id)

export type ClaimStore = {
  blocked(): boolean
  owns(id: string): boolean
  taken(row: InboxItem, ref: ItemRef): void
  bind(id: string, session: string, turn: string, registrySession?: string): void
  report(id: string, outcome: Outcome, fields?: ReportFields): void
  finalStop(session: string, turn: string): void
  continued(turn: string): void
}

export class ItemReceiver {
  private refused = new Map<string, { version: number; rides: boolean }>()
  private requesting = new Set<string>()
  constructor(readonly mode: TakeMode, readonly claims: ClaimStore, readonly dueAt: (time: string) => void, readonly revisit?: () => void) {}

  report(refs: ItemRef[], outcome: Outcome, fields?: ReportFields): void {
    for (const ref of refs) this.claims.report(ref.onsen_item_id, outcome, fields)
  }

  bind(refs: ItemRef[] | undefined, session: string, turn: string, registrySession?: string): void {
    for (const ref of refs ?? []) this.claims.bind(ref.onsen_item_id, session, turn, registrySession)
  }

  async receive(refs: ItemRef[], hook = false, binding = false, onGone?: (ids: Set<string>) => void): Promise<ReceiveResult> {
    const result = empty()
    if (!this.mode.active || this.claims.blocked()) return result
    const byId = new Map(refs.map(r => [r.onsen_item_id, r]))
    const ids = [...byId.keys()]
    if (ids.some(id => this.requesting.has(id))) return result
    if (binding) for (const id of ids) if (this.claims.owns(id)) result.given.add(id)
    const leads = new Set(refs.filter(r => r.kind === 'message' && r.reason !== 'cut_person' && r.reason !== 'parked'
      && !this.claims.owns(r.onsen_item_id) && r.onsen_version > (this.refused.get(r.onsen_item_id)?.version ?? -1)).map(r => r.from))
    const need = ids.filter(id => {
      const ref = byId.get(id)!, refusal = this.refused.get(id)
      if (refusal && ref.onsen_version <= refusal.version && !(refusal.rides && leads.has(ref.from))) return false
      this.refused.delete(id)
      return !this.claims.owns(id)
    }).slice(0, 100)
    if (!need.length) return result
    for (const id of need) this.requesting.add(id)
    const key = randomUUID()
    const take = () => this.mode.req('POST', this.mode.path + '/take', {
      connector: this.mode.connector, item_ids: need, wait: 0, limit: need.length,
    }, hook ? 3000 : 15_000, { 'Idempotency-Key': key })
    let expired = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async (): Promise<ReceiveResult> => {
      let r = await take().catch(() => null)
      // The first write may have committed before the response was lost. Recover its exact result.
      let retry = 0
      while ((!r || r.status >= 500 || expired && retry === 0) && this.mode.active) {
        if (retry) await new Promise(resolve => setTimeout(resolve, Math.min(30_000, 1000 * retry)).unref())
        if (!this.mode.active) return empty()
        retry++
        if (!this.claims.blocked()) r = await take().catch(() => null)
      }
      clearTimeout(timer)
      if (r?.status === 409) {
        const why = r.json?.error?.code
        if (why === 'not_current_connector' || why === 'not_take_member') this.mode.pause(why, why === 'not_current_connector' ? 45_000 : 60_000)
      }
      if (r?.status !== 200) return empty()
      const data = r.json.data
      if (data.next_not_before) this.dueAt(data.next_not_before)
      for (const row of data.items as InboxItem[]) {
        const ref = byId.get(row.id)
        if (!ref || !row.claim) continue
        this.claims.taken(row, ref)
        result.given.add(row.id)
      }
      const refused = need.filter(id => !result.given.has(id))
      const inspect = async () => {
        await Promise.all(refused.map(async id => {
          const single = await this.mode.req('GET', '/v1/items/' + encodeURIComponent(id), undefined, 3000).catch(() => null)
          if (single?.status === 404 || (single?.status === 200 && single.json.data.state !== 'waiting')) result.gone.add(id)
          const row: InboxItem | undefined = single?.json?.data
          if (row?.state === 'waiting' && (row.reason === 'parked' && !row.released || row.reason === 'cut_person')) {
            this.refused.set(id, { version: row.version, rides: row.reason === 'cut_person' })
          }
          if (row?.not_before) this.dueAt(row.not_before)
        }))
        if (result.gone.size) onGone?.(result.gone)
      }
      if (expired || !this.mode.active) {
        for (const id of need) if (result.given.has(id)) this.claims.report(id, 'not_taken')
        return empty()
      }
      if (refused.length) {
        if (hook) setTimeout(() => void inspect(), 0)
        else await inspect()
      }
      return result
    }
    const work = run().finally(() => { clearTimeout(timer); for (const id of need) this.requesting.delete(id) })
    if (!hook) return work
    return Promise.race([work, new Promise<ReceiveResult>(resolve => {
      timer = setTimeout(() => { expired = true; resolve(empty()) }, 3000)
    })])
  }
}
