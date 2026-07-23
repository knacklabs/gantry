---
name: no-status-clutter-in-chat
description: "PRODUCT DECISION (2026-07-19): conversation surface stays clean — no 'Done in Xm' duration stamps or status-text messages; liveness is AMBIENT ONLY (reactions, typing, edit-in-place card edits); never re-add duration text"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b85492d2-68c7-4c55-a5a3-551ccd75b3a1
---

User 2026-07-19: "We have removed Done in X minutes text altogether … We
should not clutter the conversation with these kind of messages."

**Why:** the chat is the product surface; status/duration stamps are noise a
user rereads forever. The "Done in Xm" text was deliberately removed earlier —
any reviewer/agent proposal to "restore duration display" is WRONG by default
(a Fable UX review made exactly that mistake; rejected).

**How to apply:**
- Liveness/progress signals must be ambient: reactions (seen/running flips),
  typing indicators, and replace-only edits of the ONE existing progress/todo
  card. Never additional messages, never appended status lines.
- When a chat-facing feature is removed, delete its full plumbing in the same
  cycle (the Done-in removal left: dead `elapsed` param in
  progress-updates.ts sendFinalProgressUpdate, Slack `/^Done in\b/` matcher in
  thread-progress-status.ts, unused `elapsed` in agent-todo-render.ts header,
  formatElapsed computation in group-processing.ts — cleanup dispatched
  2026-07-19).
- Related: [[notification-ux-redesign]] (mobile-first trim), quiet-until-
  terminal job notifications (#214).
