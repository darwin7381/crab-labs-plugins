import { test, expect } from 'bun:test'
import { orderBotMenu } from './bot-menu.ts'

const c = (...names: string[]) => names.map(command => ({ command, description: command }))
const names = (xs: { command: string }[]) => xs.map(x => x.command)

test('the bot menu puts /clear first and /model second; the rest keep their order', () => {
  const merged = c('start', 'help', 'status', 'input', 'clear', 'model', 'codexgate', 'effort', 'restart')
  expect(names(orderBotMenu(merged))).toEqual(['clear', 'model', 'start', 'help', 'status', 'input', 'codexgate', 'effort', 'restart'])
})

test('a menu already in that order is unchanged, and nothing is lost or doubled', () => {
  const merged = c('clear', 'model', 'start', 'help')
  expect(names(orderBotMenu(merged))).toEqual(['clear', 'model', 'start', 'help'])
  expect(orderBotMenu(c('model', 'start', 'clear')).length).toBe(3)
})

test('a bot without the control commands keeps its menu as it is', () => {
  expect(names(orderBotMenu(c('start', 'help', 'status')))).toEqual(['start', 'help', 'status'])
  expect(names(orderBotMenu(c('start', 'model', 'help')))).toEqual(['model', 'start', 'help'])
})
