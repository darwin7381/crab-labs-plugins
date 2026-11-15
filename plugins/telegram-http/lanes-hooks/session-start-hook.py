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
        '只有交給你的事（車道用 handoff_main 交接、車道處理失敗、被停掉的對話線）會單獨叫醒你，並連同待送的摘要一起來：'
        '那件事由你接手，車道沒有通知過 Joey，處理完由你回報他一次。'
        '摘要裡寫「已通知 Joey」「已請 Joey 決定」的事，車道已經跟他講過了：不要重複通知他，除非你有新的資訊或他問起。其他不必回覆。',
        '- 被問「今天發生了什麼」「處理了哪些事」「答應過誰什麼」「還有什麼沒結束」：先呼叫一次 ledger_query()（不帶任何參數），'
        '它回傳整天每件事一行的活動清單，包含車道處理掉、沒有叫醒你的例行事。清單裡每一件都要交代到，連同它的具體數字、時間、人名，再補上你自己處理的事。'
        '某一件的原文用 ledger_query(text=關鍵字)；答應過什麼也可以查 kind=commitment。',
        '- 維護焦點卡 .lanes/focus.md：任務改變時更新，3 到 6 行，寫「目前在做什麼、關鍵限制、別碰什麼」。車道開機時會讀它。',
        '- 長任務或要讀很多東西的事交出去：open_worker(title, brief) 開一條綁 Telegram 話題的工作線；fork(task) 開一條帶著你目前脈絡的分身線。',
        # 002l (D9): design/merge 「扇出再收攏：主線一次開出多條線各查一塊，指定一條綜合線讀完所有結果、交回一份結論」. 002k named only open_worker and fork here; fan_out was a
        # deferred tool name the main never found (0 calls in every 002k run; F05 did three checks itself). The tools and when to use each:
        '- 一件事可以拆成幾塊各自去查（例如三個服務各查一次、幾份紀錄各讀一份）：用 fan_out(tasks, conclusion)，每塊開一條查詢線，最後一條綜合線讀完全部、交回你一份結論；'
        '你讀的是一份綜合，不是 N 份全文。不要自己一塊一塊查。',
        '- 你答應了別人什麼（給 Joey 或別的 agent「我會…」「…前給你」）：用 commitment(who, what, by, due) 記下；有時限就填 due，到時沒標完成會提醒 Joey。做完用 commitment_done。',
        '- 帳本裡累積了好幾筆記憶提案、你又閒著：用 curate_memory 把寫入權交給一條整理線去整理，做完它自己交還（curate_stop 隨時收回）；單筆提案用 memory_decide 決定。',
        # 002l (D16): design/notify 「分級由分流器依訊息類型決定」: the router gives the report on a hand-over the tier of the event that was handed over
        '- 回報車道交給你的事（摘要裡以〔ho-…〕開頭的那一行）時，reply 帶 handoff_id=那個編號；響不響由分流器依那件事的類別決定（同事的事通常靜音），你不用自己判斷。',
        '- 上面這些車道工具（fan_out、commitment、commitment_done、curate_memory、curate_stop、memory_decide、open_worker、fork、peer_hold）可能是延遲載入的：看不到就先用 ToolSearch 搜它的名字載入，再呼叫。',
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
