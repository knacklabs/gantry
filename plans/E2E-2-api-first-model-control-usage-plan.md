---
decisions_reviewed:
  - 0000-credential-broker-boundary
  - 0001-agent-runtime-platform
  - 0002-symphony-forge-adoption
  - 0003-early-stage-no-backcompat
  - 0004-gantry-naming-and-public-repo
  - 0005-runtime-stack
  - 0006-config-secret-source-boundary
  - 0007-settings-runtime-truth
  - 0008-storage-backend-cutover
  - 0009-canonical-domain-schema-cutover
  - 0010-claude-runtime-materialization
  - 0011-provider-session-artifact-store
  - 0012-browser-capability-boundary
  - 0013-runtime-event-exchange
  - 0014-external-ingress-vs-outbound-webhooks
  - 0015-model-catalog-and-cache-accounting
  - 0016-event-bus-outbox-boundary
  - 0017-jsonb-runtime-payload-boundary
  - 0018-provider-neutral-agent-execution-adapter
  - 0019-simple-permission-and-job-tool-lifecycle
  - 0020-mcp-source-vs-action-capability
  - 0021-capability-artifacts
  - 0022-delivery-vehicle
  - 0023-deployment-modes
  - 0024-locked-preset
  - 0025-settings-authority
  - 0027-process-roles-and-multi-live
  - 0028-agent-harness-selection
  - 0029-agent-communication-reaction-binding
  - 0030-agent-communication-reasoning-safety
  - 0031-send-message-files-authority
  - 0032-signed-artifact-links-deferred
  - 0033-teams-reactions-deferred
  - 0034-client-signoff
  - 0035-epics-approved
  - 0040-permission-execution-two-axis-model
  - 0041-client-signoff
  - 0042-decision-view-16k-prefix-stripped
  - 0043-classifier-risk-only-engine-authz
  - 0044-ci-runner-isolation
  - 0045-inbound-attachment-descriptor-writer
  - 0046-llm-process-local-admission
  - 0050-agent-removal-projection-cleanup
  - 0051-client-signoff
  - 0052-birthright-self-surface
  - 0053-permission-no-timeout-interactive
  - 0054-decision-provenance-and-risk-label
  - 0055-client-signoff
  - 0056-durable-cancellation-invariant
  - 0057-arch1-client-signoff
  - 0058-readonly-scheduler-birthright
  - 0062-perm6-client-signoff
  - 0063-perm7-client-signoff
  - 0064-client-signoff
  - 0065-perm8-client-signoff
  - 0066-race-1-skill-artifact-app-isolation
  - 0067-client-signoff
  - 0068-race-2-cluster-fenced-settings-projection
  - 0069-client-signoff
  - 0070-client-signoff
  - 0071-race-4-browser-profile-lock-aba
  - 0072-client-signoff
  - 0073-race-6-profile-mirror-version-guard
  - 0074-race-8-mandatory-atomic-async-admission
  - 0075-race-9-serialize-file-backed-settings-write
  - 0076-client-signoff
  - 0077-race-5-lease-loss-lifecycle
  - 0078-lat-3a-single-memory-hydration-per-turn
  - 0079-client-signoff
  - 0080-lat-3b-retain-authoritative-second-fetch
  - 0081-client-signoff
  - 0082-fence-1-durable-lease-generation
  - 0083-conv-001-client-signoff
  - 0084-client-signoff
  - 0085-lat-4a-fused-inbound-envelope-transaction
  - 0086-client-signoff
  - 0087-lat-5-durable-provider-history-coverage
  - 0088-client-signoff
  - 0089-thread-turns-read-channel-context
  - 0090-sender-allowlist-trigger-only
  - 0091-client-signoff
  - 0092-client-signoff
  - 0093-client-signoff-is-a-pinned-project-gate
  - 0094-conversation-file-trust-program
  - 0095-client-signoff
  - 0096-thread-recency-message-timestamp
  - 0097-public-session-conversation-aggregate
  - 0098-streamed-message-projection-timing
  - 0099-rate-limits-singleton-authority
  - 0100-mig-1-client-signoff
  - 0101-oidc-generic-google-first
  - 0102-runtime-hardening-audit-harvest
  - 0103-live-admission-terminal-retention
  - 0104-co-1-recovery-intent-reframe
  - 0105-physical-attachment-workspace-handoff
  - 0106-scheduled-runs-cannot-mutate-jobs
  - 0107-typed-permission-decision-provenance
  - 0108-job-definition-revision-fencing
  - 0109-semantic-capability-job-dependencies
  - 0110-live-ux-capability-dispatcher
  - 0112-legacy-single-canonical-shape
  - 0113-enforce-no-backcompat-architecture-check
  - 0114-canonical-job-owner
  - 0115-autonomous-tool-denial-terminal
  - 0117-scheduled-job-declare-tools-at-creation
  - 0129-e2e-2-api-first-scope
