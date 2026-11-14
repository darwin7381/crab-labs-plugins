// Universe 002k (H6): the lane barrier holes, closed in the guard hook (the native Bash sandbox does not run on this box: socat is missing).
// identity (GENESIS_ACTOR), ./bin/svc methods per kind, and the targets of a Bash command's writes. The hook is run as Claude Code runs it. No network, no model.
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'

const HOOK = join(import.meta.dir, 'lanes-hooks', 'lane-guard-hook.py')
const base = mkdtempSync(join(tmpdir(), 'guard-h6-'))
const ws = join(base, 'ws'), ld = join(ws, '.lanes'), mem = join(base, 'memory')
for (const d of [ws, ld, mem, join(ws, 'mock-api'), join(ws, 'out'), join(ws, 'bin'), join(ws, 'docs')]) mkdirSync(d, { recursive: true })
writeFileSync(join(ws, 'mock-api', 'config.yaml'), 'log_level: info\n'); writeFileSync(join(ws, 'notes.txt'), 'n\n'); writeFileSync(join(ws, 'bin', 'svc'), '#!/bin/bash\n')
writeFileSync(join(ld, 'state.json'), JSON.stringify({ claims: { [join(ws, 'mock-api', 'config.yaml')]: { lane: 'adam.worker.1' }, [join(ws, 'docs', 'plan.md')]: { lane: 'adam.worker.2' } } }))
function verdict(command: string, kind = 'reflex', env: Record<string, string> = {}, cwd = ws, tool = 'Bash', input: object = { command }): { v: 'deny' | 'allow'; reason: string } {
  const r = spawnSync('python3', [HOOK], { input: JSON.stringify({ tool_name: tool, tool_input: input, cwd }), encoding: 'utf8',
    env: { ...process.env, LANES_DIR: ld, LANES_MEMORY_DIR: mem, LANES_WORKSPACE: ws, LANE_KIND: kind, LANE_ID: `adam.${kind}.1`, GENESIS_LOGOS_URL: '', LANES_LOGOS_URL: '', LANES_SVC_ALLOW: '', ...env } })
  const j = r.stdout.trim() ? JSON.parse(r.stdout) : null
  return { v: j?.hookSpecificOutput?.permissionDecision === 'deny' ? 'deny' : 'allow', reason: j?.hookSpecificOutput?.permissionDecisionReason ?? '' }
}
const no = (c: string, kind = 'reflex', env?: Record<string, string>) => expect({ c, kind, ...verdict(c, kind, env) }).toMatchObject({ v: 'deny' })
const yes = (c: string, kind = 'reflex', env?: Record<string, string>) => expect({ c, kind, ...verdict(c, kind, env) }).toMatchObject({ v: 'allow' })

// ------------------------------------------------------------------ identity
test('H6 identity: a command that sets, unsets or clears GENESIS_ACTOR is refused, whatever follows; reading it and other env is fine', () => {
  for (const c of [
    "GENESIS_ACTOR=adam.main ./bin/svc POST mock-api/scale '{\"replicas\":10}'",
    'GENESIS_ACTOR= ./bin/svc DELETE mock-backup/snapshots/snap-20261105',
    'env -u GENESIS_ACTOR ./bin/svc POST mock-api/scale',
    'env -i ./bin/svc DELETE mock-backup/snapshots/s1',
    'env --unset=GENESIS_ACTOR ./bin/svc GET',
    'env -i PATH=/usr/bin ./bin/svc GET',
    'export GENESIS_ACTOR=adam.main; ./bin/svc POST mock-api/scale',
    'unset GENESIS_ACTOR && ./bin/svc DELETE x',
    "bash -c 'unset GENESIS_ACTOR; ./bin/svc DELETE mock-backup/snapshots/s1'",
    'exec -c ./bin/svc GET',
    'eval "GENESIS_ACTOR=adam.main ./bin/svc GET"',
    'sudo env -u GENESIS_ACTOR ./bin/svc GET',
  ]) no(c)
  expect(verdict("GENESIS_ACTOR=adam.main ./bin/svc GET").reason).toContain('GENESIS_ACTOR'); expect(verdict("env -i ./bin/svc GET").reason).toContain('set by the system')
  for (const c of ['echo $GENESIS_ACTOR', 'printenv GENESIS_ACTOR', 'env FOO=1 ./bin/svc GET mock-api/health', 'env | grep LANE', 'FOO=1 ./bin/svc GET mock-api/config', 'env']) yes(c)
  for (const k of ['reflex', 'worker', 'fork', 'curator', 'synthesis']) no('GENESIS_ACTOR=adam.main ./bin/svc GET', k)
}, 60_000)

