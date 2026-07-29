# Permission durable-storage simplification — plan validation
<!-- doc-references: frozen 2026-07-22 (decision 0036) -->

Date: 2026-07-18  
Validated checkout: `fix/capability-permission-durable-record` at `94043cdc3`  
Source plan: `docs/architecture/coordination-representation-audit-2026-07-18.md`, Group A

## Verdict

**REVISE BEFORE IMPLEMENTATION.** The cycle is directionally correct, but the
audit is not an implementation-ready contract on this branch:

1. A1 does have four provider-owned recovery flows, but it does **not** have
   four reimplementations of `samePermissionClaim`. Only Slack and Teams have
   local callback comparators, those comparators are used by live-prompt paths,
   and their types/semantics do not match `samePermissionClaim`.
2. The carried-#1 line ranges are substantially stale and omit active claim
   lifecycle operations (`settle`, terminal-settlement lookup, and the shared
   scoped predicate). Its proposed columns are also insufficient to reconstruct
   the current durable claim.
3. A3 is not a unique-index-only change. The three process-local dedup paths do
   not share one durable row or one persisted `review_key`; the two skill paths
   can progress to side effects independently after duplicate approvals.
4. A2 is real representation debt, but `batch.canonicalId` alone is not a
   globally safe grouping key. Use an opaque envelope row id, or at minimum the
   full `(app_id, source_agent_folder, canonical_id)` scope.

The technically clean cycle is: characterize current invariants, normalize the
envelope and members, cut claims/settlements over to a relational table, then
unify the four permission-only recovery flows. Move A3 to the durable-work
primitive cycle.

## Validation scope and acceptance criteria

### Bounded implementation scope recommended for the future cycle

- Permission restart recovery only; no durable QUESTION replay or recovery.
- Permission recovery envelope/member representation.
- Permission callback claim/release/settle representation and repository port.
- The four channel permission-recovery branches and their focused tests.
- Cleanup of the retired permission coordination keys from active payload code.
- No settings, public API, CLI, SDK, or Gantry MCP surface changes.
- A3 is explicitly outside this cycle.

### Acceptance criteria

1. One application-owned permission recovery orchestrator owns durable lookup,
   option validation, authorization result handling, claim, decision
   reconstruction, terminalize-before-resolve ordering, retryable release, and
   durable resolution.
2. Providers only parse/ack transport input, supply canonical locator/context,
   authorize through their existing membership hook, terminalize provider UI,
   and render transport feedback.
3. One durable envelope row owns the rendered envelope and batch phase; member
   rows reference it by stable id. No full-envelope `JSON.stringify` grouping or
   N-row envelope copies remain.
4. One relational claim row is the single winner for a full scope. Release is a
   conditional delete; settlement is a conditional state transition; no alias
   or batch marker is reconstructed from a JSON claim.
5. Current permission invariants remain: full app/source/interaction scope,
   exact batch membership, unexpired pending members, persisted intent replay,
   terminalize before authority resolution, release on pre-settlement failure,
   and terminal settlement evidence.
6. Current question invariants remain: questions are in-process only across a
   restart, only cancelled question rows reopen, a live lease blocks orphan
   cancellation, and resolved/pending winners do not reopen.
7. Cleanup searches find no active uses of
   `permissionCallbackClaim`, `permissionCallbackSettlement`,
   `permissionCallbackId`, `permissionBatchCallbackId`,
   `permissionBatchRequestIds`, or per-member `permissionRecoveryEnvelope` in
   `pending_interactions.payload_json`.

## Corrected audit citations

### A1 — four provider recovery protocols

**Status: PARTLY CONFIRMED; citations and comparator claim need correction.**

