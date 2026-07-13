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

- [person-identity-service.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/application/identity/person-identity-service.ts)
- [person-identity-repository.postgres.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/adapters/storage/postgres/repositories/person-identity-repository.postgres.ts)
- [person-identity-mappers.postgres.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/adapters/storage/postgres/repositories/person-identity-mappers.postgres.ts)
- [0093_person_identity_management.sql](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/adapters/storage/postgres/schema/migrations/0093_person_identity_management.sql)

### 2. Runtime sender identity resolution

The runtime now tries to resolve the sender during live processing.

That means:

- Slack, Teams, Telegram, WhatsApp, and app-channel turns can all try to map
  the sender to a person
- group/channel turns can still resolve sender identity for identity evidence
  and audit
- the runtime only uses sender identity for personal-memory routing in
  direct/private turns, while keeping group/channel memory conversation-scoped

Runtime flow lives in:

- [group-processing.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/runtime/group-processing.ts)
- [group-person-identity.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/runtime/group-person-identity.ts)
- [group-processing-types.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/runtime/group-processing-types.ts)
- [group-processing-options.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/runtime/group-processing-options.ts)

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

- [session-interaction-module.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/application/sessions/session-interaction-module.ts)
- [group-person-identity.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/runtime/group-person-identity.ts)

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

- [people.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/control/server/routes/people.ts)
- [openapi-routes-extended.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/control/server/openapi-routes-extended.ts)
- [openapi.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/control/server/openapi.ts)
- [packages/contracts/src/users/index.ts](/Users/caw-dev/Dev/Agent.Gantry/packages/contracts/src/users/index.ts)

### 6. SDK support

The SDK now exposes people and identity operations so external callers use the
same model as the runtime and control API.

Implemented in:

- [packages/sdk/src/people.ts](/Users/caw-dev/Dev/Agent.Gantry/packages/sdk/src/people.ts)
- [packages/sdk/src/index.ts](/Users/caw-dev/Dev/Agent.Gantry/packages/sdk/src/index.ts)
- [packages/sdk/src/types.ts](/Users/caw-dev/Dev/Agent.Gantry/packages/sdk/src/types.ts)

### 7. Runtime events instead of a new audit table

For identity and hydration evidence, we used runtime events rather than adding a
new dedicated identity audit table.

Events added:

- `identity.resolved`
- `identity.alias.linked`
- `identity.alias.retired`
- `memory.hydration.decision`

Implemented in:

- [identity-runtime-events.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/application/identity/identity-runtime-events.ts)
- [runtime-event-types.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/domain/events/runtime-event-types.ts)

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
   and the identity migration was renumbered to `0093` after the provider
   account cutover migrations.
5. We made public `POST /v1/identity/resolve` safer. A key with only
   `identity:resolve` can perform a minimal, non-mutating lookup. Alias
   creation requires `people:admin`, and rich alias details require
   `people:read` or `people:admin`.
6. We added alias-collision detection to person merge preview/apply. If a
   source person and target person both have the same active alias key, apply
   fails before moving aliases.
7. We removed the unrelated baseline memory MCP tool change from this feature
   scope. This PR keeps the identity-management work separate from any future
   tool-surface cleanup.
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
15. We removed mandatory memory IPC authority from baseline runner projection.
    Baseline personas may still expose selected Gantry MCP tool names through
    the normal capability surface, but the host-signed
    `GANTRY_MEMORY_IPC_ACTIONS_JSON` list is empty unless memory tools are
    explicitly selected. Control approvers can receive only the dedicated
    memory-review IPC actions.

## Where The Changes Landed

Runtime and identity:

- [group-processing.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/runtime/group-processing.ts)
- [group-person-identity.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/runtime/group-person-identity.ts)
- [group-session-command-state.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/runtime/group-session-command-state.ts)
- [person-identity-service.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/application/identity/person-identity-service.ts)
- [person-identity-repository.postgres.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/adapters/storage/postgres/repositories/person-identity-repository.postgres.ts)

API and SDK:

- [people.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/control/server/routes/people.ts)
- [packages/sdk/src/people.ts](/Users/caw-dev/Dev/Agent.Gantry/packages/sdk/src/people.ts)
- [packages/contracts/src/users/index.ts](/Users/caw-dev/Dev/Agent.Gantry/packages/contracts/src/users/index.ts)