// ------------------------------------------------------------------ ./bin/svc methods
test('H6 methods: GET always; reflex, worker and fork may also POST api/restart, backup/rerun and tickets; PUT, PATCH, DELETE and the other POSTs are refused', () => {
  for (const k of ['reflex', 'worker', 'fork', 'curator', 'synthesis'])
    for (const c of ['./bin/svc', './bin/svc GET', './bin/svc GET mock-api/health', "./bin/svc get 'tickets?page=1&per_page=50'", 'bin/svc GET mock-backup/snapshots', 'for i in 1 2 3; do ./bin/svc GET mock-api/health; sleep 1; done']) yes(c, k)
  for (const k of ['reflex', 'worker', 'fork'])
    for (const c of ['./bin/svc POST mock-api/restart', './bin/svc POST api/restart', './bin/svc POST backup/rerun', './bin/svc POST mock-backup/rerun', "./bin/svc POST tickets '{\"title\":\"p95 高\",\"priority\":\"P2\"}'", "./bin/svc POST mock-tickets '{}'", "./bin/svc POST mock-api/restart '{}' | head -3"]) yes(c, k)
  for (const k of ['reflex', 'worker', 'fork', 'curator', 'synthesis'])
    for (const c of [
      "./bin/svc PUT mock-api/config '{\"log_level\":\"debug\"}'", "./bin/svc PATCH mock-api/config '{\"log_level\":\"debug\"}'", './bin/svc DELETE mock-backup/snapshots/snap-1',
      "./bin/svc POST mock-api/scale '{\"replicas\":10}'", "./bin/svc POST mock-api/config '{}'", './bin/svc POST mock-posts/publish', './bin/svc POST tickets/close', './bin/svc POST mock-api/restart/../scale',
      './bin/svc post mock-api/scale', './bin/svc HEAD mock-api/health', './bin/svc mock-api/health',
      'bash ./bin/svc PUT mock-api/config', './bin/svc GET mock-api/health && ./bin/svc PUT mock-api/config', 'echo $(./bin/svc PUT mock-api/config)', "bash -c './bin/svc PATCH mock-api/config'",
      'for i in 1 2; do ./bin/svc PUT mock-api/config; done', 'timeout 5 ./bin/svc DELETE mock-backup/snapshots/s1', '/abs/ws/bin/svc PUT mock-api/config',
    ]) no(c, k)
  for (const k of ['curator', 'synthesis']) { no('./bin/svc POST mock-api/restart', k); no('./bin/svc POST tickets', k) }          // these kinds read only
  const r = verdict("./bin/svc PUT mock-api/config '{}'", 'reflex')
  expect(r.reason).toContain('PUT mock-api/config is refused'); expect(r.reason).toContain('./bin/svc GET <path>'); expect(r.reason).toContain('POST api/restart'); expect(r.reason).toContain('handoff_main')
  expect(verdict('./bin/svc POST mock-api/restart', 'synthesis').v).toBe('deny'); expect(verdict('./bin/svc POST mock-api/restart', 'synthesis').reason).toContain('other methods it may use: none')
}, 90_000)

test('H6 methods: LANES_SVC_ALLOW replaces the list', () => {
  yes('./bin/svc POST backup/rerun', 'reflex', { LANES_SVC_ALLOW: 'POST:api/restart,POST:backup/rerun' })
  no('./bin/svc POST tickets', 'reflex', { LANES_SVC_ALLOW: 'POST:api/restart,POST:backup/rerun' })
  no('./bin/svc POST backup/rerun', 'reflex', { LANES_SVC_ALLOW: 'POST:api/restart' })
  yes('./bin/svc POST mock-api/restart', 'reflex', { LANES_SVC_ALLOW: 'POST:api/restart' })
})

