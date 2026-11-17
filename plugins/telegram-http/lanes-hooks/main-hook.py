#!/usr/bin/env python3
"""The main's one hook (lanes M1 + M2; docs/state-journal.md).

Register it for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, StopFailure and SessionEnd (matcher "" each). It posts
every event to the tg daemon's /lanes/main-event (TELEGRAM_HTTP_PORT, the loopback MCP token) and prints what the daemon answers:
  SessionStart  the registration: the main-only rules, or "you are not the main"
  PreToolUse    on the reply tool (…__reply): the summary gate (main-summary-gate.py reason(p, turn)) over the `turn` the daemon answers;
                its deny reason refuses the reply
  PostToolUse   every tool's input (each string cut to 3000 chars) and result (text, cut to 20000 chars; tool_error) go to the daemon, which
                keeps this turn's calls; it answers the items that reached the main during this turn (pulled at this tool boundary; additionalContext)
  Stop          items still queued are pulled (decision block); else the model aids run (an undecided Joey memory proposal over the daemon's
                `proposals` / `turn` / `curator`, the answered check over the items M1 bound to this turn); when nothing holds the turn, the
                daemon is told the turn really ended
The daemon decides everything and hands the aids the turn (items, calls, start times); this script and its aids read no transcript.
CLAUDE_PID (set by Claude Code) names the process.
"""
import importlib.util
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DID = re.compile(r'\bdid="([^"]+)"')


def token(port):
    d = os.environ.get('MCP_TOKEN_DIR') or os.path.expanduser('~/.claude/agent-inbox/mcp-tokens')
    try:
        return open(os.path.join(d, str(port))).read().strip()
    except Exception:
        return ''


def post(body, timeout):
    port = os.environ.get('TELEGRAM_HTTP_PORT')
    if not port:
        return {}
    req = urllib.request.Request(f'http://127.0.0.1:{port}/lanes/main-event', data=json.dumps(body, ensure_ascii=False).encode('utf-8'), method='POST',
                                 headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token(port)}'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b'{}')
    except Exception:
        return {}


def aid(name, fn, *args):
    """A model aid that sits beside this file (main-summary-gate.py, main-memory-gate.py, main-answered-gate.py). A missing or broken one holds nothing."""
    try:
        spec = importlib.util.spec_from_file_location(name.replace('-', '_').replace('.py', ''), os.path.join(HERE, name))
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        return getattr(m, fn)(*args)
    except Exception:
        return None


def trim_input(i):
    """The tool's input with each string value cut to 3000 chars."""
    if not isinstance(i, dict):
        return {}
    return {k: (v[:3000] if isinstance(v, str) else v) for k, v in i.items()}


def response_text(r):
    """The tool's result as text, cut to 20000 chars: a str as is, a dict with a 'content' list = the text of its parts, else its JSON."""
    if isinstance(r, str):
        t = r
    elif isinstance(r, dict) and isinstance(r.get('content'), list):
        t = ''.join(str(x.get('text', '')) for x in r['content'] if isinstance(x, dict))
    else:
        try:
            t = json.dumps(r, ensure_ascii=False)
        except Exception:
            t = str(r)
    return t[:20000]


def out(o):
    print(json.dumps(o, ensure_ascii=False))


def main():
    try:
        p = json.load(sys.stdin)
    except Exception:
        return
    ev = p.get('hook_event_name') or ''
    pid = os.environ.get('CLAUDE_PID') or ''
    body = {'event': ev, 'session_id': p.get('session_id'), 'prompt_id': p.get('prompt_id'), 'pid': int(pid) if pid.isdigit() else None,
            'transcript_path': p.get('transcript_path'), 'source': p.get('source'), 'tool_name': p.get('tool_name'), 'error': p.get('error')}
    if ev == 'UserPromptSubmit':
        body['dids'] = DID.findall(str(p.get('prompt') or ''))
    if ev == 'PostToolUse':                              # every tool: the daemon keeps this turn's calls (reply / send_to_agent keep their to, reply_to, text keys)
        body['tool_input'] = trim_input(p.get('tool_input'))
        tr = p.get('tool_response')
        body['tool_response'] = response_text(tr)
        body['tool_error'] = bool(tr.get('is_error')) if isinstance(tr, dict) else False
    if ev == 'StopFailure':
        body['reason'] = str(p.get('last_assistant_message') or '')[:300]
    if ev == 'Stop':
        body['phase'] = 'check'
    r = post(body, 1.2 if ev == 'SessionEnd' else 10)
    if ev == 'SessionStart' and r.get('additionalContext'):
        out({'hookSpecificOutput': {'hookEventName': 'SessionStart', 'additionalContext': r['additionalContext']}})
    elif ev == 'PostToolUse' and r.get('additionalContext'):
        out({'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': r['additionalContext']}})
    elif ev == 'PreToolUse' and str(p.get('tool_name') or '').endswith('__reply') and isinstance(r.get('turn'), dict):
        deny = aid('main-summary-gate.py', 'reason', p, r['turn'])
        if deny:
            out({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': deny}})
    elif ev == 'Stop':
        held = r.get('block') or aid('main-memory-gate.py', 'reason', p, r.get('turn') or {}, r.get('proposals') or [], bool(r.get('curator'))) \
            or aid('main-answered-gate.py', 'reason', p, r.get('items') or [], r.get('outputs') or [])
        if held:
            out({'decision': 'block', 'reason': held})
            return
        body['phase'] = 'final'
        post(body, 10)


if __name__ == '__main__':
    main()
