// WO-153 (Chiron): form_close (close a page form the agent sent: Onsen POST /forms/close) and the form's url sent when its key is made (POST /forms
// {chat, title, url}). Unit: the helper's arguments and answers; the form key's create gets the link as written; every lane lists the tool only when the
// daemon gives it (Onsen recording on) and its call goes there. The daemon end to end is onsen-visible-daemon.test.ts.
import { test, expect, describe } from 'bun:test'
import { mkdtempSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FORM_CLOSE_DESC, FORM_CLOSE_TOOL, formClose } from './onsen-tool.ts'
import { rewriteFormLinks } from './onsen-visible.ts'

describe('form_close: the helper', () => {
  const stub = (status: number, json: unknown) => { const calls: any[] = []; return { calls, req: async (m: 'POST', p: string, b: unknown, t?: number) => { calls.push({ m, p, b, t }); return { status, json } } } }
  test('one constant for the description; id / url / reason', () => {
    expect(FORM_CLOSE_TOOL.name).toBe('form_close')
    expect(FORM_CLOSE_TOOL.description).toBe(FORM_CLOSE_DESC)
    expect(FORM_CLOSE_DESC.split('. ').length).toBe(1)                                 // one plain sentence
    expect(Object.keys(FORM_CLOSE_TOOL.inputSchema.properties)).toEqual(['id', 'url', 'reason'])
  })
  test('POST /forms/close with what was given; Onsen\'s answer as text', async () => {
    const s = stub(200, { id: 5, closed: true })
    expect(await formClose(s.req, { id: 5, reason: ' 已答覆 ' })).toEqual({ text: '{"id":5,"closed":true}', isError: false })
    expect(s.calls).toEqual([{ m: 'POST', p: '/forms/close', b: { id: 5, reason: '已答覆' }, t: 10_000 }])
    const u = stub(200, { id: 6, closed: true, already: true })
    expect(await formClose(u.req, { url: 'https://ops.fud.city/wo/1' })).toEqual({ text: '{"id":6,"closed":true,"already":true}', isError: false })
    expect(u.calls[0].b).toEqual({ url: 'https://ops.fud.city/wo/1' })
    expect((await formClose(stub(200, {}).req, { id: '7' })).isError).toBe(false)        // a numeric string id is taken
  })
  test('refusals: 404 no such open form, 403 not yours, another status; no answer; no credential; nothing to close; a bad id', async () => {
    expect(await formClose(stub(404, { error: 'no such open form' }).req, { id: 9 })).toEqual({ text: 'form_close: no such open form (404) {"error":"no such open form"}', isError: true })
    expect(await formClose(stub(403, { error: 'not yours' }).req, { id: 9 })).toEqual({ text: 'form_close: not your form (403) {"error":"not yours"}', isError: true })
    expect((await formClose(stub(500, null).req, { id: 9 })).text).toBe('form_close: Onsen answered HTTP 500 {}')
    expect((await formClose(async () => { throw new Error('timed out') }, { id: 9 })).text).toContain('Onsen did not answer (timed out); nothing was closed')
    expect((await formClose(async () => null, { id: 9 })).text).toContain('no mesh credential')
    expect((await formClose(null, { id: 9 })).text).toContain('not connected to Onsen')
    const none = stub(200, {})
    expect((await formClose(none.req, { reason: 'x' })).isError).toBe(true)
    expect((await formClose(none.req, { id: -1 })).isError).toBe(true)
    expect((await formClose(none.req, { id: 1.5 })).isError).toBe(true)
    expect(none.calls.length).toBe(0)
  })
})

test('a form key is made with the link as written (no key), so Onsen checks that page at once', async () => {
  const got: Array<[string, string]> = []
  const r = await rewriteFormLinks('選好按送出：[打開](https://ops.fud.city/wo/153?a=1#pick)，另一頁 https://ops.fud.city/b。', { hosts: new Set(['ops.fud.city']), chat: '1',
    create: async (title, url) => { got.push([title, url]); return { id: got.length, key: `k${got.length}` } } })
  expect(got.map(g => g[1])).toEqual(['https://ops.fud.city/wo/153?a=1#pick', 'https://ops.fud.city/b'])
  expect(r.forms.map(f => f.url)).toEqual(got.map(g => g[1]))
})

describe('lanes: form_close only when the daemon gives it (Onsen recording on)', () => {
  test('listed and called through LanesDeps.formClose; without it not listed', async () => {
    const L = await import('./lanes.ts?form-close') as typeof import('./lanes.ts')
    const dir = mkdtempSync(join(tmpdir(), 'form-close-lanes-'))
    process.env.LANES_DIR = dir
    copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
    const seen: any[] = []
    L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => [],
      sendBot: async () => 1, joeyChatId: () => '1', formClose: async (a: any) => { seen.push(a); return '{"id":3,"closed":true}' } } as any)
    for (const k of ['reflex', 'mail', 'worker', 'fork'] as const) expect(L.laneToolsFor(k).filter(t => t.name === 'form_close')).toHaveLength(1)
    L.__lanesState().lanes['adam.reflex.9'] = { id: 'adam.reflex.9', kind: 'reflex', thread: 'adam#t-fc', status: 'idle', runs: 0 } as any   // a lane the call names
    expect(await L.callLaneTool({ lane: 'adam.reflex.9', evId: 'e', runId: 'r' } as any, 'form_close', { id: 3 })).toBe('{"id":3,"closed":true}')
    expect(seen).toEqual([{ id: 3 }])
    const L2 = await import('./lanes.ts?form-close-off') as typeof import('./lanes.ts')
    process.env.LANES_DIR = mkdtempSync(join(tmpdir(), 'form-close-lanes-off-'))
    copyFileSync(process.env.LANES_TEST_ROUTER!, join(process.env.LANES_DIR, 'router.json'))
    L2.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: process.env.LANES_DIR, transcriptDir: process.env.LANES_DIR, httpPort: 0, log: () => {}, authOk: () => false,
      registryNames: () => [], sendBot: async () => 1, joeyChatId: () => '1' } as any)
    for (const k of ['reflex', 'mail'] as const) expect(L2.laneToolsFor(k).some(t => t.name === 'form_close')).toBe(false)
  })
})
