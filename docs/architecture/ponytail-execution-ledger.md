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

## Phase 5 outcomes

### Current-tree revalidation

AR4, AR5, F13, and F20 all still applied after Phase 4 and the intervening
merged changes. The required repo-wide consumer searches covered `apps/`,
`packages/`, `docs/`, and `.github` before each cut. This checkout still has no
top-level `tools/`, `test/`, or `tests/` directory.

The searches found that provider-account connect/rotate/install and
Conversation info/approver behavior still lived in the CLI adapter; canonical
conversation commands still delegated into undocumented provider aliases;
messaging/runtime still rendered Slack and Telegram dialect text before
persistence and channel delivery; the provider registry still advertised a
formatting policy; and the legacy Slack thread prefix still had one acceptance
test plus stale integration fixtures. Slack and Discord permission-interaction
registration also still dominated their oversized general interaction files.

Post-change searches leave the removed provider aliases and `thread:slack:`
only in rejection tests or historical audit evidence. Removed generic-renderer
names remain only in historical documents. No Phase 6 deletion or Phase 7-9
cutover item was pulled into this phase.

| Item                   | Outcome     | Evidence and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AR4                    | Implemented | Added application-owned provider-account, ConversationInstall, summary, and approver use cases; the CLI now only parses, invokes, and formats. Authority writes remain revision-first through desired state, approver validation records canonical participants before the write, and canonical external identity segments are collision-free for all newly restamped rows. Existing pre-restamp identity rows intentionally receive no compatibility reader or migration in this phase; the approved Phase 8 offline restamp owns that cutover. |
| AR5                    | Implemented | Runtime/messaging now strips only internal tags and persists canonical visible text. Slack and Telegram render and plan provider-sized chunks at their adapter boundaries. Retry tails stay canonical across direct and streaming partial delivery; Slack native appends are token-aligned, whitespace-lossless, and use a linear canonical/rendered segment map. The provider registry formatting field and generic renderer were deleted.                                                                                                      |
| F13                    | Implemented | Deleted undocumented `provider info`, `provider control-allowlist`, and `provider approvers`; retained only canonical Conversation info/approver commands backed by the application service.                                                                                                                                                                                                                                                                                                                                                     |
| F20                    | Implemented | Deleted accepted `thread:slack:` compatibility and normalized active fixtures. The stale prefix remains only in an explicit rejection test and audit history.                                                                                                                                                                                                                                                                                                                                                                                    |
| Slack/Discord file cut | Implemented | Split permission-interaction registration into owned Slack and Discord files and added an architecture boundary test. The resulting general/permission files are 89/515 lines for Slack and 315/402 for Discord.                                                                                                                                                                                                                                                                                                                                 |

### Surface impact

| Surface                     | Classification      | Reason                                                                                                                                                        |
| --------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior            | Changed             | Canonical text persists before adapter rendering; partial-delivery retry tails remain canonical; provider/conversation mutations use application services.    |
| `settings.yaml`             | Changed             | Existing provider-account, install, and approver writes keep the same readable schema but now go exclusively through revision-first desired-state operations. |
| Postgres/runtime projection | Changed             | Validated approvers are recorded as canonical participants and outbound message/event text is canonical; no schema or migration changed.                      |
| Control API                 | Unchanged by design | Existing control routes and application service contracts are unchanged by the CLI/adapter cut.                                                               |
| SDK/contracts               | Unchanged by design | No public contract or generated SDK surface changed, so an SDK rebuild is not required.                                                                       |
| CLI                         | Changed             | Provider aliases were deleted and remaining provider/conversation commands invoke application-owned use cases.                                                |
| Gantry MCP/admin tools      | Unchanged by design | No tool schema, capability, or admin-tool path changed.                                                                                                       |
| Channel/provider adapters   | Changed             | Slack/Telegram own rendering and chunk planning; Slack/Discord permission registration is split by responsibility.                                            |
| Docs/prompts                | Changed             | Architecture/audit references and this ledger describe the new ownership; agent prompts are unchanged.                                                        |
| Audit/events                | Changed             | Existing event shapes remain, but persisted outbound visible text is now canonical rather than provider-rendered.                                             |
| Tests/verification          | Changed             | Canonical rendering/retry, application ownership, alias rejection, thread-prefix rejection, participant identity, and split-boundary invariants are covered.  |

### Net line delta

Measured before adding this ledger section, tracked files are +1,016/-1,617
and six new source/test files add 1,670 lines: complete Phase 5 code, test, and
supporting-doc delta +2,686/-1,617, net **+1,069 lines**. The positive delta is
primarily the application-owned provider/conversation use-case seam, the shared
canonical chunk/retry planner, and regression coverage; the Slack/Discord
physical splits preserve behavior instead of claiming moved lines as deletion.
No dependency was added.

### Verification notes

- `npm run typecheck` passed and includes a successful
  `npm run build:contracts`. No contracts changed, so `build:sdk` was not run.
- Final focused provider/conversation/rendering matrix: nine files, 472 tests
  passed. Phase 5 source lint passed with zero errors and 39 existing-style
  warnings. Whole-repo lint remains blocked by the unrelated baseline of 23
  errors and 999 warnings.
- The definitive full unit run is recorded below after completion.
- The focused onboarding integration file could not start in this symlinked
  worktree: the standard loader was denied writing `node_modules/.vite-temp`
  (`EPERM`), the runner loader evaluated CommonJS `__dirname` as undefined, and
  the native loader could not resolve `vitest.shared.js`. No integration test
  body ran.
- Architecture checking began with 15 production findings: nine file-size
  ratchets, one existing control-route layer edge, three provider-specific
  Telegram findings in the generic renderer, and two active-doc references.
  It ends with 12 production findings: the same nine size ratchets, layer edge,
  and two active-doc references. The checker additionally reports two stale
  exception-hygiene entries for the deleted renderer; the sandbox makes
  `.codex/architecture-exceptions.json` read-only, so those entries could not be
  removed here. Phase 5-created Slack/Telegram size ratchets were reduced below
  their existing budgets before closeout.
- Local autoreview drove consolidation of two recurring invariants: approver
  validation now records collision-free canonical participant/user/alias
  identity before revision-first settings projection, and all Slack/Telegram
  delivery/retry producers use canonical text with token-aware provider
  planning. Final review left one deliberate P2 requesting migration of
  pre-restamp identity rows; that is rejected for this phase because the
  approved plan and user direction prohibit compatibility work and assign the
  only preserved machine to the Phase 8 offline restamp.

## Phase 6 outcomes

### Current-tree revalidation and consumer searches

Before each proposed deletion, exact-name consumer searches covered `apps/`,
`packages/`, `docs/`, and `.github`; `.codex` was also searched for the factory
scripts that live there. Structural `ast-grep` searches supplemented the exact
searches for F11, F18, and F24. `ccc` was unavailable because this disposable
worktree is not initialized, and initializing it would create files outside the
bounded Phase 6 write scope.

| Item | Current-tree consumer evidence                                                                                                                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F2   | The archived-memory importer name appears only in the July audit documents; there is no caller, prompt, workflow, or package script.                                                                                                                     |
| F8   | The flag-based test recorder name appears only in the July audit documents; current factory surfaces use `record_test_from_json.py`.                                                                                                                     |
| F10  | The Postgres wrapper name appears only in audit documents and its own usage string; current docs invoke Vitest with `GANTRY_TEST_DATABASE_URL` directly.                                                                                                 |
| F11  | `_memorySubjectFromRow` had only its declaration and zero structural calls.                                                                                                                                                                              |
| F12  | The GitHub wrapper name appears only in the July audit documents; there is no workflow, prompt, or script caller.                                                                                                                                        |
| F15  | No dynamic `defaultConnection` assignment returned. Remaining matches are reject-only coverage, historical migrations/tests, and audit/goal history.                                                                                                     |
| F18  | `fallbackForInjectedRunner` was confined to the job resolver and its execution caller; `fallbackExecutionProviderId` was confined to the shared resolver and its two job callers. Injected `runAgent` remains a test seam, not provider-authority input. |
| F19  | Current recorder callers use canonical finding flags/JSON keys. No caller uses `--blocking`, `--warning`, `blocking`, or `warnings`; the compatibility reads/emits exist only in the three target scripts.                                               |
| F21  | No repository consumer imports `@gantry/contracts/primitives`. Internal imports use the retained canonical contract-primitives artifact rather than the duplicate package export alias.                                                                  |
| F22  | The no-op hook name appears only in audit documents and the hook-contract assertion that it is not configured.                                                                                                                                           |
| F24  | `MemoryScope` and `MemorySearchResult` are not imported through `domain-types.ts`; real consumers import the memory-owned types directly. The matching architecture exception is still present.                                                          |

No finding gained a new consumer. F15 remains absorbed by earlier work. The
implementer sandbox exposed `.codex` as read-only, so seven findings were first
recorded blocked; the orchestrator (with repository write access) completed
them in the same phase using the consumer evidence above. The outcome table
below records the final state.

| Item | Outcome     | Evidence and boundary                                                                                                                                                                                                                            |
| ---- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F2   | Implemented | Deleted `.codex/scripts/migrate_archived_filesystem_memory.mjs` (418 lines, no caller).                                                                                                                                                          |
| F8   | Implemented | Deleted `.codex/scripts/record_test_result.py`; `record_test_from_json.py` is the sole recorder.                                                                                                                                                 |
| F10  | Implemented | Deleted `.codex/scripts/run_postgres_integration_with_url.mjs`; docs invoke Vitest with `GANTRY_TEST_DATABASE_URL` directly.                                                                                                                     |
| F11  | Implemented | Deleted the uncalled Postgres row-to-memory-subject helper; the existing live `MemorySubject` parser/import remains.                                                                                                                             |
| F12  | Implemented | Deleted `.codex/scripts/sync_github.py` (unconsumed `gh` wrapper).                                                                                                                                                                               |
| F15  | Absorbed    | Earlier work already removed all stale dynamic assignments; reject-only and migration-history evidence remains intentionally.                                                                                                                    |
| F18  | Implemented | Deleted injected-runner provider-ID fallbacks from normal and dead-letter job resolution. Catalog routing and registered adapter/registry resolution remain authoritative; `runAgent` injection still controls only the spawned runner in tests. |
| F19  | Implemented | Removed `--blocking`/`--warning` flags, legacy JSON key reads, and legacy emit keys from `record_review.py`/`record_review_from_json.py`; `factory_gates.py` reads only `blocking_findings`. Factory tests (135) pass.                           |
| F21  | Implemented | Deleted only the unused `./primitives` package export alias and retained `./contract-primitives` plus all internal canonical imports.                                                                                                            |
| F22  | Implemented | Deleted the no-op `.codex/scripts/post_tool_use.py`; the hook contract's assertNotIn guard still passes.                                                                                                                                         |
| F24  | Implemented | Removed the `MemoryScope`/`MemorySearchResult` re-exports from `domain-types.ts` AND the paired `forbidden_import_by_layer` exception entry; consumers import the memory-owned types directly.                                                   |

No Phase 7-9 item, settings-authority seam, canonical-routing seam, public DTO,
or Phase 5 rendering/adapter path changed.

### Surface impact

