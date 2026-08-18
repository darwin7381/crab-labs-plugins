## 1.22.3 — 2026-08-18

- **cap re-delivery so a frozen transcript cannot loop forever.** Consumption is inferred from transcript progress, so an agent whose transcript stops advancing while it is otherwise alive can never be observed to consume anything. Observed live: `claude-financial-assist`'s transcript froze at ~32MB while the agent kept completing turns and replying — so every delivery read as unconsumed, was re-persisted, and 1.22.0's timer drain immediately replayed it. Same message re-delivered every ~10 minutes, indefinitely. Before the timer drain this merely parked silently; the drain converted a silent park into a loop.
  - After `MAX_REDELIVERIES` (default 3) the agent demonstrably has the message — it was pushed that many times — so re-persisting again cannot help. Stop, drop it from tracking, and log loudly that the SESSION needs investigating, not the queue.
  - This is the intended asymmetry preserved: still never a false ack, but bounded noise in the false-stall direction rather than an unbounded loop.

