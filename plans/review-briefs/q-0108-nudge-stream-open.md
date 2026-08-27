# Review brief — lite window Q-0108 (keep the SDK input stream open for one nudge turn on scheduled runs)

Facts (live run 00b9a0a9, 2026-08-27 03:59Z): scheduled runs start with `enableIpcFollowups=false`, and `query-loop.ts` ended the input stream right after the initial prompt, making the session single-turn. The Q-0105 nudge was pushed at the turn boundary into an ended stream and was never seen; the run ended mid-work again.

Contract for this diff (query-loop.ts only):
- Scheduled runs no longer end the stream at start; other followups-disabled runs unchanged.
- In the result branch, after the turn boundary: if the nudge was accepted on this result the query continues; otherwise the stream is ended so the session completes as before. At most one extra turn per run.
- IPC follow-up polling stays gated by `enableIpcFollowups` (still off for jobs).

Focus: the stream is always ended eventually (no hung session: second result → end; result with Outcome → end; close sentinel → end); no change to chat runs. Ignore style.
