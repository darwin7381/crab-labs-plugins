import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Row } from './lanes-state.ts'
import type { ItemReceiver } from './onsen-receive.ts'
import { itemRef, type InboxItem } from './onsen-items.ts'
import { hhmmTaipei } from './usage-wall.ts'

export const ACCOUNT_WALL = new Set(['rate_limit', 'billing_error', 'account_on_hold', 'authentication_failed', 'oauth_org_not_allowed', 'cloud_credential_error'])
export type CutTurn = { at: number; why: string; retry_at?: number; background_agents?: number }

export function resumeText(cut: CutTurn): string {
  const reason = ACCOUNT_WALL.has(cut.why) ? '用量上限' : cut.why === 'gen_end' ? '對話結束' : `模型回應錯誤 ${cut.why}`
  const background = cut.background_agents ? `當時有 ${cut.background_agents} 個背景工作在跑，重開後已經不在。` : ''
  return `上一回合 ${hhmmTaipei(cut.at)}（台北）被打斷（${reason}），接著做沒做完的；沒有要接的就直接結束這一回合。${background}`
}

export function resumeNotification(content: string) {
  return { method: 'notifications/claude/channel', params: { content, meta: { chat_id: 'lanes', user: 'lanes', via: 'lanes', no_reply: 'true' } } }
}

type Resume = {
  key: string
  session?: string
  prompt?: string
  id?: string
  text?: string
  superseded?: true
  withdrawn?: true
  rejected?: true
  awaitingRelease?: true
  create?: { kind: 'resume'; session_id: 'main'; body: { format: 'markdown'; text: string }; refs: never[]; not_before?: string }
}
export type ResumeLine = { key: string; session: string; text: string }

/** M2 keeps the unsent write and then the identity of the row written for this interrupted turn. */
export class ResumeItems {
  private sending = new Set<string>()

  constructor(readonly current: () => Row | undefined, readonly save: (entries: Resume[]) => void,
    readonly receiver: () => ItemReceiver | undefined, readonly delivered: (id: string) => boolean,
    readonly retire: (id: string, reason: 'superseded' | 'withdrawn') => void, readonly ready: () => void) {}

  private entries(): Resume[] { return this.current()?.resume_items ?? [] }

