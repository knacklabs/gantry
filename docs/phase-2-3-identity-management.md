# Phase 2-3 Identity Management And People API Implementation Summary

This document explains, in simple terms, what we built for the Phase 2 and
Phase 3 identity-management work, what changed in the codebase, and why those
changes matter.

## Short Version

We taught Gantry to understand two different things at the same time:

- `where` a message happened
- `who` sent it

That sounds small, but it changes the runtime model in a major way.

Before this work, the runtime could treat sender identity too loosely or too
late. After this work:

- every live turn can try to resolve the sender to a canonical `personId`
- conversation memory stays tied to the channel or thread
- personal memory stays tied to the actual human sender in direct/private
  conversations
- the People API can inspect and manage that identity graph directly
- the SDK can use the same identity model as the runtime

The main goal was to make identity consistent across runtime, API, storage, and
audit evidence.

## Plain-English Model

Think of a Slack channel, Telegram group, Teams channel, or app conversation as
the room.

Think of the sender as the person speaking in that room.

Gantry now keeps both pieces separately:

- `conversation memory` is memory about the room
- `personal memory` is memory about the person in one-on-one conversations

Example:

- Channel: `#support`
- Sender: Alice
- Conversation memory: "this is the support channel"
- Personal memory: "Alice prefers short answers"

The room memory should stay with the room. The person memory should stay with
the person. That is the boundary this work enforces.

## What We Built

### 1. Canonical people and aliases

We introduced a canonical identity model where `personId` is the stable human
identity inside one app.

Important rules:

- provider sender ids are aliases, not the person itself
- email, phone, and web SDK ids are also aliases
- alias lookup is exact-match only
- `providerAccountId` is part of the alias key when it exists

Storage and policy are implemented in:

- [person-identity-service.ts](../apps/core/src/application/identity/person-identity-service.ts)
- [person-identity-repository.postgres.ts](../apps/core/src/adapters/storage/postgres/repositories/person-identity-repository.postgres.ts)
- [person-identity-mappers.postgres.ts](../apps/core/src/adapters/storage/postgres/repositories/person-identity-mappers.postgres.ts)
- [0102_person_identity_management.sql](../apps/core/src/adapters/storage/postgres/schema/migrations/0102_person_identity_management.sql)
- [0103_drop_legacy_user_alias_unique_index.sql](../apps/core/src/adapters/storage/postgres/schema/migrations/0103_drop_legacy_user_alias_unique_index.sql)
- [0104_people_identity_query_indexes.sql](../apps/core/src/adapters/storage/postgres/schema/migrations/0104_people_identity_query_indexes.sql)

### 2. Runtime sender identity resolution

The runtime now tries to resolve the sender during live processing.

That means:

- current Slack, Teams, Telegram, and app-channel turns can try to map the
  sender to a person
- group/channel turns can still resolve sender identity for identity evidence
  and audit
- the runtime only uses sender identity for personal-memory routing in
  direct/private turns, while keeping group/channel memory conversation-scoped

Runtime flow lives in:

- [group-processing.ts](../apps/core/src/runtime/group-processing.ts)
- [group-person-identity.ts](../apps/core/src/runtime/group-person-identity.ts)
- [group-processing-types.ts](../apps/core/src/runtime/group-processing-types.ts)
- [group-processing-options.ts](../apps/core/src/runtime/group-processing-options.ts)

### 3. Live turns, conversation memory, and personal memory

A `live turn` is one active pass of Gantry processing new messages.

During a live turn:

- Gantry reads the pending messages
- it checks the sender
- it may resolve the sender to a person for identity evidence
- it loads conversation memory
- for direct/private turns, it loads personal memory only when the sender
  resolves cleanly
- for group/channel turns, it keeps long-term memory conversation scoped and
  does not add the sender's personal memory

The important boundary is this:

- conversation memory stays conversation-scoped
- personal memory stays direct-message scoped
- group/channel sender identity is not used to append personal memory
- unresolved sender identity does not rewrite the conversation into a person

### 4. SDK app-channel sender handling

SDK turns were given a clear split:

- explicit `senderId` becomes `web_user` identity evidence
- omitted `senderId` keeps the internal `sdk` sentinel
- anonymous/system SDK turns do not create people

This behavior is implemented in the session/runtime path and the identity
resolver:

