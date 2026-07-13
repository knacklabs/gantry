# Phase 2-3 Identity Management Personal Memory Verification

This note records how the local personal-memory verification environment was made testable. It intentionally uses placeholders instead of real tokens, raw user ids, or raw conversation ids.

## Goal

Verify that a person can build personal memory in a one-on-one conversation on one provider, then hydrate the same personal memory from another provider alias.

Expected behavior:

- One-on-one DM: current conversation context plus the sender person's long-term memory.
- Group/channel: current conversation context plus group/channel long-term memory only.
- Sender identity may still be resolved in a channel for audit, but channel turns must not hydrate the sender's personal memory.

## Local Runtime Setup Used

- Runtime home: local Gantry runtime home.
- Storage: local Postgres.
- Provider accounts:
  - Slack provider account with bot token and Socket Mode app token stored through Gantry runtime secret handling.
  - Telegram provider account with bot token stored through Gantry runtime secret handling.
- Slack app requirement:
  - Socket Mode enabled.
  - Event subscriptions enabled for message delivery.
  - App Home messages enabled, including the Slack setting that allows users to send messages from the Messages tab.
- Agent:
  - One default user-facing agent bound to the Slack channel and Telegram DM.
- Local Control API verification key:
  - A local-only Control API key was given the admin/read scopes needed to run the verification API calls.
  - Required scope categories were identity, people, memory, providers, conversations, agents, jobs, messages, and sessions.
  - The key token is not documented.

Do not document or commit actual Slack tokens, Telegram tokens, Control API tokens, Slack user ids, Telegram user ids, or Slack DM/channel ids.

## Alias Setup

The same human is represented by one canonical person id inside the app.

Aliases linked to that person:

- Slack alias: provider user evidence for the Slack provider account.
- Telegram alias: provider user evidence for the Telegram provider account.
- The Telegram JID prefix is `tg`, but the canonical provider registry id is
  `telegram`. Live identity resolution normalizes the prefix before exact alias
  lookup, so API-created aliases use `telegram`.

Verification API behavior:

- `POST /v1/identity/resolve` for Slack resolves to the canonical person.
- `POST /v1/identity/resolve` for Telegram resolves to the same canonical person.
- Alias events are emitted as `identity.alias.linked` or `identity.alias.retired`.
- Resolve events are emitted as `identity.resolved`.
- Runtime events must not include raw external user ids or raw phone/email values.

## Channel Memory Verification

Steps:

1. Send a Slack channel/thread message that teaches a channel preference.
2. Ask the agent in the same channel for the channel preferences.
3. Trigger channel dreaming with `subjectType=channel` and the Slack channel subject.
4. Confirm `memory_items` contains channel-scoped rows only.

Expected evidence:

- `memory_items.subject_type = channel`.
- `memory.hydration.decision.conversationKind = channel`.
- `memory.hydration.decision.memoryHydrationEligible = false`.
- `identity.resolved` may still be emitted for the sender, but personal memory is not hydrated into the channel turn.

## Slack DM Personal Memory Verification

Slack DM automation needed one setup change:

- Before enabling Slack App Home Messages, the Slack MCP could open/read the bot DM but writes failed with `restricted_action_read_only_channel`.
- After enabling Slack App Home Messages, the Slack MCP could send a real user-authored DM to the bot.

The DM must also be known to Gantry:

1. Discover the Slack DM through the Slack provider account discovery route.
2. Install/bind the discovered DM conversation to the default agent.
3. Configure the install with `memoryScope=user` and explicit `memorySubject={ type: "user", id: <canonical-person-id> }`.
4. Send a Slack DM containing a personal preference.
5. Confirm runtime events show a direct/private conversation with personal memory hydration eligible.
6. Trigger dreaming with `subjectType=user`, `subjectId=<canonical-person-id>`, and `userId=<canonical-person-id>`.
7. Confirm `memory_items` contains user-scoped rows for the canonical person.
   In the active flattened memory schema, the persisted `memory_items.subject_id`
   is the normalized hashed memory subject id derived from the canonical person,
   not the raw `person:<id>` string.

Expected evidence:

- `memory_items.subject_type = user`.
- `memory_items.subject_id = subjectIdFor({ appId, agentId, subjectType: "user", subjectId: <canonical-person-id> })`.
- Slack DM `identity.resolved.personId` equals Telegram resolve `personId`.
- A later Telegram DM can hydrate the same user memory.

## Telegram Cross-Provider Recall Verification

After Slack DM dreaming creates user memory:

1. Send a Telegram DM from the linked Telegram account.
2. Ask what personal preference the agent remembers.
3. Confirm the answer uses the Slack-created personal memory.

Expected outcome:

- Telegram identity resolves to the same canonical person as Slack.
- The Telegram DM hydrates `subjectType=user` memory for that person.
- The answer recalls the personal preference created from the Slack DM.

## Local Verification Result

Status from the local run:

- Slack channel memory was verified as channel-scoped.
- Slack DM delivery required enabling Slack App Home Messages.
- The Slack DM was discovered through provider-account discovery.
- The Slack DM was live-bound to the default agent for verification with `memoryScope=user`.
- A Slack DM personal preference was sent and the agent replied in DM.
- Runtime events showed:
  - DM conversation kind.
  - Resolved canonical person id.
  - `memoryHydrationEligible=true`.
- User-scoped dreaming completed.
- `memory_items` contained user-scoped rows for the normalized memory subject
  derived from the canonical person, including:
  - preferred name.
  - preferred identity-test response format.
- Channel-scoped rows remained separate from user-scoped rows.
- The first Telegram recall attempt happened before provider normalization was
  fixed, so Telegram resolved to a newly created person and correctly found no
  saved preferences for that temporary person.
- Provider ids are now normalized before live identity resolution.
- Live People merge preview found no conflicts, and merge apply moved the
  temporary Telegram person's aliases and personal-memory rows to the canonical
  Slack person.
- Fresh Slack and `tg` API resolves now return the same canonical person.
- After a clean build and service restart, a real user-authored Telegram DM
  asked which preferences were remembered from the Slack DM.
- The Telegram reply recalled all three Slack-created personal preferences:
  the work routine, the requested identity-test response format, and the
  preferred name.
- Durable events for that turn recorded `provider=telegram`,
  `evidenceType=provider_user`, `status=resolved`,
  `conversationKind=dm`, `reason=resolved`, and
  `memoryHydrationEligible=true`.
- The persisted identity and hydration events contained neither the raw
  external alias nor the legacy alias-derived person id.

Known caveat:

- Desktop automation could not author the Telegram message because macOS
  accessibility access was unavailable. The human-authored message and the
  persisted inbound/outbound records were used as the presentation evidence;
  no bot-originated or synthetic database message substituted for the user.

## Follow-up Risks Found During Verification

- Local migration timestamp drift can make a rebased development database skip an upstream migration.
- People/OpenAPI route schema drift can crash runtime startup.
- Ad hoc Control API helpers need to parse escaped JSON `.env` values correctly.
- People API examples should clarify response id shape.
- Slack DM verification requires both Slack App Home Messages and a Gantry DM conversation install; Slack channel setup alone is not enough.
- Telegram verification must store the canonical provider id `telegram`; the
  live `tg` JID prefix is normalized before identity lookup.
