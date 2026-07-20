# Ponytail Execution Ledger

Date: 2026-07-19

Scope: Phase 1 transition evidence and Phase 2 settings-authority cutover from
`ponytail-audit-2026-07-16.md`.

## Phase 1 transition evidence

### Migration head

- The current migration head is `0104_settings_authority_cutover` (`idx: 104`,
  journal timestamp `1784430700000`).
- The repository has 102 SQL migration files and 102 journal entries, including
  `0104`.
- Head SQL SHA-256:
  `22f9eefe9b1b25eca5b99f64a104a0d4399aea8390194395e89993a461b92cdd`.
- `0104_snapshot.json` SHA-256:
  `6facbe8a9254b3d869dbb202d257a0a9466d1a2e10d0fca7c41dcbc7156baeb3`.
- `0104` is a normal forward migration, not the Phase 7 replacement baseline.
  It adds Conversation-owned `requires_trigger` and drops the invariant
  ConversationInstall `sender_policy` and `control_policy` columns.
- The migration contains no `public` schema qualifier. Tables are referenced
  unqualified, matching the existing migration convention.
- `apps/core/test/unit/storage/postgres-migration-journal.test.ts` passes: 44
  tests.

### Current settings-revision mechanics

- `settings_revisions` is the durable desired-state authority in workstation
  and fleet modes. The current reader version is 14.
- A managed write requires runtime storage, an explicit deployment mode, and a
  settings-revision repository. It validates and normalizes the candidate,
  rejects a stale previous document or expected revision, and skips a no-op
  candidate.
- A real mutation appends with repository-owned compare-and-set semantics at
  `expectedRevision + 1`, records reader version 14, and publishes a Postgres
  revision wakeup. Only after the append succeeds does the workstation path
  synchronize `settings.yaml`, reconcile Postgres/live projection, and reload
  runtime state. A failed projection can therefore retry from the committed
  revision.
- At workstation startup, an existing latest revision wins and restores the
  readable `settings.yaml` mirror. If no revision exists, workstation mode may
  seed revision 1 from the validated file with `expectedRevision: 0`; fleet
  mode does not promote a local file when its revision authority is empty.
- Fleet workers consume the latest revision through NOTIFY plus a poll fallback
  and hold their last applied revision when `min_reader_version` is newer than
  the worker.

### Deployment-mode assumptions

- The parser default is `runtime.deployment_mode: workstation`; the only other
  supported value is `fleet`.
- This ledger records the approved pre-user assumption, not a live runtime or
  database probe: this machine is the only state-preservation target and will
  use the Phase 8 offline restamp. Every other environment resets.
- Before Phase 8, the operator must re-confirm this machine's actual deployment
  mode, latest settings revision, migration stamps, and backup location. A
  fleet-mode or multi-host result invalidates the single-host restamp
  assumption and requires a new cutover decision.

### Phase 8 reset versus restamp sketch

Phase 7 must first publish the final baseline SQL, snapshot, journal entry, and
exact stamp metadata. `0104` is not that baseline.

For this machine only:

1. Stop `com.gantry` and keep the cutover offline.
2. Back up Postgres and `settings.yaml`; capture the latest revision document,
   reader version, and all existing `__drizzle_migrations` stamps.
3. Validate and append the canonical post-cutover settings revision before
   changing migration stamps.
4. Insert the exact Phase 7 baseline timestamp/hash stamp while retaining the
   old stamps for rollback evidence. Do not replay the baseline SQL over the
   already-current schema.
5. Start the service and require exact-head migration validation, revision
   reload/reconciliation, and readiness checks before accepting the cutover.
   Restore the backup if any check fails.

For every other environment: discard the old database, create an empty
database, apply the Phase 7 baseline normally, and bootstrap canonical desired
state. No restamp or legacy-shape import is supported.

## F7 consumer search

The active cutover search covered `providerConnection`,
`provider_connection`, `channel-providerConnection`,
`missing_provider_connection`, and `Provider Connection` across source, tests,
contracts, and architecture docs, excluding generated output and migration
files.

