// stage-two.ts: telegram-bridge's second stage (WO-196 part B: 「第二段＝指令清單、串與話題、重新開始線、他按的表情、群組」), the feed items
// outbound.ts hands over (Drawer.extra) and the restart line's button (Poller.onButton).
//
//   commands      {commands:[{name, description}]}: the member's connector's commands become the bot's command menu (setMyCommands, the default
//                 scope and all_private_chats, as the daemon did), with the bridge's own /start and /help, in the fleet order (bot-menu.ts:
//                 /clear first, /model second). A name Telegram does not take (1-32 of a-z, 0-9, _) is left out; at most 100.
//   thread        {thread, name, state, client_thread}: a thread opened with no topic yet → createForumTopic in that chat (the name without
//                 emoji, lanes-topics.ts plainTopicName), then PUT /v1/bridge/threads {member, chat, thread, client_thread}; a known topic
//                 renamed → editForumTopic name; closed → the ✅ icon (getForumTopicIconStickers, as the daemon's topicDone; a private chat
//                 has no closeForumTopic, and a topic is never deleted: that removes its messages); opened again → the icon cleared.
//   restart_line  {id, lifted, lift_until}: a line drawn (lifted false) → a silent message 「已畫線：這之前的對話它看不到了（你引用的那一則照樣看得到）。」
//                 with 「讓它看得到之前的（n）」, n counting down once a second to lift_until (the 1.58.19 /clear countdown), then the button goes;
//                 no lift_until: the button stays without a number. Pressed in time → POST /v1/bridge/restart-lines/<id>/lift {client_user_id};
//                 the message then says the line is gone. lifted true (here or anywhere) → the same.
//   topics in     the names of topics (their service messages, a message typed in one) are kept for topic_name.
import { orderBotMenu } from '../bot-menu.ts'
import { plainTopicName } from '../lanes-topics.ts'
import type { Agent } from './agent.ts'
import { errCode, errSaid, retryable, type OnsenClient } from './onsen.ts'
import type { StateStore } from './state.ts'
import { errText } from './tg.ts'

type Log = (level: 'info' | 'warn' | 'error', msg: string) => void
export const BASE_COMMANDS = [
  { command: 'start', description: 'Welcome and setup guide' },
  { command: 'help', description: 'What this bot can do' },
]
export const LINE_TEXT = '已畫線：這之前的對話它看不到了（你引用的那一則照樣看得到）。'
export const LIFTED_TEXT = '已拿掉線：它查得到之前的對話了。'
const liftLabel = (n: number | null): string => n == null ? '讓它看得到之前的' : `讓它看得到之前的（${n}）`

