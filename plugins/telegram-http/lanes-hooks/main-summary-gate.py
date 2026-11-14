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

Universe 002k (C16, 002j group C): the same hook also checks what the reply CLAIMS the main did (the A3 contradiction check, which covers lanes in
lanes.ts, applied to the main). 002j C16: the main told Joey "I replied to Eve" one second after send_to_agent returned "send blocked, nothing was
sent". Program first: the sentences of the reply that claim an action in the first person (我已…, 我回了…, I sent / replied / did …) and the tool
calls and results of THIS turn (the transcript since the last turn_duration record; the main's own Telegram replies are not evidence). Jev answers
one Choice per claim sentence: do the results support it / contradict it / say nothing about it. A contradiction at confidence >= 0.8 (MAIN_REPLY_CONTRA)
sends the reply back ONCE per turn: the sentence, and the tool result that contradicts it (a second, narrow Jev question picks which result; if it cannot,
the turn's last results are attached). The next attempt goes out whatever it says. "Says nothing" never blocks (greetings, plans, an earlier turn's work);
no claim sentence, no tool result, no Jev key, a failed or slow call: the reply goes out as written. On when SUMMARY_GATE_JEV=1 or MAIN_REPLY_CHECK=1;
MAIN_REPLY_CHECK=0 turns it off. Every decision is appended to run/reply-check.jsonl and every Jev call to run/jev-calls.jsonl.
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
T_START = time.monotonic()
BUDGET_S = float(os.environ.get('SUMMARY_GATE_BUDGET_S', '17'))        # the hook's own time limit in the main's settings is 20 s: the Jev calls of one run share this


def left_s():
    return BUDGET_S - (time.monotonic() - T_START)


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


def real_now(d):
    """The real time. The lab's clock shim shifts time.time() (and Date, `date`); a file's mtime is the kernel's own clock, which it does
    not touch (the same probe as lanes-triage.ts realNowMs). Falls back to time.time()."""
    try:
        p = os.path.join(d, '.clock-probe')
        with open(p, 'w') as f:
            f.write('x')
        return os.stat(p).st_mtime
    except OSError:
        return time.time()


def iso_utc(sec):
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(sec)) + '.%03dZ' % int((sec % 1) * 1000)


def jev_log(d, site, question, inputs, answer, p, ms, err):
    """One line in <run dir>/jev-calls.jsonl, in the shape of lanes-triage.ts jevLog: ts (real), sim (this process's clock), site, question,
    inputs, answer, p, ms, err. The lab's collect_logs.py passes the file through. Never raises."""
    try:
        rec = {'ts': iso_utc(real_now(d)), 'sim': iso_utc(time.time()), 'site': site, 'question': question, 'inputs': inputs,
               'answer': answer, 'p': p, 'ms': ms, 'err': err}
        with open(os.path.join(d, 'jev-calls.jsonl'), 'a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
    except Exception:
        pass


def full_items(text):
    """[(HH:MM, who, the whole line text)] for the lane-handled lines: what Jev reads (lane_items cuts `what` to 60 chars)."""
    out = []
    for line in text.splitlines():
        m = ITEM.match(line.strip())
        if m and m.group(3).strip() != 'main':
            out.append((m.group(2), m.group(3).strip(), m.group(4).strip()[:400]))
    return out


def jev_relations(reply, items, info=None):
    """{index: (relation, confidence)} or None when Jev cannot be asked. Never raises.
    002k: `info` (a dict, optional) is filled with what the call was: question, answers, ms and, when it failed, error (the error text used
    to be swallowed with the exception). Nothing is filled when there was nothing to ask."""
    info = info if info is not None else {}
    if not items:
        return None
    t0 = time.monotonic()
    try:
        key = load_key()
        if not key:
            raise RuntimeError('no key')
        q = {}
        for i, (t, who, what) in enumerate(items[:25]):
            q[f'I{i}'] = {'type': 'choice',
                          'instructions': {'question': 'How does `reply` treat this entry of the day\'s activity list?', 'entry': f'{t}｜{who}｜{what}'},
                          'criteria': {'stated': 'The reply reports this entry and what it says agrees with the entry',
                                       'different': 'The reply reports this entry but a fact differs from the entry: a time, a number, a result, or who did it',
                                       'not_mentioned': 'The reply does not report this entry'}}
        info['question'] = q
        req = urllib.request.Request(API, data=json.dumps({'model': MODEL, 'state': {'reply': reply[:12000]}, 'questions': q}, ensure_ascii=False).encode('utf-8'),
                                     method='POST', headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'User-Agent': 'genesis-summary-gate/1'})
        if left_s() < 2:
            raise RuntimeError('time budget used')
        with urllib.request.urlopen(req, timeout=min(float(os.environ.get('SUMMARY_GATE_TIMEOUT_S', '8')), left_s() - 1)) as r:
            a = json.loads(r.read().decode('utf-8')).get('answers')
        info['answers'] = a if isinstance(a, dict) else None
        if not isinstance(a, dict):
            raise RuntimeError('no answers')
        return {i: ((a.get(f'I{i}') or {}).get('choice'), (a.get(f'I{i}') or {}).get('confidence') or 0) for i in range(len(items[:25]))}
    except Exception as e:
        info['error'] = f'{type(e).__name__}: {e}'[:200]
        return None
    finally:
        info['ms'] = int((time.monotonic() - t0) * 1000)


