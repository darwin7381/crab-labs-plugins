// Child of the C1 HTTP tests. Both identities live entirely in memory.
import { mock, spyOn } from 'bun:test'
import * as identity from '../mesh-identity.ts'
import * as mcpAuth from '../mcp-auth.ts'

import { procFactsFor } from '../lanes-proc.ts'
import { __setProcFacts } from '../lanes.ts'

// The test process is the MCP client in place of a Claude TUI.
const proc = procFactsFor()
__setProcFacts({ ...proc, peerPid: () => process.ppid, argv: pid => pid === process.ppid ? ['claude'] : proc.argv(pid) })

const mesh = { ...identity, readOwnCredential: () => 'test-member', readCredentialFile: () => 'test-member' }
const auth = { ...mcpAuth, ensureToken: () => 'test-loopback' }
mock.module('../mesh-identity.ts', () => mesh)
mock.module('../mcp-auth.ts', () => auth)
if (process.env.C1_COMMAND_FAILURE === '1') {
  const lanes = await import('../lanes.ts')
  spyOn(lanes, 'lanesCommand').mockImplementation(async () => { throw new Error('fixture command failed') })
}
if (process.env.ROAMER_MODE === '1') {
  const lanes = await import('../lanes.ts')
  spyOn(lanes, 'claudePidOf').mockImplementation(req => Number(req.headers['x-test-claude-pid']) || null)
}
if (process.env.C6_FAST_PROBE === '1') {
  const { TakeMode } = await import('../onsen-take.ts')
  const pause = TakeMode.prototype.pause
  spyOn(TakeMode.prototype, 'pause').mockImplementation(function (reason, ms) {
    return pause.call(this, reason, reason === 'mode probe did not return 200' ? 1500 : ms)
  })
}
const transport = globalThis.fetch
globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.hostname !== '127.0.0.1') throw new Error('test daemon requires a loopback destination')
  return transport(input, init)
}, transport)
