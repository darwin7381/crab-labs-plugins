#!/usr/bin/env python3
"""End-of-turn check of the MAIN (universe 002k, D1): a memory proposal that came from Joey is decided.

Problem (002j group D, D01): Joey said "記住 ...". A lane filed the proposal, the digest showed it once, the main never wrote it and no
record says why. The reporting rule did not hold the main to it; this hook does, in code:

  - the open proposals: ledger entries kind memory_proposal with refs.joey (set by the daemon from the event, never by the lane) that
    have no memory_decision with the same refs.proposal_id (the main's memory_decide tool writes it). 002p: the daemon computes them and
    hands them in (`proposals`: [{id, ts, lane, text}]); this file reads neither the ledger nor state.json nor any transcript;
  - shown to the main: a digest that carried the proposal's event reached it (the daemon's `shown`; 002v). Until 002v the stand-in was
    "filed before the start of the main's PREVIOUS turn", which gave the main a whole extra turn (002u D02: one turn after Joey's 「記住」,
    the proposal in its digest, no decision, never held);
  - the turn is held ONCE: state run/memory-gate.json keeps <session>:<turn.prompt_id>; the second Stop of the same turn passes.

While the curator lane holds the memory write right (`curator`, from the daemon) the main cannot accept anything, so nothing is held then.
Any failure (no previous turn, a state file that cannot be written) = the hook says nothing and the turn ends.
main-hook.py (the main's one hook) calls reason(p, turn, proposals, curator) on Stop with what the daemon answered. Run on its own, the script
does nothing unless its stdin carries "turn" (then "proposals" and "curator" are read from stdin too).
"""
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

def parse_ts(s):
    try:
        t = datetime.fromisoformat(str(s).replace('Z', '+00:00'))
        return (t if t.tzinfo else t.replace(tzinfo=timezone.utc)).timestamp()
    except Exception:
        return None


def reason(p, turn, proposals, curator):
    """The block reason, or None. Never raises. turn = the daemon's turn (prompt_id, prev_started_at, ...); proposals = the open Joey-sourced
    memory proposals [{id, ts, lane, text}]; curator = a curator lane holds the memory write right."""
    try:
        if (p.get('hook_event_name') or '') != 'Stop':
            return None
        open_ = [r for r in (proposals or []) if isinstance(r, dict) and r.get('id')]
        if not open_:
            return None
        if curator:
            return None                                       # the curator holds the write right: the main cannot accept
        turn = turn if isinstance(turn, dict) else {}
        if not turn.get('prompt_id'):
            return None                                       # no turn handed in by the daemon: nothing to hold
        old = [r for r in open_ if r.get('shown') is True]      # the main has been shown it (a digest that carried it reached the main)
        if not old:
            return None
        ld = os.environ.get('LANES_DIR') or os.path.join(p.get('cwd') or os.getcwd(), '.lanes')
        d = os.path.join(ld, 'run')
        d = d if os.path.isdir(d) else tempfile.gettempdir()
        sp = os.path.join(d, 'memory-gate.json')
        try:
            st = json.load(open(sp, encoding='utf-8'))
        except Exception:
            st = {}
        key = f"{p.get('session_id', '')}:{turn.get('prompt_id', '')}"
        if key in st:
            return None                                       # held once already in this turn: let it end
        st[key] = [r['id'] for r in old]
        try:
            tmp = f'{sp}.{os.getpid()}.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(dict(list(st.items())[-300:]), f)
            os.replace(tmp, sp)
        except OSError:
            return None                                       # cannot remember = would hold on every Stop: do not hold
        lines = '\n'.join(f"- {r['id']}（{r.get('lane', '')}，{r.get('ts', '')}）：{str(r.get('text', '')).split(chr(10) + '〔Jev')[0][:240]}" for r in old)
        return ('這一輪先不要結束。Joey 說的話被車道記成記憶提案，你已經在摘要裡看到它，還沒有決定：\n' + lines +
                '\n用 memory_decide(proposal_id, accept|rewrite|veto, reason) 決定：accept / rewrite 會照一般的方式寫進記憶，veto 只留決定紀錄。')
    except Exception:
        return None


def main():
    try:
        p = json.load(sys.stdin)
    except Exception:
        return
    if not isinstance(p, dict) or 'turn' not in p:
        return                                                # the old standalone Stop registration: main-hook.py calls reason()
    r = reason(p, p.get('turn') or {}, p.get('proposals') or [], bool(p.get('curator')))
    if r:
        print(json.dumps({'decision': 'block', 'reason': r}, ensure_ascii=False))


if __name__ == '__main__':
    main()
