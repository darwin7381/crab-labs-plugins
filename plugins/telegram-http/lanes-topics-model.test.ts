// lanes-topics item 3: a work topic's lane runs the main's model. Worker and fork lanes: LANES_MODEL_WORKER when set, else the model of the main's last
// genuine assistant record (liveness.ts: not <synthetic>, not an API error record), else LANES_MODEL. Reflex, mail, curator, synthesis: LANES_MODEL.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, appendFileSync, chmodSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { genuineAssistantModelFile } from './liveness.ts'
const L = await import('./lanes.ts?topics-model') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-topics-model-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
// a lane program that writes its argv and ends at once
const argvFile = join(dir, 'argv.jsonl'), bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, sys
open('${argvFile}', 'a').write(json.dumps(sys.argv[1:]) + '\\n')
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async () => 1, joeyChatId: () => '1', createTopic: async () => 7301 } as any)
const was = { worker: process.env.LANES_MODEL_WORKER }
afterAll(() => { L.__setClaudeBin(restore); if (was.worker === undefined) delete process.env.LANES_MODEL_WORKER; else process.env.LANES_MODEL_WORKER = was.worker })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const rec = (model: string, extra: object = {}) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { model, content: [{ type: 'text', text: 'x' }] }, ...extra }) + '\n'

test('liveness: the model of the LAST genuine assistant record; <synthetic> and API error records are not the session\'s model; far from the end is still found', () => {
  const t = join(dir, 't1.jsonl')
  writeFileSync(t, rec('claude-sonnet-5-5') + rec('claude-opus-5-5') + rec('<synthetic>') + rec('claude-haiku-5-5', { isApiErrorMessage: true })
    + JSON.stringify({ type: 'user', message: { content: 'y'.repeat(200_000) } }) + '\n')
  expect(genuineAssistantModelFile(t)).toBe('claude-opus-5-5')
  writeFileSync(join(dir, 't2.jsonl'), rec('<synthetic>'))
  expect(genuineAssistantModelFile(join(dir, 't2.jsonl'))).toBeNull()
  expect(genuineAssistantModelFile(join(dir, 'none.jsonl'))).toBeNull()
})

test('reflex, mail, curator and synthesis lanes run LANES_MODEL; worker and fork lanes with no main transcript too', () => {
  delete process.env.LANES_MODEL_WORKER
  for (const k of ['reflex', 'mail', 'curator', 'synthesis', 'worker', 'fork']) expect(L.laneModelFor(k)).toEqual({ model: L.laneModel(), source: 'LANES_MODEL' })
})

test('with a main: worker and fork lanes run the main\'s model (its last genuine record); the others do not; LANES_MODEL_WORKER overrides', () => {
  L.__setMainConnected('mcp-main')
  const sid = L.mainSessionId()!
  writeFileSync(join(dir, `${sid}.jsonl`), rec('claude-opus-5-5') + rec('<synthetic>'))
  expect(L.laneModelFor('worker')).toEqual({ model: 'claude-opus-5-5', source: 'main' })
  expect(L.laneModelFor('fork')).toEqual({ model: 'claude-opus-5-5', source: 'main' })
  expect(L.laneModelFor('reflex').model).toBe(L.laneModel())
  appendFileSync(join(dir, `${sid}.jsonl`), rec('claude-fable-5-2'))                        // the main switched model: the next run follows
  expect(L.laneModelFor('worker').model).toBe('claude-fable-5-2')
  process.env.LANES_MODEL_WORKER = 'claude-sonnet-5-5'
  expect(L.laneModelFor('worker')).toEqual({ model: 'claude-sonnet-5-5', source: 'LANES_MODEL_WORKER' })
  expect(L.laneModelFor('mail').model).toBe(L.laneModel())
  delete process.env.LANES_MODEL_WORKER
})

test('a worker lane\'s run is started with --model <the main\'s model>, and its spawn record says where the model came from', async () => {
  const r = await L.callMainTool('open_worker', { title: '查報表', brief: '查完回報' }, 'mcp-main')
  expect(r).toContain('opened in topic #7301')
  expect(await until(() => existsSync(argvFile))).toBe(true)
  const argv: string[] = JSON.parse(readFileSync(argvFile, 'utf8').trim().split('\n')[0])
  expect(argv[argv.indexOf('--model') + 1]).toBe('claude-fable-5-2')
  const spawn = readFileSync(join(dir, 'lanes.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(x => x.kind === 'spawn')
  expect(spawn).toMatchObject({ model: 'claude-fable-5-2', model_from: 'main' })
}, 20000)