---

## Problem

`E2E-2` was originally worded as a broad "remaining matrix rows" story, but `E2E-1` reconciled the current architecture and narrowed the next safe slice to `docs/architecture/agent-e2e-test-matrix.md` section 18. The stale roadmap criterion still names packaged boot/restart, all-tools, security, and recovery work that section 18 deliberately excludes.

The current gap is smaller: prove the user-facing model/control surfaces through deterministic Control API invariants, and strengthen the existing real `haiku` scenario only where a real model boundary is unavoidable. Existing code already exposes `/v1/models`, `/v1/models/defaults`, per-turn message controls, `model.usage` runtime events, and `/v1/usage`; this story should mostly add or tighten tests around those contracts, not add new product surfaces.

## Scope / Non-goals

In scope:

- Refine the active `E2E-2` story scope to section 18: model catalog/default invariants, per-turn control acceptance/rejection/projection, and real-turn usage reconciliation.
- Extend existing `apps/core/test/agent-e2e/` and existing Control API/integration test patterns. No new framework or directory.
- Keep deterministic assertions API-first and credential-free wherever possible.
- Strengthen `apps/core/test/agent-e2e/scenarios/haiku-turn.agent-e2e.test.ts` so `model.usage` is mandatory when the live scenario runs, and `/v1/usage` reconciles the isolated app delta for that run.
- Update `docs/architecture/agent-e2e-test-matrix.md` rows with exact test citations after implementation.

Non-goals:

- No product cost API. Section 18 cost visibility stays deferred because `/v1/usage` exposes request/input/output tokens, not cost.
- No Slack, Telegram, Teams, Discord, browser, all-tools sweep, skill/MCP acquisition, security/recovery backlog, upgrade survivor, CI policy gate, or branch-protection work in this story.
- No broad semantic cheap-model task unless deterministic assertions cannot prove a section 18 case. If needed, use one bounded cheap-model turn and assert structured behavior, not wording.
- No real provider/channel tests except the already-existing `haiku` model scenario.
- No new model catalog framework, fixture harness, API route, database table, or settings shape unless a planned invariant test exposes a real bug.

## Acceptance Criteria

1. Roadmap refinement is explicit: the plan/decomposition for `E2E-2` binds this story to section 18 and records excluded stale roadmap items as out of scope with revisit triggers if they remain unresolved at approval.
2. `/v1/models` returns at least one routable chat model whose aliases/default relationship, execution routes, capabilities, token windows, output limits, cache/pricing metadata, and credential-aware `available` flag are internally consistent. Assertions compare relationships, never fixed catalog snapshots.
3. `/v1/models/defaults` returns defaults whose effective aliases resolve to catalog entries for chat/jobs/memory slots, and inherited job defaults track the chat default where the public contract says they inherit.
4. `POST /v1/sessions/{id}/messages` accepts valid per-turn `effort`, `thinking`, and `max_output_tokens`, rejects malformed wire combinations synchronously, and persists accepted controls into the message metadata that replay passes to the runner boundary. If section 18 is interpreted to require model-specific rejection at POST time, implementation must first expose that as a real contract gap instead of inventing assertions.
5. The existing real `haiku` scenario requires a `model.usage` event with positive `inputTokens` and `outputTokens`, an alias/model consistent with the selected `haiku` route, and no provider-native secrets in evidence/log output.
6. The same live scenario queries `/v1/usage` for the isolated app and run window and proves the usage aggregate includes exactly the real turn's delta for the run/app, without counting other apps or relying on historical state.
7. `docs/architecture/agent-e2e-test-matrix.md` section 18 flips only the rows proven by this work, with file/test citations; cost visibility remains deferred with the current API gap stated.
8. Verification uses the smallest relevant checks first and the factory verify gate last. Real-model checks self-skip when `E2E_MODEL_API_KEY` or `GANTRY_TEST_DATABASE_URL` is unavailable.

