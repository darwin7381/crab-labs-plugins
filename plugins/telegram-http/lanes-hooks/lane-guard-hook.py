#!/usr/bin/env python3
"""Lane PreToolUse guard (universe 002): lanes never write memory, the focus card, the ledger
files or the persona. Memory has a single writer (the main); lanes file
ledger_write(kind=memory_proposal) instead. Denies with a reason the model can act on.
"""
import json
import os
import re
import shlex
import sys
import urllib.request

WRITE_TOOLS = ('Write', 'Edit', 'MultiEdit', 'NotebookEdit')
WRITE_HINTS = re.compile(r'(>>?|\btee\b|\brm\b|\bmv\b|\bcp\b|sed\s+-i|\btruncate\b|\bgit\b|\btouch\b|\bln\b|python3?\s+-c)')


# ---- 002k (D13): the services are reached only through ./bin/svc
# 002j group D (I03): the barrier against irreversible service calls (a lane's DELETE, publish, config change) lives in ./bin/svc only; a raw
# curl from a lane's Bash to the service port was blocked by nothing. The guard refuses a Bash command whose PROGRAM is a network client
# (curl, wget, nc, httpie, python / node / bun ..., /dev/tcp) and that names a lab service address: a loopback host on a service port
# (LANES_SERVICE_PORTS, default 18900-18999: Logos and the agents' ports) or the host of GENESIS_LOGOS_URL / LANES_LOGOS_URL.
# Only the program of each command counts: text that merely mentions an address (grep, cat, echo, a doc) is not a call. ./bin/svc itself is
# never refused. A local dev server on another port (curl localhost:3000) is not a service.
CLIENTS = {'curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'http', 'https', 'xh', 'httpie', 'ab', 'wrk', 'hey',
           'python', 'python2', 'python3', 'node', 'nodejs', 'bun', 'deno', 'perl', 'ruby', 'php'}
SHELLS = {'bash', 'sh', 'zsh', 'dash', 'ksh'}
WRAPPERS = {'sudo', 'time', 'timeout', 'nohup', 'exec', 'env', 'command', 'nice', 'stdbuf', 'setsid', 'xargs', 'watch', 'builtin'}
LOOPBACK = r'(?:127(?:\.\d{1,3}){3}|localhost|0\.0\.0\.0|\[::1\]|::1)'
SVC_BIN = re.compile(r'^(?:[A-Za-z_]\w*=\S*\s+)*(?:\./|\S*/)?bin/svc(?:\s|$)')


def service_ports():
    ports = set()
    for part in (os.environ.get('LANES_SERVICE_PORTS') or '18900-18999').split(','):
        a, _, b = part.strip().partition('-')
        if a.isdigit() and (not b or b.isdigit()):
            ports.update(range(int(a), int(b or a) + 1))
    return ports


def logos_addr():
    u = os.environ.get('GENESIS_LOGOS_URL') or os.environ.get('LANES_LOGOS_URL') or ''
    m = re.match(r'^[a-z]+://([^/\s]+)', u.strip(), re.I)
    return m.group(1).lower() if m else ''


def names_service(seg):
    """The service address a client command names, or ''."""
    ports = service_ports()
    for m in re.finditer(LOOPBACK + r'[:/ ]\s*(\d{2,5})\b', seg, re.I):
        if int(m.group(1)) in ports:
            return m.group(0).strip()
    la = logos_addr()
    if la and la in seg.lower():
        return la
    if re.search(r'\$\{?(?:GENESIS_LOGOS_URL|LANES_LOGOS_URL)\b', seg):
        return '$GENESIS_LOGOS_URL'
    return ''


def program_of(seg):
    try:
        toks = shlex.split(seg, posix=True)
    except ValueError:
        toks = seg.split()
    i = 0
    while i < len(toks):
        t = toks[i]
        if re.match(r'^[A-Za-z_]\w*=', t) or os.path.basename(t) in WRAPPERS or (i and toks[i - 1] == 'timeout' and re.match(r'^[\d.]+[smhd]?$', t)):
            i += 1
            continue
        return os.path.basename(t), toks[i + 1:]
    return '', []


def fold_heredocs(cmd):
    """A heredoc body belongs to the command that reads it: its lines are joined into that command's line."""
    out, lines, i = [], cmd.split('\n'), 0
    while i < len(lines):
        line = lines[i]
        m = re.search(r'<<-?\s*[\'"]?(\w+)[\'"]?', line)
        if not m:
            out.append(line)
            i += 1
            continue
        body, i = [], i + 1
        while i < len(lines) and lines[i].strip() != m.group(1):
            body.append(lines[i])
            i += 1
        out.append(line + ' ' + ' '.join(body))
        i += 1
    return '\n'.join(out)


def split_commands(cmd):
    """Split on ; & | and newlines that are not inside quotes."""
    segs, cur, q, i = [], [], '', 0
    while i < len(cmd):
        ch = cmd[i]
        if q:
            cur.append(ch)
            if ch == '\\' and q == '"' and i + 1 < len(cmd):
                i += 1
                cur.append(cmd[i])
            elif ch == q:
                q = ''
        elif ch in '\'"':
            q = ch
            cur.append(ch)
        elif ch == '\\' and i + 1 < len(cmd):
            cur.append(ch)
            i += 1
            cur.append(cmd[i])
        elif ch in ';&|\n':
            segs.append(''.join(cur))
            cur = []
        else:
            cur.append(ch)
        i += 1
    segs.append(''.join(cur))
    return segs


def direct_service_call(cmd, depth=0):
    """The service address a Bash command reaches without ./bin/svc, or ''."""
    if depth > 3:
        return ''
    cmd = fold_heredocs(cmd)
    subs = re.findall(r'\$\(([^()]*)\)|`([^`]*)`', cmd)
    for a, b in subs:                                       # $(...) and `...`: a command inside another
        hit = direct_service_call(a or b, depth + 1)
        if hit:
            return hit
    for seg in split_commands(cmd):
        seg = seg.strip()
        if not seg or SVC_BIN.match(seg):
            continue
        t = re.search(r'/dev/tcp/(' + LOOPBACK + r')/(\d{2,5})', seg, re.I)
        if t and int(t.group(2)) in service_ports():
            return f'{t.group(1)}:{t.group(2)}'
        prog, rest = program_of(seg)
        if prog in SHELLS and '-c' in rest and rest.index('-c') + 1 < len(rest):
            hit = direct_service_call(rest[rest.index('-c') + 1], depth + 1)
            if hit:
                return hit
        if prog == 'eval' and rest:
            hit = direct_service_call(' '.join(rest), depth + 1)
            if hit:
                return hit
        if prog in CLIENTS:
            hit = names_service(seg)
            if hit:
                return hit
    return ''


