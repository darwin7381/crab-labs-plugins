#!/usr/bin/env python3
"""Lane Stop hook (universe 002): never-silent for lanes.

A lane turn may only end after it closed with one of the lane tools
  notify_joey (the router alone decides its tier), reply_agent, receipt
— the lane equivalents of the fleet rule "every woken turn reports". High-frequency no-change
routines close with receipt only (Joey msg 934).
Blocks at most MAX_BLOCKS times per turn; after that the daemon's exit check makes the silence
loud (ledger escalation + bot message), so a stuck model cannot loop forever.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

TOLD = ('mcp__lane__notify_joey', 'mcp__lane__ask_joey', 'mcp__lane__handoff_main', 'mcp__lane__report_result', 'mcp__lane__deliver_synthesis', 'mcp__lane__curator_done')
CLOSERS = ('mcp__lane__notify_joey', 'mcp__lane__ask_joey', 'mcp__lane__handoff_main', 'mcp__lane__reply_agent', 'mcp__lane__receipt',
           'mcp__lane__report_result', 'mcp__lane__deliver_synthesis', 'mcp__lane__curator_done')   # 002k: fan-out, synthesis, curator
MAX_BLOCKS = 2
# 002k (E3, 002j group E): a Joey-class run that ends by telling Joey it cannot do something, without ever looking at the service catalog.
DECLINE_RE = re.compile(r"無法|沒辦法|can[’']t|cannot|unable", re.I)
# 002k (H4, 002j group H): the same rule for a run a PEER's message started, and for a decline said with ask_joey or reply_agent (a lane told a peer it could not
# verify a claim that one GET would have settled). The program output attached is `./bin/svc GET mock-api/config` and `GET mock-api/health` when the run is
# about mock-api, the catalog when the subject is not known.
SAID_TOOLS = ('mcp__lane__notify_joey', 'mcp__lane__ask_joey', 'mcp__lane__reply_agent')
PEER_RUN = re.compile(r'來源 mesh｜寄件者 ([^\s（(｜]+)')
AUTOMATED = ('scheduler', 'alert-dispatcher', 'main')
API_SUBJECT = re.compile(r'mock-api|\bapi\b|config|health|p95|5xx|replica|log_level|maintenance|timeout|設定|維護|逾時|健康|延遲|錯誤率', re.I)


# 002m model aid (b): a claim of a hand-over or an escalation that the run did not make. H03 r1/r2 (told Eve 「轉給 Joey」, used a silent notify_joey), C03 r2
# (「已請 Joey 決定」, a silent notify_joey), B09 (handoff_main where Joey had to decide). identity rule 4 「要承諾…就升級主線」, routing 「需要主線的才升級」, notify
# 「誰可以對你發訊息」: what reaches Joey for a decision is ask_joey, what reaches the main is handoff_main. A run whose message to a peer or to Joey says the
# matter was (or will be) passed to Joey or the main, with neither tool called in the run, is held ONCE: do it now, or correct the claim.
# Program first: clear claims and clear negations are read here; only a sentence that names Joey or the main without a clear claim goes to Jev (one Noul
# per sentence, p >= LANES_CLAIM_JEV_P, default 0.8), as A3 does. No key or a failed call: the program's answer stands.
WHO = r'(?:Joey|joey|老闆|主線|主\s*agent|主\s*session|主腦|the main(?: agent| session)?)'
CLAIM_RE = [
    re.compile(r'(?:轉給|轉交|轉交給|交給|交由|上報給?|升級給|升級到|呈報|請示|丟給|轉達給)\s*' + WHO),
    re.compile(r'(?:請|讓|由)\s*' + WHO + r'\s*(?:來)?(?:決定|定奪|處理|確認|判斷|裁決|拍板|核准|批准|同意|接手)'),
    re.compile(r'(?:等|待|等待)\s*' + WHO + r'\s*(?:的)?(?:決定|回覆|確認|核准|批准|定奪|裁決)'),
    re.compile(WHO + r'\s*(?:會|將|那邊會|之後會)\s*(?:來)?(?:決定|定奪|處理|確認|裁決|回覆|接手)'),
    re.compile(r'已(?:經)?升級|升級(?:處理|主線)'),
    re.compile(r'\b(?:passed|forwarded|escalated|handed(?: it| this)?(?: over)?|referred|sent)\s+(?:it\s+|this\s+)?(?:on\s+|up\s+)?to\s+(?:Joey|the main)', re.I),
    re.compile(r'\b(?:Joey|the main(?: agent)?)\s+(?:will|is going to|to)\s+(?:decide|handle|confirm|approve|take (?:it|this) over)', re.I),
]
# said to Joey himself with a silent notice: "you decide" is a question for Joey, which is ask_joey's job
ASK_JOEY_RE = re.compile(r'(?:請你|要你|需要你|等你|由你|你來)\s*(?:決定|定奪|確認|核准|批准|同意|拍板|裁決)')
NEG_RE = re.compile(r'不(?:會|用|必|需要?)\s*(?:再)?(?:轉|交|請|升級|麻煩|打擾|驚動)|沒有(?:轉|交|請|升級)|還沒|尚未|無需|不需要|no need to|won\'t|will not|did not|didn\'t|not (?:yet )?(?:escalat|pass|forward|hand)', re.I)
LOOSE_RE = re.compile(WHO + r'|escalat|上級|主管|上面', re.I)
CLAIM_JEV_P = float(os.environ.get('LANES_CLAIM_JEV_P', '0.8'))
JEV_MODEL = os.environ.get('TYPESAFE_DEFAULT_MODEL', 'jev-1.14.0')


def sentences(text):
    return [x.strip() for x in re.split(r'(?<=[。！？!?；;])\s*|\n+', text or '') if x.strip()]


def claim_kind(sentence, to_joey):
    """'claim' (a clear claim of a hand-over/escalation), 'loose' (names Joey or the main, no clear claim: Jev decides), or None."""
    if NEG_RE.search(sentence):
        return None
    if any(r.search(sentence) for r in CLAIM_RE) or (to_joey and ASK_JOEY_RE.search(sentence)):
        return 'claim'
    return 'loose' if LOOSE_RE.search(sentence) else None


def load_key():
    k = os.environ.get('TYPESAFE_API_KEY', '').strip()
    if k:
        return k
    try:
        for line in open(os.environ.get('TYPESAFE_KEY_FILE', os.path.expanduser('~/.genesis/typesafe.env')), encoding='utf-8'):
            line = line.strip()
            if line.startswith('export '):
                line = line[7:].strip()
            if line.startswith('TYPESAFE_API_KEY='):
                return line.split('=', 1)[1].strip().strip('"').strip("'") or None
    except OSError:
        pass
    return None


def jev_claims(items, run_dir):
    """For the loose sentences [(to, sentence)]: the indexes Jev reads as a claim that the matter was or will be passed to Joey or the main (p >= CLAIM_JEV_P).
    One request, one Noul per sentence. Logged to <run>/jev-calls.jsonl (site lane-claim-check). [] on no key or any failure."""
    key = load_key()
    if not key or not items:
        return []
    q = {f'S{i + 1}': {'type': 'noul', 'instructions': f'Does item S{i + 1} of `messages` tell its reader that this matter has been passed, or will be passed, to Joey or to the main agent to decide or to handle?',
                       'criteria': {'true': 'It says Joey or the main agent has been asked, was handed the matter, or will decide or handle it',
                                    'false': 'It does not say that (it only mentions them, reports facts, or says they are not needed)'}} for i in range(len(items))}
    state = {'setting': 'An operations agent\'s helper lane sent these messages in one run. The helper cannot decide for Joey; asking Joey and handing work to the main agent are separate steps it takes with its tools.',
             'messages': [{'id': f'S{i + 1}', 'to': to, 'text': snt[:400]} for i, (to, snt) in enumerate(items)]}
    t0, ans, err = time.monotonic(), None, None
    try:
        req = urllib.request.Request(os.environ.get('TYPESAFE_BASE_URL', 'https://api.typesafe.ai').rstrip('/') + '/v1/systemone',
                                     data=json.dumps({'model': JEV_MODEL, 'state': state, 'questions': q}, ensure_ascii=False).encode('utf-8'), method='POST',
                                     headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'User-Agent': 'genesis-lane-claim-check/1'})
        with urllib.request.urlopen(req, timeout=float(os.environ.get('LANES_CLAIM_JEV_TIMEOUT_S', '8'))) as r:
            ans = json.loads(r.read().decode('utf-8')).get('answers')
        if not isinstance(ans, dict):
            raise RuntimeError('no answers')
    except Exception as e:
        err = f'{type(e).__name__}: {e}'[:160]
    hits = []
    if ans:
        for i in range(len(items)):
            try:
                if float((ans.get(f'S{i + 1}') or {}).get('noul', 0)) >= CLAIM_JEV_P:
                    hits.append(i)
            except Exception:
                pass
    if run_dir:
        try:
            ps = [float((ans.get(f'S{i + 1}') or {}).get('noul', 0)) for i in range(len(items))] if ans else []
            with open(os.path.join(run_dir, 'jev-calls.jsonl'), 'a', encoding='utf-8') as f:
                f.write(json.dumps({'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'site': 'lane-claim-check', 'question': q,
                                    'inputs': {'lane': os.environ.get('LANE_ID', ''), 'sentences': [s[:80] for _, s in items]}, 'answer': ans,
                                    'p': max(ps) if ps else None, 'ms': int((time.monotonic() - t0) * 1000), 'err': err}, ensure_ascii=False) + '\n')
        except Exception:
            pass
    return hits


def unbacked_claims(sent, run_dir):
    """[(tool, to, sentence, by)] for the claims in what the run sent: by 'program' or 'jev'."""
    clear, loose = [], []
    for tool, to, text in sent:
        for snt in sentences(text):
            k = claim_kind(snt, tool == 'mcp__lane__notify_joey')
            if k == 'claim':
                clear.append((tool, to, snt, 'program'))
            elif k == 'loose':
                loose.append((tool, to, snt))
    if clear:
        return clear
    if os.environ.get('LANES_CLAIM_JEV', '1') == '0':
        return []
    return [(loose[i][0], loose[i][1], loose[i][2], 'jev') for i in jev_claims([(to, snt) for _, to, snt in loose][:8], run_dir)]


def looked_at_catalog(cmd):
    """Some command of the Bash call IS ./bin/svc with no arguments (the catalog) or with GET."""
    for seg in re.split(r'&&|\|\||[;|&\n]', cmd):
        toks, i = seg.split(), 0
        while i < len(toks) and (re.match(r'^[A-Za-z_]\w*=', toks[i]) or toks[i] in ('sudo', 'time', 'nohup', 'exec', 'env', 'command', 'bash', 'sh')):
            i += 1
        if i < len(toks) and (toks[i] == 'bin/svc' or toks[i].endswith('/bin/svc')):
            args = toks[i + 1:]
            if not args or args[0].upper() == 'GET':
                return True
    return False


def svc_output(cwd, args=()):
    """What ./bin/svc prints for these arguments, run here by the program; '' when it cannot be run."""
    try:
        r = subprocess.run(['./bin/svc', *args], cwd=cwd or os.getcwd(), capture_output=True, text=True, timeout=8)
        return r.stdout.strip()[:3000] if r.returncode == 0 else ''
    except Exception:
        return ''


def catalog_output(cwd):
    """What ./bin/svc prints (the catalog), run here by the program; '' when it cannot be run."""
    return svc_output(cwd)


def save_state(state_p, st):
    if not state_p:
        return False
    try:
        tmp = state_p + '.tmp'
        json.dump(dict(list(st.items())[-200:]), open(tmp, 'w'))
        os.replace(tmp, state_p)
        return True
    except Exception:
        return False


def steering_text(p):
    """002k (E18): a message from Joey that reached this lane while its run was in progress and was not handed over at a tool boundary (lane-steer-hook.py): hand it over now."""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location('lane_steer_hook', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lane-steer-hook.py'))
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        return m.deliver(p)
    except Exception:
        return ''


def main():
    try:
        p = json.load(sys.stdin)
    except Exception:
        return
    steer = steering_text(p)
    if steer:                                     # the run goes on with it: nothing else is checked on this Stop (the next Stop checks everything)
        print(json.dumps({'decision': 'block', 'reason': '這一輪先不要結束。' + steer}, ensure_ascii=False))
        return
    tp = p.get('transcript_path') or ''
    sid = p.get('session_id', '')
    try:
        lines = open(tp, encoding='utf-8').read().splitlines()
    except Exception:
        return
    last_user = None
    for i in range(len(lines) - 1, -1, -1):
        try:
            j = json.loads(lines[i])
        except Exception:
            continue
        if j.get('type') != 'user':
            continue
        c = j.get('message', {}).get('content', '')
        if isinstance(c, list):
            if any(isinstance(x, dict) and x.get('type') == 'tool_result' for x in c):
                continue
            txt = ' '.join(x.get('text', '') for x in c if isinstance(x, dict) and x.get('type') == 'text')
        else:
            txt = str(c)
        if txt.lstrip().startswith('Stop hook feedback') or 'lane-stop-hook' in txt:
            continue
        last_user = i
        break
    if last_user is None:
        return
    closed, used = False, set()
    said, looked = {}, False
    sent = []                                     # 002m aid (b): every message the run sent to a peer or to Joey, in order
    names_used = set()
    for line in lines[last_user + 1:]:
        try:
            j = json.loads(line)
        except Exception:
            continue
        if j.get('type') != 'assistant':
            continue
        for c in j.get('message', {}).get('content', []) or []:
            if not isinstance(c, dict) or c.get('type') != 'tool_use':
                continue
            n = c.get('name', '')
            if n in SAID_TOOLS:
                said[n] = str((c.get('input') or {}).get('text', ''))      # the LAST text of each of the three tools
            if n in ('mcp__lane__reply_agent', 'mcp__lane__notify_joey'):
                inp = c.get('input') or {}
                sent.append((n, str(inp.get('to', 'a peer')) if n == 'mcp__lane__reply_agent' else 'Joey', str(inp.get('text', ''))))
            if n == 'Bash' and looked_at_catalog(str((c.get('input') or {}).get('command', ''))):
                looked = True
            names_used.add(n)
            if n in TOLD:
                closed = True
            elif n in CLOSERS:
                used.add(n)
    lanes_dir = os.environ.get('LANES_DIR', '')
    state_p = os.path.join(lanes_dir, 'run', 'stop-blocks.json') if lanes_dir else ''
    key = f'{sid}:{last_user}'
    try:
        st = json.load(open(state_p)) if state_p and os.path.exists(state_p) else {}
    except Exception:
        st = {}
    # 002k (plan/decisions DC1): reply_agent or receipt alone is not a line for Joey. A high-frequency routine may end with the receipt
    # alone (Joey msg 934): its tag is in the event text of this turn.
    prompt_text = ''
    try:
        pj = json.loads(lines[last_user]); pc = pj.get('message', {}).get('content', '')
        prompt_text = pc if isinstance(pc, str) else ' '.join(x.get('text', '') for x in pc if isinstance(x, dict))
    except Exception:
        pass
    # 002k (B9): a follow-up run (its event text is the router's "後續檢查" message) always leaves its notify_joey line, even when the
    # routine it belongs to is high-frequency: the follow-up text says so, and the receipt-only exception is for the scheduled run itself
    followup = '[車道事件｜後續檢查' in prompt_text
    if not closed and used and used <= {'mcp__lane__receipt'} and '[high-frequency]' in prompt_text and not followup:
        closed = True
    # 002k (E3): a run Joey's message started that ends with a notify_joey that declines, and that never called ./bin/svc for the catalog or a GET:
    # held once, with the output of ./bin/svc attached as program output (the hook ran it; it is not a new instruction)
    joey_run = '來源 Telegram｜Joey' in prompt_text
    pm = PEER_RUN.search(prompt_text)
    peer_run = bool(pm) and pm.group(1) not in AUTOMATED
    if closed and not looked and (joey_run or peer_run) and said and int(st.get(key + ':decline', 0)) < 1:
        hit = None
        for tool in SAID_TOOLS:                                  # notify_joey first (the E3 case), then ask_joey, then reply_agent
            m = DECLINE_RE.search(said.get(tool, ''))
            if m:
                hit = (tool, m.group(0), said[tool])
                break
        if hit:
            tool, word, said_text = hit
            legacy = joey_run and tool == 'mcp__lane__notify_joey'          # E3 as it was: the catalog
            if not legacy and API_SUBJECT.search(prompt_text + ' ' + said_text):
                parts = [(a, svc_output(p.get('cwd'), a)) for a in (('GET', 'mock-api/config'), ('GET', 'mock-api/health'))]
                parts = [(' '.join(('./bin/svc',) + a), o) for a, o in parts if o]
            else:
                parts = []
            if not parts:
                o = catalog_output(p.get('cwd'))
                parts = [('./bin/svc', o)] if o else []
            if parts:
                st[key + ':decline'] = 1
                if save_state(state_p, st):                      # cannot remember = could hold for ever: do not hold
                    lane = os.environ.get('LANE_ID', 'this lane')
                    to = 'Joey' if tool != 'mcp__lane__reply_agent' else 'a peer'
                    started = 'Joey' if joey_run else pm.group(1)
                    body = '\n\n'.join(f'{cmd}:\n{o}' for cmd, o in parts)
                    print(json.dumps({'decision': 'block', 'reason': (
                        f'⛔ lane-stop-hook: {lane} (started by {started}) told {to} it cannot ({word}) with {tool.replace("mcp__lane__", "")}, but this run never looked at '
                        f'the service catalog or made a GET call (no ./bin/svc catalog or GET). Output of ./bin/svc, run by the hook just now (program output):\n{body}')}, ensure_ascii=False))
                    return
    # 002m aid (b): a hand-over or escalation claimed in a message, with neither ask_joey nor handoff_main in the run: held once
    if sent and not ({'mcp__lane__ask_joey', 'mcp__lane__handoff_main'} & names_used) and int(st.get(key + ':claim', 0)) < 1 \
            and os.environ.get('LANES_CLAIM_CHECK', '1') != '0':
        hits = unbacked_claims(sent, os.path.join(lanes_dir, 'run') if lanes_dir else '')
        if hits:
            st[key + ':claim'] = 1
            if save_state(state_p, st):                          # cannot remember = could hold for ever: do not hold
                lane = os.environ.get('LANE_ID', 'this lane')
                if lanes_dir:
                    try:
                        with open(os.path.join(lanes_dir, 'run', 'claim-check.jsonl'), 'a', encoding='utf-8') as f:
                            f.write(json.dumps({'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'lane': lane, 'session': sid,
                                                'claims': [{'tool': t, 'to': to, 's': snt[:200], 'by': by} for t, to, snt, by in hits]}, ensure_ascii=False) + '\n')
                    except Exception:
                        pass
                said_lines = '\n'.join(f'- to {to} ({t.replace("mcp__lane__", "")}): 「{snt[:200]}」' for t, to, snt, _ in hits[:4])
                print(json.dumps({'decision': 'block', 'reason': (
                    f'⛔ lane-stop-hook: {lane} said the matter was (or will be) passed to Joey or the main:\n{said_lines}\n'
                    'but this run called neither ask_joey nor handoff_main, so nobody has it. Before ending, do one of these: if Joey has to decide, call ask_joey '
                    '(one message; it rings); if the main has to act, call handoff_main; if neither is true, send a correction to whoever you told '
                    '(reply_agent to the peer, notify_joey to Joey) that says who actually handles it.')}, ensure_ascii=False))
                return
    if closed:
        return
    n = int(st.get(key, 0))
    if n >= MAX_BLOCKS:
        return
    st[key] = n + 1
    if state_p:
        try:
            tmp = state_p + '.tmp'
            json.dump(dict(list(st.items())[-200:]), open(tmp, 'w'))
            os.replace(tmp, state_p)
        except Exception:
            pass
    lane = os.environ.get('LANE_ID', 'this lane')
    print(json.dumps({'decision': 'block', 'reason': (
        f'⛔ lane-stop-hook: {lane} has not left Joey a line yet. Close this turn with notify_joey (one line; the router decides '
        'whether it rings, a peer matter is silent), also after answering a peer with reply_agent. '
        'Only a high-frequency routine with no change may end with the receipt alone (a follow-up run never may). '
        'Never end silent. If Joey must decide, use ask_joey; if the main must do it, use handoff_main (one of them, not both).')}))


if __name__ == '__main__':
    main()