## Technical Approach

Recommendation: implement one deterministic Control API invariant test and one narrow live-haiku strengthening pass. This is the lazy path that satisfies section 18 without reopening the whole E2E backlog.

1. Add or extend a focused deterministic integration test near the existing Control API/session tests. Prefer a new single file only if `server-auth.test.ts` would become noisier; otherwise reuse current patterns. The test should start the in-process Control server, call public HTTP endpoints, and assert:
   - `/v1/models` model records satisfy schema-level relationships: aliases include `recommendedAlias`; chat-capable models expose at least one execution route; Anthropic SDK entries with curated metadata have positive context/output/pricing where present; `available` reflects the configured provider set rather than a source snapshot.
   - `/v1/models/defaults` slots point back to catalog aliases and workloads; inherited jobs follow chat defaults.
   - `POST /v1/sessions/{id}/messages` stores accepted controls in `agentControls` and malformed wire controls fail before session lookup.
2. Keep per-turn control projection below the model boundary deterministic. Existing storage and adapter tests already cover message replay and adapter mapping; add only the missing API-to-stored-message assertion if current coverage proves enough. Do not claim model-specific rejection at the Control API unless a focused test proves it or the implementation adds it.
3. Extend `AgentE2EApiClient` only if the live usage reconciliation needs a tiny helper for `/v1/usage`; otherwise use the existing generic `request`.
4. Tighten `haiku-turn.agent-e2e.test.ts`:
   - capture the accepted message time/run id/window;
   - require `model.usage` instead of optional checking;
   - assert positive `usage.inputTokens` and `usage.outputTokens`;
   - query `/v1/usage` scoped by `runId` and the isolated time window;
   - compare aggregate input/output tokens to the event payload.
5. Update the matrix rows and leave cost visibility deferred. Do not add a cost field to `/v1/usage`; that contradicts the current product/model-management docs, where cost belongs outside this runtime surface unless separately approved.

## Decisions

The scope refinement is recorded in
`docs/decisions/0129-e2e-2-api-first-scope.md`.

Relevant existing decisions also cover the choices here:

- `docs/decisions/0015-model-catalog-and-cache-accounting.md` owns model aliases, catalog metadata, token/cache accounting, and `/v1/models`.
- `docs/decisions/0018-provider-neutral-agent-execution-adapter.md` owns the provider-neutral runner boundary and keeps provider-native details adapter-private.
- `docs/decisions/0044-ci-runner-isolation.md` owns the protected real-model lane and fork-secret skip behavior.

Note: `docs/decisions/0038-neutral-e2e-model-credential-env.md` exists but is still `proposed`, so this plan does not treat it as active governance. The current test code already uses the neutral `E2E_MODEL_API_KEY` helper; this story should preserve that behavior.

## Surface Impact

| Surface | Classification | Reason |
| --- | --- | --- |
| runtime behavior | Read-only | Deterministic tests observe current model/default/control behavior; live haiku observes the real model boundary. Runtime code changes only if an invariant exposes a bug. |
| API | Read-only | Tests observe the existing public Control API contract; an API shape change is outside this plan and would require a scope signal. |
| data/schema | Unchanged by design | Usage and runtime events already persist in existing Postgres tables; no migration or schema shape is planned. |
| CLI/ops | Unchanged by design | No CLI command or operational workflow is in scope; verification commands only. |
| UI | N-A | No frontend or channel-rendered user interface changes. |
| docs | Changed | `docs/architecture/agent-e2e-test-matrix.md` must cite the rows proven by this story and keep excluded rows visibly unflipped/deferred. |
| tests | Changed | Adds/updates deterministic Control API tests and the existing live haiku scenario. |
| `settings.yaml` | Read-only | Model defaults may be patched in isolated tests, but no settings schema or production default changes. |
| Postgres/runtime projection | Read-only | Tests inspect existing message metadata, runtime events, and usage aggregation; no new projection. |
| control API | Read-only | `/v1/models`, `/v1/models/defaults`, `/v1/sessions/{id}/messages`, and `/v1/usage` are the primary observed surfaces; their contract is not changed. |
| SDK/contracts | Read-only | Contracts/OpenAPI already describe these shapes; update only if an existing mismatch is found. |
| Gantry MCP/admin | Unchanged by design | No MCP/admin tool is needed for section 18. |
| channel/provider adapters | Read-only | Provider adapter usage normalization is observed via the existing haiku route; no adapter feature work planned. |
| docs/prompts | Changed | Matrix docs change; no prompt contract changes planned. |
| audit/events | Read-only | `model.usage` runtime events and usage aggregation become required evidence in tests. |
| tests/verification | Changed | Focused integration/e2e checks plus factory verify. |