- No current runtime settings type, parser fallback, public contract, Slack
  permission consumer, or control-plane action retains the shadow.
- `settings-revision-legacy-bindings.ts` still recognizes old spellings only as
  the explicitly deferred Phase 9 transition reader (F3).
- `runtime-settings-compact.ts` and focused tests retain old terms only to
  reject unsupported input or prove it is omitted.
- Remaining documentation matches are the audit and historical goal prompt.
  Current architecture vocabulary now says Provider Account.
- Migration-journal tests retain historical table/column names as migration
  evidence.

## Phase 2 outcomes

| Item | Outcome     | Evidence and boundary                                                                                                                                                                                                                                                                          |
| ---- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F6   | Implemented | Removed top-level and per-agent binding/install projections. `conversations.*.installedAgents` is the public/runtime authority, and control-plane/setup consumers now read it directly.                                                                                                        |
| F7   | Adjusted    | Removed the runtime `providerConnection` shadow, fallback reads, obsolete prefix, and current vocabulary. Old spellings remain only in the Phase 9 transition reader, reject-only coverage, and migration/history evidence.                                                                    |
| F16  | Implemented | Removed install-owned `trigger`/`requiresTrigger`; Conversation owns `requiresTrigger`, while install model and permission overrides remain.                                                                                                                                                   |
| F23  | Implemented | Removed invariant install `senderPolicy`/`controlPolicy` from domain, repository, schema, contracts, tests, and writers; `0104` drops the columns. Conversation sender policy and approvers remain authoritative.                                                                              |
| AR1  | Implemented | Moved the existing desired-state service, helpers, types, and current export into `application/settings`; boot, watchers, writer, CLI/control consumers, and reconciliation use that application-owned seam. YAML codecs and revision transport remain in their narrow config/Postgres owners. |

No Phase 2 item was skipped. F7 is adjusted only because the approved plan
keeps F3's transition reader through the short rollback window and removes it
in Phase 9.

### Net line delta

Measured before adding this Phase 1 ledger:

- tracked changes: +631 / -7,382 lines;
- new non-generated `application/settings` source: +1,382 lines;
- Phase 2 non-generated total: +2,013 / -7,382, net **-5,369 lines**;
- generated migration artifacts excluded from that reduction: `0104` SQL +2
  lines and snapshot +14,576 lines.

The exclusion matches the audit's nonmigration estimates and prevents the
generated schema snapshot from hiding the source/test reduction.

## One-time live settings cleanup (deploy prerequisite)

The live machine's `settings.yaml` still contains install-level `trigger` or
`requires_trigger` keys in four real conversations:

- `main_slack_gantry_runtime`
- `main_telegram_dm`
- `main_telegram_group`
- `telegram_default_-1003798366047_0f76daeb32c4`

It also contains roughly 16 stale `codex_test_*` conversations. Before
deploying this cutover, a human operator must translate the four real entries'
trigger configuration to the conversation-level `requires_trigger` field,
remove their install-level trigger keys, and delete the stale test
conversations. This is a manual live-machine cleanup step; the runtime does not
translate the legacy shape.

### Runbook addendum (R6 finding resolution, no-legacy policy)

The 0104 migration derives conversation `requires_trigger` from kind and drops
the per-install columns without preservation code (user directive: no legacy
support). Live-machine audit 2026-07-19: two REAL channels deliberately run
trigger-free and MUST carry `requires_trigger: false` explicitly through the
one-time settings cleanup — `main_telegram_group` and
`telegram_default_-1003798366047_0f76daeb32c4`. The other two real
conversations match kind-derived defaults. All codex*test*\* conversations are
deleted, not migrated.

- Phase 7-9 cutover must restamp unqualified/bare route keys and legacy `memorySubjectJson.route` rows because Slice 2 requires agent/provider-account-qualified keys.

## Phase 3 Slice 1 deferral

- Transient install `trigger` remains until AR2 replaces the legacy route DTO;
  current routing still reads it, so deleting only the in-memory bridge would
  change behavior before the canonical writer cutover.