- [session-interaction-module.ts](../apps/core/src/application/sessions/session-interaction-module.ts)
- [group-person-identity.ts](../apps/core/src/runtime/group-person-identity.ts)

### 5. People API

We added a control surface for people and aliases so admins and tools can work
with the identity graph directly.

Routes include:

- resolve identity
- list people
- inspect a person
- add alias
- retire alias
- preview merge
- apply merge

Implemented in:

- [people.ts](../apps/core/src/control/server/routes/people.ts)
- [openapi-routes-extended.ts](../apps/core/src/control/server/openapi-routes-extended.ts)
- [openapi.ts](../apps/core/src/control/server/openapi.ts)
- [packages/contracts/src/users/index.ts](../packages/contracts/src/users/index.ts)

### 6. SDK support

The SDK now exposes people and identity operations so external callers use the
same model as the runtime and control API.

Implemented in:

- [packages/sdk/src/people.ts](../packages/sdk/src/people.ts)
- [packages/sdk/src/index.ts](../packages/sdk/src/index.ts)
- [packages/sdk/src/types.ts](../packages/sdk/src/types.ts)

### 7. Runtime events instead of a new audit table

For identity and hydration evidence, we used runtime events rather than adding a
new dedicated identity audit table.

Events added:

- `identity.resolved`
- `identity.alias.linked`
- `identity.alias.retired`
- `memory.hydration.decision`

Implemented in:

- [identity-runtime-events.ts](../apps/core/src/application/identity/identity-runtime-events.ts)
- [runtime-event-types.ts](../apps/core/src/domain/events/runtime-event-types.ts)

## Why These Decisions Matter

### Provider account

`providerAccountId` is the specific installed provider account or workspace
connection.

Example:

- one Slack workspace installation
- another Slack workspace installation

The same sender id in two different installations should not be treated as the
same alias unless the full key matches. That is why the alias lookup includes
`providerAccountId` when it exists.

### Group/channel memory vs personal memory

This separation is the heart of the change.

If Gantry sees a message in a Slack channel:

- the channel memory should remain about the channel
- the sender identity should be resolved separately
- the sender's personal memory should not be added to the group/channel memory
  path

That prevents accidental re-keying of the whole conversation through one person.

### Retired aliases

We decided that retired aliases are not active identities for runtime hydration.

That means:

- runtime resolution does not automatically revive retired aliases
- administrators can intentionally re-link the same alias row
- schema, repository behavior, and tests all follow that rule

## Corrections We Made After Review

These were important follow-up decisions that became part of the final result:

1. We kept group/channel sender identity resolution available for identity
   evidence, but removed sender-personal-memory hydration from that path.
2. We removed the DM raw-sender fallback so direct messages do not mix provider
   alias ids into personal long-term memory when resolver infrastructure fails.
3. We aligned the schema and repository semantics around retired aliases so the
   final behavior is consistent, not accidental.
4. We aligned the feature with the current provider-account model from `main`.
   The active code and API now use `providerAccountId` / `provider_account_id`,
   and the final identity migrations follow the provider-account cutover
   migrations without reusing an upstream migration sequence number.
5. We made public `POST /v1/identity/resolve` safer. A key with only
   `identity:resolve` can perform a minimal, non-mutating lookup. Alias
   creation requires `people:admin`, and rich alias details require
   `people:read` or `people:admin`.
6. We added alias-collision detection to person merge preview/apply. If a
   source person and target person both have the same active alias key, apply
   fails before moving aliases.
7. We retained the narrowly related memory IPC correction found by live Slack
   verification. Baseline memory tools already visible to the runner must be
   authorized by the host-signed IPC token; this does not grant any new
   authority-changing memory capability.
8. We fixed a Slack route-projection mismatch found during local setup
   verification. Readable settings IDs such as `slack:C123` now normalize to
   the inbound runtime JID `sl:C123`, so messages delivered by Slack Socket Mode
   can match the configured conversation route. This is a settings projection
   fix, not a memory-policy change.
9. We fixed runtime-event FK misuse found during Slack smoke testing. Slack
   route ids such as `sl:C123` and provider thread timestamps are useful
   audit context, but they are not canonical `conversations.id` or
   `conversation_threads.id` values. Identity, hydration, runner startup, and
   model-gateway audit events now keep raw provider route context in payload
   fields such as `conversationJid` and `threadId`; top-level
   `conversationId` / `threadId` fields are used only when the producer already
   has canonical FK ids.
