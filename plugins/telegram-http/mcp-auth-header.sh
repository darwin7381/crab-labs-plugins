#!/bin/sh
# MCP headersHelper (see mcp-auth.ts): prints the loopback token header for the daemon this
# server entry points at. Claude Code runs it on every connect/reconnect and passes the URL in
# CLAUDE_CODE_MCP_SERVER_URL; the port picks the token file the daemon wrote. No token file yet
# (older daemon) → no header, which a report-first daemon still accepts.
port=$(printf '%s' "$CLAUDE_CODE_MCP_SERVER_URL" | sed -n 's#^http://127\.0\.0\.1:\([0-9][0-9]*\)/.*#\1#p')
f="${MCP_TOKEN_DIR:-$HOME/.claude/agent-inbox/mcp-tokens}/$port"
if [ -n "$port" ] && [ -r "$f" ]; then
  tok=$(tr -cd 'A-Za-z0-9_-' < "$f")
  [ -n "$tok" ] && { printf '{"Authorization":"Bearer %s"}\n' "$tok"; exit 0; }
fi
printf '{}\n'