| Audit subject          | Current branch evidence                                                                                                         | Correction                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discord recovery       | `apps/core/src/channels/discord-permission-callback.ts:100-203`; decision reconstruction `:205-219`                             | The audit's `:100-219` range is accurate. There is no local claim/callback equality helper in this file. The recovery path locates by provider prompt identity at `:117-145`, validates context/authorization/options at `:147-159`, reuses `prompt.claim` or claims at `:161-171`, terminalizes at `:180-198`, then resolves at `:199-202`.                                                                                                                    |
| Telegram recovery      | `apps/core/src/channels/telegram/permission-callback.ts:62-187`; terminalization `:189-241`; decision reconstruction `:243-257` | The audit's recovery and decision-helper ranges are accurate. There is no local claim/callback equality helper. Prompt lookup/claim reuse is at `:87-136`; authorization/options at `:112-127`; terminalize/release/resolve at `:159-186`.                                                                                                                                                                                                                      |
| Slack recovery         | `apps/core/src/channels/slack/channel-interactions.ts:303-391`; decision reconstruction `:636-654`                              | Replace audit `~310-389` with `:303-391`. The local `samePermissionCallback` is `:623-634`, but recovery does not call it. It is used for live pending prompts at `:393` and live full-view access at `:490`. Recovery looks up by callback scope at `:304-311`, uses `durable.claim` at `:318-339`, terminalizes at `:365-375`, and resolves at `:376-390`.                                                                                                    |
| Teams recovery         | `apps/core/src/channels/teams-interaction-handlers.ts:212-295`; decision reconstruction `:546-564`                              | Replace audit `~250-291` with `:212-295`. The local `sameTeamsPermissionCallback` is `:533-544`, but it is used only for the live pending path at `:305-309`, not recovery. Recovery looks up by callback scope at `:214-221`, uses `durable.claim` at `:233-251`, terminalizes at `:269-287`, and resolves at `:289-292`.                                                                                                                                      |
| Shared equality helper | `apps/core/src/application/interactions/pending-interaction-permission-claim.ts:73-83`                                          | The location is accurate, but the audit's proposed replacement is not. `samePermissionClaim` compares a complete persisted `PermissionCallbackClaim` to a `PermissionCallbackClaimReference` by claim id plus scope. Slack/Teams compare two provider callback descriptors, including `providerAlias` and `matchKind`, and have no claim id. The helper is already used at the actual durable boundary in `pending-interaction-permission-callback.ts:525-529`. |

The audit is correct that recovery ownership has drifted: Discord/Telegram use
the claim returned by prompt lookup (`discord-permission-callback.ts:137-163`,
`telegram/permission-callback.ts:103-130`), while Slack/Teams use the claim from
request-scope durable lookup (`slack/channel-interactions.ts:304-333`,
`teams-interaction-handlers.ts:214-245`). It overstates this as byte duplication:
the locator, acknowledgement, terminalization, and feedback semantics are
provider-specific. The shared portion is the application protocol between
canonical location and transport terminalization.

#### Correct A1 target

Add a permission-specific application function, not a generic durable
interaction recovery engine:

```text
recoverDurablePermissionDecision({
  locator, providerAlias, incomingMode, incomingApprover,
  resolveTransportContext, authorize, terminalize, reportOutcome
})
```

The application layer should own both supported locator forms (prompt-message
identity and canonical callback scope), durable context validation, claim
acquisition/reuse, reconstruction from persisted intent, release on failed
terminalization, and durable resolution. `samePermissionClaim` remains for the
persisted-claim/reference check; it is not a replacement for live callback
descriptor equality. If the live comparators are later consolidated, use a
separately typed callback-scope helper or eliminate the comparison by passing a
single validated callback descriptor.

The new wrapper in `apps/core/src/jobs/ipc-handler.ts:37-58` and its dependency
injection at `:169-175` mean reviewed-capability IPC prompts now also create
permission durable rows. A1 and the schema cut must include this path in focused
tests even though the audit predates it.

### A2 — `JSON.stringify` recovery-envelope identity

**Status: CONFIRMED representation smell; failure explanation and target need
qualification.**

- The full-object grouping exists exactly at
  `apps/core/src/application/interactions/pending-interaction-permission-callback.ts:118-124`;
  the equality expression is `:122-123`.
- `readPermissionRecoveryEnvelope` is now
  `apps/core/src/application/interactions/pending-interaction-permission-envelope.ts:58-107`,
  not merely “at line 106.” It validates the object and returns the same object
  by cast at `:106`; it does not rebuild a canonical representation.
- The earlier full-object equality remains in
  `sharedPermissionRecoveryEnvelope` at
  `pending-interaction-permission-envelope.ts:109-139`, specifically `:120`.

The code proves that grouping depends on full serialized equality. It does not
by itself prove the audit's specific “one JSONB round-trip changes key order”
failure. Treat that causal explanation as **PLAUSIBLE**, not confirmed. The
confirmed flaw is that group identity is coupled to every envelope field and
array order rather than to a database-enforced identity.

For review-each, `batch.canonicalId` is present and validated at
`pending-interaction-permission-envelope.ts:96-105`, but it is only canonical
inside the app/source scope. `PermissionCallbackScope` itself contains all
three fields at `apps/core/src/domain/types.ts:200-204`. Therefore the minimum
safe temporary key is `(appId, sourceAgentFolder, batch.canonicalId)`, not bare
`canonicalId`; sorted request ids must also be scope-qualified. The preferred
final fix is an opaque envelope row id referenced by relational member rows, so
no serialized grouping remains.

### A3 — process-local review dedup sets

**Status: SET CITATIONS CONFIRMED; proposed durable guard and impact are stale.**

- `pendingRequestOnlyCapabilityReviews` is still declared at
  `apps/core/src/jobs/ipc-admin-handlers.ts:89`, checked/added at `:317-320`,
  and deleted at `:638-640`.