| Surface                     | Classification      | Reason                                                                                                                                       |
| --------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior            | Unchanged by design | F11 was dead and F18 removes only injected-runner provider authority; production catalog/registered-adapter resolution is unchanged.         |
| `settings.yaml`             | Unchanged by design | Phase 6 does not read, write, or project desired settings.                                                                                   |
| Postgres/runtime projection | Unchanged by design | The removed Postgres helper had zero calls; no repository contract, schema, row, or migration changed.                                       |
| Control API                 | Unchanged by design | No Control route, validator, response, or application use case changed.                                                                      |
| SDK/contracts               | Changed             | Package metadata no longer exposes the unused `./primitives` alias; the canonical `./contract-primitives` subpath and contract types remain. |
| CLI                         | Unchanged by design | No CLI command or implementation consumes the completed deletions.                                                                           |
| Gantry MCP/admin skill      | Unchanged by design | No tool schema, capability, prompt, or admin surface changed.                                                                                |
| Channel/provider adapters   | Unchanged by design | No channel/provider adapter or Phase 5 rendering seam changed.                                                                               |
| Docs/prompts                | Changed             | This ledger records current consumer evidence, outcomes, blocked boundaries, and verification.                                               |
| Audit/events                | Unchanged by design | No audit/event kind, payload, persistence, or delivery behavior changed.                                                                     |
| Tests/verification          | Changed             | Focused job/provider-resolution checks cover F18; final typecheck, unit, architecture, and completion results are recorded below.            |

### Net line delta

Before this ledger section, the implemented source/package changes are
+0/-49, net **-49 lines**: F11 -32, F18 -12, and F21 -5. The orchestrator
completion adds the `.codex` deletions (F2 -418, F8 -51, F10 -32, F12 -26,
F22 -3), the F19 alias removal (~-24), the F24 re-export + exception removal
(-12), and the dated-snapshot doc-reference rule in
`architecture_rules.py` (+8) — Phase 6 total net approximately **-620 lines**.
No dependency was added or removed.

### Verification notes

- Prettier was run on every touched supported file; unsupported/deleted paths
  were passed through the worktree-safe `--ignore-unknown` invocation.
- F18 focused execution/model-resolution tests passed: 48 tests.
- Final `npm run typecheck` passed, including `npm run build:contracts`.
- The requested direct unit command could not create the shared symlink target's
  `node_modules/.vite-temp` (`EPERM`) before test discovery. An equivalent
  worktree-local Vitest config preserved the unit includes, aliases, setup, and
  timeout; its temporary verifier also isolated npm cache/Husky writes and
  forced Gantry's existing polling fallback because this sandbox denies the
  FSEvents lookup used by `fs.watch`. The temporary files were removed after
  the run. Final result: 519 files and 6,442 tests passed in 923.91 seconds,
  exit 0.
- The architecture checker reports the existing baseline only: nine file-size
  ratchets, one control-route layer edge, and one active-doc reference (the
  undated artifact-store goal prompt). Deleting `.codex` scripts named by the
  dated audit snapshots would otherwise create ~17 broken-link findings, so
  `check_doc_references` now skips dated snapshot docs
  (`DATED_SNAPSHOT_DOC_RE`): a dated audit describes the tree as of its date
  and files it names may legitimately be deleted later. This also retired the
  prior outbound-attachments baseline entry (dated doc). Factory script tests:
  135 pass after the F19/F22 edits and the rule change.

## Phase 7 outcomes

### Current-tree revalidation

F1 still applied at Phase 6 head
`f0f79afcf0276414b44132c6f303ff791d0477a0`. The current Drizzle schema has 93
tables, while the pre-Phase-7 migration set still had 102 SQL files, 102
journal entries, and five retained snapshots (`0100` through `0104`). The
former head was `0104_settings_authority_cutover`, not a baseline generated
from the final Phase 6 schema.

The replacement was generated from
`apps/core/src/adapters/storage/postgres/schema/schema.ts` with:

```bash
./node_modules/.bin/drizzle-kit generate --dialect postgresql --schema apps/core/src/adapters/storage/postgres/schema/schema.ts --out <isolated temp dir> --name ponytail_baseline --breakpoints
```

No TypeScript schema source changed. The only mechanical corrections to the
generated SQL were removing 168 `"public".` qualifiers to retain the existing
schema-neutral migration contract and parenthesizing the three constant-value
memory indexes for `light`, `rem`, and `deep`. The baseline also carries
forward seven live CHECK constraints and five live repository indexes that
were installed after the canonical table resets but are not represented in
the current Drizzle schema source. They therefore remain explicit raw-SQL-only
baseline objects and are intentionally absent from the Drizzle snapshot;
recording them there would make the next normal generation emit destructive
drops. Focused tests pin both halves of that policy: the SQL must retain all
twelve and the snapshot must omit them until a separately scoped schema-source
adoption is implemented.

The final disposition is one SQL baseline, one `idx: 0` journal entry, and one
snapshot. It removes the 102 old SQL files, all 102 old journal entries, and
the five `0100`-`0104` snapshots. This phase generated and inspected artifacts
only: no database replay, catalog-equivalence comparison, live database or
service command, settings import, or cutover action was run.

| Item                    | Outcome     | Evidence and boundary                                                                                                                                                                                        |
| ----------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1                      | Implemented | Replaced the pre-release migration chain with one current-schema SQL baseline, one journal entry, and one matching 93-table snapshot.                                                                        |
| Baseline stamp contract | Implemented | Pinned the exact Drizzle timestamp and corrected SQL SHA-256 below. Phase 8 must insert that pair verbatim and retain every historical stamp on the one preserved workstation.                               |
| Offline cutover runbook | Implemented | Extended this existing ledger/runbook with the machine-specific Phase 8 restamp, rollback, and all-other-environments reset procedures below.                                                                |
| Live cutover            | Deferred    | Phase 8 owns explicit approval, downtime, service stop, backup, canonical revision append, row checks, restamp, restart, exact-head validation, and rollback. Phase 7 performs none of those stateful steps. |

### Final baseline stamp metadata

- Journal tag: `0000_ponytail_baseline`
- Journal index: `0`
- Journal timestamp / Drizzle `created_at`: **`1784609882223`**
- Corrected SQL SHA-256 / Drizzle migration `hash`:
  **`406a5a9af01f7aa922a8a2df716019f85a742577e0163e2d1e131c93544872ea`**
- Snapshot SHA-256:
  **`9e93499964e82d3a8862920cf664f9523a848b03cc76c01b0f10f22871e04deb`**
- Snapshot tables: `93`

Phase 8 must copy the numeric timestamp and lowercase migration hash verbatim.
It must not substitute the snapshot hash, a regenerated timestamp, or the old
`0104` hash.

### Phase 8 offline cutover runbook

**Documentation only: none of the commands in this section was run in Phase 7.** This restamp path is approved only for the single preserved workstation
at `/Users/ravikiranvemula/gantry`. Never replay
`0000_ponytail_baseline.sql` against its populated database and never delete
its old migration stamps.

Run steps 0-7 in order in one dedicated interactive `zsh` session. The first
command enables `errexit`, `nounset`, and `pipefail`; every later shell block
inherits that state and every nonzero guard terminates the cutover. Do not run
blocks in separate shells, skip a guard, append `|| true`, or resume after a
failure. Keep the failed service offline and enter step 8 in that same shell.

`settings_revisions` remains the durable desired-state authority;
`/Users/ravikiranvemula/gantry/settings.yaml` remains its canonical readable
mirror. Phase 7 writes neither.

#### 0. Approval, topology, builds, and canonical candidate

Obtain explicit Phase 8 approval and a downtime window. Re-confirm that this
is a single `workstation` deployment, that `storage.postgres.schema` is exactly
`gantry`, and that no other host or Gantry worker uses the database. The backup
step below must also prove that the database is dedicated to Gantry. A fleet,
multi-host, different-schema, or shared-database result is a stop condition
requiring a new cutover decision.

Before downtime, preserve and build the exact Phase 6 head, then build the
landed Phase 7 checkout:

```bash
set -euo pipefail
if ! test -e /private/tmp/gantry-ponytail-phase6; then
  git -C /Users/ravikiranvemula/Workdir/myclaw worktree add --detach /private/tmp/gantry-ponytail-phase6 f0f79afcf0276414b44132c6f303ff791d0477a0
fi
test "$(git -C /private/tmp/gantry-ponytail-phase6 rev-parse HEAD)" = "f0f79afcf0276414b44132c6f303ff791d0477a0"
test -z "$(git -C /private/tmp/gantry-ponytail-phase6 status --porcelain)"
ln -sfn /Users/ravikiranvemula/Workdir/myclaw/node_modules /private/tmp/gantry-ponytail-phase6/node_modules
npm --prefix /private/tmp/gantry-ponytail-phase6 run build
test -z "$(git -C /Users/ravikiranvemula/Workdir/myclaw status --porcelain)"
PONYTAIL_PHASE7_HEAD=$(git -C /Users/ravikiranvemula/Workdir/myclaw rev-parse HEAD)
npm --prefix /Users/ravikiranvemula/Workdir/myclaw run build
test "$(shasum -a 256 /Users/ravikiranvemula/Workdir/myclaw/dist/adapters/storage/postgres/schema/migrations/0000_ponytail_baseline.sql | awk '{print $1}')" = "406a5a9af01f7aa922a8a2df716019f85a742577e0163e2d1e131c93544872ea"
```

If `/private/tmp/gantry-ponytail-phase6` already exists, do not recreate or
overwrite it; verify its exact HEAD and clean state before using it. Retain the
Phase 6 worktree and `$PONYTAIL_PHASE7_HEAD` through the rollback window.

Prepare
`/Users/ravikiranvemula/gantry/settings.ponytail-phase8.yaml` from the current
readable settings file, but do not import it yet. It must use the canonical
Phase 6-rendered provider-account, Conversation, and
`conversations.*.installed_agents` shape and must:

- delete every `codex_test_*` conversation rather than translate it;
- remove install-level `trigger` and `requires_trigger` keys;
- move trigger admission to Conversation-owned `requires_trigger`;
- set `requires_trigger: false` for `main_telegram_group` and
  `telegram_default_-1003798366047_0f76daeb32c4`; and
- set `desired_state.authoritative: true` for the one-time reconciliation.

Review provider-account IDs, installed-agent IDs, control approvers,
capabilities, and secret references. Do not edit Postgres or the active file to
bypass the desired-state service.

#### 1. Stop `com.gantry` and prove it is offline

```bash
launchctl bootout "gui/$(id -u)/com.gantry"
if launchctl print "gui/$(id -u)/com.gantry" >/dev/null 2>&1; then
  echo "com.gantry is still loaded" >&2
  exit 1
fi
```

Do not continue while any Gantry runtime or worker for
`/Users/ravikiranvemula/gantry` is still serving work.

#### 2. Back up Postgres, settings, revisions, and stamps

Parse only the connection URL as data with Gantry's existing env-file parser,
without sourcing or printing the runtime secret file. Create a mode-`0700`
operator backup directory outside the agent runtime tree and derive mode-`0600`
libpq service/password files. The password is never placed in a process
argument, and unrelated runtime secrets are never exported to child processes.
Step 7 encrypts this whole directory with an operator-entered passphrase and
removes every plaintext credential/backup artifact before Gantry restarts:

