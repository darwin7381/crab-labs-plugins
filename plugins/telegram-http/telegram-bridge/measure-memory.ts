// measure-memory.ts: the memory of one telegram-bridge process carrying 1 bot and carrying 27 (WO-196 part B, 「記憶體用量（帶 1 個與帶 27 個 bot
// 各多少）」). Starts fakes.ts's Telegram and Onsen in this process, runs the bridge as its own process (bun telegram-bridge.ts) against them with
// N fake bots (ONSEN_BRIDGE_STATE_DIRS, made in a temp folder), lets every bot poll and a few messages go both ways, then reads the bridge's
// resident memory (ps rss) a few times. Fake tokens only; nothing real is reached.
//   bun measure-memory.ts            # 1 and 27
//   bun measure-memory.ts 5 50       # any counts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeOnsen, FakeTelegram, until } from './fakes.ts'

const JOEY = 1828173984
const rssKb = (pid: number): number => Number(Bun.spawnSync(['ps', '-o', 'rss=', '-p', String(pid)]).stdout.toString().trim()) || 0

async function measure(n: number): Promise<{ n: number; rssMb: number[]; written: number; drawn: number }> {
  const root = mkdtempSync(join(tmpdir(), 'tgb-mem-'))
  const tg = new FakeTelegram(), onsen = new FakeOnsen()
  const cred = 'mesh_memtest_' + 'z'.repeat(24)
  onsen.creds.set(cred, 'telegram-bridge-memtest')
  const names: string[] = [], pairs: string[] = []
  for (let i = 0; i < n; i++) {
    const m = `agent-${i}`, dir = join(root, m, '.telegram-state'), token = `${8000000000 + i}:FAKE${String(i).padStart(4, '0')}${'k'.repeat(30)}`
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.env'), `TELEGRAM_BOT_TOKEN=${token}\n`)
    writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [String(JOEY)], groups: {}, pending: {} }))
    tg.addBot(token, `${m.replace('-', '_')}_bot`)
    names.push(m); pairs.push(`${m}=${dir}`)
    onsen.members.push({ name: m, display_name: m, kind: 'agent' })
  }
  const credFile = join(root, 'cred'); writeFileSync(credFile, cred)
  const settings = join(root, 'env'); writeFileSync(settings, `ONSEN_BRIDGE=${names.join(',')}\nONSEN_BRIDGE_STATE_DIRS=${pairs.join(',')}\n`)
  const p = Bun.spawn([process.execPath, join(import.meta.dir, 'telegram-bridge.ts')], {
    env: { PATH: process.env.PATH ?? '', HOME: join(root, 'home'), TELEGRAM_BRIDGE_MACHINE: 'memtest', ONSEN_BASE: onsen.base, TELEGRAM_API_ROOT: tg.root,
      TELEGRAM_BRIDGE_STATE_DIR: join(root, 'state'), CRAB_LABS_PLUGINS_ENV: settings, TELEGRAM_BRIDGE_CREDENTIAL_FILE: credFile },
    stdout: 'ignore', stderr: 'ignore',
  })
  try {
    await until(() => [...tg.bots.values()].every(b => b.getUpdatesCalls > 0), 30_000, 'every bot polled')
    for (const [token] of tg.bots) tg.text(token, JOEY, 'hello')
    await until(() => onsen.messages.length >= n, 30_000, 'every message written')
    await until(() => onsen.requests.some(r => r.path.endsWith('/bridge/feed')), 30_000, 'the feed polled')      // its first call starts from now
    for (const m of names) onsen.push({ type: 'message', member: m, conversation_id: `cv_${m}`, chat: String(JOEY), message: { id: `o-${m}`, from: m, type: 'message',
      body: { format: 'markdown', text: 'hi there' }, attachments: [] }, author_label: null, silent: false, origin_client: null, reply_to_client_msg_id: null, client_thread: null })
    await until(() => onsen.reports.length >= n, 30_000, 'every reply drawn')
    const rss: number[] = []
    for (let i = 0; i < 5; i++) { await Bun.sleep(2000); rss.push(Math.round(rssKb(p.pid) / 102.4) / 10) }
    return { n, rssMb: rss, written: onsen.messages.length, drawn: onsen.reports.length }
  } finally {
    p.kill('SIGTERM'); await p.exited
    tg.stop(); onsen.stop(); rmSync(root, { recursive: true, force: true })
  }
}

const counts = process.argv.slice(2).map(Number).filter(x => x > 0)
for (const n of counts.length ? counts : [1, 27]) {
  const r = await measure(n)
  console.log(`${r.n} bot(s): rss ${r.rssMb.join(' / ')} MB (5 reads, 2 s apart, after ${r.written} message(s) in and ${r.drawn} out)`)
}
process.exit(0)