- `pendingSkillInstallCommandReviews` and `pendingSkillPackageReviews` are still
  declared at `apps/core/src/jobs/ipc-skill-install-handlers.ts:38-39`.
  Command review checks/adds at `:150-165` and deletes at `:329-331`.
  Package review checks/adds at `:384-402` and deletes at `:419-421`, `:470-472`,
  and `:474-475`.

The audit says a durable pending-review row is already the real guard. That is
not true for this combined set:

- The request-only capability path creates a `pending_access_requests` row only
  after the local Set admits it, uses a random id, and swallows insert failure
  (`ipc-admin-handlers.ts:530-545`). The table has no `review_key` and only a
  non-unique app/status/expiry index
  (`apps/core/src/adapters/storage/postgres/schema/pending-access-requests.ts:4-36`).
- Skill command review creates a random permission request id and directly
  awaits approval (`ipc-skill-install-handlers.ts:191-229`); it does not create
  a `pending_access_requests` row.
- Skill package/proposal review also creates a random permission request id
  (`apps/core/src/jobs/ipc-skill-permission-review.ts:80-123`); it does not share
  the request-only capability row.
- Duplicate approved command reviews can both execute the installer at
  `ipc-skill-install-handlers.ts:259-275`. The materialization lock is explicitly
  process-local and defers cross-process coordination
  (`apps/core/src/shared/skill-install-lock.ts:1-7`), so the impact is not proven
  to be prompt-only UX.

Adding `UNIQUE (scope, review_key) WHERE status='pending'` is useful only after
there is one durable review-work contract with a deterministic key, atomic
create-or-observe result, explicit expiry/settlement, and side-effect ownership.
That is durable-work-primitive scope, not this permission callback storage cut.

### Carried #1 — claim state in JSONB

**Status: CONFIRMED; all cited ranges are stale and the target columns are
incomplete.**

Current repository locations are:

- `createPendingInteractionRow`:
  `apps/core/src/adapters/storage/postgres/repositories/worker-coordination-interaction.postgres.ts:56-181`,
  not `:84-115`. The permission duplicate-create refresh that preserves claim
  or settlement and removes/restores callback markers is `:107-180`, especially
  `:130-161`.
- `resolvePendingInteractionRow`: same file `:183-242`, not `:158-181`. The
  claim-to-settlement write and claim-fenced predicate are `:204-227`.
- `claimPendingPermissionCallbackRows`: same file `:324-475`, not `:240-392`.
  Exact batch validation is `:344-416`; JSON claim construction is `:417-432`;
  the claim write/guards are `:433-474`.
- `releasePendingPermissionCallbackRows`: same file `:478-508`, not `:394-425`.
  It reconstructs batch and provider callback aliases from the stored claim at
  `:487-504`.

The audit omits active lifecycle code that must migrate too:

- `settlePendingPermissionCallbackRows` converts the JSON claim to a JSON
  settlement at `worker-coordination-interaction.postgres.ts:511-529`.
- `findPendingPermissionInteractionRows` locates active claims and terminal
  settlements at `:531-580`.
- `scopedClaimWhere` claim-fences release/settle at `:582-599`.
- The repository adapter exposes claim/release/settle/find at
  `apps/core/src/adapters/storage/postgres/repositories/worker-coordination-repository.postgres.ts:564-591`;
  the port contract is
  `apps/core/src/domain/ports/worker-coordination.ts:296-309`.

The suggested columns `claim_id`, `claim_source_agent_folder`, `claim_kind`,
`claim_mode`, and `claimed_at` do not preserve the current claim contract. A
full `PermissionCallbackClaim` also contains `appId`, `interactionId`,
`approverRef`, `decidedAt`, `canonicalId`, and `providerAliases`
(`apps/core/src/domain/types.ts:200-223`). Settlement state and `settledAt` are
also durable inputs to retry/owner classification
(`pending-interaction-permission-callback.ts:70-93`, `:440-455`).

#### Recommended relational shape

Use tables rather than repeating nullable claim columns across N member rows:

1. `permission_recovery_envelopes`
   - opaque `id` primary key;
   - `app_id`, `source_agent_folder`, `canonical_id` with a unique constraint;
   - one sanitized `envelope_json` for rendering/replay data;
   - real `phase` (`decision | review_each`) and timestamps.
2. `permission_recovery_members`
   - `envelope_id`, `pending_interaction_id`, `request_id`, `member_index`, and
     nullable `provider_callback_alias`;
   - unique `(envelope_id, request_id)`, `(envelope_id, member_index)`, and
     `pending_interaction_id`;
   - durable review-each dispatch state/claim on the member, replacing the
     process-local replay memo.