```bash
set -euo pipefail
PONYTAIL_OPERATOR_BACKUP_ROOT="/Users/ravikiranvemula/Library/Application Support/Gantry Operator Backups"
mkdir -p "$PONYTAIL_OPERATOR_BACKUP_ROOT"
chmod 700 "$PONYTAIL_OPERATOR_BACKUP_ROOT"
PONYTAIL_BACKUP_DIR="$PONYTAIL_OPERATOR_BACKUP_ROOT/ponytail-phase8-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$PONYTAIL_BACKUP_DIR"
node --input-type=module - /Users/ravikiranvemula/gantry/.env "$PONYTAIL_BACKUP_DIR/database-url" <<'NODE'
import fs from 'node:fs';

import { parseEnvContent } from '/Users/ravikiranvemula/Workdir/myclaw/dist/shared/env-file.js';

const [envPath, outputPath] = process.argv.slice(2);
const parsed = parseEnvContent(fs.readFileSync(envPath, 'utf8'));
const databaseUrl = parsed.GANTRY_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('GANTRY_DATABASE_URL is missing');
const fd = fs.openSync(outputPath, 'wx', 0o600);
try {
  fs.writeFileSync(fd, databaseUrl, 'utf8');
} finally {
  fs.closeSync(fd);
}
NODE
python3 - "$PONYTAIL_BACKUP_DIR" <<'PY'
import os
import re
import sys
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlsplit

backup_dir = Path(sys.argv[1])
url_path = backup_dir / "database-url"
parsed = urlsplit(url_path.read_text())
if parsed.scheme not in {"postgres", "postgresql"}:
    raise SystemExit("GANTRY_DATABASE_URL must use postgres or postgresql")
if parsed.hostname is None or parsed.username is None or not parsed.path.lstrip("/"):
    raise SystemExit("GANTRY_DATABASE_URL must include host, user, and database")

def service_quote(value: str) -> str:
    if "\n" in value or "\r" in value:
        raise SystemExit("multiline libpq values are not supported")
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"

def pgpass_escape(value: str) -> str:
    if "\n" in value or "\r" in value:
        raise SystemExit("multiline libpq values are not supported")
    return value.replace("\\", "\\\\").replace(":", "\\:")

host = unquote(parsed.hostname)
port = str(parsed.port or 5432)
database = unquote(parsed.path.lstrip("/"))
user = unquote(parsed.username)
password = unquote(parsed.password or "")
service_values = {"host": host, "port": port, "dbname": database, "user": user}
for key, value in parse_qsl(parsed.query, keep_blank_values=True):
    if key == "schema":
        if value != "gantry":
            raise SystemExit("this machine's cutover requires schema=gantry")
        continue
    if not re.fullmatch(r"[a-z_]+", key) or key in {
        "password", "passfile", "service", "servicefile"
    }:
        raise SystemExit(f"unsupported connection parameter: {key}")
    service_values[key] = value

service_path = backup_dir / "pg_service.conf"
pass_path = backup_dir / ".pgpass"
service_fd = os.open(service_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(service_fd, "w") as handle:
    handle.write("[gantry_ponytail_phase8]\n")
    for key, value in service_values.items():
        handle.write(f"{key}={service_quote(value)}\n")
pass_fd = os.open(pass_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(pass_fd, "w") as handle:
    handle.write(":".join(pgpass_escape(value) for value in (host, port, database, user, password)) + "\n")
url_path.unlink()
PY
export PGSERVICEFILE="$PONYTAIL_BACKUP_DIR/pg_service.conf"
export PGSERVICE=gantry_ponytail_phase8
export PGPASSFILE="$PONYTAIL_BACKUP_DIR/.pgpass"
PONYTAIL_UNEXPECTED_SCHEMA_COUNT=$(psql --set ON_ERROR_STOP=1 --tuples-only --no-align --command "SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'public', 'gantry', 'gantry_deepagents', 'pgboss') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp_%'")
PONYTAIL_PUBLIC_RELATION_COUNT=$(psql --set ON_ERROR_STOP=1 --tuples-only --no-align --command "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')")
if test "$PONYTAIL_UNEXPECTED_SCHEMA_COUNT" -ne 0 || test "$PONYTAIL_PUBLIC_RELATION_COUNT" -ne 0; then
  echo "database topology is not dedicated to Gantry" >&2
  exit 1
fi
cp /Users/ravikiranvemula/gantry/settings.yaml "$PONYTAIL_BACKUP_DIR/settings.yaml"
cp /Users/ravikiranvemula/gantry/settings.ponytail-phase8.yaml "$PONYTAIL_BACKUP_DIR/settings.ponytail-phase8.yaml"
pg_dump --format=custom --no-owner --no-privileges --file "$PONYTAIL_BACKUP_DIR/gantry.dump"
psql --set ON_ERROR_STOP=1 --csv --command 'SELECT app_id, revision, settings_document_json, min_reader_version, created_by, note, created_at FROM "gantry"."settings_revisions" ORDER BY app_id, revision' > "$PONYTAIL_BACKUP_DIR/settings-revisions.csv"
psql --set ON_ERROR_STOP=1 --csv --command 'SELECT id, hash, created_at FROM "gantry"."__drizzle_migrations" ORDER BY created_at, id' > "$PONYTAIL_BACKUP_DIR/drizzle-stamps.csv"
PONYTAIL_EXPECTED_REVISION=$(psql --set ON_ERROR_STOP=1 --tuples-only --no-align --command "SELECT max(revision) FROM \"gantry\".\"settings_revisions\" WHERE app_id = 'default'")
PONYTAIL_STAMP_COUNT_BEFORE=$(psql --set ON_ERROR_STOP=1 --tuples-only --no-align --command 'SELECT count(*) FROM "gantry"."__drizzle_migrations"')
printf '%s\n' "$PONYTAIL_EXPECTED_REVISION" > "$PONYTAIL_BACKUP_DIR/pre-cutover-revision.txt"
printf '%s\n' "$PONYTAIL_STAMP_COUNT_BEFORE" > "$PONYTAIL_BACKUP_DIR/pre-cutover-stamp-count.txt"
```

The two catalog assertions permit only Gantry's `gantry`, optional
`gantry_deepagents`, and `pgboss` schemas, with no application relations in
`public`. Any unexpected schema or public relation means this is a shared
database: stop before `pg_dump`; the full-database backup/restore procedure is
not authorized for that topology.

Require nonempty evidence, secure credential files, and the exact old `0104`
head before any mutation:

```bash
test -s "$PONYTAIL_BACKUP_DIR/gantry.dump"
test -s "$PONYTAIL_BACKUP_DIR/settings.yaml"
test -s "$PONYTAIL_BACKUP_DIR/settings.ponytail-phase8.yaml"
test -s "$PONYTAIL_BACKUP_DIR/settings-revisions.csv"
test -s "$PONYTAIL_BACKUP_DIR/drizzle-stamps.csv"
test -n "$PONYTAIL_EXPECTED_REVISION"
test "$(stat -f '%Lp' "$PGSERVICEFILE")" = 600
test "$(stat -f '%Lp' "$PGPASSFILE")" = 600
test "$(psql --set ON_ERROR_STOP=1 --tuples-only --no-align --command "SELECT count(*) FROM \"gantry\".\"__drizzle_migrations\" WHERE created_at = 1784430700000 AND hash = '22f9eefe9b1b25eca5b99f64a104a0d4399aea8390194395e89993a461b92cdd'")" = 1
test "$(psql --set ON_ERROR_STOP=1 --tuples-only --no-align --command 'SELECT count(*) FROM "gantry"."__drizzle_migrations" WHERE created_at > 1784430700000')" = 0
```

Any failure is a stop condition. Keep the service offline and restore or
investigate; do not restamp.

#### 3. Append the canonical revision while the database advertises `0104`

Use the preserved Phase 6 CLI and the captured compare-and-set revision:

```bash
node /private/tmp/gantry-ponytail-phase6/dist/cli/index.js --runtime-home /Users/ravikiranvemula/gantry settings import --file /Users/ravikiranvemula/gantry/settings.ponytail-phase8.yaml --expected-revision "$PONYTAIL_EXPECTED_REVISION" --note "Ponytail Phase 8 canonical cutover before baseline restamp"
PONYTAIL_CUTOVER_REVISION=$((PONYTAIL_EXPECTED_REVISION + 1))
```

Require the CLI outcome `revision_created(<PONYTAIL_CUTOVER_REVISION>)`.
`no_op`, `applied_no_revision`, projection failure, or any other error fails the
cutover. Then require the new revision to be latest and the active readable
file to match the reviewed candidate:

```bash
test "$(psql --set ON_ERROR_STOP=1 --tuples-only --no-align --command "SELECT max(revision) FROM \"gantry\".\"settings_revisions\" WHERE app_id = 'default'")" = "$PONYTAIL_CUTOVER_REVISION"
psql --set ON_ERROR_STOP=1 --expanded --command "SELECT revision, min_reader_version, created_by, note, created_at FROM \"gantry\".\"settings_revisions\" WHERE app_id = 'default' ORDER BY revision DESC LIMIT 1"
diff -u /Users/ravikiranvemula/gantry/settings.ponytail-phase8.yaml /Users/ravikiranvemula/gantry/settings.yaml
```

#### 4. Transactionally restamp the canonical conversation identity graph

The Phase 6 settings writer deliberately preserves an existing matching
Conversation ID, so the revision append alone cannot complete the Phase 3
identity cutover. Create and execute the following transaction before touching
the catalog or migration stamps. It derives each canonical Conversation ID as
`conversation:<provider-account-id>:<jid>`, inserts replacement parent rows
before rewiring children, restamps canonical thread/participant/approver
identities, updates every direct Conversation/Thread reference in the current
93-table schema, and rewrites the three supported Conversation references in
`conversation_installs.memory_subject_json`. Any malformed identity, unsafe
participant ID, collision, or inconsistent memory reference aborts the whole
transaction:

