---
issue: SIMP-2
title: Construct control application services once in the composition root
status: approved
saved: 2026-08-03T02:45:39+00:00
story: SIMP-2
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
---


# SIMP-2 — Construct control application services once in the composition root

## Objective

`createJobManagementService` and `createSessionInteractionModule` are rebuilt on every
control-server request from global getters — 13 call sites for the jobs service, plus three
divergent copies of the session-module construction. Build each service once in
`startControlServer`'s composition root, inject them through `ControlRouteContext`, and keep
every genuinely live dependency behind an explicit getter so settings-reload and
runtime-store-init behavior is unchanged.

## Context (verified 2026-08-03)

- `createJobManagementService` — defined `apps/core/src/control/server/routes/jobs.ts:145`;
  called per-request at jobs.ts:315,400,438,461,497,516,581,595,621,658,
  `routes/guided-actions.ts:118`, `routes/models.ts:469`, and transitively per-request from
  `external-ingress-adapter.ts:196`.
- `createSessionInteractionModule` — defined `session-interaction-adapter.ts:19`; called
  per-request from that adapter's helpers and seven sites in `routes/sessions.ts`
  (214,230,246,278,300,378,488). A third hand-built copy (`new SessionInteractionModule`)
  lives at `external-ingress-adapter.ts:139`.
- Composition root: `startControlServer` builds the `ctx` literal at
  `control/server/index.ts:355-461`; routes receive `ctx` as an argument
  (`ControlRouteContext`, `handler-context.ts:86-173`). Production boot
  (`app/index.ts:423`) initializes runtime storage BEFORE the control server starts.
- Liveness facts that constrain the design:
  - `toolRepository: getRuntimeToolRepositoryIfReady()` (jobs.ts:159) is DELIBERATELY
    re-evaluated per request — it returns `undefined` until storage is ready. Latching it at
    boot breaks the post-init upgrade.
  - `control` / `ops` / `repositories` / `runtimeEvents` / `skillRepository` /
    `mcpServerRepository` come from mutable runtime-store globals; production sets them once
    pre-boot, but tests swap them (`_setRuntimeStorageForTest`, `vi.mock`).
  - `getCredentialBroker` and `getConfiguredAgentRuntime` are already getters — liveness
    preserved by closing over them.
  - `liveAdmissionAppId` differs BY CALL SITE today: message-accept and external-ingress pass
    a value derived from `ctx.liveTurnsEnabled`; the seven `routes/sessions.ts` sites pass
    nothing. A single boot instance with it baked in would change those routes' behavior.

## Approach

### 1. One construction site, injected via ControlRouteContext

Add `jobManagement` and `sessionInteraction` to `ControlRouteContext`, constructed exactly
once inside `startControlServer` alongside the existing `ctx` literal. Every route call site
above switches to `ctx.jobManagement` / `ctx.sessionInteraction`; the per-request factories
and the hand-built copy in `external-ingress-adapter.ts` are deleted. No legacy paths: the
old module-level factory exports stop being called from routes (they may remain as the
composition root's private constructor, but nothing else calls them).

### 2. Live values stay live — as explicit getters, not re-construction

Any dependency whose value can change after boot is injected as a getter the service reads
at use time; stable values (clock, id generation, hashing, boot-static flags) are plain
values. Concretely:

- tool repository → `getToolRepository: () => getRuntimeToolRepositoryIfReady()`
- runtime-store-derived deps (control/ops/repositories/runtimeEvents/skill/mcp repos) →
  thin getters over the existing runtime-store accessors, so post-import swaps in tests and
  storage init ordering behave exactly as today
- credential broker and configured agent runtime → close over the existing ctx getters
  (already live)

Constructor signatures change outright where needed (no compatibility shims — unknown or
legacy-shaped deps fail the compile).

### 3. liveAdmissionAppId moves to the method (decided by Ravi 2026-08-03)

Remove `liveAdmissionAppId` from `SessionInteractionModule`'s constructor; the one method
that uses it takes it as an argument. The message-accept and external-ingress callers pass
the value they compute today; the seven session routes pass nothing and keep their current
(no-admission) behavior. The per-caller difference becomes explicit at the call site.

### 4. Out of scope (siblings, noted for a future SIMP)

Per-request services in mcp-servers.ts, capability-catalog.ts, credentials.ts, people.ts,
skills.ts, agents.ts, guided-actions.ts (`GuidedActionService`), provider-conversation-
routes.ts, observer.ts, and the private near-duplicate session-module in
`channels/app.ts:60` stay untouched.

## Verification

```bash
npm run typecheck
npx vitest run -c apps/core/vitest.config.ts apps/core/test/unit/control
python3 factory/scripts/verify.py
```

Behavioral checks that must exist (test-proven, fail-with-fix-reverted where behavioral):

1. Jobs and session routes work through the boot-constructed services (existing route
   suites: job-trigger.test.ts, session-control-port.test.ts, external-ingress-adapter.test.ts).
2. Tool-repository liveness: a request served BEFORE storage init sees no tool repository;
   a request AFTER init sees the real one — through the same boot-constructed service.
3. Settings reload: credential-broker/agent-runtime reads reflect reloaded settings after
   boot-time construction (existing settings-reload coverage must stay green).
4. liveAdmission: message-accept passes the admission app id; plain session routes do not —
   pinned at the call-site level now that the constructor no longer carries it.
5. `guided-actions-routes.test.ts` currently mocks the `createJobManagementService` module
   export — rework it to inject a fake via `ctx.jobManagement` (the new seam).

## Risks

- Test-only storage swaps after server start: runtime-store deps stay getter-read (step 2),
  so semantics match today's per-request reads. If a suite still breaks, the suite is
  depending on construction timing, not behavior — fix the test at the new seam.
- external-ingress-adapter closes over `ctx.app.getConversationRoutes()` per call; closing
  over the getter at boot preserves liveness. Reviewer focus point.

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Unchanged by design | same services, built once; live reads preserved |
| Data/schema | Unchanged by design | none |
| API | Unchanged by design | no route contract changes |
| CLI/ops | Unchanged by design | none |
| UI | Unchanged by design | none |
| Docs | Unchanged by design | no decision needed; roadmap story only |
| Tests | Changed | new liveness pins; guided-actions mock reworked to the ctx seam |

`user_facing: false`.