3. `permission_claims`
   - `claim_id` primary key, `envelope_id`, `app_id`,
     `source_agent_folder`, `interaction_id`, `claim_kind`, `mode`,
     `approver_ref`, `claimed_at`, `canonical_id`, `provider_aliases`, `status`,
     and `settled_at`;
   - unique `(app_id, source_agent_folder, interaction_id)` across claimed and
     settled rows. Release conditionally deletes a claimed row; settle
     conditionally updates it. A settled row remains as terminal owner evidence.

This removes the N-row claim copy, makes release deletion rather than JSON
reconstruction, keeps review-each batch and member claims distinct, and gives
the recovery orchestrator one envelope plus relational membership.

### Carried #2 — envelope duplicated into every member row

**Status: CONFIRMED; prompt-binding citation is stale.**

- Envelope construction is now
  `apps/core/src/application/interactions/pending-interaction-prompt-binding.ts:136-177`;
  N per-row payload updates are `:178-212`. Replace the audit's `:199-233`.
- Shared read/equality is still
  `apps/core/src/application/interactions/pending-interaction-permission-envelope.ts:109-139`.
- The envelope type and member identity are
  `apps/core/src/domain/types.ts:177-198`.

The single-envelope target is correct, but a canonical row alone is not enough:
member-to-pending-row identity and member order must be relationally unique so
batch completeness no longer depends on duplicated arrays.

### Carried #4 — `reviewEachReplays`

**Status: CONFIRMED, but it is a Map and not an A3-style Set/index fix.**

- Replay orchestration is still
  `apps/core/src/application/interactions/pending-interaction-permission-callback.ts:151-234`.
- The process-local memo is a `Map<string, Promise<...>>` at `:245-248`, read at
  `:161-168`, written/cleared at `:231-232`, `:250-265`.

It prevents duplicate in-process replay for a claim. Cross-process replacement
requires durable per-member dispatch ownership/state tied to the canonical
envelope; a generic pending-review partial index does not express this state.
Implement it with the normalized envelope/member stage, not A3.

### Carried #5 — blind double resolve

**Status: STILL CURRENT; cite both lines.**

`finishDurablePermissionInteraction` still performs the same resolve twice at
`apps/core/src/application/interactions/durable-interaction-handler.ts:74-75`.
The first call applies the repository CAS through
`pending-interaction-resolution.ts:77-110`; an immediate identical retry is not
conditioned on current claim/envelope state. Fix this in the claim-table stage:
return a typed resolution result (`resolved`, `already_settled_same_claim`,
`retryable_failure`, `claim_mismatch`) and retry only the retryable case. Do not
touch `finishDurableQuestionInteraction` at `durable-interaction-handler.ts:257-272`.

## Full active reader/writer inventory for affected JSONB coordination fields

Inventory command scope was `apps/core/src`; tests are consumers to update, not
runtime readers/writers. Domain decision objects named
`permissionCallbackClaim` are excluded unless they read/write
`PendingInteraction.payload`. Generic payload boundaries are listed after the
field-specific sites.

