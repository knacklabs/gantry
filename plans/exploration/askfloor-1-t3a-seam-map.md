# ASKFLOOR-1-T3a seam map — decision-memory storage (Codex gpt-5.6-terra @ high, read-only, 2026-09-05)

The task boundary is persistence and domain/application contracts only; callback/settlement integration is explicitly T3c. Plan `plans/active/ASKFLOOR-1-…md:190`; task objective `.factory/stories/ASKFLOOR-1/decomposition.json` (ASKFLOOR-1-T3a).

## 1. Table, migrations, and drift gate

- Drizzle definition: `apps/core/src/adapters/storage/postgres/schema/schema.ts:66`. Columns: `id` (text PK), app/folder, `kind`, `lookupIdentity`, optional effect/decision/risk/root/principal fields, effect/rail versions, provenance, creation/expiry/revocation timestamps (`schema.ts:69`).
- Unconditional `(app_id, agent_folder, kind, lookup_identity)` `unique`, plus an active lookup index filtered on `revoked_at IS NULL` (`schema.ts:97`). No human-row `CHECK`, no `outcome`/scope/person columns, IDs are text not UUID.
- Sequential migration `0107_permission_decision_memory.sql`, amended by `0110_permission_decision_memory_risk.sql`; the newest migration overall is timestamped `20260827174119_agents_web_ui_foundation.sql` — the repo mixes sequential and timestamp naming, so T3a must pick the currently-live convention.
- Drift gate: CI runs `drizzle-kit check`, generates a disposable `ci_schema_drift` migration, requires no diff (`.github/workflows/ci.yml:63`; scripts `db:migrations:check`/`generate` in `package.json:57`).

## 2. Repository and existing cache/provenance seams

- Adapter: `apps/core/src/adapters/storage/postgres/repositories/permission-decision-memory-repository.postgres.ts:30`. `put` conflicts on the four-column key and reactivates revoked rows; `get`/`list`/`revoke` keyed the same way.
- Port: `apps/core/src/domain/ports/permission-decision-memory.ts:7` has generic `put/get/list/revoke` plus classifier-specific `putClassifierVerdict`/`getClassifierVerdict` (line 79).
- `allow_once` is rejected before any DB write (guard at line 17). Classifier cache uses `classifier_verdict` kind, effect hash as lookup identity, deterministic `pdm:` IDs (line 82).
- T2b's `writeIpcClassifierCache` excludes interactive-auto Gantry/native-file allows and tags provenance `'classifier'` (`runtime/ipc-permission-classifier-decision.ts:453`).
- `decidedBy` is a free-form string on `PermissionApprovalDecision` (`domain/types.ts:300`); PERM-4 (decision 0054) requires typed provenance/risk labels.

## 3. Effect-hash and canonical destination

- `computePermissionEffectHash` (full-effect) includes schema/rail versions, app/provider/conversation/folder/tool, canonical input (`domain/permission-effect-key.ts:48`). This stays the "No" scope key per 0154; T3a needs a separate path-only key for eligible Allows.
- Canonical-destination normalizers already exist per surface: native `FileWrite`/`FileEdit` → `judgeNativeFileWrite` extracts `file_path`/`path` (`application/permissions/native-file-write-risk.ts:7`); resolved native path → `evaluateProspectiveWriteBoundary` (`shared/permission-prospective-write.ts:13`); `file`/`write` and `file`/`promote_scratch` → `judgeFileTool` normalises virtual scope/path (`application/permissions/gantry-tool-risk.ts:117,134`); virtual path canonicalisation `domain/file-artifacts/virtual-path.ts:4`.
- `native-file-write-risk.ts:24` treats "every destination in workspace" as Low — not yet the "single-destination" rule; T3a's scope module adds that check itself.

## 4. Acting person, label, settlement paths

