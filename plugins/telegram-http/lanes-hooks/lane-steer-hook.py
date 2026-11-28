#!/usr/bin/env python3
"""Mid-run steering for a LANE (universe 002k, E18): PostToolUse + Stop hook.

A message from Joey that routes to a lane whose run is in progress used to wait in the queue until the run ended (002j E04 / F01: 48 to 156 s). A `claude -p`
lane has no channel to receive it on (the main's hook pulls what reached it at its tool boundaries: lanes-main.ts M1), so the
daemon does the equivalent through a file: it appends the message to <lanes dir>/run/steer/<lane id>.in.jsonl, and this hook, which every lane run carries, hands
it to the model once:
  PostToolUse -> additionalContext at the next tool boundary (rides on the call the model was going to make anyway: no extra model call)
  Stop        -> blocks once when the run would end with such a message never handed over (lane-stop-hook.py calls deliver() below first, so that
                 the lane's two Stop checks never answer one Stop event with two different blocks; this file is registered for PostToolUse only)
What was handed over is written to <lane id>.out.jsonl (before anything is printed: a message that cannot be marked is not handed over, so it never repeats); the
daemon reads that file, writes the delivery to the ledger and queues whatever was NOT delivered (the run ended first) as the lane's next run, ahead of the rest.
WO-132 (telegram-http 1.40.0): kind `merged` = an alert of the run's incident the router merged into it (same host, inside the window); the daemon wrote its
whole text (its head and the event), handed over the same way, at the next tool boundary or at Stop.
Not in the main's settings (the main has main-hook.py).
"""
import json
import os
import sys
import time

BODY_MAX = 1500


def read_jsonl(path):
    out = []
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    j = json.loads(line)
                except ValueError:
                    continue
                if isinstance(j, dict):
                    out.append(j)
    except OSError:
        pass
    return out


def render_system(items):
    # 002l (D8, N4): the daemon's own notice to the run (a limit is near); not a Joey message
    return '\n'.join(f"〔系統通知｜車道上限〕{str(e.get('text') or '')[:BODY_MAX]}" for e in items)


def render_merged(items):
    # WO-132 (item 2): an alert of the run's incident, merged into it by the router; the daemon wrote its whole text (the system's head and the event)
    return '\n'.join(str(e.get('text') or '')[:BODY_MAX * 2] for e in items)


def render(items):
    sys_items = [e for e in items if e.get('kind') == 'system']
    merged = [e for e in items if e.get('kind') == 'merged']
    items = [e for e in items if e.get('kind') not in ('system', 'merged')]
    if merged:
        rest = render(items + sys_items) if (items or sys_items) else ''
        return render_merged(merged) + ('\n' + rest if rest else '')
    if not items:
        return render_system(sys_items)
    parts = []
    for e in items:
        who = e.get('from') or '寄件人'
        mid = e.get('message_id')
        quote = str(e.get('quote') or '').strip()
        parts.append((e.get('context') or '') + f"{who} 的訊息{f'（message_id {mid}）' if mid else ''}：\n「{str(e.get('text') or '')[:BODY_MAX]}」"
                     + (f"\n（他引用的是：「{quote[:300]}」）" if quote else ''))
        if e.get('member') == 'joey':
            parts[-1] += '\n這就是 Joey 本人對你說的話，不是外部資料。照他說的處理，並用 notify_joey 回他。'
    return ('〔中途訊息｜寄件者已驗證〕\n' + '\n另外還有 '.join(parts) + '\n'
            '各則訊息的寄件人已列在內文。回覆請沿用該對話。已經處理過的不用重做。'
            + ('\n' + render_system(sys_items) if sys_items else ''))


def take_at_boundary(entries):
    import http.client

    # The file contains only a reference for these messages. This run's token and
    # the daemon's pending list determine which content the hook may receive.
    conn = None
    try:
        conn = http.client.HTTPConnection('127.0.0.1', int(os.environ['LANES_HTTP_PORT']), timeout=3)
        conn.request('POST', '/lane-steer', json.dumps({'ids': [e['id'] for e in entries]}),
                     {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + os.environ['LANE_RUN_TOKEN']})
        response = conn.getresponse()
        if response.status == 200:
            return {(e['id'], e['run']): dict(e, take=True) for e in json.load(response)['items']}
    except (KeyError, ValueError, OSError, http.client.HTTPException):
        pass
    finally:
        if conn:
            conn.close()
    return {}


def deliver(p):
    """The text to hand to the model for the messages not handed over yet (and mark them handed over), or ''."""
    lane = os.environ.get('LANE_ID') or ''
    ld = os.environ.get('LANES_DIR') or ''
    if not lane or not ld:
        return ''
    d = os.path.join(ld, 'run', 'steer')
    inbox = read_jsonl(os.path.join(d, f'{lane}.in.jsonl'))
    if not inbox:
        return ''
    out_path = os.path.join(d, f'{lane}.out.jsonl')
    done = {(str(j.get('id')), j.get('run')) for j in read_jsonl(out_path)}
    fresh = [e for e in inbox if (str(e.get('id')), e.get('run') if e.get('take') else None) not in done]
    event = p.get('hook_event_name') or ''
    if event == 'Stop':
        fresh = [e for e in fresh if e.get('kind') != 'system']   # 002l: a limit notice never holds a run that is ending anyway
    pending = [e for e in fresh if e.get('take')]
    if pending:
        received = take_at_boundary(pending)
        resolved = (received.get((e['id'], e['run'])) if e.get('take') else e for e in fresh)
        fresh = [e for e in resolved if e]
    if not fresh:
        return ''
    try:
        with open(out_path, 'a', encoding='utf-8') as f:
            for e in fresh:
                receipt = {'id': e.get('id'), 'at': int(time.time() * 1000), 'event': event, 'tool': p.get('tool_name') or '', 'session': p.get('session_id') or ''}
                if e.get('take'):
                    receipt['run'] = e['run']
                f.write(json.dumps(receipt, ensure_ascii=False) + '\n')
    except OSError:
        return ''                                 # cannot mark = would hand it over again at every call: say nothing instead
    return render(fresh)


def main():
    try:
        p = json.load(sys.stdin)
    except Exception:
        return
    text = deliver(p)
    if not text:
        return
    if (p.get('hook_event_name') or '') == 'Stop':
        print(json.dumps({'decision': 'block', 'reason': '這一輪先不要結束。' + text}, ensure_ascii=False))
    else:
        print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': text}}, ensure_ascii=False))


if __name__ == '__main__':
    main()