| JSONB field                    | Writers/mutators                                                                                                                                                                                                                                                                                                                                                                     | Readers/guards                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `permissionCallbackId`         | Initial IPC payload: `runtime/ipc-interaction-processing.ts:146-156`; provider bind/add/delete/restore: `application/interactions/pending-interaction-prompt-binding.ts:155-168`, `:178-208`; duplicate-create preservation/removal: `worker-coordination-interaction.postgres.ts:130-160`; claim removes it and copies it into aliases: `:417-432`; release restores it: `:478-504` | Prompt lookup/full view: `pending-interaction-prompt-binding.ts:401-419`, `:435-446`; durable request lookup: `pending-interaction-permission-callback.ts:319-329`; SQL batch/individual eligibility: `worker-coordination-interaction.postgres.ts:385-397`, `:465-471`                                                                                                                                                                                                                                                  |
| `permissionBatchCallbackId`    | Provider bind/add/delete: `pending-interaction-prompt-binding.ts:169-175`, `:178-208`; duplicate-create removes/preserves related aliases: `worker-coordination-interaction.postgres.ts:130-160`; claim removes it: `:417-432`; release reconstructs it: `:478-504`                                                                                                                  | Prompt binding/lookup: `pending-interaction-prompt-binding.ts:188-205`, `:401-419`, `:448-469`; durable request lookup: `pending-interaction-permission-callback.ts:331-338`; SQL batch membership/claim/find: `worker-coordination-interaction.postgres.ts:344-397`, `:458-471`, `:540-556`                                                                                                                                                                                                                             |
| `permissionBatchRequestIds`    | Provider bind adds/deletes it at `pending-interaction-prompt-binding.ts:169-175`, `:202-205`                                                                                                                                                                                                                                                                                         | Exact batch-member and locator guards are all in `worker-coordination-interaction.postgres.ts:344-397`, plus per-row batch eligibility at `:458-463`                                                                                                                                                                                                                                                                                                                                                                     |
| `permissionCallbackClaim`      | Claim JSON is constructed/written at `worker-coordination-interaction.postgres.ts:417-446`; resolve moves it to settlement at `:204-212`; release deletes it at `:478-504`; settle moves it to settlement at `:511-529`; duplicate create preserves it at `:130-143`                                                                                                                 | Parser/equality boundaries: `application/interactions/pending-interaction-permission-claim.ts:26-65` and `pending-interaction-permission-envelope.ts:151-193`; bind rejection and prompt lookup: `pending-interaction-prompt-binding.ts:178-187`, `:390-419`; replay/find/claim/resolve readers: `pending-interaction-permission-callback.ts:60-93`, `:182-201`, `:295-317`, `:420-455`, `:515-530`; SQL resolve/claim/find/scoped guards: `worker-coordination-interaction.postgres.ts:204-227`, `:401-457`, `:531-599` |
| `permissionCallbackSettlement` | Duplicate-create preservation: `worker-coordination-interaction.postgres.ts:143-159`; resolve writes it at `:204-212`; explicit settle writes it at `:511-529`                                                                                                                                                                                                                       | Bind settlement handling: `pending-interaction-prompt-binding.ts:185-200`; replay/owner classification: `pending-interaction-permission-callback.ts:70-93`, `:188-201`, `:440-455`; SQL terminal lookup: `worker-coordination-interaction.postgres.ts:558-562`                                                                                                                                                                                                                                                           |
| `permissionRecoveryEnvelope`   | Provider bind writes the duplicated envelope at `pending-interaction-prompt-binding.ts:136-212`; batch claim mutates its nested phase at `worker-coordination-interaction.postgres.ts:433-445`                                                                                                                                                                                       | Validation/shared equality: `pending-interaction-permission-envelope.ts:58-139`; replay/group/owner reads: `pending-interaction-permission-callback.ts:82-124`, `:440-452`; prompt and request lookup call shared read at `pending-interaction-prompt-binding.ts:370-391` and `pending-interaction-permission-callback.ts:295-300`                                                                                                                                                                                       |

Supporting JSON scope fields retained today are `sourceAgentFolder` (with
fallback to `request.sourceAgentFolder`) and `requestId`. Their application
parser is `pending-interaction-permission-claim.ts:14-24`; SQL reads occur in
`worker-coordination-interaction.postgres.ts:336-359`, `:453-470`, and
`:570-573`. The normalized envelope/member tables should make permission claim
queries independent of these payload paths even if the payload keeps them as
render/audit data.

Generic boundaries that can carry any of the fields are:

- `toPendingInteraction`, which exposes the whole JSONB payload:
  `worker-coordination-interaction.postgres.ts:33-53`.
- initial create and duplicate refresh:
  `worker-coordination-interaction.postgres.ts:107-180`.
- the row-locked whole-payload update callback:
  `worker-coordination-interaction.postgres.ts:288-321`.
- the current table definition:
  `apps/core/src/adapters/storage/postgres/schema/worker-coordination.ts:135-182`.

## #228/#229 interaction analysis

### A1 versus deferred durable QUESTION recovery

There is no inherent conflict if A1 remains permission-specific. The #228
closeout contract is explicit: permission recovery remains durable, questions
are in-process only, and restart terminalizes/re-asks rather than replaying
answers (`docs/architecture/cd-envelope-durability-fix.md:11-15`, `:387-403`).
Current code implements the re-ask path in
`durable-interaction-handler.ts:159-205`.

Hard boundary for A1:

- Do not create `recoverDurableInteractionDecision` with permission/question
  branches.
- Do not call the new permission orchestrator from any user-question callback.
- Do not add question envelope replay, dispatch state, or answer recovery.
- Do not change `finishDurableQuestionInteraction` or question provider
  settlement as part of provider permission recovery extraction.

### Claim/envelope schema versus cancelled-only reopen and lease-aware cancel

The current question behavior is split across two exact seams:

1. `createPendingInteractionRow` has a question-only `INSERT ... ON CONFLICT DO
UPDATE` that reopens only `kind='question' AND status='cancelled'`, returns
   the new row, and otherwise reads the existing winner
   (`worker-coordination-interaction.postgres.ts:71-106`). The unique authority
   is `uq_pending_interactions_idempotency` at
   `schema/worker-coordination.ts:168-171`.
2. `cancelPendingQuestionInteractionIfRunLeaseInactiveRow` updates only the
   exact pending question id with non-null run id, a non-empty string lease
   token, a positive numeric fencing version, and no matching active lease
   (`worker-coordination-interaction.postgres.ts:244-285`).

