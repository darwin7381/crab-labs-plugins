#!/usr/bin/env python3
"""Lane PreToolUse guard (universe 002): lanes never write memory, the focus card, the ledger
files or the persona. Memory has a single writer (the main); lanes file
ledger_write(kind=memory_proposal) instead. Denies with a reason the model can act on.
"""
import json
import os
import re
import sys

WRITE_TOOLS = ('Write', 'Edit', 'MultiEdit', 'NotebookEdit')
WRITE_HINTS = re.compile(r'(>>?|\btee\b|\brm\b|\bmv\b|\bcp\b|sed\s+-i|\btruncate\b|\bgit\b|\btouch\b|\bln\b|python3?\s+-c)')


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
        names = [r for r in roots] + ['.lanes', '/memory', 'CLAUDE.md']
        if any(n and n in cmd for n in names) and WRITE_HINTS.search(cmd):
            deny('lanes cannot modify memory, .lanes/ or CLAUDE.md through the shell. '
                 'Use ledger_write(kind=memory_proposal) or escalate.')


if __name__ == '__main__':
    main()