def protected_roots():
    roots = []
    mem = os.environ.get('LANES_MEMORY_DIR')
    if mem:
        roots.append(os.path.realpath(mem))
    lanes = os.environ.get('LANES_DIR')
    if lanes:
        roots.append(os.path.realpath(lanes))
    return roots


def holds_write_right():
    try:
        return open(os.path.join(os.environ.get('LANES_DIR', ''), 'run', 'memory-writer'), encoding='utf-8').read().strip() == os.environ.get('LANE_ID')
    except OSError:
        return False


def curator_write(tool, ti, rp):
    """002w (G): the refusal for a curator's write in the memory dir, or '': a new file, or Edits whose old text stays in the new text."""
    keep = ('the curator only adds to memory: a new file, or an Edit whose new_string keeps the old text (a mark such as 建議刪除 added next to it). '
            'What the main wrote is not overwritten or removed: file a memory_proposal 「建議刪除：…（理由）」 for the main instead.')
    if tool == 'Write':
        return f'{keep} ({os.path.basename(rp)} exists: a Write would replace it.)' if os.path.exists(rp) else ''
    if tool == 'Edit':
        edits = [ti]
    elif tool == 'MultiEdit':
        edits = ti.get('edits') or []
    else:
        return keep
    for e in edits:
        old, new = str((e or {}).get('old_string') or ''), str((e or {}).get('new_string') or '')
        if old and old not in new:
            return f'{keep} (this edit removes 「{old[:80]}」.)'
    return ''


def claimed_by():
    try:
        st = json.load(open(os.path.join(os.environ.get('LANES_DIR', ''), 'state.json'), encoding='utf-8'))
        # keyed by real path, like the paths they are compared with (os.path.realpath below): lanes.ts writes the resolved path,
        # which on macOS can sit under a symlink (/var -> /private/var, /tmp -> /private/tmp); lanes-golive
        return {os.path.realpath(k): v.get('lane') for k, v in (st.get('claims') or {}).items()}
    except (OSError, ValueError):
        return {}


def own_anchor(ws):
    """lanes-topics (item 5): the one knowledge/ file this lane may write, as a real path, or '': a worker lane's anchor file, as the router assigned it
    (state.json lanes[LANE_ID].anchor, under knowledge/lines/), while the lane is open. Any other lane kind, or a closed lane: none."""
    if os.environ.get('LANE_KIND') != 'worker':
        return ''
    try:
        st = json.load(open(os.path.join(os.environ.get('LANES_DIR', ''), 'state.json'), encoding='utf-8'))
        lane = (st.get('lanes') or {}).get(os.environ.get('LANE_ID') or '') or {}
    except (OSError, ValueError):
        return ''
    rel = str(lane.get('anchor') or '')
    if lane.get('kind') != 'worker' or lane.get('status') == 'closed' or not rel:
        return ''
    rp = os.path.realpath(os.path.join(ws, rel))
    return rp if under(rp, os.path.join(ws, 'knowledge', 'lines')) and rp.endswith('.md') else ''


APPEND_EXT = ('.md', '.txt', '.log', '.csv', '.tsv', '.jsonl')
APPEND_NEVER_DIRS = ('.lanes', '.secrets', '.git', '.claude', 'bin', '.telegram-state', '.agent-inbox-state', 'node_modules', os.path.join('knowledge', 'lines'))
APPEND_NEVER_NAMES = ('claude.md', 'reanchor.md', 'memory.md')


def appendable(ws):
    """WO-123: the files the main declared for appending (.lanes/appendable.txt), as real paths. The same rules as lanes-append.ts readDeclared (keep
    the two in step): workspace-relative, a regular file or not there yet, a record-like extension, never memory / .lanes / secrets / settings /
    CLAUDE.md / REANCHOR.md and the anchor files it lists / a worker's anchor files. A lane adds to these with the append_file tool only: every
    write tool and shell write to one of them is refused, for every lane kind (a claim does not open it)."""
    lanes_dir = os.environ.get('LANES_DIR') or ''
    try:
        text = open(os.path.join(lanes_dir, 'appendable.txt'), encoding='utf-8').read()
    except OSError:
        return set()
    wsr = os.path.realpath(ws)
    ld = os.path.realpath(lanes_dir)
    mem = os.path.realpath(os.environ.get('LANES_MEMORY_DIR') or '/nonexistent')
    anchors = set()
    try:
        rean = open(os.path.join(wsr, 'knowledge', 'REANCHOR.md'), encoding='utf-8').read()
        for m in re.finditer(r'`([^`\s]+\.md)`|定錨檔：\s*([^\s|｜)）`]+\.md)', rean):
            q = m.group(1) or m.group(2)
            if q and not q.startswith(('/', '~')):
                anchors.add(os.path.realpath(os.path.join(wsr, q)))
    except OSError:
        pass
    out = set()
    for raw in text.split('\n'):
        line = raw.strip()
        if not line or line.startswith('#') or line.startswith(('/', '~')):
            continue
        abs0 = os.path.normpath(os.path.join(wsr, line))
        if abs0 == wsr or not under(abs0, wsr):
            continue
        if os.path.islink(abs0) or (os.path.lexists(abs0) and not os.path.isfile(abs0)):
            continue
        rp = os.path.realpath(abs0)
        if not under(rp, wsr) or os.path.splitext(rp)[1].lower() not in APPEND_EXT or os.path.basename(rp).lower() in APPEND_NEVER_NAMES:
            continue
        if any(under(rp, os.path.join(wsr, d)) for d in APPEND_NEVER_DIRS) or under(rp, ld) or under(rp, mem) or rp in anchors:
            continue
        out.add(rp)
    return out


def append_why(f):
    return (f'{f} is a file lanes may only ADD to: use append_file(path="{f}", text=...) to put text at its end. '
            'Nothing already in it can be changed (Write, Edit and shell writes are refused).')


