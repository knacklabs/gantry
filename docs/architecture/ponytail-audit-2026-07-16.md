# Ponytail Legacy and Backward-Compatibility Audit — 2026-07-16

## Outcome

**USER DECISION 2026-07-16: DB reset approved.** Environments may reset
Postgres state instead of upgrading through migration history — implement the
FULL scope (~19,400 lines) including migration baselining and legacy-shape
reader removal; script and run the local baseline step for this machine.

This is a follow-up, audit-only review after the July 14 dead-code cleanup. It
focuses on remaining legacy state readers, backward-compatibility aliases,
duplicate projections, orphan scripts, and incomplete clean cuts.

This revision does not claim mathematical proof that no other candidate exists.
It records the high-confidence findings that survived two independent passes:

1. one subagent owned each repository section and tried to prove or retract its
   candidates; and
2. a different subagent cross-falsified that section against current writers,
   readers, contracts, tests, docs, generated code, and persisted shapes.

Material disagreements received a third, narrow tie-break. A subsequent
architecture-refactor pass used three more section owners plus adversarial
cross-checks. Relative to the first draft, the confidence and architecture
passes added five findings; the architecture pass specifically added findings
23 and 24. They also folded provider-level CLI aliases into the existing CLI
finding, reduced several estimates, and retracted two unsafe proposed cleanups.
The conservative, overlap-adjusted estimate is:

- **approximately 1,424 lines removable without baselining migration history**
- **approximately 18,000 additional lines removable if every environment may
  reset instead of upgrading through the existing Postgres history**
- **approximately 19,424 total lines possible under that clean-reset condition**
- **0 direct dependencies removable**

Early development supports clean cuts, but it does not by itself prove that
local, CI, staging, remote, or fleet state may be destroyed. Each affected
finding therefore states its own reset, rewrite, schema, or coordinated-cutover
prerequisite.

## Validation verdict (Codex gate, 2026-07-16): NOT SAFE AS STAGED — execute via the 10-phase plan

Phase 0 stabilize Stage C+D first (F7 gained a new consumer from that work; re-verify all consumers). Phase 1 prove live transition state (DB backup, deployment mode, migration head, latest revision; separate reset vs restamp procedures). Phase 2 settings authority cutover (F6,F7,F16,F23,AR1 together). Phase 3 canonical routing (AR2+F5,F9,F14). Phase 4 public contracts (AR3+F4,F17). Phase 5 adapters/CLI/rendering (AR4,AR5+F13,F20; split oversized Slack/Discord files). Phase 6 low-coupling deletions (F2,F8,F10-F12,F15,F18-F19,F21-F22,F24) after repeating consumer searches. Phase 7 generate final baseline (F1 last: SQL, journal, snapshot, stamp metadata, offline cutover doc). Phase 8 single-host offline cutover (stop service, backup, canonical revision append, baseline stamp with rollback stamps retained). Phase 9 remove transition reader (F3) only after rollback window closes. Full detail: codex session 019f6b9e-a92a-7f10-8872-63b01d73e20a.

## Decisions taken (user, 2026-07-16)

Pre-user deployment: the ONLY preservation target is this machine (Phase 8 restamp); every other environment resets from the new baseline. No transition shims; the F3 transition-reader rollback window can be short (days, not releases).

## Ranked Findings

Numbers are stable references rather than final sort order: findings 23 and 24
were discovered after the ranked confidence pass and were not renumbered.

### 1. Baseline the pre-release Postgres migration history

- Tag: `shrink`
- Estimated reduction: approximately 18,000 lines after replacement
- Primary path:
  `apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json`
- Condition: every database may reset, or the owner explicitly accepts a full
  reset instead of an in-place upgrade
- Evidence:
  - The repository carries 99 SQL migrations and 99 journal entries.
  - Migration SQL, two current snapshots, the journal, and the
    migration-history test total 37,972 lines.
  - Runtime health and deployment entrypoints actively use the migration
    journal; this is supported upgrade history, not dead code today.
- Replacement: atomically publish one current-schema baseline migration, one
  current snapshot, a minimal journal, and focused schema tests before another
  deployment. Retain additive migrations created after that baseline.
- Boundary: keep reader-version skew handling; it protects supported rolling
  fleet upgrades independently of old local schema history.

### 2. Delete the archived filesystem-memory importer

- Tag: `delete`
- Estimated reduction: 418 lines
- Path: `.codex/scripts/migrate_archived_filesystem_memory.mjs`
- Evidence: hidden-inclusive search found no caller, workflow, package script,
  scaffold requirement, prompt, or active documentation. The script translates
  explicitly legacy filesystem state into current Postgres memory.