  /** Before settled 59, the acknowledgement dropped the text. Its original POST is in the same journal. */
  restoreLines(path: string, receipts: Row[]): void {
    const entries = this.entries(), missing = entries.filter(e => e.id && !e.create && !e.text && !e.withdrawn && !e.superseded)
    if (!missing.length) return
    const texts = new Map<string, string>()
    for (const r of receipts) {
      const id = r.onsen_items?.[0]?.onsen_item_id, text = r.notif?.params?.content
      if (id && text) texts.set(id, text)
    }
    if (missing.some(e => !texts.has(e.id!))) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.includes('"resume_items"') || !line.includes('"create"')) continue
        let row
        try { row = JSON.parse(line) } catch { continue }
        for (const e of row.resume_items ?? []) if (e.create?.body?.text) texts.set(e.key, e.create.body.text)
      }
    }
    const restored = new Map(missing.map(e => [e, texts.get(e.key) ?? texts.get(e.id!)]))
    if (missing.some(e => restored.get(e))) this.save(entries.map(e => restored.get(e) ? { ...e, text: restored.get(e) } : e))
  }

  private undelivered(e: Resume): boolean { return !e.superseded && !e.withdrawn && (!e.id || !this.delivered(e.id)) }

  line(session: string): ResumeLine | undefined {
    const rx = this.receiver()
    if (!rx?.mode.active) return
    const e = this.entries().find(e => e.session === session && this.undelivered(e)
      && (e.text || e.create?.body.text) && !(e.id && (rx.taking(e.id) || rx.claims.owns(e.id))))
    if (e) return { key: e.key, session, text: e.text ?? e.create!.body.text }
  }

  withdraw(line: ResumeLine): void {
    const entries = this.entries(), e = entries.find(e => (e.key === line.key || e.id === line.key) && e.session === line.session)
    if (!e || !this.undelivered(e)) return
    this.save(entries.map(it => it === e ? { ...e, withdrawn: true } : it))
    if (e.id) this.retire(e.id, 'withdrawn')
    this.sync()
  }

  cutFields(g: Row, cut: CutTurn) {
    const entries = this.entries()
    if (entries.some(e => e.session === g.session_id && this.undelivered(e))) return { cut_turn: null }
    const entry: Resume = { key: randomUUID(), session: g.session_id, prompt: g.prompt_id, create: {
      kind: 'resume', session_id: 'main', body: { format: 'markdown', text: resumeText(cut) }, refs: [],
      ...(cut.retry_at != null ? { not_before: new Date(cut.retry_at).toISOString() } : {}) } }
    return { cut_turn: null, resume_items: [...entries, entry] }
  }

  /** While a matching POST is unacknowledged, a peek cannot identify the cut from its text alone. */
  canOffer(id: string, text: string): boolean {
    const entries = this.entries(), known = entries.find(e => e.id === id)
    if (known?.superseded || known?.withdrawn) return false
    if (known && known.key !== id) return true // the POST identified this row
    return !entries.some(e => e.create?.body.text === text)
  }
  cancelling(id: string): 'superseded' | 'withdrawn' | undefined {
    const e = this.entries().find(e => e.id === id)
    return e?.withdrawn ? 'withdrawn' : e?.superseded ? 'superseded' : undefined
  }

  remember(id: string, text: string): void {
    const entries = this.entries()
    const prior = entries.find(e => e.id === id)
    if (prior && (prior.awaitingRelease || !prior.text && text)) {
      // A new waiting peek follows the other connector's release. The rest of the spool can run meanwhile.
      this.save(entries.map(e => e === prior ? { ...e, text: e.text ?? text, awaitingRelease: undefined } : e))
      this.sync()
    } else if (!prior) this.save([...entries, { key: id, id, text, session: this.current()?.session_id }])
  }

  supersede(session: string, interruptedPrompt?: string): void {
    const entries = this.entries()
    const pending = new Set(entries.filter(e => (!e.session || e.session === session)
      && (!interruptedPrompt || e.prompt === interruptedPrompt) && this.undelivered(e)))
    if (!pending.size) return
    this.save(entries.map(e => pending.has(e) ? { ...e, superseded: true } : e))
    for (const e of pending) if (e.id) {
      // Spool a held claim before its unbound timer fires, even when Onsen is unreachable.
      this.receiver()?.claims.report(e.id, 'superseded')
      this.retire(e.id, 'superseded')
    }
    this.sync()
  }

  sync(): void {
    const receiver = this.receiver()
    if (!receiver?.mode.active) return
    const all = this.entries(), entries = all.filter(e => !e.id || !receiver.claims.completed(e.id))
    if (entries.length !== all.length) this.save(entries)
    for (const e of entries) {
      if (e.create) receiver.mode.writeItem?.({ key: e.key, item: e.create })
      else if ((e.superseded || e.withdrawn) && e.id && !e.rejected && !e.awaitingRelease && !receiver.taking(e.id)
        && (e.withdrawn || !receiver.claims.blocked()))
        receiver.mode.writeItem?.({ key: e.id, id: e.id, outcome: e.withdrawn ? 'withdrawn' : 'superseded' })
    }
  }

  /** Called before the spool advances its cursor, including on replay after a restart. */
  settled(write: ItemWrite, row?: InboxItem): void {
    const entries = this.entries(), entry = entries.find(e => 'item' in write ? e.key === write.key : e.id === write.id)
    if (!entry) return
    if ('item' in write) {
      if (write.item.kind !== 'resume' || !entry.create) return
      const other = entries.filter(e => e !== entry && (!row || e.id !== row.id))
      const seen = row && entries.find(e => e.id === row.id)
      const delivered = row && (row.in_session_at || this.delivered(row.id))
      const superseded = seen?.superseded || (delivered ? undefined : entry.superseded)
      const withdrawn = seen?.withdrawn || (delivered ? undefined : entry.withdrawn)
      this.save(row ? [...other, { ...seen, ...entry, create: undefined, id: row.id, text: entry.create.body.text, superseded, withdrawn }] : other)
      if (row && (withdrawn || superseded)) this.retire(row.id, withdrawn ? 'withdrawn' : 'superseded')
    } else {
      if (write.outcome !== this.cancelling(write.id)) return
      const receiver = this.receiver()
      if (row?.state === 'claimed' && row.claim && !row.in_session_at && !receiver?.claims.inSession(row.id)) {
        if (!receiver || row.claim.connector !== receiver.mode.connector || write.outcome === 'withdrawn') {
          if (write.outcome === 'withdrawn' && receiver?.claims.owns(row.id)) receiver.claims.report(row.id, 'not_taken')
          this.save(entries.map(e => e === entry ? { ...e, awaitingRelease: true } : e))
          return
        }
        if (receiver.taking(row.id)) return
        receiver.claims.taken(row, itemRef(row))
        receiver.claims.report(row.id, 'superseded')
      }
      // A refused DELETE must never let a later peek deliver this cancelled local offer.
      this.save(row ? entries.filter(e => e !== entry) : entries.map(e => e === entry ? { ...e, rejected: true } : e))
    }
    if (!mode.active || !e.id) return
    const id = e.id, path = '/v1/items/' + encodeURIComponent(id)
    this.retire(id)
    if (receiver.taking(id) || receiver.claims.blocked()) return
    const detail = await mode.req('GET', path)
    if (!mode.active) return
    const row: InboxItem | undefined = detail?.json?.data
    if (detail?.status !== 404) {
      if (detail?.status !== 200 || row?.kind !== 'resume' || row.id !== id) throw Error('reading resume ' + id + ': HTTP ' + detail?.status)
      if (row.state === 'claimed') {
        if (row.claim?.connector === mode.connector && !receiver.taking(id) && !receiver.claims.blocked()) {
          receiver.claims.taken(row, itemRef(row))
          receiver.claims.report(id, 'superseded')
        }
        return
      }
      if (row.state === 'waiting') {
        const ended = await mode.req('DELETE', path, { expected_version: row.version, outcome: 'superseded' })
        if (ended?.status === 409) return // Another writer won. The next pump reads the new version or claim.
        if (ended?.status !== 200 && ended?.status !== 404) throw Error('ending resume ' + id + ': HTTP ' + ended?.status)
      }
    }
    this.save(this.entries().filter(entry => entry.key !== e.key))
  }
}
