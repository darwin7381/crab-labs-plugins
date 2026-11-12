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


def main_context(agent, session_id):
    """The main-only rules (registered main). Lanes never get this text: their identity card is built by lanes.ts."""
    # The architecture's main-only rules travel with the architecture (this hook), not in the
    # persona files, so universe 002 runs on exactly the same inhabitant set as universe 001.
    return '\n'.join([
        f'[lanes] 你是 {agent} 的主線（session {session_id} 已登記）。以下是主線專用規則，車道不適用：',
        '- Telegram 與分流到主線的 mesh 訊息只會送到你這裡。例行警報、排程、別的 agent 的新話題由反射線（headless 車道）處理；'
        '它們做了什麼，會附在你下一則自然進來的訊息最前面（標「車道摘要」，已拆成每條線的發生／做了／承諾／需主線；不會為了它單獨叫醒你）。'
        '只有升級（escalation）、被停掉的對話線、已推播給 Joey 的事會單獨叫醒你，並連同待送的摘要一起來。'
        '看完，需要你決定的事就處理（必要時回報 Joey），其他不必回覆。',
        '- 被問「發生了什麼事」「答應過誰什麼」之前，先用 ledger_query(since, kind, text) 查帳本再回答；摘要只列重點，有些事（例如車道靜默回覆對方、只進帳本的通知）不會出現在摘要裡。',
        '- 維護焦點卡 .lanes/focus.md：任務改變時更新，3 到 6 行，寫「目前在做什麼、關鍵限制、別碰什麼」。車道開機時會讀它。',
        '- 長任務或要讀很多東西的事交出去：open_worker(title, brief) 開一條綁 Telegram 話題的工作線；fork(task) 開一條帶著你目前脈絡的分身線。',
        '- 記憶目錄只有主線寫，每次寫入自動 commit；車道只能在帳本留 memory_proposal，你在摘要裡看到再決定要不要寫。',
    ])


def not_main_context(agent, reasons):
    return (f'[lanes] 注意：你不是 {agent} 的主線（{reasons}）。你不會收到 Telegram 或 mesh 訊息，'
            '也不要用 reply / send_to_agent 代替主線發言。')


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
        ctx = main_context(agent, p.get('session_id'))
    else:
        reasons = '; '.join(f'{k}: {v.get("reason")}' for k, v in out.items())
        ctx = not_main_context(agent, reasons)
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'SessionStart', 'additionalContext': ctx}},
                     ensure_ascii=False))


if __name__ == '__main__':
    main()
