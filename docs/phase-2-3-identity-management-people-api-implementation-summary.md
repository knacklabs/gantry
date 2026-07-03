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

The important checks were:

- unit tests for runtime behavior
- repository integration coverage for exact alias matching and retirement
- typecheck

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