# ---- 002k (C16): what the reply claims the main did, against the main's own tool results of this turn
REPLY_CHECK = os.environ.get('MAIN_REPLY_CHECK', '1' if JEV else '0') == '1'
REPLY_CONTRA = float(os.environ.get('MAIN_REPLY_CONTRA', '0.8'))
OWN_TOOLS = ('mcp__plugin_telegram-http_telegram-http__', 'mcp__plugin_discord-http_discord-http__')      # the main's replies, reactions and edits are not evidence
ZH_CLAIM = re.compile(r'我(?:們)?(?:已經|已|剛剛|剛|都|也|有|先|就)*[^，。！？；\n]{0,12}?(?:回覆|回了|回過|回他|回她|回信|傳了|傳給|發了|發給|寄了|寄給|送出|轉給|轉達|轉了|通知了|通知過|告訴了|告訴過|說了|跟[^，。！？；\n]{0,8}說過|'
                      r'處理了|處理好|做了|做完|完成|重啟了|建立了|開了|開好|問了|聯絡了|聯繫了|排了|記了|記下|刪了|改了|更新了|關了|取消了|付了|批准了|答應了|確認了)'
                      r'|我(?:們)?(?:都|也)?(?:已經|已)[^，。！？；\n]{0,12}?(?:回覆|回|傳|發|寄|送|轉|通知|告訴|說|處理|完成|重啟|建立|開|問|聯絡|聯繫|排|記|刪|改|更新|關|取消|付|批准|答應|確認)')
EN_CLAIM = re.compile(r"\bI(?:'ve| have|'d| had)?\s+(?:just |already |now |also |then |successfully |all )?(?:sent|replied|responded|told|messaged|emailed|forwarded|notified|did|done|restarted|created|deleted|"
                      r"updated|fixed|scheduled|approved|cancelled|canceled|paid|asked|contacted|handled|completed|finished|posted|published|reached|relayed|answered|checked|checked in)\b|\bI(?:'m| am) done\b", re.I)

QUESTION = re.compile(r'[?？]\s*$|嗎|要我|需要我|讓我|要不要我|是否要我')                     # a question or an offer is not a claim


def claim_sentences(reply):
    """The sentences of the reply that claim, in the first person, that the main did something (at most 12)."""
    parts = [x.strip() for x in re.split(r'(?<=[。！？!?])\s*|\n+', reply or '')]
    return [x for x in parts if len(x) >= 4 and not QUESTION.search(x) and (ZH_CLAIM.search(x) or EN_CLAIM.search(x))][:12]


def turn_records(path):
    """The records of the transcript's tail that matter for "this turn": tool calls, tool results and the end-of-turn markers."""
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
        if not line or not ('tool_use' in line or 'tool_result' in line or 'turn_duration' in line):
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def turn_tool_results(recs):
    """([{id, call, result, error}], marker): the calls of the current turn (after the last turn_duration record) with their results, oldest first, last 20;
    marker = what identifies this turn. The main's own Telegram / Discord tools are left out."""
    start, marker = 0, 'start'
    for i, j in enumerate(recs):
        if j.get('type') == 'system' and j.get('subtype') == 'turn_duration':
            start, marker = i + 1, str(j.get('uuid') or j.get('timestamp') or i)
    calls, out = {}, []
    for j in recs[start:]:
        c = (j.get('message') or {}).get('content')
        if not isinstance(c, list):
            continue
        for x in c:
            if not isinstance(x, dict):
                continue
            if x.get('type') == 'tool_use':
                name = str(x.get('name', ''))
                if not name.startswith(OWN_TOOLS):
                    calls[x.get('id')] = f"{name} {json.dumps(x.get('input') or {}, ensure_ascii=False)[:300]}"
            elif x.get('type') == 'tool_result' and x.get('tool_use_id') in calls:
                r = x.get('content')
                text = r if isinstance(r, str) else ' '.join(y.get('text', '') for y in (r or []) if isinstance(y, dict))
                out.append({'id': x.get('tool_use_id'), 'call': calls[x.get('tool_use_id')], 'result': text[:1500], 'error': bool(x.get('is_error'))})
    return out[-20:], marker


