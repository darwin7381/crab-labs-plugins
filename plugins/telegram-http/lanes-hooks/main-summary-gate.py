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

Universe 002j (SUMMARY_GATE_JEV=1 in the hook's environment): the HH:MM test stays as the program's first pass, and Jev
reads each lane-handled line against the reply: the reply states it and agrees / states it with a different fact (a time,
a number, a result, who did it) / does not mention it. One request, one Choice per line; the line travels in the question
and the reply is the state, so the lines cannot disturb one another. Then, in code:
  - a line whose HH:MM is absent is still accepted when Jev says the reply states it (a summary may describe an event
    without quoting its time);
  - a line the reply states with a different fact is named as inconsistent (the HH:MM test could never see that);
  - anything Jev is unsure about, and any failed call, falls back to the HH:MM test alone.
Every decision is appended to run/summary-gate.jsonl.
"""
import json
import os
import re
import sys
import tempfile
import time
import urllib.request

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


JEV = os.environ.get('SUMMARY_GATE_JEV') == '1'
MODEL = os.environ.get('TYPESAFE_DEFAULT_MODEL', 'jev-1.14.0')
API = os.environ.get('TYPESAFE_BASE_URL', 'https://api.typesafe.ai').rstrip('/') + '/v1/systemone'
KEY_FILE = os.environ.get('TYPESAFE_KEY_FILE', os.path.expanduser('~/.genesis/typesafe.env'))
STATED_CONF, CONTRA_CONF = 0.7, 0.8


def load_key():
    k = os.environ.get('TYPESAFE_API_KEY', '').strip()
    if k:
        return k
    try:
        for line in open(KEY_FILE, encoding='utf-8'):
            line = line.strip()
            if line.startswith('export '):
                line = line[7:].strip()
            if line.startswith('TYPESAFE_API_KEY='):
                return line.split('=', 1)[1].strip().strip('"').strip("'") or None
    except OSError:
        pass
    return None


def full_items(text):
    """[(HH:MM, who, the whole line text)] for the lane-handled lines: what Jev reads (lane_items cuts `what` to 60 chars)."""
    out = []
    for line in text.splitlines():
        m = ITEM.match(line.strip())
        if m and m.group(3).strip() != 'main':
            out.append((m.group(2), m.group(3).strip(), m.group(4).strip()[:400]))
    return out


def jev_relations(reply, items):
    """{index: (relation, confidence)} or None when Jev cannot be asked. Never raises."""
    try:
        key = load_key()
        if not key or not items:
            return None
        q = {}
        for i, (t, who, what) in enumerate(items[:25]):
            q[f'I{i}'] = {'type': 'choice',
                          'instructions': {'question': 'How does `reply` treat this entry of the day\'s activity list?', 'entry': f'{t}｜{who}｜{what}'},
                          'criteria': {'stated': 'The reply reports this entry and what it says agrees with the entry',
                                       'different': 'The reply reports this entry but a fact differs from the entry: a time, a number, a result, or who did it',
                                       'not_mentioned': 'The reply does not report this entry'}}
        req = urllib.request.Request(API, data=json.dumps({'model': MODEL, 'state': {'reply': reply[:12000]}, 'questions': q}, ensure_ascii=False).encode('utf-8'),
                                     method='POST', headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'User-Agent': 'genesis-summary-gate/1'})
        with urllib.request.urlopen(req, timeout=float(os.environ.get('SUMMARY_GATE_TIMEOUT_S', '8'))) as r:
            a = json.loads(r.read().decode('utf-8')).get('answers')
        if not isinstance(a, dict):
            return None
        return {i: ((a.get(f'I{i}') or {}).get('choice'), (a.get(f'I{i}') or {}).get('confidence') or 0) for i in range(len(items[:25]))}
    except Exception:
        return None


def main():
    try:
        p = json.load(sys.stdin)
    except Exception:
        return
    reply = str((p.get('tool_input') or {}).get('text') or '')
    call, text = activity_list_of_this_turn(tail_records(p.get('transcript_path') or ''))
    if not call:
        return
    items = lane_items(text)
    missing = [it for it in items if it[0] not in reply]
    different = []
    ld = os.environ.get('LANES_DIR') or os.path.join(p.get('cwd') or os.getcwd(), '.lanes')
    d = os.path.join(ld, 'run')
    if JEV:
        rel = jev_relations(reply, full_items(text))
        if rel is not None and len(rel) == len(items):
            # stated without its time = not missing; stated with a different fact = inconsistent; unsure = the HH:MM test stands
            missing = [it for i, it in enumerate(items) if it[0] not in reply and not (rel[i][0] == 'stated' and rel[i][1] >= STATED_CONF)]
            different = [it for i, it in enumerate(items) if rel[i][0] == 'different' and rel[i][1] >= CONTRA_CONF]
        try:
            with open(os.path.join(d if os.path.isdir(d) else tempfile.gettempdir(), 'summary-gate.jsonl'), 'a', encoding='utf-8') as f:
                f.write(json.dumps({'ts': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'session': p.get('session_id', ''), 'items': len(items), 'jev': rel is not None,
                                    'relations': None if rel is None else [[items[i][0], rel[i][0], rel[i][1], items[i][0] in reply] for i in range(len(items)) if i in rel],
                                    'missing': [it[0] for it in missing], 'different': [it[0] for it in different]}, ensure_ascii=False) + '\n')
        except OSError:
            pass
    if not missing and not different:
        return
    sp = os.path.join(d if os.path.isdir(d) else tempfile.gettempdir(), 'summary-gate.json')
    try:
        st = json.load(open(sp, encoding='utf-8'))
    except Exception:
        st = {}
    key = f"{p.get('session_id', '')}:{call}"
    if key in st:
        return                                        # refused once already for this list: let it through
    st[key] = len(missing) + len(different)
    try:
        tmp = f'{sp}.{os.getpid()}.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(dict(list(st.items())[-300:]), f)
        os.replace(tmp, sp)
    except OSError:
        return                                        # cannot remember = could refuse for ever: do not refuse
    lines = '\n'.join(f'• {t}｜{who}｜{what}' for t, who, what in missing)
    reason = '這則整理先不送：'
    if missing:
        reason += f'活動清單裡有 {len(missing)} 件沒有出現在你的整理裡：\n{lines}\n'
    if different:
        reason += (f'有 {len(different)} 件你寫的跟清單不一致（時間、數字、結果或是誰做的），請對照清單改正：\n'
                   + '\n'.join(f'• {t}｜{who}｜{what}' for t, who, what in different) + '\n')
    reason += ('清單上每一件都要寫到：時間、發生什麼、結果（數字照清單寫）。補上後再送一次。'
              '如果 Joey 這次只問其中一部分，就在訊息裡寫明只回答哪一部分，再送一次即可。')
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny',
                                             'permissionDecisionReason': reason}}, ensure_ascii=False))


if __name__ == '__main__':
    main()