- Replacement: nothing. Reset unsupported local state instead of retaining a
  compatibility importer.

### 3. Delete legacy settings-revision binding migration

- Tag: `delete`
- Estimated reduction: 243 lines
- Paths:
  - `apps/core/src/config/settings/settings-revision-legacy-bindings.ts`
  - `apps/core/src/config/settings/settings-import-service.ts`
  - `apps/core/test/unit/config/settings-import-service.test.ts`
- Evidence:
  - `settingsFromRevisionDocument()` still calls
    `migrateLegacyAgentBindings()` before parsing.
  - The migrator is 194 lines and its dedicated acceptance test is 48 lines.
  - The current parser already rejects stale root and agent-local binding
    shapes.
  - The native Provider Account goal explicitly requires rejection rather than
    an old-state migration helper.
- Replacement: parse the revision document directly and retain fail-loud stale
  shape coverage.
- Boundary: keep `CURRENT_SETTINGS_READER_VERSION`; it protects supported
  rolling settings-reader upgrades.

### 4. Derive SDK model types from corrected generated OpenAPI types

- Tag: `shrink`
- Estimated reduction: approximately 130 lines after prerequisites
- Primary path: `packages/sdk/src/job-model-types.ts`
- Related paths:
  - `packages/contracts/src/jobs/index.ts`
  - `apps/core/src/control/server/openapi-schemas.ts`
  - `packages/sdk/src/generated/openapi.ts`
  - `.github/workflows/ci.yml`
- Evidence: the handwritten model/defaults/preview block at lines 201–370
  duplicates generated wire types at approximately lines 2020–2160.
- Prerequisites:
  - Make the existing contracts schema the OpenAPI source first. Current
    handwritten OpenAPI fields are weaker than contracts for cache fields,
    source, experimental status, workload, and harness vocabulary.
  - Correct the canonical contract itself wherever the intended public shape is
    not yet represented.
  - Regenerate the SDK.
  - Add `npm run check:generated --workspace @gantry/sdk` to CI so generated
    drift cannot silently recreate the duplication.
- Replacement: narrow aliases derived from contract-projected generated
  operations and schemas.
- Boundary: do not replace the richer handwritten job block; it is not
  equivalent to the generated `Job` schema.

### 5. Cut stored runtime routes over to qualified keys

- Tag: `shrink`
- Estimated reduction: approximately 100 lines after replacement
- Primary paths:
  - `apps/core/src/app/bootstrap/runtime-app.ts`
  - `apps/core/src/runtime/message-loop.ts`
  - `apps/core/src/shared/thread-queue-key.ts`
  - `apps/core/src/app/bootstrap/live-turn-browser-finalizer.ts`
- Evidence:
  - Startup, external ingress, session ensure, IPC agent registration, and
    provider setup CLIs still write bare stored conversation routes.
  - Readers consequently preserve bare-route preference, persistence lookup,
    recovery deduplication, cursor inheritance, and browser-folder recovery.
  - Focused tests explicitly protect legacy bare stored-route compatibility.
- Prerequisites:
  - Canonicalize every writer with agent and provider-account identity.
  - Use a virtual App/Web Provider Account for the internal default agent.
  - Reconcile persisted route rows and rebuild router cursor state atomically.
- Replacement: qualified stored route keys only.
- Boundary: retain user-facing bare conversation selectors and ambiguity
  detection. They are current UX, not stored-route compatibility.

### 6. Collapse duplicate ConversationInstall projections

- Tag: `shrink`
- Estimated reduction: approximately 100 lines after replacement
- Primary paths:
  - `apps/core/src/config/settings/runtime-settings-binding-derivation.ts`
  - `apps/core/src/config/settings/runtime-settings-parser.ts`
  - `apps/core/src/config/index.ts`
  - `packages/contracts/src/settings/index.ts`
  - `packages/sdk/src/settings.ts`
- Evidence:
  - One relationship is exposed as nested `installedAgents`, flat
    `conversationInstalls`, top-level `bindings`, and per-agent `bindings`.
  - The parser materializes all projections from installs, while live settings,
    control-plane, sender-policy, CLI, SDK, and routing consumers read the
    derived shapes.
- Replacement: keep `conversations.*.installed_agents` authoritative and derive
  one narrow runtime route DTO at the persistence/runtime boundary.
- Boundary: this is a coordinated ownership cut, not dead-field deletion.
  Retain current install identity, provider account, conversation/thread,
  status, memory scope, model override, permission override, and timestamps.
  The estimate excludes findings 3, 7, and 16.

