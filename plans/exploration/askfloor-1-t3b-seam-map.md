# ASKFLOOR-1-T3b seam map — memory consult (Codex gpt-5.6-terra @ high, read-only, 2026-09-06, on the T3a task worktree)

# ASKFLOOR-1-T3b seam map

## 1. Coordinator stages and insertion points

The named, pinned order already reserves T3b’s two stages:

`pre_coordination_route_analysis → exact_remembered_deny → hard_restrictions → reviewed_rules → deterministic_rails → conditional_trusted_root → remembered_allows → classifier_cache → tail` — `apps/core/src/runtime/permission-decision-coordinator.ts:46-56`, pinned in `apps/core/test/unit/runtime/permission-decision-coordinator.test.ts:314-325`.

- The exact-deny slot is explicitly a no-op immediately before hard restrictions: `permission-decision-coordinator.ts:102-107`. T3b’s deny consult belongs here, before `hardDenyReason`, locked preset, and fixed-image checks (`:107-123`).
- Reviewed rules precede rails (`:124-146`); family-rule handling follows the single base rail evaluation (`:147-183`).
- The base rail result is computed once at `:147-156`. Trusted-root processing runs only for an ASK with `out_of_trusted_root` (`:187-212`, helper `:321-379`).
- Today, a rail ASK with no `analysis` exits to `tail` at `:202-208`; with analysis it reaches the reserved remembered-allow slot at `:213`, then classifier-cache read at `:214-265`, then tail at `:266-270`.
- Therefore T3b’s allow stage belongs at `:213`, before classifier cache and tail, and must replace the analyzed out-of-root fall-through rather than weaken the rail. Exact allow, then kind allow, then place allow should be attempted only after the non-overridable rails have survived.

T1’s seam is present:

- `CoordinatePermissionDecisionInput.analysis?: AutoLaneAnalysis` and `tail(context?)` are at `permission-decision-coordinator.ts:58-84`.
- IPC derives the lane once from effective mode and host-derived job id at `runtime/ipc-permission-classifier-decision.ts:90-103`, passes it to the coordinator at `:181-192`, and the coordinator freezes it with the rail result for the tail at `permission-decision-coordinator.ts:153-156`.
- The tail classifier consult consumes `context.analysis.lane` at `ipc-permission-classifier-decision.ts:330-334`; rail-veto relaxation is limited to `interactive_auto` and the two named signals at `:393-422`.

## 2. T3a outputs consumed by T3b

- Human decision domain model:
  - remember resolution and guards: `apps/core/src/domain/human-decision.ts:13-33`;
  - memory-write DTO: `:35-49`;
  - typed provenance payload and fail-closed codec: `:51-105`.
- The memory port defines human rows with `outcome`, `scope`, `scopeKey`, person identity, rail version, provenance, and revocation fields at `apps/core/src/domain/ports/permission-decision-memory.ts:34-58`.
- It exposes `listHumanDecisions` and `countExactAllowsByTool` at `:186-205`, but has no active lookup by person/scope key. T3b needs a person-scoped active lookup, e.g. `getActiveHumanDecision({ appId, agentFolder, actingPersonId, scope, scopeKey, railVersion })`, or a batched equivalent for the candidate keys. It must exclude revoked rows and reject stale rail versions.
- Scope-key derivation is `deriveHumanDecisionScopeKey(...)` at `apps/core/src/application/permissions/human-decision-scope.ts:45-88`.

At consult time, derive these candidate keys:

1. exact deny: `outcome: deny, scope: exact` — full effect hash (`human-decision-scope.ts:54-59,72-74`);
2. exact allow: `outcome: allow, scope: exact` — path-only for eligible native/virtual writes, otherwise full hash (`:75-87`);
3. kind allow: `outcome: allow, scope: kind` (`:60-65,176-222`);
4. place allow: `outcome: allow, scope: place`, using the canonical root obtained through trusted-root handling (`:66-70`).

Rail invalidation is by `railVersion` stored in every row (`permission-decision-memory.ts:52-54`) and the current `RAIL_CATALOG_VERSION` constant (`apps/core/src/domain/permission-effect-key.ts:29-33`). The effect hash itself also frames both effect-schema and rail versions (`:67-76`).

## 3. Acting-person identity

### IPC

- `PermissionApprovalRequest` has optional `personId` at `apps/core/src/domain/types.ts:179-205`.
- Spawn registration receives `memoryUserId` and stores it in the host restriction at `runtime/agent-spawn-permission-run-restriction.ts:21-53`.
- Before coordinator resolution, IPC reads that restriction and overwrites the request with the host-owned `memoryUserId` and `jobId` at `runtime/ipc-interaction-processing.ts:132-158`; the same request object then enters `resolvePermissionIpcDecision` at `:241-250`.
- The classifier input does not currently carry `personId`: its supplied fields are visible at `runtime/ipc-permission-classifier-decision.ts:353-387`. This is correct for classifier trust isolation; T3b’s coordinator consult should consume `request.personId`, not add identity to classifier input.

### Inline

- Inline run context carries `run.memoryUserId` into core-tool context at `apps/core/src/app/bootstrap/inline-agent-loop-tools.ts:153-178`.
- But the third-party-MCP permission request sets only `senderId`, not `personId`, at `:362-387`. Thus inline currently cannot make a person-scoped memory consult despite possessing the host run identity.
- T3b needs to stamp `request.personId: run.memoryUserId` for a non-scheduled inline live run, subject to the same interactive-auto gate. Scheduled identity/projection remains T4 territory.

## 4. Inline dependencies and consult seam