```bash
cat > "$PONYTAIL_BACKUP_DIR/phase8-conversation-restamp.sql" <<'SQL'
BEGIN;

LOCK TABLE
  "gantry"."conversations",
  "gantry"."conversation_threads",
  "gantry"."conversation_installs",
  "gantry"."conversation_participants",
  "gantry"."conversation_approvers"
IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE ponytail_conversation_identity ON COMMIT DROP AS
WITH source AS (
  SELECT
    c.id AS old_id,
    c.provider_account_id,
    'conversation:' || c.provider_account_id || ':' AS canonical_prefix
  FROM "gantry"."conversations" c
)
SELECT
  old_id,
  provider_account_id,
  CASE
    WHEN left(old_id, char_length(canonical_prefix)) = canonical_prefix
      THEN substring(old_id FROM char_length(canonical_prefix) + 1)
    ELSE substring(old_id FROM char_length('conversation:') + 1)
  END AS jid,
  canonical_prefix || CASE
    WHEN left(old_id, char_length(canonical_prefix)) = canonical_prefix
      THEN substring(old_id FROM char_length(canonical_prefix) + 1)
    ELSE substring(old_id FROM char_length('conversation:') + 1)
  END AS new_id
FROM source;

DO $ponytail$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "gantry"."conversations" c
    LEFT JOIN "gantry"."provider_accounts" pa
      ON pa.id = c.provider_account_id
    WHERE left(c.id, char_length('conversation:')) <> 'conversation:'
      OR NULLIF(btrim(c.provider_account_id), '') IS NULL
      OR pa.id IS NULL
  ) THEN
    RAISE EXCEPTION 'conversation identity cannot be derived safely';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ponytail_conversation_identity
    WHERE NULLIF(jid, '') IS NULL
  ) THEN
    RAISE EXCEPTION 'conversation identity has an empty jid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ponytail_conversation_identity
    GROUP BY new_id
    HAVING count(*) <> 1
  ) OR EXISTS (
    SELECT 1
    FROM ponytail_conversation_identity identity
    JOIN "gantry"."conversations" existing
      ON existing.id = identity.new_id
     AND existing.id <> identity.old_id
  ) THEN
    RAISE EXCEPTION 'canonical conversation identity collision';
  END IF;
END
$ponytail$;

CREATE TEMP TABLE ponytail_conversation_id_map ON COMMIT DROP AS
SELECT old_id, new_id, provider_account_id, jid
FROM ponytail_conversation_identity
WHERE old_id <> new_id;

CREATE TEMP TABLE ponytail_thread_identity ON COMMIT DROP AS
WITH source AS (
  SELECT
    thread.id AS old_id,
    identity.new_id AS conversation_id,
    identity.provider_account_id,
    identity.jid,
    COALESCE(
      thread.external_ref_json::jsonb ->> 'threadId',
      thread.external_ref_json::jsonb ->> 'externalThreadId',
      thread.external_ref_json::jsonb ->> 'value'
    ) AS public_thread_id,
    'thread:' || identity.provider_account_id || ':' AS account_prefix
  FROM "gantry"."conversation_threads" thread
  JOIN ponytail_conversation_identity identity
    ON identity.old_id = thread.conversation_id
)
SELECT
  old_id,
  conversation_id,
  public_thread_id,
  CASE
    WHEN left(public_thread_id, char_length(account_prefix)) = account_prefix
      THEN public_thread_id
    ELSE account_prefix || jid || ':' || public_thread_id
  END AS new_id
FROM source;

DO $ponytail$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ponytail_thread_identity
    WHERE NULLIF(btrim(public_thread_id), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'thread identity cannot be derived safely';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ponytail_thread_identity
    GROUP BY new_id
    HAVING count(*) <> 1
  ) OR EXISTS (
    SELECT 1
    FROM ponytail_thread_identity identity
    JOIN "gantry"."conversation_threads" existing
      ON existing.id = identity.new_id
     AND existing.id <> identity.old_id
  ) THEN
    RAISE EXCEPTION 'canonical thread identity collision';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "gantry"."conversation_participants" participant
    JOIN ponytail_conversation_id_map map
      ON map.old_id = participant.conversation_id
    WHERE NULLIF(btrim(participant.external_user_id), '') IS NULL
      OR participant.external_user_id !~ '^[A-Za-z0-9._:-]+$'
  ) THEN
    RAISE EXCEPTION 'participant identity requires reviewed encoding';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "gantry"."conversation_installs" install
    JOIN ponytail_conversation_id_map map
      ON map.old_id = install.conversation_id
    WHERE (
        install.memory_subject_json::jsonb ? 'conversationId'
        AND install.memory_subject_json::jsonb ->> 'conversationId' <> map.old_id
      ) OR (
        (install.memory_subject_json::jsonb #> '{liveRoute}') ? 'conversationId'
        AND install.memory_subject_json::jsonb #>> '{liveRoute,conversationId}' <> map.old_id
      ) OR (
        (install.memory_subject_json::jsonb #> '{route}') ? 'conversationId'
        AND install.memory_subject_json::jsonb #>> '{route,conversationId}' <> map.old_id
      )
  ) THEN
    RAISE EXCEPTION 'conversation install memory identity is inconsistent';
  END IF;
END
$ponytail$;

CREATE TEMP TABLE ponytail_thread_id_map ON COMMIT DROP AS
SELECT old_id, new_id
FROM ponytail_thread_identity
WHERE old_id <> new_id;

CREATE TEMP TABLE ponytail_participant_id_map ON COMMIT DROP AS
SELECT
  participant.id AS old_id,
  'participant:' || map.new_id || ':' || participant.external_user_id AS new_id
FROM "gantry"."conversation_participants" participant
JOIN ponytail_conversation_id_map map
  ON map.old_id = participant.conversation_id;

CREATE TEMP TABLE ponytail_approver_id_map ON COMMIT DROP AS
SELECT
  approver.id AS old_id,
  'channel-control:'
    || regexp_replace(btrim(map.new_id), '[^a-zA-Z0-9._:@-]', '_', 'g')
    || ':'
    || regexp_replace(btrim(approver.external_user_id), '[^a-zA-Z0-9._:@-]', '_', 'g')
    AS new_id
FROM "gantry"."conversation_approvers" approver
JOIN ponytail_conversation_id_map map
  ON map.old_id = approver.conversation_id;

DO $ponytail$
BEGIN
  IF EXISTS (
    SELECT new_id FROM ponytail_participant_id_map
    GROUP BY new_id HAVING count(*) <> 1
  ) OR EXISTS (
    SELECT 1
    FROM ponytail_participant_id_map map
    JOIN "gantry"."conversation_participants" existing
      ON existing.id = map.new_id
     AND existing.id <> map.old_id
  ) THEN
    RAISE EXCEPTION 'canonical participant identity collision';
  END IF;

  IF EXISTS (
    SELECT new_id FROM ponytail_approver_id_map
    GROUP BY new_id HAVING count(*) <> 1
  ) OR EXISTS (
    SELECT 1
    FROM ponytail_approver_id_map map
    JOIN "gantry"."conversation_approvers" existing
      ON existing.id = map.new_id
     AND existing.id <> map.old_id
  ) THEN
    RAISE EXCEPTION 'canonical approver identity collision';
  END IF;
END
$ponytail$;

INSERT INTO "gantry"."conversations" (
  id, app_id, provider_account_id, external_ref_json, kind, title,
  requires_trigger, status, created_at, updated_at
)
SELECT
  map.new_id, conversation.app_id, conversation.provider_account_id,
  conversation.external_ref_json, conversation.kind, conversation.title,
  conversation.requires_trigger, conversation.status,
  conversation.created_at, conversation.updated_at
FROM "gantry"."conversations" conversation
JOIN ponytail_conversation_id_map map ON map.old_id = conversation.id;

INSERT INTO "gantry"."conversation_threads" (
  id, app_id, conversation_id, external_ref_json, title, status,
  created_at, updated_at
)
SELECT
  identity.new_id, thread.app_id, identity.conversation_id,
  thread.external_ref_json, thread.title, thread.status,
  thread.created_at, thread.updated_at
FROM "gantry"."conversation_threads" thread
JOIN ponytail_thread_identity identity ON identity.old_id = thread.id
WHERE identity.old_id <> identity.new_id;

UPDATE "gantry"."memory_candidates" AS target_row SET thread_id = map.new_id FROM ponytail_thread_id_map map WHERE target_row.thread_id = map.old_id;
UPDATE "gantry"."memory_dream_decisions" AS target_row SET thread_id = map.new_id FROM ponytail_thread_id_map map WHERE target_row.thread_id = map.old_id;
UPDATE "gantry"."memory_dream_runs" AS target_row SET thread_id = map.new_id FROM ponytail_thread_id_map map WHERE target_row.thread_id = map.old_id;
UPDATE "gantry"."memory_evidence" AS target_row SET thread_id = map.new_id FROM ponytail_thread_id_map map WHERE target_row.thread_id = map.old_id;
UPDATE "gantry"."memory_review_requests" AS target_row SET thread_id = map.new_id FROM ponytail_thread_id_map map WHERE target_row.thread_id = map.old_id;
UPDATE "gantry"."agent_async_tasks" AS target_row SET thread_id = map.new_id FROM ponytail_thread_id_map map WHERE target_row.thread_id = map.old_id;
UPDATE "gantry"."conversation_installs" AS target_row SET thread_id = map.new_id FROM ponytail_thread_id_map map WHERE target_row.thread_id = map.old_id;
UPDATE "gantry"."control_http_response_routes" AS target_row SET thread_id = map.new_id FROM ponytail_thread_id_map map WHERE target_row.thread_id = map.old_id;
UPDATE "gantry"."runtime_events" AS target_row SET thread_id = map.new_id FROM ponytail_thread_id_map map WHERE target_row.thread_id = map.old_id;
UPDATE "gantry"."jobs" AS target_row SET thread_id = map.new_id FROM ponytail_thread_id_map map WHERE target_row.thread_id = map.old_id;
UPDATE "gantry"."live_admission_work_items" AS target_row SET thread_id = map.new_id FROM ponytail_thread_id_map map WHERE target_row.thread_id = map.old_id;
UPDATE "gantry"."live_turns" AS target_row SET thread_id = map.new_id FROM ponytail_thread_id_map map WHERE target_row.thread_id = map.old_id;
UPDATE "gantry"."memory_items" AS target_row SET thread_id = map.new_id FROM ponytail_thread_id_map map WHERE target_row.thread_id = map.old_id;
UPDATE "gantry"."messages" AS target_row SET thread_id = map.new_id FROM ponytail_thread_id_map map WHERE target_row.thread_id = map.old_id;
UPDATE "gantry"."agent_mcp_server_bindings" AS target_row SET thread_id = map.new_id FROM ponytail_thread_id_map map WHERE target_row.thread_id = map.old_id;
UPDATE "gantry"."outbound_deliveries" AS target_row SET thread_id = map.new_id FROM ponytail_thread_id_map map WHERE target_row.thread_id = map.old_id;
UPDATE "gantry"."agent_runs" AS target_row SET thread_id = map.new_id FROM ponytail_thread_id_map map WHERE target_row.thread_id = map.old_id;
UPDATE "gantry"."agent_session_digests" AS target_row SET scope_thread_id = map.new_id FROM ponytail_thread_id_map map WHERE target_row.scope_thread_id = map.old_id;
UPDATE "gantry"."agent_sessions" AS target_row SET thread_id = map.new_id FROM ponytail_thread_id_map map WHERE target_row.thread_id = map.old_id;
UPDATE "gantry"."permission_prompts" AS target_row SET thread_id = map.new_id FROM ponytail_thread_id_map map WHERE target_row.thread_id = map.old_id;

DELETE FROM "gantry"."conversation_threads" thread
USING ponytail_thread_id_map map
WHERE thread.id = map.old_id;

UPDATE "gantry"."conversation_threads" thread
SET conversation_id = map.new_id
FROM ponytail_conversation_id_map map
WHERE thread.conversation_id = map.old_id;

UPDATE "gantry"."conversation_installs" install
SET memory_subject_json = jsonb_set(
  jsonb_set(
    jsonb_set(
      install.memory_subject_json::jsonb,
      '{conversationId}', to_jsonb(map.new_id), false
    ),
    '{liveRoute,conversationId}', to_jsonb(map.new_id), false
  ),
  '{route,conversationId}', to_jsonb(map.new_id), false
)::text
FROM ponytail_conversation_id_map map
WHERE install.conversation_id = map.old_id;

UPDATE "gantry"."conversation_participants" participant
SET id = ids.new_id, conversation_id = map.new_id
FROM ponytail_participant_id_map ids, ponytail_conversation_id_map map
WHERE participant.id = ids.old_id
  AND participant.conversation_id = map.old_id;

UPDATE "gantry"."conversation_approvers" approver
SET id = ids.new_id, conversation_id = map.new_id
FROM ponytail_approver_id_map ids, ponytail_conversation_id_map map
WHERE approver.id = ids.old_id
  AND approver.conversation_id = map.old_id;

UPDATE "gantry"."agent_async_tasks" AS target_row SET conversation_id = map.new_id FROM ponytail_conversation_id_map map WHERE target_row.conversation_id = map.old_id;
UPDATE "gantry"."conversation_installs" AS target_row SET conversation_id = map.new_id FROM ponytail_conversation_id_map map WHERE target_row.conversation_id = map.old_id;
UPDATE "gantry"."control_http_sessions" AS target_row SET conversation_id = map.new_id FROM ponytail_conversation_id_map map WHERE target_row.conversation_id = map.old_id;
UPDATE "gantry"."runtime_events" AS target_row SET conversation_id = map.new_id FROM ponytail_conversation_id_map map WHERE target_row.conversation_id = map.old_id;
UPDATE "gantry"."jobs" AS target_row SET conversation_id = map.new_id FROM ponytail_conversation_id_map map WHERE target_row.conversation_id = map.old_id;
UPDATE "gantry"."live_admission_work_items" AS target_row SET conversation_id = map.new_id FROM ponytail_conversation_id_map map WHERE target_row.conversation_id = map.old_id;
UPDATE "gantry"."live_turns" AS target_row SET conversation_id = map.new_id FROM ponytail_conversation_id_map map WHERE target_row.conversation_id = map.old_id;
UPDATE "gantry"."memory_items" AS target_row SET conversation_id = map.new_id FROM ponytail_conversation_id_map map WHERE target_row.conversation_id = map.old_id;
UPDATE "gantry"."messages" AS target_row SET conversation_id = map.new_id FROM ponytail_conversation_id_map map WHERE target_row.conversation_id = map.old_id;
UPDATE "gantry"."agent_mcp_server_bindings" AS target_row SET conversation_id = map.new_id FROM ponytail_conversation_id_map map WHERE target_row.conversation_id = map.old_id;
UPDATE "gantry"."outbound_deliveries" AS target_row SET conversation_id = map.new_id FROM ponytail_conversation_id_map map WHERE target_row.conversation_id = map.old_id;
UPDATE "gantry"."agent_runs" AS target_row SET conversation_id = map.new_id FROM ponytail_conversation_id_map map WHERE target_row.conversation_id = map.old_id;
UPDATE "gantry"."agent_session_digests" AS target_row SET scope_conversation_id = map.new_id FROM ponytail_conversation_id_map map WHERE target_row.scope_conversation_id = map.old_id;
UPDATE "gantry"."agent_sessions" AS target_row SET conversation_id = map.new_id FROM ponytail_conversation_id_map map WHERE target_row.conversation_id = map.old_id;

DELETE FROM "gantry"."conversations" conversation
USING ponytail_conversation_id_map map
WHERE conversation.id = map.old_id;

DO $ponytail$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "gantry"."conversations" conversation
    WHERE left(
      conversation.id,
      char_length('conversation:' || conversation.provider_account_id || ':')
    ) <> 'conversation:' || conversation.provider_account_id || ':'
  ) THEN
    RAISE EXCEPTION 'legacy conversation identity remains';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "gantry"."conversation_installs" install
    WHERE (
        install.memory_subject_json::jsonb ? 'conversationId'
        AND install.memory_subject_json::jsonb ->> 'conversationId' <> install.conversation_id
      ) OR (
        (install.memory_subject_json::jsonb #> '{liveRoute}') ? 'conversationId'
        AND install.memory_subject_json::jsonb #>> '{liveRoute,conversationId}' <> install.conversation_id
      ) OR (
        (install.memory_subject_json::jsonb #> '{route}') ? 'conversationId'
        AND install.memory_subject_json::jsonb #>> '{route,conversationId}' <> install.conversation_id
      )
  ) THEN
    RAISE EXCEPTION 'restamped conversation memory reference is inconsistent';
  END IF;
END
$ponytail$;

COMMIT;
SQL
psql --set ON_ERROR_STOP=1 --file "$PONYTAIL_BACKUP_DIR/phase8-conversation-restamp.sql"
```

