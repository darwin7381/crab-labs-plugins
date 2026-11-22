#!/usr/bin/env python3
"""Sub-agent types of a LANE (universe 002k, K3): PreToolUse hook on the Agent tool.

A worker or fork lane may use claude's native sub-agents (the Agent tool). A sub-agent inherits the lane's tools, MCP tools included, unless its definition says
otherwise, and a sub-agent must not use the lane's own tools (mcp__lane__*: tell Joey, hand work to the main, answer a peer, write the ledger): only the lane does.
The lane is started with --agents, which redefines every agent type claude itself offers (LANE_AGENT_TYPES in lanes.ts, the same names as ALLOWED here) with the lane's
MCP server in disallowedTools, and with Agent(fork) denied. The agent types that PLUGINS add (a dozen on the lab's machines) cannot be redefined by name from here, and
most of them inherit every tool: this hook refuses any sub-agent type that is not one of the redefined ones, with the list of the allowed ones in the message, so
the model's next call is a good one. No subagent_type means the general-purpose agent, which is redefined. Not in the main's settings.
"""
import json
import sys

ALLOWED = ('general-purpose', 'claude', 'Explore', 'Plan', 'statusline-setup')


def main():
    try:
        p = json.load(sys.stdin)
    except Exception:
        return
    if p.get('tool_name') not in ('Agent', 'Task'):
        return
    ti = p.get('tool_input') or {}
    kind = str(ti.get('subagent_type') or 'general-purpose').strip()
    if kind in ALLOWED:
        return
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason':
        f"sub-agent type {kind!r} is not available in a lane: it would keep this lane's own tools (the lane tools for Joey, the main, peers and the ledger belong to the lane alone). "
        f"Use one of: {', '.join(ALLOWED)} (or leave subagent_type out for general-purpose)."}}, ensure_ascii=False))


if __name__ == '__main__':
    main()