// ------------------------------------------------------------------ writes
test('H6 writes (reflex, synthesis, curator): the probes of the finding, and the other ways a Bash command writes into the workspace, are refused', () => {
  const RES_ALL: string[] = [
      "sed -i 's/log_level: info/log_level: debug/' mock-api/config.yaml", "sed -i.bak -e 's/info/debug/' mock-api/config.yaml", "sed -ni 's/info/debug/p' mock-api/config.yaml",
      'echo "x" >> notes.txt', 'echo x > ./notes.txt', 'cat /tmp/a > mock-api/config.yaml', 'printf x >| notes.txt', 'echo x &> notes.txt',
      "python3 -c \"open('mock-api/config.yaml','a').write('log_level: debug')\"", 'python3 - <<EOF\nwith open("notes.txt", "w") as f:\n    f.write("x")\nEOF',
      "python3 -c \"import pathlib; pathlib.Path('notes.txt').write_text('x')\"".replace('pathlib.Path', 'Path'), "python3 -c \"import os; os.remove('notes.txt')\"",
      "python3 -c \"import shutil; shutil.copy('/tmp/a', 'mock-api/config.yaml')\"", "node -e \"require('fs').writeFileSync('notes.txt', 'x')\"", "node -e \"fs.appendFileSync('mock-api/config.yaml','x')\"",
      "python3 -c \"import os; os.system('sed -i s/a/b/ mock-api/config.yaml')\"",
      'cat /tmp/a | tee notes.txt', 'echo x | tee -a mock-api/config.yaml', 'echo x | sponge notes.txt',
      'cp /tmp/a mock-api/config.yaml', 'cp -f /tmp/a notes.txt', 'cp -t mock-api /tmp/a', 'mv /tmp/a notes.txt', 'mv notes.txt /tmp/', 'install -m 644 /tmp/a notes.txt', 'ln -sf /tmp/a notes.txt', 'rsync -a /tmp/a/ mock-api/',
      'rm -f notes.txt', 'rm -rf mock-api', 'rm mock-api/*', 'touch newfile.txt', 'mkdir newdir', 'truncate -s 0 notes.txt', 'dd if=/dev/zero of=notes.txt count=1', 'chmod 600 notes.txt',
      'git checkout -- notes.txt', 'git -C . reset --hard', 'git stash', 'git apply /tmp/p.diff', 'patch -p1 < /tmp/p.diff',
      'wget https://example.com/x.tar.gz', 'wget -P mock-api https://example.com/x', 'curl -O https://example.com/f', 'curl -o notes.txt https://example.com/f',
      'tar xzf /tmp/a.tgz', 'unzip /tmp/a.zip', "find . -name '*.tmp' -delete",
      'cd mock-api && sed -i s/a/b/ config.yaml', 'cd mock-api; echo x > config.yaml', '(cd mock-api && echo x >> config.yaml)',
      "bash -c 'echo x >> notes.txt'", 'sh -c "sed -i s/a/b/ mock-api/config.yaml"', 'eval "echo x > notes.txt"', 'echo $(echo x > notes.txt)',
      'for f in notes.txt; do echo x >> $f; done', 'echo x > $FILE', 'echo x > "$(pwd)/notes.txt"', 'cd $SOMEWHERE && echo x > a.txt',
      'sed -i s/a/b/ bin/svc', 'echo x >> bin/svc', 'cp bin/svc /tmp/svc2', 'mv bin/svc /tmp/svc3', 'rm bin/svc', 'echo x >> .lanes/ledger.jsonl', `echo x > ${join(mem, 'n.md')}`,
  ]
  for (const c of RES_ALL) no(c, 'reflex')                                                    // every command, as a reflex lane
  for (const k of ['synthesis', 'curator']) for (const c of RES_ALL.filter((_, i) => i % 6 === 0)) no(c, k)   // a spread of them for the other restricted kinds
}, 90_000)

