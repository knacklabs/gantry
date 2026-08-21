# Review brief — DIAG-2: structured job-completion notification card

## Problem
A scheduled job's completion card showed the agent's raw stream-of-consciousness
narration, hard-truncated mid-word (`…find a soli`). Neither structured nor useful.

## Change (notification card only)
- **Stats line** (`status-formatting.ts` `terminalRunStats`): for terminal `completed`/`failed`
  cards, lead with a structured line built from the run diagnostics already available at
  completion — duration, total tool calls, browser used/not used, last tool. Threaded via
  `execution-notifications.ts` (`notifySchedulerTerminalRunState` now passes `diagnostics`).
- **Boundary-aware truncation** (`compactSummary`): cut at the last sentence end (`.!?`) or,
  failing that, the last whitespace boundary — never mid-word. Used at both call sites
  (default 180 and the terminal card's 360).

## Non-goals
Durable `job.completed.summary` / persisted `result_summary` are unchanged — they keep the
raw narration for diagnosability. Only the user-facing card changed. No capability-action
detail yet (that needs DIAG-1's data threaded in; separate follow-up).

## Tests
`status-formatting.test.ts`: terminal card includes the stats line; a long multi-sentence
body truncates at a sentence boundary and never mid-word.
