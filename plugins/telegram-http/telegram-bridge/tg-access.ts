// tg-access.ts: who may talk to an agent's bot, read from that agent's own <state dir>/access.json, exactly as its daemon reads it today
// (WO-196 part B: 「過白名單（照舊讀那一隻的 access.json，配對照舊）」). Ported from server.ts 1.58.21 (gate 367-426, dmCommandGate 429-439,
// isMentioned 441-465, readAccessFile 288-312, pruneExpired 350-360, pairingRemainingMin 513-515, checkApprovals 471-491): server.ts cannot be
// imported (it starts a bot and exits without a port at load), and once WO-197 makes the daemons connectors this code leaves server.ts; the
// bridge then holds the only copy. The group and sender allowlists govern intake; Onsen chooses the recipients (§4c).
//
// One difference, on purpose: a corrupt access.json is not moved aside and replaced (the daemon did that to its own file); the bridge reads
// another program's file, so it refuses every message of that bot until the file reads again (fail closed), one log line.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PAIRING_TTL_MS = 30 * 60 * 1000
export type PendingEntry = { senderId: string; chatId: string; createdAt: number; expiresAt: number; replies: number }
export type GroupPolicy = { requireMention: boolean; allowFrom: string[] }
export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
  alertTo?: string[]
}
export const defaultAccess = (): Access => ({ dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} })

/** access.json of a state dir: the file's values (missing file: the default); null = the file is there and does not parse (refuse everything) */
export function readAccess(stateDir: string): Access | null {
  let raw: string
  try { raw = readFileSync(join(stateDir, 'access.json'), 'utf8') } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? defaultAccess() : null
  }
  try {
    const p = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: p.dmPolicy ?? 'pairing', allowFrom: (p.allowFrom ?? []).map(String), groups: p.groups ?? {}, pending: p.pending ?? {},
      mentionPatterns: p.mentionPatterns, ackReaction: p.ackReaction, replyToMode: p.replyToMode, textChunkLimit: p.textChunkLimit,
      chunkMode: p.chunkMode, alertTo: Array.isArray(p.alertTo) ? p.alertTo.map(String) : undefined,
    }
  } catch { return null }
}

/** written as the daemon writes it (server.ts saveAccess): tmp file, mode 600, rename */
export function saveAccess(stateDir: string, a: Access): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, 'access.json'), tmp = `${file}.bridge-${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export function pruneExpired(a: Access, now = Date.now()): boolean {
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) if (p.expiresAt < now) { delete a.pending[code]; changed = true }
  return changed
}

export const pairingRemainingMin = (expiresAt: number, now = Date.now()): number => Math.max(1, Math.ceil((expiresAt - now) / 60000))

/** what the gate looks at in one Telegram message */
export type GateMsg = { from?: { id: number | string } | null; chat?: { id: number | string; type?: string } | null; text?: string; caption?: string
  entities?: any[]; caption_entities?: any[]; reply_to_message?: any }

export type GateResult = { action: 'deliver'; access: Access } | { action: 'drop'; why: string } | { action: 'pair'; code: string; isResend: boolean; expiresAt: number }

/** server.ts gate(): deliver, drop, or the pairing code to send. Writes access.json when it prunes or adds a pending code (as the daemon does). */
export function gate(stateDir: string, m: GateMsg, now = Date.now()): GateResult {
  const access = readAccess(stateDir)
  if (!access) return { action: 'drop', why: 'access.json does not parse' }
  if (access.dmPolicy === 'disabled') return { action: 'drop', why: 'dmPolicy disabled' }
  if (!m.from) return { action: 'drop', why: 'no sender' }
  const senderId = String(m.from.id)
  const chatType = m.chat?.type
  if (chatType === 'private') {
    if (pruneExpired(access, now)) saveAccess(stateDir, access)
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop', why: 'not on the allowlist' }
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop', why: 'pairing: replied twice already' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(stateDir, access)
        return { action: 'pair', code, isResend: true, expiresAt: p.expiresAt }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop', why: 'pairing: 3 pending' }
    const code = randomBytes(3).toString('hex')
    const expiresAt = now + PAIRING_TTL_MS
    access.pending[code] = { senderId, chatId: String(m.chat!.id), createdAt: now, expiresAt, replies: 1 }
    saveAccess(stateDir, access)
    return { action: 'pair', code, isResend: false, expiresAt }
  }
  if (chatType === 'group' || chatType === 'supergroup') {
    const policy = access.groups[String(m.chat!.id)]
    if (!policy) return { action: 'drop', why: 'group not allowlisted' }
    const groupAllowFrom = (policy.allowFrom ?? []).map(String)
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return { action: 'drop', why: 'not on the group allowlist' }
    return { action: 'deliver', access }
  }
  return { action: 'drop', why: `chat type ${chatType}` }
}

/** the pairing reply (server.ts handleInbound, the `pair` branch) */
export function pairingText(r: { code: string; isResend: boolean; expiresAt: number }, now = Date.now()): string {
  return `${r.isResend ? 'Still pending' : 'Pairing required'} — run in Claude Code:\n\n/telegram:access pair ${r.code}\n\n(code expires in ~${pairingRemainingMin(r.expiresAt, now)} min)`
}

/** server.ts dmCommandGate: a bot command in a DM, no pairing side effects: allowed or not */
export function dmCommandGate(stateDir: string, m: GateMsg, now = Date.now()): { access: Access; senderId: string } | null {
  if (m.chat?.type !== 'private' || !m.from) return null
  const access = readAccess(stateDir)
  if (!access) return null
  if (pruneExpired(access, now)) saveAccess(stateDir, access)
  if (access.dmPolicy === 'disabled') return null
  const senderId = String(m.from.id)
  if (access.dmPolicy === 'allowlist' && !access.allowFrom.includes(senderId)) return null
  return { access, senderId }
}

/** may this person act in this chat (an edit, a reaction, a button): a DM of someone on allowFrom, or an allowlisted group whose policy admits them
 *  (server.ts edited_message handler 3020-3022; the buttons check allowFrom) */
export function mayAct(a: Access, chat: { id: number | string; type?: string } | null | undefined, userId: string): boolean {
  if (!chat) return false
  if (chat.type === 'private') return a.allowFrom.includes(userId)
  const g = a.groups?.[String(chat.id)]
  if (!g) return false
  const af = (g.allowFrom ?? []).map(String)
  return af.length === 0 || af.includes(userId)
}

/** /telegram:access drops <state dir>/approved/<sender id> when it pairs someone: the sender ids waiting for their confirmation (the caller sends
 *  "Paired! Say hi to Claude." and calls doneApproval, sent or not, as the daemon does) */
export function approvals(stateDir: string): string[] {
  try { return readdirSync(join(stateDir, 'approved')).filter(n => /^-?\d+$/.test(n)) } catch { return [] }
}
export function doneApproval(stateDir: string, senderId: string): void { try { rmSync(join(stateDir, 'approved', senderId), { force: true }) } catch {} }
export const PAIRED_TEXT = 'Paired! Say hi to Claude.'