## Phase 3 Slice 2 outcomes

### Current-tree revalidation

AR2, F5, and F14 all still applied. Slice 1 had already removed the durable
install-trigger projection and qualified the settings desired-state writer,
but the transient install bridge, manual Control/IPC writers, partially
qualified runtime registration, route-selection fallbacks, and Postgres
external-reference fallback all remained.

The legacy runtime record has expanded from the original audit's 51 production
consumers to 94. A mechanical repo-wide record rename would add churn without
removing behavior, so Slice 2 names and enforces `LiveConversationRoute` at the
application projection seam, moves route-key encoding/selection beside it, and
leaves `ConversationRoute` as the internal repository storage record rather
than the canonical writer contract. This is the only current-tree adjustment;
no finding was stale or fully absorbed.

| Item           | Outcome     | Evidence and boundary                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AR2            | Implemented | Added one application-owned live-route projection with required agent/provider-account identity and derived trigger behavior; moved route-key selection out of `shared`; preserved thread scope; replaced `MemorySubject.route` with a typed adapter-private payload; merged the one-consumer binding ops service into the Postgres repository; and routed `register_agent` through the revision-first ConversationInstall writer. |
| F5             | Implemented | Every durable writer now emits an agent/provider-account-qualified key. Runtime registration rejects non-app routes without provider-account identity, and selection/recovery no longer falls back to route payload identity, folder identity, bare keys, or partially qualified duplicates.                                                                                                                                       |
| F14            | Implemented | Canonical binding reads no longer select or parse Conversation external refs and reject an empty `conversation-route:` suffix instead of reconstructing a JID.                                                                                                                                                                                                                                                                     |
| Trigger bridge | Implemented | Removed transient install `trigger`, IPC/MCP registration trigger input, free-form CLI trigger input, writer copies, and adapter-private persisted trigger text. Trigger text is derived once from the agent display name; Conversation remains authoritative for `requiresTrigger`.                                                                                                                                               |

The Phase 9 transition reader still recognizes legacy revision `binding.trigger`
as explicitly planned. It is not a live settings/runtime bridge and remains
until the rollback window closes.

### Surface impact

| Surface                     | Classification      | Reason                                                                                          |
| --------------------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| Runtime behavior            | Changed             | Route identity is canonical and trigger text is derived.                                        |
| `settings.yaml`             | Unchanged by design | Slice 1 already removed install trigger; current writes still use revision-first desired state. |
| Postgres/runtime projection | Changed             | Binding rows require canonical route suffixes and Conversation-owned trigger policy.            |
| Control API / SDK contracts | Unchanged by design | No public route contract changed.                                                               |
| CLI / Gantry MCP tools      | Changed             | Custom trigger text was removed; registration writes ConversationInstall desired state.         |
| Channel/provider adapters   | Changed             | Setup writers persist qualified routes through the central projection.                          |
| Audit/events                | Unchanged by design | Existing desired-state and registration audit paths remain authoritative.                       |
| Tests/verification          | Changed             | Legacy-key/fallback cases were deleted and canonical identity invariants added.                 |

### Net line delta

Mutually exclusive path attribution for source and tests is AR2 +578/-363,
F5 +459/-687, F14 +52/-79, and trigger-bridge removal +58/-104: total
+1,147/-1,233, net **-86 lines**. The required ledger and audit-path updates
add +68/-3 documentation lines, making the complete uncommitted worktree delta
+1,215/-1,236, net **-21 lines**.

### Verification notes

- Focused routing matrix: 16 files, 416 tests passed; the additional
  `ipc-interaction-handler` canonical-key fixture rerun passed 37 tests.
- Full-unit broad run: 511 files / 6,324 tests passed. The remaining unrelated
  failures were isolated to the sandbox's denied FSEvents watchers (`EMFILE`)
  and `npm pack`'s denied write to the primary checkout's `.git/config` during
  Husky prepare; the exact `npm run test:unit` run stalled after the same
  watcher exhaustion and was terminated after bounded waits.
