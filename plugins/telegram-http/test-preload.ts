// Loaded before every test file (bunfig.toml [test] preload). The suite never reaches the real Jev by accident.
// 002k (K2): with the peer-disclosure check on by default, every reply_agent / send_to_agent in a test is a Jev call; on a machine that has the key file
// (~/.genesis/typesafe.env) it would be a live one. Tests that want Jev point TYPESAFE_BASE_URL at a local stand-in and set TYPESAFE_API_KEY (or their own
// TYPESAFE_KEY_FILE), as they always did; nothing here changes for them.
// - The key file is not read unless the test names its own key. All files run in one process and some delete TYPESAFE_KEY_FILE when they end, so it is set
//   again before every test (hook children inherit it too).
// - A fetch to the real TypeSafe host fails at once, whatever the env says (the code treats it as a failed call: the action goes through).
import { afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// - Every run has its own temp folder, removed when the run ends (Hephaestus #200970, 11-28: the suite had left 194k folders, 28 GiB, in the Mac mini's
//   user TMPDIR: tests mkdtempSync(join(tmpdir(), '<prefix>')) and many never remove them). tmpdir() in this process, and every child given process.env,
//   lands in it. A run that was killed leaves its folder; the next run removes run folders untouched for 6 h.
const TMP_ROOT = tmpdir(), RUN_PREFIX = 'tgh-run-'
try {
  for (const n of readdirSync(TMP_ROOT)) {
    if (!n.startsWith(RUN_PREFIX)) continue
    const p = join(TMP_ROOT, n)
    try { if (Date.now() - statSync(p).mtimeMs > 6 * 3600_000) rmSync(p, { recursive: true, force: true }) } catch {}
  }
} catch {}
const RUN_TMP = mkdtempSync(join(TMP_ROOT, RUN_PREFIX))
process.env.TMPDIR = RUN_TMP
// bun test runs a preload's afterAll once, after the last file (its process 'exit' handlers do not run); 'exit' stays for a plain `bun` run of a test
const dropRunTmp = (): void => { try { rmSync(RUN_TMP, { recursive: true, force: true }) } catch {} }
afterAll(dropRunTmp)
process.on('exit', dropRunTmp)
const guardKey = (): void => { if (!process.env.TYPESAFE_API_KEY && !process.env.TYPESAFE_KEY_FILE) process.env.TYPESAFE_KEY_FILE = '/nonexistent/typesafe.env' }
guardKey()
beforeEach(guardKey)
const realFetch = globalThis.fetch
globalThis.fetch = Object.assign((input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? '')
  if (/^https?:\/\/([^/]*\.)?typesafe\.ai(\/|:|$)/i.test(url)) return Promise.reject(new Error('test: the real TypeSafe API is not called from tests'))
  return realFetch(input, init)
}, realFetch) as typeof fetch
// - No test starts the real claude. A lane run that a test did not give its own fake binary (__setClaudeBin) to, or one that starts after the file put the
//   real one back in its afterAll, runs test-fixtures/no-claude.sh instead: a failed run at once, no model call, no process left behind.
process.env.LANES_CLAUDE_BIN ??= `${import.meta.dir}/test-fixtures/no-claude.sh`
// lanes-golive (C6): the fleet default notify profile is `default` (every line rings, ORG-CHART §0 #2 / #5). The lab's suite specifies the `tiered` table
// (silent classes, the cap, quiet follow-ups): it runs under that profile unless a test file takes it away (lanes-golive-c6.test.ts tests the default).
process.env.LANES_NOTIFY_PROFILE ??= 'tiered'
// lanes-golive: worker / fork lanes have no Agent tool on the fleet (no sub-agents in a lane); the lab suite specifies the K3 tool, so it runs with it on
process.env.LANES_WORKER_AGENT_TOOL ??= '1'
// lanes-golive (release): the lab tests read the Genesis lab's router (universes/002/router.json); a copy lives in test-fixtures so `bun test` needs no
// file outside the repo. LANES_TEST_ROUTER still overrides it.
process.env.LANES_TEST_ROUTER ??= `${import.meta.dir}/test-fixtures/lab-router.json`
