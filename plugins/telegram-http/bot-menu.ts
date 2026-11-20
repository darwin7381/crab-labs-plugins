/**
 * The order of the bot's command menu (Telegram setMyCommands).
 *
 * Joey (TG 2026-11-19, again 2026-11-21 msg 7727): /clear first, /model second, on every bot. The commands he taps most
 * sit at the top of the list Telegram shows; the rest keep the order they were assembled in. A bot whose menu has neither
 * (control mode off) is unchanged.
 */
export const MENU_FIRST = ['clear', 'model'] as const

export function orderBotMenu<T extends { command: string }>(commands: T[]): T[] {
  const first = MENU_FIRST.map(n => commands.find(c => c.command === n)).filter((c): c is T => !!c)
  return [...first, ...commands.filter(c => !(MENU_FIRST as readonly string[]).includes(c.command))]
}