- Architecture checker before and after Slice 2 reports the same 11 current-tree
  findings: five size ratchets, one existing control agent-route layer edge, three
  Telegram text-style findings, and two active-doc references. The task's
  stated eight-finding baseline omitted the newly merged prompt-profile ratchet
  and two active-doc references; Slice 2 added no finding or exception.

## Phase 3 Slice 3 outcomes

### Current-tree revalidation

F9, N2, N3, N4, and N8 all still applied after Slices 1-2 and the merged
conversation-quality, permission-prompt schema, attachment, messaging-cleanup,
and gateway-latency changes. None was fully or partially absorbed: the job
model still allowed missing canonical execution/delivery fields and rebuilt
them from legacy mirrors, question selections were still decoded twice, Slack
and Teams still carried separate durable callback readers, the unused pending
interaction list port still crossed every layer, and the prompt-binding module
still re-exported unrelated callback types.

| Item | Outcome     | Evidence and boundary                                                                                                                                                                                                                                                                                                              |
| ---- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F9   | Implemented | Made `execution_context` and non-empty `notification_routes` the only job execution/delivery authority; deleted top-level/session/route reconstruction and route-source aliases; required canonical rows at Postgres read/write boundaries; preserved provider-account identity in system-job targets and registration signatures. |
| N2   | Implemented | Removed the second raw selection decoder and builds the durable selection map directly from the already-validated pending-interaction envelope.                                                                                                                                                                                    |
| N3   | Implemented | Consolidated Slack and Teams durable question callback recovery into one application-owned reader; channel adapters now keep only channel-specific rendering/parsing.                                                                                                                                                              |
| N4   | Implemented | Deleted the zero-production-consumer `listPendingInteractions` port, Postgres implementation, mocks, and tests; recovery continues through the existing idempotency-key lookup.                                                                                                                                                    |
| N8   | Implemented | Removed prompt-binding callback/type re-exports and changed consumers to import each type or reader from its owning module.                                                                                                                                                                                                        |

F9 intentionally adds no compatibility reader or migration shim. The approved
Phase 8 reset/restamp must leave every retained job with canonical execution
context and at least one notification route before this fail-loud reader is
deployed; other environments reset.

### Surface impact

| Surface                     | Classification       | Reason                                                                                                           |
| --------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Runtime behavior            | Changed              | Jobs execute and notify only from canonical context/routes; durable question recovery has one reader.            |
| `settings.yaml`             | Unchanged by design  | These findings do not change desired-state configuration or its authority.                                       |
| Postgres/runtime projection | Changed              | Job reads/writes reject missing canonical fields; the unused pending-interaction list repository method is gone. |
| Control API                 | Read-only/observable | Existing job responses consume canonical visibility metadata; no public request or response shape changed.       |
| SDK/contracts               | Unchanged by design  | No provider SDK or public contract changed.                                                                      |
| CLI                         | Unchanged by design  | No CLI surface reads the removed fallbacks or pending-interaction list.                                          |
| Gantry MCP/admin tools      | Unchanged by design  | Existing job writers already supply canonical context/routes; no tool schema changed.                            |
| Channel/provider adapters   | Changed              | Slack and Teams share the application callback reader; Discord imports the callback type from its owner.         |
| Docs/prompts                | Changed              | This ledger records the cutover prerequisite and current-tree outcome; prompts are unchanged.                    |
| Audit/events                | Unchanged by design  | Existing job and interaction audit/event payloads remain authoritative.                                          |
| Tests/verification          | Changed              | Fallback/list tests were deleted and canonical fail-loud/provider-account invariants were added.                 |

### Net line delta

Mutually exclusive source-and-test attribution is F9 +342/-290 (net **+52**;
production alone +116/-233, net **-117**), N2 +9/-37 (net **-28**), N3
+33/-51 (net **-18**), N4 +33/-95 (net **-62**), and N8 +10/-20 (net
**-10**): total +427/-493, net **-66 lines** before this ledger section.

### Verification notes

