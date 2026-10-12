/**
 * Who receives ops traffic: system alerts (usage limit, API errors), the
 * login-expired watchdog, startup-picker buttons and permission prompts.
 *
 * `alertTo` set   → only those ids, and only if they are also in allowFrom
 *                   (an alert must never reach someone the bot doesn't accept
 *                   messages from). `[]` means nobody.
 * `alertTo` unset → everyone in allowFrom, the pre-1.24.11 behaviour.
 *
 * Why (pactolus 5056, 2026-10-12): allowFrom doubles as "who may talk to the
 * bot". Adding a human colleague so they can hand the agent information also
 * DMed them every "⚠️ 系統警告" — on 2026-10-05 four weekly-limit warnings from
 * Atlas's bot buried a key message meant for that colleague.
 */
export function opsRecipients(access: { allowFrom: string[]; alertTo?: string[] }): string[] {
  if (!access.alertTo) return access.allowFrom
  return access.alertTo.filter(id => access.allowFrom.includes(id))
}