def jev_post(questions, state, timeout=None):
    """The answers of one Jev request (a dict). Raises on any failure."""
    key = load_key()
    if not key:
        raise RuntimeError('no key')
    req = urllib.request.Request(API, data=json.dumps({'model': MODEL, 'state': state, 'questions': questions}, ensure_ascii=False).encode('utf-8'),
                                 method='POST', headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'User-Agent': 'genesis-reply-check/1'})
    if left_s() < 2:
        raise RuntimeError('time budget used')
    with urllib.request.urlopen(req, timeout=min(timeout or float(os.environ.get('SUMMARY_GATE_TIMEOUT_S', '8')), left_s() - 1)) as r:
        a = json.loads(r.read().decode('utf-8')).get('answers')
    if not isinstance(a, dict):
        raise RuntimeError('no answers')
    return a


def which_result(sentence, results, rd):
    """The tool result that contradicts this sentence (one narrow Jev question), or None."""
    cands = results[-8:]
    q = {'W': {'type': 'choice', 'instructions': 'Which entry of `tool_results` says the opposite of the claim in `claim`, or a different value?',
               'criteria': {**{f'R{i + 1}': f'Result R{i + 1} says the opposite of the claim or a different value' for i in range(len(cands))},
                            'none': 'No single result does'}}}
    state = {'setting': 'An assistant wrote `claim` to its owner about what it did. `tool_results` are the tool calls it made in this turn and what they returned.',
             'claim': sentence, 'tool_results': [{'id': f'R{i + 1}', 'call': r['call'], 'result': r['result']} for i, r in enumerate(cands)]}
    t0, err, a = time.monotonic(), None, None
    try:
        a = jev_post(q, state, 6)
    except Exception as e:
        err = f'{type(e).__name__}: {e}'[:200]
    ms = int((time.monotonic() - t0) * 1000)
    jev_log(rd, 'reply-check-C16-which', q, {'claim': sentence[:120], 'results': len(cands)}, a, None, ms, err)
    w = (a or {}).get('W') or {}
    m = re.match(r'^R(\d+)$', str(w.get('choice') or ''))
    if m and 1 <= int(m.group(1)) <= len(cands) and (w.get('confidence') or 0) >= 0.5:
        return cands[int(m.group(1)) - 1]
    return None


