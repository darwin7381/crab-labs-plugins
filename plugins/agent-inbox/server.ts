// agent-inbox — standalone local mailbox daemon for a Claude Code agent.
//
// This instance serves the fleet mailbox tools and the roster's /inject port.
// A local sender writes an Item with the member's credential. The member's
// connector takes it from Onsen for delivery.
process.env.CHANNEL_INBOX_ONLY = '1'
await import('../telegram-http/server.ts')
