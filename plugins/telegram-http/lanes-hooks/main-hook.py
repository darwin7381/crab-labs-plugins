#!/usr/bin/env python3
"""The main's one hook (lanes M1 + M2; docs/state-journal.md).

Register it for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, StopFailure and SessionEnd (matcher "" each). It posts
every event to the tg daemon's /lanes/main-event (TELEGRAM_HTTP_PORT, the loopback MCP token) and prints what the daemon answers:
  SessionStart  the registration: the main-only rules, or "you are not the main"
  PreToolUse    on the reply tool (…__reply): the summary gate (main-summary-gate.py reason(p, turn)) over the `turn` the daemon answers;
                its deny reason refuses the reply. On send_to_agent: 002w, its C16 claims check (main-summary-gate.py claims(p, turn), the one
                the reply gets) refuses a send that says the main did what its own tool results say it did not; else (002v) when the daemon
                answers mark_no_reply (the turn took in the last message of a conversation the thread gate stopped, and this send goes to that
                peer), the send runs with no_reply set (updatedInput)
  PostToolUse   every tool's input (each string cut to 3000 chars) and result (text, cut to 20000 chars; tool_error) go to the daemon, which
                keeps this turn's calls; it answers the items that reached the main during this turn (pulled at this tool boundary; additionalContext)
  Stop          items still queued are pulled (decision block); else, once per turn, a turn that still owes what it works on (the daemon's M3
                check, 002w: a Joey line, a peer's answer, a receipt of an event of this turn, or of the work a turn that took in nothing carries
                on, handed to the main or open on what it owns) is held (decision block, naming each event); else
                the model aids run (an undecided Joey memory proposal over the daemon's
                `proposals` / `turn` / `curator`, the answered check over the items M1 bound to this turn, which also asks whether the
                turn's last words (the payload's last_assistant_message, after the turn's last output) reached anyone; 002v: a turn that took in
                nothing is asked over the `context` the daemon hands: the work it carries on); when nothing holds the turn, the
                daemon is told the turn really ended
The daemon decides everything and hands the aids the turn (items, calls, start times); this script and its aids read no transcript.
A hook event that carries `agent_id` fired inside a subagent (Claude Code runs the session's tool hooks for a subagent's calls too): it is not
the main's turn. It is posted as `sub: true`, nothing is printed, and the daemon only keeps an open turn alive by it (002r).
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
    if p.get('agent_id'):                    # 002r (H05): a subagent's (or teammate's) tool call, not the main's turn: the daemon only notes the process works
        post({'event': ev, 'session_id': p.get('session_id'), 'pid': int(pid) if pid.isdigit() else None, 'sub': True}, 5)
        if ev == 'PreToolUse' and str(p.get('tool_name') or '').endswith('__reply'):
            # 002w (G, gap 19): the Telegram reply tool is the main's: a subagent of the main reports to the main, which answers Joey
            out({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny',
                 'permissionDecisionReason': 'refused: the reply tool belongs to the main session; a subagent returns its result to the main, and the main answers Joey.'}})
        return
    body = {'event': ev, 'session_id': p.get('session_id'), 'prompt_id': p.get('prompt_id'), 'pid': int(pid) if pid.isdigit() else None,
            'transcript_path': p.get('transcript_path'), 'source': p.get('source'), 'tool_name': p.get('tool_name'), 'error': p.get('error')}
    if ev == 'UserPromptSubmit':
        body['dids'] = DID.findall(str(p.get('prompt') or ''))
    if ev == 'PreToolUse' and p.get('tool_name') == 'Bash':   # the tool's own bound (M2's stuck rule): a Bash runs at most its timeout
        ti = p.get('tool_input') if isinstance(p.get('tool_input'), dict) else {}
        if not ti.get('run_in_background'):
            try:
                body['tool_timeout_ms'] = int(ti.get('timeout') or os.environ.get('BASH_DEFAULT_TIMEOUT_MS') or 120000)
            except (TypeError, ValueError):
                body['tool_timeout_ms'] = 120000
    if ev == 'PreToolUse' and str(p.get('tool_name') or '').endswith('__send_to_agent'):   # 002v: the router may mark it no_reply (a stopped conversation)
        ti = p.get('tool_input') if isinstance(p.get('tool_input'), dict) else {}
        body['tool_input'] = {'to': ti.get('to'), 'no_reply': ti.get('no_reply')}
    if ev == 'PostToolUse':                              # every tool: the daemon keeps this turn's calls (reply / send_to_agent keep their to, reply_to, text keys)
        body['tool_input'] = trim_input(p.get('tool_input'))
        tr = p.get('tool_response')
        body['tool_response'] = response_text(tr)
        body['tool_error'] = bool(tr.get('is_error')) if isinstance(tr, dict) else False
    if ev == 'StopFailure':
        body['reason'] = str(p.get('last_assistant_message') or '')[:300]
    if ev == 'SessionEnd':                               # 002v: why it ended (clear: the process goes on with a new session)
        body['reason'] = str(p.get('reason') or '')
    if ev == 'Stop':
        body['phase'] = 'check'
    r = post(body, 1.2 if ev == 'SessionEnd' else 10)
    if ev == 'SessionStart' and r.get('additionalContext'):
        out({'hookSpecificOutput': {'hookEventName': 'SessionStart', 'additionalContext': r['additionalContext']}})
    elif ev == 'PostToolUse' and r.get('additionalContext'):
        out({'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': r['additionalContext']}})
    elif ev == 'PreToolUse' and str(p.get('tool_name') or '').endswith('__send_to_agent'):
        # 002w (F, gap 18): the C16 claims check judges what the main tells a peer as it judges what it tells Joey (the daemon hands the turn for both)
        deny = aid('main-summary-gate.py', 'claims', p, r['turn']) if isinstance(r.get('turn'), dict) else None
        if deny:
            out({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': deny}})
        elif r.get('mark_no_reply') and isinstance(p.get('tool_input'), dict):
            # 002v: updatedInput replaces the whole input (hooks reference, PreToolUse decision control): the main's own input with no_reply set
            out({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'updatedInput': {**p['tool_input'], 'no_reply': True}}})
    elif ev == 'PreToolUse' and str(p.get('tool_name') or '').endswith('__reply') and isinstance(r.get('turn'), dict):
        deny = aid('main-summary-gate.py', 'reason', p, r['turn'])
        if deny:
            out({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': deny}})
    elif ev == 'Stop':
        held = r.get('block') or aid('main-memory-gate.py', 'reason', p, r.get('turn') or {}, r.get('proposals') or [], bool(r.get('curator'))) \
            or aid('main-answered-gate.py', 'reason', p, r.get('items') or [], r.get('outputs') or [], r.get('turn') or {}, r.get('context'))
        if held:
            out({'decision': 'block', 'reason': held})
            return
        body['phase'] = 'final'
        post(body, 10)
        aid('memory-commit-hook.py', 'commit', p, None)   # 002w (G, gap 21): what the turn changed in memory by any tool (Bash, NotebookEdit) is committed


if __name__ == '__main__':
    main()
