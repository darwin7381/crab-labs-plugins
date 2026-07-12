// agent-inbox — standalone local mailbox daemon for a Claude Code agent.
//
// Every fleet agent gets one: an independent process/port/state-dir whose only
// job is durable local message delivery into the agent's session (on-call
// handoffs, agent-to-agent messages, scheduled nudges, BTCC Comms-console
// messages from the boss). Deliberately NOT the Telegram daemon: the wake/comms
// path must not share fate with Telegram polling, logins, or plugin restarts
// (Joey 2026-07-12, msg 4557).
//
// Implementation: telegram-http's battle-tested channel engine (MCP transport,
// memQueue + disk pending replay, zombie-session GC, keepalives) booted in
// CHANNEL_INBOX_ONLY mode — no token, no polling, no TG tools; serves /mcp,
// /healthz and POST /inject only. 獨立 = instance（process/port/state），not
// codebase.
process.env.CHANNEL_INBOX_ONLY = '1'
await import('../telegram-http/server.ts')