The transaction is intentionally exhaustive for exact Conversation and Thread
columns in the Phase 7 snapshot. Do not shorten its update list or convert a
collision into `ON CONFLICT`; a failure requires restoring the backup or
preparing a separately reviewed data correction.

While the database still advertises `0104`, create one reusable assertion file
and run it. It fails closed on legacy route identities, incomplete or
non-strict job routing objects, legacy job-routing aliases, and missing
execution-provider identity:

```bash
cat > "$PONYTAIL_BACKUP_DIR/phase8-row-assertions.sql" <<'SQL'
DO $ponytail$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "gantry"."conversation_installs"
    WHERE status = 'active'
      AND id LIKE 'conversation-route:%'
      AND (
        id NOT LIKE '%::agent:%'
        OR id NOT LIKE '%::provider_account:%'
        OR NOT (memory_subject_json::jsonb ? 'liveRoute')
        OR memory_subject_json::jsonb ? 'route'
        OR NOT (memory_subject_json::jsonb ? 'conversationId')
        OR NOT (
          (memory_subject_json::jsonb #> '{liveRoute}') ? 'conversationId'
        )
        OR conversation_id <>
          'conversation:' || provider_account_id || ':' ||
          split_part(
            split_part(
              split_part(
                substring(id FROM char_length('conversation-route:') + 1),
                '::thread:', 1
              ),
              '::agent:', 1
            ),
            '::provider_account:', 1
          )
        OR memory_subject_json::jsonb ->> 'conversationId' <> conversation_id
        OR memory_subject_json::jsonb #>> '{liveRoute,conversationId}' <> conversation_id
      )
  ) THEN
    RAISE EXCEPTION 'active conversation routes are not canonical';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "gantry"."conversations" conversation
    WHERE left(
      conversation.id,
      char_length('conversation:' || conversation.provider_account_id || ':')
    ) <> 'conversation:' || conversation.provider_account_id || ':'
      OR char_length(conversation.id) <=
        char_length('conversation:' || conversation.provider_account_id || ':')
  ) THEN
    RAISE EXCEPTION 'conversation identity is not provider-account-qualified';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "gantry"."jobs" job
    WHERE job.target_json ?| ARRAY[
      'linked_sessions', 'linkedSessions', 'notificationTarget',
      'deliver_to', 'deliverTo', 'notifyLinkedSessions',
      'sessionId', 'threadId', 'group' || 'Scope', 'group_' || 'scope'
    ]
      OR CASE
        WHEN jsonb_typeof(job.target_json -> 'executionContext') = 'object'
        THEN
          jsonb_typeof(job.target_json #> '{executionContext,conversationJid}') IS DISTINCT FROM 'string'
          OR NULLIF(btrim(job.target_json #>> '{executionContext,conversationJid}'), '') IS NULL
          OR jsonb_typeof(job.target_json #> '{executionContext,workspaceKey}') IS DISTINCT FROM 'string'
          OR NULLIF(btrim(job.target_json #>> '{executionContext,workspaceKey}'), '') IS NULL
          OR NOT ((job.target_json -> 'executionContext') ? 'threadId')
          OR jsonb_typeof(job.target_json #> '{executionContext,threadId}') NOT IN ('string', 'null')
          OR (
            (job.target_json -> 'executionContext') ? 'sessionId'
            AND jsonb_typeof(job.target_json #> '{executionContext,sessionId}') NOT IN ('string', 'null')
          )
          OR (
            (job.target_json -> 'executionContext')
            - 'conversationJid' - 'workspaceKey' - 'threadId' - 'sessionId'
          ) <> '{}'::jsonb
        ELSE TRUE
      END
      OR CASE
        WHEN jsonb_typeof(job.target_json -> 'notificationRoutes') = 'array'
        THEN
          jsonb_array_length(job.target_json -> 'notificationRoutes') = 0
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(job.target_json -> 'notificationRoutes') AS item(route)
            WHERE CASE
              WHEN jsonb_typeof(item.route) = 'object'
              THEN
                jsonb_typeof(item.route -> 'conversationJid') IS DISTINCT FROM 'string'
                OR NULLIF(btrim(item.route ->> 'conversationJid'), '') IS NULL
                OR NOT (item.route ? 'threadId')
                OR jsonb_typeof(item.route -> 'threadId') NOT IN ('string', 'null')
                OR jsonb_typeof(item.route -> 'label') IS DISTINCT FROM 'string'
                OR NULLIF(btrim(item.route ->> 'label'), '') IS NULL
                OR (
                  item.route ? 'providerAccountId'
                  AND jsonb_typeof(item.route -> 'providerAccountId') NOT IN ('string', 'null')
                )
                OR (
                  item.route
                  - 'conversationJid' - 'threadId' - 'providerAccountId' - 'label'
                ) <> '{}'::jsonb
              ELSE TRUE
            END
          )
        ELSE TRUE
      END
  ) THEN
    RAISE EXCEPTION 'jobs.target_json is not canonical strict executionContext/notificationRoutes data';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "gantry"."agent_runs"
    WHERE execution_provider_id IS NULL OR btrim(execution_provider_id) = ''
  ) THEN
    RAISE EXCEPTION 'agent runs are missing execution_provider_id';
  END IF;
END
$ponytail$;
SQL
psql --set ON_ERROR_STOP=1 --file "$PONYTAIL_BACKUP_DIR/phase8-row-assertions.sql"
```

Any assertion failure is a stop condition, not a silent repair step. Review and
approve any bounded data correction separately; never guess authority or add a
compatibility reader during this procedure.

#### 5. Reconcile the old-chain catalog and prove equivalence

An offline, ordered audit of all 102 old migration files against the generated
baseline found a closed reconciliation set: two data-bearing LLM cutover
snapshot tables, eight column attributes, one redundant pre-Provider-Account
index, and 27 same-named indexes whose old-chain definitions differ from the
final Drizzle schema. The column differences are seven retained defaults plus
one missing column-level `NOT NULL`; index differences include sort/null
ordering, a partial predicate, key versus `INCLUDE` columns, and one removed
partial predicate. The full backup is their rollback path.

Run the exact reconciliation below through `psql --set ON_ERROR_STOP=1`. It
uses no `IF EXISTS`: a missing old object, duplicate new object, invalid
definition, or any other error aborts the transaction and stops the cutover.
The replacement definitions are copied from
`0000_ponytail_baseline.sql`—do not edit or shorten this list during Phase 8:

