#!/usr/bin/env python3
"""End-of-turn check of the MAIN (universe 002j): every message taken in during this turn is answered or deferred.

Problem (problems list, item 9): a message that arrives while the main is working is absorbed into the running turn. A model
may fold it into the task at hand and end the turn without ever answering it (seen live on 2026-11-14 with Haiku, with no
fault injected). main-midturn-hook.py hands such a message back once; this hook checks the OUTCOME when the turn is about to end.

Program first, Jev for the narrow remainder (site: /genesis/jev-design, rule 1). From the session's own transcript the hook
establishes, in code:
  - the turn: everything after the last end-of-turn record;
  - the messages taken in during it: the prompt that started it and every message absorbed mid-turn, with their ids;
  - the outputs: the reply / send_to_agent tool calls of the turn, with their reply_to ids.
A turn that took in one message is not checked. A message that an output replies to BY ID is answered: no question is asked.
For the others Jev is asked three narrow questions per message, all in one request: does it need a reply; does any output
address it; does any output say it will be handled later. A message that needs a reply and has neither is listed back to
the model, once per message; after that the turn ends normally, whatever the model does.

Jev can only make the turn continue once. It releases nothing and decides nothing else. Any failure (no key, HTTP error, an
HTML 403, a timeout, a malformed answer) = the hook says nothing and the turn ends as it would have.

ANSWERED_GATE_MODE=shadow records what it would have done (run/answered-gate.jsonl) and never blocks. Default: enforce.
"""
import json
import os
import re
import sys
import tempfile
import time
import urllib.request

TAIL_BYTES = 3_000_000
BODY_MAX, OUT_MAX = 1500, 2000
YES, NO = 0.7, 0.35                      # starting points (official cookbooks); calibrate on run/answered-gate.jsonl
MODEL = os.environ.get('TYPESAFE_DEFAULT_MODEL', 'jev-1.14.0')
API = os.environ.get('TYPESAFE_BASE_URL', 'https://api.typesafe.ai').rstrip('/') + '/v1/systemone'
KEY_FILE = os.environ.get('TYPESAFE_KEY_FILE', os.path.expanduser('~/.genesis/typesafe.env'))
TIMEOUT_S = float(os.environ.get('ANSWERED_GATE_TIMEOUT_S', '6'))
CH = re.compile(r'<channel ([^>]*)>\n?(.*?)\n?</channel>', re.S)
ATTR = re.compile(r'(\w+)="([^"]*)"')
REPLY_TOOLS = ('__reply', '__send_to_agent')


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


def tail(path):
    try:
        size = os.path.getsize(path)
        with open(path, 'rb') as f:
            if size > TAIL_BYTES:
                f.seek(size - TAIL_BYTES)
                f.readline()
            return f.read().decode('utf-8', errors='replace')
    except OSError:
        return ''


def channel_messages(text):
    out = []
    for m in CH.finditer(text or ''):
        a = dict(ATTR.findall(m.group(1)))
        mid = a.get('message_id') or a.get('btcc_msg_id') or a.get('did')
        if not mid:
            continue
        out.append({'mid': mid, 'kind': 'tg' if a.get('message_id') else 'mesh' if a.get('btcc_msg_id') else 'sys',
                    'user': a.get('user', ''), 'no_reply': a.get('no_reply') == 'true', 'system': a.get('user') == 'lanes' or bool(a.get('kind')),
                    'body': m.group(2).strip()})
    return out


def turn(path):
    """-> (messages taken in during the current turn, outputs of the turn), both in transcript order."""
    msgs, outs, seen = [], [], set()
    for line in tail(path).splitlines():
        if not line:
            continue
        try:
            j = json.loads(line)
        except ValueError:
            continue
        t = j.get('type')
        if t == 'system' and j.get('subtype') in ('turn_duration', 'stop_hook_summary'):
            msgs, outs, seen = [], [], set()            # a turn ended here: what follows is the next turn
            continue
        found = []
        if t == 'user' and isinstance((j.get('message') or {}).get('content'), str):
            found = channel_messages(j['message']['content'])
        elif t == 'queue-operation' and j.get('operation') == 'remove' and j.get('reason') == 'absorbed_mid_turn':
            found = channel_messages(str(j.get('content') or ''))
            for f in found:
                f['absorbed'] = True
        for f in found:
            if f['mid'] not in seen:
                seen.add(f['mid']); msgs.append(f)
        if t == 'assistant':
            for c in (j.get('message') or {}).get('content') or []:
                if isinstance(c, dict) and c.get('type') == 'tool_use' and str(c.get('name', '')).endswith(REPLY_TOOLS):
                    i = c.get('input') or {}
                    if i.get('text'):
                        outs.append({'to': str(i.get('to') or ('Joey' if str(c.get('name')).endswith('__reply') else '')),
                                     'reply_to': str(i.get('reply_to') or ''), 'text': str(i['text'])})
    return msgs, outs