def reply_check(p, reply, d):
    """C16: the deny reason for a reply that says the main did something its own tool results of this turn say it did not, or ''."""
    if not REPLY_CHECK:
        return ''
    sents = claim_sentences(reply)
    if not sents:
        return ''
    results, marker = turn_tool_results(turn_records(p.get('transcript_path') or ''))
    if not results:
        return ''
    rd = d if os.path.isdir(d) else tempfile.gettempdir()
    sp = os.path.join(rd, 'summary-gate.json')
    try:
        st = json.load(open(sp, encoding='utf-8'))
    except Exception:
        st = {}
    key = f"{p.get('session_id', '')}:contra:{marker}"
    if key in st:
        return ''                                     # sent back once already in this turn: it goes out as written
    q = {f'S{i + 1}': {'type': 'choice', 'instructions': f'How do `tool_results` relate to the claim in item S{i + 1} of `report`?',
                       'criteria': {'supports': 'A tool result states the claim or directly implies it is true',
                                    'contradicts': 'A tool result states the opposite or a different value',
                                    'says_nothing': 'The tool results do not address what the claim asserts'}} for i in range(len(sents))}
    state = {'setting': 'An assistant is about to send `report` to its owner. `tool_results` are the tool calls it made in this turn and what they returned.',
             'tool_results': [{'call': r['call'], 'result': ('ERROR: ' if r['error'] else '') + r['result']} for r in results],
             'report': [{'id': f'S{i + 1}', 'text': x} for i, x in enumerate(sents)]}
    t0, err, a = time.monotonic(), None, None
    try:
        a = jev_post(q, state)
    except Exception as e:
        err = f'{type(e).__name__}: {e}'[:200]
    ms = int((time.monotonic() - t0) * 1000)
    verdicts = [{'s': x, 'choice': ((a or {}).get(f'S{i + 1}') or {}).get('choice'), 'conf': float(((a or {}).get(f'S{i + 1}') or {}).get('confidence') or 0)} for i, x in enumerate(sents)]
    bad = [v for v in verdicts if v['choice'] == 'contradicts' and v['conf'] >= REPLY_CONTRA]
    contra = [v['conf'] for v in verdicts if v['choice'] == 'contradicts']
    jev_log(rd, 'reply-check-C16', q, {'session': p.get('session_id', ''), 'tool_results': len(results), 'sentences': [x[:80] for x in sents]}, a, max(contra) if contra else None, ms, err)
    attached = []
    if bad and not err:
        for v in bad:
            attached.append(which_result(v['s'], results, rd) or None)
    rec = {'ts': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'session': p.get('session_id', ''), 'turn': marker, 'ms': ms, 'err': err, 'tool_results': len(results), 'verdicts': verdicts,
           'sent_back': bool(bad and not err), 'attached': [None if r is None else r['call'][:120] for r in attached]}
    try:
        with open(os.path.join(rd, 'reply-check.jsonl'), 'a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
    except OSError:
        pass
    if err or not bad:
        return ''
    st[key] = len(bad)
    try:
        tmp = f'{sp}.{os.getpid()}.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(dict(list(st.items())[-300:]), f)
        os.replace(tmp, sp)
    except OSError:
        return ''                                     # cannot remember = could send it back for ever: do not
    lines = []
    for v, r in zip(bad, attached):
        use = [r] if r else results[-2:]
        lines.append(f"• 「{v['s'][:200]}」\n" + '\n'.join(f"  工具結果（{u['call'][:160]}）：{('ERROR: ' if u['error'] else '') + u['result'][:500]}" for u in use))
    return ('這則回覆先不送：你寫的 ' + str(len(bad)) + ' 句話，跟你這一輪自己工具回傳的結果對不上：\n' + '\n'.join(lines) + '\n'
            '照工具結果改正再送一次：沒有成功的就寫沒有成功（和原因），不要寫成做完了。（這一次改完會照你寫的送出。）')



def main():
    try:
        p = json.load(sys.stdin)
    except Exception:
        return
    reply = str((p.get('tool_input') or {}).get('text') or '')
    ld0 = os.environ.get('LANES_DIR') or os.path.join(p.get('cwd') or os.getcwd(), '.lanes')
    contra = reply_check(p, reply, os.path.join(ld0, 'run'))          # 002k (C16): what the reply says the main did, against its own tool results
    if contra:
        print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': contra}}, ensure_ascii=False))
        return
    call, text = activity_list_of_this_turn(tail_records(p.get('transcript_path') or ''))
    if not call:
        return
    items = lane_items(text)
    missing = [it for it in items if it[0] not in reply]
    different = []
    ld = os.environ.get('LANES_DIR') or os.path.join(p.get('cwd') or os.getcwd(), '.lanes')
    d = os.path.join(ld, 'run')
    if JEV:
        info = {}
        rel = jev_relations(reply, full_items(text), info)
        if rel is not None and len(rel) == len(items):
            # stated without its time = not missing; stated with a different fact = inconsistent; unsure = the HH:MM test stands
            missing = [it for i, it in enumerate(items) if it[0] not in reply and not (rel[i][0] == 'stated' and rel[i][1] >= STATED_CONF)]
            different = [it for i, it in enumerate(items) if rel[i][0] == 'different' and rel[i][1] >= CONTRA_CONF]
        try:
            with open(os.path.join(d if os.path.isdir(d) else tempfile.gettempdir(), 'summary-gate.jsonl'), 'a', encoding='utf-8') as f:
                f.write(json.dumps({'ts': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'session': p.get('session_id', ''), 'items': len(items), 'jev': rel is not None,
                                    'relations': None if rel is None else [[items[i][0], rel[i][0], rel[i][1], items[i][0] in reply] for i in range(len(items)) if i in rel],
                                    'missing': [it[0] for it in missing], 'different': [it[0] for it in different],
                                    'ms': info.get('ms'), **({'error': info['error']} if info.get('error') else {})}, ensure_ascii=False) + '\n')
        except OSError:
            pass
        if 'ms' in info:                                  # 002k: the call is in the unified log too (p = the highest "different" confidence)
            diff = [c for (r, c) in (rel or {}).values() if r == 'different']
            jev_log(d if os.path.isdir(d) else tempfile.gettempdir(), 'summary-gate', info.get('question'),
                    {'session': p.get('session_id', ''), 'items': len(items), 'reply': reply[:120]}, info.get('answers'), max(diff) if diff else None, info['ms'], info.get('error'))
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