### 7. Delete the `providerConnection` runtime shadow and stale active vocabulary

- Tag: `delete`
- Estimated reduction: approximately 55 lines; active vocabulary renames are
  additional zero-net cleanup
- Primary paths:
  - `apps/core/src/config/settings/runtime-settings-types.ts`
  - `apps/core/src/config/settings/runtime-settings-parser.ts`
  - `apps/core/src/config/index.ts`
  - `apps/core/src/config/settings/desired-state-current-export.ts`
- Evidence:
  - `RuntimeConfiguredConversation.providerConnection` shadows
    `providerAccount`, and the parser writes both with the same value.
  - Public settings discard the shadow while production derivation and
    validation still fall back to it.
  - Export accepts obsolete `channel-providerConnection:` even though current
    writers mint `channel-providerAccount:`.
  - Active code, OpenAPI, generated SDK output, runtime errors, and active docs
    still use residual Provider Connection wording such as
    `missing_provider_connection`.
- Replacement: `providerAccount` only; delete duplicate writes, fallbacks,
  omission-only tests, and the obsolete prefix. Rename remaining active
  vocabulary without counting those renames as line reduction.
- Boundary: do not rewrite historical migrations or historical decision text
  under this finding.

### 8. Delete the superseded test-result recorder

- Tag: `delete`
- Estimated reduction: 51 lines
- Path: `.codex/scripts/record_test_result.py`
- Evidence: no caller uses the flag-by-flag recorder. Current factory docs,
  prompts, stage playbooks, and scaffold checks use
  `.codex/scripts/record_test_from_json.py`.
- Replacement: `record_test_from_json.py`.

### 9. Make canonical job routing fields mandatory

- Tag: `shrink`
- Estimated reduction: approximately 40 lines after replacement
- Primary paths:
  - `apps/core/src/domain/job-types.ts`
  - `apps/core/src/jobs/job-notification-routes.ts`
  - `apps/core/src/application/jobs/job-visibility-metadata.ts`
  - `apps/core/src/application/jobs/job-management-access.ts`
  - `apps/core/src/adapters/storage/postgres/services/canonical-job-ops-service.ts`
- Evidence:
  - Current user and system job writers persist both `execution_context` and
    `notification_routes`.
  - Readers still accept camel aliases, reconstruct authority from old
    top-level fields, and permit missing canonical routing.
- Prerequisite: reset or rewrite existing job rows before making both canonical
  fields required.
- Replacement: canonical fields only.
- Boundary: keep top-level `workspace_key`, `thread_id`, and `session_id` where
  they remain current schema/correlation fields; delete only their fallback
  authority.

### 10. Delete the unreferenced Postgres-test wrapper

- Tag: `delete`
- Estimated reduction: 32 lines
- Path: `.codex/scripts/run_postgres_integration_with_url.mjs`
- Evidence: no active caller, docs, CI, package script, or scaffold requirement
  references it. Historical `.factory/reviews` mentions are evidence, not
  consumers.
- Replacement: set `GANTRY_TEST_DATABASE_URL` and invoke the documented focused
  Postgres test command directly.

### 11. Delete uncalled `_memorySubjectFromRow`

- Tag: `delete`
- Estimated reduction: 32 lines
- Path:
  `apps/core/src/adapters/storage/postgres/repositories/domain-repositories.postgres.ts`
- Evidence: exact, tracked-file, and structural searches found only its
  declaration; no interface or dynamic export requires it.
- Replacement: nothing.

### 12. Replace the GitHub-comment wrapper with `gh`

- Tag: `native`
- Estimated reduction: 26 lines
- Path: `.codex/scripts/sync_github.py`
- Evidence: no caller, prompt, workflow, documentation, or scaffold requirement
  references it. It only dispatches to `gh pr comment` or `gh issue comment`.
- Replacement: use `gh` directly with `--repo` and `--body-file`.

### 13. Delete legacy provider-namespace conversation CLI aliases

- Tag: `delete`
- Estimated reduction: approximately 25 lines after replacement
- Path: `apps/core/src/cli/provider.ts`
- Evidence:
  - Undocumented `gantry provider info` resolves and formats the same object as
    documented `gantry conversation info`.
  - Undocumented `provider control-allowlist` and `provider approvers` own
    conversation approver behavior.
  - Canonical `conversation approvers` currently delegates backward into that
    provider branch, and an alias-focused test is its only hidden consumer.
- Replacement: move the approver implementation behind a conversation-owned
  helper and retain only `gantry conversation info` and
  `gantry conversation approvers`.

