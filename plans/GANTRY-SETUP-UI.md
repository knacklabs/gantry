# GANTRY-SETUP-UI — Generic Agent Setup UI

## Problem

Gantry has live model, conversation, and local-owner control-plane surfaces,
but they are spread across standalone pages. People and several owner-facing
areas remain previews. An owner cannot complete a safe, generic setup flow for
an arbitrary agent without knowing the internal routes and CLI sequence.

## Scope / Non-goals

Implement a catalog-driven `/ui/agents/setup` flow for agent identity, model access,
provider connection, conversation policy/binding, profile, and readiness. The
flow uses neutral labels and examples and accepts no persona-, person-,
workspace-, or channel-specific defaults.

Non-goals: browser login/session authentication; a parallel People/alias
system; browser-stored provider credentials; a new model/provider catalog;
automatic service restart; a replacement CLI setup flow; or a second
conversation routing model.

## Acceptance Criteria

1. A generic setup route presents the six ordered stages with accessible
   loading, empty, validation, and error states at desktop, tablet, and mobile
   widths in both themes.
2. Agent, provider, and model choices come from existing server-owned
   catalogs/contracts rather than frontend constants.
3. Provider credentials are submitted only to a server-side secret path and
   are never returned by UI/API responses, logs, or durable messages.
4. Conversation lookup resolves an exact canonical identifier; updating a
   binding cannot remove an existing valid binding before its replacement is
   validated and persisted.
5. Sender policy, trigger policy, and approvers are explicit and durable.
6. Agent profile reads/updates use the approved profile mechanism rather than
   generic file editing.
7. People remains fixture-backed until the canonical identity branch merges,
   then swaps to the People API without a route/view-model rewrite.
8. The end-to-end owner path has focused API/UI/security verification and
   requires explicit user intent before a live runtime restart.

## Technical Approach

Recommendation: compose the new setup flow from the existing web feature
clients and local-owner bridge, adding narrowly scoped server contracts only
where a current application service does not expose safe owner behavior. This
is smaller and safer than replacing existing Operations, Models, People, or
Agent pages.

The setup route owns only stage orchestration and generic presentation. It
uses existing model and conversation discovery APIs first. Missing provider
verification, exact conversation resolution, policy update, transactional
binding, profile, and readiness operations are added at the application /
Control API boundary and projected through the local-owner bridge. Secret
material remains behind the runtime secret provider. People keeps a small
adapter boundary so the identity branch changes the data source, not UI routes.

The known binding-projection lesson is mandatory: live route projection stays
separate from durable `AgentConversationBinding` records; whole-conversation
projection is live-only and thread-scoped bindings never register a parent
conversation route.

## Decisions

No new decisions. The generic owner-flow scope is explicitly approved in
`docs/decisions/0040-client-signoff.md`; provider-neutral architecture and
identity ownership are already governed by the existing architecture documents
and the committed goal prompt.

## Surface Impact

| Surface | Classification | Rationale |
| --- | --- | --- |
| Runtime behavior | Changed | Owner readiness and setup operations need safe runtime projections. |
| API | Changed | Browser-safe owner endpoints and local-owner authorization are required. |
| Data/schema | Changed | Only if the missing policy/binding/readiness service cannot reuse existing durable projection; migrations stay narrowly scoped. |
| CLI/ops | Unchanged by design | CLI remains an alternative setup adapter over the same services; restart stays explicit. |
| UI | Changed | Adds the generic staged setup route and converts supported previews to live clients. |
| Docs | Changed | Goal/brief/decision record and setup-facing documentation are updated. |
| Tests | Changed | Focused contract, UI, secret-redaction, and binding-projection tests are required. |

## Task Decomposition

1. **Generic setup shell and navigation** — Own `apps/web/src/app/` and a new
   `apps/web/src/features/setup/` feature. Add the six-stage route, neutral
   copy, stage state, and links to existing standalone screens. Acceptance:
   criteria 1 and 2; no provider/persona constants in the new UI; verify at
   1440px, 1024px, and 390px in light and dark themes.

2. **People setup adapter** — Own only `apps/web/src/features/people/` query
   boundary and setup-facing view models. Preserve the current fixture adapter
   until identity API integration; define the swap seam without changing routes.
   Acceptance: criterion 7.

3. **Live owner-control wiring** — Own the local-owner allowlist, existing
   web API clients, and current provider/conversation route tests. Expose
   supported catalog/discovery endpoints and authorize them correctly.
   Acceptance: criteria 1, 2, and 8.

4. **Missing setup application contracts** — Own application/control API/SDK
   contracts for secure provider verification, exact conversation resolution,
   sender/trigger policy, transactional binding, profile operations, memory
   status, and readiness. Keep durable binding separate from live projection.
   Acceptance: criteria 3 through 6 and 8. A profile version conflict must
   return an actionable 409 response; no restart occurs without an explicit
   authorized user action.

5. **Canonical identity integration** — After the other developer's identity
   change lands on shared `main`, merge that updated `main` into this feature
   branch and replace only the People preview data adapter. Preserve current
   routes and view models without parallel identity storage. Acceptance:
   criterion 7.

6. **Verification and cleanup** — Add focused tests, search for stale
   persona/channel-specific setup copy and obsolete binding paths, run the
   required verification pipeline, and perform a runtime smoke only after
   explicit user approval. Acceptance: all criteria.

## Risks

- The incoming identity change is owned by another developer. Mitigation: do
  not merge their branch directly; wait for it to land on shared `main`, then
  merge that shared-main revision in a dedicated integration commit.
- Provider verification can leak credentials if implemented as a generic UI
  form. Mitigation: accept raw input only at the server secret boundary and
  return redacted connection metadata.
- Conversation updates can regress message routing. Mitigation: retain
  durable/live projection separation and add regression coverage before cutover.
- The local runtime is intentionally stopped. Mitigation: do not restart it
  during development; use unit/integration checks and seek explicit approval
  for a final smoke.

## Verify Plan

For each packet, run its nearest unit/API/UI checks plus `npm run typecheck`.
For data-backed work, start a disposable Postgres container with `vector` and
`pg_trgm`, point tests at `GANTRY_TEST_DATABASE_URL`, and remove it afterward.
Before handoff run:

```bash
npm run build
npm test
python3 scripts/check_architecture.py
python3 .agents/scripts/verify.py
python3 .agents/scripts/pr_ready.py
```

Then inspect the built UI at 1440px, 1024px, and 390px in both themes and run
the owner setup flow against a non-secret test provider path. Search the new
web, control, contract, and SDK code for raw credential patterns and for
persona/channel-specific setup copy. Do not restart `com.gantry` or send an
external message without explicit user authorization.
