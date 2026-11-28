// Child of the C1 HTTP tests. Both identities live entirely in memory.
import { mock, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import * as identity from '../mesh-identity.ts'
import * as mcpAuth from '../mcp-auth.ts'

const mesh = { ...identity, readOwnCredential: () => 'test-member', readCredentialFile: () => 'test-member' }
const auth = { ...mcpAuth, ensureToken: () => 'test-loopback' }
mock.module('../mesh-identity.ts', () => mesh)
mock.module('../mcp-auth.ts', () => auth)
// The scripted lane talks to the daemon with its in-memory run token. It never consumes an MCP config.
const write = fs.writeFileSync
const writeFileSync: typeof write = (path, data, options) =>
  write(path, /\.mcp\.json\.\d+\.tmp$/.test(String(path)) ? '{}' : data, options)
const fixtureFs = { ...fs, writeFileSync }
mock.module('fs', () => fixtureFs)
if (process.env.C1_COMMAND_FAILURE === '1') {
  const lanes = await import('../lanes.ts')
  spyOn(lanes, 'lanesCommand').mockImplementation(async () => { throw new Error('fixture command failed') })
}
const transport = globalThis.fetch
globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.hostname !== '127.0.0.1') throw new Error('test daemon requires a loopback destination')
  return transport(input, init)
}, transport)