```bash
psql --set ON_ERROR_STOP=1 <<'SQL'
BEGIN;

ALTER TABLE "gantry"."agent_runs"
  ALTER COLUMN "execution_provider_id" SET NOT NULL;
ALTER TABLE "gantry"."jobs"
  ALTER COLUMN "created_at" DROP DEFAULT,
  ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "gantry"."job_triggers"
  ALTER COLUMN "created_at" DROP DEFAULT,
  ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "gantry"."memory_items"
  ALTER COLUMN "created_at" DROP DEFAULT,
  ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "gantry"."model_credentials"
  ALTER COLUMN "auth_mode" DROP DEFAULT;

DROP TABLE "gantry"."llm_profiles_response_family_legacy";
DROP TABLE "gantry"."llm_profiles_model_alias_legacy";

DROP INDEX "gantry"."idx_agent_runs_job_started";
DROP INDEX "gantry"."idx_agent_runs_lease_claim";
DROP INDEX "gantry"."idx_agent_runs_started_created";
DROP INDEX "gantry"."idx_agent_session_digests_scope_created";
DROP INDEX "gantry"."idx_agent_tool_sources_app_agent_status";
DROP INDEX "gantry"."idx_brain_page_embeddings_status";
DROP INDEX "gantry"."idx_brain_pages_app_updated";
DROP INDEX "gantry"."idx_jobs_target_session_updated";
DROP INDEX "gantry"."idx_jobs_target_thread_normalized_updated";
DROP INDEX "gantry"."idx_jobs_target_workspace_key_updated";
DROP INDEX "gantry"."idx_mcp_server_audit_events_app_server_created";
DROP INDEX "gantry"."idx_mcp_servers_app_status_updated";
DROP INDEX "gantry"."idx_memory_candidates_boundary";
DROP INDEX "gantry"."idx_memory_dream_decisions_app";
DROP INDEX "gantry"."idx_memory_dream_runs_boundary";
DROP INDEX "gantry"."idx_memory_embedding_backfill_runs_scope";
DROP INDEX "gantry"."idx_memory_embedding_backfill_runs_status";
DROP INDEX "gantry"."idx_memory_evidence_boundary";
DROP INDEX "gantry"."idx_memory_item_embeddings_item";
DROP INDEX "gantry"."idx_memory_item_embeddings_provider_batch";
DROP INDEX "gantry"."idx_memory_item_embeddings_status";
DROP INDEX "gantry"."idx_memory_items_subject_updated";
DROP INDEX "gantry"."idx_memory_recall_events_app";
DROP INDEX "gantry"."idx_memory_recall_events_item";
DROP INDEX "gantry"."idx_messages_conversation_recent";
DROP INDEX "gantry"."idx_provider_sessions_agent_status_updated";
DROP INDEX "gantry"."idx_provider_sessions_resume_lookup";

CREATE INDEX "idx_agent_runs_job_started" ON "gantry"."agent_runs" USING btree ("job_id","started_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);
CREATE INDEX "idx_agent_runs_lease_claim" ON "gantry"."agent_runs" USING btree ("status","lease_expires_at","lease_owner") WHERE "agent_runs"."status" IN ('pending', 'leased');
CREATE INDEX "idx_agent_runs_started_created" ON "gantry"."agent_runs" USING btree ("started_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);
CREATE INDEX "idx_agent_session_digests_scope_created" ON "gantry"."agent_session_digests" USING btree ("agent_session_id","scope_app_id","scope_agent_id","scope_conversation_id","scope_user_id","scope_thread_id","created_at","id");
CREATE INDEX "idx_agent_tool_sources_app_agent_status" ON "gantry"."agent_tool_sources" USING btree ("app_id","agent_id","status","source_id","kind","version","updated_at");
CREATE INDEX "idx_brain_page_embeddings_status" ON "gantry"."brain_page_embeddings" USING btree ("status","updated_at" DESC NULLS LAST);
CREATE INDEX "idx_brain_pages_app_updated" ON "gantry"."brain_pages" USING btree ("app_id","updated_at" DESC NULLS LAST);
CREATE INDEX "idx_jobs_target_session_updated" ON "gantry"."jobs" USING btree (("target_json" #>> '{executionContext,sessionId}'),"updated_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);
CREATE INDEX "idx_jobs_target_thread_normalized_updated" ON "gantry"."jobs" USING btree (coalesce("target_json" #>> '{executionContext,threadId}', ''),"updated_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);
CREATE INDEX "idx_jobs_target_workspace_key_updated" ON "gantry"."jobs" USING btree (("target_json" #>> '{executionContext,workspaceKey}'),"updated_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);
CREATE INDEX "idx_mcp_server_audit_events_app_server_created" ON "gantry"."mcp_server_audit_events" USING btree ("app_id","server_id","created_at" DESC NULLS LAST);
CREATE INDEX "idx_mcp_servers_app_status_updated" ON "gantry"."mcp_servers" USING btree ("app_id","status","updated_at" DESC NULLS LAST);
CREATE INDEX "idx_memory_candidates_boundary" ON "gantry"."memory_candidates" USING btree ("app_id","agent_id","subject_type","subject_id","status","confidence","updated_at");
CREATE INDEX "idx_memory_dream_decisions_app" ON "gantry"."memory_dream_decisions" USING btree ("app_id","agent_id","created_at");
CREATE INDEX "idx_memory_dream_runs_boundary" ON "gantry"."memory_dream_runs" USING btree ("app_id","agent_id","subject_type","subject_id","started_at");
CREATE INDEX "idx_memory_embedding_backfill_runs_scope" ON "gantry"."memory_embedding_backfill_runs" USING btree ("app_id","agent_id","started_at" DESC NULLS LAST);
CREATE INDEX "idx_memory_embedding_backfill_runs_status" ON "gantry"."memory_embedding_backfill_runs" USING btree ("status","updated_at" DESC NULLS LAST);
CREATE INDEX "idx_memory_evidence_boundary" ON "gantry"."memory_evidence" USING btree ("app_id","agent_id","subject_type","subject_id","created_at");
CREATE INDEX "idx_memory_item_embeddings_item" ON "gantry"."memory_item_embeddings" USING btree ("item_id","updated_at");
CREATE INDEX "idx_memory_item_embeddings_provider_batch" ON "gantry"."memory_item_embeddings" USING btree ("provider","model","status","provider_batch_id","updated_at","item_id");
CREATE INDEX "idx_memory_item_embeddings_status" ON "gantry"."memory_item_embeddings" USING btree ("status","updated_at");
CREATE INDEX "idx_memory_items_subject_updated" ON "gantry"."memory_items" USING btree ("app_id","agent_id","subject_type","subject_id","status","updated_at" DESC NULLS LAST);
CREATE INDEX "idx_memory_recall_events_app" ON "gantry"."memory_recall_events" USING btree ("app_id","agent_id","created_at");
CREATE INDEX "idx_memory_recall_events_item" ON "gantry"."memory_recall_events" USING btree ("item_id","created_at");
CREATE INDEX "idx_messages_conversation_recent" ON "gantry"."messages" USING btree ("conversation_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
CREATE INDEX "idx_provider_sessions_agent_status_updated" ON "gantry"."provider_sessions" USING btree ("agent_session_id","status","updated_at" DESC NULLS LAST);
CREATE INDEX "idx_provider_sessions_resume_lookup" ON "gantry"."provider_sessions" USING btree ("agent_session_id","provider","status","updated_at" DESC NULLS LAST);

COMMIT;
SQL
```

Now replay the checked-in baseline into an isolated schema in the same
database. This exercises the exact SQL without touching `gantry` and uses the
same extensions and server capabilities as the preserved schema:

```bash
PONYTAIL_COMPARE_SCHEMA=ponytail_phase8_compare
test "$(psql --set ON_ERROR_STOP=1 --tuples-only --no-align --command "SELECT count(*) FROM pg_namespace WHERE nspname = '$PONYTAIL_COMPARE_SCHEMA'")" = 0
psql --set ON_ERROR_STOP=1 --set compare_schema="$PONYTAIL_COMPARE_SCHEMA" <<'SQL'
CREATE SCHEMA :"compare_schema";
SET search_path TO :"compare_schema", public;
\i /Users/ravikiranvemula/Workdir/myclaw/dist/adapters/storage/postgres/schema/migrations/0000_ponytail_baseline.sql
SQL
psql --set ON_ERROR_STOP=1 --set compare_schema="$PONYTAIL_COMPARE_SCHEMA" <<'SQL'
BEGIN;
SET LOCAL search_path TO pg_catalog, public;

CREATE TEMP TABLE ponytail_phase8_constraint_matches ON COMMIT DROP AS
WITH live_constraints AS (
  SELECT
    relation.relname AS table_name,
    constraint_row.conname AS constraint_name,
    replace(
      pg_get_constraintdef(constraint_row.oid, false),
      quote_ident(namespace.nspname) || '.',
      '__ponytail_schema__.'
    ) AS constraint_definition
  FROM pg_constraint AS constraint_row
  JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
  JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'gantry'
    AND relation.relname <> '__drizzle_migrations'
), baseline_constraints AS (
  SELECT
    relation.relname AS table_name,
    constraint_row.conname AS constraint_name,
    replace(
      pg_get_constraintdef(constraint_row.oid, false),
      quote_ident(namespace.nspname) || '.',
      '__ponytail_schema__.'
    ) AS constraint_definition
  FROM pg_constraint AS constraint_row
  JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
  JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = :'compare_schema'
)
SELECT
  live_constraints.table_name,
  live_constraints.constraint_name AS old_name,
  baseline_constraints.constraint_name AS new_name,
  live_constraints.constraint_definition
FROM live_constraints
JOIN baseline_constraints USING (table_name, constraint_definition);

CREATE TEMP TABLE ponytail_phase8_constraint_counts ON COMMIT DROP AS
SELECT
  (
    SELECT count(*)
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'gantry'
      AND relation.relname <> '__drizzle_migrations'
  ) AS live_count,
  (
    SELECT count(*)
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = :'compare_schema'
  ) AS baseline_count,
  (SELECT count(*) FROM ponytail_phase8_constraint_matches) AS match_count;

DO $$
DECLARE
  live_count bigint;
  baseline_count bigint;
  match_count bigint;
BEGIN
  SELECT counts.live_count, counts.baseline_count, counts.match_count
  INTO live_count, baseline_count, match_count
  FROM ponytail_phase8_constraint_counts AS counts;

  IF live_count <> baseline_count OR match_count <> live_count THEN
    RAISE EXCEPTION
      'constraint definitions do not match baseline: live %, baseline %, matches %',
      live_count,
      baseline_count,
      match_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ponytail_phase8_constraint_matches
    GROUP BY table_name, old_name
    HAVING count(*) <> 1
  ) OR EXISTS (
    SELECT 1
    FROM ponytail_phase8_constraint_matches
    GROUP BY table_name, new_name
    HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'constraint matching is not one-to-one';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ponytail_phase8_constraint_matches AS constraint_match
    JOIN pg_constraint AS constraint_row
      ON constraint_row.conname = constraint_match.new_name
    JOIN pg_class AS relation
      ON relation.oid = constraint_row.conrelid
     AND relation.relname = constraint_match.table_name
    JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
     AND namespace.nspname = 'gantry'
    WHERE constraint_match.old_name <> constraint_match.new_name
  ) THEN
    RAISE EXCEPTION 'a baseline constraint name is already occupied';
  END IF;
END
$$;

DO $$
DECLARE
  match_row record;
BEGIN
  FOR match_row IN
    SELECT table_name, old_name, new_name
    FROM ponytail_phase8_constraint_matches
    WHERE old_name <> new_name
    ORDER BY table_name, old_name
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I RENAME CONSTRAINT %I TO %I',
      'gantry',
      match_row.table_name,
      match_row.old_name,
      match_row.new_name
    );
  END LOOP;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ponytail_phase8_constraint_matches AS constraint_match
    LEFT JOIN pg_constraint AS constraint_row
      ON constraint_row.conname = constraint_match.new_name
    LEFT JOIN pg_class AS relation
      ON relation.oid = constraint_row.conrelid
     AND relation.relname = constraint_match.table_name
    LEFT JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
     AND namespace.nspname = 'gantry'
    WHERE namespace.oid IS NULL
  ) THEN
    RAISE EXCEPTION 'constraint-name reconciliation is incomplete';
  END IF;
END
$$;

COMMIT;
SQL
pg_dump --schema-only --no-owner --no-privileges --quote-all-identifiers --schema=gantry --exclude-table=gantry.__drizzle_migrations --exclude-table=gantry.__drizzle_migrations_id_seq --file "$PONYTAIL_BACKUP_DIR/live-gantry-catalog.sql"
pg_dump --schema-only --no-owner --no-privileges --quote-all-identifiers --schema="$PONYTAIL_COMPARE_SCHEMA" --file "$PONYTAIL_BACKUP_DIR/baseline-replay-catalog.sql"
python3 - "$PONYTAIL_BACKUP_DIR" "$PONYTAIL_COMPARE_SCHEMA" <<'PY'
import sys
from pathlib import Path

backup_dir = Path(sys.argv[1])
compare_schema = sys.argv[2]
sentinel = "__ponytail_schema__"

for input_name, output_name, schema in (
    ("live-gantry-catalog.sql", "live-gantry-catalog.normalized.sql", "gantry"),
    ("baseline-replay-catalog.sql", "baseline-replay-catalog.normalized.sql", compare_schema),
):
    text = (backup_dir / input_name).read_text()
    lines = [
        line
        for line in text.splitlines()
        if not line.startswith("\\restrict ") and not line.startswith("\\unrestrict ")
    ]
    normalized = "\n".join(lines) + "\n"
    normalized = normalized.replace(f'"{schema}"', f'"{sentinel}"')
    normalized = normalized.replace(f"Name: {schema}; Type: SCHEMA", f"Name: {sentinel}; Type: SCHEMA")
    normalized = normalized.replace(f"Schema: {schema};", f"Schema: {sentinel};")
    (backup_dir / output_name).write_text(normalized)
PY
if diff -u "$PONYTAIL_BACKUP_DIR/live-gantry-catalog.normalized.sql" "$PONYTAIL_BACKUP_DIR/baseline-replay-catalog.normalized.sql"; then
  psql --set ON_ERROR_STOP=1 --set compare_schema="$PONYTAIL_COMPARE_SCHEMA" <<'SQL'
DROP SCHEMA :"compare_schema" CASCADE;
SQL
else
  echo "catalog equivalence failed; comparison schema retained" >&2
  exit 1
fi
```

