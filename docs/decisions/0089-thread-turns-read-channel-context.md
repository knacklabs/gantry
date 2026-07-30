---
status: proposed
confirmed_by: ""
date: 2026-07-30
---

# Thread Turns Read Channel Context — Pin the Guarantee, Restore the Window

## Context

A live report (GH-352, and an equivalent client screenshot) showed the agent
blind to a colleague's channel message when replying. Three separate efforts
converged on this in one day: kl-yash's PR #353 (unmerged), kl-arhan's
`75e1f0617` (merged), and this phase. Measurement against main @ `3623be890`
shows the real defect was **top-level mentions being routed into synthetic
empty threads** — fixed by `75e1f0617`
(`apps/core/src/channels/slack/channel-interactions.ts:81`,
`apps/core/src/channels/slack/channel-message-ingest.ts:201`). The suspected
defect — thread turns lacking channel context — does **not** exist:
`buildConversationContextPacket` unconditionally fetches the 30 most recent
top-level messages (`apps/core/src/runtime/conversation-context.ts:43`) and
the formatter always renders `<recent_channel_context>` before
`<active_thread_context>` (`apps/core/src/messaging/router.ts:70`).
Recorded via Forge signal `S-0001-2b7e` (raised and resolved pre-planning).

However, `75e1f0617` also shrank the thread window from 50 to 10 and removed
the first-replies block from long-thread selection — contradicting the
client's same-day direction to keep the measured 30/50 limits.

## Decision

1. **The guarantee, pinned:** an in-thread agent turn sees the thread window
   PLUS the same 30-message top-level channel background a channel turn sees,
   on every provider, with thread-selected messages deduped out of the channel
   block. This existing behaviour becomes a tested contract, not an accident.
2. **The window, restored:** `THREAD_CONTEXT_LIMIT` returns to 50. Long-thread
   selection returns to **root + first 10 replies + latest 39** (client
   choice 2026-07-30) — the thread's setup survives even when its middle is
   evicted. The mention-routing fix from `75e1f0617` is kept untouched.
3. Window sizes stay fixed constants — no settings knob.

## Consequences

- Thread turns carry up to ~80 historical messages (30 channel + 50 thread)
  before the formatter's 16,000-byte cap. Under the cap the formatter evicts
  **oldest channel lines first, then oldest thread lines**
  (`apps/core/src/messaging/router.ts:123`) — accepted boundary: background
  yields to the active conversation. Not a new knob.
- Slack's provider hydration mirrors the SAME selection shape: root
  (identified by the requested thread id, never positionally) + first 10
  non-root replies + latest 39 non-root replies, with a latest-only fallback
  when the root is absent and a bounded tail formula for small parameterized
  limits. Hydration stays single-scope — channel background on a thread turn
  comes from local storage only. With decision 0090 making persistence
  store-always, local channel history is complete going forward.
- Tests pinned to 10/9-shaped values flip to 50-shaped values; the first-10 +
  latest-39 selection tests return.
- Rejected: keeping the 10-message window (an unmeasured number from the
  issue text, contradicting the client's measured 50); root + latest-49
  (loses the thread's setup on long threads); making any of it configurable.