The new permission tables/columns must preserve all of the following:

- `pending_interactions.idempotency_key` and the cancelled-question-only
  conflict predicate remain unchanged.
- Question reopen replaces the row's `id`, payload, callback route, run id,
  expiry, and timestamps with the new attempt; pending and resolved rows remain
  non-reopenable.
- Permission-only columns on `pending_interactions` are nullable and reset to
  null by the question reopen write. A permission child table never contains a
  question row.
- Every claim/release/settle query remains permission-only. No “missing claim
  row” predicate may classify a question as a recoverable permission.
- Claim absence must not block question resolution. The current no-claim branch
  succeeds because question payloads have no `permissionCallbackClaim`
  (`worker-coordination-interaction.postgres.ts:215-227`); the relational
  equivalent must scope `NOT EXISTS permission_claims` to permission rows.
- The lease-aware cancellation SQL and its JSON lease-token/fencing reads remain
  untouched in this cycle. Moving those question fields to columns is a later
  question/durable-work decision.
- Any FK from permission member state to `pending_interactions.id` is
  permission-only and cascading. It must not turn a cancelled question reopen's
  primary-key replacement into a cross-table dependency.
- `toPendingInteraction` and `listPendingInteractions` must continue returning
  both kinds; adding an inner join to permission envelope/claim tables would
  silently drop question rows.

Focused existing regression anchors are
`apps/core/test/unit/application/pending-interaction-durability.test.ts:2614-3084`
and
`apps/core/test/integration/worker-coordination.postgres.integration.test.ts:852-944`.

## Migration plan and conventions

### Migration location/convention

`dist/postgres-migrate.js:1` imports `PostgresStorageService` and invokes
`service.migrate()` at `:32-38`. The built service resolves migrations relative
to itself as `schema/migrations`
(`dist/adapters/storage/postgres/storage-service.js:11-12`) and runs Drizzle
under an advisory lock at `:144-154`.

The source-of-truth directory is
`apps/core/src/adapters/storage/postgres/schema/migrations/`: `npm run build`
copies it into `dist/adapters/storage/postgres/schema/migrations`
(`package.json:48-53`). Do not edit `dist/` by hand. The next migration follows
the sequential convention as `0102_permission_durable_storage_cutover.sql`,
with matching `meta/0102_snapshot.json` and a `_journal.json` entry after the
current `0101` entry (`meta/_journal.json:692-697`). Update the active Drizzle
schema modules and export from `schema/schema.ts` in the same stage.

### Recommended cutover

Use a **clean destructive permission-only cut**, not a JSON backfill or dual
reader:

1. Add the normalized envelope, member, and claim tables plus constraints.
2. Delete existing `pending_interactions` rows where `kind='permission'` in the
   cutover migration (or reset the disposable/local development DB). Do not try
   to reconstruct claims, settlements, aliases, or member groups from arbitrary
   legacy JSON.
3. Leave question rows and question lease payload fields intact.
4. Cut repository/application code directly to the new tables and remove all
   old JSON coordination reads/writes in the same stage. Do not ship a fallback
   reader or compatibility branch.

This is simpler than a backfill, avoids carrying the representation bug into
new rows, and is consistent with the repo's no-live-users clean-cut policy.
Deleting only permission interaction rows preserves unrelated runtime state and
is no more complex than requiring a full DB reset.

## Recommended stage sequence

Each stage is independently green. No implementation stage starts until this
plan is incorporated into an approved goal prompt with the required Surface
Impact Matrix and bounded handoffs.

### Stage 1 — characterize invariants before structural change

- Add/complete table-driven tests for the common permission recovery outcome
  matrix across Discord, Telegram, Slack, and Teams: active persisted claim,
  fresh claim, already decided, retryable claim, unauthorized/wrong channel,
  invalid mode, terminalization false/throw, resolve false, and batch recovery.
- Pin current exact-batch single-winner/release/settle behavior and the #229
  question reopen/cancel invariants.
- No production change.

Verify:

```bash
npm run test:unit -- apps/core/test/unit/application/pending-interaction-durability.test.ts apps/core/test/unit/channels/discord.test.ts apps/core/test/unit/channels/telegram.test.ts apps/core/test/unit/channels/slack.test.ts apps/core/test/unit/channels/teams.test.ts apps/core/test/unit/jobs/ipc-handler.test.ts
GANTRY_TEST_DATABASE_URL=<disposable-postgres-url> npx vitest run -c vitest.integration.config.ts --no-file-parallelism apps/core/test/integration/worker-coordination.postgres.integration.test.ts
npm run typecheck
```

### Stage 2 — canonical envelope/member cutover (A2 + carried #2/#4 foundation)

- Add the envelope/member schema and destructive permission-only migration.
- Store one envelope, scope-qualified stable identity, relational membership,
  real batch phase, and durable per-member review-each dispatch state.
