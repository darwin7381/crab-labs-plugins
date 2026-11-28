import { hostname } from 'os'
import type { ActionReq, OnsenClient } from './onsen-client.ts'

export function machineName(host = process.env.ONSEN_HOST): string {
  return (host?.trim() || hostname().replace(/\.local$/, '')).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '').slice(0, 32) || 'unknown'
}

export function takeRefusal(o: { inbox: boolean; roamer: boolean; lanes: boolean; record: boolean; observation: boolean }): string | undefined {
  if (o.inbox) return 'INBOX_ONLY'
  if (o.roamer) return 'ROAMER'
  if (!o.lanes) return 'LANES_ON is off'
  if (!o.record) return 'recording is off'
  if (!o.observation) return 'ONSEN_OBSERVATION is off'
}

/** The connector parameter distinguishes this probe from a normal member inbox read. */
export async function deliveryMode(req: ActionReq, path: string, connector: string): Promise<'take' | 'pull'> {
  const r = await req('GET', path + '?' + new URLSearchParams({ limit: '1', connector }), undefined, 5000).catch(() => null)
  return r?.status === 200 ? 'take' : 'pull'
}

export type ItemRequest = OnsenClient['request']

export class TakeMode {
  readonly path: string
  readonly connector: string
  checking = true
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
    const mode = await deliveryMode(this.req, this.path, this.connector)
    if (this.stopped) return
    this.checking = false
    if (mode === 'pull') {
      if (this.reason === 'not_current_connector') this.pause(this.reason, 45_000)
      else this.pause('mode probe did not return 200', 60_000)
      return
    }
    this.reason = ''
    this.active = this.observationRequired = true
    this.log('onsen take: started ' + this.connector)
    this.changed(true)
  }

  pause(reason: string, ms: number): void {
    if (this.stopped) return
    if (this.reason === reason && this.timer) return
    if (reason !== this.reason) this.log('onsen take: ' + reason)
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
