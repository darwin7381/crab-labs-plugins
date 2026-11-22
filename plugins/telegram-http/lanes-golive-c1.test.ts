// lanes-golive C1: no wake-up line is swallowed. Keep-warm, STALL-WAKE, RESTART-WAKE and the resume line come no_reply from the delivery watchdog
// (fleet-watchdog); the lab router's `mesh-no-reply` rule filed them in the ledger (cache cold, a stuck main never woken, mail never read). Each kind now
// has its destination before any rule, and owes nothing but the item; the daemon's own keep-warm is a mesh event, never a Telegram message of Joey's.
import { test, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?golive-c1') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-golive-c1-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
let n = 0
const mk = (from: string, text: string, meta: Record<string, string> = {}, extra: object = {}) => {
  const ev: any = { id: `mesh-c1-${++n}`, source: 'mesh', from, verified: true, text, meta, notif: { method: 'notifications/claude/channel', params: { content: text, meta } }, no_reply: true, ...extra }
  const w = L.wakeKind(from, text, meta.wake); if (w) ev.wake = w
  return ev
}
const routing = (): any[] => readFileSync(join(dir, 'routing.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))

test('wakeKind: the body field wins; without one, the watchdog sender and its marker; anything else is no wake', () => {
  expect(L.wakeKind('fleet-watchdog', '[保溫] 你閒了 50 分鐘')).toBe('keepwarm')
  expect(L.wakeKind('fleet-watchdog', '讀信箱（3 封未讀，最舊的等了 70 分鐘）：先用 mailbox_list')).toBe('mail')
  expect(L.wakeKind('fleet-watchdog', '[fleet-watchdog] 你有 2 則輸入進了佇列、沒有被送進你的回合')).toBe('stall')
  expect(L.wakeKind('fleet-watchdog', '[fleet-watchdog] 你的 session 重啟了；上一個 session 結束時有 1 個背景子 agent 還沒做完')).toBe('restart')
  expect(L.wakeKind('fleet-watchdog', '[fleet-watchdog] 艦隊帳號在你撞到用量上限之後已經切換，可以繼續了：把被上限打斷的工作重做一次')).toBe('resume')
  expect(L.wakeKind('eve', '[保溫] not the watchdog')).toBeNull()
  expect(L.wakeKind('scheduler', '[scheduled][x][run:9] 讀信箱（')).toBeNull()
  expect(L.wakeKind('anyone', 'text', 'mail-reminder')).toBe('mail')
  expect(L.wakeKind('anyone', 'text', 'stall-wake')).toBe('stall')
  expect(L.lineOf('mail')).toBe('mail'); expect(L.lineOf('page')).toBe('call'); expect(L.lineOf('')).toBeNull()
})

for (const [kind, text] of [['keepwarm', '[保溫] 你閒了 50 分鐘，這一則只是為了不讓對話過期'], ['stall', '[fleet-watchdog] 你有 2 則輸入進了佇列'],
  ['restart', '[fleet-watchdog] 你的 session 重啟了；上一個 session 結束時有 1 個背景子 agent 還沒做完'], ['resume', '[fleet-watchdog] 艦隊帳號在你撞到用量上限之後已經切換，可以繼續了']] as const) {
  test(`a ${kind} line (no_reply, fleet-watchdog) reaches the main as an M1 item that owes nothing else; not the ledger`, async () => {
    const ev = mk('fleet-watchdog', text, { no_reply: 'true' })
    const d = await L.routeEvent(ev)
    expect(d).toMatchObject({ rule: `wake-${kind}`, target: 'main' })
    expect(routing().find(r => r.event === ev.id)).toMatchObject({ rule: `wake-${kind}`, target: 'main', wake: kind })
    const rec = L.__events().get(ev.id)!
    expect((rec.obligations as any[]).map(o => o.kind)).toEqual(['main'])          // no Joey line, no answer owed for a keep-warm
    expect(L.__journal().rows('msg', r => r.event === ev.id).length).toBe(1)        // the item M1 offers the main
  })
}

test('a mesh no_reply notice that is not a wake-up line still goes to the ledger (mesh-no-reply)', async () => {
  const ev = mk('eve', '知會一聲：備份好了', { no_reply: 'true' })
  const d = await L.routeEvent(ev)
  expect(d).toMatchObject({ rule: 'mesh-no-reply', target: 'ledger' })
})

test('server.ts: with lanes on, dispatchInbound builds a Telegram event only for a Telegram message; the agent-inbox daemon and local injects go to the router as mesh events', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  const di = src.slice(src.indexOf('async function dispatchInbound('), src.indexOf("source: 'telegram', from: meta.user ?? 'joey'"))
  expect(di).toContain("if (INBOX_ONLY || meta.via === 'local-inject') { await laneDeliverMesh(notification); return }")
  // the keep-warm's own line carries its kind as a field with lanes on, and only then
  expect(src).toContain("...(Lanes.LANES_ON ? { wake: Lanes.wakeKind(SENDER_KEEPWARM, text) ?? 'keepwarm' } : {})")
  // /inject: the wake kind and the line are fields of the meta the router reads
  expect(src).toContain('Lanes.wakeKind(from, text, body?.wake)')
  expect(src).toContain("line: Lanes.lineOf((body as any)?.line ?? (body as any)?.tier) ?? 'call'")
})
