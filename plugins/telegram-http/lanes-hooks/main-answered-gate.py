#!/usr/bin/env python3
"""End-of-turn check of the MAIN (universe 002j): every message taken in during this turn is answered or deferred, and (002r) the
turn's last words reached somebody.

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

002r, the last words (universe 002q, G02): the main acknowledged Joey's request, worked, and ended the turn with the answer written as
plain text on its own screen. Every other check passed: the turn had a reply, and nothing was owed by the record. So, when the turn
made tool calls after its last delivered reply / send_to_agent (`turn.calls`, the daemon's record) and ends on a text of substance
(the Stop payload's `last_assistant_message`; no transcript is read), Jev is asked one question: does that text state an answer or
result a sender asked for which no output of the turn contains. Yes = the turn is held once, with fixed words. The question and its
threshold were calibrated on the real turns of universes 002o, 002p and 002q (59 recap or waiting texts after a reply: highest 0.37;
the real unsent answer: 0.99).
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
UNSENT_MIN = 40                          # a final text shorter than this states no result
UNSENT_P = float(os.environ.get('ANSWERED_GATE_UNSENT_P', '0.6'))
UNSENT_SETTING = ('An agent works for its boss and for other senders. They can read ONLY `outputs`: the messages the agent sent during this turn, in order. '
                  '`messages` are what the agent took in during the turn. `final_text` is what the agent wrote on its own screen as the turn ended; '
                  'nobody else can see it.')
UNSENT_Q = {'type': 'noul',
            'instructions': 'Does `final_text` state an answer, a result or a figure that a sender of `messages` asked for, which no item of `outputs` already told that sender?',
            'criteria': {'true': 'final_text gives the asked-for answer or result, and no output contains it: the outputs only acknowledge, report progress, or promise it for later',
                         'false': 'what final_text states was already sent in an output, or final_text only describes what was sent or done, or says the agent is still waiting'}}
UNSENT_WORDS = ('這一輪先不要結束。你最後寫的那段結果只出現在你自己的畫面上，對方看不到。'
                '要讓他知道，現在用 reply（給 Joey）或 send_to_agent（給同伴）發出去；內容其實都發過了的話，直接結束即可。')


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


def reason(p, msgs, outs, turn=None):
    """The block reason for a turn whose bound messages were not addressed, or whose last words reached nobody, or None.
    msgs: [{mid, kind, user, no_reply, system, body}] (M1); outs: [{to, reply_to, text}]; turn: the daemon's turn ({prompt_id, calls}). Never raises."""
    try:
        return _reason(p, list(msgs or []), list(outs or []), turn)
    except Exception:
        return None


def calls_after_last_output(calls, had_outputs):
    """How many tool calls the turn made after its last delivered reply / send_to_agent. None: it delivered nothing (the owed-line hold's
    case, not this one). The daemon keeps the turn's last 40 calls: an output older than that leaves all of them after it."""
    calls = list(calls or [])
    last = None
    for i, c in enumerate(calls):
        if isinstance(c, dict) and str(c.get('name') or '').endswith(('__reply', '__send_to_agent')) and not c.get('error'):
            last = i
    if last is None:
        return len(calls) if had_outputs else None
    return len(calls) - 1 - last


def unsent_p(msgs, outs, final):
    """Jev's probability that `final` states an asked-for answer or result that no output of the turn contains."""
    a = ask({'setting': UNSENT_SETTING, 'messages': [{'from': m.get('user') or '', 'text': str(m.get('body') or '')[:BODY_MAX]} for m in msgs][-6:],
             'outputs': [{'to': o['to'], 'text': o['text'][:OUT_MAX]} for o in outs[-12:]], 'final_text': final[:3000]}, {'unsent': UNSENT_Q})
    return (a.get('unsent') or {}).get('noul')


def _load(sp):
    try:
        return json.load(open(sp, encoding='utf-8'))
    except Exception:
        return {}


def _save(sp, st):
    """False = cannot remember = the hold would repeat on every stop: the caller says nothing instead."""
    try:
        tmp = f'{sp}.{os.getpid()}.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(dict(list(st.items())[-500:]), f)
        os.replace(tmp, sp)
        return True
    except OSError:
        return False


def _reason(p, msgs, outs, turn=None):
    sid, d = p.get('session_id') or '', lanes_run_dir(p)
    return _missed(p, sid, d, msgs, outs) or _unsent(p, sid, d, msgs, outs, turn if isinstance(turn, dict) else {})


def _unsent(p, sid, d, msgs, outs, turn):
    """The hold for a turn whose last words reached nobody, or None. One hold per turn (the prompt id)."""
    final = str(p.get('last_assistant_message') or '').strip()
    after = calls_after_last_output(turn.get('calls'), bool(outs))
    if not msgs or not outs or not after or len(final) < UNSENT_MIN:
        return None
    sp = os.path.join(d, 'answered-gate.json')
    st, key = _load(sp), f"{sid}:unsent:{turn.get('prompt_id') or p.get('prompt_id') or ''}"
    if key in st:
        return None
    facts = {'calls_after': after, 'chars': len(final)}
    try:
        pr = unsent_p(msgs, outs, final)
    except Exception as e:                               # a failed call is an error, never a verdict
        record(d, {'session': sid, 'unsent': facts, 'error': f'{type(e).__name__}: {e}'[:200], 'ms': CALL.get('ms')})
        jev_log(d, 'unsent-gate', CALL.get('question'), {'session': sid, **facts}, None, None, CALL.get('ms'), CALL.get('error'))
        return None
    jev_log(d, 'unsent-gate', CALL.get('question'), {'session': sid, **facts}, CALL.get('answers'), pr, CALL.get('ms'), None)
    mode = os.environ.get('ANSWERED_GATE_MODE', 'enforce')
    hold = pr is not None and pr >= UNSENT_P
    record(d, {'session': sid, 'mode': mode, 'ms': CALL.get('ms'), 'unsent': {**facts, 'p': pr}, 'blocked': ['unsent'] if hold and mode != 'shadow' else []})
    if not hold or mode == 'shadow':
        return None
    st[key] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
    return UNSENT_WORDS if _save(sp, st) else None


def _missed(p, sid, d, msgs, outs):
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
    st = _load(sp)
    missed = [m for m in msgs if verdict.get(m['mid']) == 'not_addressed' and f"{sid}:{m['mid']}" not in st]
    mode = os.environ.get('ANSWERED_GATE_MODE', 'enforce')
    record(d, {'session': sid, 'mode': mode, 'outputs': len(outs), 'ms': CALL.get('ms'), 'blocked': [m['mid'] for m in missed] if mode != 'shadow' else [],
               'messages': [{'mid': m['mid'], 'kind': m['kind'], 'verdict': verdict.get(m['mid']), 'p': m.get('p')} for m in msgs]})
    if not missed or mode == 'shadow':
        return None
    for m in missed:
        st[f"{sid}:{m['mid']}"] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
    if not _save(sp, st):
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
    r = reason(p, t.get('items') or [], t.get('outputs') or [], t.get('turn'))
    if r:
        print(json.dumps({'decision': 'block', 'reason': r}, ensure_ascii=False))


if __name__ == '__main__':
    main()
