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
| T2b | **Browser-action routing** | Confirmed browser events tagged `phase:browser_action`, counted in the reducer, routed from the exchange. `browserActivityCount` = real action, not prelaunch. | ✅ done |
| T3 | **`jobNotificationView` plumbing** | `JobNotificationView` + `StructuredJobResult` on `MessageSendOptions`; built + threaded through delivery; channels still send fallback. | ✅ done |
| T4 | **Telegram native renderer** | HTML card + neutral `boundJobNotificationView` (cap items, code-unit-budget/code-point-boundary truncation, drop empty result). | ✅ done |
| T5 | **Slack native renderer** | Block Kit card (header/context/section) + fallback. | ✅ done |
| T6 | **Discord native renderer** | Rich embed (title/color/description/footer) + buttons + fallback. | ✅ done |
| — | **File-size budget bumps** | types.ts/execution.ts/telegram-delivery grew; budgets raised. | ✅ done |
| T7 | **Structured job result via a finish tool** | Schema-validated `job_report` tool the agent calls with `{headline, items:[{outcome, label, detail}], nextAction}`; capture its args on the run → the view's `result`. Renderers already render `result` when present. **Bigger — runtime tool integration.** | ⏳ pending |

## View shape (T3, carries the structured result for T7)
```
JobNotificationView = {
  status; jobName; durationMs?;
  stats?: { toolCount; browserUsed; lastAction? };   // from diagnostics
  result?: { headline?; items?: [{outcome:'done'|'skipped'|'failed'; label; detail?}]; nextAction? }; // T7
  fallbackText;   // neutral markdown card body — ALWAYS present
  nextRunAt?;
}
```
Renderers prefer `result`; fall back to `fallbackText`. Unsupported channels use `fallbackText` verbatim.

## Invariants
- The neutral markdown string is always produced (persistence, accessibility, unsupported channels); native views are an enhancement branch inside each provider's `sendMessage`.
- Diagnostics stay a single neutral reducer — the formatter never branches on runtime.
- Durable `job.completed.summary` / `result_summary` keep the raw narration for diagnosability.

## Sequencing
T2b and T3 are independent and can land in either order. T4/T5/T6 all depend on T3 (the view).
Everything lands on one branch → one PR (per the "all in one" decision), declaring each window ticket.
