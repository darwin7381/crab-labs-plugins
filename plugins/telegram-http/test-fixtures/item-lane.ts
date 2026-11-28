import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const end = Date.now() + 10_000
let boundary = 1
while (!existsSync('release-lane') && Date.now() < end) {
  const file = 'hook-' + boundary
  if (existsSync(file)) {
    const event = readFileSync(file, 'utf8')
    const hook = event === 'Stop' ? 'lane-stop-hook.py' : 'lane-steer-hook.py'
    const result = Bun.spawnSync(['python3', '-B', join(import.meta.dir, '..', 'lanes-hooks', hook)], {
      stdin: Buffer.from(JSON.stringify({ hook_event_name: event, tool_name: 'Bash', session_id: 'fixture-session' })),
    })
    if (result.exitCode !== 0) throw Error(result.stderr.toString())
    writeFileSync(file + '.out', result.stdout)
    boundary++
  }
  await Bun.sleep(30)
}
const prompt = process.argv[process.argv.indexOf('-p') + 1] ?? ''
const client = new Client({ name: 'c1-test-lane', version: '1' }, { capabilities: {} })
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + process.env.LANES_HTTP_PORT + '/lane-mcp'),
  { requestInit: { headers: { Authorization: 'Bearer ' + process.env.LANE_RUN_TOKEN } } }))
const call = existsSync('receipt-input.json') ? { name: 'receipt', arguments: JSON.parse(readFileSync('receipt-input.json', 'utf8')) }
  : prompt.includes('explicit handover')
  ? { name: 'handoff_main', arguments: { text: 'The owner needs the original alert and the pending decision.' } }
  : { name: 'notify_joey', arguments: { text: 'The fixture alert was handled.', outcome: 'normal' } }
if (existsSync('receipt-first.json')) {
  const first = await client.callTool({ name: 'receipt', arguments: JSON.parse(readFileSync('receipt-first.json', 'utf8')) })
  writeFileSync('receipt-first-answer.json', JSON.stringify(first))
}
const result = await client.callTool(call)
if (call.name === 'receipt') writeFileSync('scheduler-receipt', JSON.stringify(result.content))
if (result.isError) throw Error('fixture lane tool failed')
await client.close()
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fixture completed' }))