### 14. Delete unreachable external-ref route reconstruction

- Tag: `delete`
- Estimated reduction: approximately 20 lines
- Path:
  `apps/core/src/adapters/storage/postgres/repositories/canonical-binding-repository.postgres.ts`
- Evidence:
  - The sole supported writer always persists
    `conversation-route:${jid}`.
  - The reader selects only that prefix, validates it, and extracts the nonempty
    route key before considering `conversationExternalRefJson`.
  - Git history, migrations, and direct fixtures contain no supported row that
    the external-ref fallback can rescue.
- Replacement: derive the route key only from the binding ID suffix and retain
  an empty-suffix fail-closed guard.
- Boundary: remove only this projection/select/parse/fallback and its fixture
  properties. `conversations.external_ref_json` remains live for outbound
  delivery and discovery.

### 15. Delete stale `defaultConnection` test assignments

- Tag: `delete`
- Estimated reduction: 17 lines
- Path:
  `apps/core/test/unit/config/settings-desired-state-service.test.ts`
- Evidence: 16 assignments occupy 17 lines and dynamically spell the retired
  property as `['default' + 'Connection']`, evading normal cleanup searches.
  Production has no reader and the parser rejects `default_connection`.
- Replacement: nothing; retain the reject-only stale-shape test.

### 16. Move trigger policy off ConversationInstall

- Tag: `shrink`
- Estimated reduction: approximately 15 net lines, excluding finding 6
- Primary paths:
  - `apps/core/src/config/settings/runtime-settings-types.ts`
  - `apps/core/src/config/settings/runtime-settings-parser.ts`
  - `apps/core/src/config/settings/runtime-settings-renderer.ts`
  - `packages/contracts/src/settings/index.ts`
  - `packages/contracts/src/providers/index.ts`
- Evidence:
  - The native Provider Account contract forbids a user-configured text trigger
    as multi-agent selection authority.
  - Settings and provider contracts still expose install-level `trigger` and
    `requiresTrigger`, and desired-state persistence embeds them in install
    route metadata.
- Replacement:
  - Remove configurable `trigger` from ConversationInstall; derive any internal
    matcher from validated provider-native or virtual App/Web identity.
  - Move `requiresTrigger` to the Conversation trigger policy and project its
    live admission behavior into runtime routes.
- Boundary: retain install/agent-qualified `model` and `permissionMode`.
  `/model` and `/permissions` use them as documented conversation overrides.

### 17. Derive SDK agent profile-file types from generated OpenAPI

- Tag: `shrink`
- Estimated reduction: approximately 15 lines
- Primary paths:
  - `packages/sdk/src/agents.ts`
  - `packages/sdk/src/openapi-types.ts`
- Evidence: the handwritten profile-file wire types at `agents.ts` lines 29–52
  are equivalent to generated OpenAPI types at approximately lines 1973–2000.
- Replacement: narrow generated aliases.
- Prerequisite: share finding 4's contract projection and generated-drift CI
  gate; its cost is counted there, not twice.

### 18. Delete injected-runner execution-provider fallbacks

- Tag: `delete`
- Estimated reduction: approximately 11 lines
- Paths:
  - `apps/core/src/jobs/execution.ts`
  - `apps/core/src/jobs/execution-dead-letter.ts`
  - `apps/core/src/jobs/model-resolution.ts`
  - `apps/core/src/runtime/execution-provider-id.ts`
- Evidence: both normal and dead-letter fallback branches exist only when tests
  inject `runAgent`; production composition supplies execution adapters and
  catalog-backed model routing resolves the provider first.
- Replacement: the normal registered-adapter and catalog-backed path. Update
  focused tests to inject the existing fake adapter.

### 19. Delete factory review compatibility aliases

- Tag: `shrink`
- Estimated reduction: approximately 8 lines
- Paths:
  - `.codex/scripts/record_review.py`
  - `.codex/scripts/record_review_from_json.py`
  - `.codex/scripts/factory_gates.py`
- Evidence: current docs, prompts, and artifacts require
  `blocking_findings`/`non_blocking_findings`; scripts still accept or emit
  `--blocking`, `--warning`, `blocking`, and `warnings`. The gate validates
  canonical required fields before its old fallback could rescue an old-only
  artifact.
- Replacement: canonical finding fields only.
- Boundary: keep `record_review.py`; current reviewer docs still use it.

### 20. Delete accepted `thread:slack:` compatibility

