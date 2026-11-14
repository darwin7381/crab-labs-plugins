// Universe 002k (D13): the lane guard refuses Bash commands that reach the lab services without ./bin/svc. Real-looking commands.
// The hook is run as Claude Code runs it (stdin payload, stdout decision). No network, no model.
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'

const HOOK = join(import.meta.dir, 'lanes-hooks', 'lane-guard-hook.py')
const d = mkdtempSync(join(tmpdir(), 'guard-d13-')); const ld = join(d, '.lanes'); mkdirSync(ld, { recursive: true }); mkdirSync(join(d, 'memory'), { recursive: true })
function verdict(command: string, env: Record<string, string> = {}, kind = 'reflex'): { v: 'deny' | 'allow'; reason: string } {
  const r = spawnSync('python3', [HOOK], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: d }), encoding: 'utf8',
    env: { ...process.env, LANES_DIR: ld, LANES_MEMORY_DIR: join(d, 'memory'), LANE_KIND: kind, LANE_ID: `adam.${kind}.1`, GENESIS_LOGOS_URL: '', LANES_LOGOS_URL: '', ...env } })
  const j = r.stdout.trim() ? JSON.parse(r.stdout) : null
  return { v: j?.hookSpecificOutput?.permissionDecision === 'deny' ? 'deny' : 'allow', reason: j?.hookSpecificOutput?.permissionDecisionReason ?? '' }
}
const denied = (c: string, env?: Record<string, string>) => expect({ c, ...verdict(c, env) }).toMatchObject({ v: 'deny' })
const allowed = (c: string, env?: Record<string, string>) => expect({ c, ...verdict(c, env) }).toMatchObject({ v: 'allow' })

test('D13: direct calls to the service port are refused, with a message that says to use ./bin/svc', () => {
  for (const c of [
    'curl -s http://127.0.0.1:18900/svc/mock-api/health',
    'curl -sS -X DELETE http://127.0.0.1:18900/svc/mock-backup/snapshots/3',
    "curl -X POST -H 'Content-Type: application/json' -d '{\"replicas\":8}' http://localhost:18900/svc/mock-api/scale",
    'curl -s localhost:18900/svc/tickets | jq .',
    'wget -qO- http://127.0.0.1:18900/logos/world/truth',
    'echo "GET /svc/tickets HTTP/1.0\\r\\n\\r\\n" | nc 127.0.0.1 18900',
    'nc -z localhost 18900 && echo up',
    'python3 -c "import urllib.request as u; print(u.urlopen(\'http://127.0.0.1:18900/svc/tickets\').read())"',
    'python3 - <<EOF\nimport requests\nprint(requests.post("http://localhost:18900/svc/mock-posts/publish").text)\nEOF',
    "node -e \"fetch('http://127.0.0.1:18900/svc/mock-api/health').then(r => r.text()).then(console.log)\"",
    'bash -c \'exec 3<>/dev/tcp/127.0.0.1/18900; printf "GET /svc/ HTTP/1.0\\r\\n\\r\\n" >&3; cat <&3\'',
    'curl http://[::1]:18900/svc/',
    'cd /tmp && sleep 1 && curl -s http://127.0.0.1:18900/svc/mock-api/health',
    './bin/svc GET mock-api/health | curl -s -d @- http://127.0.0.1:18900/logos/record',
    'echo $(curl -s http://127.0.0.1:18900/svc/tickets)',
    'bash -c "curl -s http://127.0.0.1:18900/svc/tickets"',
    'sudo timeout 5 curl http://127.0.0.1:18930/inject',                                     // another agent's port in the lab range
    'FOO=1 curl -s http://127.0.0.1:18900/svc/',
  ]) denied(c)
  const r = verdict('curl -s http://127.0.0.1:18900/svc/mock-api/health')
  expect(r.reason).toContain('./bin/svc'); expect(r.reason).toContain('127.0.0.1:18900'); expect(r.reason).toContain('./bin/svc GET <path>'); expect(r.reason).toContain('catalog')
})

test('D13: ./bin/svc itself, other network use, and text that merely mentions an address are not refused', () => {
  for (const c of [
    './bin/svc GET',
    './bin/svc GET mock-api/health',
    "./bin/svc POST tickets '{\"title\":\"p95 高\",\"body\":\"see curl http://127.0.0.1:18900/svc/ for the raw call\",\"priority\":\"P2\"}'",
    'GENESIS_ACTOR=x ./bin/svc GET mock-backup/status',
    'curl -s https://example.com/status.json',
    'curl -s http://localhost:3000/health',                                                  // a local dev server of the lane's own work: not a service
    'curl -s http://127.0.0.1/',
    'wget -q https://github.com/x/y/archive/main.tar.gz',
    'python3 -c "print(sum(range(10)))"',
    'node -e "console.log(1+1)"',
    'grep -rn "127.0.0.1:18900" docs/',                                                      // reading about the address
    'grep -rn "curl http://127.0.0.1:18900" docs/runbooks/',
    'cat docs/runbooks/backup.md | grep -n curl',
    'echo "do not use curl http://127.0.0.1:18900 directly"',
    'sed -n 1,40p mock-api/config.yaml',
    'ls -la && date',
    'git log --oneline | head -5',
    'ss -ltn | grep 18900',
  ]) allowed(c)
})

test('D13: the host of GENESIS_LOGOS_URL / LANES_LOGOS_URL, by address or by the variable', () => {
  const env = { LANES_LOGOS_URL: 'http://10.1.2.3:7777' }
  denied('curl -s http://10.1.2.3:7777/logos/world/truth', env)
  denied('curl -s $GENESIS_LOGOS_URL/logos/world/truth')
  denied('curl -s "${GENESIS_LOGOS_URL}/svc/tickets"')
  denied('wget -qO- http://10.1.2.3:7777/svc/', { GENESIS_LOGOS_URL: 'http://10.1.2.3:7777' })
  allowed('curl -s http://10.1.2.3:7777/logos/world/truth')                                  // not told which host is Logos: nothing to match
  allowed('echo $GENESIS_LOGOS_URL')
  allowed('./bin/svc GET mock-api/health', env)
})

test('D13: the service ports are an env setting; every lane kind is guarded; the existing memory guard still works', () => {
  denied('curl -s http://127.0.0.1:17641/x', { LANES_SERVICE_PORTS: '17600-17700,18900' })
  allowed('curl -s http://127.0.0.1:18930/x', { LANES_SERVICE_PORTS: '18900' })
  for (const k of ['reflex', 'worker', 'fork', 'curator', 'synthesis']) expect(verdict('curl http://127.0.0.1:18900/svc/', {}, k).v).toBe('deny')
  denied('echo x > memory/note.md'.replace('memory/note.md', `${join(d, 'memory')}/note.md`))   // the write guard of memory (002) is unchanged
})