10. We added a runtime-event exchange guard so direct event publishers cannot
    accidentally persist raw Slack/Telegram/Teams route ids as database foreign
    keys. Raw provider route ids are moved into payload route-context fields
    before persistence.
11. We fixed sender-policy and control-approver lookup for readable Slack
    conversation ids. Settings may contain readable ids such as `slack:C123`,
    but inbound Slack events arrive as `sl:C123`; both now normalize to the
    same runtime JID before allowlist checks.
12. We fixed provider-account conversation memory subject drift. Canonical
    route ids such as `conversation:slack_default:sl:C123` now hydrate the same
    channel memory subject as live Slack turns, `conversation:sl:C123`, instead
    of creating a second long-term memory bucket for the same channel.
13. We removed raw alias values from person-merge conflict keys. Merge conflict
    evidence now uses source/target alias ids, not Slack user ids, phone
    numbers, web-user ids, or email-like alias values.
14. We tightened SDK People/Identity response types to use the shared contract
    response shapes. This avoids a weakly typed SDK surface drifting away from
    the server API.
15. We aligned the host-signed memory IPC actions with the baseline memory
    tools already visible to the runner. This fixes turns where a visible
    baseline tool such as `memory_save` failed only because the host token did
    not authorize the matching action. Authority-changing memory tools remain
    capability-gated, and locked runners exclude them even if stale tool rules
    request them.
16. We normalized provider ids before live identity resolution. Provider JID
    prefixes such as `tg` and `sl` are routing syntax; canonical identity alias
    keys use provider registry ids such as `telegram` and `slack`. This prevents
    one human from being split into separate people because ingress and admin
    API calls used different names for the same provider.
17. We made conversation installation fail before live route registration when
    desired-state synchronization fails. A failed install can no longer leave a
    route active only until restart.
18. We changed identity repository writes to lock exact alias keys and merge
    participants transactionally. Concurrent alias links cannot silently move
    an alias to a different person, and concurrent merges cannot apply from a
    stale preview.
19. We removed the legacy display-name uniqueness rule. Display names are not
    identities, so two people in one app may have the same name.
20. We bounded People listing with opaque cursor pagination: 50 people by
    default and at most 200 per request. Page hydration uses fixed batch queries
    for people, aliases, and memory counts instead of issuing queries per person.
21. We canonicalize provider ids at the People API boundary as well as live
    ingress. Admin input such as `tg` or `sl` is stored as `telegram` or
    `slack`, so an API-created alias cannot become invisible to the runtime.
22. We made explicit alias review meaningful. Adding an alias that already
    belongs to the same person promotes an unverified alias to verified and
    replaces its evidence; it never silently moves an alias between people.
23. We made malformed percent-encoded People paths return a controlled
    `400 INVALID_REQUEST` instead of escaping route handling as an internal
    server error.
24. We added indexes for People cursor order, batched alias lookup, and active
    personal-memory lookup/conflict detection, and retired exact-alias lookup.
    Disposable Postgres EXPLAIN tests verify that the intended indexes are
    selected.
25. We moved first-progress notification ahead of durable identity event writes.
    Identity evidence remains durable, but it does not delay the channel's
    initial acknowledgement of a live turn.
26. Telegram text and media ingress now carry the active provider account id
    into canonical message persistence, matching Slack and runtime identity
    lookup behavior.
27. Active DM `/new` now resolves the sender to the canonical person before it
    captures and clears session state. Group/channel `/new` remains
    conversation-scoped and carries no personal memory subject.
28. We bounded merge detail materialization at 1,000 aliases or conflicts. The
    set-based memory and alias moves may still process the full person, but an
    admin request cannot hold locks while building an unbounded response or
    audit JSON payload.
29. Missing people and aliases keep the existing non-disclosing
    `Person is not accessible to this app.` error. Route tests prove those paths
    return the controlled error before any alias event is published, so the
    non-null OpenAPI and SDK success shapes remain truthful.
30. SDK sessions are app-channel ingress, not a private/DM conversation mode.
    An explicit `senderId` creates `web_user` identity evidence but does not add
    personal memory to that app-channel turn; omitted senders remain the `sdk`
    system sentinel.
