// WO-197 final (1.59.0): a preload (bun --preload) that makes the Telegram code unloadable in the process it runs in: loading grammy (or its types
// package) or roamer-telegram.ts throws, and the path is appended to $PROBE_OUT (when set). A connector or the agent-inbox daemon started with it must
// start and run as usual; a roamer started with it cannot start (the negative control: the probe does see the load). Tests only.
import { plugin } from 'bun'
import { appendFileSync } from 'fs'

const out = process.env.PROBE_OUT
plugin({
  name: 'no-telegram-probe',
  setup(build) {
    build.onLoad({ filter: /(\/node_modules\/grammy\/|\/node_modules\/@grammyjs\/|\/roamer-telegram\.ts$)/ }, args => {
      if (out) { try { appendFileSync(out, `${args.path}\n`) } catch {} }
      throw new Error(`no-telegram-probe: ${args.path} must not be loaded by this daemon`)
    })
  },
})

// The same host can also serve tests for bridge writes, files and actions. Give only
// its member Item routes to the take fixture, preserving the original file origin.
if (process.env.FIXTURE_ITEM_BASE) {
  const { mock } = await import('bun:test')
  const identity = await import('../mesh-identity.ts')
  const token = process.env.FIXTURE_MEMBER_TOKEN
  if (!token && !process.env.ONSEN_CREDENTIAL_FILE) {
    const inMemory = { ...identity, readCredentialFile: () => 'test-member', readOwnCredential: () => 'test-member' }
    mock.module('../mesh-identity.ts', () => inMemory)
  }
  const transport = globalThis.fetch
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== '127.0.0.1') throw new Error('test daemon requires a loopback destination')
    const path = url.pathname.replace(/^\/api\/onsen/, '')
    if (/^\/v1\/(?:items\/|members\/[^/]+\/items(?:\/|$))/.test(path)) {
      const headers = new Headers(init?.headers)
      headers.set('Authorization', 'Bearer test-member')
      return transport(process.env.FIXTURE_ITEM_BASE + path + url.search, { ...init, headers })
    }
    return transport(input, init)
  }, transport)
}
