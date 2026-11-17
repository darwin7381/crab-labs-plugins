#!/usr/bin/env python3
"""The main's one hook (lanes M1 + M2; docs/state-journal.md).

Register it for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, StopFailure and SessionEnd (matcher "" each). It posts
every event to the tg daemon's /lanes/main-event (TELEGRAM_HTTP_PORT, the loopback MCP token) and prints what the daemon answers:
  SessionStart  the registration: the main-only rules, or "you are not the main"
  PostToolUse   items that reached the main during this turn (pulled at this tool boundary; additionalContext)
  Stop          items still queued are pulled (decision block); else the model aids run (an undecided Joey memory proposal, the answered
                check over the items M1 bound to this turn); when nothing holds the turn, the daemon is told the turn really ended
The daemon decides everything; this script reads no transcript. CLAUDE_PID (set by Claude Code) names the process.
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
    """A model aid that sits beside this file (main-memory-gate.py, main-answered-gate.py). A missing or broken one holds nothing."""
    try:
        spec = importlib.util.spec_from_file_location(name.replace('-', '_').replace('.py', ''), os.path.join(HERE, name))
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        return getattr(m, fn)(*args)
    except Exception:
        return None


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
    if ev == 'PostToolUse' and re.search(r'(__reply|__send_to_agent)$', str(p.get('tool_name') or '')):
        i = p.get('tool_input') or {}
        body['tool_input'] = {'to': i.get('to'), 'reply_to': i.get('reply_to'), 'text': str(i.get('text') or '')[:3000]}
    if ev == 'StopFailure':
        body['reason'] = str(p.get('last_assistant_message') or '')[:300]
    if ev == 'Stop':
        body['phase'] = 'check'
    r = post(body, 1.2 if ev == 'SessionEnd' else 10)
    if ev == 'SessionStart' and r.get('additionalContext'):
        out({'hookSpecificOutput': {'hookEventName': 'SessionStart', 'additionalContext': r['additionalContext']}})
    elif ev == 'PostToolUse' and r.get('additionalContext'):
        out({'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': r['additionalContext']}})
    elif ev == 'Stop':
        held = r.get('block') or aid('main-memory-gate.py', 'reason', p) \
            or aid('main-answered-gate.py', 'reason', p, r.get('items') or [], r.get('outputs') or [])
        if held:
            out({'decision': 'block', 'reason': held})
            return
        body['phase'] = 'final'
        post(body, 10)


if __name__ == '__main__':
    main()