31. `sessions:write` is trusted identity ingress authority for its own app. As
    with authenticated Slack or Telegram ingress, a real explicit sender may
    create an unverified person/alias as a side effect of a turn. `people:admin`
    remains required for verified alias linking, retirement, and merges; this
    is not a bypass of verified People administration.

## Where The Changes Landed

Runtime and identity:

- [group-processing.ts](../apps/core/src/runtime/group-processing.ts)
- [group-person-identity.ts](../apps/core/src/runtime/group-person-identity.ts)
- [group-session-command-state.ts](../apps/core/src/runtime/group-session-command-state.ts)
- [person-identity-service.ts](../apps/core/src/application/identity/person-identity-service.ts)
- [person-identity-repository.postgres.ts](../apps/core/src/adapters/storage/postgres/repositories/person-identity-repository.postgres.ts)

API and SDK:

- [people.ts](../apps/core/src/control/server/routes/people.ts)
- [packages/sdk/src/people.ts](../packages/sdk/src/people.ts)
- [packages/contracts/src/users/index.ts](../packages/contracts/src/users/index.ts)

Docs:

- This file is the canonical identity architecture, implementation, decision,
  and verification record.
- [MEMORY.md](MEMORY.md)
- [SPEC.md](SPEC.md)

Settings projection and route normalization:

- [desired-state-provider-conversations.ts](../apps/core/src/config/settings/desired-state-provider-conversations.ts)
- [runtime-settings-parser.ts](../apps/core/src/config/settings/runtime-settings-parser.ts)
- [runtime-settings.ts](../apps/core/src/config/settings/runtime-settings.ts)
- [channel-persistence-handlers.ts](../apps/core/src/app/bootstrap/channel-persistence-handlers.ts)

Runtime events and audit routing:

- [runtime-event-conversation.ts](../apps/core/src/domain/events/runtime-event-conversation.ts)
- [identity-runtime-events.ts](../apps/core/src/application/identity/identity-runtime-events.ts)
- [runtime-event-exchange.ts](../apps/core/src/application/runtime-events/runtime-event-exchange.ts)
- [runtime-event-forwarding.ts](../apps/core/src/runtime/runtime-event-forwarding.ts)
- [agent-spawn-startup-diagnostic.ts](../apps/core/src/runtime/agent-spawn-startup-diagnostic.ts)
- [agent-spawn-process-diagnostic.ts](../apps/core/src/runtime/agent-spawn-process-diagnostic.ts)
- [runner-startup-diagnostic.ts](../apps/core/src/adapters/llm/anthropic-claude-agent/runner/runner-startup-diagnostic.ts)
- [startup-diagnostic.ts](../apps/core/src/adapters/llm/deepagents-langchain/runner/startup-diagnostic.ts)
- [gantry-model-gateway.ts](../apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway.ts)

People merge and SDK typing:

- [person-identity-merge-conflicts.postgres.ts](../apps/core/src/adapters/storage/postgres/repositories/person-identity-merge-conflicts.postgres.ts)
- [packages/sdk/src/people.ts](../packages/sdk/src/people.ts)

Runner memory IPC authority:

- [memory-ipc-actions.ts](../apps/core/src/shared/memory-ipc-actions.ts)
- [agent-capabilities.test.ts](../apps/core/test/unit/runner/agent-capabilities.test.ts)

## Examples

### Slack channel example

Alice posts in `#support`.

What Gantry does:

- uses `#support` as the conversation scope
- resolves Alice as the sender
- loads `#support` memory
- does not add Alice's personal memory to the channel-memory path

### Telegram group example

Someone posts in a Telegram group.

What Gantry does:

- keeps the group as conversation memory
- keeps long-term memory scoped to the group/thread/topic
- does not append sender personal memory to that group-memory path

### SDK app example

A web app sends a message with an explicit `senderId`.

What Gantry does:

- treats it as `web_user` evidence
- resolves or creates the corresponding person

If the app does not provide a sender id:

- Gantry treats it as the internal `sdk` sentinel
- no person is created

## Verification

Focused verification was added for:

- runtime sender identity resolution
- trigger-gated runtime behavior
- people API behavior
- alias retirement and re-link behavior
- route normalization for Slack settings ids
- runtime-event FK safety
- channel memory subject normalization
- SDK People/Identity response typing

The important checks were:

