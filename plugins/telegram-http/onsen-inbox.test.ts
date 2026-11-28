import { test, expect, describe } from 'bun:test'
import { OnsenSender, isMailboxInject, switchOn } from './onsen-inbox.ts'

const quiet = () => {}

test('switches: a comma list or *', () => {
  expect(switchOn('chiron, adam', 'adam')).toBe(true)
  expect(switchOn('*', 'x')).toBe(true)
  expect(switchOn('chiron', 'adam')).toBe(false)
  expect(switchOn(undefined, 'adam')).toBe(false)
  expect(switchOn('', 'adam')).toBe(false)
})

describe('the sender', () => {
  test('stored / duplicate / pulling from Onsen\'s answer; a failure never throws and says why', async () => {
    const sent: any[] = []
    let answer: any = { status: 200, json: { results: [{ to: 'eve', seq: 4, duplicate: false, pulling: true }] } }
    const s = new OnsenSender({ req: async (_m, _p, b) => { sent.push(b); if (answer instanceof Error) throw answer; return answer }, log: quiet })
    expect(await s.send('eve', 'peer_call', { text: 'hi' }, 'msg:9', { refs: { btcc_msg_id: 9 }, no_reply: true })).toEqual({ stored: true, duplicate: false, pulling: true })
    expect(sent[0]).toEqual({ to: 'eve', kind: 'peer_call', payload: { text: 'hi' }, dedupe: 'msg:9', refs: { btcc_msg_id: 9 }, no_reply: true })
    answer = { status: 200, json: { results: [{ to: 'eve', seq: 4, duplicate: true, pulling: false }] } }
    expect(await s.send('eve', 'peer_call', { text: 'hi' }, 'msg:9')).toEqual({ stored: true, duplicate: true, pulling: false })
    answer = { status: 200, json: { results: [{ to: 'eve', seq: 5, duplicate: false, pulling: false }] } }
    expect(await s.send('eve', 'peer_call', { text: 'later' }, 'msg:10')).toEqual({ stored: true, duplicate: false, pulling: false })
    answer = new Error('down')
    expect(await s.send('eve', 'peer_call', { text: 'hi' }, null)).toEqual({ stored: false, duplicate: false, pulling: false, error: 'down' })
    answer = { status: 400, json: { detail: 'payload.text is required' } }
    expect(await s.send('eve', 'peer_call', {}, null)).toEqual({ stored: false, duplicate: false, pulling: false, error: 'HTTP 400 payload.text is required' })
    const none = new OnsenSender({ req: async () => null, log: quiet })
    expect((await none.send('eve', 'peer_call', { text: 'x' }, null)).error).toBe('no mesh credential')
    expect(s.stats).toMatchObject({ sent: 3, duplicate: 1, not_pulling: 2, failed: 2 })
  })
})

describe('the roster url of a mailbox-type identity (WO-158)', () => {
  test('BTCC\'s /api/mesh/mailbox/<name>/inject only', () => {
    expect(isMailboxInject('https://btcc.blocktempo.ai/api/mesh/mailbox/bt-app-codex/inject')).toBe(true)
    expect(isMailboxInject('https://btcc.blocktempo.ai/api/mesh/mailbox/bt-app-codex/inject/')).toBe(true)
    expect(isMailboxInject('http://127.0.0.1:17696/inject')).toBe(false)
    expect(isMailboxInject('https://steropes-inbox.fud.city/relay/atlas')).toBe(false)
    expect(isMailboxInject('https://inbox.mbp.fud.city/inject')).toBe(false)
    expect(isMailboxInject('https://x/api/mesh/mailbox/a/b/inject')).toBe(false)
    expect(isMailboxInject('not a url')).toBe(false)
    expect(isMailboxInject(undefined)).toBe(false)
  })
})
