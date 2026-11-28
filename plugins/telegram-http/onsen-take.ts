import { hostname } from 'os'
import type { ActionReq, OnsenClient } from './onsen-client.ts'

export function machineName(host = process.env.ONSEN_HOST): string {
  return (host?.trim() || hostname().replace(/\.local$/, '')).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '').slice(0, 32) || 'unknown'
}

export function takeRefusal(o: { inbox: boolean; roamer: boolean; targetRouting?: boolean; lanes: boolean; record: boolean; observation: boolean }): string | undefined {
  if (o.inbox) return 'INBOX_ONLY'
  if (o.roamer && !o.targetRouting) return 'ROAMER'
  if (!o.lanes && !o.targetRouting) return 'LANES_ON is off'
  if (!o.record) return 'recording is off'
  if (!o.observation) return 'ONSEN_OBSERVATION is off'
}

type DeliveryObservation = 'take' | 'foreign' | 'pull' | undefined

// Only a member-mode response can switch an established member back to pull.
export function reportedDelivery(source: 'items' | 'inbox', status?: number, code?: string): DeliveryObservation {
  if (source === 'inbox') {
    if (status === 200) return 'pull'
    if (status === 409 && code === 'take_member') return 'take'
  } else {
    if (status === 200) return 'take'
    if (status === 400 || status === 404 || (status === 409 && code === 'not_take_member')) return 'pull'
    if (status === 409 && code === 'not_current_connector') return 'foreign'
  }
}

export class MemberDelivery {
  active = false

  observe(observation: DeliveryObservation): boolean | undefined {
    if (observation === undefined) return
    return this.active = observation !== 'pull'
  }
}

/** The connector parameter distinguishes this probe from a normal member inbox read. */
export async function deliveryMode(req: ActionReq, path: string, connector: string) {
  const r = await req('GET', path + '?' + new URLSearchParams({ limit: '1', connector }), undefined, 5000).catch(() => null)
  const observation = reportedDelivery('items', r?.status, r?.json?.error?.code ?? r?.json?.detail?.code)
  return { take: observation === 'take', observation, status: r?.status, asOf: Date.parse(r?.json?.as_of) }
}

export type ItemRequest = OnsenClient['request']

export class TakeMode extends MemberDelivery {
  readonly path: string
  readonly connector: string
  checking = true
  observationRequired = false
  private stopped = false
  private timer?: ReturnType<typeof setTimeout>
  private reason = ''
  private offset = 0
  readonly now = () => Date.now() + this.offset

  constructor(readonly member: string, readonly req: ItemRequest, readonly changed: (canReceive: boolean) => void | Promise<void>,
    readonly log: (line: string) => void, machine = machineName(),
    readonly later = (fn: () => void, ms: number) => setTimeout(fn, ms)) {
    super()
    this.path = '/v1/members/' + encodeURIComponent(member) + '/items'
    this.connector = machine + '/' + member
  }

  get canReceive(): boolean { return this.active && !this.stopped && !this.reason }

  async probe(): Promise<void> {
    const mode = await deliveryMode(this.req, this.path, this.connector)
    if (this.stopped) return
    this.checking = false
    const observed = this.observe(mode.observation)
    if (mode.observation === 'foreign') {
      this.pause('not_current_connector', 45_000)
      return
    }
    if (observed === undefined && this.active) { this.pause('mode probe unavailable', 60_000); return }
    if (!this.active) { this.pause('mode probe: ' + (mode.status ? 'HTTP ' + mode.status : 'no response'), 60_000); return }
    clearTimeout(this.timer)
    this.timer = undefined
    if (Number.isFinite(mode.asOf)) this.offset = mode.asOf - Date.now()
    this.reason = ''
    this.observationRequired = true
    this.log('onsen take: started ' + this.connector)
    try { await this.changed(true) }
    catch (e) { this.pause('could not start ' + this.connector + ': ' + e, 60_000) }
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
