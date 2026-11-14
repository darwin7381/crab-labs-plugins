#!/usr/bin/env python3
"""End-of-turn check of the MAIN (universe 002k, D1): a memory proposal that came from Joey is decided.

Problem (002j group D, D01): Joey said "記住 ...". A lane filed the proposal, the digest showed it once, the main never wrote it and no
record says why. The reporting rule did not hold the main to it; this hook does, in code:

  - the open proposals: ledger entries kind memory_proposal with refs.joey (set by the daemon from the event, never by the lane) that
    have no memory_decision with the same refs.proposal_id (the main's memory_decide tool writes it);
  - "older than one main turn": the proposal was filed before the start of the main's PREVIOUS turn, i.e. a whole turn of the main has
    gone by with it listed in the digest (the digest lists every open Joey-sourced proposal again until it is decided);
  - the turn is held ONCE: state run/memory-gate.json keeps <session>:<start of this turn>; the second Stop of the same turn passes.

While the curator lane holds the memory write right the main cannot accept anything, so nothing is held then.
Any failure (no ledger, unreadable transcript, a state file that cannot be written) = the hook says nothing and the turn ends.
Runs as its own Stop hook, and main-answered-gate.py (the Stop hook the lab already wires for the main) calls reason() first.
"""
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

TAIL_BYTES = 3_000_000


def parse_ts(s):
    try:
        t = datetime.fromisoformat(str(s).replace('Z', '+00:00'))
        return (t if t.tzinfo else t.replace(tzinfo=timezone.utc)).timestamp()
    except Exception:
        return None


def read_jsonl(path, tail=False):
    try:
        size = os.path.getsize(path)
        with open(path, 'rb') as f:
            if tail and size > TAIL_BYTES:
                f.seek(size - TAIL_BYTES)
                f.readline()
            data = f.read().decode('utf-8', errors='replace')
    except OSError:
        return []
    out = []
    for line in data.splitlines():
        if line:
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def turn_starts(recs):
    """Timestamps of the prompts that started the main's turns: user records that are not tool results and not a hook's own feedback."""
    out = []
    for j in recs:
        if j.get('type') != 'user':
            continue
        c = (j.get('message') or {}).get('content')
        if isinstance(c, list):
            if any(isinstance(x, dict) and x.get('type') == 'tool_result' for x in c):
                continue
            txt = ' '.join(x.get('text', '') for x in c if isinstance(x, dict))
        else:
            txt = str(c or '')
        if txt.lstrip().startswith('Stop hook feedback'):
            continue
        t = parse_ts(j.get('timestamp'))
        if t is not None:
            out.append((t, str(j.get('timestamp'))))
    return out


def open_joey_proposals(ledger):
    decided = {(r.get('refs') or {}).get('proposal_id') for r in ledger if r.get('kind') == 'memory_decision'}
    return [r for r in ledger if r.get('kind') == 'memory_proposal' and (r.get('refs') or {}).get('joey') is True
            and (r.get('refs') or {}).get('proposal_id') and (r.get('refs') or {}).get('proposal_id') not in decided]


def reason(p):
    """The block reason, or None. Never raises."""
    try:
        if (p.get('hook_event_name') or '') != 'Stop':
            return None
        ld = os.environ.get('LANES_DIR') or os.path.join(p.get('cwd') or os.getcwd(), '.lanes')
        open_ = open_joey_proposals(read_jsonl(os.path.join(ld, 'ledger.jsonl')))
        if not open_:
            return None
        try:
            if json.load(open(os.path.join(ld, 'state.json'), encoding='utf-8')).get('curator'):
                return None                                   # the curator holds the write right: the main cannot accept
        except Exception:
            pass
        starts = turn_starts(read_jsonl(p.get('transcript_path') or '', tail=True))
        if len(starts) < 2:
            return None                                       # the main has not had a turn before this one
        cur, prev = starts[-1], starts[-2]
        old = [r for r in open_ if (parse_ts(r.get('ts')) or 0) < prev[0]]
        if not old:
            return None
        d = os.path.join(ld, 'run')
        d = d if os.path.isdir(d) else tempfile.gettempdir()
        sp = os.path.join(d, 'memory-gate.json')
        try:
            st = json.load(open(sp, encoding='utf-8'))
        except Exception:
            st = {}
        key = f"{p.get('session_id', '')}:{cur[1]}"
        if key in st:
            return None                                       # held once already in this turn: let it end
        st[key] = [r['refs']['proposal_id'] for r in old]
        try:
            tmp = f'{sp}.{os.getpid()}.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(dict(list(st.items())[-300:]), f)
            os.replace(tmp, sp)
        except OSError:
            return None                                       # cannot remember = would hold on every Stop: do not hold
        lines = '\n'.join(f"- {r['refs']['proposal_id']}（{r.get('lane', '')}，{r.get('ts', '')}）：{str(r.get('text', '')).split(chr(10) + '〔Jev')[0][:240]}" for r in old)
        return ('這一輪先不要結束。Joey 說的話被車道記成記憶提案，過了主線的一整個回合，到現在還沒有決定：\n' + lines +
                '\n用 memory_decide(proposal_id, accept|rewrite|veto, reason) 決定：accept / rewrite 會照一般的方式寫進記憶，veto 只留決定紀錄。')
    except Exception:
        return None


def main():
    try:
        p = json.load(sys.stdin)
    except Exception:
        return
    r = reason(p)
    if r:
        print(json.dumps({'decision': 'block', 'reason': r}, ensure_ascii=False))


if __name__ == '__main__':
    main()
