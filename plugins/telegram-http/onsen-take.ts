import { hostname } from 'os'
import type { ActionReq } from './onsen-client.ts'

export function machineName(host = process.env.ONSEN_HOST): string {
  return (host?.trim() || hostname().replace(/\.local$/, '')).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '').slice(0, 32) || 'unknown'
}

export type ItemRequest = (...args: [...Parameters<ActionReq>, signal?: AbortSignal]) => ReturnType<ActionReq>

export class TakeMode {
  readonly path: string
  readonly connector: string
  active = false
  observationRequired = false
  private stopped = false
  private timer?: ReturnType<typeof setTimeout>
  private reason = ''

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
      this.pause(r ? `HTTP ${r.status} ${code ?? 'probe refused'}` : 'probe unavailable', code === 'not_current_connector' ? 45_000 : 60_000)
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
    if (reason !== this.reason) this.log(`onsen take: ${this.connector} ${reason}; retry in ${ms / 1000}s`)
    this.reason = reason
    if (this.active) { this.active = false; this.changed(false) }
    clearTimeout(this.timer)
    this.timer = this.later(() => { this.timer = undefined; void this.probe() }, ms)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    if (this.active) { this.active = false; this.changed(false) }
  }
}
