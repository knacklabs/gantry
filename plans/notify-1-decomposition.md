# NOTIFY-1 — decomposition

**Story:** Runtime-neutral structured job-completion notifications with per-provider native cards.
**Epic:** observability · **Branch:** `feat/DIAG-2-structured-completion` (base `main`, includes DIAG-1).

The scheduled-job completion notification dumped the agent's raw, mid-word-truncated
narration. This story makes it a structured, accurate, runtime-neutral card, rendered
natively per provider. Codex diagnosis anchored each seam (file:line below).

## Tasks

| # | Task | Scope / seam | Status |
|---|------|--------------|--------|
| T1 | **Base structured card** | `status-formatting.ts`: stats line from diagnostics + sentence/word-boundary truncation (never mid-word). Card only; durable summary keeps raw narration. | ✅ done (committed, autoreview clean) |
| T2a | **Heartbeat final flush (both runtimes)** | `anthropic-claude-agent/runner/job-heartbeat.ts` + `deepagents-langchain/runner/job-heartbeat.ts`: emit a final, idempotent snapshot on `stop()` so sub-15s runs report real tool counts. | ✅ done (committed, autoreview clean) |
| T2b | **Browser-action routing** | Route confirmed browser `JOB_TOOL_ACTIVITY` (`ipc-browser-handler.ts:493`, `browser-activity-events.ts:61`) into the diagnostics reducer (`execution-diagnostics.ts:149/177/274/490`) with dedup, so `browserActivityCount` reflects a real action, not just prelaunch. One neutral reducer; no engine branching. | ⏳ pending |
| T3 | **`jobNotificationView` plumbing** | Add a typed view to `MessageSendOptions` (`domain/types.ts:532`, mirror `reviewMessageView`); thread it through `sendJobNotification` (`delivery.ts:220`) / `execution-notifications.ts` alongside the neutral fallback string. | ⏳ pending |
| T4 | **Telegram native renderer** | `channels/telegram/channel-delivery.ts`: render the view as HTML/expandable card + existing inline keyboard. | ⏳ pending |
| T5 | **Slack native renderer** | `channels/slack/channel-delivery.ts`: Block Kit card (header/context/section) from the view. | ⏳ pending |
| T6 | **Discord native renderer** | `channels/discord.ts` / `discord-delivery.ts`: embed from the view + existing buttons. | ⏳ pending |

## Invariants
- The neutral markdown string is always produced (persistence, accessibility, unsupported channels); native views are an enhancement branch inside each provider's `sendMessage`.
- Diagnostics stay a single neutral reducer — the formatter never branches on runtime.
- Durable `job.completed.summary` / `result_summary` keep the raw narration for diagnosability.

## Sequencing
T2b and T3 are independent and can land in either order. T4/T5/T6 all depend on T3 (the view).
Everything lands on one branch → one PR (per the "all in one" decision), declaring each window ticket.