The constraint-reconciliation transaction must report matching live, baseline,
and one-to-one match counts. It deliberately normalizes historical constraint
names preserved by table renames; it does not change constraint definitions.
`diff` must then be empty. It compares tables, columns, defaults,
primary/foreign keys, CHECK constraints, indexes, and other schema objects after
excluding only Drizzle's stamp table and its owned sequence. Any difference is
unapproved catalog drift: do not add the baseline stamp, keep the service
offline, and restore the backup. Drop the isolated comparison schema only after
the empty diff.

#### 6. Lock and add only the exact baseline stamp

With the service still offline, run this block with `psql --set
ON_ERROR_STOP=1`. It locks `gantry.__drizzle_migrations`, proves the former
head, rejects a conflicting timestamp/hash, inserts the exact new pair only if
absent, verifies one row was added, and never deletes an old stamp:

```sql
BEGIN;
LOCK TABLE "gantry"."__drizzle_migrations" IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE ponytail_phase8_stamp_guard ON COMMIT DROP AS
SELECT count(*)::bigint AS before_count
FROM "gantry"."__drizzle_migrations";

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM "gantry"."__drizzle_migrations"
    WHERE created_at = 1784430700000
      AND hash = '22f9eefe9b1b25eca5b99f64a104a0d4399aea8390194395e89993a461b92cdd'
  ) <> 1 THEN
    RAISE EXCEPTION '0104 exact migration head is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "gantry"."__drizzle_migrations"
    WHERE created_at > 1784430700000
      AND NOT (
        created_at = 1784609882223
        AND hash = '406a5a9af01f7aa922a8a2df716019f85a742577e0163e2d1e131c93544872ea'
      )
  ) THEN
    RAISE EXCEPTION '0104 is not the current preserved head';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "gantry"."__drizzle_migrations"
    WHERE (
      created_at = 1784609882223
      OR hash = '406a5a9af01f7aa922a8a2df716019f85a742577e0163e2d1e131c93544872ea'
    )
      AND NOT (
        created_at = 1784609882223
        AND hash = '406a5a9af01f7aa922a8a2df716019f85a742577e0163e2d1e131c93544872ea'
      )
  ) THEN
    RAISE EXCEPTION 'conflicting Ponytail baseline stamp exists';
  END IF;
END
$$;

INSERT INTO "gantry"."__drizzle_migrations" (hash, created_at)
SELECT
  '406a5a9af01f7aa922a8a2df716019f85a742577e0163e2d1e131c93544872ea',
  1784609882223
WHERE NOT EXISTS (
  SELECT 1
  FROM "gantry"."__drizzle_migrations"
  WHERE created_at = 1784609882223
    AND hash = '406a5a9af01f7aa922a8a2df716019f85a742577e0163e2d1e131c93544872ea'
);

DO $$
DECLARE
  stamps_before bigint;
  stamps_after bigint;
BEGIN
  SELECT before_count INTO stamps_before
  FROM ponytail_phase8_stamp_guard;
  SELECT count(*) INTO stamps_after
  FROM "gantry"."__drizzle_migrations";

  IF stamps_after <> stamps_before + 1 THEN
    RAISE EXCEPTION 'expected exactly one added migration stamp';
  END IF;

  IF (
    SELECT count(*)
    FROM "gantry"."__drizzle_migrations"
    WHERE created_at = 1784609882223
      AND hash = '406a5a9af01f7aa922a8a2df716019f85a742577e0163e2d1e131c93544872ea'
  ) <> 1 THEN
    RAISE EXCEPTION 'exact Ponytail baseline stamp was not installed';
  END IF;
END
$$;

COMMIT;
```

After commit, require the exact pair and the captured count plus one:

```bash
psql --set ON_ERROR_STOP=1 --command "SELECT id, hash, created_at FROM \"gantry\".\"__drizzle_migrations\" WHERE created_at = 1784609882223 AND hash = '406a5a9af01f7aa922a8a2df716019f85a742577e0163e2d1e131c93544872ea'"
PONYTAIL_STAMP_COUNT_AFTER=$(psql --set ON_ERROR_STOP=1 --tuples-only --no-align --command 'SELECT count(*) FROM "gantry"."__drizzle_migrations"')
test "$PONYTAIL_STAMP_COUNT_AFTER" -eq "$((PONYTAIL_STAMP_COUNT_BEFORE + 1))"
test "$(psql --set ON_ERROR_STOP=1 --tuples-only --no-align --command "SELECT max(revision) FROM \"gantry\".\"settings_revisions\" WHERE app_id = 'default'")" = "$PONYTAIL_CUTOVER_REVISION"
psql --set ON_ERROR_STOP=1 --file "$PONYTAIL_BACKUP_DIR/phase8-row-assertions.sql"
```

Do not run the Phase 7 migrator on this populated database. Without the exact
inserted pair, the new one-entry journal would attempt to replay the baseline
against existing tables.

#### 7. Install Phase 7, restart, and validate exact head

Before any agent process restarts, seal the full backup directory with a new,
high-entropy operator passphrase and escrow that passphrase outside Gantry.
This machine's `/opt/homebrew/bin/gpg` 2.4.9 prompts through pinentry and emits
an integrity-protected OpenPGP archive; do not place the passphrase in a shell
argument, environment variable, file, settings, or this runbook. The second
prompt decrypts the archive only to list and verify it. The guarded removal
then deletes all plaintext dump, settings, CSV, and libpq credential files:

```bash
set -euo pipefail
case "$PONYTAIL_BACKUP_DIR" in
  "$PONYTAIL_OPERATOR_BACKUP_ROOT"/ponytail-phase8-*) ;;
  *) echo "refusing to seal unexpected backup path" >&2; exit 1 ;;
esac
PONYTAIL_BACKUP_NAME=$(basename "$PONYTAIL_BACKUP_DIR")
PONYTAIL_ENCRYPTED_BACKUP="$PONYTAIL_BACKUP_DIR.tar.gz.gpg"
PONYTAIL_ARCHIVE_LIST="$PONYTAIL_OPERATOR_BACKUP_ROOT/$PONYTAIL_BACKUP_NAME.archive-list.txt"
test ! -e "$PONYTAIL_ENCRYPTED_BACKUP"
tar -C "$PONYTAIL_OPERATOR_BACKUP_ROOT" -czf - "$PONYTAIL_BACKUP_NAME" |
  /opt/homebrew/bin/gpg --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 --compress-algo none --no-symkey-cache --output "$PONYTAIL_ENCRYPTED_BACKUP"
test -s "$PONYTAIL_ENCRYPTED_BACKUP"
chmod 600 "$PONYTAIL_ENCRYPTED_BACKUP"
/opt/homebrew/bin/gpg --no-symkey-cache --decrypt "$PONYTAIL_ENCRYPTED_BACKUP" |
  tar -tzf - > "$PONYTAIL_ARCHIVE_LIST"
grep -Fx "$PONYTAIL_BACKUP_NAME/gantry.dump" "$PONYTAIL_ARCHIVE_LIST"
grep -Fx "$PONYTAIL_BACKUP_NAME/settings.yaml" "$PONYTAIL_ARCHIVE_LIST"
grep -Fx "$PONYTAIL_BACKUP_NAME/settings-revisions.csv" "$PONYTAIL_ARCHIVE_LIST"
grep -Fx "$PONYTAIL_BACKUP_NAME/drizzle-stamps.csv" "$PONYTAIL_ARCHIVE_LIST"
grep -Fx "$PONYTAIL_BACKUP_NAME/pg_service.conf" "$PONYTAIL_ARCHIVE_LIST"
grep -Fx "$PONYTAIL_BACKUP_NAME/.pgpass" "$PONYTAIL_ARCHIVE_LIST"
rm "$PONYTAIL_ARCHIVE_LIST"
rm -rf -- "$PONYTAIL_BACKUP_DIR"
test ! -e "$PONYTAIL_BACKUP_DIR"
rm /Users/ravikiranvemula/gantry/settings.ponytail-phase8.yaml
test ! -e /Users/ravikiranvemula/gantry/settings.ponytail-phase8.yaml
unset PGSERVICEFILE PGSERVICE PGPASSFILE

test "$(git -C /Users/ravikiranvemula/Workdir/myclaw rev-parse HEAD)" = "$PONYTAIL_PHASE7_HEAD"
test -z "$(git -C /Users/ravikiranvemula/Workdir/myclaw status --porcelain)"
npm --prefix /Users/ravikiranvemula/Workdir/myclaw run build
test "$(git -C /Users/ravikiranvemula/Workdir/myclaw rev-parse HEAD)" = "$PONYTAIL_PHASE7_HEAD"
test -z "$(git -C /Users/ravikiranvemula/Workdir/myclaw status --porcelain)"
test "$(shasum -a 256 /Users/ravikiranvemula/Workdir/myclaw/dist/adapters/storage/postgres/schema/migrations/0000_ponytail_baseline.sql | awk '{print $1}')" = "406a5a9af01f7aa922a8a2df716019f85a742577e0163e2d1e131c93544872ea"
node /Users/ravikiranvemula/Workdir/myclaw/dist/cli/index.js --runtime-home /Users/ravikiranvemula/gantry service install
launchctl bootstrap "gui/$(id -u)" /Users/ravikiranvemula/Library/LaunchAgents/com.gantry.plist
launchctl kickstart -k "gui/$(id -u)/com.gantry"
launchctl print "gui/$(id -u)/com.gantry"
node /Users/ravikiranvemula/Workdir/myclaw/dist/cli/index.js --runtime-home /Users/ravikiranvemula/gantry status
curl --fail --silent --show-error --unix-socket /Users/ravikiranvemula/gantry/run/control.sock http://localhost/healthz
curl --fail --silent --show-error --unix-socket /Users/ravikiranvemula/gantry/run/control.sock http://localhost/readyz
```

The pre-seal SQL checks above prove exactly one baseline timestamp/hash row,
the latest canonical revision, and the strict row invariants. Phase 7 runtime
startup calls `assertMigrationsCurrent`, which requires that same exact
timestamp/hash pair before the process can become ready. Accept the cutover
only when those pre-seal checks, encrypted-archive verification, launchd,
`gantry status`, `/healthz`, and `/readyz` all pass.

#### 8. Roll back by restoring the backup

On any failure, stop Phase 7 and restore while Gantry remains offline:

