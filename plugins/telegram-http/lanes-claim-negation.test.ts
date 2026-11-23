// lanes-topics live run (2026-11-23): a worker lane's report with 「不交給主線」 was sent back once as a hand-over claim (ownerClaimWarning).
// A claim denied in its own clause is no claim; a real one, alone or after a denied one, still is.
import { test, expect } from 'bun:test'
import { claimsHandover } from './lanes.ts'

test('a denied hand-over is no claim', () => {
  for (const t of ['這件事我自己做完，不交給主線。', '不用交給主線', '沒有轉交 Joey', '這次不必請 Joey 決定', '未上報 Joey，已自行處理', '別交給主線',
    'I have not passed it to the main.', 'Done without escalating; nothing was forwarded to Joey? No: never handed to Joey.'])
    expect([t, claimsHandover(t)]).toEqual([t, false])
})

test('a hand-over said plainly is a claim', () => {
  for (const t of ['已交給主線處理', '這件事轉交 Joey', '請 Joey 決定要不要刪', '主線會處理後續', 'I passed it to the main.', 'escalated to Joey'])
    expect([t, claimsHandover(t)]).toEqual([t, true])
})

test('a denied clause does not hide a real claim in another clause', () => {
  expect(claimsHandover('報告本身不交給主線；刪除的部分請 Joey 決定。')).toBe(true)
  expect(claimsHandover('不交給主線，我自己收尾。結論已寫進定錨檔。')).toBe(false)
})