- unit tests for runtime behavior
- repository integration coverage for exact alias matching and retirement
- typecheck

### 2026-07-13 Slack/API Verification Corrections

Manual Slack and Control API verification found two implementation support bugs
that did not change the product decision about memory scope:

- Telegram was attached to the same person as Slack through the People alias
  API, then resolved through `POST /v1/identity/resolve`. That proved the public
  API path works, but it also exposed a stale legacy unique index on
  `user_aliases`. Retired aliases were supposed to free the exact
  provider/account/external-id tuple for re-linking, but the old non-partial
  index still blocked that. The fix adds a migration that drops the old index
  and keeps the active partial unique index as the only alias uniqueness rule.
- Slack channel smoke testing showed the runner could see baseline memory tools
  such as `memory_save`, while the host memory IPC token allowed only a smaller
  action set. The agent then failed with `Memory IPC action is not allowed:
memory_save`. The fix makes the shared memory IPC selector include the same
  baseline memory actions as the visible Gantry MCP tool surface, while keeping
  review/admin memory actions gated.

Decision kept: group/channel turns may resolve sender identity for audit and
alias evidence, but they do not hydrate or write sender personal memory. Group
conversations use conversation/group memory; one-on-one conversations use the
resolved person's personal memory.

Commands run during this review cycle:

```bash
npm run test:unit -- apps/core/test/unit/platform/sender-allowlist.test.ts apps/core/test/unit/memory/app-memory-session-hydration.test.ts apps/core/test/unit/application/runtime-events/runtime-event-exchange.test.ts apps/core/test/unit/runtime/runtime-event-forwarding.test.ts apps/core/test/unit/config/runtime-settings.test.ts apps/core/test/unit/config/settings-desired-state-service.test.ts apps/core/test/unit/bootstrap/channel-wiring.test.ts apps/core/test/unit/runtime/group-person-identity.test.ts
npm run test:unit -- apps/core/test/unit/platform/sender-allowlist.test.ts apps/core/test/unit/memory/app-memory-session-hydration.test.ts apps/core/test/unit/application/runtime-events/runtime-event-exchange.test.ts apps/core/test/unit/runtime/runtime-event-forwarding.test.ts apps/core/test/unit/config/runtime-settings.test.ts apps/core/test/unit/config/settings-desired-state-service.test.ts apps/core/test/unit/bootstrap/channel-wiring.test.ts apps/core/test/unit/runtime/group-person-identity.test.ts apps/core/test/unit/control/people-routes.test.ts apps/core/test/unit/core/gantry-model-gateway.test.ts apps/core/test/unit/runtime/agent-spawn-startup-diagnostic.test.ts apps/core/test/unit/runtime/agent-spawn-process.test.ts apps/core/test/unit/runtime/agent-spawn.test.ts apps/core/test/unit/adapters/deepagents-startup-diagnostic.test.ts apps/core/test/unit/runner/agent-capabilities.test.ts
npm run typecheck
npm run build
npm link
python3 .codex/scripts/check_task_completion.py
node .codex/scripts/run_postgres_integration_with_url.mjs postgres://localhost/gantry_identity_test_20260713 run -c vitest.integration.config.ts --no-file-parallelism apps/core/test/integration/postgres-domain-repositories.integration.test.ts
```

Observed results:

- focused unit suite passed with 15 files and 472 tests
- `typecheck` passed
- `build` passed
- architecture completion check passed
- focused Postgres repository integration passed with 1 file and 28 tests
- temporary local database `gantry_identity_test_20260713` was created for the
  focused Postgres check and dropped after the run
- `check_task_completion.py` still reports a warning that repository/schema
  files changed without detected repository/storage/schema tests, but the
  focused Postgres repository test above was run manually with the checked-in
  URL wrapper and passed

### Final ship gate

The complete post-hardening state was checked again, not accepted from the
earlier partial results above:

- `npm run typecheck`, `npm run format:check`, lint with zero errors, generated
  SDK verification, and the architecture checker passed
- `npm test` passed 493 unit files with 5,687 tests and 9 active integration
  files with 64 tests
- the checked-in disposable-Postgres gate passed 17 files with 102 tests and
  one intentional skip
- the explicit identity repository suite passed 35 tests on a fresh disposable
  database, including exact alias races, duplicate display names, merge
  behavior, pagination, migration `0100`, and query-plan assertions
