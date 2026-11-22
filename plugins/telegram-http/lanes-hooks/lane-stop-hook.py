#!/usr/bin/env python3
"""Lane Stop hook (M3). A lane run ends only after it asked the daemon once what its event still owes.

1. A message of Joey's that reached the run and was not handed over at a tool boundary is handed over now (lane-steer-hook.deliver).
2. POST /lane-stop on the tg daemon with the run's own token: the daemon answers from the event record (M3), never from the transcript.
   It blocks once with the obligations still open (a line for Joey, an answer to a peer, a scheduler receipt), or lets the run end.
   What is still open when the run ends goes to the main (the exit rule).
"""
import importlib.util
import json
import os
import sys
import urllib.request


def steering(p):
    try:
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
    steer = steering(p)
    if steer:                                   # the run goes on with it; the next Stop asks the daemon
        print(json.dumps({'decision': 'block', 'reason': '這一輪先不要結束。' + steer}, ensure_ascii=False))
        return
    port, tok = os.environ.get('LANES_HTTP_PORT'), os.environ.get('LANE_RUN_TOKEN')
    if not port or not tok:
        return
    req = urllib.request.Request(f'http://127.0.0.1:{port}/lane-stop', data=json.dumps({'stop_hook_active': p.get('stop_hook_active')}).encode(),
                                 method='POST', headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {tok}'})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            block = (json.loads(r.read() or b'{}') or {}).get('block')
    except Exception:
        return
    if block:
        print(json.dumps({'decision': 'block', 'reason': block}, ensure_ascii=False))


if __name__ == '__main__':
    main()
