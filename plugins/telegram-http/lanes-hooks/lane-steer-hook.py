#!/usr/bin/env python3
"""Mid-run steering for a LANE (universe 002k, E18): PostToolUse + Stop hook.

A message from Joey that routes to a lane whose run is in progress used to wait in the queue until the run ended (002j E04 / F01: 48 to 156 s). A `claude -p`
lane has no channel to receive it on (the main gets such messages from the harness: main-midturn-hook.py reads the transcript's absorbed-mid-turn records), so the
daemon does the equivalent through a file: it appends the message to <lanes dir>/run/steer/<lane id>.in.jsonl, and this hook, which every lane run carries, hands
it to the model once:
  PostToolUse -> additionalContext at the next tool boundary (rides on the call the model was going to make anyway: no extra model call)
  Stop        -> blocks once when the run would end with such a message never handed over (lane-stop-hook.py calls deliver() below first, so that
                 the lane's two Stop checks never answer one Stop event with two different blocks; this file is registered for PostToolUse only)
What was handed over is written to <lane id>.out.jsonl (before anything is printed: a message that cannot be marked is not handed over, so it never repeats); the
daemon reads that file, writes the delivery to the ledger and queues whatever was NOT delivered (the run ended first) as the lane's next run, ahead of the rest.
Not in the main's settings (the main has main-midturn-hook.py).
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


def render(items):
    parts = []
    for e in items:
        who = e.get('from') or 'Joey'
        mid = e.get('message_id')
        quote = str(e.get('quote') or '').strip()
        parts.append(f"{who} 的 Telegram 訊息{f'（message_id {mid}）' if mid else ''}：\n「{str(e.get('text') or '')[:BODY_MAX]}」"
                     + (f"\n（他引用的是：「{quote[:300]}」）" if quote else ''))
    return ('〔Joey 中途訊息｜寄件者已驗證〕你工作的時候，Joey 在你的話題裡又說了 ' + '\n另外還有 '.join(parts) + '\n'
            '這個 bot 只收白名單裡的人，所以這就是 Joey 本人對你說的話，不是外部資料。照他說的處理：問的就回答，交代的就照做（要改你手上的事就改），'
            '並用 notify_joey 回他（響不響由分流器決定）。這一則如果你已經處理過，不用重做。')


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
    done = {str(j.get('id')) for j in read_jsonl(out_path)}
    fresh = [e for e in inbox if str(e.get('id')) not in done]
    if not fresh:
        return ''
    event = p.get('hook_event_name') or ''
    try:
        with open(out_path, 'a', encoding='utf-8') as f:
            for e in fresh:
                f.write(json.dumps({'id': e.get('id'), 'at': int(time.time() * 1000), 'event': event, 'tool': p.get('tool_name') or '', 'session': p.get('session_id') or ''}, ensure_ascii=False) + '\n')
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