- Typecheck passed after the final production/test change.
- Focused job/interaction matrix: 14 files, 624 tests passed; the two stale F9
  fixtures discovered by the first full run were corrected and reran in
  isolation with 75 tests passed. The N2/N3/N4/N8 subset independently passed
  six files / 474 tests.
- Autoreview found one provider-account restamp gap for dead-lettered system
  jobs. Both per-conversation and singleton registrations now refresh canonical
  targets without reviving the job; the focused regression file passed 16
  tests and typecheck passed again.
- The exact full `npm run test:unit` command was run three times. The first run
  found the two stale F9 fixtures above. After their isolated green rerun, both
  the second run and the final post-review-fix run emitted no failing test but
  did not exit or print Vitest's final summary after bounded waits, so they were
  terminated as load/open-handle stalls rather than reported as clean
  full-suite completions.
- Postgres integration startup is blocked in this symlinked worktree because
  Vitest cannot create `node_modules/.vite-temp` (`EPERM`); no integration test
  body ran, so focused unit coverage is the verification evidence for N4.

## Phase 4 outcomes

### Current-tree revalidation

AR3, F4, and F17 all still applied after Phase 3 and the intervening merged
changes. Canonical Zod schemas already owned the model/default/preview,
agent-profile, runtime-settings, and ConversationInstall shapes, but Control
OpenAPI still hand-copied or omitted them. The SDK then hand-copied the model,
profile, runtime-settings, and desired-state types from that incomplete public
description.

Independent re-review then found four residual contract-to-SDK drifts in the
first Phase 4 pass: install responses still emitted removed trigger-policy
fields; the shared install request advertised path-owned identity and
unsupported metadata; the model workload enum still had two definitions; and
the SDK model list return retained one handwritten response mirror. All four
were removed in this review-fix pass.

The required pre-change consumer search covered `apps/`, `packages/`,
`.github/`, and their nested tests. This checkout has no top-level `tools/`,
`test/`, or `tests/` directory. The findings were:

- the F4 handwritten model/default/preview types were consumed by the SDK
  model client and root exports; richer job-only records remain distinct and
  were preserved;
- the F17 handwritten profile types were local to the SDK agent client;
- the SDK settings client was the only handwritten consumer of the existing
  runtime-settings and desired-state response shapes;
- the enable/update routes need a strict route-specific install request because
  app, agent, and conversation identity comes from the authenticated path, and
  install metadata is not persisted;
- stale install memory-route trigger fields had one remaining response mapper,
  one desired-state writer, one agent-list reader, and one application merge
  path even though Conversation now owns `requiresTrigger` and channel trigger
  derivation;
- `apps/core/src/cli/model-preview-types.ts` and the shared runtime
  `ModelWorkload` are internal CLI/runtime shapes, not duplicate public SDK
  declarations, and remain unchanged.

| Item | Outcome     | Evidence and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AR3  | Implemented | Added one Zod-registry projection for canonical contract components; projected model, profile, runtime-settings, desired-state/revision, AgentHarness, and ConversationInstall schemas; documented the existing desired-state routes; generated SDK aliases from operations; and added the generated check to CI. The route request is now a strict canonical schema that omits path-owned identity and unsupported metadata. Install responses expose only `agentConfig` in `routeConfig`. |
| F4   | Implemented | Deleted handwritten SDK model/default/preview declarations and the handwritten OpenAPI copies. Generated aliases now preserve the complete model contract. `ModelWorkloadSchema` is defined once and referenced by `ModelRecordSchema`, and `models.list()` returns generated `ListModelsResponse`. Existing memory-preview diagnostics remain canonical, while provider-neutral `modelRoute.id` remains an open string.                                                                    |
| F17  | Implemented | Deleted handwritten SDK profile declarations and projected the canonical strict profile schemas, including nonnegative integers, the content length limit, and the profile-kind path parameter.                                                                                                                                                                                                                                                                                             |

