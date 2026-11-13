#!/usr/bin/env python3
"""Summary gate of the MAIN (universe 002h): PreToolUse hook on the Telegram reply tool.

The main does not handle most events itself any more: lanes do, and the main learns of them from the
activity list (ledger_query() with no argument: one line per event of the day). When Joey asks for
"what happened today", the answer is only as complete as the main's rewrite of that list, and a
weaker model drops lines when it condenses (T1-R row 6: 5, 9, 7 and 6 of 10 facts over four
universes, with the complete list in the model's hands every time).

This hook does not ask the model to be more careful. When the main took the full activity list in
this turn and now sends a reply, the hook checks that every lane-handled line of the list appears
in the reply (recognised by its HH:MM). If lines are missing, the reply is refused ONCE and the
missing lines are named; the next reply passes whatever it says (so a partial answer on purpose is
possible, and nothing can loop).
State: <lanes dir>/run/summary-gate.json. Only in the main's settings; lanes never run it.
"""
import json
import os
import re
import sys
import tempfile

TAIL_BYTES = 3_000_000
ITEM = re.compile(r'^• (\d\d-\d\d) (\d\d:\d\d)｜([^｜]+)｜(.*)$')


def tail_records(path):
    try:
        size = os.path.getsize(path)
        with open(path, 'rb') as f:
            if size > TAIL_BYTES:
                f.seek(size - TAIL_BYTES)
                f.readline()
            data = f.read().decode('utf-8', errors='replace')
    except OSError:
        return []
    out = []
    for line in data.splitlines():
        if not line or not ('ledger_query' in line or 'tool_result' in line or 'turn_duration' in line):
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def activity_list_of_this_turn(recs):
    """(tool_use id, list text) of the last no-argument ledger_query in the current turn, or (None, None)."""
    start = 0
    for i, j in enumerate(recs):                      # the current turn starts after the last end-of-turn record
        if j.get('type') == 'system' and j.get('subtype') == 'turn_duration':
            start = i + 1
    call = None
    results = {}
    for j in recs[start:]:
        c = (j.get('message') or {}).get('content')
        if not isinstance(c, list):
            continue
        for x in c:
            if not isinstance(x, dict):
                continue
            if x.get('type') == 'tool_use' and str(x.get('name', '')).endswith('ledger_query'):
                inp = x.get('input') or {}
                if not any(str(v or '').strip() for v in inp.values()):
                    call = x.get('id')
            elif x.get('type') == 'tool_result':
                r = x.get('content')
                text = r if isinstance(r, str) else ''.join(y.get('text', '') for y in (r or []) if isinstance(y, dict))
                results[x.get('tool_use_id')] = text
    text = results.get(call) if call else None
    if not text or not text.lstrip().startswith('活動清單'):
        return None, None
    return call, text


def lane_items(text):
    """[(HH:MM, who, what)] for the lines of the list that a lane or the router handled (the main knows its own)."""
    out = []
    for line in text.splitlines():
        m = ITEM.match(line.strip())
        if not m or m.group(3).strip() == 'main':
            continue
        what = m.group(4)
        what = what.split('發生：', 1)[1] if '發生：' in what else what
        out.append((m.group(2), m.group(3).strip(), what.split('｜')[0].strip()[:60]))
    return out


def main():
    try:
        p = json.load(sys.stdin)
    except Exception:
        return
    reply = str((p.get('tool_input') or {}).get('text') or '')
    call, text = activity_list_of_this_turn(tail_records(p.get('transcript_path') or ''))
    if not call:
        return
    missing = [it for it in lane_items(text) if it[0] not in reply]
    if not missing:
        return
    ld = os.environ.get('LANES_DIR') or os.path.join(p.get('cwd') or os.getcwd(), '.lanes')
    d = os.path.join(ld, 'run')
    sp = os.path.join(d if os.path.isdir(d) else tempfile.gettempdir(), 'summary-gate.json')
    try:
        st = json.load(open(sp, encoding='utf-8'))
    except Exception:
        st = {}
    key = f"{p.get('session_id', '')}:{call}"
    if key in st:
        return                                        # refused once already for this list: let it through
    st[key] = len(missing)
    try:
        tmp = f'{sp}.{os.getpid()}.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(dict(list(st.items())[-300:]), f)
        os.replace(tmp, sp)
    except OSError:
        return                                        # cannot remember = could refuse for ever: do not refuse
    lines = '\n'.join(f'• {t}｜{who}｜{what}' for t, who, what in missing)
    reason = (f'這則整理先不送：活動清單裡有 {len(missing)} 件沒有出現在你的整理裡（以時間辨認）：\n{lines}\n'
              '清單上每一件都要寫到：時間、發生什麼、結果（數字照清單寫）。補上後再送一次。'
              '如果 Joey 這次只問其中一部分，就在訊息裡寫明只回答哪一部分，再送一次即可。')
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny',
                                             'permissionDecisionReason': reason}}, ensure_ascii=False))


if __name__ == '__main__':
    main()