- `InlineCoreToolHostDeps` exposes classifier access and repositories, but no decision-memory port: `apps/core/src/app/bootstrap/inline-agent-loop-tool-types.ts:23-53`.
- The inline request enters `coordinatePermissionDecision` with only hard restrictions, access preset, reviewed decision, and a tail: `inline-agent-loop-tools.ts:389-395`. It currently supplies no `analysis`, effect hash, deterministic rails input, or decision-memory port.
- Its tail locally sanitizes input and calls the classifier at `:399-445`; this is the exact live-consult seam owned by T3b.
- Wiring is centralized in `wireInlineAgentLoopTools` (`:572-624`) and creates the host deps object at `:642-662`. Runtime services invokes that wiring from `apps/core/src/app/bootstrap/runtime-services.ts:331-342`.

The minimal injection shape is a typed optional `getPermissionDecisionMemoryRepository(): PermissionDecisionMemoryRepository | undefined` in the inline host deps and wire input, then passing its value to the coordinator. To make the consult genuinely equivalent to IPC, inline also needs to derive and pass `AutoLaneAnalysis`, the effect hash, and the deterministic-rail inputs before the tail; otherwise the coordinator sees no lane and takes the current no-analysis rail-to-tail exit.

## 5. `decidedBy` and provenance plumbing

- `PermissionDecisionSource` already includes `'human_decision'`: `apps/core/src/domain/types.ts:251-260`.
- `PermissionApprovalDecision` carries `decidedBy`, `source`, `reason`, and typed rail provenance at `:300-314`.
- `decisionForMode` maps recognized machine deciders through `PERMISSION_PROVENANCE_BY_DECIDER` (`apps/core/src/domain/permission-decision.ts:69-115`). `human_decision` is not yet in that map, so merely calling it with `decidedBy: 'human_decision'` would currently fall back to `human_once`.
- T3b must add the canonical machine mapping and construct:
  - allow: `decisionForMode(request, 'allow_once', 'human_decision', 'machine')`;
  - deny: the corresponding `cancel` decision with the same decider/source.
- The row provenance is not free text: it is decoded from the `human_decision:` codec carrying record id, person, outcome, scope, and rail version (`domain/human-decision.ts:51-105`).
- For exact remembered deny, the contract’s agent-visible reason is: `denied by your remembered No to this exact command (<date>) — /permissions to change`. The date should come from the matched human-decision record’s `createdAt`, not inferred from provenance.

## 6. Existing tests and tap-budget harness

Coordinator test style:

- Uses a small shared request fixture and `vi.fn` fakes: `apps/core/test/unit/runtime/permission-decision-coordinator.test.ts:31-48`.
- The stage-order test records calls in an array, injects rails and partial memory fakes with `as never`, and asserts exact ordering at `:314-389`.
- Existing precedence/cache pins include cache-hit skips-tail (`:565-600`), ASK rail skips cache (`:688-720`), and locked preset outranks cache (`:722-740`).
- T3b should add seeded human rows to a typed fake lookup and explicitly assert: exact deny skips rails/classifier; allow skips classifier/tail; stale rail version and revoked rows fall through; ask, auto_strict, and job lanes make no human-memory lookup.

Tap harness:

- `apps/core/test/unit/runtime/askfloor-tap-budget-harness.ts:13-36` defines replay fixtures; `replayPermissionRequest` counts approval calls as taps and executes the real IPC decision path at `:42-138`.
- It currently has no `personId` or decision-memory-repository fixture injection, so it cannot yet prove a remembered-person replay.
- Existing scenarios pin S1 and S3 in `apps/core/test/unit/runtime/askfloor-tap-budget.test.ts:22-85`. The plan assigns the remembered-allow S2 fixture to T3c, not T3b (`plans/active/ASKFLOOR-1-the-judge-actually-judges-context-aware-first-asks-in-auto-mode.md:155,191-192`).

## 7. Constraining decisions

- **0154** — human decisions are person-scoped interactive-auto memory; exact No is checked before hard restrictions, allows only after non-overridable rails, order is exact/kind/place, and ask/auto_strict/jobs/groups do not consult directly: `docs/decisions/0154-human-decision-memory-generic-scope.md:13-21`.
- **0121** — a host-verified job must not consult the classifier; job identity is the registry job id, not worker input: `docs/decisions/0121-autodet-no-classifier-autonomous.md:24-34`.
- **0043** — classifier judges risk only; authorization belongs to deterministic coordinator stages: `docs/decisions/0043-classifier-risk-only-engine-authz.md:18-37`.
- **0118** — `memoryUserId` is the host-stamped acting identity for live turns; scheduled work uses `execution_context.personId`: `docs/decisions/0118-identity-scoped-approval-and-grants.md:37-52`.
- **0153** — jobs may consume only live-projected remembered Allows as declared grants; they never consult remembered No directly, and projection is T4: `docs/decisions/0153-learned-decisions-project-into-job-grants.md:13-20`.
- **0155** — interactive-auto-only posture; ask, auto_strict, and job semantics remain closed, while inline’s lane-less classifier path is a separate constrained path: `docs/decisions/0155-default-allow-gantry-tools-interactive-auto.md:13-22,24-36`.

## Open questions for the T3b contract

- What exact active-lookup port shape is required: one ordered multi-key query, or four individual person-scoped lookups?
- Does the lookup enforce `railVersion` only, or also require `effectSchemaVersion` equality for non-path-only exact records?
- On database/port failure, does T3b fail closed by treating memory as no match and continuing to the existing tail?
- When an existing trusted-root grant and a remembered place allow both cover an out-of-root request, which provenance wins?
- What date format/time zone is required for the remembered-No reason line?
- Is `run.memoryUserId` sufficient evidence of a DM on the inline live path, or must T3b add an explicit DM/eligibility guard before consultation?
