import { hostname } from 'os'
import type { ActionReq } from './onsen-client.ts'

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
export async function deliveryMode(req: ActionReq, path: string, connector: string, active = false): Promise<'take' | 'pull' | 'not_current_connector' | 'unavailable'> {
  const r = await req('GET', path + '?' + new URLSearchParams({ limit: '1', connector }), undefined, 5000).catch(() => null)
  if (r?.status === 409 && r.json?.error?.code === 'not_current_connector') return 'not_current_connector'
  if (active && (!r || r.status >= 500)) return 'unavailable'
  return r?.status === 200 ? 'take' : 'pull'
}

export type ItemRequest = (...args: [...Parameters<ActionReq>, signal?: AbortSignal]) => ReturnType<ActionReq>

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

  constructor(readonly member: string, readonly req: ItemRequest, readonly changed: (canReceive: boolean) => void,
    readonly log: (line: string) => void, machine = machineName(),
    readonly later = (fn: () => void, ms: number) => setTimeout(fn, ms)) {
    this.path = '/v1/members/' + encodeURIComponent(member) + '/items'
    this.connector = machine + '/' + member
  }

  get canReceive(): boolean { return this.active && !this.stopped && !this.reason }

  async probe(): Promise<void> {
    const mode = await deliveryMode(this.req, this.path, this.connector, this.active)
    if (this.stopped) return
    this.checking = false
    if (mode === 'not_current_connector') {
      this.active = true
      this.pause(mode, 45_000)
      return
    }
    if (mode === 'unavailable') { this.pause('mode probe unavailable', 60_000); return }
    this.active = mode === 'take'
    if (!this.active) { this.pause('mode probe did not return 200', 60_000); return }
    clearTimeout(this.timer)
    this.timer = undefined
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
