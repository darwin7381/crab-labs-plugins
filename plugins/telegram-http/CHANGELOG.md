## 1.22.1 — 2026-08-18

- **FIX (regression introduced in 1.21.0): the `import.meta.main` guard silently disabled every agent-inbox daemon.** `plugins/agent-inbox/server.ts` is a shim that sets `CHANNEL_INBOX_ONLY=1` and `await import`s this engine ("獨立 = instance, not codebase"). Under that import `import.meta.main` is FALSE, so `startListen()` never ran and the daemon came up without listening — `/healthz` dark, no MCP, no wake/comms path. Guard is now `import.meta.main || process.env.CHANNEL_INBOX_ONLY === '1'`.
  - Caught on the lab canary during the 1.22.0 rollout, before it reached a second agent. Blast radius: one (claude-financial-assist), restored. The other ten inbox daemons were never restarted onto the bad code because fleet rollouts only kickstart `com.btai.telegram-daemon.*`, not `com.btai.agent-inbox.*` — luck, not design.
  - Lesson recorded: this engine has TWO legitimate entry points. Any change to startup conditions must be validated against both the direct-run path and the shim-import path.

