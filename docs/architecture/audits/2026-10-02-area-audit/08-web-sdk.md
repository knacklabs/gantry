Seven findings, verified in source. No files changed.

1. **Connected console still serves demo data — UX / parallel**

   **Today:** The header can say “Runtime connected,” but Chat’s Send button always asks the person to connect. Jobs, diagnostics and other screens read fixtures. Overview mixes live provider data with invented metrics and blockers. There are also two people directories: the live Directory and the fixture-backed `/people` pages.

   **Locations:** All fixture-query copies:
   - `apps/web/src/features/chat/chat-queries.ts:13,19,28`
   - `apps/web/src/features/operations/operations-queries.ts:108,114,120`
   - `apps/web/src/features/runtime/runtime-queries.ts:24,29,34,39,44,49,54`
   - `apps/web/src/features/workflows/workflows-queries.ts:12,18,24`
   - `apps/web/src/features/people/people-queries.ts:12,18`

   Additional wiring: [Overview’s fixture imports](../../../../apps/web/src/features/operations/routes/overview-route.tsx#L16), [Chat Send](../../../../apps/web/src/features/chat/components/chat-composer.tsx#L73), [unconditional connection message](../../../../apps/web/src/ui/compositions/connection-gate.tsx#L40), [live header](../../../../apps/web/src/app/app-shell.tsx#L15), [production route registration](../../../../apps/web/src/app/router.tsx#L15). People copies: [live directory](../../../../apps/web/src/features/agents/routes/agents-route.tsx#L28), [preview directory](../../../../apps/web/src/features/people/routes/people-route.tsx#L25), [preview detail](../../../../apps/web/src/features/people/routes/person-detail-route.tsx#L43).

   **Survive:** Live queries and the existing development labs. **Delete/merge:** Remove demo data from product routes; merge people browsing into the live Directory. Unsupported actions should say they are unavailable instead of diagnosing a missing connection.

   **Size:** Large story. **Risk:** Preserve working administration paths while removing preview wiring.

2. **The shell blocks every console page on phones — UX**

   **Today:** Below 768px, people see “Tablet or desktop required”; the entire console is hidden, including simple account and settings pages.

   **Locations:** [blocking panel](../../../../apps/web/src/app/app-shell.tsx#L24), [hidden application container](../../../../apps/web/src/app/app-shell.tsx#L34).

   **Survive:** One responsive shell and existing navigation. **Delete/merge:** Delete the viewport refusal; collapse navigation on small screens and allow wide tables to scroll.

   **Size:** Small fix. **Risk:** Verify keyboard access, drawer focus and table overflow.

3. **Account pages mistake pagination for missing ownership — duplicate / UX**

   **Today:** Both account screens fetch only the first 100 AI employees, then search that page for each account’s owner. An owner outside that page is displayed as unavailable; the detail page loses its owner link.

   **Locations:** [list’s capped request](../../../../apps/web/src/features/channel-accounts/routes/channel-accounts-route.tsx#L16), [list’s missing-owner wording](../../../../apps/web/src/features/channel-accounts/routes/channel-accounts-route.tsx#L125); [detail’s capped request](../../../../apps/web/src/features/channel-accounts/routes/channel-account-detail-route.tsx#L26), [detail lookup](../../../../apps/web/src/features/channel-accounts/routes/channel-account-detail-route.tsx#L83). The server [caps pages at 100](../../../../apps/core/src/control/server/routes/browser-agents-helpers.ts#L16).

   **Survive:** Account ownership IDs and the existing [agent-detail query](../../../../apps/web/src/features/agents/agents-queries.ts#L51). **Delete/merge:** Remove both directory-page joins; resolve owners by ID or include owner names in account responses.

   **Size:** Small fix. **Risk:** Keep owner resolution scoped to the current app.

4. **Handwritten SDK DTOs already disagree with canonical contracts — duplicate**

   **Today:** SDK developers cannot access model image/PDF capabilities through the declared type. Its settings response similarly omits delegates, harness and provider-account fields that contracts describe.

   **Locations, every representation of these two DTOs:**
   - Models: [SDK](../../../../packages/sdk/src/job-model-types.ts#L224), [contracts](../../../../packages/contracts/src/jobs/index.ts#L510), [handwritten OpenAPI](../../../../apps/core/src/control/server/openapi-schemas.ts#L343), [generated type](../../../../packages/sdk/src/generated/openapi.ts#L2586).
   - Settings: [SDK](../../../../packages/sdk/src/settings.ts#L9), [contracts](../../../../packages/contracts/src/settings/index.ts#L229), [OpenAPI’s untyped object](../../../../apps/core/src/control/server/openapi-schemas.ts#L631), [generated type](../../../../packages/sdk/src/generated/openapi.ts#L2747).

   **Survive:** Canonical contracts and generated artifacts. **Delete/merge:** Import contract types into the SDK; derive corresponding OpenAPI descriptions from those schemas. The SDK already [uses contracts for people](../../../../packages/sdk/src/people.ts#L1).

   **Size:** Medium story. **Risk:** Check schema conversion preserves optional fields and validation semantics.

5. **Agent administration has three conflicting descriptions — parallel**

   **Today:** Contracts describe `capabilities.capabilities`; OpenAPI describes that object using `AgentAccessResponse`, whose selection field is `selections`. The SDK sidesteps both with `Record<string, unknown>`, so developers get neither accurate documentation nor useful typing.

   **Locations:** [canonical admin contract](../../../../packages/contracts/src/agents/index.ts#L342), [access shape](../../../../packages/contracts/src/agents/index.ts#L311), [OpenAPI copy](../../../../apps/core/src/control/server/openapi-schemas.ts#L117), [generated copy](../../../../packages/sdk/src/generated/openapi.ts#L2150), [SDK copy](../../../../packages/sdk/src/agents.ts#L15). The [actual handler](../../../../apps/core/src/control/server/routes/agents.ts#L199) returns the capabilities view.

   **Survive:** One contract matching the handler. **Delete/merge:** Remove the SDK mirror and incorrect OpenAPI reference; generate both from the canonical response schema.

   **Size:** Medium story, ideally with finding 4. **Risk:** Validate nested responses against actual HTTP output.

6. **Model defaults return every selection twice — parallel / over-complicated**

   **Today:** API consumers can read the same values through `chat/jobs/memory` or `defaults`. The handler inserts the same six objects into both representations.

   **Locations:** [handler](../../../../apps/core/src/control/server/routes/models.ts#L179), [contracts](../../../../packages/contracts/src/jobs/index.ts#L613), [SDK](../../../../packages/sdk/src/job-model-types.ts#L328), [OpenAPI](../../../../apps/core/src/control/server/openapi-schemas.ts#L547), [generated type](../../../../packages/sdk/src/generated/openapi.ts#L2677).

   **Survive:** Grouped `chat/jobs/memory`, which already expresses workload ownership. **Delete/merge:** Delete the redundant response-level `defaults` object from every representation.

   **Size:** Medium story: public interface change. **Risk:** Update consumers of the removed shape; external usage is unknown.

7. **An unused directory table duplicates the live table — dead**

   **Today:** Developers maintain a second employee table with its own status rendering and pagination. No source imports or calls it.

   **Locations:** [unused component, 195 lines](../../../../apps/web/src/features/agents/components/agent-directory-table.tsx#L15), [live replacement](../../../../apps/web/src/features/agents/routes/agents-route.tsx#L238), [live call](../../../../apps/web/src/features/agents/routes/agents-route.tsx#L173).

   **Survive:** The live combined directory. **Delete:** `agent-directory-table.tsx`.

   **Size:** Small, one-file fix. **Risk:** None found; repository search found only its declaration.

Covered by PERMFLOW-1..4: separate permission-button rendering in `interaction-renderer.tsx:85` and `interactions-route.tsx:128`.

Covered by UX-1: form interactions in `content-interaction-renderer.tsx:122`.

Ranked by value:

1. Connected console serving demo data.
2. Mobile console lockout.
3. False unavailable account owners.
4. SDK DTO drift.
5. Conflicting agent-admin contracts.
6. Redundant model-default shapes.
7. Unused directory table: certain 195-line deletion.
