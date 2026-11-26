#!/usr/bin/env bun
// A stand-in for `codex exec` in codex-runner.test.ts (no model call). It reads the argv the runner builds, records it (FAKE_CODEX_LOG, one JSON line
// per start and per end), prints --json events like codex 0.169 (thread.started with the session id, turn.started, item.completed, turn.completed /
// turn.failed), writes the last message to -o, and does what the prompt asks:
//   IMG:<name>   write a small PNG named <name> in the folder        BIG:<name>   write a file of FAKE_CODEX_BIG bytes
//   MANY:<n>     write n small files                                SLEEP:<s>    take s seconds
//   FAIL         40 lines of stderr, turn.failed, exit 3            HANG         never end (SIGTERM ends it)
//   HANGHARD     never end, SIGTERM ignored (only SIGKILL ends it)  NOLAST       no -o file
//   KID          leave a `sleep 30` behind in its process group and end (its pid in the log)
// FAKE_CODEX_LIVE: a folder holding one file per running fake (the test counts them).
import { spawn } from 'node:child_process'
import { appendFileSync, fstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
let dir = '', out = '', resume: string | null = null, text = ''
const images: string[] = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!
  if (a === '--') { text = argv.slice(i + 1).join(' '); break }
  if (a === '-C') dir = argv[++i]!
  else if (a === '-o') out = argv[++i]!
  else if (a === '-i') images.push(argv[++i]!)
  else if (a === '-s') i++
  else if (a === 'resume') resume = argv[++i]!
}
const log = (o: Record<string, unknown>): void => { if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(o) + '\n') }
let stdinNull = false
try { stdinNull = fstatSync(0).rdev === statSync('/dev/null').rdev } catch {}
const live = process.env.FAKE_CODEX_LIVE
let liveNow = 0
if (live) { mkdirSync(live, { recursive: true }); writeFileSync(join(live, String(process.pid)), ''); liveNow = readdirSync(live).length }
const session = resume ?? `sess-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
log({ ev: 'start', pid: process.pid, cwd: process.cwd(), argv, dir, out, resume, images, text, stdin_null: stdinNull, live: liveNow, at: Date.now(),
  codex_home: process.env.CODEX_HOME ?? null, home: process.env.HOME ?? null, runner_env: Object.keys(process.env).filter(k => /^(CODEX_RUNNER_|ONSEN_)/.test(k)) })
const done = (code: number): never => {
  if (live) rmSync(join(live, String(process.pid)), { force: true })
  log({ ev: 'end', pid: process.pid, code, at: Date.now() })
  process.exit(code)
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: session }))
console.log(JSON.stringify({ type: 'turn.started' }))
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex')

async function main(): Promise<void> {
  if (/\bHANGHARD\b/.test(text)) { process.on('SIGTERM', () => {}); await new Promise(() => setInterval(() => {}, 1000)) }
  if (/\bHANG\b/.test(text)) { process.on('SIGTERM', () => done(143)); await new Promise(() => setInterval(() => {}, 1000)) }
  if (/\bKID\b/.test(text)) { const k = spawn('sleep', ['30'], { stdio: 'ignore' }); k.unref(); log({ ev: 'kid', pid: process.pid, kid: k.pid }) }
  const sl = /SLEEP:(\d+(?:\.\d+)?)/.exec(text)
  if (sl) await new Promise(r => setTimeout(r, Number(sl[1]) * 1000))
  if (/\bFAIL\b/.test(text)) {
    for (let i = 1; i <= 40; i++) console.error(`boom line ${i}`)
    console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'the model said no' } }))
    done(3)
  }
  for (const m of text.matchAll(/IMG:([\w.-]+)/g)) writeFileSync(join(dir, m[1]!), PNG)
  for (const m of text.matchAll(/BIG:([\w.-]+)/g)) writeFileSync(join(dir, m[1]!), Buffer.alloc(Number(process.env.FAKE_CODEX_BIG ?? 2048), 7))
  const many = /MANY:(\d+)/.exec(text)
  if (many) for (let i = 1; i <= Number(many[1]); i++) writeFileSync(join(dir, `f${String(i).padStart(2, '0')}.txt`), `file ${i}`)
  const answer = `answer to: ${text.split('\n')[0]} | session=${session} | resumed=${resume ? 'yes' : 'no'} | images=${images.length}`
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: answer } }))
  if (!/\bNOLAST\b/.test(text) && out) writeFileSync(out, (process.env.FAKE_CODEX_ANSWER ?? '') + answer)
  console.log(JSON.stringify({ type: 'turn.completed', usage: {} }))
  done(0)
}
void main()