CALL = {}                                          # 002k: what the last Jev call was (question, answers, ms, error), for the logs


def ask(state, questions):
    t0 = time.monotonic()
    CALL.clear()
    CALL['question'] = questions
    try:
        key = load_key()
        if not key:
            raise RuntimeError('no key')
        req = urllib.request.Request(API, data=json.dumps({'model': MODEL, 'state': state, 'questions': questions}, ensure_ascii=False).encode('utf-8'),
                                     method='POST', headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json',
                                                             'User-Agent': 'genesis-answered-gate/1'})
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
            body = r.read().decode('utf-8')
        a = json.loads(body).get('answers')            # an HTML page (blocked request) fails here: treated as a failure
        CALL['answers'] = a if isinstance(a, dict) else None
        if not isinstance(a, dict):
            raise RuntimeError('no answers')
        return a
    except Exception as e:
        CALL['error'] = f'{type(e).__name__}: {e}'[:200]
        raise
    finally:
        CALL['ms'] = int((time.monotonic() - t0) * 1000)


def lanes_run_dir(payload):
    ld = os.environ.get('LANES_DIR') or os.path.join(payload.get('cwd') or os.getcwd(), '.lanes')
    d = os.path.join(ld, 'run')
    return d if os.path.isdir(d) else tempfile.gettempdir()


def record(d, rec):
    try:
        with open(os.path.join(d, 'answered-gate.jsonl'), 'a', encoding='utf-8') as f:
            f.write(json.dumps({'ts': time.strftime('%Y-%m-%dT%H:%M:%S%z'), **rec}, ensure_ascii=False) + '\n')
    except OSError:
        pass


def judge(msgs, outs):
    """-> (verdict per message id, raw answers). Code decides; Jev only supplies probabilities for what code cannot tell."""
    verdict, pending = {}, []
    for m in msgs:
        if m['no_reply'] or m['system']:
            verdict[m['mid']] = 'no_reply_needed (marked)'
        elif any(o['reply_to'] == m['mid'] for o in outs):
            verdict[m['mid']] = 'answered (by id)'
        else:
            pending.append(m)
    if not pending:
        return verdict, None
    M = [{'id': f'M{i}', 'from': m['user'], 'text': m['body'][:BODY_MAX]} for i, m in enumerate(pending, 1)]
    O = [{'id': f'O{i}', 'to': o['to'], 'text': o['text'][:OUT_MAX]} for i, o in enumerate(outs[-20:], 1)]
    q = {}
    for x in M:
        i = x['id']
        q[f'{i}.reply_needed'] = {'type': 'noul', 'instructions': f'Does the item of `messages` with id {i} ask a question or ask for something, so that its sender needs an answer back?',
                                  'criteria': {'true': 'The sender asks something or requests something and is waiting for the result',
                                               'false': 'The sender only informs, or says no reply is needed'}}
        q[f'{i}.answered'] = {'type': 'noul', 'instructions': f'Does any item of `outputs` address or answer the item of `messages` with id {i}?',
                              'criteria': {'true': 'At least one output states or directly implies the answer, or reports doing what it asks',
                                           'false': 'No output deals with what it asks'}}
        q[f'{i}.deferred'] = {'type': 'noul', 'instructions': f'Does any item of `outputs` tell the sender of the item of `messages` with id {i} that it will be handled later, or name who will handle it?'}
    a = ask({'setting': 'An agent took in `messages` during one turn of work. `outputs` are the messages it sent during that turn, in order.',
             'messages': M, 'outputs': O or '(none)'}, q)
    for x, m in zip(M, pending):
        p = {k: (a.get(f"{x['id']}.{k}") or {}).get('noul') for k in ('reply_needed', 'answered', 'deferred')}
        if None in p.values():
            verdict[m['mid']] = 'unjudged'
        elif p['reply_needed'] >= YES and p['answered'] <= NO and p['deferred'] <= NO:
            verdict[m['mid']] = 'not_addressed'
        elif p['answered'] >= YES:
            verdict[m['mid']] = 'answered'
        elif p['deferred'] >= YES:
            verdict[m['mid']] = 'deferred'
        elif p['reply_needed'] <= NO:
            verdict[m['mid']] = 'no_reply_needed'
        else:
            verdict[m['mid']] = 'unsure'
        m['p'] = p
    return verdict, a


