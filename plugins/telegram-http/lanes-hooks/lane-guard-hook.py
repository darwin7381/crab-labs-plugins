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


def claimed_by():
    try:
        st = json.load(open(os.path.join(os.environ.get('LANES_DIR', ''), 'state.json'), encoding='utf-8'))
        return {k: v.get('lane') for k, v in (st.get('claims') or {}).items()}
    except (OSError, ValueError):
        return {}


def deny(reason):
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny',
                                             'permissionDecisionReason': reason}}))


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
        # 002k: the curator lane holds the memory write right while .lanes/run/memory-writer names it (design/memory 整理線)
        if in_mem and os.environ.get('LANE_KIND') == 'curator' and holds_write_right():
            return
        if rp == persona or any(rp == r or rp.startswith(r + os.sep) for r in roots):
            deny(f'lanes cannot write {f}: memory, the focus card and .lanes/ have a single writer (the main). '
                 'Use ledger_write(kind=memory_proposal) for something worth remembering, or escalate.')
            return
        # 002k: workspace files (design/stability SR6): a reflex lane does not edit them; other lanes claim the file first (claim_file)
        ws = os.path.realpath(cwd)
        if rp.startswith(ws + os.sep):
            kind = os.environ.get('LANE_KIND') or ''
            if kind in ('reflex', 'synthesis', 'curator'):
                deny(f'a {kind} lane does not edit workspace files ({f}). Hand the change to the main with handoff_main.')
            elif claimed_by() .get(rp) != os.environ.get('LANE_ID'):
                deny(f'claim the file first: claim_file(path="{f}", why=...). If another lane holds it you will be told who.')
        return
    if tool == 'Bash':
        cmd = str(ti.get('command', ''))
        hit = direct_service_call(cmd)
        if hit:
            deny(f'lanes reach the services only through ./bin/svc: it records every call and holds the barrier against irreversible actions, '
                 f'so a direct call to {hit} is refused. Use ./bin/svc GET <path> (./bin/svc GET with no path lists the catalog) or '
                 "./bin/svc POST <path> '<json>'.")
            return
        names = [r for r in roots] + ['.lanes', '/memory', 'CLAUDE.md']
        if any(n and n in cmd for n in names) and WRITE_HINTS.search(cmd):
            deny('lanes cannot modify memory, .lanes/ or CLAUDE.md through the shell. '
                 'Use ledger_write(kind=memory_proposal) or escalate.')


if __name__ == '__main__':
    main()