test('H6 writes: out/, /tmp and reading are free; the commands lanes really run stay allowed', () => {
  const FREE: string[] = [
      'echo x > out/a.txt', 'echo x >> out/log.txt', 'mkdir -p out/tmp && touch out/tmp/x', 'cp mock-api/config.yaml out/config.yaml.orig', 'mv out/a out/b', 'rm -rf out/tmp', "sed -i 's/a/b/' out/a.txt", 'tee out/x < /dev/null',
      'echo x > /tmp/a.txt', 'cd /tmp && echo x > a.txt && cp a.txt b.txt', 'cd out && echo x > a.txt', "python3 -c \"open('/tmp/x','w').write('x')\"", "python3 -c \"open('out/x','w').write('x')\"",
      "python3 -c \"from pathlib import Path; Path('out/r.txt').write_text('x')\"", "node -e \"require('fs').writeFileSync('/tmp/n', 'x')\"", 'curl -s -o /tmp/r.json https://example.com/r.json', 'wget -q -O /tmp/y https://example.com/y',
      'tar czf out/b.tgz mock-api', 'tar xzf /tmp/a.tgz -C /tmp/x', "find /tmp -name 'x*' -delete", 'git status', 'git log --oneline | head -5', 'git diff', 'git -C . log -3',
      'cat mock-api/config.yaml', 'cat notes.txt > /dev/null', 'ls -la 2>&1', 'grep -rn "log_level" docs/ mock-api/ 2>/dev/null | head -20', "sed -n '1,40p' docs/plan.md", 'sed s/a/b/ notes.txt | head',
      "awk '{print $1}' mock-api/config.yaml | sort | uniq -c | sort -rn | head", 'date -u +%FT%TZ', 'wc -l mock-api/config.yaml', "find . -name '*.md' | head", 'sleep 1; echo done',
      "./bin/svc GET mock-api/metrics | python3 -c \"import json,sys; d=json.load(sys.stdin); print(d['p95_ms'])\"", "./bin/svc GET 'tickets?page=1&per_page=50' > /tmp/t.json", './bin/svc GET mock-api/health 2>&1 | head -3',
      'echo $(date) > out/a', 'cat bin/svc', 'head -20 bin/svc',
  ]
  for (const c of FREE) yes(c, 'reflex')
  for (const k of ['synthesis', 'curator']) for (const c of FREE.filter((_, i) => i % 5 === 0)) yes(c, k)
}, 90_000)

test('H6 writes (worker, fork): only files the lane has claimed (and out/ and /tmp); never bin/; the refusal says to claim', () => {
  for (const k of ['worker', 'fork']) {
    const c = { LANE_ID: 'adam.worker.1' }
    yes("sed -i 's/info/debug/' mock-api/config.yaml", k, c); yes('echo x >> mock-api/config.yaml', k, c); yes("python3 -c \"open('mock-api/config.yaml','a').write('x')\"", k, c)    // claimed by adam.worker.1
    yes('echo x > out/a.txt', k, c); yes('echo x > /tmp/a', k, c)
    no('echo x >> notes.txt', k, c); no('cp /tmp/a notes.txt', k, c); no('rm notes.txt', k, c); no('touch new.txt', k, c)               // not claimed
    no('echo x >> docs/plan.md', k, c)                                                                                                    // claimed by ANOTHER lane
    no('echo x >> bin/svc', k, c); no('sed -i s/a/b/ bin/svc', k, c)                                                                      // never the wrapper, claimed or not
    no('echo x > $F', k, c)
  }
  expect(verdict('echo x >> notes.txt', 'worker', { LANE_ID: 'adam.worker.1' }).reason).toContain('claim the file first: claim_file(path="notes.txt"')
  expect(verdict('echo x >> docs/plan.md', 'worker', { LANE_ID: 'adam.worker.1' }).reason).toContain('claim the file first')
  expect(verdict('echo x >> notes.txt', 'reflex').reason).toContain('does not write workspace files (notes.txt)'); expect(verdict('echo x >> notes.txt', 'reflex').reason).toContain('out/')
}, 60_000)

