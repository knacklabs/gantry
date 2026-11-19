# Microsoft Teams live transport

4 parts · Risks: archived Microsoft SDK, dependency vulnerabilities, authenticated public ingress, durable conversation routing · New moving parts: BotBuilder

## What changes for you

After a Teams bot is connected to Gantry, people can talk to their Gantry agent in Microsoft Teams instead of seeing a configured channel that cannot start. Replies stay in the originating Teams conversation and thread. Gantry can later send a message back to a conversation it has already seen, including scheduled or proactive updates, and Teams approval cards can return their decisions to the waiting agent flow.

This first slice supports text messages, threaded replies, proactive messages, and Adaptive Card actions. Attachments and files, full Teams history, typing indicators, and reactions are not included.

## Why

Gantry already has Teams setup, routing, rendering, and approval behavior, but the production transport factory currently returns no client. This story connects those existing Gantry-owned behaviors to Microsoft Bot Framework using the implementation proven on the earlier Manipal branch while keeping the archived SDK confined to one replaceable adapter.

## Done when

1. **A person can send a text message to a configured Gantry bot in Teams and receive the agent reply in the same conversation and thread.**
2. **Gantry can send a proactive or scheduled text message to a Teams conversation it has previously received, including after Gantry restarts.**
3. **A permitted person can submit a Gantry approval or action card in Teams and the waiting Gantry flow receives that decision without accepting an unauthorized submitter.**

## Risks

- BotBuilder is a new dependency and Microsoft has archived it. Its imports and data shapes must remain inside the Teams transport adapter so a later SDK migration replaces that adapter rather than Gantry's channel behavior.
- The archived dependency may carry a fixable high or critical transitive vulnerability. The dependency task's pull request must pass the Trivy image-vulnerability gate in `.github/workflows/image.yml`; a necessary patched transitive version is pinned with a root override rather than weakening the gate.
- Teams activities arrive through a public HTTP endpoint. Bot Framework authentication must validate every activity before Gantry normalizes or processes it.
- Proactive delivery adds Teams routing fields to the existing canonical conversation external reference. Updates must merge those fields without overwriting the conversation identity, and a serialized BotBuilder object must not become the source of truth.

## For the builders

### Done-when details

1. The transport accepts `POST /v1/providers/teams/{providerAccountId}/activities` only when that account alias is registered by a Teams client started with inbound enabled. The app root injects `processTeamsActivity` into `ControlRouteContext`; the route passes the raw Node request and response plus the path account to the adapter-owned inbound-client registry. Every alias in the connection's `inboundProviderAccountIds` selects the same authenticated client, so there is no process-wide last-client winner. The live worker's `ops` profile and the all-in-one process can answer only when their inbound client is registered; an outbound-only control process returns 503 without reading the body.

   Bot Framework authentication runs before body normalization and must reject an unsigned token or a validly signed token for another audience with 401. The authenticated activity tenant must equal the configured bot tenant before a route is stored or a message enters Gantry. A valid message removes the bot mention where applicable, strips any `;messageid=<root>` suffix from the canonical conversation id, uses that root as the thread id, and passes only Gantry-owned `TeamsInboundMessage` data to `TeamsChannel`. Per MSG-1, the adapter awaits `onMessage` through durable save before sending a success response; a failed save returns non-2xx. Outbound text looks up the canonical route and sets `replyToId` from the Gantry thread id. Prove this with the `teams-live-transport` end-to-end case for inbound text and a same-thread reply, plus focused adapter and route tests, including outbound-only 503, wrong-tenant refusal, failed-save non-2xx, unsigned-token 401, and wrong-audience 401.

2. Every authenticated inbound activity refreshes Teams routing fields in the existing `conversations.external_ref_json` record for every account alias in `inboundProviderAccountIds`. The existing deterministic provider-account-plus-JID conversation id remains the key. When an alias has no conversation row, the store first creates it through the existing `ensureConversation` path, then merges `serviceUrl`, `tenantId`, `botId`, `channelId`, and nullable `conversationType` into the external reference without replacing its canonical identity fields. The ordinary canonical conversation upsert must preserve external-reference keys it does not own, so saving the message after route capture cannot erase Teams routing. The Gantry-owned store contract is `upsertForProviderAccounts({ providerAccountIds, route }): Promise<void>` and `get({ providerAccountId, conversationJid }): Promise<TeamsConversationRoute | null>`. It strips `;messageid=<root>` before keying and never stores raw BotBuilder JSON as authority.

   Outbound delivery uses that record after a new client instance starts; a missing record produces an actionable delivery error and never guesses a service URL. Shared-credential sibling accounts each receive a route and remain independently addressable without allowing another bot connection's route to match. Prove this with the `teams-live-transport` end-to-end restart/proactive case and a Postgres repository integration test covering save, refresh, sibling aliases, connection isolation, canonical suffix stripping, reload, and missing route.

