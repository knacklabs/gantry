# Ponytail Execution Ledger

Date: 2026-07-19

Scope: Phase 1 transition evidence and Phase 2 settings-authority cutover from
`ponytail-audit-2026-07-16.md`.

## Phase 1 transition evidence

### Migration head

- The current migration head is `0103_settings_authority_cutover` (`idx: 103`,
  journal timestamp `1784418410109`).
- The repository has 101 SQL migration files and 101 journal entries, including
  `0103`.
- Head SQL SHA-256:
  `46995b633e529e57e2195829a1bfc9bd6d5340a89431889dc236728961498d7a`.
- `0103_snapshot.json` SHA-256:
  `d807c83424f31ad996d13ec965cbc0a39d717cb181005bc452529aa13e46db05`.
- `0103` is a normal forward migration, not the Phase 7 replacement baseline.
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
exact stamp metadata. `0103` is not that baseline.

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
| F23  | Implemented | Removed invariant install `senderPolicy`/`controlPolicy` from domain, repository, schema, contracts, tests, and writers; `0103` drops the columns. Conversation sender policy and approvers remain authoritative.                                                                              |
| AR1  | Implemented | Moved the existing desired-state service, helpers, types, and current export into `application/settings`; boot, watchers, writer, CLI/control consumers, and reconciliation use that application-owned seam. YAML codecs and revision transport remain in their narrow config/Postgres owners. |

No Phase 2 item was skipped. F7 is adjusted only because the approved plan
keeps F3's transition reader through the short rollback window and removes it
in Phase 9.

### Net line delta

Measured before adding this Phase 1 ledger:

- tracked changes: +631 / -7,382 lines;
- new non-generated `application/settings` source: +1,382 lines;
- Phase 2 non-generated total: +2,013 / -7,382, net **-5,369 lines**;
- generated migration artifacts excluded from that reduction: `0103` SQL +2
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
The 0103 migration derives conversation `requires_trigger` from kind and drops
the per-install columns without preservation code (user directive: no legacy
support). Live-machine audit 2026-07-19: two REAL channels deliberately run
trigger-free and MUST carry `requires_trigger: false` explicitly through the
one-time settings cleanup — `main_telegram_group` and
`telegram_default_-1003798366047_0f76daeb32c4`. The other two real
conversations match kind-derived defaults. All codex_test_* conversations are
deleted, not migrated.