def memory_gate_reason(payload):
    """main-memory-gate.py sits beside this file; it is called from here because this is the Stop hook the lab wires for the main.
    Never raises: a missing or broken gate must not affect the answered check."""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location('main_memory_gate', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'main-memory-gate.py'))
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        return m.reason(payload)
    except Exception:
        return None


def main():
    try:
        p = json.load(sys.stdin)
    except Exception:
        return
    if (p.get('hook_event_name') or '') != 'Stop':
        return
    held = memory_gate_reason(p)                         # 002k (D1): a Joey-sourced memory proposal that is still undecided holds the turn once
    if held:
        print(json.dumps({'decision': 'block', 'reason': held}, ensure_ascii=False))
        return
    sid, d = p.get('session_id') or '', lanes_run_dir(p)
    msgs, outs = turn(p.get('transcript_path') or '')
    if len(msgs) < 2:                                   # a turn that took in one message is not checked
        return
    def log_call():                                      # 002k: the call, when there was one, in the unified log too
        if 'ms' in CALL:
            jev_log(d, 'answered-gate', CALL.get('question'), {'session': sid, 'messages': [m['mid'] for m in msgs], 'outputs': len(outs)},
                    CALL.get('answers'), None, CALL['ms'], CALL.get('error'))
    try:
        verdict, _raw = judge(msgs, outs)
    except Exception as e:                               # a failed call is an error, never a verdict
        record(d, {'session': sid, 'error': f'{type(e).__name__}: {e}'[:200], 'ms': CALL.get('ms'), 'messages': [m['mid'] for m in msgs]})
        log_call()
        return
    log_call()
    sp = os.path.join(d, 'answered-gate.json')
    try:
        st = json.load(open(sp, encoding='utf-8'))
    except Exception:
        st = {}
    missed = [m for m in msgs if verdict.get(m['mid']) == 'not_addressed' and f"{sid}:{m['mid']}" not in st]
    mode = os.environ.get('ANSWERED_GATE_MODE', 'enforce')
    record(d, {'session': sid, 'mode': mode, 'outputs': len(outs), 'ms': CALL.get('ms'), 'blocked': [m['mid'] for m in missed] if mode != 'shadow' else [],
               'messages': [{'mid': m['mid'], 'kind': m['kind'], 'absorbed': bool(m.get('absorbed')), 'verdict': verdict.get(m['mid']), 'p': m.get('p')} for m in msgs]})
    if not missed or mode == 'shadow':
        return
    for m in missed:
        st[f"{sid}:{m['mid']}"] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
    try:
        tmp = f'{sp}.{os.getpid()}.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(dict(list(st.items())[-500:]), f)
        os.replace(tmp, sp)
    except OSError:
        return                                           # cannot remember = would repeat on every stop: say nothing instead
    lines = '\n'.join(f"- {m['user'] or '寄件者'}（{'Telegram' if m['kind'] == 'tg' else 'mesh'} {m['mid']}）：「{m['body'][:300]}」" for m in missed)
    print(json.dumps({'decision': 'block', 'reason': '這一輪先不要結束。你這一回合收到的下面這幾則訊息，到現在沒有回應，也沒有交代什麼時候處理：\n' + lines +
                      '\n請現在回應；如果要晚一點才處理，也回一句讓對方知道。已經回過的不用重回。'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
