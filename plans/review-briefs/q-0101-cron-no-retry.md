# Review brief — lite window Q-0101 (cron jobs: no post-failure retry; next run = next cron slot)

Facts: after a failed run the retry branch wrote `next_run = now + retry_backoff_ms` and the notice printed it, but cron jobs are dispatched only by the pg-boss cron schedule (scheduler-engine.ts cron sync returns before the one-shot dispatch), so the retry never ran (2026-08-26: promised 14:57:08Z, nothing until the next slot; same after the 05:43Z timeout). Owner decision: no retry for cron jobs.

Contract for this diff: in the retry branch, cron jobs get `nextRun = nextRunOnSuccess` (computeNextJobRun); `once` jobs keep the backoff retry; consecutive_failures and dead-letter thresholds unchanged; manual unchanged.

BY DESIGN: consecutive_failures still increments on cron failures so dead-lettering after max_consecutive_failures still works across slots. Focus: the notice's Next run now equals the real next cron slot; no other branch touched. Ignore style.
