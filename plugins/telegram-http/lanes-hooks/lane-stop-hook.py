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
import re
import subprocess
import sys

TOLD = ('mcp__lane__notify_joey', 'mcp__lane__ask_joey', 'mcp__lane__handoff_main', 'mcp__lane__report_result', 'mcp__lane__deliver_synthesis', 'mcp__lane__curator_done')
CLOSERS = ('mcp__lane__notify_joey', 'mcp__lane__ask_joey', 'mcp__lane__handoff_main', 'mcp__lane__reply_agent', 'mcp__lane__receipt',
           'mcp__lane__report_result', 'mcp__lane__deliver_synthesis', 'mcp__lane__curator_done')   # 002k: fan-out, synthesis, curator
MAX_BLOCKS = 2
# 002k (E3, 002j group E): a Joey-class run that ends by telling Joey it cannot do something, without ever looking at the service catalog.
DECLINE_RE = re.compile(r"無法|沒辦法|can[’']t|cannot|unable", re.I)


def looked_at_catalog(cmd):
    """Some command of the Bash call IS ./bin/svc with no arguments (the catalog) or with GET."""
    for seg in re.split(r'&&|\|\||[;|&\n]', cmd):
        toks, i = seg.split(), 0
        while i < len(toks) and (re.match(r'^[A-Za-z_]\w*=', toks[i]) or toks[i] in ('sudo', 'time', 'nohup', 'exec', 'env', 'command', 'bash', 'sh')):
            i += 1
        if i < len(toks) and (toks[i] == 'bin/svc' or toks[i].endswith('/bin/svc')):
            args = toks[i + 1:]
            if not args or args[0].upper() == 'GET':
                return True
    return False


def catalog_output(cwd):
    """What ./bin/svc prints (the catalog), run here by the program; '' when it cannot be run."""
    try:
        r = subprocess.run(['./bin/svc'], cwd=cwd or os.getcwd(), capture_output=True, text=True, timeout=8)
        return r.stdout.strip()[:3000] if r.returncode == 0 else ''
    except Exception:
        return ''


def save_state(state_p, st):
    if not state_p:
        return False
    try:
        tmp = state_p + '.tmp'
        json.dump(dict(list(st.items())[-200:]), open(tmp, 'w'))
        os.replace(tmp, state_p)
        return True
    except Exception:
        return False


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
    closed, used = False, set()
    notify_texts, looked = [], False
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
            if n == 'mcp__lane__notify_joey':
                notify_texts.append(str((c.get('input') or {}).get('text', '')))
            elif n == 'Bash' and looked_at_catalog(str((c.get('input') or {}).get('command', ''))):
                looked = True
            if n in TOLD:
                closed = True
            elif n in CLOSERS:
                used.add(n)
    lanes_dir = os.environ.get('LANES_DIR', '')
    state_p = os.path.join(lanes_dir, 'run', 'stop-blocks.json') if lanes_dir else ''
    key = f'{sid}:{last_user}'
    try:
        st = json.load(open(state_p)) if state_p and os.path.exists(state_p) else {}
    except Exception:
        st = {}
    # 002k (plan/decisions DC1): reply_agent or receipt alone is not a line for Joey. A high-frequency routine may end with the receipt
    # alone (Joey msg 934): its tag is in the event text of this turn.
    prompt_text = ''
    try:
        pj = json.loads(lines[last_user]); pc = pj.get('message', {}).get('content', '')
        prompt_text = pc if isinstance(pc, str) else ' '.join(x.get('text', '') for x in pc if isinstance(x, dict))
    except Exception:
        pass
    # 002k (B9): a follow-up run (its event text is the router's "後續檢查" message) always leaves its notify_joey line, even when the
    # routine it belongs to is high-frequency: the follow-up text says so, and the receipt-only exception is for the scheduled run itself
    followup = '[車道事件｜後續檢查' in prompt_text
    if not closed and used and used <= {'mcp__lane__receipt'} and '[high-frequency]' in prompt_text and not followup:
        closed = True
    # 002k (E3): a run Joey's message started that ends with a notify_joey that declines, and that never called ./bin/svc for the catalog or a GET:
    # held once, with the output of ./bin/svc attached as program output (the hook ran it; it is not a new instruction)
    if closed and not looked and '來源 Telegram｜Joey' in prompt_text and notify_texts:
        m = DECLINE_RE.search(notify_texts[-1])
        if m and int(st.get(key + ':decline', 0)) < 1:
            out = catalog_output(p.get('cwd'))
            if out:
                st[key + ':decline'] = 1
                if save_state(state_p, st):                      # cannot remember = could hold for ever: do not hold
                    lane = os.environ.get('LANE_ID', 'this lane')
                    print(json.dumps({'decision': 'block', 'reason': (
                        f'⛔ lane-stop-hook: {lane} told Joey it cannot ({m.group(0)}), but this run never looked at the service catalog or made a GET call '
                        f'(no ./bin/svc catalog or GET). Output of ./bin/svc, run by the hook just now (program output):\n{out}')}, ensure_ascii=False))
                    return
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
        f'⛔ lane-stop-hook: {lane} has not left Joey a line yet. Close this turn with notify_joey (one line; the router decides '
        'whether it rings, a peer matter is silent), also after answering a peer with reply_agent. '
        'Only a high-frequency routine with no change may end with the receipt alone (a follow-up run never may). '
        'Never end silent. If Joey must decide, use ask_joey; if the main must do it, use handoff_main (one of them, not both).')}))


if __name__ == '__main__':
    main()
