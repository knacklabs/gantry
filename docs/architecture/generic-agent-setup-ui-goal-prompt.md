# Generic Agent Setup UI Goal Prompt

## Objective

Deliver a generic, catalog-driven web setup flow for creating and operating any Gantry agent. The experience must use neutral labels, examples, validation, and status messages. It must not contain character-, person-, workspace-, or channel-specific defaults.

The feature branch must first be integrated with the current shared `main` branch. The incoming identity-management change is the canonical People and alias foundation once it lands on shared `main`; it is an explicit future integration dependency, not a parallel identity implementation.

## Product Contract

The web surface guides an owner through these ordered stages:

1. Create or select an agent using a neutral name and purpose.
2. Select an available model from the existing provider-neutral catalog.
3. Connect and verify a provider connection without exposing credentials after entry.
4. Discover/select a conversation, configure sender and trigger policy, and bind it to the agent atomically.
5. Edit the agent profile through the supported profile-update path.
6. Review readiness and run an explicit verification action.

Until identity management lands, People is a clearly marked preview backed by fixtures. After it lands, the same UI replaces that adapter with the canonical People API and retains its view model and navigation contract.

## Boundaries

- Reuse existing Control API, SDK, application-service, catalog, desired-state, and profile-update contracts where they already exist.
- Add only the missing server-side contracts needed for secure provider verification, exact conversation resolution, sender policy, atomic agent-conversation binding, profile access/update, and readiness/restart status.
- Do not add browser login/session authentication. This change consumes People identity only.
- Do not add a second People, alias, or ownership system.
- Do not write secrets to browser state, logs, settings, source files, or durable message content.
- Do not introduce character names, catchphrases, channel-specific sample messages, or hard-coded provider/model lists.

## Delivery Stages

### Stage 0 — Shared-main integration

Merge the current shared `main` into this feature branch. Resolve conflicts by preserving both the existing web/control-plane work and upstream behavior, then run the smallest relevant baseline checks.

### Stage 1 — Generic setup shell and fixtures

Add the setup route, stage model, generic copy, navigation, validation shell, and fixture-backed previews for unsupported control-plane surfaces. Existing standalone pages remain usable.

### Stage 2 — Live supported controls

Wire existing live model, conversation discovery, and binding behavior through the local-owner bridge. Add provider-scoped discovery authorization and surface real loading, empty, and error states.

### Stage 3 — Missing onboarding contracts

Implement the minimum application and Control API contracts for secure provider connection verification, exact conversation lookup, sender/trigger policy persistence, transactional binding, profile read/update, memory status, and operational readiness/restart status. Expose matching SDK and web clients.

### Stage 4 — Identity integration after shared-main release

After the other developer's identity change has merged into shared `main`, merge that updated `main` into this feature branch. Replace only the People preview adapter with the canonical People API; preserve routes, view models, and generic UI language.

### Stage 5 — End-to-end readiness

Verify the complete owner flow against a disposable Postgres database and a non-secret test provider path. Confirm no secrets appear in browser responses, events, or logs, and retain explicit authorization before any live service restart.

## Surface Impact Matrix

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | New onboarding operations and readiness projections are required. |
| `settings.yaml` | Read-only/observable | Existing desired-state ownership remains authoritative; no new raw secret fields. |
| Postgres/runtime projection | Changed | Provider metadata, policy, binding, and readiness operations need durable projection. |
| Control API | Changed | Browser-safe owner endpoints and local-owner route authorization are required. |
| SDK/contracts | Changed | Typed clients must match new owner operations. |
| CLI | Unchanged by design | CLI remains the operational setup alternative and shares application services. |
| Gantry MCP/admin skill | Read-only/observable | Existing desired-state/profile authority remains the source for privileged updates. |
| Channel/provider adapters | Changed | Connection verification and conversation discovery must use adapter-owned behavior. |
| Docs/prompts | Changed | Generic setup guidance and architecture ownership are documented here. |
| Audit/events | Changed | Connection and policy mutations require durable audit evidence. |
| Tests/verification | Changed | Each stage needs focused API, UI, security, and integration checks. |

## Acceptance Criteria

- A user can complete the six-stage flow with generic language and no agent persona assumptions.
- Provider/model choices come from live catalogs, not frontend constants.
- Credentials are accepted only by the server-side secret path and are never returned after submission.
- Conversation selection uses an exact canonical identifier and binding does not delete a prior valid binding before replacement succeeds.
- Sender policy, trigger policy, and approvers are explicit and durable.
- Profile changes use the approved profile update mechanism, not a generic file editor.
- The People view swaps from its preview adapter to canonical identity API without a route or UI-contract rewrite.
- Focused tests and the repository-required verification commands produce evidence before handoff.
