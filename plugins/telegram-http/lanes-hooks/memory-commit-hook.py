#!/usr/bin/env python3
"""Memory single writer + version control (universe 002): PostToolUse hook of the MAIN, and (002w) its commit() at the main's final Stop.

The memory directory (~/.claude/projects/<proj>/memory, shared by every session in the folder)
is a git repo. Every write the main makes there is committed at once; the message names the
writer lane and thread (main writes: lane=<agent>.main; when the main applies a lane's
memory_proposal it may set LANES_PROPOSAL_REF via the commit message trailer — not needed for
the auto-commit). Lanes cannot write there at all (lane-guard-hook).
"""
import json
import os
import re
import subprocess
import sys


def memory_dir(p):
    mem = os.environ.get('LANES_MEMORY_DIR') or ''
    if not mem:
        proj = (p.get('transcript_path') or '')
        mem = os.path.join(os.path.dirname(proj), 'memory') if proj else ''
    return mem


def commit(p, f=None):
    """002w (G, gap 21): THE memory commit. f = the file a Write / Edit / MultiEdit of the main wrote (its PostToolUse): committed when it is inside the
    memory dir; f = None (main-hook.py at the main's final Stop): everything the turn changed under the memory dir, whatever tool wrote it (Bash,
    NotebookEdit). The message names the writer lane and thread. Returns (sha, what) of the commit, or None when nothing was committed."""
    mem = memory_dir(p)
    if not mem or not os.path.isdir(mem):
        return None
    if f is not None and not os.path.realpath(f).startswith(os.path.realpath(mem) + os.sep):
        return None
    if not os.path.isdir(os.path.join(mem, '.git')):
        subprocess.run(['git', '-C', mem, 'init', '-q'], check=False)
    changed = [ln[3:] for ln in subprocess.run(['git', '-C', mem, 'status', '--porcelain'], check=False, capture_output=True, text=True).stdout.splitlines() if ln[3:]]
    if not changed:
        return None
    agent = os.environ.get('LANES_AGENT') or os.path.basename(p.get('cwd') or os.getcwd())
    lane = os.environ.get('LANE_ID') or f'{agent}.main'
    thread = os.environ.get('LANE_THREAD') or '-'
    rel = os.path.relpath(os.path.realpath(f), os.path.realpath(mem)) if f is not None else ', '.join(changed)[:200]
    msg = f'memory: {rel}\n\nlane={lane} thread={thread} session={p.get("session_id", "")}'
    # lanes-golive (A6): the agent's fleet identity form (lanes.ts gitEmail), the lane or <agent>.main as the name
    email = os.environ.get('LANES_GIT_EMAIL') or (re.sub(r'[^a-z0-9._-]', '-', agent.lower()) + '@fleet.local')
    env = {**os.environ, 'GIT_AUTHOR_NAME': lane, 'GIT_AUTHOR_EMAIL': email,
           'GIT_COMMITTER_NAME': lane, 'GIT_COMMITTER_EMAIL': email}
    subprocess.run(['git', '-C', mem, 'add', '-A'], check=False, env=env)
    r = subprocess.run(['git', '-C', mem, 'commit', '-q', '-m', msg], check=False, env=env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if r.returncode != 0:
        return None
    sha = subprocess.run(['git', '-C', mem, 'rev-parse', '--short', 'HEAD'], check=False, capture_output=True, text=True).stdout.strip()
    return (sha, rel, lane) if sha else None


def main():
    try:
        p = json.load(sys.stdin)
    except Exception:
        return
    if p.get('tool_name') not in ('Write', 'Edit', 'MultiEdit'):
        return
    done = commit(p, (p.get('tool_input') or {}).get('file_path') or '')
    # 002l (N2): design/memory 「版控…看得到哪條線在什麼時候改了什麼、改壞了能退回」 and 「主線隨時可以…退回任何一次改動」. The commit used to be silent (stdout to
    # DEVNULL, no context): D05's 「把剛才那次寫記憶的改動退回去」 became a hand rewrite. The main is now told the commit and how to undo it.
    if not done or os.environ.get('LANE_ID'):
        return
    sha, rel, lane = done
    ctx = (f'〔記憶版控〕這次寫入已提交 {sha}（{rel}，lane={lane}）。記憶目錄是 git：memory_history 看誰在什麼時候改了什麼；'
           f'要退回這一次就用 memory_revert(sha="{sha}", reason=…)，會產生一筆退回的提交，不要手動改回去。')
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': ctx}}, ensure_ascii=False))

if __name__ == '__main__':
    main()
