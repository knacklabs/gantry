# ASKFLOOR-1-T6 seam map (pre-plan reading, 2026-09-09)

Story plan lines: AF-AC5 (outage latch), AF-AC6 (invariance suite), AF-AC7 (gates), AF-AC8 S6 (tap budget), T6 paragraph at line 200. Depends on T4 and T5b (both merged after #496). user_facing: true.

## What exists

- **One shared consult helper serves both paths.** `runtime/permission-classifier.ts:255 consultPermissionClassifierBeforePrompt(...)` is called from the IPC decision (`runtime/ipc-permission-classifier-decision.ts:385`) and the inline loop (`app/bootstrap/inline-agent-loop-tools.ts:373`). The story plan's "BOTH hooks" therefore collapse to: one latch consulted inside/around this helper, with each caller supplying the latch key and the notice delivery.
- **Typed status** `domain/permission-classifier-status.ts`: `Answered | Unavailable | Skipped`. No `wiring_missing` value exists anywhere in the tree (checked 2026-09-09; T2a never added it) — T6 adds it to the `PermissionClassifierFailureCode` string union at `runtime/permission-classifier.ts:60-67` (values: llm_unconfigured, timeout, aborted, model_resolution_failure, query_error, parse_failure, validation_failure), not a new status and not a domain file.
- **Failure path**: `permission-classifier.ts:227-232` maps errors to `failureCode` (timeout vs other) and returns `failedResult(...)`; the callers already fail closed to ask. AF-AC5's "explicit provenance" is the reason string at `inline-agent-loop-tools.ts:~418` ("Classifier requested human approval: …") and the IPC equivalent.
- **Latch key inputs**: IPC caller has `input.request.appId`, `agentId`, `agentFolder`, `runId` (no provider account / conversation on the consult input — they live on the request/route upstream in the same file); inline caller has `run.appId`, `run.chatJid` (used for `publishRuntimeEvent`), `deps.publishRuntimeEvent`. Provider account: derive from the conversation JID/route as T5b did (`appIdFromConversationJid`, route account axis from RACE-3).
- **Notice delivery**: inline path already publishes runtime events with `conversationId: run.chatJid`; the IPC path delivers cards through the prompt/notification pipeline. The one-per-episode notice should ride the existing notification send that precedes the first offline card (both lanes), not a new channel call.
- **No outage code exists** (`grep outage|degradedNotice|judgeUnavailable` → only jobs/execution-finalization.ts, unrelated).
- **Tap-budget harness** `test/unit/runtime/askfloor-tap-budget.test.ts`: S1–S4 + TB1–TB4 + mirror fixtures exist; S6 is the slot T6 adds ("judge offline = one notice per episode, reads inside trusted roots or a learned scope unaffected, an uncovered read asks at most once and Allow still remembers while offline"). Harness file `askfloor-tap-budget-harness.ts` has the revokeById/learning paths real since T5b.

## Ceilings that bite

- `permission-classifier.ts` 688/700 → the latch is a NEW module (`runtime/permission-judge-outage-latch.ts`), the helper only calls it.
- `inline-agent-loop-tools.ts` 708/750 (per-file ceiling in scripts/architecture-map.json:31) → hook = a few lines, no new logic there.
- `ipc-permission-classifier-decision.ts` 691/700 → same: a call, not logic.

## Proposed write scope (target ≤ 15 files)

Source (4): NEW `runtime/permission-judge-outage-latch.ts`; `runtime/permission-classifier.ts` (consult helper calls the latch + returns a `noticeDue` flag); `runtime/ipc-permission-classifier-decision.ts` (deliver notice before first offline card; provenance text); `app/bootstrap/inline-agent-loop-tools.ts` (same, inline); no domain file: `wiring_missing` joins the failure-code union inside permission-classifier.ts. Source count = 4.
Tests (≤ 8): NEW latch unit suite; `permission-classifier.test.ts` (unavailable → noticeDue once per key, reset on Answered); `ipc-interaction-handler.test.ts` or the IPC decision suite (notice once, card follows, deterministic read-only still allows); `inline-agent-loop-tools.test.ts` (same inline); NEW `askfloor-invariance.test.ts` (AF-AC6 explicit lanes — may be large; it is table-driven over existing fixtures); `askfloor-tap-budget.test.ts` + harness (S6); scheduled-job lane pin (deterministic denial + card recovery unchanged).

## Owner questions to bundle in the grill (owner-level only)

1. Notice copy (one line, plain): proposal "The permission judge is offline. I'll ask before anything that isn't clearly read-only until it's back."
2. Episode reset: on the first `Answered` after `Unavailable` (proposal) vs a time window.
3. Does the latch survive a runtime restart? Proposal: process-local only (AF-AC5 says process-local).
4. D-0080 pickup: T6 does not touch the listing/Forget/used-by read → D-0080 stays deferred (proposal).

## Contract clauses to pre-check against the layer rules (T5b lesson)

- The latch module is `runtime/` → may import domain + shared only.
- The notice send from the IPC path must go through the existing notification port, not a channel import (application/runtime cannot import channels).
- Any new status value is domain-owned; do not describe it as application-owned.
