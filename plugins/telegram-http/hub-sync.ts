// Hub sync's leftovers (1.52.0, board WO-158; Joey TG chiron:2403 「果斷一點馬上解決」).
//
// 1.33.0–1.51.0: the agent-inbox daemon asked BTCC every 30 s for the rows addressed to its agent that it had not taken
// (GET /api/mesh/inbox/pending: rows with a payload, written by BTCC's console send and mesh push), pushed each into the
// session and reported it taken (POST /api/mesh/inbox/taken); an /inject carrying a sender-assigned BTCC id was a
// "doorbell" that waited for that sync. Removed in 1.52.0: every BTCC sender that writes such a row also writes the
// recipient's Onsen inbox (backend/app/onsen_send.py through comms.onsen_copy: comms.py _deliver, mesh.py push), and the
// daemon takes from Onsen (onsen-inbox.ts). Nothing reads received_at except that pending list.
//
// What stays: a doorbell an older process parked on disk (hub-doorbell/<id>.json) while it waited for a sync is handed
// to the delivery once at start, so the upgrade strands none. The old state file (hub-sync.json) is left as it is.

import { readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'

export type Notif = { method: string; params: unknown }
export const DOORBELL_DIR = 'hub-doorbell'

/** Doorbells a previous process held waiting for a hub sync: hand each to the delivery (the old path), then remove its
 *  file. Returns how many were dispatched. A file that cannot be read or delivered is logged and kept. */
export async function drainLeftoverDoorbells(stateDir: string, dispatch: (chatId: string, n: Notif) => Promise<void>,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void): Promise<number> {
  const dir = join(stateDir, DOORBELL_DIR)
  let files: string[] = []
  try { files = readdirSync(dir).filter(f => f.endsWith('.json')).sort() } catch { return 0 }
  let n = 0
  for (const f of files) {
    try {
      const h = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { chatId: string; notif: Notif }
      await dispatch(h.chatId, h.notif)
      n++
    } catch (err) {
      log('warn', `hub: leftover doorbell ${f} unreadable or undeliverable: ${err}`)
      continue
    }
    try { rmSync(join(dir, f)) } catch {}
  }
  if (n) log('info', `hub: hub sync was removed in 1.52.0 — ${n} doorbell(s) held by the previous process handed to the delivery`)
  return n
}
