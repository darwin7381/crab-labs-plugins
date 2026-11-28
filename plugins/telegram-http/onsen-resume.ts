import { randomUUID } from 'node:crypto'
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
  superseded?: true
  create?: { kind: 'resume'; session_id: 'main'; body: { format: 'markdown'; text: string }; refs: never[]; not_before?: string }
}

/** M2 keeps the unsent write and then the identity of the row written for this interrupted turn. */
export class ResumeItems {
  private sending = new Set<string>()

  constructor(readonly current: () => Row | undefined, readonly save: (entries: Resume[]) => void,
    readonly receiver: () => ItemReceiver | undefined, readonly retire: (id: string) => void, readonly ready: () => void) {}

  private entries(): Resume[] { return this.current()?.resume_items ?? [] }

  cutFields(g: Row, cut: CutTurn) {
    const entries = this.entries()
    if (entries.some(e => !e.superseded && e.session === g.session_id && e.prompt === g.prompt_id)) return { cut_turn: null }
    const entry: Resume = { key: randomUUID(), session: g.session_id, prompt: g.prompt_id, create: {
      kind: 'resume', session_id: 'main', body: { format: 'markdown', text: resumeText(cut) }, refs: [],
      ...(cut.retry_at != null ? { not_before: new Date(cut.retry_at).toISOString() } : {}) } }
    return { cut_turn: null, resume_items: [...entries, entry] }
  }

  /** The peek can arrive before the POST response. Only the latter identifies which cut owns the id. */
  canOffer(id: string): boolean {
    return !this.entries().some(e => e.create || e.id === id && e.superseded)
  }
  cancelling(id: string): boolean { return this.entries().some(e => e.id === id && e.superseded) }

  remember(id: string): void {
    const entries = this.entries(), g = this.current()
    if (!entries.some(e => e.create || e.id === id)) this.save([...entries, { key: id, id, session: g?.session_id }])
  }

  supersede(session: string): void {
    const entries = this.entries()
    const applies = (e: Resume) => !e.superseded && (!e.session || e.session === session)
    if (!entries.some(applies)) return
    this.save(entries.map(e => applies(e) ? { ...e, superseded: true } : e))
    for (const e of entries) if (applies(e) && e.id) {
      // Spool a held claim before its unbound timer fires, even when Onsen is unreachable.
      this.receiver()?.claims.report(e.id, 'superseded')
      this.retire(e.id)
    }
    this.sync()
  }

  sync(): void {
    const receiver = this.receiver()
    if (!receiver?.mode.active) return
    const all = this.entries(), entries = all.filter(e => !e.id || !receiver.claims.completed(e.id))
    if (entries.length !== all.length) this.save(entries)
    for (const e of entries) {
      if (!(e.create || e.superseded) || this.sending.has(e.key)) continue
      this.sending.add(e.key)
      void this.send(e, receiver).catch(err => receiver.mode.log('onsen resume: ' + err))
        .finally(() => this.sending.delete(e.key))
    }
  }

  private async send(e: Resume, receiver: ItemReceiver): Promise<void> {
    const mode = receiver.mode
    if (e.create) {
      const reply = await mode.req('POST', mode.path, e.create, 15_000, { 'Idempotency-Key': e.key })
      const row = reply?.json?.data
      if (!reply || ![200, 201].includes(reply.status) || !row?.id) throw Error('creating resume: HTTP ' + reply?.status)
      const entries = this.entries(), latest = entries.find(entry => entry.key === e.key)
      if (!latest) return
      e = { ...latest, id: row.id, create: undefined }
      this.save(entries.map(entry => entry === latest ? e : entry))
      if (!e.superseded) { this.ready(); return }
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
