#!/usr/bin/env python3
"""End-of-turn check of the MAIN (universe 002j): every message taken in during this turn is answered or deferred.

Problem (problems list, item 9): a message that reaches the main while it is working is pulled into the running turn. A model
may fold it into the task at hand and end the turn without ever answering it (seen live on 2026-11-14 with Haiku, with no
fault injected). This aid checks the OUTCOME when the turn is about to end. It is called by lanes-hooks/main-hook.py (the
main's Stop hook), which hands it what the daemon knows, no transcript is read:
  - the messages of the turn: exactly the items M1 bound to this prompt (the one that opened it and the ones pulled into it);
  - the outputs: the reply / send_to_agent calls of the turn (the main hook reports them at PostToolUse), with their reply_to ids.
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
import sys
import tempfile
import time
import urllib.request

BODY_MAX, OUT_MAX = 1500, 2000
YES, NO = 0.7, 0.35                      # starting points (official cookbooks); calibrate on run/answered-gate.jsonl
MODEL = os.environ.get('TYPESAFE_DEFAULT_MODEL', 'jev-1.14.0')
API = os.environ.get('TYPESAFE_BASE_URL', 'https://api.typesafe.ai').rstrip('/') + '/v1/systemone'
KEY_FILE = os.environ.get('TYPESAFE_KEY_FILE', os.path.expanduser('~/.genesis/typesafe.env'))
TIMEOUT_S = float(os.environ.get('ANSWERED_GATE_TIMEOUT_S', '6'))


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


def reason(p, msgs, outs):
    """The block reason for a turn whose bound messages were not addressed, or None. msgs: [{mid, kind, user, no_reply, system, body}] (M1);
    outs: [{to, reply_to, text}]. Never raises."""
    try:
        return _reason(p, list(msgs or []), list(outs or []))
    except Exception:
        return None


def _reason(p, msgs, outs):
    sid, d = p.get('session_id') or '', lanes_run_dir(p)
    if len(msgs) < 2:                                   # a turn that took in one message is not checked
        return None
    def log_call():                                      # 002k: the call, when there was one, in the unified log too
        if 'ms' in CALL:
            jev_log(d, 'answered-gate', CALL.get('question'), {'session': sid, 'messages': [m['mid'] for m in msgs], 'outputs': len(outs)},
                    CALL.get('answers'), None, CALL['ms'], CALL.get('error'))
    try:
        verdict, _raw = judge(msgs, outs)
    except Exception as e:                               # a failed call is an error, never a verdict
        record(d, {'session': sid, 'error': f'{type(e).__name__}: {e}'[:200], 'ms': CALL.get('ms'), 'messages': [m['mid'] for m in msgs]})
        log_call()
        return None
    log_call()
    sp = os.path.join(d, 'answered-gate.json')
    try:
        st = json.load(open(sp, encoding='utf-8'))
    except Exception:
        st = {}
    missed = [m for m in msgs if verdict.get(m['mid']) == 'not_addressed' and f"{sid}:{m['mid']}" not in st]
    mode = os.environ.get('ANSWERED_GATE_MODE', 'enforce')
    record(d, {'session': sid, 'mode': mode, 'outputs': len(outs), 'ms': CALL.get('ms'), 'blocked': [m['mid'] for m in missed] if mode != 'shadow' else [],
               'messages': [{'mid': m['mid'], 'kind': m['kind'], 'verdict': verdict.get(m['mid']), 'p': m.get('p')} for m in msgs]})
    if not missed or mode == 'shadow':
        return None
    for m in missed:
        st[f"{sid}:{m['mid']}"] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
    try:
        tmp = f'{sp}.{os.getpid()}.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(dict(list(st.items())[-500:]), f)
        os.replace(tmp, sp)
    except OSError:
        return None                                      # cannot remember = would repeat on every stop: say nothing instead
    lines = '\n'.join(f"- {m['user'] or '寄件者'}（{'Telegram' if m['kind'] == 'tg' else 'mesh'} {m['mid']}）：「{m['body'][:300]}」" for m in missed)
    return ('這一輪先不要結束。你這一回合收到的下面這幾則訊息，到現在沒有回應，也沒有交代什麼時候處理：\n' + lines +
            '\n請現在回應；如果要晚一點才處理，也回一句讓對方知道。已經回過的不用重回。')


def main():
    """Standalone (tests): stdin = the Stop payload plus `lanes_turn` {items, outputs}, as main-hook.py passes them."""
    try:
        p = json.load(sys.stdin)
    except Exception:
        return
    t = p.get('lanes_turn') or {}
    r = reason(p, t.get('items') or [], t.get('outputs') or [])
    if r:
        print(json.dumps({'decision': 'block', 'reason': r}, ensure_ascii=False))


if __name__ == '__main__':
    main()