def deny(reason):
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny',
                                             'permissionDecisionReason': reason}}))


# ---- WO-125 (B): a refusal is a system fact of the run
# Each write or command refused in a lane run is reported to the daemon (POST /lane-blocked with the run's token), which counts it on the run: the run's
# notify_joey / ask_joey, its receipt and its digest line then carry 「〔系統〕這一趟 N 次寫入或指令被擋：…」, and its scheduled receipt is not completed as a
# success (11-23: five runs reported as done a write refused here). Only with LANES_BLOCK_FACTS=1 in the lane's env (lanes.ts laneEnv, the daemon's switch).
# The target is the file (workspace-relative inside the workspace), else the command's first 80 characters. Not reported: the receipt's own handling (a
# receipt-only command, whatever the daemon answers; a receipt chained after ALLOWED steps). The report never changes the decision: it is sent after the
# decision is printed, and any failure is ignored.
BLOCK = {'target': ''}                  # the file of the refusal write_policy returned ('' = none named: the command is the target)


def shown_path(rp, ws):
    return os.path.relpath(rp, ws) if under(rp, ws) else rp


def command_head(cmd):
    return re.sub(r'\s+', ' ', cmd).strip()[:80]


def report_block(tool, target, category):
    if os.environ.get('LANES_BLOCK_FACTS') != '1' or not target:
        return
    port, tok = os.environ.get('LANES_HTTP_PORT'), os.environ.get('LANE_RUN_TOKEN')
    if not port or not tok:
        return
    try:
        sys.stdout.flush()
        req = urllib.request.Request(f'http://127.0.0.1:{port}/lane-blocked', method='POST',
                                     data=json.dumps({'tool': tool, 'category': category, 'target': target}).encode(),
                                     headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {tok}'})
        with urllib.request.urlopen(req, timeout=3) as r:
            r.read()
    except Exception:
        pass


# ---- 002k (H6): the lane barrier holes, closed here
# 002j group H (H03): the barrier against irreversible service calls and workspace writes was client-side: the svc wrapper takes the lane's identity from
# GENESIS_ACTOR, which the lane's own Bash can override; PUT and PATCH pass the wrapper; Bash can write workspace files (sed -i, >>, python open()).
# The first choice was Claude Code's native Bash sandbox (filesystem write allowlist, network allowlist). It does not run on this box: claude 2.1.322 with
# sandbox.enabled and failIfUnavailable stops at start with "dependencies are missing: socat not installed" (bubblewrap is there). So the guard decides, in code:
#   identity   a command that sets, unsets or clears GENESIS_ACTOR (GENESIS_ACTOR=..., export / unset, env -u / env -i, exec -c) is refused;
#   methods    ./bin/svc takes GET, and the POSTs of the kind's allowlist (reflex, worker, fork: POST api/restart, backup/rerun, tickets; synthesis, curator:
#              none); PUT, PATCH, DELETE and the rest are refused. LANES_SVC_ALLOW overrides the list ("POST:api/restart,POST:tickets");
#   writes     the targets of a Bash command's writes are resolved (redirections, tee, sed -i, cp / mv / ln / install destinations, rm, touch, mkdir, truncate, dd of=,
#              git commands that rewrite the tree, curl -o / wget, tar x, and the literal paths of python / node open / write calls) and refused inside the workspace:
#              reflex, synthesis and curator lanes write only under out/; worker and fork lanes only files they have claimed (claim_file); nobody writes bin/ (the wrapper) or
#              copies it. A target that cannot be worked out (a variable, a substitution) is refused for these kinds. Outside the workspace (/tmp) is free.
# What it cannot see: a script file that does the writing or the calling itself (python3 job.py), a build tool (npm install), a command written in pieces. The sandbox
# would see those; installing socat is what it needs (see the commit message).
RESTRICTED = ('reflex', 'synthesis', 'curator', 'mail')     # lanes-golive: the mail lane writes no workspace file either
# lanes-golive: knowledge/ holds the main's anchor files (定錨檔, knowledge/REANCHOR.md: the global rule of 11-22) and its other knowledge files; a lane's
# record is its receipt and the ledger, so no lane writes there, whatever its kind or claim
KNOWLEDGE_WHY = ('lanes do not write knowledge/ (the anchor files, knowledge/REANCHOR.md and the other knowledge files are the main\'s). '
                 'Your record is your receipt and the ledger: put it there, or hand the change to the main with handoff_main.')


def knowledge_why():
    """the refusal for a write under knowledge/; a worker lane is told its own anchor file is the one it may write (lanes-topics item 5)"""
    if os.environ.get('LANE_KIND') == 'worker':
        return KNOWLEDGE_WHY + ' A worker lane writes exactly one file there: its own anchor file, the path in its 〔車道資訊〕 block (knowledge/lines/...).'
    return KNOWLEDGE_WHY
ACT_KINDS = ('reflex', 'worker', 'fork')
SVC_ALIAS = {'mock-api': 'api', 'mock-backup': 'backup', 'mock-posts': 'posts', 'mock-tickets': 'tickets'}
SVC_ALLOW_DEFAULT = 'POST:api/restart,POST:backup/rerun,POST:tickets'
INTERPRETERS = {'python', 'python2', 'python3', 'node', 'nodejs', 'bun', 'deno', 'perl', 'ruby', 'php'}
WRITING_GIT = {'checkout', 'restore', 'reset', 'clean', 'stash', 'apply', 'am', 'merge', 'rebase', 'pull', 'mv', 'rm', 'revert', 'cherry-pick', 'switch', 'submodule'}
SEPARATORS = {';', '&&', '||', '|', '&', ';;', '|&', '(', ')'}
OUT_REDIRECT = re.compile(r'^[<>&|]*>[<>&|]*$')
IN_REDIRECT = re.compile(r'^<[<&]*$')


def workspace_root(cwd):
    return os.path.realpath(os.environ.get('LANES_WORKSPACE') or cwd)


def under(rp, root):
    return rp == root or rp.startswith(root + os.sep)


def svc_allow():
    out = set()
    for x in (os.environ.get('LANES_SVC_ALLOW') or SVC_ALLOW_DEFAULT).split(','):
        m, _, t = x.strip().partition(':')
        if m and t:
            out.add((m.upper(), t.strip().lower()))
    return out


def svc_target(path):
    p = re.split(r'[?#]', path or '', 1)[0]
    seg = []
    for s in p.split('/'):
        if s in ('', '.'):
            continue
        if s == '..':
            if seg:
                seg.pop()
            continue
        seg.append(s)
    if not seg:
        return ''
    return SVC_ALIAS.get(seg[0], seg[0]).lower() + ('/' + '/'.join(seg[1:]).lower() if len(seg) > 1 else '')


def split_heredocs(cmd):
    """(the command without its heredoc bodies, the bodies)"""
    out, bodies, lines, i = [], [], cmd.split('\n'), 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        i += 1
        m = re.search(r'<<-?\s*[\'"]?(\w+)[\'"]?', line)
        if m:
            body = []
            while i < len(lines) and lines[i].strip() != m.group(1):
                body.append(lines[i])
                i += 1
            bodies.append('\n'.join(body))
            i += 1
    return '\n'.join(out), bodies


def newlines_to_semicolons(cmd):
    out, q, i = [], '', 0
    while i < len(cmd):
        ch = cmd[i]
        if q:
            out.append(ch)
            if ch == '\\' and q == '"' and i + 1 < len(cmd):
                i += 1
                out.append(cmd[i])
            elif ch == q:
                q = ''
        elif ch in '\'"':
            q = ch
            out.append(ch)
        elif ch == '\\' and i + 1 < len(cmd):
            out.append(ch)
            i += 1
            out.append(cmd[i])
        elif ch == '\n':
            out.append(' ; ')
        else:
            out.append(ch)
        i += 1
    return ''.join(out)


def commands(cmd):
    """[(words, redirect targets)] of a command line, and the heredoc bodies. Unquoted ; & | ( ) < > are operators; quoted text stays one word."""
    stripped, bodies = split_heredocs(cmd)
    text = newlines_to_semicolons(stripped)
    try:
        sh = shlex.shlex(text, posix=True, punctuation_chars=True)
        sh.whitespace_split = True
        toks = list(sh)
    except ValueError:
        toks = text.split()
    cmds, words, redirs, i = [], [], [], 0
    while i < len(toks):
        t = toks[i]
        if t in SEPARATORS:
            if words or redirs:
                cmds.append((words, redirs))
            words, redirs = [], []
        elif OUT_REDIRECT.match(t):
            nxt = toks[i + 1] if i + 1 < len(toks) else ''
            if '&' in t and (nxt.isdigit() or nxt == '-'):          # 2>&1, >&2: a copy of a descriptor, not a file
                i += 1
            elif nxt:
                redirs.append(nxt)
                i += 1
            if words and words[-1].isdigit():                       # the 2 of 2>file
                words.pop()
        elif IN_REDIRECT.match(t):
            i += 1
        else:
            words.append(t)
        i += 1
    if words or redirs:
        cmds.append((words, redirs))
    return cmds, bodies


def command_word(words):
    """(program, its arguments) after env assignments and wrappers (sudo, time, env, timeout N ...)"""
    i = 0
    while i < len(words):
        t = words[i]
        b = os.path.basename(t)
        if t in ('do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}'):      # a command after a shell keyword is still a command
            i += 1
            continue
        if re.match(r'^[A-Za-z_]\w*=', t) or b in WRAPPERS:
            if b == 'timeout' and i + 1 < len(words):
                i += 1
            i += 1
            continue
        if t.startswith('-') and i and os.path.basename(words[i - 1]) in WRAPPERS:      # env -i, sudo -n, nice -n ...
            i += 1
            continue
        return b, words[i + 1:], t
    return '', [], ''


def positionals(args, skip_next=()):
    out, i = [], 0
    while i < len(args):
        a = args[i]
        if a == '--':
            out += args[i + 1:]
            break
        if a in skip_next:
            i += 2
            continue
        if a.startswith('-') and a != '-':
            i += 1
            continue
        out.append(a)
        i += 1
    return out


def option_value(args, names):
    for i, a in enumerate(args):
        if a in names and i + 1 < len(args):
            return args[i + 1]
        for n in names:
            if n.startswith('--') and a.startswith(n + '='):
                return a.split('=', 1)[1]
    return None


def interpreter_findings(code):
    """(literal write targets, whether a write goes to a path that is not a literal, shell commands the code runs)"""
    targets, unresolved, shells = [], False, []
    for m in re.finditer(r'\bopen\(\s*(?:(?P<q>[\'"])(?P<p>[^\'"]+)(?P=q)|(?P<v>[^,)\'"]+))\s*,\s*[\'"](?P<mode>[^\'"]*)[\'"]', code):
        if re.search(r'[wax+]', m.group('mode')):
            if m.group('p'):
                targets.append(m.group('p'))
            else:
                unresolved = True
    for m in re.finditer(r'Path\(\s*[\'"]([^\'"]+)[\'"]\s*\)\s*\.\s*(?:write_text|write_bytes|touch|mkdir|unlink|rename|replace|rmdir)', code):
        targets.append(m.group(1))
    for m in re.finditer(r'\b(?:os|shutil)\.(?:remove|rename|unlink|replace|makedirs|mkdir|rmdir|truncate|rmtree|move|copy|copy2|copyfile|copytree)\(\s*(?:[^,)]*,\s*)?[\'"]([^\'"]+)[\'"]', code):
        targets.append(m.group(1))
    for m in re.finditer(r'\b(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|mkdirSync|unlinkSync|rmSync|renameSync|copyFileSync|Bun\.write)\(\s*[\'"`]([^\'"`]+)[\'"`]', code):
        targets.append(m.group(1))
    for m in re.finditer(r'open\([^)]*[\'"]>>?\s*([^\'"]+)[\'"]', code):                # perl / ruby
        targets.append(m.group(1).strip())
    for m in re.finditer(r'(?:os\.system|subprocess\.(?:run|call|check_call|check_output|Popen)|exec|execSync|spawnSync|system)\(\s*(?:\[\s*)?([\'"`])(.*?)\1', code):
        shells.append(m.group(2))
    return targets, unresolved, shells


def actor_tamper(cmd, depth=0):
    """True when a command sets, unsets or clears GENESIS_ACTOR (the lane's identity is the system's)"""
    if re.search(r'\bGENESIS_ACTOR\b\s*\+?=', cmd) or re.search(r'\b(?:export|unset|declare|typeset|readonly|local|eval|alias)\b[^;&|\n]*\bGENESIS_ACTOR\b', cmd):
        return True
    if depth > 3:
        return False
    cmds, bodies = commands(cmd)
    for words, _ in cmds:
        for i, w in enumerate(words):
            b = os.path.basename(w)
            if b == 'env':
                for a in words[i + 1:]:
                    if re.match(r'^[A-Za-z_]\w*=', a):
                        continue
                    if a == '-' or re.match(r'^-[A-Za-z]*[iu]', a) or a.startswith('--unset') or a == '--ignore-environment':
                        return True
                    if not a.startswith('-'):
                        break
            if b == 'exec' and any(a == '-c' for a in words[i + 1:i + 3]):
                return True
        prog, rest, _w = command_word(words)
        if prog in SHELLS and '-c' in rest and rest.index('-c') + 1 < len(rest) and actor_tamper(rest[rest.index('-c') + 1], depth + 1):
            return True
        if prog == 'eval' and rest and actor_tamper(' '.join(rest), depth + 1):
            return True
    for a, b in re.findall(r'\$\(([^()]*)\)|`([^`]*)`', cmd):
        if actor_tamper(a or b, depth + 1):
            return True
    return False


def svc_policy(cmd, kind, depth=0):
    """A refusal for a ./bin/svc call this kind may not make (PUT, PATCH, DELETE, POST outside the allowlist), or ''."""
    if depth > 3:
        return ''
    cmds, _ = commands(cmd)
    for a, b in re.findall(r'\$\(([^()]*)\)|`([^`]*)`', cmd):
        r = svc_policy(a or b, kind, depth + 1)
        if r:
            return r
    for words, _r in cmds:
        prog, rest, _w = command_word(words)
        args = None
        if prog == 'svc':
            args = rest
        elif prog in SHELLS and rest and os.path.basename(rest[0]) == 'svc':
            args = rest[1:]
        elif prog in SHELLS and '-c' in rest and rest.index('-c') + 1 < len(rest):
            r = svc_policy(rest[rest.index('-c') + 1], kind, depth + 1)
            if r:
                return r
        if args is None:
            continue
        method = (args[0] if args else 'GET').upper()
        target = svc_target(args[1] if len(args) > 1 else '')
        if method == 'GET':
            continue
        if kind in ACT_KINDS and (method, target) in svc_allow():
            continue
        allowed = ', '.join(f'{m} {t}' for m, t in sorted(svc_allow())) if kind in ACT_KINDS else 'none'
        return (f'a {kind or "lane"} lane reads the services with ./bin/svc GET <path> (./bin/svc GET with no path lists the catalog); the other methods it may use: {allowed}. '
                f'{method} {args[1] if len(args) > 1 else ""} is refused. Hand it to the main with handoff_main, or tell Joey with ask_joey if the request looks wrong.')
    return ''


def write_targets(prog, args):
    """The paths a command writes (raw strings), '.' for a command that rewrites the tree it runs in, or None for a command that writes nothing we know."""
    pos = positionals
    if prog in ('tee', 'sponge'):
        return pos(args)
    if prog == 'sed' and any(re.match(r'^-[A-Za-z]*i', a) or a.startswith('--in-place') for a in args if a.startswith('-')):
        files = pos(args, skip_next=('-e', '-f', '--expression', '--file'))
        return files if any(a in ('-e', '-f', '--expression', '--file') or a.startswith('--expression') for a in args) else files[1:]
    if prog == 'perl' and any(re.match(r'^-[A-Za-z]*i', a) for a in args if a.startswith('-')):
        files = pos(args, skip_next=('-e', '-E'))
        return files if any(a in ('-e', '-E') or re.match(r'^-[A-Za-z]*e', a) for a in args) else files[1:]
    if prog in ('cp', 'install'):
        if prog == 'install' and '-d' in args:
            return pos(args)
        t = option_value(args, ('-t', '--target-directory'))
        p = pos(args, skip_next=('-t', '--target-directory', '-m', '-o', '-g'))
        return [t] if t else p[-1:]
    if prog == 'mv':
        t = option_value(args, ('-t', '--target-directory'))
        return ([t] if t else []) + pos(args, skip_next=('-t', '--target-directory'))
    if prog == 'ln':
        p = pos(args)
        return p[-1:] if len(p) > 1 else p
    if prog in ('rsync', 'scp'):
        return pos(args)[-1:]
    if prog in ('rm', 'rmdir', 'unlink', 'shred', 'mkdir', 'touch', 'mkfifo', 'mknod', 'chattr', 'setfacl'):
        return pos(args)
    if prog == 'truncate':
        return pos(args, skip_next=('-s', '--size', '-r', '--reference'))
    if prog in ('chmod', 'chown', 'chgrp'):
        return pos(args)[1:]
    if prog == 'dd':
        return [a[3:] for a in args if a.startswith('of=')]
    if prog == 'git':
        i = 0
        while i < len(args) and args[i].startswith('-'):
            i += 2 if args[i] in ('-C', '-c', '--git-dir', '--work-tree') else 1
        return ['.'] if i < len(args) and args[i] in WRITING_GIT else None
    if prog == 'patch':
        return ['.']
    if prog == 'curl':
        o = option_value(args, ('-o', '--output'))
        if o:
            return [o]
        return ['.'] if any(a in ('-O', '--remote-name', '-J', '--remote-header-name') for a in args) else None
    if prog == 'wget':
        o = option_value(args, ('-O', '--output-document'))
        d = option_value(args, ('-P', '--directory-prefix'))
        return [o] if o and o != '-' else ([d] if d else ['.'])
    if prog == 'tar' and args and re.match(r'^-?[A-Za-z]*x', args[0] if not args[0].startswith('--') else '') or (prog == 'tar' and '--extract' in args):
        return [option_value(args, ('-C', '--directory')) or '.']
    if prog == 'unzip':
        return [option_value(args, ('-d',)) or '.']
    if prog == 'find' and ('-delete' in args or any(a in ('-exec', '-execdir') for a in args)):
        return [a for a in args if not a.startswith('-') and a not in ('(', '!')][:1] or ['.']
    return None


def write_policy(cmd, cwd, kind, depth=0):
    """A refusal for a Bash command that writes where this kind may not, or ''."""
    if depth > 3:
        return ''
    ws = workspace_root(cwd)
    out = os.path.join(ws, 'out')
    me = os.environ.get('LANE_ID')
    claims = claimed_by() if kind not in RESTRICTED else {}
    roots = protected_roots()
    cwd_v = os.path.realpath(cwd)
    anchor = own_anchor(ws)                                     # lanes-topics (item 5): a worker's own anchor file
    declared = appendable(ws)                                   # WO-123: files a lane may only append to, with append_file

    def check(raw, cwd_now, why_copy=False):
        if raw in ('', '-') or raw.startswith('/dev/') or raw.startswith('/proc/self/fd'):
            return ''
        if cwd_now is None and not raw.startswith(('/', '~')):
            return UNRESOLVED
        if re.search(r'[$`]', raw):
            return UNRESOLVED
        pat = re.split(r'[*?\[{]', raw, 1)[0] or '.'            # a pattern: the directory it starts in
        rp = os.path.realpath(os.path.join(cwd_now or '/', os.path.expanduser(pat)))
        if anchor and rp == anchor and pat == raw:              # exactly that file (not a pattern that starts there)
            return ''

        def refused(why):                                       # WO-125 (B): the file this refusal is about
            BLOCK['target'] = shown_path(rp, ws)
            return why
        if rp in declared or any(under(d, rp) for d in declared):    # WO-123: an appendable file (or a directory holding one, for rm -r / mv)
            return refused(append_why(os.path.relpath(rp, ws)))
        if any(under(rp, r) for r in roots):
            return refused('lanes cannot modify memory, .lanes/ or CLAUDE.md through the shell. Use ledger_write(kind=memory_proposal) or escalate.')
        if under(rp, os.path.join(ws, 'bin')):
            return refused('bin/ holds the svc wrapper, the barrier of the lanes: no lane writes, moves, deletes or copies it.')
        if under(rp, os.path.join(ws, 'knowledge')):
            return refused(knowledge_why())
        if under(rp, ws) and not under(rp, out):
            rel = os.path.relpath(rp, ws)
            if kind in RESTRICTED:
                return refused(f'a {kind or "lane"} lane does not write workspace files ({rel}). Use out/ (or /tmp) for scratch files, or hand the change to the main with handoff_main.')
            if claims.get(rp) != me:
                return refused(f'claim the file first: claim_file(path="{rel}", why=...). If another lane holds it you will be told who.')
        return ''

    UNRESOLVED = ('the write target of this command cannot be worked out (it uses a variable, a substitution or a command that changes directory in a way that is not visible): '
                  'write to a literal path under out/ or /tmp'
                  + (f', or to your own anchor file ({os.path.relpath(anchor, ws)}) by its literal path' if anchor else '') + '.')
    cmds, bodies = commands(cmd)
    for a, b in re.findall(r'\$\(([^()]*)\)|`([^`]*)`', cmd):
        r = write_policy(a or b, cwd_v, kind, depth + 1)
        if r:
            return r
    for words, redirs in cmds:
        for t in redirs:
            r = check(t, cwd_v)
            if r:
                return r
        prog, rest, _w = command_word(words)
        if prog in ('cd', 'pushd'):
            tgt = positionals(rest)
            cwd_v = os.path.realpath(os.path.join(cwd_v, os.path.expanduser(tgt[0]))) if cwd_v and tgt and not re.search(r'[$`]', tgt[0]) and tgt[0] != '-' else (cwd_v if not tgt else None)
            continue
        if prog in SHELLS and '-c' in rest and rest.index('-c') + 1 < len(rest):
            r = write_policy(rest[rest.index('-c') + 1], cwd_v or cwd, kind, depth + 1)
            if r:
                return r
        if prog == 'eval' and rest:
            r = write_policy(' '.join(rest), cwd_v or cwd, kind, depth + 1)
            if r:
                return r
        if prog in ('cp', 'install', 'rsync', 'ln', 'mv'):                 # the wrapper is not copied
            srcs = positionals(rest)
            for s in (srcs if prog == 'mv' else srcs[:-1]):
                if cwd_v and not re.search(r'[$`*?]', s) and under(os.path.realpath(os.path.join(cwd_v, os.path.expanduser(s))), os.path.join(ws, 'bin')):
                    return 'bin/ holds the svc wrapper, the barrier of the lanes: no lane writes, moves, deletes or copies it.'
        tg = write_targets(prog, rest)
        for t in tg or []:
            r = check(t, cwd_v)
            if r:
                return r
        if prog in INTERPRETERS:
            code = ' '.join(rest) + '\n' + '\n'.join(bodies)
            lits, unresolved, shells = interpreter_findings(code)
            for t in lits:
                r = check(t, cwd_v)
                if r:
                    return r
            if unresolved and (kind in RESTRICTED or kind not in ACT_KINDS):
                return UNRESOLVED
            for sh_cmd in shells:
                r = write_policy(sh_cmd, cwd_v or cwd, kind, depth + 1)
                if r:
                    return r
    return ''


# ---- M3: a scheduler run is completed in one place (lanes.ts completeRun), whichever way the lane asks for it
# The scheduler card tells the agent to run ~/.claude/tools/btcc-receipt complete N (the lab: ./bin/btcc-receipt); a lane also has the receipt tool. Both are the same request: meet the event's
# receipt obligation for run N, once. The guard hands the CLI's request to the daemon (POST /lane-receipt with the run's token), which completes the run
# there (or refuses it: already completed), and the command itself does not run. So nothing but the daemon completes a run at the scheduler.
RECEIPT_CLI = 'btcc-receipt'


def receipt_cli_calls(cmd, depth=0):
    """[{run_id, outcome, note}] of the `btcc-receipt complete N` commands in a Bash command line (also inside bash -c '...')"""
    out = []
    cmds, _ = commands(cmd)
    for words, _r in cmds:
        prog, args, _w = command_word(words)
        if prog in SHELLS and depth < 3:
            inner = option_value(args, ('-c',))
            if inner:
                out += receipt_cli_calls(inner, depth + 1)
            continue
        if prog == RECEIPT_CLI and args[:1] == ['complete']:
            pos = positionals(args[1:], skip_next=('--outcome', '--note'))
            out.append({'run_id': pos[0] if pos else '', 'outcome': option_value(args, ('--outcome',)) or 'done', 'note': option_value(args, ('--note',)) or ''})
    return out


# ---- WO-129 (telegram-http 1.39.0): a lane completes a scheduled run only with the receipt tool (its steps)
# With LANES_RECEIPT_STEPS=1 (the lane's env, set by the router) the router answers a lane's btcc-receipt complete with `cli_blocked` and the pointer to the
# receipt tool (completing nothing): that answer is the whole deny reason. A Bash command that calls the scheduler's completion API itself
# (.../api/scheduler/runs/<N>/complete) is refused the same way (the router counts it: via=api). btcc-receipt ack is not touched.
COMPLETION_API = re.compile(r'/api/scheduler/runs/(\d+)/complete\b')


def steps_on():
    return os.environ.get('LANES_RECEIPT_STEPS') == '1'


def receipt_tool_words():
    return 'the receipt tool: receipt(run_id, outcome, steps)' if steps_on() else 'btcc-receipt complete alone, or the receipt tool with run_id'


def lane_receipt_post(body):
    """POST /lane-receipt with the run's token: the router's answer (dict), or None when it cannot be reached"""
    port, tok = os.environ.get('LANES_HTTP_PORT'), os.environ.get('LANE_RUN_TOKEN')
    if not (port and tok):
        return None
    req = urllib.request.Request(f'http://127.0.0.1:{port}/lane-receipt', data=json.dumps(body).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {tok}'})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return json.loads(r.read() or b'{}') or {}
    except Exception:
        return None


def completion_api_refusal(cmd):
    """the deny reason for a command that calls the scheduler's completion API directly (steps on), or ''"""
    if not steps_on():
        return ''
    runs = COMPLETION_API.findall(cmd)
    if not runs:
        return ''
    a = lane_receipt_post({'run_id': runs[0], 'via': 'api'}) or {}
    return str(a.get('text') or f'This command was not run: in a lane, a scheduled run is completed only by the receipt tool: receipt(run_id={runs[0]}, outcome, steps). '
                                  'Nothing was sent to the scheduler.')


def complete_through_daemon(calls):
    """the deny reason: what the daemon did with each completion the command asked for"""
    port, tok = os.environ.get('LANES_HTTP_PORT'), os.environ.get('LANE_RUN_TOKEN')
    said, refile = [], False
    for c in calls:
        text = ''
        if port and tok:
            req = urllib.request.Request(f'http://127.0.0.1:{port}/lane-receipt', data=json.dumps(c).encode(), method='POST',
                                         headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {tok}'})
            try:
                with urllib.request.urlopen(req, timeout=8) as r:
                    a = json.loads(r.read() or b'{}') or {}
                # 1.38.2: a run handed to the main with the matter is the main's to complete: the router records the lane's part only
                if a.get('cli_blocked'):                         # WO-129: the receipt tool is the lane's one way; the router's pointer says it all
                    return str(a.get('text', ''))
                text = ('completed: ' if a.get('ok') else 'left for the main: ' if a.get('left_for_main') else 'not completed: ') + str(a.get('text', ''))
                refile = refile or bool(a.get('refile'))         # WO-125 (B): refused as a success while refusals count: it is filed again, as failed
            except Exception as e:
                text = f'not completed: the router could not be reached ({type(e).__name__}); call receipt(run_id={c["run_id"]}, outcome=...)'
        else:
            text = f'not completed: call receipt(run_id={c["run_id"]}, outcome=...{", steps=[...]" if steps_on() else ""})'
        said.append(f'run {c["run_id"] or "?"} {text}')
    return ('This command was not run: a lane completes a scheduler run through the router, the same request as the receipt tool, once per run. '
            + ' | '.join(said) + (' File the receipt again as that says (btcc-receipt complete <run> --outcome failed --note \'...\' on its own, or the receipt tool); run any other part of the command on its own.'
                                  if refile else ' Do not run btcc-receipt complete again; run any other part of the command on its own.'))


def bash_policy(cmd, cwd, kind):
    """The refusal for a lane's Bash command, or ''."""
    if actor_tamper(cmd):
        return ('a lane\'s identity is set by the system (GENESIS_ACTOR): a command that sets, unsets or clears it (GENESIS_ACTOR=..., export / unset, env -u, env -i, exec -c) '
                'is refused. Run ./bin/svc as it is.')
    r = svc_policy(cmd, kind)
    if r:
        return r
    hit = direct_service_call(cmd)
    if hit:
        return (f'lanes reach the services only through ./bin/svc: it records every call and holds the barrier against irreversible actions, '
                f'so a direct call to {hit} is refused. Use ./bin/svc GET <path> (./bin/svc GET with no path lists the catalog) or '
                "./bin/svc POST <path> '<json>' where the kind may.")
    return write_policy(cmd, cwd, kind)


def bash_refusal(cmd, cwd, kind, roots):
    """The refusal for a lane's Bash command (bash_policy, then the shell check on memory / .lanes / CLAUDE.md), or ''."""
    why = bash_policy(cmd, cwd, kind)
    if why:
        return why
    names = [r for r in roots] + ['.lanes', '/memory', 'CLAUDE.md']
    if any(n and n in cmd for n in names) and WRITE_HINTS.search(cmd):
        return ('lanes cannot modify memory, .lanes/ or CLAUDE.md through the shell. '
                'Use ledger_write(kind=memory_proposal) or escalate.')
    return ''


# ---- 1.36.2: a refused command has no side effect, its receipt included
# 2026-11-23 10:06Z, elsa.reflex.1 (scheduled run 6843) ran ONE command: `echo ... >> data/login-habits.md; cf_access_watch.py --ack; btcc-receipt complete 6843`.
# The receipt branch came first: the hook completed run 6843 through the daemon (ledger: 「run 6843: ok — ...（btcc-receipt）」) and refused the command
# without looking at the rest; run alone, the write was then refused (a reflex lane writes no workspace file) and the --ack never ran, yet the run stood
# completed and the lane told Joey the line was recorded. Now the rest of the command is checked first: a command the guard refuses completes nothing.
def receipt_only(cmd, depth=0):
    """True when the command is nothing but `btcc-receipt complete N` calls (a cd before them allowed, also inside bash -c '...')"""
    cmds, _ = commands(cmd)
    for words, redirs in cmds:
        prog, args, _w = command_word(words)
        if redirs:
            return False
        if prog in SHELLS and depth < 3:
            inner = option_value(args, ('-c',))
            if inner and receipt_only(inner, depth + 1):
                continue
            return False
        if (prog == RECEIPT_CLI and args[:1] == ['complete']) or prog in ('cd', 'pushd'):
            continue
        return False
    return bool(cmds)


def receipt_refused(why, calls):
    """the deny reason for a refused command that also asked for a scheduler run's completion: nothing ran, the run is not completed"""
    runs = ', '.join(c['run_id'] or '?' for c in calls)
    if not why:
        # an allowed command chained with the receipt: until 1.36.2 the run was completed here and the command refused "for the receipt alone", so the
        # run stood completed before any of the work had run. The receipt is filed by a command of its own, after the work.
        return (f'This command was not run and NOTHING in it ran, the btcc-receipt complete included: scheduler run {runs} is NOT completed. '
                'The receipt has to be a command of its own. Run the work first as separate commands, check that it worked, and then file the receipt '
                f'({receipt_tool_words()}) only after the work is really done.')
    return (f'This command was refused and NOTHING in it ran, the btcc-receipt complete included: scheduler run {runs} is NOT completed. '
            f'Why it was refused: {why} '
            'Run the allowed steps as separate commands, check that they worked, and file the receipt '
            f'({receipt_tool_words() if steps_on() else "btcc-receipt complete, or the receipt tool with run_id"}) only after the work is really done.')


def main():
    try:
        p = json.load(sys.stdin)
    except Exception:
        return
    tool = p.get('tool_name', '')
    ti = p.get('tool_input') or {}
    cwd = p.get('cwd') or os.getcwd()
    roots = protected_roots()
    persona = os.path.realpath(os.path.join(cwd, 'CLAUDE.md'))
    if tool in WRITE_TOOLS:
        f = ti.get('file_path') or ti.get('notebook_path') or ''
        rp = os.path.realpath(os.path.join(cwd, os.path.expanduser(f)))
        mem = os.path.realpath(os.environ.get('LANES_MEMORY_DIR') or '/nonexistent')
        in_mem = rp == mem or rp.startswith(mem + os.sep)
        ws = workspace_root(cwd)

        def refuse(why):                                                         # WO-125 (B): every refusal of a write tool is reported, its file the target
            deny(why)
            report_block(tool, shown_path(rp, ws), 'file')
        # 002k: the curator lane holds the memory write right while .lanes/run/memory-writer names it (design/memory 整理線)
        # 002w (G, gap 20): MM5 「整理線只整理提案，不刪主線寫的內容，只能標記『建議刪除』」 is the guard's, not the prompt's: with the right the curator
        # writes new files and Edits that keep the old text (a mark added, nothing removed); a Write over an existing file, an Edit that removes text and
        # a notebook edit are refused
        if in_mem and os.environ.get('LANE_KIND') == 'curator' and holds_write_right():
            why = curator_write(tool, ti, rp)
            if why:
                refuse(why)
            return
        if rp == persona or any(rp == r or rp.startswith(r + os.sep) for r in roots):
            refuse(f'lanes cannot write {f}: memory, the focus card and .lanes/ have a single writer (the main). '
                   'Use ledger_write(kind=memory_proposal) for something worth remembering, or escalate.')
            return
        # 002k: workspace files (design/stability SR6): a reflex lane does not edit them; other lanes claim the file first (claim_file)
        if rp in appendable(ws):                                                 # WO-123: append-only, through append_file
            refuse(append_why(f))
            return
        if under(rp, os.path.join(ws, 'bin')):                                  # 002k (H6): the svc wrapper is the barrier
            refuse('bin/ holds the svc wrapper, the barrier of the lanes: no lane writes, moves, deletes or copies it.')
            return
        if under(rp, os.path.join(ws, 'knowledge')):                            # lanes-golive: the main's anchor and knowledge files
            if rp != own_anchor(ws):                                             # lanes-topics (item 5): except a worker's own anchor file
                refuse(knowledge_why())
            return
        if rp.startswith(ws + os.sep):
            kind = os.environ.get('LANE_KIND') or ''
            if kind in RESTRICTED:
                if not under(rp, os.path.join(ws, 'out')):                       # 002k (H6): out/ is the scratch place of these kinds
                    refuse(f'a {kind} lane does not edit workspace files ({f}). Use out/ for scratch files, or hand the change to the main with handoff_main.')
            elif claimed_by() .get(rp) != os.environ.get('LANE_ID'):
                refuse(f'claim the file first: claim_file(path="{f}", why=...). If another lane holds it you will be told who.')
        return
    if tool == 'Bash':
        cmd = str(ti.get('command', ''))
        api = completion_api_refusal(cmd)                                        # WO-129: a direct completion call (steps on): refused, never run
        if api:
            deny(api)
            return
        calls = receipt_cli_calls(cmd)
        BLOCK['target'] = ''
        try:
            why = bash_refusal(cmd, cwd, os.environ.get('LANE_KIND') or '', roots)   # 002k (D13, H6): identity, ./bin/svc methods, direct service calls, write targets
        except Exception:
            if not calls:
                raise
            why = ''                                                             # the receipt path is never worse than before 1.36.2
        if calls:
            # 1.36.2: the command itself never runs either way (M3: nothing but the daemon completes a run).
            # Only a command that is nothing but the receipt call completes the run: chained after other steps (refused OR allowed) it completes
            # nothing, because none of those steps has run yet when the hook sees the command.
            if receipt_only(cmd):
                deny(complete_through_daemon(calls))                             # WO-125: the receipt's own handling, never reported
            else:
                deny(receipt_refused(why, calls))
                if why:                                                          # WO-125 (B): the rest of it was refused (a write, a command): that counts;
                    report_block('Bash', BLOCK['target'] or command_head(cmd), 'file' if BLOCK['target'] else 'command')   # chained after ALLOWED steps: not
            return
        if why:
            deny(why)
            report_block('Bash', BLOCK['target'] or command_head(cmd), 'file' if BLOCK['target'] else 'command')   # WO-125 (B)


if __name__ == '__main__':
    main()
