# Finish the Agent E2E reliability gate

## Problem

The public Control API session ID is not the same as the runtime agent-session
ID. As a result, a streamed reply can be visible before it is durable in the
messages API, session runs can appear empty, and runtime lifecycle events can
be omitted from the session event feed.

## Scope / Non-goals

Change the existing messages, runs, and event projections to use the app-scoped
canonical conversation aggregate. Persist each completed streamed generation
before the long-lived run closes. Reuse the existing public run contract and
add the supporting Postgres index.

Do not add endpoints, settings, CLI/MCP behavior, provider-specific logic, or
SDK convenience wrappers. Do not redesign `GET /v1/sessions/{id}` provider
session details: a conversation may have several runtime/provider sessions and
that response needs a separate contract decision.

## Acceptance Criteria

1. A completed streamed assistant generation is visible through the messages
   API within the E2E polling budget and before runner shutdown.
2. Each completed visible generation creates exactly one message row;
   intermediate chunks do not create rows.
3. Interaction-boundary generations are persisted and finalization does not
   duplicate them.
4. Session runs are returned when the public session UUID differs from runtime
   session UUIDs, including root and threaded runs in the same conversation.
5. Runs remain observable after an agent rebind and exclude other apps or
   conversations; ordering and limit are deterministic.
6. Session event list, wait, and stream filters include matching run lifecycle
   events and exclude unrelated conversations.
7. Run responses validate against `AgentRunResponseSchema` and expose no
   provider, worker, lease, or execution-provider internals.
8. The real-provider Agent E2E proves prompt message, run, and event
   observability without waiting for idle runner shutdown.

## Technical Approach

1. Preserve canonical `conversationId` when mapping the Control API session
   record; keep it internal and retain explicit public response projection.
2. Move streamed-message persistence to completed output-buffer generations.
   Persist `sent` or `partially_sent` after delivery settlement, leave wholly
   undelivered output to fallback behavior, and remove late transcript
   persistence from run finalization.
3. Add a repository query for `appId + conversationId`, ordered by creation
   time and bounded by the existing limit. Add a composite index on
   `(app_id, conversation_id, created_at DESC, id DESC)` in the next migration
   and Drizzle schema.
4. Stamp inbound, outbound, and run lifecycle runtime events with canonical
   conversation identity and filter session event reads through it.
5. Project session runs through the existing `AgentRunResponseSchema` and
   update the stale OpenAPI run schema.
6. Add focused runtime tests, real Postgres repository/control tests, public
   boundary assertions, and the real-provider Agent E2E checks.

## Decisions

- [0083](../decisions/0083-public-session-conversation-aggregate.md): public
  sessions are canonical conversation aggregates.
- [0084](../decisions/0084-streamed-message-projection-timing.md): completed
  streamed generations persist before run finalization.
- Existing decisions 0008, 0013, and 0018 continue to govern Postgres
  persistence, runtime event exchange, and provider-neutral execution.

## Surface Impact

| Surface | Status | Reason |
|---|---|---|
| Runtime behavior | Changed | Completed streamed generations become durable during active runs. |
| `settings.yaml` | Unchanged by design | No configuration controls this reliability invariant. |
| Postgres/runtime projection | Changed | Conversation run query, event correlation, and supporting index change. |
| Control API | Changed | Existing session endpoints become truthful and use the safe run contract. |
| SDK/contracts | Changed | OpenAPI run response aligns with the existing canonical contract. |
| CLI | Unchanged by design | No CLI surface owns session observability. |
| Gantry MCP/admin | Unchanged by design | No admin operation is required to consume this projection. |
| Channel/provider adapters | Read-only/observable | Adapter contracts stay provider-neutral; streaming durability is shared runtime behavior. |
| Docs/prompts | Changed | Reliability matrix and API contract notes are updated. |
| Audit/events | Changed | Existing runtime events gain canonical conversation correlation. |
| Tests/verification | Changed | Runtime, Postgres, boundary, route, and Agent E2E coverage is added. |
| Provider-session details | Deferred | A public conversation may have multiple provider sessions; redesign when a multi-session response contract is approved. |

## Task Decomposition

1. **Canonical session observability** — preserve conversation identity, add the
   conversation run query/index, correlate runtime events, and update event
   filtering. Covers criteria 4–6.
2. **Prompt streamed-message durability** — persist completed generations,
   remove duplicate finalization persistence, and add focused tests. Covers
   criteria 1–3.
3. **Public contract and reliability proof** — align OpenAPI/public projection,
   add integration and real-provider E2E assertions, and update the matrix.
   Covers criteria 7–8.

## Risks

- Duplicate message rows if finalization remains a second persistence owner.
- Cross-conversation leakage if either app or canonical conversation filtering
  is omitted.
- Slow run queries without the matching composite index.
- Public leakage if repository records bypass the existing public schema.
- Live E2E timeouts if it waits for idle runner termination.

## Verify Plan

Run focused runtime and storage tests first, including real Postgres with a
disposable database and the required `vector` and `pg_trgm` extensions. Run the
real-provider Agent E2E when its credentials are available. Then run the
repository gates:

```bash
npm run typecheck
npm run test:unit
npm run test:integration:postgres
npm run test:e2e
python3 .agents/scripts/verify.py
```

Record automated tests, run deterministic verification, perform the single
quality/performance/security autoreview pass, and run the functional check if
the decomposition marks the E2E task user-facing.