Docs:

- [identity-management.md](/Users/caw-dev/Dev/Agent.Gantry/docs/architecture/identity-management.md)
- [MEMORY.md](/Users/caw-dev/Dev/Agent.Gantry/docs/MEMORY.md)
- [SPEC.md](/Users/caw-dev/Dev/Agent.Gantry/docs/SPEC.md)

Settings projection and route normalization:

- [desired-state-provider-conversations.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/config/settings/desired-state-provider-conversations.ts)
- [runtime-settings-parser.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/config/settings/runtime-settings-parser.ts)
- [runtime-settings.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/config/settings/runtime-settings.ts)
- [channel-persistence-handlers.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/app/bootstrap/channel-persistence-handlers.ts)

Runtime events and audit routing:

- [runtime-event-conversation.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/domain/events/runtime-event-conversation.ts)
- [identity-runtime-events.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/application/identity/identity-runtime-events.ts)
- [runtime-event-exchange.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/application/runtime-events/runtime-event-exchange.ts)
- [runtime-event-forwarding.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/runtime/runtime-event-forwarding.ts)
- [agent-spawn-startup-diagnostic.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/runtime/agent-spawn-startup-diagnostic.ts)
- [agent-spawn-process-diagnostic.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/runtime/agent-spawn-process-diagnostic.ts)
- [runner-startup-diagnostic.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/adapters/llm/anthropic-claude-agent/runner/runner-startup-diagnostic.ts)
- [startup-diagnostic.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/adapters/llm/deepagents-langchain/runner/startup-diagnostic.ts)
- [gantry-model-gateway.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway.ts)

People merge and SDK typing:

- [person-identity-merge-conflicts.postgres.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/adapters/storage/postgres/repositories/person-identity-merge-conflicts.postgres.ts)
- [packages/sdk/src/people.ts](/Users/caw-dev/Dev/Agent.Gantry/packages/sdk/src/people.ts)

Runner memory IPC authority:

- [memory-ipc-actions.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/src/shared/memory-ipc-actions.ts)
- [agent-capabilities.test.ts](/Users/caw-dev/Dev/Agent.Gantry/apps/core/test/unit/runner/agent-capabilities.test.ts)

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

## Surface Impact Matrix

| Surface | Impact | Reason |
|---|---|---|
| Runtime behavior | Changed | Direct/private conversations hydrate current conversation memory plus resolved personal memory. Group/channel conversations hydrate current conversation memory plus group/channel long-term memory, not sender personal memory. Sender identity may still be resolved for evidence. |
| `settings.yaml` | Read-only/observable | No new settings shape was added. Existing readable provider conversation ids are normalized more correctly when projected into runtime routes and allowlists. |
| Postgres/runtime projection | Changed | Identity tables, aliases, merge audit, settings route projection, and runtime-event route-context persistence are part of the feature. Raw provider route ids are no longer written as runtime-event FK columns. |
| Control API | Changed | People and identity routes expose resolve, list, inspect, alias add/retire, and merge preview/apply while preserving the existing identity resolve wire shape. |
| SDK/contracts | Changed | Contracts define People/Identity request and response shapes, and the SDK exposes typed People/Identity clients backed by those contracts. |
| CLI | Unchanged by design | No operator command was needed for the identity graph itself; setup fixes observed on `main` were kept out of this feature scope. |
| Gantry MCP tools/admin skill | Unchanged by design | This feature changes host-owned identity, hydration, and People API behavior. It does not add or remove agent-facing MCP tools. |
| Channel/provider adapters | Changed | Live channel ingress now carries sender evidence and provider-account metadata consistently enough for sender resolution and route projection. Slack route normalization was corrected after smoke testing. |
| Docs/prompts | Changed | Identity architecture and this implementation summary document the room/person memory boundary and the review corrections. Agent-facing prompt behavior is unchanged. |
| Audit/events | Changed | Identity resolution, alias admin actions, hydration decisions, startup diagnostics, runtime forwarding, and model-gateway audit events avoid raw provider ids in FK columns and keep provider route context in payload fields. |
| Tests/verification | Changed | Unit, integration, and smoke coverage were expanded around identity resolution, group-vs-DM memory policy, provider-account alias lookup, Slack route projection, event persistence safety, and SDK typing. |

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
