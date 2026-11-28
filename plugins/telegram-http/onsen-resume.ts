import { randomUUID } from 'node:crypto'
import type { Row } from './lanes-state.ts'
import type { ItemReceiver } from './onsen-receive.ts'
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

type Resume = { key: string; session: string; prompt?: string; create?: { kind: 'resume'; session_id: 'main'
  body: { format: 'markdown'; text: string }; refs: never[]; not_before?: string }; id?: string; version?: number }

/** M2 keeps the unsent write and then the identity of the row written for this interrupted turn. */
export class ResumeItems {
  private sending = new Set<string>()

  constructor(readonly current: () => Row | undefined, readonly save: (entries: Resume[]) => void,
    readonly receiver: () => ItemReceiver | undefined) {}

  private entries(): Resume[] { return this.current()?.resume_items ?? [] }

  cutFields(g: Row, cut: CutTurn) {
    const entries = this.entries()
    if (entries.some(e => e.session === g.session_id && e.prompt === g.prompt_id)) return { cut_turn: null }
    const entry: Resume = { key: randomUUID(), session: g.session_id, prompt: g.prompt_id, create: {
      kind: 'resume', session_id: 'main', body: { format: 'markdown', text: resumeText(cut) }, refs: [],
      ...(cut.retry_at != null ? { not_before: new Date(cut.retry_at).toISOString() } : {}) } }
    return { cut_turn: null, resume_items: [...entries, entry] }
  }

  private replace(key: string, edit: (entry: Resume) => Resume) {
    this.save(this.entries().map(e => e.key === key ? edit(e) : e))
  }

  sync(): void {
    const receiver = this.receiver()
    if (!receiver?.mode.active) return
    for (const e of this.entries()) {
      if (!e.create || this.sending.has(e.key)) continue
      this.sending.add(e.key)
      void this.send(e, receiver).catch(err => receiver.mode.log('onsen resume: ' + err))
        .finally(() => this.sending.delete(e.key))
    }
  }

  private async send(e: Resume, receiver: ItemReceiver): Promise<void> {
    const mode = receiver.mode
    const reply = await mode.req('POST', mode.path, e.create, 15_000, { 'Idempotency-Key': e.key })
    const row = reply?.json?.data
    if (!reply || ![200, 201].includes(reply.status) || !row?.id || !Number.isInteger(row.version)) throw Error('creating resume: HTTP ' + reply?.status)
    this.replace(e.key, latest => ({ ...latest, create: undefined, id: row.id, version: row.version }))
  }
}
