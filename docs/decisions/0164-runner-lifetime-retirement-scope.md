---
status: accepted
confirmed_by: "Client (chat approval)"
date: 2026-09-22
stories: [cache-bug]
---

# Runner-lifetime retirement scope and preserved cross-process ceiling

## Context

Decision 0163 selects runner-lifetime Claude continuity and lazy retirement of
existing canonical provider handles. Decision 0003 generally forbids runtime
cleanup solely for old local state, and the earlier cache-bug grill selected a
manual pre-deploy reset. The requirements review identified that the exception
and reversal were not explicit. It also found that superseding 0158 left the
precise surviving cross-process ceiling rules outside the active corpus.

Implementation remains subject to the separate plan, task, verification, and
review gates; accepting this decision does not mark those gates complete.

## Decision

1. Amend 0003 only for the canonical, current-schema provider-session rows
   governed by 0163: a cold runner using `runner_lifetime` may retire its owned
   active or ready handle lazily through the existing identity/reset fence.
   This explicitly replaces the earlier manual pre-deploy Claude-handle reset
   choice. No general compatibility policy or migration service is introduced.
   Decision 0112 remains intact: malformed or legacy-shaped rows are never
   imported, reconstructed, repaired, or read through a fallback.
2. Preserve already-running maintenance ownership. A cold runner suppresses
   the locked handle without canceling the durable task or expiring its row.
   Existing work may complete or time out normally. Retire a resulting ready
   handle on a later cold encounter. No new runner-lifetime maintenance is
   admitted. Canonical messages, memory, events, and artifacts are retained.
3. Clarify 0163's unchanged cross-process ceiling contract in this active
   record: retain the nullable integer high-water mark; raise it once after a
   measured run to the maximum of existing and observed, clamped to the SQL
   integer maximum, behind provider ownership and null-safe reset fencing.
   Prefer `contextUsage.totalTokens`; otherwise use cache-inclusive
   `modelVisibleInputTokens` with existing per-provider inclusive/additive
   accounting (unresolved/mixed routes use additive). Billing remains unchanged.
4. For `cross_process`, retain the global revisioned 20,000–900,000 integer
   limit with default 150,000 and existing settings-reader version protection.
   A mark strictly greater than the limit triggers fenced active-to-expired
   retirement before resume. Ready promotion, maintenance exclusion, and
   same-generation memory carry remain unchanged. Null/at-or-under-limit marks
   resume normally. This allows an overshoot run; it is not a mid-run hard cap.
   No new reset, backfill, cleanup, checkpoint policy, or schema migration is
   introduced for DeepAgents. Accepted 0159 cleanup remains separately pending.
5. For `runner_lifetime`, policy precedes fingerprint/ceiling evaluation and
   compaction-delta replay. Retire ready rows directly with an explicit selected
   status, keeping active as the retirement API default. Never replay a retired
   session's compaction delta into a fresh briefing. Publish `runner_lifetime`
   only after a successful transition, with canonical session correlation and
   hashed provider handle, no raw handle, no runId, and no cap/high-water fields.

These are narrow amendments/clarifications of 0003 and 0163, not wholesale
supersession. Other provisions of those records remain in force.

## Consequences

- Owners need not bulk-reset Claude handles before deploying the fix. The
  runtime retains a bounded policy-enforcement path over supported canonical
  rows, accepting that narrow exception to the no-old-state-cleanup rule.
- In-flight maintenance is not stolen by another runner; rollout may temporarily
  retain a locked row, but a cold Claude runner must never resume it.
- Cross-process behavior has an active, explicit contract without restoring
  the superseded requirement to resume Claude across processes.
- No old SDK files are deleted by this decision. No extra model handoff, digest,
  active-work checkpoint, or automatic merge is authorized.
