# Review brief — lite window Q-0093 (outcome contract at the end of every scheduled run's prompt)

Facts: Q-0091 made the terminal notice lead with an `Outcome:` headline lifted from the run's final message; the contract was stated only as a profile-guidance bullet, and the first live run (4e1f2de0, 2026-08-26) ignored it — its final message was mid-work narration, so no headline rendered.

Contract for this diff:
- `scheduledJobRunPrompt(job)` appends ONE trailing paragraph to the job prompt for scheduled runs (idempotent by an ends-with check ignoring trailing whitespace; the original prompt is never modified — the paragraph is appended after it; system jobs such as memory dreaming are returned unchanged) stating that the final message must begin with `Outcome: <one sentence…>`.
- execution.ts uses it for the run's baseInput prompt only; memory collection still receives the raw job prompt.
- Job- and provider-neutral; no change to notices, renderers, or delivery.

Focus: idempotency when a job prompt already contains the paragraph (e.g. prompts edited by users), system-job exclusion, and that the appended text cannot alter the job's own instructions (it is additive, at the end, plain text). Ignore style.
