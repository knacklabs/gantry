# Chat-parity permissions for scheduled jobs

## What changes for you

IN: v9 sections A (ask-and-wait lane, need model, reconciler, card-revision
outbox, living card, lease/slot rules), B (browser prompt-naming fix only),
C (request_access + catalog + unprojected contract), D (truthful statuses),
the v9 Deletions (single-cut), one decision record. OUT: NOTIFY-3 result-card
rendering; JOBPERM-2 in-session reprojection; JOBPERM-3 toolbox-at-creation;
any interactive/chat behavior change; any classifier on autonomous runs
(0121); any weakening of the remote-content-execution boundary.

## Why

The autonomous permission lane hard-returns "denied" without waiting
(permission-callback.ts:265-276, timeout 0), so any scheduled-run tool call
needing a host decision dies: compounds (fixed by #434), Browser (granted yet
unreachable), request_access (itself denied), any unlisted tool. Six days of
"Needs permission" dead-ends in two weeks; runs killed, accuracy lost, reruns
required. Full validated design: plans/review-briefs/
scheduled-job-permission-parity-design.md (v9 FROZEN, 7 adversarial Codex
xhigh rounds, 57 findings resolved). This plan implements v9 verbatim.

## Done when

1. Unmatched grantable tool call raises the standard card; authorized Allow
   resumes the SAME run in place; rule persists; next run silent-allows.
2. Browser works for a granted job with no card (host verdict awaited).
3. Living card coalesces needs; revision/epoch-bound batch; no unseen
   approvals; provider contract tests on Telegram, Slack, Discord.
4. Deny terminal per need with Reconsider epoch; handoff card keeps Deny +
   human Approve-and-run-again.
5. Hard-boundary and unprojected cases yield typed truthful results, never
   permanent grants or auto-reruns.
6. v9 Deletions land: old autonomous lane paths removed, source-asserted.

## Tasks

| ID | Name | What it delivers | Covers | Scope | Tests | After | User-facing |
|---|---|---|---|---|---|---|---|
| T1 | Single-cut ask-and-wait lane core | Delete the parallel autonomous permission lane (v9 Deletions: worker hard-returns, hostJobId cancel, dead classifier-wait, dual auth/timeout rules) and make the one interactive path serve scheduled runs for the simple case: unmatched grantable need raises the standard card, tool call holds in the existing poll loop, authorized Allow resumes in place and persists to the job, Deny is terminal, Browser resolves from the host verdict with no card, denial texts truthful. |  | `apps/core/src/app/`, `apps/core/src/adapters/llm/anthropic-claude-agent/runner/`, `apps/core/src/runner/`, `apps/core/src/runtime/`, `apps/core/src/shared/`, `apps/core/src/application/`, `apps/core/src/jobs/`, `apps/core/test/`, `docs/decisions/`, `docs/specs/` | `apps/core/test/unit/application/jobperm-ask-and-wait.test.ts` | none | no |
| T2 | Durable needs, reconciler, living card | Implement v9 durability: need rows with asking_epoch reusing the pending-interaction store, one idempotent reconciler (approved_pending_apply/denied_pending_delivery/handoff), card-revision outbox, living card per job with revision+epoch-bound capacity-aware batch, actor-authorized clicks (0118), confirmed-delivery wait anchor, lease extension from host-monotonic pending intervals, slot release/re-acquire, waiter-scoped handoff card with Approve-and-run-again plus Deny, coalescing. |  | `apps/core/src/`, `apps/core/test/`, `docs/decisions/` | `apps/core/test/unit/application/jobperm-durability.test.ts` | T1 | no |
| T3 | Honest edges, catalog, provider contracts, live proof | Implement v9 edges: hard-boundary remote-content-execution equivalence class yields typed reformulation (never a grant), unprojected approvals persist and end the run Completed-with-limits with human Run-again, request_access always callable raising the same card, requestable-identity catalog in the runner prompt, provider contract tests for the card lifecycle on Telegram Slack Discord, agent-e2e plus the three live KnackLabs scenarios. |  | `apps/core/src/`, `apps/core/test/`, `docs/decisions/` | `apps/core/test/unit/application/jobperm-edges.test.ts` | T2 | no |

New moving parts: none named in the old plan

## Risks

Provider card semantics drift (mitigated: contract tests x3 channels);
lease-extension accounting bugs (host-monotonic union, tested for skew/
restart/overlap); losing the single-cut (mitigated: source assertions that
deleted paths are gone); scope creep beyond v9 (mitigated: v9 is frozen; any
deviation returns to the owner).

## Notes

Converted from plans/active/JOBPERM-1-chat-parity-permissions-for-scheduled-jobs.md by forge migrate.

### Technical Approach

Implement v9 exactly; it is the authoritative contract. Core seams:
soften the hostJobId cancel (ipc-permission-classifier-decision.ts:184-210)
into the interactive tail (:447); delete the worker hard-returns
(permission-callback.ts:265-276, permission-ipc-client.ts:228-239) so the
existing poll loop serves both lanes; extend the 24h auth purpose to
jobId-bearing requests; durable need rows (reusing the pending-interaction
store) with asking_epoch, one reconciler, card-revision outbox; lease-deadline
extension from host-monotonic pending intervals; slot release/re-acquire
around waits; persistence via the setup-pause wiring with the fingerprint
short-circuit extended; actor authorization via 0118 machinery. Every stage
is implemented by Codex via forge delegate with the v9 doc as review contract.

### Decisions

New decision: "Autonomous runs ask-and-wait (chat parity)" — supersedes the
cancel consequence of 0121, amends 0115; records the two owner-accepted
physics limits and the single-cut deletions. Consistent with 0053, 0056,
0106, 0118, 0124, 0134.

### Surface Impact

Runtime behavior only: scheduled jobs stop dead-ending on permissions; one
living approval card per job in the job's channel; truthful agent-facing
results. No API/schema change beyond the need-row reuse of the
pending-interaction store; no interactive-chat change; net non-test LOC down
outside the need/outbox modules (Deletions).

### Task Decomposition

T1 lane-core: the single-cut (Deletions) + ask-and-wait for the simple case
(one need, confirmed delivery, approve/deny, resume, persistence, truthful
results, browser await). T2 durability: need states + reconciler +
card-revision outbox + epoch/actor binding + lease/slot rules + handoff +
coalescing/living card. T3 edges + live proof: hard-boundary equivalence
class, unprojected/catalog/request_access contract, provider contract tests,
agent-e2e + live KnackLabs scenarios.

### Verify Plan

python3 factory/scripts/verify.py green per stage; the v9 validation-plan
unit list mapped into required_tests per task; autoreview per stage with the
v9 doc as --prompt-file; live scenarios 1-3 on KnackLabs before pr_ready.

### Implementation Assumptions

<!-- Made during implementation, NOT part of the approved plan. Dev: review these before merge; promote any that matter to docs/decisions/. -->
- 2026-08-23: JOBPERM-1-T2 reuses pending_interactions by storing one deterministic JSONB need row per job and canonical need identity plus one deterministic JSONB card/outbox row per job; no parallel permission-state table is introduced.
- 2026-08-24: Hard-boundary commands return a typed kind=reformulation_required code=remote_content_execution result to the model without creating a permission need, card, or terminal denial event.
