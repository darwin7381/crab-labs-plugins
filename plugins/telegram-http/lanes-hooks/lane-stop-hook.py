#!/usr/bin/env python3
"""Lane Stop hook (universe 002): never-silent for lanes.

A lane turn may only end after it closed with one of the lane tools
  notify_joey (the router alone decides its tier), reply_agent, receipt
— the lane equivalents of the fleet rule "every woken turn reports". High-frequency no-change
routines close with receipt only (Joey msg 934).
Blocks at most MAX_BLOCKS times per turn; after that the daemon's exit check makes the silence
loud (ledger escalation + bot message), so a stuck model cannot loop forever.
"""
import json
import os
import sys

CLOSERS = ('mcp__lane__notify_joey', 'mcp__lane__ask_joey', 'mcp__lane__handoff_main', 'mcp__lane__reply_agent', 'mcp__lane__receipt')
MAX_BLOCKS = 2


def main():
    try:
        p = json.load(sys.stdin)
    except Exception:
        return
    tp = p.get('transcript_path') or ''
    sid = p.get('session_id', '')
    try:
        lines = open(tp, encoding='utf-8').read().splitlines()
    except Exception:
        return
    last_user = None
    for i in range(len(lines) - 1, -1, -1):
        try:
            j = json.loads(lines[i])
        except Exception:
            continue
        if j.get('type') != 'user':
            continue
        c = j.get('message', {}).get('content', '')
        if isinstance(c, list):
            if any(isinstance(x, dict) and x.get('type') == 'tool_result' for x in c):
                continue
            txt = ' '.join(x.get('text', '') for x in c if isinstance(x, dict) and x.get('type') == 'text')
        else:
            txt = str(c)
        if txt.lstrip().startswith('Stop hook feedback') or 'lane-stop-hook' in txt:
            continue
        last_user = i
        break
    if last_user is None:
        return
    closed = False
    for line in lines[last_user + 1:]:
        try:
            j = json.loads(line)
        except Exception:
            continue
        if j.get('type') != 'assistant':
            continue
        for c in j.get('message', {}).get('content', []) or []:
            if not isinstance(c, dict) or c.get('type') != 'tool_use':
                continue
            n = c.get('name', '')
            if n in CLOSERS:
                closed = True
    lanes_dir = os.environ.get('LANES_DIR', '')
    state_p = os.path.join(lanes_dir, 'run', 'stop-blocks.json') if lanes_dir else ''
    key = f'{sid}:{last_user}'
    try:
        st = json.load(open(state_p)) if state_p and os.path.exists(state_p) else {}
    except Exception:
        st = {}
    if closed:
        return
    n = int(st.get(key, 0))
    if n >= MAX_BLOCKS:
        return
    st[key] = n + 1
    if state_p:
        try:
            tmp = state_p + '.tmp'
            json.dump(dict(list(st.items())[-200:]), open(tmp, 'w'))
            os.replace(tmp, state_p)
        except Exception:
            pass
    lane = os.environ.get('LANE_ID', 'this lane')
    print(json.dumps({'decision': 'block', 'reason': (
        f'⛔ lane-stop-hook: {lane} has not reported yet. Close this turn with notify_joey'
        ', reply_agent (answering the agent that asked), or receipt '
        '(scheduled routine; high-frequency no-change may leave only the receipt). '
        'Never end silent. If Joey must decide, use ask_joey; if the main must do it, use handoff_main (one of them, not both).')}))


if __name__ == '__main__':
    main()