- Remove duplicated `permissionRecoveryEnvelope`,
  `permissionBatchRequestIds`, and full-object grouping from member payloads.
- Replace `sharedPermissionRecoveryEnvelope` and `reviewEachReplays` with one
  repository-backed envelope/member read and durable dispatch ownership.

Verify:

```bash
npm run test:unit -- apps/core/test/unit/application/pending-interaction-durability.test.ts apps/core/test/unit/storage/postgres-migration-journal.test.ts apps/core/test/unit/channels/permission-batch-coalescer.test.ts
GANTRY_TEST_DATABASE_URL=<disposable-postgres-url> npx vitest run -c vitest.integration.config.ts --no-file-parallelism apps/core/test/integration/worker-coordination.postgres.integration.test.ts
GANTRY_TEST_DATABASE_URL=<disposable-postgres-url> npm run test:integration:postgres
rg -n "permissionRecoveryEnvelope|permissionBatchRequestIds|sharedPermissionRecoveryEnvelope|reviewEachReplays|JSON.stringify\(interaction.payload.permissionRecoveryEnvelope\)" apps/core/src
npm run typecheck
```

The cleanup search should have no active coordination matches; retained type or
historical test/doc mentions must be individually justified.

### Stage 3 — relational claim/settlement cutover (carried #1 + carried #5)

- Add `permission_claims` port/repository operations and cut claim, release,
  settle, find, resolution fencing, terminal-owner detection, and review-each
  member claims to the table.
- Remove callback/batch alias reconstruction by reading stable member aliases.
- Replace blind double resolve with typed resolution outcomes and retry only a
  classified retryable failure.
- Delete all old claim/settlement/callback marker JSON paths and their parsers.

Verify:

```bash
npm run test:unit -- apps/core/test/unit/application/pending-interaction-durability.test.ts apps/core/test/unit/channels/permission-batch-coalescer.test.ts apps/core/test/unit/runtime/ipc-interaction-handler.test.ts
GANTRY_TEST_DATABASE_URL=<disposable-postgres-url> npx vitest run -c vitest.integration.config.ts --no-file-parallelism apps/core/test/integration/worker-coordination.postgres.integration.test.ts
GANTRY_TEST_DATABASE_URL=<disposable-postgres-url> npm run test:e2e:postgres
rg -n "permissionCallbackClaim|permissionCallbackSettlement|permissionCallbackId|permissionBatchCallbackId|permissionBatchRequestIds" apps/core/src/application apps/core/src/adapters/storage/postgres apps/core/src/runtime
npm run typecheck
python3 .codex/scripts/check_architecture.py
```

The cleanup search may retain domain decision/reference names, but must have no
`PendingInteraction.payload` or `payload_json` coordination reads/writes.

### Stage 4 — one permission recovery orchestrator (A1)

- Add `recoverDurablePermissionDecision` in the application interaction layer.
- Convert the four provider recovery branches to typed locator/context,
  authorization, terminalization, and feedback hooks.
- Delete the four provider decision reconstruction helpers. Keep live prompt
  callback equality separate unless it becomes dead after the extraction.
- Keep all question callbacks and recovery behavior unchanged.

Verify:

```bash
npm run test:unit -- apps/core/test/unit/channels/discord.test.ts apps/core/test/unit/channels/telegram.test.ts apps/core/test/unit/channels/slack.test.ts apps/core/test/unit/channels/teams.test.ts apps/core/test/unit/application/pending-interaction-durability.test.ts apps/core/test/unit/jobs/ipc-handler.test.ts
npm run test:integration -- apps/core/test/integration/permission-approval-ipc.integration.test.ts
rg -n "recoverDurablePermission|recoveredDiscordPermissionDecision|recoveredTelegramPermissionDecision|recoveredSlackPermissionDecision|recoveredTeamsPermissionDecision" apps/core/src
npm run typecheck
python3 .codex/scripts/check_architecture.py
```

Expected cleanup result: one application recovery entrypoint; no provider-owned
decision reconstruction functions.

### Cycle closeout

```bash
npm run build
npm test
GANTRY_TEST_DATABASE_URL=<disposable-postgres-url> npm run test:integration:postgres
GANTRY_TEST_DATABASE_URL=<disposable-postgres-url> npm run test:e2e:postgres
python3 .codex/scripts/check_architecture.py
python3 .codex/scripts/check_task_completion.py
```

### A3 sequencing decision

**Move A3 to the durable-work-primitive cycle.** The repo execution queue
already places durable-work before permission durable-storage simplification
(`docs/architecture/goals-index.md:22-26`). That cycle should define the
deterministic durable review-work key, atomic create-or-observe API, expiry,
settlement, crash recovery, and side-effect ownership for capability, skill
command, and skill package/proposal reviews. Only then add the partial unique
index and remove the Sets. Pulling only the index into this cycle would either
cover one path or create another bespoke work primitive.

