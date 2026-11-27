import { existsSync } from 'fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const end = Date.now() + 10_000
while (!existsSync('release-lane') && Date.now() < end) await Bun.sleep(30)
const prompt = process.argv[process.argv.indexOf('-p') + 1] ?? ''
const client = new Client({ name: 'c1-test-lane', version: '1' }, { capabilities: {} })
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + process.env.LANES_HTTP_PORT + '/lane-mcp'),
  { requestInit: { headers: { Authorization: 'Bearer ' + process.env.LANE_RUN_TOKEN } } }))
const call = prompt.includes('explicit handover')
  ? { name: 'handoff_main', arguments: { text: 'The owner needs the original alert and the pending decision.' } }
  : { name: 'notify_joey', arguments: { text: 'The fixture alert was handled.', outcome: 'normal' } }
const result = await client.callTool(call)
if (result.isError) throw Error('fixture lane tool failed')
await client.close()
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fixture completed' }))
