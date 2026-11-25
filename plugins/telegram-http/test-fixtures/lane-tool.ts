// A lane binary for daemon tests (WO-147 1.49.1, tests only): it answers like a successful claude run. When the run's prompt carries a marker it first
// calls that lane tool on the daemon's own lane MCP endpoint (/lane-mcp, the run's token from --mcp-config), as a lane's model would (the marker of the
// run's own event: the last one in the prompt): [[HANDOFF]] handoff_main · [[CARD-NOW]] decide_later with urgent_because · [[CARD-DEFER]] decide_later (can wait)
// No marker: it answers at once (the run ends; the exit rule decides what it still owes).
import { readFileSync } from 'fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const argv = process.argv.slice(2)
const at = (flag: string): string => { const i = argv.indexOf(flag); return i >= 0 ? String(argv[i + 1] ?? '') : '' }
const prompt = at('-p'), cfgPath = at('--mcp-config')
const CARD = { decide: '要不要把 api-gw 的 timeout 改成 30 秒', recommend: '改（p99 已 24 秒）', basis: 'Grafana p99', then: '改設定、回 Eve' }
// the run's own event is rendered last in the prompt (runPrompt: the card, then the event); earlier text (the ledger, other events) may carry other markers
const TOOLS: Record<string, [string, Record<string, unknown>]> = {
  '[[HANDOFF]]': ['handoff_main', { text: 'Eve 要週五報表，要主線決定' }],
  '[[CARD-NOW]]': ['decide_later', { title: 'timeout', card: CARD, urgent_because: 'Eve 的部署卡在這一步，今天下班前要' }],
  '[[CARD-DEFER]]': ['decide_later', { title: '預算格式', card: CARD }],
}
const last = Object.keys(TOOLS).map(m => [m, prompt.lastIndexOf(m)] as const).filter(([, i]) => i >= 0).sort((a, b) => b[1] - a[1])[0]
const calls: Array<[string, Record<string, unknown>]> = last ? [TOOLS[last[0]]!] : []
if (calls.length && cfgPath) {
  try {
    const lane = JSON.parse(readFileSync(cfgPath, 'utf8')).mcpServers.lane
    const c = new Client({ name: 'lane-tool-fixture', version: '0' }, { capabilities: {} })
    await c.connect(new StreamableHTTPClientTransport(new URL(lane.url), { requestInit: { headers: lane.headers } }))
    for (const [name, args] of calls) { const r: any = await c.callTool({ name, arguments: args }); console.error(`${name}: ${String(r.content?.[0]?.text ?? '').slice(0, 200)}`) }
    await c.close()
  } catch (e) { console.error(`lane-tool fixture: ${e}`) }
}
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }))
