## 1.22.2 — 2026-08-18

- **ROOT CAUSE of the lost-message class: `replayPendingFromDisk` replayed into a session whose SSE was not yet open, then deleted the durable file.** `server.notification()` resolves even when the SSE stream is still pending — the write goes into a stream nobody is reading — and the replay treated that as success and `rmSync`'d the only durable copy. The session-open handler calls the replay ~0.2s after logging `MCP session opened (SSE pending)`, i.e. squarely inside the window.
  - Measured on the lab canary: a 6.5h-old parked delivery was "disk-replayed" at session-open+0.24s on TWO separate session-opens; the file was deleted both times and the content never appeared in the agent's transcript. The identical payload delivered 30s later by the 1.22.0 timer drain (which gates on `sseOpen`) landed and was acknowledged by the agent.
  - This is almost certainly what destroyed the principal's message on 2026-08-17: delivered 4s after a session opened, parked, then consumed by a later session-open replay without ever being delivered.
  - Fix: `replayPendingFromDisk` now returns 0 unless the target session's SSE is confirmed open. Files stay parked and the timer drain picks them up once the stream is real. `broadcastNotification` has always gated on `sseOpen`; this path never did.