- `npm run build`, package-content checks, runtime-image checks, CycloneDX SBOM
  generation, the production dependency audit, and the full dependency audit
  passed; the dependency audit reported zero vulnerabilities
- the disposable Postgres container was removed after verification

The final contract review also found that alias-add and merge requests exposed
optional `appId` through the API and SDK while omitting it from the shared Zod
contracts. The shared contracts now own that selector and focused tests prove
parsing retains it, preventing an explicit app selection from silently falling
back to the API key's default app.

Live merge verification then found migration drift: merge audit reads and
writes include `result_json`, but the original identity migration omitted that
column. Additive migration `0105_person_merge_audit_result.sql` repairs both
fresh and already-applied migration chains. A migration-contract test now
guards the schema/repository requirement before runtime verification.

Event inspection also found that older person ids could embed a raw provider
alias even though event payloads omitted `externalUserId`. Identity-resolution
and hydration events now omit only that legacy alias-derived id shape; opaque
current person ids remain observable, and internal personal-memory routing
still receives the complete canonical id.

The final live presentation gate also passed. After canonical alias merge, a
clean build, and service restart, a real user-authored Telegram DM recalled all
three personal preferences created from the Slack DM. Persisted events for the
turn recorded successful Telegram identity resolution and eligible DM
personal-memory hydration without storing the raw external alias, memory
contents, or the legacy alias-derived person id. This verifies the complete
Slack DM -> canonical person -> personal memory -> Telegram DM path through
real provider ingress and egress.

The final cleanup also closed the write side of the memory boundary. Agents can
no longer select `user`, `group`, or `global` on `memory_save` or
`procedure_save`: a DM writes its trusted person scope and a group/channel
writes its trusted conversation scope. The host independently rejects a forged
cross-scope IPC request, so this rule is not prompt-only enforcement.

## Decision And Follow-up Ledger

This ledger records the implementation decisions and issues encountered while
rebasing, testing, and verifying the feature. “Resolved” means the code or
verification process was corrected. “Documented” means the behavior is known
and intentionally outside this feature's source scope.

1. **Migration timestamp collision:** rebasing exposed a local migration
   timestamp collision; identity migrations use unique sequence numbers.
2. **People OpenAPI schemas:** startup requires route schemas; People schemas
   were added and tested.
3. **Escaped local API-key JSON:** verification helpers parse the runtime's
   escaped JSON representation instead of assuming a raw array.
4. **People response id shapes:** verification accepts the supported response
   envelope instead of assuming one legacy identifier shape.
5. **Slack DM testing:** provider MCP limitations were separated from runtime
   behavior; direct live-turn verification used the configured DM route.
6. **Control API scope updates:** local credential/config updates preserve the
   escaped JSON format and do not print secrets.
7. **Conversation install atomicity:** failed desired-state synchronization must
   not leave a live route registered; the underlying error remains a control
   plane follow-up.
8. **Runtime event foreign keys:** provider route ids are payload context, not
   canonical conversation foreign keys.
9. **Telegram persistence metadata:** Telegram canonical messages carry the
   active provider-account id like other channel adapters.
10. **Provider id normalization:** routing prefixes such as `sl` and `tg` are
    normalized to registry ids `slack` and `telegram` for identity keys.
11. **Development dependency audit:** vulnerable build-tool pins were updated;
    final dependency verification reported no vulnerabilities.
12. **People list scaling:** listing is cursor-paginated and uses batch hydration,
    not an unbounded N+1 query pattern.
13. **Admin provider ids:** alias administration canonicalizes provider ids at
    the API boundary.
14. **Alias re-linking:** re-adding an alias for the same person verifies it and
    replaces evidence; it does not silently move aliases between people.
15. **People path safety:** malformed encoded paths return controlled `400`
    errors.
16. **Live-turn latency:** first progress acknowledgement is sent before
    non-critical identity event persistence.
17. **DM reset scope:** direct-message `/new` resolves the canonical person;
    group/channel reset remains conversation-scoped.
18. **Retired aliases:** retired aliases do not hydrate memory and require
    intentional administrative re-linking.
19. **Merge safety:** merge preview/apply detects alias collisions and performs
    participant changes transactionally.
20. **Merge detail bounds:** merge response and audit materialization are bounded
    even when the underlying set-based operation handles more records.
