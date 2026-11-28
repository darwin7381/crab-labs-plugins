import { hostname } from 'os'
import { randomUUID } from 'crypto'
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ActionReq, OnsenClient } from './onsen-client.ts'

export function machineName(host = process.env.ONSEN_HOST): string {
  return (host?.trim() || hostname().replace(/\.local$/, '')).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '').slice(0, 32) || 'unknown'
}

export function connectorId(stateDir: string, member: string, machine = machineName()): string {
  const dir = join(stateDir, 'onsen'), file = join(dir, 'connector-id')
  let id: string
  try { id = readFileSync(file, 'utf8').trim() }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const candidate = randomUUID(), tmp = file + '.' + candidate
    writeFileSync(tmp, candidate, { mode: 0o600, flag: 'wx' })
    try { linkSync(tmp, file) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
    finally { unlinkSync(tmp) }
    id = readFileSync(file, 'utf8').trim()
  }
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid Onsen connector-id in ' + dir)
  return (machine + '/' + member).slice(0, 43) + ':' + id
}

export function takeRefusal(o: { inbox: boolean; roamer: boolean; targetRouting?: boolean; lanes: boolean; record: boolean; observation: boolean }): string | undefined {
  if (o.inbox) return 'INBOX_ONLY'
  if (o.roamer && !o.targetRouting) return 'ROAMER'
  if (!o.lanes && !o.targetRouting) return 'LANES_ON is off'
  if (!o.record) return 'recording is off'
  if (!o.observation) return 'ONSEN_OBSERVATION is off'
}

/** The connector parameter distinguishes this probe from a normal member inbox read. */
export async function deliveryMode(req: ActionReq, path: string, connector: string, active = false) {
  const r = await req('GET', path + '?' + new URLSearchParams({ limit: '1', connector }), undefined, 5000).catch(() => null)
  const code = r?.json?.error?.code ?? r?.json?.detail?.code
  const mode = r?.status === 200 ? 'take' : r?.status === 409 && code === 'not_current_connector' ? 'not_current_connector'
    : !active || (r?.status === 409 && code === 'not_take_member') ? 'pull' : 'unavailable'
  return { mode, take: mode === 'take', status: r?.status, asOf: Date.parse(r?.json?.as_of) }
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
  private readonly modeFile?: string
  private offset = 0
  readonly now = () => Date.now() + this.offset

  constructor(readonly member: string, readonly req: ItemRequest, readonly changed: (canReceive: boolean) => void | Promise<void>,
    readonly log: (line: string, level?: 'info' | 'error') => void, machine: string | { stateDir: string } = machineName(),
    readonly later = (fn: () => void, ms: number) => setTimeout(fn, ms)) {
    this.path = '/v1/members/' + encodeURIComponent(member) + '/items'
    this.connector = typeof machine === 'string' ? machine + '/' + member : connectorId(machine.stateDir, member)
    if (typeof machine !== 'string') {
      this.modeFile = join(machine.stateDir, 'onsen', 'take-member')
      try { this.active = readFileSync(this.modeFile, 'utf8') === member }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    }
  }

  private rememberMode(take: boolean): void {
    if (this.active === take) return
    if (this.modeFile) {
      const tmp = this.modeFile + '.' + process.pid
      writeFileSync(tmp, take ? this.member : '', { mode: 0o600 })
      renameSync(tmp, this.modeFile)
    }
    this.active = take
  }

  get canReceive(): boolean { return this.active && !this.checking && !this.stopped && !this.reason }

  async probe(): Promise<void> {
    const probe = await deliveryMode(this.req, this.path, this.connector, this.active)
    if (this.stopped) return
    this.checking = false
    if (probe.mode === 'not_current_connector') {
      this.rememberMode(true)
      this.pause(probe.mode, 45_000)
      return
    }
    if (probe.mode === 'unavailable') {
      if (probe.status === 401 || probe.status === 403) this.log('onsen take: ' + this.connector + ' mode probe HTTP ' + probe.status + ', retry in 60s', 'error')
      this.pause('mode probe unavailable', 60_000)
      return
    }
    this.rememberMode(probe.take)
    if (!this.active) { this.pause('mode probe: ' + (probe.status ? 'HTTP ' + probe.status : 'no response'), 60_000); return }
    if (Number.isFinite(probe.asOf)) this.offset = probe.asOf - Date.now()
    clearTimeout(this.timer)
    this.timer = undefined
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