Deferred entries that survive approval should be recorded with triggers:

- Cost visibility: reopen when Gantry has an approved product/API source for cost aggregates, not just token counts.
- Broad stale `E2E-2` backlog rows: reopen as separate stories when section 18 is green or when a production incident requires the specific row.
- Semantic fallback: reopen only if deterministic assertions cannot cover one of the accepted section 18 criteria.

## Task Decomposition

1. Scope refinement and deterministic Control API invariants
   - Write scope: `plans/roadmap.json` only if approved scope refinement is recorded there, `docs/architecture/agent-e2e-test-matrix.md`, and focused Control API/integration tests under `apps/core/test/unit/control/` or `apps/core/test/integration/`.
   - Acceptance covered: 1, 2, 3, 4, 7.
   - Notes: prefer extending existing server/test helpers. Do not create a new E2E harness.

2. Live haiku usage reconciliation
   - Write scope: `apps/core/test/agent-e2e/scenarios/haiku-turn.agent-e2e.test.ts`, with a tiny helper in `apps/core/test/agent-e2e/harness/api-client.ts` only if it removes duplication.
   - Acceptance covered: 5, 6, 8.
   - Notes: keep one real-model turn. Do not add a second live scenario unless deterministic coverage cannot prove the behavior.

3. Verification and matrix closeout
   - Write scope: test evidence artifact recording, matrix row citations, and no product code unless tasks 1 or 2 exposed a bug.
   - Acceptance covered: 7, 8.
   - Notes: record exact checks and skipped live checks honestly.

## Risks

- Real model flake or quota: the live lane can fail for provider rate limits. Keep it one cheap `haiku` turn, preserve current self-skip, and keep deterministic tests as the merge-bar proof.
- Optional usage event today: making `model.usage` mandatory may reveal provider/SDK responses that omit usage. That is the intended bug boundary; do not paper over it with optional assertions.
- Catalog churn: fixed model counts or exact model snapshots will create brittle tests. Assert relationships and at least-one routable selections instead.
- Per-turn control wording: current Control API validation rejects malformed wire controls, while model-capability support appears to be enforced lower in the runner/model factory. Treat model-specific POST-time rejection as a contract gap unless proven otherwise.
- Roadmap drift: if the stale `E2E-2` criterion is not refined, review may demand all-tools/security/recovery work. The plan/decomposition must state the section 18 refinement before implementation starts.
- Host env leakage: prior evidence showed `GANTRY_CONTROL_API_KEYS_JSON` can leak into tests. Scoped commands should unset it where relevant.

## Verify Plan

Focused checks during implementation:

```bash
env -u GANTRY_CONTROL_API_KEYS_JSON npm run test:unit -- apps/core/test/unit/control/server-auth.test.ts apps/core/test/unit/control/usage-routes.test.ts apps/core/test/unit/control/openapi.test.ts
env -u GANTRY_CONTROL_API_KEYS_JSON npm run test:integration -- apps/core/test/integration/session-ensure-agent-binding.integration.test.ts apps/core/test/integration/session-control-runs.integration.test.ts
GANTRY_TEST_DATABASE_URL=<throwaway-postgres-url> env -u GANTRY_CONTROL_API_KEYS_JSON npm run test:integration:postgres -- apps/core/test/integration/usage.postgres.integration.test.ts
GANTRY_TEST_DATABASE_URL=<throwaway-postgres-url> E2E_MODEL_API_KEY=<protected-key> npm run test:e2e -- apps/core/test/agent-e2e/scenarios/haiku-turn.agent-e2e.test.ts
```

Broader gates before PR-ready:

```bash
npm run typecheck
npm test
python3 scripts/check_architecture.py
python3 factory/scripts/verify.py
```

If `E2E_MODEL_API_KEY` is unavailable, record the live lane as skipped and rely only on deterministic evidence for review; do not claim acceptance criteria 5 or 6 are complete until a protected-key run passes.