21. **Display names:** display names are not identities and are not unique.
22. **Non-disclosing People errors:** inaccessible people and aliases retain the
    controlled non-disclosing error response.
23. **SDK sender authority:** an explicit SDK `senderId` is `web_user` evidence;
    omitted sender ids remain the `sdk` system sentinel.
24. **SDK channel memory:** SDK app-channel turns do not hydrate sender personal
    memory; they remain conversation-scoped.
25. **Memory IPC authority:** baseline visible memory actions are authorized by
    host-signed IPC tokens, while authority-changing actions stay gated.
26. **Group sender identity:** group/channel senders may resolve for evidence and
    audit, but their personal memory is never appended to group memory.
27. **DM personal boundary:** direct/private turns use current conversation
    memory plus resolved personal memory only.
28. **Provider-account alias key:** exact alias identity is scoped by app,
    provider, optional provider account, and external user id.
29. **No fuzzy matching:** display names, raw phone/email similarity, and fuzzy
    provider matching are not used for identity resolution.
30. **Runtime events:** identity and hydration evidence use runtime events rather
    than a separate identity audit table; raw alias values and memory contents
    are excluded.
31. **Migration `0100`:** merge-audit result persistence is covered by an
    additive migration and migration-contract tests.
32. **Legacy person ids:** legacy alias-derived identifiers are not exposed in
    identity/hydration event payloads; current opaque person ids remain valid
    internal identifiers.
33. **Fresh database extensions:** disposable or fresh Postgres databases must
    install `vector` and `pg_trgm` before setup and migrations.
34. **Credential preservation:** runtime secrets remain in Credential Center or
    the protected runtime secret lane; no secret is stored in this document or
    source control.
35. **Slack DM install error:** a generic control-plane `500` is not treated as
    success; route persistence must be verified after restart.
36. **Partial setup repair:** stale duplicate route projection was removed during
    local verification and the canonical DM route was rebuilt; this was runtime
    data repair, not a feature-policy change.
37. **Manual memory versus dreaming:** explicit `memory_save` writes active
    memory immediately and records provenance evidence. Dreaming skips that
    evidence unless it contains validated structured candidate metadata.
38. **Storage-key verification:** memory items use deterministic hashed storage
    subject ids, while resolver/evidence records use canonical person subjects.
    Verification must compare through the trusted person boundary, not by
    treating the hashed storage key as the person id.

## Operational Notes

- The feature does not change guided setup, provider model selection, or CLI
  setup UX. Setup and local database bootstrap issues observed during testing
  are recorded above but remain separate from identity behavior.
- A person can be created through `POST /v1/identity/resolve` with
  `createIfMissing: true` and administrative authority. An alias for an existing
  person is added through `POST /v1/people/{personId}/aliases`.
- Dreaming is triggered through `POST /v1/memory/dreaming/trigger` with a
  trusted user subject. A zero-promotion run is expected when explicit
  `memory_save` writes already created active items.
- For runtime verification, build this checkout before restarting Gantry, run
  `gantry status` and `gantry doctor`, and use a disposable Postgres database
  for integration checks.
- The final cross-provider test requires: create personal preferences in a
  Slack DM, resolve the Telegram alias to the same person, send a Telegram DM,
  and verify both the response and durable identity/hydration runtime events.

## Surface Impact Matrix