- ID-1: `PersonRecord.displayName`; identity resolution returns `personId` + matched/created alias (`application/identity/person-identity-service.ts:12,74`).
- Host stamps live-request identity via `permissionRunRestriction(...).memoryUserId`, overwriting any worker-supplied person ID (`runtime/ipc-interaction-processing.ts:132`).
- Ordinary callback claims carry only `approverRef` + timestamp, not canonical person ID/label (`application/interactions/pending-interaction-permission-callback.ts:292,579`).
- JOBPERM settled-card path builds durable approvals from `decidedBy`; final settlement for persistent/denied results uses a synthetic `job_permission_reconciler` actor (`app/bootstrap/job-permission-durability-wiring.ts:164,540`).
- `PermissionApprovalResult`/`PermissionApprovalDecision` have no acting-person field or label snapshot (`domain/permission-approval-result.ts:3`, `domain/types.ts:300`).

## 5. Application-service and architecture seams

- No existing service matches `remember/list/revokeById`. Closest precedent: `CapabilitySecretService` — constructor-injected domain port, `list`, `set`, `unset` (`application/capability-secrets/capability-secret-service.ts:17`).
- `PermissionManagementService.revokePersistentToolRuleGrant` is the nearer permission-domain precedent but too broad to reuse (`application/permissions/permission-management-service.ts:382`).
- Target location: `application/permissions/`, depending on the decision-memory domain port only. Architecture map: application → domain/ports/shared; no concrete adapters constructed in application; DB access stays in adapters (`docs/architecture/target-folder-structure.md:29`).

## 6. Tests and Postgres fixture

- Primary suite: `apps/core/test/integration/permission-decision-memory.postgres.integration.test.ts:18,21` uses `schemaPrefix: 'permission_decision_memory'`. Line 154 raw-insert test is the authoritative pin on the current four-column unconditional unique key — must be replaced when the two partial indexes land.
- Shared runtime: `createPostgresIntegrationRuntime` derives a schema from `schemaPrefix`, migrates, cleans up (`apps/core/test/harness/postgres-integration-runtime.ts:53`).
- Unit coverage: `permission-decision-memory-guard.test.ts:106` pins allow-once guard/risk-cache/expiry, not the SQL key; nearest unit-level lookup-key pin is trusted-root identity composition in `permission-decision-coordinator.test.ts:799`.

## 7. Constraining decisions

- 0043 — classifier memory is a machine allow/ask cache keyed by versioned effect hash; human `allow_once` never enters it.
- 0121 — autonomous host-verified job runs never call the classifier; only declared grants can allow.
- 0130 — `capability_run` stays high-risk; ineligible for classifier-derived or cached allow.
- 0154 — defines `human_decision`: person-scoped label snapshot, exact/kind/place scopes, full-hash No, path-only-eligible-write Allow, revocation, no unresolved/group learning. Primary spec for T3a's shape.
- 0155 — governs which native/file shapes are high/ambiguous; keeps native verdicts and interactive-auto Gantry/native-file allows out of the classifier cache.
- 0054 (PERM-4) — provenance must be agent-visible and distinct from risk label.
- 0107 — decision source is a typed union with repeatability semantics; `human_decision` needs a codec addition, not string inference.
- 0118 (ID-1) — `memoryUserId` host-stamped for live work; `execution_context.personId` for jobs; person scope drives authority/memory.
- 0138 — agents are `service`-kind Persons; human-decision rows must keep the human acting-person contract distinct from agent aliases.

## Open questions the task contract must settle (orchestrator rulings in the T3a plan)

- Partial-index predicates/conflict targets — revoked human row reactivated on re-insert, or a fresh UUID row? → fresh row; revoked rows are history.
- Which seam resolves and snapshots the approver's canonical person ID + display label? → T3c (the remember DTO carries `actingPersonId` + `actingPersonLabel` supplied by the caller; T3a persists, never resolves).
- Canonical destination format (resolved absolute path vs virtual `scope/path`), and dual `file_path`+`path` native inputs. → native: the resolved absolute path from the prospective boundary; virtual: `<scope>/<normalised path>`; dual keys or any multi-destination shape are NOT path-only eligible (full hash).
- Does `remember` generate UUIDs itself? → the service takes injected `newId` (default `randomUUID`) and `now`.
- Typed `PermissionDecisionSource` value for replayed human memory → `human_decision` (distinct from `human_once`/`human_persistent`), added to the 0107 codec.