3. Message and invoke activities carrying Adaptive Card values normalize into the existing Teams action pipeline. Successful invokes return the response envelope Teams expects; failed handling returns a safe error envelope. Existing conversation-approver checks remain authoritative. An unauthorized submitter receives a short refusal response, the card remains unchanged, and the waiting flow remains pending so a later permitted submitter can decide it. Transport logs record only redacted activity metadata rather than card values or credentials. Prove this with the `teams-live-transport` end-to-end approval case and focused invoke/authentication tests.

### Bounded write scope

- `apps/core/src/channels/teams/**` and `apps/core/src/channels/register-builtins.ts` for the Gantry-owned route-store port, BotBuilder adapter, inbound registry, internal Teams seam, and removal of the runtime-placeholder flag.
- `apps/core/src/adapters/storage/postgres/repositories/teams-conversation-route-store.postgres.ts`, `apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts`, and `apps/core/src/adapters/storage/postgres/runtime-store.ts` for merging and reading Teams routing metadata through the existing canonical conversation record while preserving transport-owned keys during ordinary conversation saves.
- `apps/core/src/app/index.ts`, `apps/core/src/control/server/index.ts`, `apps/core/src/control/server/handler-context.ts`, `apps/core/src/control/server/routes/teams-activities.ts`, and `apps/core/src/control/server/openapi-routes-core.ts` for app-root composition, the authenticated Teams activity endpoint, and its OpenAPI description.
- The existing shared inbound-event repository, runtime routing/persistence/unpack loop, provider-account connection wiring, and their focused tests for the minimum durable save-and-recovery path required by Teams. Other channel adapters are not converted in this pull request.
- `apps/core/src/cli/teams.ts` and new `docs/operations/microsoft-teams.md` for the live endpoint and removal of scaffold-only wording.
- `apps/core/test/**`, `package.json`, and `package-lock.json` for focused proof and the BotBuilder dependency.

### Surface Impact Matrix

| Surface | Classification | Reason |
|---|---|---|
| Runtime behavior | Changed | Configured Teams accounts gain real inbound, outbound, threaded, proactive, and card-action transport. |
| `settings.yaml` | Unchanged by design | Existing Teams provider-account and encrypted credential ownership already supply the required client id, secret, and tenant id. |
| Postgres/runtime projection | Changed | The existing provider-account-scoped canonical conversation external reference gains Teams routing metadata, making proactive delivery restart-safe without a new table. |
| Control API | Changed | A public Bot Framework activity endpoint is mounted in `full` and `ops` profiles but handles requests only in a process with the matching inbound client registered. |
| SDK/contracts | Changed | The internal Gantry-owned Teams start/ingress result contract gains account aliases, inbound readiness, and action disposition; public contracts stay unchanged and BotBuilder types do not cross the boundary. |
| CLI | Changed | Teams setup output names the live activity endpoint and no longer says that a transport adapter is missing. |
| Gantry MCP tools/admin skill | Unchanged by design | Existing provider setup and delivery tools already target canonical Teams JIDs. |
| Channel/provider adapters | Changed | The null Teams factory path is replaced by the BotBuilder-backed implementation. |
| Docs/prompts | Changed | A Teams operations guide documents the account-specific endpoint and the deliberately deferred capabilities. |
| Audit/events | Unchanged by design | Existing channel delivery and action events remain authoritative; the adapter adds only redacted operational logs. |
| Tests/verification | Changed | Adapter, route, Postgres, and end-to-end Teams transport proof are added. |

### Boundary and migration rules