```bash
set -euo pipefail
if launchctl print "gui/$(id -u)/com.gantry" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/com.gantry"
fi
if launchctl print "gui/$(id -u)/com.gantry" >/dev/null 2>&1; then
  echo "com.gantry is still loaded" >&2
  exit 1
fi
case "$PONYTAIL_BACKUP_DIR" in
  "$PONYTAIL_OPERATOR_BACKUP_ROOT"/ponytail-phase8-*) ;;
  *) echo "refusing to restore unexpected backup path" >&2; exit 1 ;;
esac
PONYTAIL_BACKUP_NAME=$(basename "$PONYTAIL_BACKUP_DIR")
PONYTAIL_ENCRYPTED_BACKUP="$PONYTAIL_BACKUP_DIR.tar.gz.gpg"
PONYTAIL_ARCHIVE_LIST="$PONYTAIL_OPERATOR_BACKUP_ROOT/$PONYTAIL_BACKUP_NAME.archive-list.txt"
if ! test -d "$PONYTAIL_BACKUP_DIR"; then
  test -s "$PONYTAIL_ENCRYPTED_BACKUP"
  /opt/homebrew/bin/gpg --no-symkey-cache --decrypt "$PONYTAIL_ENCRYPTED_BACKUP" |
    tar -xzf - -C "$PONYTAIL_OPERATOR_BACKUP_ROOT"
fi
test -s "$PONYTAIL_BACKUP_DIR/gantry.dump"
test "$(stat -f '%Lp' "$PONYTAIL_BACKUP_DIR/pg_service.conf")" = 600
test "$(stat -f '%Lp' "$PONYTAIL_BACKUP_DIR/.pgpass")" = 600
export PGSERVICEFILE="$PONYTAIL_BACKUP_DIR/pg_service.conf"
export PGSERVICE=gantry_ponytail_phase8
export PGPASSFILE="$PONYTAIL_BACKUP_DIR/.pgpass"
psql --set ON_ERROR_STOP=1 --command 'DROP SCHEMA IF EXISTS "ponytail_phase8_compare" CASCADE'
pg_restore --clean --if-exists --exit-on-error --no-owner --no-privileges --dbname "service=$PGSERVICE" "$PONYTAIL_BACKUP_DIR/gantry.dump"
PONYTAIL_EXPECTED_REVISION=$(tr -d '[:space:]' < "$PONYTAIL_BACKUP_DIR/pre-cutover-revision.txt")
test -n "$PONYTAIL_EXPECTED_REVISION"
test "$(psql --set ON_ERROR_STOP=1 --tuples-only --no-align --command "SELECT count(*) FROM \"gantry\".\"__drizzle_migrations\" WHERE created_at = 1784430700000 AND hash = '22f9eefe9b1b25eca5b99f64a104a0d4399aea8390194395e89993a461b92cdd'")" = 1
test "$(psql --set ON_ERROR_STOP=1 --tuples-only --no-align --command "SELECT count(*) FROM \"gantry\".\"__drizzle_migrations\" WHERE created_at = 1784609882223 OR hash = '406a5a9af01f7aa922a8a2df716019f85a742577e0163e2d1e131c93544872ea'")" = 0
test "$(psql --set ON_ERROR_STOP=1 --tuples-only --no-align --command "SELECT max(revision) FROM \"gantry\".\"settings_revisions\" WHERE app_id = 'default'")" = "$PONYTAIL_EXPECTED_REVISION"
cp "$PONYTAIL_BACKUP_DIR/settings.yaml" /Users/ravikiranvemula/gantry/settings.yaml
cmp -s "$PONYTAIL_BACKUP_DIR/settings.yaml" /Users/ravikiranvemula/gantry/settings.yaml
if ! test -s "$PONYTAIL_ENCRYPTED_BACKUP"; then
  tar -C "$PONYTAIL_OPERATOR_BACKUP_ROOT" -czf - "$PONYTAIL_BACKUP_NAME" |
    /opt/homebrew/bin/gpg --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 --compress-algo none --no-symkey-cache --output "$PONYTAIL_ENCRYPTED_BACKUP"
fi
test -s "$PONYTAIL_ENCRYPTED_BACKUP"
chmod 600 "$PONYTAIL_ENCRYPTED_BACKUP"
/opt/homebrew/bin/gpg --no-symkey-cache --decrypt "$PONYTAIL_ENCRYPTED_BACKUP" |
  tar -tzf - > "$PONYTAIL_ARCHIVE_LIST"
grep -Fx "$PONYTAIL_BACKUP_NAME/gantry.dump" "$PONYTAIL_ARCHIVE_LIST"
grep -Fx "$PONYTAIL_BACKUP_NAME/settings.yaml" "$PONYTAIL_ARCHIVE_LIST"
grep -Fx "$PONYTAIL_BACKUP_NAME/pg_service.conf" "$PONYTAIL_ARCHIVE_LIST"
grep -Fx "$PONYTAIL_BACKUP_NAME/.pgpass" "$PONYTAIL_ARCHIVE_LIST"
rm "$PONYTAIL_ARCHIVE_LIST"
rm -rf -- "$PONYTAIL_BACKUP_DIR"
test ! -e "$PONYTAIL_BACKUP_DIR"
rm -f /Users/ravikiranvemula/gantry/settings.ponytail-phase8.yaml
unset PGSERVICEFILE PGSERVICE PGPASSFILE
test "$(git -C /private/tmp/gantry-ponytail-phase6 rev-parse HEAD)" = "f0f79afcf0276414b44132c6f303ff791d0477a0"
test -z "$(git -C /private/tmp/gantry-ponytail-phase6 status --porcelain)"
npm --prefix /private/tmp/gantry-ponytail-phase6 run build
test "$(git -C /private/tmp/gantry-ponytail-phase6 rev-parse HEAD)" = "f0f79afcf0276414b44132c6f303ff791d0477a0"
test -z "$(git -C /private/tmp/gantry-ponytail-phase6 status --porcelain)"
node /private/tmp/gantry-ponytail-phase6/dist/cli/index.js --runtime-home /Users/ravikiranvemula/gantry service install
launchctl bootstrap "gui/$(id -u)" /Users/ravikiranvemula/Library/LaunchAgents/com.gantry.plist
launchctl kickstart -k "gui/$(id -u)/com.gantry"
launchctl print "gui/$(id -u)/com.gantry"
node /private/tmp/gantry-ponytail-phase6/dist/cli/index.js --runtime-home /Users/ravikiranvemula/gantry status
curl --fail --silent --show-error --unix-socket /Users/ravikiranvemula/gantry/run/control.sock http://localhost/healthz
curl --fail --silent --show-error --unix-socket /Users/ravikiranvemula/gantry/run/control.sock http://localhost/readyz
```

The fail-fast block verifies the restored old head, pre-cutover revision, and
absence of the new stamp before it copies settings or starts Phase 6. It then
verifies the encrypted archive and removes the decrypted directory before
restart. Phase 6 startup requires the exact old timestamp/hash pair before
`/readyz` can pass. The database restore removes the appended canonical
revision and new baseline stamp together; do not hand-delete either row. Retain
the failed-state logs and encrypted archive for diagnosis.

#### 9. Reset path for every other environment

No other environment may use the restamp procedure or import old desired
state. Stop its Gantry processes and optionally archive its database, then
discard that database. Provision a truly empty database with `vector` and at
least one of `pg_trgm` or `pg_search`; the migrator role must be able to create
`pgcrypto` in `public` and initialize pg-boss. Verify emptiness and extension
readiness before migration:

```sql
SELECT count(*) AS non_system_tables
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema');

SELECT
  EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS has_vector,
  EXISTS (SELECT 1 FROM pg_extension WHERE extname IN ('pg_trgm', 'pg_search')) AS has_text_search;
```

Require `non_system_tables = 0`, `has_vector = true`, and
`has_text_search = true`. Point `GANTRY_DATABASE_URL` at that empty database
and run the landed Phase 7 explicit migrator exactly once:

```bash
GANTRY_HOME=/path/to/new/runtime-home node /path/to/landed-phase7/dist/postgres-migrate.js
```

Bootstrap canonical settings as a new installation, start the runtime, and
require healthy `/readyz` plus exactly one row with timestamp `1784609882223`
and hash
`406a5a9af01f7aa922a8a2df716019f85a742577e0163e2d1e131c93544872ea`.
Never copy old `settings_revisions`, `__drizzle_migrations`, routes, jobs, or a
pre-cutover `settings.yaml` into the reset database.

### Surface impact

| Surface                      | Classification       | Reason                                                                                                                                                                                         |
| ---------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior             | Unchanged by design  | Phase 7 changes installation artifacts only; no running process or runtime code path changed.                                                                                                  |
| `settings.yaml`              | Unchanged by design  | Phase 7 does not read or write the live file; Phase 8 alone imports the reviewed candidate through the desired-state service.                                                                  |
| Postgres/runtime projection  | Changed              | Fresh databases now install the current 93-table schema from one baseline; the preserved database remains untouched until the deferred Phase 8 restamp.                                        |
| Control API                  | Unchanged by design  | No route, validator, response, authentication, or application use case changed.                                                                                                                |
| SDK/contracts                | Unchanged by design  | No public contract, generated SDK type, model, or provider interface changed.                                                                                                                  |
| CLI                          | Read-only/observable | Existing Phase 6 and Phase 7 CLI binaries are named in the future runbook; no CLI command or behavior changed in Phase 7.                                                                      |
| Gantry MCP tools/admin skill | Unchanged by design  | No tool schema, capability, skill, prompt, or admin authorization surface changed.                                                                                                             |
| Channel/provider adapters    | Unchanged by design  | No channel transport, rendering, callback, provider-account, or model adapter changed.                                                                                                         |
| Docs/prompts                 | Changed              | This existing ledger now pins the final stamp and contains the offline cutover, rollback, and reset procedures; agent prompts are unchanged.                                                   |
| Audit/events                 | Unchanged by design  | No audit/event kind, payload, persistence, or notification behavior changed; Phase 7 emitted no live cutover event.                                                                            |
| Tests/verification           | Changed              | Directly affected unit tests now expect a one-entry journal and the replacement baseline artifacts under their existing conventions; completed checks and sandbox blockers are recorded below. |

### Net line delta

Safely measured before adding this ledger section: the migration artifacts and
directly affected tests are `+16,283/-82,119`, net **-65,836 lines**. This
includes the new 1,777-line SQL baseline and 14,300-line snapshot, the removal
of 102 old SQL files and five old snapshots, and the journal/test adjustments.
No dependency changed.

### Verification notes

- The generation command above completed against an isolated temporary output
  directory. The final migration directory has one SQL file, the journal has
  one `idx: 0` entry, and the one snapshot has 93 tables.
- A follow-up `drizzle-kit generate` against a temporary copy of the final
  journal/snapshot and the unchanged schema source reported `No schema changes,
nothing to migrate`; the raw-SQL-only object policy therefore produces no
  automatic destructive drops.
- `shasum -a 256` reproduced the corrected SQL hash
  `406a5a9af01f7aa922a8a2df716019f85a742577e0163e2d1e131c93544872ea`
  and snapshot hash
  `9e93499964e82d3a8862920cf664f9523a848b03cc76c01b0f10f22871e04deb`.
- No database replay or catalog-equivalence check was run, and no command
  targeted a live database, `com.gantry`, active settings, or another service.
- An ordered static audit of all old-chain index creates, drops, table drops,
  index/table renames, column definitions, and column alterations found 180
  final old-chain indexes and 180 baseline indexes, plus eight column attribute
  differences. The active app/agent conversation-install index is retained in
  both paths. The exact seven default drops, one `NOT NULL`, 27 index drops,
  and 27 baseline index replacements are pinned in the Phase 8 transaction
  above; the two legacy tables are its remaining catalog delta. Historical
  constraint-name drift is reconciled by one-to-one definition matching before
  the exact catalog diff.
- `npm run typecheck` passed.
- The four directly affected unit files passed with 25 tests; the two
  supplemental migration/migrator files passed with five tests. The contracts
  unit shard passed with two files and 39 tests. The broad core shard passed
  519 of 521 files (6,390 tests) before two sandbox-only files failed: the
  package-hygiene test cannot run `npm pack --dry-run --json` because Husky's
  prepare hook cannot update this worktree's read-only Git metadata, and IPC
  child-process tests receive `EMFILE: too many open files, watch` when this
  managed macOS sandbox denies FSEvents. A single-worker retry with a temporary
  npm cache reproduced both blockers; no migration or directly affected test
  failed. Full-unit green therefore remains blocked by the execution
  environment rather than upgraded from the focused greens.
- Prettier passed on every touched format-supported file. Final artifact
  validation reproduced the one-entry stamp, one SQL file, 93-table snapshot,
  zero `"public".` qualifiers, and zero top-level destructive statements;
  `git diff --check` and the final write-scope inspection passed.
- `docs/architecture/current-verification-commands.md` still names deleted
  historical migration `0009_canonical_persistence_adapter_cut.sql`. The
  explicit Phase 7 write boundary excludes that document, so it remains an
  acknowledged follow-up rather than an out-of-scope edit in this worktree.
- Structured local review identified the non-redundant app/agent
  conversation-install index and search-path-sensitive constraint deparsing;
  both were corrected. The final pass completed clean with no
  accepted/actionable findings.