## Surface Impact Matrix

| Surface                      | Classification      | Reason                                                                                                                                                                                                       |
| ---------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime behavior             | Changed             | Internal permission restart recovery, claim lifecycle, batch membership, and review-each dispatch move to one relational/application protocol; user-visible decisions should remain behaviorally equivalent. |
| `settings.yaml`              | Unchanged by design | No configuration value is needed; this is an internal persistence/coordination cut.                                                                                                                          |
| Postgres/runtime projection  | Changed             | New envelope/member/claim tables, migration, repository methods, and runtime mapping are the core change. Postgres remains authoritative for durable interaction state.                                      |
| Control API                  | Unchanged by design | No public owner/admin API accepts or exposes this internal claim representation.                                                                                                                             |
| SDK/contracts                | Unchanged by design | Public SDK schemas do not expose pending-interaction claim storage. Internal domain/port types may change.                                                                                                   |
| CLI                          | Unchanged by design | No CLI command owns permission callback recovery.                                                                                                                                                            |
| Gantry MCP tools/admin skill | Unchanged by design | Tool requests continue through the same approval surface; no tool name or admin capability changes.                                                                                                          |
| Channel/provider adapters    | Changed             | Discord, Telegram, Slack, and Teams recovery branches become thin transport hooks.                                                                                                                           |
| Docs/prompts                 | Changed             | The approved goal prompt, schema/storage documentation, assumptions ledger, and cleanup evidence must reflect the relational invariant and A3 deferral.                                                      |
| Audit/events                 | Unchanged by design | Preserve existing permission requested/resolved evidence and actor attribution; do not change event payload contracts merely because storage moved.                                                          |
| Tests/verification           | Changed             | Add common recovery characterization, Postgres concurrency/migration, two-process claim, question non-regression, and all-provider tests.                                                                    |
| A3 review dedup              | Deferred            | It requires a shared durable review-work primitive and cross-process side-effect ownership, which is broader than permission callback storage.                                                               |

## Top five risks and concrete de-risking steps

1. **Single-winner/fail-closed regression during the table cut.** A relational
   rewrite can accidentally weaken full scope, exact batch membership, expiry,
   or terminal-owner detection.  
   **De-risk:** write a single invariant table before implementation; exercise
   it with Postgres tests for individual/batch claim races, release, settle,
   malformed/incomplete batches, expired members, cross-app/folder collisions,
   and the existing two-process E2E claim test.

2. **Provider terminalization semantics get flattened by A1.** Discord,
   Telegram, Slack, and Teams differ in lookup, ack, receipt fallback, and
   response reporting. A generic hook can release too late/early or resolve
   before UI terminalization.  
   **De-risk:** Stage 1's common outcome matrix must assert ordering and release
   behavior per provider. The application orchestrator returns typed outcomes;
   transport hooks retain provider feedback only.

3. **Question reopen/cancel behavior is broken by generic repository joins or
   predicates.** A permission-table inner join, non-null claim default, or
   altered conflict update can make questions disappear, reopen a live winner,
   or fail to re-ask.  
   **De-risk:** keep question SQL text outside the permission write scope; run
   the cited unit and real-Postgres reopen/cancel concurrency tests after every
   schema/repository stage; assert question rows have no permission children.

4. **The new schema stores too little durable intent.** The audit's short column
   list omits approver identity, decided time, provider aliases, canonical id,
   settlement, and review-each dispatch state. Recovery would then re-derive
   security-relevant intent from incoming transport data.  
   **De-risk:** map every field of `PermissionRecoveryEnvelope` and
   `PermissionCallbackClaim` to exactly one durable owner before DDL; require a
   restart test that reconstructs the decision solely from persisted rows plus
   canonical incoming locator/approver data.

5. **A3 becomes an accidental second durable-work framework or permits
   duplicate installs.** One index cannot cover the current random ids,
   different tables, and post-approval effects.  
   **De-risk:** defer A3; in the durable-work cycle, define one review-work row
   and claim/fence the execution owner before deleting any Set. Add a
   two-process duplicate command/package test proving one prompt owner and one
   side-effect owner.

## Start gate

The post-#229 code is a valid baseline, but the cycle is **not safe to start
immediately from the audit as written**. First update/approve a goal prompt with
the normalized three-table contract, the full claim-field inventory, the hard
question non-goals, typed resolution outcomes, and A3 deferral. Also respect the
current execution queue: `goals-index.md:22-26` places the durable-work primitive
before this cycle. After those plan corrections and the Stage 1 characterization
tests, there is no identified code-level blocker to implementation.