/** the bot's menu for a member's commands: the bridge's own two, the connector's (valid names, first one wins), the fleet order */
export function menuOf(commands: Array<{ name?: unknown; description?: unknown }>): Array<{ command: string; description: string }> {
  const merged = [...BASE_COMMANDS]
  for (const c of commands ?? []) {
    const name = String(c?.name ?? '').replace(/^\//, '').trim().toLowerCase()
    if (!/^[a-z0-9_]{1,32}$/.test(name)) continue
    const description = String(c?.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 256) || name
    const i = merged.findIndex(b => b.command === name)
    if (i >= 0) merged[i] = { command: name, description }
    else merged.push({ command: name, description })
  }
  return orderBotMenu(merged).slice(0, 100)
}

export class StageTwo {
  private iconId: string | null | undefined
  private names = new Map<string, string>()              // member:chat:client_thread → the topic's name
  constructor(readonly d: { onsen: OnsenClient; state: StateStore; log: Log; now?: () => number; tick?: number }) {
    for (const t of Object.values(d.state.data.topics)) this.names.set(`${t.member}:${t.chat}:${t.client_thread}`, t.name)
  }
  private now(): number { return (this.d.now ?? Date.now)() }
  private get st() { return this.d.state.data }
  noteTopic(member: string, chat: string, clientThread: string, name: string): void { this.names.set(`${member}:${chat}:${clientThread}`, name); if (this.names.size > 5000) this.names.delete(this.names.keys().next().value!) }
  topicName(member: string, chat: string, clientThread: string): string | null { return this.names.get(`${member}:${chat}:${clientThread}`) ?? null }

  /** Drawer.extra: true = drawn here */
  async draw(a: Agent, item: any): Promise<boolean> {
    switch (item.type) {
      case 'commands': await this.drawCommands(a, item); return true
      case 'thread': await this.drawThread(a, item); return true
      case 'restart_line': await this.drawLine(a, item); return true
      default: return false
    }
  }

  async drawCommands(a: Agent, item: any): Promise<void> {
    const menu = menuOf(Array.isArray(item.commands) ? item.commands : [])
    await a.tg.call('setMyCommands', { commands: menu })
    await a.tg.call('setMyCommands', { commands: menu, scope: { type: 'all_private_chats' } })
    this.d.log('info', `${a.member}: command menu of @${a.username} set (${menu.length}: ${menu.map(c => c.command).join(', ')})`)
  }

  async drawThread(a: Agent, item: any): Promise<void> {
    const chat = String(item.chat), thread = String(item.thread ?? ''), key = `${a.member}:${chat}:${thread}`
    if (!thread) return
    const name = plainTopicName(item.name, '工作')
    const rec = this.st.topics[key]
    let ct: string | null = item.client_thread != null ? String(item.client_thread) : rec?.client_thread ?? null
    if (item.state === 'open' && !ct) {
      const r = await a.tg.call('createForumTopic', { chat_id: chat, name }).catch(e => { this.d.log('warn', `${a.member}: no topic for thread ${thread} in chat ${chat} (${errText(e)}): its messages stay outside topics`); return null })
      if (!r?.message_thread_id) return
      ct = String(r.message_thread_id)
      this.st.topics[key] = { member: a.member, chat, thread, client_thread: ct, name, state: 'open', at: this.now() }
      this.d.state.dirty()
      this.noteTopic(a.member, chat, ct, name)
      await this.report(a, chat, thread, ct)
      this.d.log('info', `${a.member}: thread ${thread} opened as topic ${ct} 「${name}」 in chat ${chat}`)
      return
    }
    if (!ct) return
    const was = rec ?? { member: a.member, chat, thread, client_thread: ct, name: '', state: '', at: 0 }
    if (name && name !== was.name && item.name) await a.tg.call('editForumTopic', { chat_id: chat, message_thread_id: Number(ct), name }).catch(e => this.d.log('warn', `${a.member}: renaming topic ${ct}: ${errText(e)}`))
    if (item.state === 'closed' && was.state !== 'closed') {
      this.iconId ??= await a.tg.call('getForumTopicIconStickers', {}).then((xs: any[]) => xs.find(s => String(s?.emoji ?? '').replace(/️/g, '') === '✅')?.custom_emoji_id ?? null).catch(() => null)
      if (this.iconId) await a.tg.call('editForumTopic', { chat_id: chat, message_thread_id: Number(ct), icon_custom_emoji_id: this.iconId }).catch(e => this.d.log('warn', `${a.member}: the ✅ on topic ${ct}: ${errText(e)}`))
      else this.d.log('warn', `${a.member}: getForumTopicIconStickers has no ✅: topic ${ct} keeps its icon`)
    } else if (item.state === 'open' && was.state === 'closed') {
      await a.tg.call('editForumTopic', { chat_id: chat, message_thread_id: Number(ct), icon_custom_emoji_id: '' }).catch(e => this.d.log('warn', `${a.member}: clearing the icon of topic ${ct}: ${errText(e)}`))
    }
    this.st.topics[key] = { ...was, client_thread: ct, name: item.name ? name : was.name, state: String(item.state ?? was.state), at: this.now() }
    this.d.state.dirty()
    if (item.client_thread == null) await this.report(a, chat, thread, ct)
  }
  /** PUT /v1/bridge/threads: which topic a thread is (tried twice; a later item for the thread sends it again) */
  private async report(a: Agent, chat: string, thread: string, ct: string): Promise<void> {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await this.d.onsen.req('PUT', '/bridge/threads', { member: a.member, chat, thread, client_thread: ct })
        if (r.status >= 200 && r.status < 300) return
        if (!retryable(r)) { this.d.log('warn', `${a.member}: PUT /bridge/threads for thread ${thread}: HTTP ${r.status} ${errCode(r)} ${errSaid(r)}`); return }
      } catch {}
      await Bun.sleep(1000)
    }
    this.d.log('warn', `${a.member}: Onsen did not take topic ${ct} for thread ${thread}; sent again with the next item of that thread`)
  }

  // ---- the restart line ----------------------------------------------------------------------------------------------------------
  async drawLine(a: Agent, item: any): Promise<void> {
    const chat = String(item.chat), id = String(item.id ?? '')
    if (!id) return
    const key = `${a.member}:${id}`
    const rec = this.st.lines[key]
    if (item.lifted) {
      if (rec && !rec.lifted) { rec.lifted = true; this.d.state.dirty(); await a.tg.call('editMessageText', { chat_id: rec.chat, message_id: rec.msg, text: LIFTED_TEXT, reply_markup: { inline_keyboard: [] } }).catch(() => {}) }
      return
    }
    if (rec) return                                                    // drawn already
    const until = item.lift_until ? Date.parse(item.lift_until) : NaN
    const left = Number.isFinite(until) ? Math.ceil((until - this.now()) / 1000) : null
    if (left != null && left <= 0) return                              // its window is over (a late item after a restart): nothing to press
    const kb = (n: number | null) => ({ inline_keyboard: [[{ text: liftLabel(n), callback_data: `olift:${id}`.slice(0, 64) }]] })
    const m = await a.tg.call('sendMessage', { chat_id: chat, text: LINE_TEXT, disable_notification: true, reply_markup: kb(left) })
    const msg = Number(m.message_id)
    this.st.lines[key] = { member: a.member, chat, msg, lift_until: Number.isFinite(until) ? until : null, lifted: false, at: this.now(), id } as any
    this.d.state.dirty()
    if (left == null) return
    // once a second: (n-1) … (1), then the button goes (a pressed or lifted line is left alone)
    for (let n = left - 1; n >= 0; n--) {
      const t = setTimeout(() => {
        const r = this.st.lines[key]
        if (!r || r.lifted || (r as any).pressed) return
        void a.tg.call('editMessageReplyMarkup', { chat_id: chat, message_id: msg, reply_markup: n > 0 ? kb(n) : { inline_keyboard: [] } })
          .catch(e => this.d.log('warn', `${a.member}: restart line ${id} countdown (${n}): ${errText(e)}`))
      }, (left - n) * (this.d.tick ?? 1000))
      ;(t as any).unref?.()
    }
  }

  /** Poller.onButton: olift:<line id>; true = handled */
  async button(a: Agent, cq: any): Promise<boolean> {
    const mm = /^olift:(.+)$/.exec(String(cq.data ?? ''))
    if (!mm) return false
    const answer = (text: string) => a.tg.call('answerCallbackQuery', { callback_query_id: cq.id, text }).catch(() => {})
    const id = mm[1]!, key = `${a.member}:${id}`, rec: any = this.st.lines[key]
    if (!rec || rec.lifted) { await answer('這條線已經拿掉了'); return true }
    if (rec.lift_until != null && this.now() > rec.lift_until + 1000) {
      await answer('已經過了，線留著')
      await a.tg.call('editMessageReplyMarkup', { chat_id: rec.chat, message_id: rec.msg, reply_markup: { inline_keyboard: [] } }).catch(() => {})
      return true
    }
    rec.pressed = true
    let r: { status: number; json: any } | null = null
    try { r = await this.d.onsen.req('POST', `/bridge/restart-lines/${encodeURIComponent(id)}/lift`, { client_user_id: String(cq.from?.id ?? '') }) } catch (e) { this.d.log('warn', `${a.member}: lifting line ${id}: ${errText(e)}`) }
    if (r && r.status >= 200 && r.status < 300) {
      rec.lifted = true; this.d.state.dirty()
      await a.tg.call('editMessageText', { chat_id: rec.chat, message_id: rec.msg, text: LIFTED_TEXT, reply_markup: { inline_keyboard: [] } }).catch(() => {})
      await answer('已拿掉線')
      this.d.log('info', `${a.member}: restart line ${id} lifted by tg:${cq.from?.id}`)
      return true
    }
    rec.pressed = false
    await answer(!r || retryable(r) ? '沒拿掉：Onsen 沒回應，稍後再按一次' : `沒拿掉（${errCode(r) || r.status}）`)
    return true
  }
}