- Only the Teams transport adapter may import `botbuilder` or accept its `Activity`, `TurnContext`, or `ConversationReference` shapes.
- The control route delegates the raw request to the transport for Microsoft JWT validation; it must not parse or trust the activity first.
- Persistence owns Gantry-shaped routing fields inside the existing canonical conversation external reference. Reconstruct any SDK object inside the adapter instead of persisting raw BotBuilder JSON as the authority.
- Canonical conversation writes merge their owned external-reference fields over the stored JSON instead of replacing the whole value. This preserves Teams transport fields while still allowing canonical identity fields to be refreshed.
- T1 exposes the existing canonical-conversation persistence through a Gantry-owned `TeamsConversationRouteStore`. The Teams factory passes that dependency to `createMicrosoftTeamsSdkClient`; the BotBuilder client never constructs or imports a Postgres repository.
- `TeamsChannel`, application services, domain code, settings, and public contracts continue to depend only on the existing Gantry-owned Teams types.
- Port from `manipal-changes`, using its legacy `BotFrameworkAdapter` behavior rather than introducing `CloudAdapter`. Existing `client_id`, `client_secret`, and `tenant_id` secrets are the single-tenant Teams bot app registration; no second bot credential set is added.
- The test harness supplies a local RSA signing-key/OpenID metadata service, OAuth token endpoint, and connector endpoint through BotBuilder's configurable authentication and connector seams. CI performs no Microsoft network calls.
- This consolidated pull request includes the minimum shared inbox worker/routing prerequisites and the Teams save-before-reading edge that were previously assigned to MSG-1/T16. It activates that path only for Teams and does not convert Slack, Telegram, or Discord.
- This story ports behavior, not source wholesale: historical code is reused only where it matches current main's provider-account isolation, control-server profiles, action pipeline, and schema conventions.

### Cleanup and verification

- Search for the null `createMicrosoftTeamsSdkClient` placeholder, the Teams `runtime-placeholder` flag, and scaffold-only CLI warning; none remains after the cutover.
- Search all production source for `botbuilder`, `BotFrameworkAdapter`, `TurnContext`, `Activity`, and `ConversationReference`; matches are allowed only in the Teams transport adapter and its direct tests.
- Run `npm run db:migrations:check` and confirm this story adds no schema migration or Teams-specific table.
- Run the focused Teams unit, control-route integration, Postgres repository integration, and `teams-live-transport` end-to-end cases.
- Run `GANTRY_TEST_DATABASE_URL=<disposable-postgres-url> npm run test:e2e:postgres -- apps/core/test/e2e/teams-live-transport.postgres.e2e.test.ts` for the database-backed owner proof.
- Require the Trivy image scan in `.github/workflows/image.yml` to pass on the BotBuilder dependency pull request; do not treat `npm run security:images` as vulnerability proof.
- Run `npm run typecheck`, `npm run lint`, `python3 scripts/check_architecture.py`, `npm test`, and `npm run build` before handoff.

## Tasks

| ID | Name | What it delivers | Covers | Scope | Tests | After | User-facing |
|---|---|---|---|---|---|---|---|
| T5 | Deliver the complete Teams transport | Delivers all four implementation parts together: the minimum shared durable save-and-recovery path activated only for Teams, durable conversation routes, authenticated inbound activities and Adaptive Card actions, stored-route outbound and proactive delivery, and the mounted endpoint, CLI/docs, and end-to-end proof. It selectively restores the valid reverted T1 implementation rather than rebuilding it. | 1, 2, 3 | The full bounded write scope above | All focused shared-inbox, adapter, control-route, Postgres repository, and `teams-live-transport` end-to-end proof named above; the pull request must also pass the Trivy image workflow | - | Yes |

New moving parts: `botbuilder` dependency (items 1-3). No new Postgres table or migration is required; item 2 reuses the existing canonical conversation record.

## Notes

- Decided: use the historical BotBuilder approach for this first PR, accepting its archived status in exchange for the shortest proven path; keep the boundary strict so migration to Microsoft 365 Agents SDK is adapter-local (owner, 2026-10-22).
- Decided: reuse `conversations.external_ref_json` for Gantry-shaped Teams routing fields instead of adding a Teams-specific table; the current canonical conversation model already owns provider-account-scoped conversation identity (owner clarification, 2026-10-22).
- Deferred: attachments and files, full Teams history hydration, typing indicators, and reactions. They are not required for the agreed first live-chat slice.
