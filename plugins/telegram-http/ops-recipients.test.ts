import { describe, expect, test } from 'bun:test'
import { opsRecipients } from './ops-recipients.ts'

describe('opsRecipients', () => {
  test('alertTo unset → everyone in allowFrom (unchanged behaviour)', () => {
    expect(opsRecipients({ allowFrom: ['1', '2'] })).toEqual(['1', '2'])
  })
  test('alertTo set → only those ids', () => {
    expect(opsRecipients({ allowFrom: ['1', '2', '3'], alertTo: ['1'] })).toEqual(['1'])
  })
  test('alertTo ids not in allowFrom are dropped', () => {
    expect(opsRecipients({ allowFrom: ['1'], alertTo: ['1', '9'] })).toEqual(['1'])
  })
  test('alertTo [] → nobody', () => {
    expect(opsRecipients({ allowFrom: ['1', '2'], alertTo: [] })).toEqual([])
  })
})
