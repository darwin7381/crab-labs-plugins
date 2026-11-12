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
        if rp == persona or any(rp == r or rp.startswith(r + os.sep) for r in roots):
            deny(f'lanes cannot write {f}: memory, the focus card and .lanes/ have a single writer (the main). '
                 'Use ledger_write(kind=memory_proposal) for something worth remembering, or escalate.')
        return
    if tool == 'Bash':
        cmd = str(ti.get('command', ''))
        names = [r for r in roots] + ['.lanes', '/memory', 'CLAUDE.md']
        if any(n and n in cmd for n in names) and WRITE_HINTS.search(cmd):
            deny('lanes cannot modify memory, .lanes/ or CLAUDE.md through the shell. '
                 'Use ledger_write(kind=memory_proposal) or escalate.')


if __name__ == '__main__':
    main()