- Tag: `delete`
- Estimated reduction: approximately 7 lines
- Path: `apps/core/src/channels/slack/thread-ts.ts`
- Evidence: no active source writer emits `thread:slack:`. One compatibility
  assertion and stale integration fixture literals remain.
- Replacement: accept current Slack JID and provider-account-qualified thread
  IDs only; normalize stale fixture literals without counting those edits as
  line reduction.

### 21. Remove one duplicate contracts-package export alias

- Tag: `yagni`
- Estimated reduction: 5 lines
- Path: `packages/contracts/package.json`
- Evidence: `./contract-primitives` and `./primitives` resolve to the same
  artifact, neither has a repository consumer, `npm view @gantry/contracts`
  returns not found, and the repository has no release tags.
- Replacement: retain `./contract-primitives` only.

### 22. Delete the obsolete post-tool hook stub

- Tag: `delete`
- Estimated reduction: 3 lines
- Path: `.codex/scripts/post_tool_use.py`
- Evidence: the file is a no-op, is not configured, and the hook contract test
  asserts it is absent from the configured hook surface.
- Replacement: nothing.

### 23. Delete invariant ConversationInstall sender/control fields

- Tag: `delete`
- Estimated reduction: approximately 60 net nonmigration lines; 66 active/test
  lines before allowing for a small forward migration
- Primary paths:
  - `apps/core/src/domain/provider/provider.ts`
  - `apps/core/src/adapters/storage/postgres/schema/providers.ts`
  - `apps/core/src/adapters/storage/postgres/repositories/domain-repositories.postgres.ts`
  - `apps/core/src/application/provider-conversations/provider-conversation-control-use-cases.ts`
  - `apps/core/src/config/settings/desired-state-service.ts`
  - focused domain, application, control, and Postgres tests
- Evidence:
  - `ConversationInstall.senderPolicy` can only be `provider_native` and
    `controlPolicy` can only be `conversation_approvers`.
  - Every writer persists those two constants.
  - No runtime, API, SDK, audit, authorization, approval, or delivery consumer
    branches on either field.
  - Actual sender admission uses the Conversation-owned sender policy; approval
    authority uses Conversation approver rows.
- Replacement: nothing. Keep sender policy, trigger policy, and approvers on
  Conversation; keep install identity, status, memory scope, model/permission
  overrides, and permission-policy references on ConversationInstall.
- Migration boundary: do not count migration-history or snapshot deletions
  here. If finding 1 lands, omit the columns from the replacement baseline. If
  it does not, add a normal forward drop migration.
- Documentation: correct the stale install-policy wording in
  `docs/architecture/canonical-domain-model.md` without counting that zero-net
  edit as deletion.

### 24. Delete unused domain memory re-exports and their exception

- Tag: `delete`
- Estimated reduction: exactly 11 lines
- Paths:
  - `apps/core/src/domain/repositories/domain-types.ts`
  - `.codex/architecture-exceptions.json`
- Evidence:
  - No consumer imports `MemoryScope` or `MemorySearchResult` through the domain
    repository barrel; real consumers import the memory-owned types directly.
  - The four-line re-export is the file's only forbidden layer import.
  - Removing it makes the seven-line architecture exception stale, which the
    checker requires deleting in the same change.
- Replacement: nothing.

## Architecture Refactor Companion

### Verdict and acceptance criteria

Architecture changes are required alongside a subset of the cleanup, but the
smallest correct plan is five bounded slices. A broad folder shuffle, new
general-purpose service layer, new route table, compatibility facade, or higher
architecture-exception cap is not justified.

The companion refactor is complete only when:

- every settings mutation writes a revision before Postgres, live runtime, and
  `settings.yaml` projection;
- live routes no longer use folder, free-form trigger text, or bare JID as
  canonical identity;
- Conversation owns sender/trigger/approver policy and ConversationInstall owns
  agent-specific installation and override state;
- public contract schemas flow one way into OpenAPI and generated SDK types;
- runtime/messaging persists canonical visible text and channel adapters alone
  render provider-native text; and
- architecture checks pass without raising line budgets or exception counts.

This addendum is audit/planning only. Its bounded write scope is this report;
implementation must use the Gantry goal pipeline and preserve unrelated dirty
worktree changes.

### AR1. Move desired-state orchestration to application ownership

- Related findings: 3, 6, 7, 16, and 23
- Current debt:
  - `config/settings` owns revision CAS, repository reconciliation, runtime
    projection, import/export, and YAML codecs together.
  - Provider/conversation Control routes mutate domain/Postgres first, manually
    project live routes, then export backward into settings.
  - Slack, Telegram, and other setup CLIs can write a route before writing the
    desired-state revision.