// ------------------------------------------------------------------ the file tools
test('H6 file tools: reflex, synthesis and curator may write under out/ with Write and Edit and nowhere else in the workspace; bin/ is never written', () => {
  const w = (file: string, kind: string, tool = 'Write', env: Record<string, string> = {}) => verdict('', kind, env, ws, tool, { file_path: file })
  for (const k of ['reflex', 'synthesis', 'curator']) {
    expect(w(join(ws, 'out', 'a.txt'), k).v).toBe('allow'); expect(w('out/a.txt', k).v).toBe('allow')
    expect(w(join(ws, 'mock-api', 'config.yaml'), k).v).toBe('deny'); expect(w('notes.txt', k, 'Edit').v).toBe('deny'); expect(w('/tmp/x.txt', k).v).toBe('allow')
  }
  expect(w(join(ws, 'mock-api', 'config.yaml'), 'worker', 'Edit', { LANE_ID: 'adam.worker.1' }).v).toBe('allow')               // claimed
  expect(w(join(ws, 'notes.txt'), 'worker', 'Write', { LANE_ID: 'adam.worker.1' }).v).toBe('deny')
  for (const k of ['reflex', 'worker', 'fork', 'curator', 'synthesis']) expect(w(join(ws, 'bin', 'svc'), k, 'Edit', { LANE_ID: 'adam.worker.1' }).v).toBe('deny')
  expect(w(join(ws, 'bin', 'svc'), 'worker', 'Edit', { LANE_ID: 'adam.worker.1' }).reason).toContain('svc wrapper')
  expect(w(join(ld, 'ledger.jsonl'), 'worker').v).toBe('deny')                                                                  // unchanged: the lanes directory
})

test('H6: the workspace is the lane\'s start directory (LANES_WORKSPACE), not wherever its shell has wandered', () => {
  expect(verdict('echo x >> /tmp/notes.txt', 'reflex', {}, '/tmp').v).toBe('allow')                                              // the shell sits in /tmp: a relative notes.txt would be /tmp/notes.txt
  expect(verdict('echo x >> notes.txt', 'reflex', {}, '/tmp').v).toBe('allow')
  expect(verdict(`echo x >> ${join(ws, 'notes.txt')}`, 'reflex', {}, '/tmp').v).toBe('deny')                                      // an absolute path into the workspace, wherever the shell is
  expect(verdict('echo x >> ../notes.txt', 'reflex', {}, join(ws, 'out')).v).toBe('deny')                                          // out/ ../ is the workspace again
  expect(verdict('echo x >> notes.txt', 'reflex', {}, join(ws, 'out')).v).toBe('allow')                                           // out/notes.txt
})

test('H6: the lane process gets LANES_WORKSPACE (the workspace the guard measures against)', async () => {
  const { mkdtempSync: mk, copyFileSync, readFileSync, chmodSync } = await import('fs')
  const L = await import('./lanes.ts?h6-env') as typeof import('./lanes.ts')
  const dir = mk(join(tmpdir(), 'lanes-h6env-'))
  process.env.LANES_DIR = dir
  copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
  writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
  mkdirSync(join(dir, 'workspace'))
  const bin = join(dir, 'lane.py')
  writeFileSync(bin, `#!/usr/bin/env python3\nimport os\nopen('${dir}/env.txt', 'w').write(os.environ.get('LANES_WORKSPACE', '') + '|' + os.environ.get('LANE_KIND', ''))\nprint('{"type":"result","subtype":"success","is_error":false,"result":"ok"}')\n`)
  chmodSync(bin, 0o755)
  const restore = L.__setClaudeBin(bin)
  L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: join(dir, 'workspace'), transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
  L.__setMainConnected('mcp-main')
  await L.routeEvent({ id: 'mesh-h6e', source: 'mesh', from: 'eve', verified: true, text: 'hi', meta: {}, notif: { method: '', params: {} } } as any)
  for (let i = 0; i < 100; i++) { try { readFileSync(join(dir, 'env.txt'), 'utf8'); break } catch { await new Promise(r => setTimeout(r, 30)) } }
  expect(readFileSync(join(dir, 'env.txt'), 'utf8')).toBe(`${join(dir, 'workspace')}|reflex`)
  L.__setClaudeBin(restore)
})
