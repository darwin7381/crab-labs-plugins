#!/usr/bin/env python3
"""Main registration (universe 002): SessionStart hook of the main TUI.

POSTs {session_id, transcript_path, source} to /lanes/register-main on this agent's
telegram-http daemon (TELEGRAM_HTTP_PORT) and agent-inbox daemon (AGENT_INBOX_PORT). The
daemons identify the calling claude process by its socket, accept only the session the keeper
launched (or the same process after /clear), and from then on deliver main-bound traffic to
that process's MCP session only. The verdict is handed back to the session as context, so a
second session in the folder is told plainly that it is not the main.
"""
import json
import os
import sys
import urllib.request


def token(port):
    d = os.environ.get('MCP_TOKEN_DIR') or os.path.expanduser('~/.claude/agent-inbox/mcp-tokens')
    try:
        return open(os.path.join(d, str(port))).read().strip()
    except Exception:
        return ''


def post(port, body):
    req = urllib.request.Request(f'http://127.0.0.1:{port}/lanes/register-main', data=json.dumps(body).encode(),
                                 method='POST', headers={'Content-Type': 'application/json',
                                                         'Authorization': f'Bearer {token(port)}'})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return json.loads(r.read() or b'{}')
    except Exception as e:
        return {'accepted': False, 'reason': f'daemon unreachable: {e}'}


def main():
    try:
        p = json.load(sys.stdin)
    except Exception:
        return
    body = {'session_id': p.get('session_id'), 'transcript_path': p.get('transcript_path'), 'source': p.get('source')}
    out = {}
    for name in ('TELEGRAM_HTTP_PORT', 'AGENT_INBOX_PORT'):
        port = os.environ.get(name)
        if port:
            out[name] = post(port, body)
    ok = out and all(v.get('accepted') for v in out.values())
    agent = os.environ.get('LANES_AGENT') or os.path.basename(os.getcwd())
    if ok:
        ctx = (f'[lanes] 你是 {agent} 的主線（session {p.get("session_id")} 已登記）。'
               'Telegram 與分流到主線的 mesh 訊息只會送到你這裡；例行警報、排程、別的 agent 的新話題由反射線處理，'
               '結果在你閒下來時以 user="lanes" 的摘要送達。任務改變時更新焦點卡 .lanes/focus.md。')
    else:
        reasons = '; '.join(f'{k}: {v.get("reason")}' for k, v in out.items())
        ctx = (f'[lanes] 注意：你不是 {agent} 的主線（{reasons}）。你不會收到 Telegram 或 mesh 訊息，'
               '也不要用 reply / send_to_agent 代替主線發言。')
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'SessionStart', 'additionalContext': ctx}},
                     ensure_ascii=False))


if __name__ == '__main__':
    main()