- Target:
  - Keep YAML/JSON parse, validation, render, and file codecs under
    `config/settings`.
  - Relocate the existing desired-state orchestration into
    `application/settings`; do not create a parallel service.
  - Control HTTP, CLI, runtime revision listeners, and reviewed admin tools call
    the same application facade.
  - The mutation order is revision append/CAS, then Postgres and live runtime
    reconciliation, then canonical YAML sync.
  - Put revision notification transport behind a narrow port implemented by the
    Postgres adapter.
  - Delete manual `projectConversationInstallToRuntime` and reverse topology
    sync once every mutation uses reconciliation.
- Existing exceptions with removal phase `settings-desired-state-port-extraction`
  should be removed as their imports disappear, not widened.

### AR2. Replace the legacy live-route contract with a canonical projection

- Related findings: 5, 6, 14, 16, and the `register_agent` writer
- Current debt:
  - `apps/core/src/domain/types.ts` models `ConversationRoute` with `folder`, free-form
    `trigger`, `added_at`, and optional canonical identities.
  - The repository port lives in the old ops bundle, route selection lives in
    `apps/core/src/shared/thread-queue-key.ts`, and 51 production files consume the legacy
    shape.
  - A manual thread-qualified Control projection loses thread scope when
    `runtime-app.ts` reconstructs the key with `threadId: undefined`.
  - `MemorySubject.route` carries routing and agent configuration that do not
    belong to memory identity.
- Target:
  - Relocate and rename the existing narrow port as an application-owned
    `LiveConversationRoute` projection; this is moving an existing seam, not
    adding another repository abstraction.
  - Use canonical app, agent, provider-account, conversation, optional thread,
    and explicit workspace identity. Provider JID conversion stays at adapter
    boundaries; folder is not identity.
  - Move route key encoding/selection out of `shared` beside the application
    route projection.
  - Preserve Conversation-owned `requiresTrigger`; derive provider-native
    addressing evidence inside channel adapters instead of persisting user
    trigger text.
  - Replace `MemorySubject.route` with an adapter-private typed live-projection
    payload. Desired-state revisions remain durable authority.
  - Merge the one-consumer canonical binding ops wrapper into the Postgres route
    repository.
  - Keep explicitly identified and filtered `conversation-route:` rows in the
    shared ConversationInstall table; the current rules permit that separation
    and do not justify a new table.
  - Make MCP `register_agent` and IPC registration call the same
    ConversationInstall/desired-state use case instead of `registerGroup`.

### AR3. Make contracts the one-way public schema authority

- Related findings: 4, 6, 7, 16, and 17
- Target flow:
  `@gantry/contracts` Zod schema → Control OpenAPI JSON Schema → generated SDK
  operation/schema aliases.
- Evidence:
  - `packages/contracts` is the documented public integration boundary.
  - Control routes already validate important provider/install requests with
    those schemas.
  - Handwritten OpenAPI currently weakens or omits contract fields, and the SDK
    duplicates both.
  - Installed Zod 4 can project the checked ConversationInstall, runtime
    settings, and profile schemas through `z.toJSONSchema`; no dependency or
    new schema-generation framework is required.
- Target:
  - Add one small OpenAPI-layer projection helper for contract-covered DTOs.
  - Keep route metadata, examples, and schemas with no canonical contract
    manual.
  - Add missing desired-state/revision response contracts before migrating SDK
    settings types.
  - Enforce `npm run check:generated --workspace @gantry/sdk` in CI.
- Correction to finding 4: manually tightening OpenAPI is only a stopgap; the
  contract projection must establish the authority direction before SDK aliases
  replace handwritten types.

### AR4. Finish provider/conversation application ownership

- Related findings: 5, 6, 7, 13, and 16
- Current debt: Control and CLI adapters still construct storage/config writers,
  decode persistence metadata, or delegate canonical Conversation commands
  backward into Provider commands.
- Target:
  - Put ProviderAccount, ConversationInstall, Conversation administration, and
    agent-conversation summary use cases under
    `application/provider-conversations`.
  - Inject those services at composition roots; Control and CLI only parse,
    authenticate, invoke, and format.
  - Route `conversation info/approvers` through the existing
    `ConversationAdministrationService` before deleting finding 13's aliases.
  - Preserve current audit evidence and use the desired-state mutation path for
    all authority changes.
- Boundary: a wholesale CLI/control folder move is a separate target-layout
  concern and is not required for this cleanup.

### AR5. Move outbound rendering to channel adapters