| Surface                      | Impact               | Reason                                                                                                                                                                                                                                                                               |
| ---------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime behavior             | Changed              | Direct/private conversations hydrate current conversation memory plus resolved personal memory. Group/channel conversations hydrate current conversation memory plus group/channel long-term memory, not sender personal memory. Sender identity may still be resolved for evidence. |
| `settings.yaml`              | Read-only/observable | No new settings shape was added. Existing readable provider conversation ids are normalized more correctly when projected into runtime routes and allowlists.                                                                                                                        |
| Postgres/runtime projection  | Changed              | Identity tables, aliases, merge audit, settings route projection, and runtime-event route-context persistence are part of the feature. Raw provider route ids are no longer written as runtime-event FK columns.                                                                     |
| Control API                  | Changed              | People and identity routes expose resolve, list, inspect, alias add/retire, and merge preview/apply while preserving the existing identity resolve wire shape.                                                                                                                       |
| SDK/contracts                | Changed              | Contracts define People/Identity request and response shapes, and the SDK exposes typed People/Identity clients backed by those contracts.                                                                                                                                           |
| CLI                          | Unchanged by design  | No operator command was needed for the identity graph itself; setup fixes observed on `main` were kept out of this feature scope.                                                                                                                                                    |
| Gantry MCP tools/admin skill | Changed              | No tool names were added or removed. Host-signed memory IPC actions were aligned with visible baseline memory tools, while authority-changing actions remain capability-gated and are removed from locked projections.                                                               |
| Channel/provider adapters    | Changed              | Live channel ingress now carries sender evidence and provider-account metadata consistently enough for sender resolution and route projection. Slack route normalization was corrected after smoke testing.                                                                          |
| Docs/prompts                 | Changed              | Identity architecture and this implementation summary document the room/person memory boundary and the review corrections. Agent-facing prompt behavior is unchanged.                                                                                                                |
| Audit/events                 | Changed              | Identity resolution, alias admin actions, hydration decisions, startup diagnostics, runtime forwarding, and model-gateway audit events avoid raw provider ids in FK columns and keep provider route context in payload fields.                                                       |
| Tests/verification           | Changed              | Unit, integration, and smoke coverage were expanded around identity resolution, group-vs-DM memory policy, provider-account alias lookup, Slack route projection, event persistence safety, and SDK typing.                                                                          |

## Post-Approval Hardening Decisions

The moderator review identified seven release-blocking concerns. These were
implemented as bounded follow-up changes rather than changing the approved
DM/group memory policy:

1. **Authenticated app through memory IPC:** the host now includes `appId` in
   the signed memory IPC token and parsed trusted context. Every memory search,
   save, patch, review, and procedure operation uses that context. Missing app
   context is rejected; the default app is no longer a memory IPC fallback.
2. **Collision-resistant participants:** participant ids now hash the exact
   tuple `appId`, conversation id, provider, provider connection id, and
   external user id. PostgreSQL also enforces uniqueness over that tuple, with
   external user ids required for participant rows.
3. **Atomic identity audit evidence:** newly created identities and alias
   link/retire mutations write their runtime event in the same transaction as
   the identity mutation through the existing event outbox. Existing live-turn
   event publication remains best-effort so an audit transport failure cannot
   turn a successful live resolve into a failed turn.
4. **Database app isolation:** `users` has a composite `(app_id, id)` identity
   and aliases reference it with a composite foreign key. Application checks
   remain in place as an additional boundary.
5. **Public person id cutover:** public memory contracts, OpenAPI schemas, SDK
   types, generated SDK types, routes, and examples expose `personId`, not the
   legacy public `userId`. Internal database columns and runtime actor fields
   remain unchanged where they are implementation details.
6. **Application-owned identity policy:** alias ownership, inactive-person
   rules, retired-alias rebinding, merge conflict rules, and merge detail
   limits now live in the application identity policy module. The PostgreSQL
   repository retains query, lock, mapping, and transaction responsibilities.
7. **Bounded landing:** these hardening changes are limited to app-scoped
   memory IPC, participant identity constraints, identity transaction/outbox
   behavior, public memory contracts, and identity policy ownership. Existing
   Slack routing, gateway audit, diagnostics, and baseline IPC repairs remain
   separate historical commits and are not expanded here.

These decisions preserve the core product contract: DMs hydrate conversation
memory plus the resolved person's personal memory; groups and channels hydrate
conversation/group memory only, even though sender identity may still be
resolved for evidence and future identity administration.

## Verification After Hardening

- `npm run typecheck` passes.
- `npm run format:check` passes.
- SDK generated OpenAPI types are current.
- Focused IPC, identity API, agent-spawn, memory-scope, and People API tests
  pass: 149 tests.
- `npm run build` completes the runtime, contracts, SDK, and migration build.
  The optional Next.js example workspace remains blocked by its pre-existing
  missing `react` and `next` dependencies.

## Bottom Line

This work makes Gantry's identity model explicit:

- person identity is canonical
- sender aliases are exact and scoped
- conversation memory and personal memory stay separate
- DMs use personal memory and groups use conversation memory
- the People API and SDK match the runtime behavior

If you read only one sentence: Gantry now remembers the room separately from the
person, and only one-on-one conversations use the person's personal long-term
memory.