No Phase 4 item was skipped. The review fix changes only the install request
validator, response projection, and trigger-policy source needed to make the
runtime behavior match the canonical public contract. It does not add install
metadata persistence or restore install-level trigger policy.

### Surface impact

| Surface                     | Classification       | Reason                                                                                                                                                         |
| --------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior            | Changed              | Enable/update rejects ignored identity/metadata fields, install saves strip stale route policy, and agent-list trigger policy reads Conversation.              |
| `settings.yaml`             | Unchanged by design  | The cutover does not add or remove desired-state fields in the human-readable settings surface.                                                                |
| Postgres/runtime projection | Changed              | Desired-state reconciliation no longer mirrors Conversation `requiresTrigger` into install memory-route state; live routes still receive it from Conversation. |
| Control API                 | Changed              | OpenAPI projects the strict route request and agentConfig-only route response that the handlers honor.                                                         |
| SDK/contracts               | Changed              | Route-specific request, single workload schema, generated model-list response, and regenerated operation declarations remove the hand mirrors.                 |
| CLI                         | Unchanged by design  | The internal CLI preview formatter/types are not public SDK contracts and remain in place.                                                                     |
| Gantry MCP/admin tools      | Unchanged by design  | No MCP/admin tool schema or capability selection changed.                                                                                                      |
| Channel/provider adapters   | Read-only/observable | Existing live route registration observes Conversation-owned trigger policy; provider transports and rendering are unchanged.                                  |
| Docs/prompts                | Changed              | This ledger records the review fixes; prompts and product guidance are unchanged.                                                                              |
| Audit/events                | Unchanged by design  | Existing control/settings/profile audit and event paths remain unchanged.                                                                                      |
| Tests/verification          | Changed              | Contract, OpenAPI, mapper, route validation, desired-state, and onboarding regression coverage locks the corrected shapes and ownership.                       |

### Net line delta

Measured before adding this ledger section:

- non-generated source, tests, and CI: +681/-915, net **-234 lines**;
- regenerated SDK declaration: +873/-453, net **+420 lines**;
- complete Phase 4 code/test/generated delta: +1,554/-1,368, net **+186
  lines**.

The generated declaration expanded because previously inline or incomplete
OpenAPI copies now expose the full canonical runtime-settings/model shapes and
new desired-state operations. Regeneration also absorbed pre-existing
`missing_provider_connection` to `missing_provider_account` drift already
present at Phase 4 start.

### Verification notes

- `npm run build:contracts`, `npm run build:sdk`, and `npm run typecheck`
  passed after the review fixes.
- Final focused contract/OpenAPI/mapper/install-service/desired-state/route-
  validation matrix: six files, 160 tests passed. The focused onboarding
  integration file also passed all five tests in the final worktree-safe
  non-bundling config-loader run.
- The definitive full unit run,
  `npm run test:unit -- --pool=forks --maxWorkers=4 --retry=2 --reporter=dot`,
  passed all 518 files and 6,424 tests in 1,963.88 seconds. An earlier
  eight-worker diagnostic run passed 517 files and 6,418 tests but timed out
  six unrelated spawned-runner cases; the two different cases that timed out
  in an isolated rerun both passed when rerun directly before the clean full
  run.
- The exact workspace generated check cannot resolve new worktree-local
  contract exports through this checkout's shared `node_modules` symlink: it
  loads the primary checkout's built `@gantry/contracts`. The same generator
  was run with a temporary worktree-local `tsx` path mapping; generation and
  its final `--check` comparison passed. CI now runs the exact
  `npm run check:generated --workspace @gantry/sdk` command in a normal
  checkout after build.
- `npm run format:check` and `git diff --check` passed.
- Architecture checking began with 16 current-tree findings: ten file-size
  ratchets, one existing control-route layer edge, three Telegram text-style
  findings, and two active-doc references. It ends with the same baseline
  except that `openapi-schemas.ts` is now below its size budget: 15 findings,
  no new finding or exception.
- Independent re-review found the four residual drift defects described above;
  this outcomes update records their fixes. Re-review of the resulting
  uncommitted work remains pending by request.