- Related finding: 16; also resolves current provider-boundary debt
- Current debt:
  - `apps/core/src/messaging/text-styles.ts` contains Slack/Telegram dialect
    behavior.
  - `apps/core/src/messaging/router.ts`, runtime buffering, and bootstrap outbound projection
    resolve provider formatting before the channel send boundary.
  - Runtime events can therefore persist provider-formatted text instead of
    canonical visible text.
- Target:
  - Runtime/messaging only removes internal tags and persists canonical visible
    Markdown/text.
  - Slack and Telegram render at send/stream boundaries inside their adapters;
    Teams, Discord, and App keep their current native/no-op behavior.
  - Delete the provider registry `formatting` field and
    `formatOutboundForChannel` when no consumer remains.
  - Keep provider-specific partial-delivery and length behavior inside each
    channel adapter.
- No architecture-map update is required because the target owners are already
  approved adapter paths.

### Immediate architecture-gate closeout

The current dirty worktree has independent architecture blockers that should be
fixed before branch closeout, but they are not included in the Ponytail line
estimate:

- Split `apps/core/src/app/bootstrap/channel-wiring.ts` by responsibility and
  restore its ratchet. The dirty map raises its budget from 759 to 820 while the
  file is currently 790 lines; do not use that cap increase as the fix.
- AR5 must remove the three provider-specific Telegram violations currently
  reported in `apps/core/src/messaging/text-styles.ts`.

Do not raise `.codex/architecture-map.json` line budgets or
`.codex/architecture-exceptions.json` counts. Remove exception entries in the
same change that removes their violations. Change the architecture map only if
a later physical move creates a genuinely new owned path.

### Findings that need no architecture movement

Findings 1, 2, 8–12, 14, 15, and 18–22 are deletion/replacement work in their
current owner. Finding 9 requires canonical job fields and a row reset/rewrite,
but no new job routing port or value object. Finding 11 does not require
splitting the 1,700-line Postgres repository bundle; that broader file split is
separate maintainability work.

### Surface Impact Matrix

| Surface                      | Classification       | Reason                                                                                                                                                                 |
| ---------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior             | Changed              | Qualified live routes, preserved thread scope, revision-first overrides, and adapter-owned rendering alter internal execution paths while preserving product behavior. |
| `settings.yaml`              | Changed              | Nested installs become sole authority; install trigger and derived binding copies are removed; Conversation owns trigger admission.                                    |
| Postgres/runtime projection  | Changed              | Settings revisions drive projection; invariant install columns and route fallbacks are removed; job rows need reset/rewrite.                                           |
| Control API                  | Changed              | Provider/conversation mutations become revision-first and public generic route config is removed.                                                                      |
| SDK/contracts                | Changed              | Contracts become schema authority; generated aliases replace handwritten duplicates.                                                                                   |
| CLI                          | Changed              | Conversation commands and setup mutations call application services instead of direct route/settings writes.                                                           |
| Gantry MCP tools/admin skill | Changed              | `register_agent` keeps its durable tool name but calls the canonical install/desired-state use case and loses model-authored trigger authority.                        |
| Channel/provider adapters    | Changed              | Adapters derive provider-native addressing and own final text rendering.                                                                                               |
| Docs/prompts                 | Changed              | Canonical ownership, schema flow, Provider Account vocabulary, and settings examples must align.                                                                       |
| Audit/events                 | Read-only/observable | Existing event kinds and audit authority remain; stored outbound text and route identities become canonical.                                                           |
| Tests/verification           | Changed              | Revision-first, route/thread, contract generation, channel rendering, stale-shape, and disposable-Postgres coverage are required.                                      |

### Implementation order and verification

1. Decide whether every database can reset; baseline history only with explicit
   approval.
2. Seal canonical settings and policy ownership, including findings 6, 7, 16,
   and 23.
3. Establish AR1's revision-first application seam and remove reverse/manual
   projection.
4. Cut over AR2's qualified live-route projection and all writers, including
   `register_agent`.
5. Establish AR3's contract projection, regenerate the SDK, and land findings 4
   and 17.
6. Land AR4/AR5 adapter cuts and clear current architecture-gate overflows.
7. Apply remaining deletion-only findings and run stale-name/entrypoint searches.

Minimum focused evidence for implementation:

- settings parser/render/import/reconciliation and revision listener tests;
- provider-conversation application, Control auth/route, CLI, MCP, and IPC tests;
- route-key, message-loop, runtime-app, model/permission override, and thread
  projection tests;
