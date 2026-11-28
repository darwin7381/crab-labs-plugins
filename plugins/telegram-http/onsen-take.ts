import { hostname } from 'os'
import type { ActionReq } from './onsen-client.ts'
import { sendOpsAlert } from './system-alert.ts'

export function machineName(host = process.env.ONSEN_HOST): string {
  return (host?.trim() || hostname().replace(/\.local$/, '')).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '').slice(0, 32) || 'unknown'
}

export type ItemRequest = (...args: [...Parameters<ActionReq>, signal?: AbortSignal]) => ReturnType<ActionReq>

export type TakeHealth = { state: 'take' | 'pull-refused' | 'off'; active: boolean; reason: string | null }
export function takeOff(reason: string): TakeHealth {
  return { state: 'off', active: false, reason }
}
export function takeAlert(connector: string, reason: string, notify: (text: string) => void): void {
  sendOpsAlert(`${connector} 已停止領取 Onsen Item（${reason}）。請檢查成員的 take 設定與 connector 狀態。`, 'onsen-take', notify)
}

export class TakeMode {
  readonly path: string
  readonly connector: string
  active = false
  observationRequired = false
  private stopped = false
  private timer?: ReturnType<typeof setTimeout>
  private reason = 'probing'
  onUnavailable?: (reason: string) => void

  health(): TakeHealth {
    if (this.active) return { state: 'take', active: true, reason: null }
    if (this.reason === 'not_take_member') return { state: 'pull-refused', active: false, reason: this.reason }
    return takeOff(this.reason)
  }

  constructor(readonly member: string, readonly req: ItemRequest, readonly changed: (active: boolean) => void,
    readonly log: (line: string) => void, machine = machineName(),
    readonly later = (fn: () => void, ms: number) => setTimeout(fn, ms)) {
    this.path = '/v1/members/' + encodeURIComponent(member) + '/items'
    this.connector = machine + '/' + member
  }

  async probe(): Promise<void> {
    const query = new URLSearchParams({ limit: '1', connector: this.connector })
    const r = await this.req('GET', this.path + '?' + query, undefined, 5000).catch(() => null)
    if (this.stopped) return
    if (r?.status !== 200) {
      const code = r?.json?.error?.code
      const reason = r?.status === 409 && typeof code === 'string' ? code : r ? `HTTP ${r.status} ${code ?? 'probe refused'}` : 'probe unavailable'
      this.pause(reason, code === 'not_current_connector' ? 45_000 : 60_000)
      return
    }
    clearTimeout(this.timer)
    this.reason = ''
    this.active = this.observationRequired = true
    this.log('onsen take: started ' + this.connector)
    this.changed(true)
  }

  pause(reason: string, ms: number): void {
    if (this.stopped) return
    if (this.reason === reason && this.timer) return
    const newReason = reason !== this.reason
    if (newReason) this.log(`onsen take: ${this.connector} ${reason}; retry in ${ms / 1000}s`)
    this.reason = reason
    if (this.active) { this.active = false; this.changed(false) }
    clearTimeout(this.timer)
    this.timer = this.later(() => { this.timer = undefined; void this.probe() }, ms)
    this.timer.unref()
    if (newReason) this.onUnavailable?.(reason)
  }

  stop(): void {
    this.stopped = true
    this.reason = 'stopped'
    clearTimeout(this.timer)
    if (this.active) { this.active = false; this.changed(false) }
  }
}
