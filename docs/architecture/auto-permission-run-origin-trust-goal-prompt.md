# Goal: Host-Recorded Run-Origin Trust for Auto-Permission

**Status: SUPERSEDED (2026-07-13).** The run-origin machinery was removed in
Stage A of `docs/architecture/auto-permission-action-based-goal-prompt.md`;
auto mode now judges the action, not the requester. Historical record below.

Closes the r13 P1: interactive auto-allow must be authorized by the actual,
channel-authenticated human who triggered *this* run, established from host state
and bound to a host-trusted run id — never from runner-supplied IPC fields, and
never by scanning arbitrary recent message history.

## Problem

The permission IPC request is authored entirely by the runner (untrusted). Prior
fixes circled the trust question across four review rounds:
- Trusting `request.senderId` as approver proof → forgeable by a compromised runner (r12).
- Deriving trust/intent by scanning recent conversation history → not bound to the
  triggering turn, so in a group a non-approver can trigger a call that matches an
  older approver message and be auto-allowed (r13).

The only safe source is the host's own record of who triggered *this specific run*,
looked up by a run id the host trusts via the IPC auth material it issued.

## Objective

For an interactive auto-mode permission request, `resolvePermissionAuthority`
derives `trustedRequester` and the operator `intent` from a host-recorded run-origin
record keyed by a **host-trusted runId** (recovered from the authenticated IPC
response key, not `request.runId`). Unattended scheduled runs keep their existing
host-verifiable path. Any gap fails safe to the normal human prompt. `request.senderId`
and `request.turnIntentSummary` never influence the decision.

## Locked decisions

1. **Persisted, keyed by canonical runId.** Live turns are durable and worker-routable
   (`docs/architecture/multi-worker-execution.md`), so an in-memory map is insufficient.
   Persist the origin so the worker handling the permission IPC can read it.
2. **Run-origin record fields:** `run_id` (PK), `app_id`, `agent_folder`, `target_jid`,
   `provider_account_id`, `thread_id?`, `triggering_sender_id?`, `sender_is_approver`
   (bool, host-computed at spawn), `triggering_message_timestamp?`, `triggering_message_id?`,
   `is_scheduled` (bool), `created_at`. Written host-side at spawn.
3. **Trusted runId, not `request.runId`.** The host issues a per-run response signing key
   (`responseKeyId`) at spawn (`ipc-auth.ts:197`). Bind `responseKeyId → runId` there. At
   permission receipt (`ipc.ts`), after the request authenticates against a known
   `responseKeyId`, recover the bound runId and thread it as the trusted runId into the
   decision. If the recovered runId is absent or disagrees with any authenticated binding,
   fail safe (treat as untrusted).
4. **Decision reads origin, not history.** `resolvePermissionAuthority` takes the trusted
   runId, loads the origin via a new dep `getRunOrigin(runId)`, and sets:
   - interactive: `trustedRequester = origin.senderIsApprover === true`;
   - unattended: keep `unattended && jobId` (host-run-nature), unchanged;
   - `intent`: the triggering message content — either stored on the origin record, or
     loaded from the message store bounded to `origin.triggering_message_*` and filtered to
     `origin.triggering_sender_id`. Never the runner `turnIntentSummary`.
   Remove the current future-cursor message-history scan. Fail safe (untrusted / intent
   'none') when no origin, no approver, or any lookup error.
5. **Fail-safe only.** The change may only ever *remove* trust; any ambiguity → human prompt.

## Stages

### Stage A — run-origin persistence
New store keyed by `run_id` with the Locked-decision-2 fields: Drizzle schema table
(`run_permission_origin`) + migration, a `RunPermissionOriginRepository` port
(`upsertRunOrigin`, `getRunOrigin`), and its Postgres implementation. Follow the existing
repository/port/schema patterns (see `worker-coordination` repo/port/schema for shape).

### Stage B — record origin at spawn
In `group-agent-runner.ts`, after `runState.runId` is assigned and
`memoryReviewerUserId` / `memoryReviewerIsControlApprover` are computed, upsert the run
origin (triggering sender, approver flag, target jid, provider account, thread, triggering
message cursor from `options.turnMessages`, `is_scheduled` from the run kind). Also record
origin for the scheduled/job spawn path with `is_scheduled: true`. Best-effort write behind
a try/catch that never blocks the run.

### Stage C — bind responseKeyId → runId and recover trusted runId
`ipc-auth.ts`: when creating the per-run response signing key
(`createIpcAuthEnvelope`, ~:197), record the association `responseKeyId → runId` (in the
same `responseSigningKeys` registry entry or an adjacent host-side binding). Expose a
host-only lookup `trustedRunIdForResponseKey(responseKeyId)`.
`ipc.ts` (permission receipt, ~:550-598): after the request
authenticates, resolve the trusted runId from the authenticated `responseKeyId` binding and
pass it into `processPermissionInteractionIpc` → `resolvePermissionIpcDecision` as a
host-derived field distinct from `request.runId`. Never fall back to `request.runId` for the
trust decision.

### Stage D — decision reads run origin
`ipc-permission-classifier-decision.ts`: add `getRunOrigin` to deps;
`resolvePermissionAuthority` uses the trusted runId to load the origin and derive
`trustedRequester` + `intent` per Locked decision 4. Remove the message-history scan added
in the prior fix. Keep the unattended scheduled branch.

## Surface Impact Matrix

| Surface | Impact |
| --- | --- |
| storage/postgres schema + migration | new `run_permission_origin` table |
| domain/ports | new `RunPermissionOriginRepository` |
| storage/postgres/repositories | new Postgres repo impl |
| `apps/core/src/runtime/group-agent-runner.ts` | write origin at spawn (interactive + scheduled) |
| `apps/core/src/runtime/ipc-auth.ts` | bind responseKeyId → runId; trusted-runId lookup |
| `apps/core/src/runtime/ipc.ts` | recover trusted runId at permission receipt, thread it |
| `apps/core/src/runtime/ipc-permission-classifier-decision.ts` | read origin, drop history scan |
| wiring/bootstrap | inject `getRunOrigin` dep into the permission path |

## Acceptance criteria

1. A forged `request.senderId` / `request.turnIntentSummary` has zero effect on the
   auto-allow decision (covered by unit tests at the decision seam).
2. Interactive auto-allow happens only when the host-recorded origin for the trusted runId
   has `sender_is_approver === true`; a non-approver-triggered run is never auto-allowed even
   if an approver spoke earlier in the conversation.
3. The intent used is the triggering turn's message, not later history and not the runner
   summary.
4. Missing origin / lookup error / unknown responseKeyId → untrusted → human prompt.
5. Scheduled unattended runs still auto-classify.
6. Focused unit tests + PG-gated repo test + typecheck + architecture + task-completion gates.

## Verification & smoke

- Unit: decision seam with a mock `getRunOrigin` (approver vs non-approver vs missing);
  ipc-auth binding + trusted-runId recovery; spawn writes origin.
- PG-gated: `run_permission_origin` upsert/get round-trip.
- Runtime smoke (Telegram group, auto mode): approver triggers `list my drive files` →
  silent allow; a non-approver in the same group triggers a matching command → still prompts.
- Full closeout: build, gates, PG-gated suites, codex autoreview until clean.

## Bounded write scope per stage

Each stage names its files above; codex implements one stage at a time, orchestrator verifies
and commits between stages, then the autoreview loop to clean before merge.