- canonical binding repository unit tests plus disposable-Postgres integration;
- messaging/outbound projection plus Slack, Telegram, Teams, and Discord tests;
- contracts tests, Control OpenAPI tests, SDK generation check, typecheck, and
  build;
- `python3 .codex/scripts/check_architecture.py`;
- `python3 .codex/scripts/check_task_completion.py`;
- clean-cut searches for `ConversationRoute`, `registerGroup`,
  `providerConnection`, `routeConfig`, `MemorySubject.route`,
  `formatOutboundForChannel`, `triggerPattern`, and `requiresTrigger` in their
  retired ownership contexts.

## Falsified or Excluded Candidates

The following were searched and intentionally excluded from the total:

- Do not broadly replace handwritten Provider/Admin SDK types yet. Current
  generated OpenAPI omits or weakens metadata, enums, nullability, trigger, and
  capability shapes; direct aliases would regress SDK accuracy.
- Do not delete camel-shaped canonical job target readers broadly. Current
  Postgres writers intentionally emit parts of that shape. Only the routing
  aliases already included in finding 9 are legacy.
- Keep install-level `model` and `permissionMode`; they are current,
  restart-persistent conversation overrides with documented precedence.
- Keep broad `external_ref_json` support; only the narrow route fallback in
  finding 14 is unreachable.
- Keep `@anthropic-ai/sdk`; it is a required peer of
  `@anthropic-ai/claude-agent-sdk`.
- Keep the configured Stop hook; it is documented and contract-tested even
  though its current behavior is deliberately quiet.
- Keep scheduler and IPC guards for `required_tools`, the legacy group-scope
  token, `linkedSessions`, `deliverTo`, and `notificationTarget`; they reject
  stale input instead of accepting it.
- Keep `command ?? cmd`; accepting both names is a current permission and YOLO
  policy invariant.
- Keep camel/snake runtime-event normalization because current producers use
  both shapes.
- Keep reader-version skew handling because it protects supported rolling fleet
  upgrades.
- Keep direct sandbox mode and service-manager fallbacks; both are current,
  documented behavior.

## Verification Performed

- Refreshed the semantic inventory with `ccc`.
- Used hidden-inclusive `rg`, tracked-file `git grep`, and structural
  `ast-grep` searches.
- Falsified live writers, imports, object shapes, tests, docs, generated code,
  package reason chains, persisted rows, migrations, and Git history.
- Ran three section-owner subagents, reassigned every section to a different
  falsifier, and ran narrow third-pass tie-breakers for disputed or newly found
  seams.
- Confirmed the orchestrator reports `phase=done` for the current goal.
- Confirmed `npm run check:generated --workspace @gantry/sdk` currently passes;
  the missing piece is enforcing it in CI.
- Re-ran the architecture and completion checkers. Both report only the three
  provider-specific Telegram path violations; the completion checker inspected
  49 dirty-worktree files and reported no additional completion warnings.
- Confirmed this report passes Prettier and `git diff --check`-equivalent
  whitespace inspection.

The audit changed only this report. It did not implement cleanup, change
configuration or dependencies, or mutate Git state. Current whole-worktree
architecture closeout is blocked by the three provider-specific `telegram`
violations in `apps/core/src/messaging/text-styles.ts` and the hidden
`channel-wiring.ts` ratchet relaxation described above. Those dirty-worktree
failures are outside the Ponytail line estimate. Earlier Discord and Slack
line-budget failures disappeared as concurrent dirty-worktree edits reduced
those files below their configured limits; they are not retained as findings.

`net: approximately -19,424 lines, -0 deps possible under the clean-reset condition.`

## Phase-3 slice 1 validation addendum (2026-07-19)

Slice 1 (N1, N5-N7, N9, remnants, AR1 19→0 settings edges; trigger bridge
deferred to AR2, see execution ledger on `feature/ponytail-audit`) passed
typecheck + full unit, but local autoreview found two REAL P1s (fix round
dispatched; both must land before the slice commits):

1. **appId-less provider (family 3)**: control-server process-wide
   `configureDesiredSettingsStorageProvider` builds `SettingsDesiredStateService`
   WITHOUT `appId` while the sibling site (control/server/index.ts:~391) passes
   it — multi-app writes reconcile against the default tenant. Root fix: thread
   `appId` through the provider callback contract in
   `desired-settings-writer.ts` (`writeDesiredRuntimeSettings` already has it),
   then scope ALL provider sites (control server + CLI — same latent bug).
2. **Duplicate `desiredState:` keys** in settings-import-service.test.ts object
   literals — invisible to typecheck (tests excluded) and vitest (esbuild
   last-wins). Keep one per literal.
