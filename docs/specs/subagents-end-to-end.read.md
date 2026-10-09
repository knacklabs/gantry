---
reader: codex (gpt-6.1-sol)
read_at: 2026-10-02T16:05:22+00:00
read_hash: 00aa797af105c419a8d080c2c1ff0fa3c65e2d74
round: 2
passed: yes
doc_seen: 00aa797af105c419a8d080c2c1ff0fa3c65e2d74
spec_seen: e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
notes_seen: 38054e83027ac89f56f2448fa210e5da7fea1612
---
# Cold read notes

Written by `forge read`. Under every finding, write one disposition line, amend the doc, then run
`forge read <doc>` again for the next round, until a round finds nothing:

- `Disposition: cut` when the doc was edited to remove it;
- `Disposition: defer` when the item moved to the spec's Out of scope;
- `Disposition: keep <one-line reason>` otherwise.

Only a genuine trade-off goes to the human, as a question with options.

## Round 1

1. AC1 promises a full answer, but the result envelope only defines a short summary.
   Pin where unstructured answer text lives and how the parent retrieves large answers. Existing [result handling](/apps/core/src/shared/delegated-task-result-policy.ts:1) truncates tool context at 4,000 characters; storing the full answer and returning it inside the turn are different contracts.
   Disposition: keep amended: Defined complete answer text or a file reference, scoped retrieval and matching wait-mode acceptance criteria.

2. Deadlines, budgets and concurrency limits are not defined sufficiently to enforce.
   Specify defaults, who may lower or raise limits, what counts as a turn, how unavailable cost data is handled, and whether exceeding the parent cap queues or refuses work. Pin whether queue time, permission waits and downtime consume the deadline. Add acceptance criteria for exhaustion and limits surviving recovery.
   Disposition: keep amended: Pinned limits, change authority, turn and cost accounting, deadline consumption, cap refusal and recovery checks in Behaviour and AC9.

3. Background delegation from a job has no defined settlement rule (AC6).
   Background children survive parent-turn completion, but job children must never outlive the job and must contribute to its result. Decide whether job completion waits for children or cancels unfinished children and records that outcome; include deadline expiry and lease loss.
   Disposition: keep amended: Job settlement cancels unfinished children and records all outcomes; deadline expiry and lease loss stop children under the current lease owner.

4. Restart behaviour for an interrupted wait-mode call is unspecified (AC1/AC2/AC4).
   The adapter promises resume, while Risks permits reporting interruption. Specify which runs resume, what an interrupted waiting parent receives, and how interruption maps into the four terminal statuses. The smallest safe policy is to recover queued work and report interrupted running work unless resumption is required.
   Disposition: keep amended: Recover only never-started background work, cancel orphaned queued waits, fail interrupted running work without replay and deliver the saved outcome once.

5. The progress-card contract does not cover background work after its originating turn ends (AC7).
   The current [turn cleanup](/apps/core/src/runtime/group-processing.ts:822) retires the progress sender. Decide which card owns subsequent child updates, especially during another parent turn or after restart, and how timed-out and cancelled children appear.
   Disposition: keep amended: The current parent turn owns updates, retired cards stay retired and subsequent turns refresh saved states including timed out and cancelled.

6. Steering without a receipt has no bounded failure outcome (AC4).
   A child can finish, be cancelled, or become unreachable before acknowledging the message. Define what the caller receives in those cases and when waiting ends; “acknowledged only on receipt” alone allows another indefinitely waiting tool call.
   Disposition: keep amended: Added a 30-second receipt deadline and distinct received, not-delivered and unconfirmed outcomes with no automatic resend.

7. The success metric and target measure different outcomes.
   The metric counts only done tasks and excludes system timeouts; the target also counts failures with clear reasons. Define one numerator and denominator, including cancellations, deliberate deadline expiry, and tasks still unfinished after their deadline. Otherwise clear timeout failures can either satisfy or fail the same target.
   Disposition: keep amended: Metric and target now share a weekly admitted-task cohort and timely terminal-outcome definition including cancellations, timeouts and overdue unfinished work.

## Round 2

No findings.
