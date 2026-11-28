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
export async function deliveryMode(req: ActionReq, path: string, connector: string) {
  const r = await req('GET', path + '?' + new URLSearchParams({ limit: '1', connector }), undefined, 5000).catch(() => null)
  return { take: r?.status === 200, status: r?.status, code: r?.json?.error?.code, asOf: Date.parse(r?.json?.as_of) }
}

export type ItemRequest = OnsenClient['request']

/** The C1 member-mode check used by the local delivery and notification gates. */
export function takeModeActive(mode?: Pick<TakeMode, 'active'>): boolean { return mode?.active === true }

export class TakeMode {
  readonly path: string
  readonly connector: string
  checking = true
  active = false  // member delivery mode; pausing this connector does not switch the member to pull
  observationRequired = false
  private stopped = false
  private timer?: ReturnType<typeof setTimeout>
  private reason = ''
  private offset = 0
  readonly now = () => Date.now() + this.offset

  constructor(readonly member: string, readonly req: ItemRequest, readonly changed: (canReceive: boolean) => void,
    readonly log: (line: string) => void, machine = machineName(),
    readonly later = (fn: () => void, ms: number) => setTimeout(fn, ms)) {
    this.path = '/v1/members/' + encodeURIComponent(member) + '/items'
    this.connector = machine + '/' + member
  }

  get canReceive(): boolean { return this.active && !this.stopped && !this.reason }

  async probe(): Promise<void> {
    const mode = await deliveryMode(this.req, this.path, this.connector)
    if (this.stopped) return
    this.checking = false
    if (mode.status === 409 && mode.code === 'not_current_connector') {
      this.active = true
      this.pause(mode.code, 45_000)
      return
    }
    if (this.active && (!mode.status || mode.status >= 500)) { this.pause('mode probe unavailable', 60_000); return }
    this.active = mode.take
    if (!this.active) { this.pause('mode probe: ' + (mode.status ? 'HTTP ' + mode.status : 'no response'), 60_000); return }
    clearTimeout(this.timer)
    this.timer = undefined
    if (Number.isFinite(mode.asOf)) this.offset = mode.asOf - Date.now()
    this.reason = ''
    this.observationRequired = true
    this.log('onsen take: started ' + this.connector)
    this.changed(true)
  }

  pause(reason: string, ms: number): void {
    if (this.stopped) return
    if (this.reason === reason && this.timer) return
    if (reason !== this.reason) {
      this.log('onsen take: ' + reason)
      this.reason = reason
      this.changed(false)
    }
    clearTimeout(this.timer)
    this.timer = this.later(() => { this.timer = undefined; void this.probe() }, ms)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = this.checking = true
    clearTimeout(this.timer)
    if (this.active) { this.active = false; this.changed(false) }
  }
}
