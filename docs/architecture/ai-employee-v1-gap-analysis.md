# AI employee V1 — gap analysis (Codex sweep, 2026-08-26)

Five parallel read-only Codex (`gpt-5.6-terra`, high) sweeps checked the
`ai-employee-v1` roadmap stories against the code and accepted decisions.
Verbatim reports follow; roadmap changes made in response are recorded in the
same commit. Headline: the Teams transport is a stub
(`apps/core/src/channels/teams-sdk-client.ts` returns `null`), so every
Teams-first claim depends on `TEAMS-1`.

Resolutions (human, same day): build `TEAMS-1` in V1.0 and keep the video on
Teams; add `AUDIT-1`, `UIFACADE-1`, `OAUTH-1`, `EGRESS-1` as prerequisites;
split `COST-1` (usage view, V1.0.x) from `COST-2` (hard cap, V1.1); narrow
`HITL-1` to channel approvals; two-tier Teams E2E (fixture in gate, real
tenant nightly).


## Identity: IDENT-2, IDENT-4

Read-only audit; no files changed. `main` contains IDENTITY-01 (PR #373), but not its cross-kind extension.

| # | Gap | Severity (blocker/major/minor) | Evidence (paths) | Recommended story change |
|---|---|---|---|---|
| 1 | IDENTITY-01 is merged, but its actual alias shape is Person-only: `users` + `user_aliases(provider, providerAccountId, externalUserId)`, not `(kind, authorityId, subject)`. Merge and `people:admin` exist; `person_merge_audit.actor` is scalar text. | major | `apps/core/src/adapters/storage/postgres/schema/apps.ts`, `apps/core/src/adapters/storage/postgres/repositories/person-identity-repository.postgres.ts`, `apps/core/src/control/server/routes/people.ts` | Treat IDENT-2 as a schema migration from the shipped Person model, including collision-fail migration; do not call the documented canonical alias table “existing.” |
| 2 | Provider Accounts are PG projections of revisioned desired state, not a transactionally owned YAML record. A YAML/revision write cannot currently atomically create/retire an alias. | major | `apps/core/src/adapters/storage/postgres/schema/providers.ts`, `apps/core/src/config/settings/desired-state-service.ts`, `docs/decisions/0025-settings-authority.md` | Define the atomic boundary as desired-state revision + identity/runtime/outbox orchestration with recovery; YAML is only a mirror/import surface. |
| 3 | Actor stamping has 103 source writers and 6 persisted shapes: `runtime_events.actor`, `person_merge_audit.actor`, `permission_audit_events.actor_id`, `mcp_server_audit_events.actor_id`, decision `actor_context_json`/`approver_ref`, and provenance fields (memory/amendment/observer). Bare values such as `agent`, `runtime`, `permission`, `sdk`, and CLI strings remain. | major | `apps/core/src/adapters/storage/postgres/schema/events.ts`, `apps/core/src/adapters/storage/postgres/schema/permissions.ts`, `apps/core/src/adapters/storage/postgres/schema/mcp-servers.ts` | Add an explicit writer/table migration matrix. At minimum migrate those four audit/event tables; decide whether decision, memory-evidence, amendment, and observer provenance also become `PrincipalRef`. |
| 4 | `agent remove` is route-first, non-atomic cleanup; `removeRoutelessAgent` prunes desired state then best-effort disables projection. There is no `offboarded` status/gate, no agent-wide job cancellation, and `main_agent` is only protected from complete removal. | major | `apps/core/src/cli/group.ts`, `apps/core/src/cli/group-remove-routeless.ts`, `apps/core/src/adapters/storage/postgres/schema/agents.ts`, `apps/core/src/adapters/storage/postgres/schema/jobs.ts` | Add `offboarded`, a pre-remove gate, explicit main-agent prohibition, and one offboard use case—not a modification of route removal. |
| 5 | Conversation installs exist both in settings and PG; account disable preserves secret references, but the current removal path drops declarations and only reconciles absent state when authoritative. Delegates can block desired-state pruning after a route was already removed. | major | `apps/core/src/adapters/storage/postgres/schema/providers.ts`, `apps/core/src/config/settings/desired-state-service.ts`, `apps/core/src/cli/group-helpers.ts` | Specify whether offboard atomically removes or disables installs/delegates, and make durable cancellation intent—not synchronous in-flight settlement—the atomic job guarantee. |
| 6 | IDENT-4 redaction does not exist. Memory is correctly person-scoped, but DM text is in `message_parts.payload_json` and messages have no Person FK; related memory evidence, candidates, reviews, and session summaries expand the erase graph. | major | `apps/core/src/adapters/storage/postgres/schema/memory.ts`, `apps/core/src/adapters/storage/postgres/schema/messages.ts`, `docs/architecture/identity-01-canonical-person-continuous-memory-plan.md` | Define every redacted table/representation and the join strategy before planning; existing attachment deletion is insufficient. Include person-scoped grant revocation. |
| 7 | Agent-sender classification is not implemented. Slack/Discord drop bot/self messages, but Teams has no live bot gate; the current participant persistence can auto-create a human Person before runtime identity/memory checks. | major | `apps/core/src/channels/slack/channel-message-ingest.ts`, `apps/core/src/channels/discord.ts`, `apps/core/src/channels/teams.ts` | Resolve normalized agent aliases before participant/message persistence; unify with existing bot/self filters and add Slack, Teams, and Discord collision/no-run tests. |
| 8 | Accepted decisions widen the work: connector accounts must share alias/offboard hooks; person offboarding must retire person-scoped grants; runtime events/outbox must use the established append repository. | major | `docs/decisions/0137-connector-accounts-mirror-provider-accounts.md`, `docs/decisions/0118-identity-scoped-approval-and-grants.md`, `docs/decisions/0016-event-bus-outbox-boundary.md` | Add connector-account/MCP binding retirement, person-grant revocation, and a named identity-offboarded event through the existing runtime-event/outbox path. |
| 9 | Locked posture requires parent-side denial/audit, so offboarding must remain operator-only; PrincipalRef migration must cover `denied_by_profile`. ADR 0023 also says fleet requires production posture, while legacy topology env usage remains. | major | `docs/decisions/0024-locked-preset.md`, `docs/decisions/0023-deployment-modes.md`, `apps/core/src/config/settings/storage.ts` | Add operator-only/locked-agent tests and resolve or explicitly exempt the pre-existing posture ADR drift. |
| 10 | The source extension is explicitly “Proposed,” and both roadmap stories carry spec debt; IDENT-4 also depends on IDENT-2. | blocker | `docs/architecture/identity-01-canonical-person-continuous-memory-plan.md`, `plans/roadmap.json`, `plans/roadmap.json` | Resolve the above contracts, save/confirm specs, then plan IDENT-2 before IDENT-4. |

IDENT-2: not plannable as written; its prerequisite is merged, but the assumed alias, atomicity, actor, and lifecycle contracts are not.

IDENT-4: not plannable as written; it depends on IDENT-2 and lacks a defined irreversible-redaction and grant-retirement boundary.

Both become plannable after a short decision/spec amendment fixes rows 2–10.

## Approvals and RBAC: HITL-1, RBAC-1

| # | Gap | Severity | Evidence (paths) | Recommended story change |
|---:|---|---|---|---|
| 1 | HITL’s approval authority is raw external user IDs, not `PrincipalRef`; no fail-closed migration exists. | blocker | `conversation_approvers.external_user_id`; `ConversationAdministrationService.isControlApproverAllowed()`; IDENTITY-02 target in `docs/architecture/identity-01-canonical-person-continuous-memory-plan.md` | Make IDENT-2’s alias-resolution migration an explicit prerequisite and define its rollback/failure behavior. |
| 2 | DM self-approval already exists: direct conversations authorize listed participants, not `control_approvers`. | minor | `apps/core/src/application/provider-conversations/conversation-administration-service.ts` | Retain this acceptance criterion as regression proof, not new feature work. |
| 3 | Channel approval cards already use one durable claim/resolve path, but HITL changes the same authority/callback seams as PERM-2. | major | `permission-decision-coordinator.ts`, `channel-wiring.ts`, `pending-interaction-permission-callback.ts`, provider callback handlers | Reuse the durable path and specify shared-file ownership/merge order with PERM-2; do not create cards or a parallel decision store. |
| 4 | “Web approval surface” is not a browser-console feature today. The API route accepts any API key with `approvals:write`, stamps `api-key:<kid`, and does not check conversation approvers; the Guardrails page is preview-only. | blocker | `apps/core/src/control/server/routes/sessions.ts`, `session-interaction-approvals.ts`, `browser-scope-policy.ts`, `apps/web/src/features/runtime/routes/guardrails-route.tsx` | Either add browser-session authorization through the same `canApprove` check, or narrow HITL V1 to channel/API approvals. |
| 5 | Approval audit is not principal-shaped or uniformly canonical: prompt/interactions and `permission_decisions` store free-form strings; `permission_audit_events.actor_id` is nullable string. | blocker | `apps/core/src/adapters/storage/postgres/schema/worker-coordination.ts`, `apps/core/src/adapters/storage/postgres/schema/permissions.ts`, `permission-management-service.ts` | Migrate all approval outcome records to `{ actor: PrincipalRef, aliasId? }`; backfill/fail closed where impossible. |
| 6 | No current per-agent approver or owner model exists. Agents only have `active`/`disabled`; job runs can be paused, but agents have no owner-authorized pause/resume operation. | major | `packages/contracts/src/agents/index.ts`, `apps/core/src/control/server/routes/agents.ts`, `apps/core/src/adapters/storage/postgres/schema/agents.ts`, identity plan §IDENTITY-02 | Add an agent-owner `PrincipalRef` relation and explicit pause/resume state/authorization; keep offboard `agents:admin` only. |
| 7 | Entra is generic-OIDC configuration, not a Google-only adapter; however Google’s `hd` claim is the automatic Viewer-grant shortcut, which Entra normally lacks. | major | `browser-oidc.ts`, `apps/core/src/adapters/auth/oidc-adapter.ts`, `apps/core/src/control/server/routes/browser-auth.ts`, `docs/specs/authentication-access-web-ui.md` | State Entra sign-in is config-only but requires invitation/CLI approval unless domain-grant policy is generalized. |
| 8 | Console roles are only Administrator/Viewer, browser policy marks `approvals:write` ineligible, and web types/UI hard-code two roles. Browser sessions do link to the canonical Person (`user_id` is legacy naming), but not to a `PrincipalRef`; agent principals do not yet exist. | blocker | `auth-foundations.ts`, `apps/core/src/adapters/storage/postgres/schema/authentication.ts`, `browser-scope-policy.ts`, `apps/web/src/features/auth/`, `identity-01-canonical-person-continuous-memory-plan.md` | RBAC-1 must cover role schema/migration, browser-scope policy, auth routes, web role unions/UI, and a PrincipalRef role-binding model. |

HITL-1 is not plannable as written until IDENT-2 supplies principal migration and browser-approval authority; its DM/card reuse is already present.  
RBAC-1 is not plannable as written: owner/pause semantics and principal-role bindings need a concrete contract, though Entra itself is mostly configuration.  
HITL-1 should not hard-depend on all of PERM-2—the coordinator/card core exists—but must serialize or jointly own its shared authority and durable-interaction files while PERM-2 remains active.

## Directory and cost: DIR-UI-1, COST-1

Read-only: no files changed. Current console routes include `/agents`, `/runtime/{models,memory,capacity,guardrails}`, `/activity`, `/memory`, `/mcp-servers`, `/providers`, and `/auth/*`; the natural directory home is `/agents`.

| # | Gap | Severity | Evidence | Recommended story change |
|---|---|---|---|---|
| 1 | IDENT-2 is proposed, not implemented; it is a real dependency blocker. | blocker | `docs/architecture/identity-01-canonical-person-continuous-memory-plan.md` | Make DIR-UI-1 depend on a shipped IDENT-2 API/use-case, not merely the plan. |
| 2 | `/agents` exists but is fixture-backed. It shows config/profile, capability/source/MCP/conversation lists, last run and daily count—not live aliases, installs, or authoritative status. | major | `apps/web/src/features/agents/agents-queries.ts`, `apps/web/src/features/agents/agents-preview.ts` | Replace fixture query with directory read model: agent, aliases, installs, status, access summary. |
| 3 | No same-origin agents facade. `/v1/agents` is Bearer-only; browser sessions cannot call `/v1/*`. | blocker | `apps/core/src/control/server/routes/agents.ts`, `apps/core/src/control/server/index.ts` | Add `/ui/api/agents` with Viewer read / Administrator mutation, CSRF, Origin, reauth, and audit policy matching 0132/0135. |
| 4 | Activity is static preview data; there is no browser audit/activity facade. | blocker | `apps/web/src/features/runtime/runtime-queries.ts`, `apps/web/src/features/runtime/runtime-preview.ts`, `docs/decisions/0135-browser-model-provider-credential-facade.md` | Add a live, agent-filtered audit facade/read model before claiming “read its audit trail.” |
| 5 | No atomic offboard mutation/use case. Existing agent status is only `active \| disabled`; control mutations and settings reconcile are separately sequenced. | blocker | `apps/core/src/domain/agent/agent.ts`, `apps/core/src/config/settings/desired-state-service.ts` | Ship IDENT-2 atomic offboard first: retire aliases, remove installs, disable accounts, cancel jobs, set `offboarded`, write audit/event/outbox. |
| 6 | No agent pause/budget state or cross-runtime spend admission. Existing `maxRunTokens` is post-output, per-run; queues do not know budget state. | blocker | `apps/core/src/runtime/group-agent-runner.ts`, `apps/core/src/runtime/group-queue.ts` | Define durable `paused_for_budget` state and atomically check/reserve at live admission and scheduler claim. |
| 7 | Monthly usage can be queried, but only as a range aggregation over events—not a transactional calendar-month cap rollup. | major | `apps/core/src/control/server/routes/usage.ts`, `apps/core/src/adapters/storage/postgres/repositories/runtime-event-repository.postgres.ts` | Add an app/agent/month durable counter or reservation ledger; define UTC/calendar timezone and concurrency semantics. |
| 8 | `/v1/usage` undercounts model use: memory extraction/dreaming and permission-classifier calls log `onUsage` but do not emit `model.usage`. | major | `apps/core/src/memory/extractor-llm.ts`, `apps/core/src/adapters/llm/openai-memory/openai-memory-llm-client.ts` | Either account/enforce every agent-attributable model call, or explicitly exclude and label the cap accordingly. |
| 9 | There is no general administrator budget-alert channel. Scheduler job notifications are reusable infrastructure but route to configured job recipients. | major | `apps/core/src/jobs/delivery.ts` | Specify admin recipients and reuse the durable notification/outbox delivery seam; add one-per-threshold dedupe. |

DIR-UI-1 is not plannable as written: its required data, browser facades, live audit, and atomic offboard dependency do not exist.

COST-1 is not safely plannable as written: usage display is feasible, but a hard cap needs durable admission/reservation and complete accounting first.

Accepted decisions checked include 0132, 0135, 0015, 0046, and 0099; none supplies a per-agent monthly-cap contract, and 0132 requires new browser surfaces to be explicitly classified.

## Install, docs, Teams: PKG-1, DOCS-1, TEAMS-E2E-1

Read-only audit complete; no files changed.

| # | Gap | Severity (blocker/major/minor) | Evidence (paths) | Recommended story change |
|---|---|---|---|---|
| 1 | Root package declares CLI but checkout has no `dist/`; `npm pack` will not run the build. | blocker | `package.json`, `.gitignore` | Add `prepack`, then prove clean `npm pack` → fresh install → `gantry` works. |
| 2 | Build is monorepo-dependent: runtime build compiles contracts, SDK, web, root TS, migrations/UI; source docs prescribe clone/build/`npm link`. | major | `package.json`, `README.md` | Define and test the supported package artifact; avoid requiring consumers to build workspaces. |
| 3 | No public package exists; no release/tag/npm/provenance workflow exists. Image workflow publishes GHCR only. | blocker | `.github/workflows/image.yml`, `.github/workflows/ci.yml` | Include first `@gantry/runtime` publish, tag-from-main enforcement, npm provenance/OIDC, and release acceptance test. |
| 4 | Setup does not provision Postgres: it asks for a URL and tells the user to start Compose themselves. | major | `apps/core/src/cli/setup-flow-core-steps.ts`, `docker-compose.yml` | Either make setup own a local Compose lifecycle or explicitly scope V1 to “user-started Postgres.” Measure fresh-machine first-agent time. |
| 5 | Linux sandbox runtime needs `bubblewrap` and `socat`; Python is not a documented host requirement. | minor | `docs/architecture/deployment-profiles.md` | Put exact platform prerequisites in the npm install guide and fresh-machine test image. |
| 6 | Docs are Markdown only; no Docusaurus/MkDocs/docs-site build exists. Current entry is fragmented and has a broken validation-loop link. | major | `docs/README.md`, `package.json` | Define DOCS-1 as a Markdown documentation spine unless hosting a docs site is explicitly added. Repair the broken link. |
| 7 | Slack has an install guide, but Teams has no operator quickstart; there is no lifecycle-oriented onboard/access/audit/offboard navigation. | major | `docs/operations/slack-app-install.md`, `README.md` | Add lifecycle landing page plus linked Slack and Teams operational quickstarts. |
| 8 | Security material exists but is scattered; no definitive egress allowlist or operator-readable audit schema page. | major | `docs/SECURITY.md`, `docs/security/single-host-hardening-plan.md`, `docs/decisions/0024-locked-preset.md` | Consolidate or cross-link threat model, locked posture, audit-event/schema reference, and exact egress configuration. |
| 9 | Teams transport is a stub: SDK client returns `null`; factory disables the channel. No Bot Framework adapter, manifest, or Azure Bot artifact exists. | blocker | `apps/core/src/channels/teams-sdk-client.ts`, `apps/core/src/channels/teams-factory.ts` | Split transport/app-registration/endpoint delivery into a prerequisite story before tenant E2E. |
| 10 | Teams CLI only discovers Graph channels and saves bindings; it does not install a bot, create a manifest, or configure a public messaging endpoint. | blocker | `apps/core/src/cli/teams.ts`, `apps/core/src/channels/teams-setup-discovery.ts` | Specify tenant app package, Bot Framework receive/send path, dedicated test approver, and stable public HTTPS endpoint. |
| 11 | Adaptive Card approval is mock-ready, but cannot reach a real tenant without that transport. `gantry agent offboard` does not exist; only `agent remove` exists. | blocker | `apps/core/src/channels/teams-permission-approval.ts`, `apps/core/src/cli/group-helpers.ts` | Make offboarding implementation and its retained-audit semantics a prerequisite, then test the three-step tenant flow. |
| 12 | Agent E2E is local/hermetic and nightly. PR CI explicitly excludes E2E; the real-model nightly step self-skips and has no Teams secrets or inbound path. | major | `.github/workflows/ci.yml`, `.github/workflows/nightly-e2e.yml`, `vitest.agent-e2e.config.ts` | Put fixture/adapter contract E2E in the required PR gate; run real tenant proof nightly or trusted label-gated against a deployed endpoint. |
| 13 | Decision 0033 does not block Card approval: it explicitly preserves Adaptive Card buttons and only defers reactions. Active Decision 0044 expects PR-blocking E2E, but current CI is nightly-only. | major | `docs/decisions/0033-teams-reactions-deferred.md`, `docs/decisions/0044-ci-runner-isolation.md` | Keep the video on Card approval; reconcile the E2E gate decision with the intended two-tier test strategy. |

PKG-1: plannable after narrowing “one install path” to a packaged artifact plus user-managed or setup-managed Postgres; release/provenance and first publish are essential scope.

DOCS-1: plannable as a Markdown lifecycle/security spine; a hosted docs site should be a separate explicit decision.

TEAMS-E2E-1: not plannable as written—real tenant in the ordinary merge gate is infeasible today; use fixture/adapter E2E as the blocking gate and a real-tenant nightly or trusted label-gated run with a stable public endpoint.

## Connectors and sovereign: CONN-1, CONN-GSUITE-1, SOV-1

| # | Gap | Severity | Evidence (paths) | Recommended story change |
|---|---|---|---|---|
| 1 | `connector_accounts`, alias projection, and offboard cleanup do not exist. Provider Accounts are a viable model, but use `provider`, not connector `kind`. | blocker | `apps/core/src/config/settings/runtime-settings-provider-accounts-parser.ts`; `apps/core/src/adapters/storage/postgres/schema/providers.ts`; `docs/decisions/0137-connector-accounts-mirror-provider-accounts.md` | CONN-1 must add settings + Postgres desired-state projection, IDENT-2 alias lifecycle, and atomic offboard cleanup. |
| 2 | MCP credentials are server-definition scoped (`credentialRefs`); bindings have no credential/account field. `runtime_secret_refs` are not currently projected into MCP. | major | `apps/core/src/domain/mcp/mcp-servers.ts`; `apps/core/src/application/capability-secrets/mcp-secret-projection.ts`; `apps/core/src/application/mcp/mcp-server-materialization.ts` | Make one account create one dedicated server/binding and add a scoped connector-secret projection; do not share a server across mailboxes. |
| 3 | Remote HTTP/SSE MCP runs through the host-side proxy; third-party stdio MCP execution is explicitly disabled. There is no current worker-sandbox MCP-process supervisor or capacity model for N mailbox processes. | blocker | `apps/core/src/application/mcp/mcp-tool-proxy-connection.ts`; `apps/core/src/application/mcp/mcp-tool-proxy-client-cache.ts`; `apps/core/src/application/mcp/mcp-server-materialization.ts` | Define GSuite as remote MCP, or add bounded sandboxed stdio supervision, process limits, health/restart, and account lifecycle ownership. |
| 4 | MCP calls are tool-exactly gated and audited with server/binding metadata, but no `connectorAccountId` exists or is durably recorded. Account scope is not an authorization input. | major | `apps/core/src/application/mcp/mcp-tool-proxy-audit.ts`; `apps/core/src/application/mcp/mcp-tool-proxy.ts`; `docs/decisions/0020-mcp-source-vs-action-capability.md` | Add connector-account scope evaluation before tool rules and a first-class account ID in audit/events. |
| 5 | No connector/tool OAuth authorization-code flow, encrypted refresh-token lifecycle, refresh, or rotation exists. Existing Google OIDC is UI-login-only; Vertex ADC/service accounts are model-gateway credentials, not Workspace grants. | blocker | `apps/core/src/adapters/auth/oidc-adapter.ts`; `docs/decisions/0101-oidc-generic-google-first.md`; `docs/architecture/credential-management.md` | CONN-GSUITE-1 needs its own OAuth callback/state/PKCE, scope validation, encrypted refresh-token store, refresh/revoke behavior, and redacted audit contract. |
| 6 | Provider Accounts are both `settings.yaml` desired state and Postgres projection; their identity ref is only `Record<string,string`, not an arbitrary nested object. | minor | `apps/core/src/config/settings/runtime-settings-provider-accounts-parser.ts`; `apps/core/src/adapters/storage/postgres/schema/providers.ts` | Specify the connector identity schema as flat string fields, or explicitly budget a typed/nested identity migration. |
| 7 | A free-form OpenAI-compatible provider/base URL conflicts with the registry-derived, fail-closed model-provider design; ADR 0135 explicitly excludes custom providers. | blocker | `apps/core/src/shared/model-provider-registry.ts`; `apps/core/src/shared/model-provider-registry-openai-compatible.ts`; `docs/decisions/0135-browser-model-provider-credential-facade.md` | Amend the ADR and add a constrained `openai_compatible` provider contract: URL validation, credential mode, catalog/route behavior, and gateway tests. |
| 8 | Egress is denylist/default-allow, not allowlist; `direct` mode has advisory proxy routing only. Remote MCP uses guarded direct fetch, so it is outside the runner proxy path; a global boot check does not exist. | blocker | `apps/core/src/config/settings/runtime-settings-permissions-parser.ts`; `apps/core/src/runtime/egress-gateway.ts`; `apps/core/src/application/mcp/mcp-tool-proxy-connection.ts`; `docs/decisions/0040-permission-execution-two-axis-model.md` | SOV-1 needs a host-bootstrap-owned allowlist policy and enforcement coverage for gateway/model traffic, embeddings, browser, remote MCP, telemetry, and sandbox/direct modes—not merely a doctor check. |

CONN-1: plannable only after explicitly budgeting the new account lifecycle, scoped secret projection, and MCP execution topology.  
CONN-GSUITE-1: not plannable as written; its OAuth/token-refresh platform is absent and should be a prerequisite or a clearly expanded story.  
SOV-1: not plannable as written; both generic-provider support and enforceable global allowlist require ADR changes and new host-owned infrastructure.

# Part 2 — console UI sweep (2026-08-26)

Four parallel read-only Codex sweeps mapped the finalised V1 to console surfaces. Resolutions: ONBOARD-UI-1 and PEOPLE-UI-1 added to V1.0; UI-CONN-ACCOUNTS-1 and ACCESS-UI-1 to V1.0.x; UIFACADE-1, DIR-UI-1, RBAC-1, EGRESS-1, SOV-1, COST-1, COST-2 gained UI acceptance criteria; decisions 0142 (third role, amends 0132) and 0143 (write-only secret ingest) proposed.

## Console inventory, facades, design system, testing

Read-only inventory complete — no files changed.

| Routes (base `/ui`) | Feature folder | Data |
|---|---|---|
| `/` → `/overview`; `/profile`; dev `/__components`, `/__components/interactions` | preferences; `ui/lab` | local browser preferences; dev labs |
| `/overview` | operations | mixed: live providers; preview interactions/diagnostics |
| `/interactions`, `/conversations`, `/conversations/$conversationId`, `/diagnostics` | operations | preview |
| `/providers`; `/mcp-servers` | operations | live `/ui/api/model-providers`; live `/ui/api/mcp-servers` |
| `/agents`, `/agents/$agentId`, `/sources`, `/pause` | agents | preview |
| `/people`, `/people/$personId` | people | preview |
| `/chat`, `/chat/$sessionId`, `/memory` | chat | preview |
| `/jobs`, `/jobs/$jobId`, `/runtime/{models,memory,capacity,guardrails}`, `/activity` | runtime | preview |
| `/workflows`, `/workflows/new`, `/$id/edit`, `/$id/runs/$runId`, `/external` | workflows | preview/local draft UI |
| `/auth/{local,local/reauthorize,sign-in,no-access,disabled,callback-failed,reauthenticate,setup,invitation}` | auth | live public auth flow |
| `/settings/authentication-access` | auth | live auth facade |

Router: `apps/web/src/app/router.tsx`. The protected root loads `/ui/api/auth/session` and accepts only `administrator|viewer` into route context: `apps/web/src/app/root-route.tsx`.

| `/ui/api` endpoint(s) | Role | Mutation protection / audit |
|---|---|---|
| `auth/local/authorize` POST | active local session | Origin + CSRF; no reauth; no direct audit |
| `auth/config` GET; `config/candidate` PUT; `config/test` POST; `config/activate` POST | Administrator | mutations Origin + CSRF; hosted reauth for candidate/activate; activation audit |
| `auth/invitations` GET/POST; `invitations/:id` DELETE | Administrator | mutations Origin + CSRF; reauth only when inviting an Administrator; create/revoke audit |
| `auth/access` GET; `access/:id` PATCH | Administrator | PATCH Origin + CSRF; reauth for elevation/restoration; audit; final active admin protected |
| `auth/sessions` GET; `sessions/:id/revoke` POST | session owner | revoke Origin + CSRF; self-revoke audit |
| `auth/session` GET; `auth/events` GET/SSE | active session | read-only; SSE revalidates session |
| `model-providers` GET | Viewer (`credentials:read`) | read-only, secret-safe DTO |
| `model-providers/:provider` PUT/PATCH/DELETE; `/verify` POST; `/credential` DELETE | Administrator (`credentials:admin`) | Origin + CSRF + hosted reauth; set/rotate/disable/remove use service audit events; verification returns safe metadata |
| `mcp-servers` GET/POST; `:id/(test\|disable\|reconnect)` POST; `:id/agents/:agentId` PUT/PATCH/DELETE | GET Viewer (`mcp:read`); mutations Administrator (`mcp:admin`) | Origin + CSRF + hosted reauth; MCP service audit trail |

All browser routes are `no-store`, reject Bearer credentials, and are only mounted on the full Control profile: `apps/core/src/control/server/index.ts`. The common mutation guard is exact canonical Origin plus synchronizer CSRF: `apps/core/src/control/server/routes/browser-auth.ts`; browser scope classification is exhaustive in `apps/core/src/control/server/browser-scope-policy.ts`.

Decision 0132 requires opaque revocable sessions, no browser-held API/OIDC/secret credentials, Bearer rejection, exact-Origin+CSRF mutations, and default-deny scope classification. Decision 0135 applies that rule to the narrow provider facade: direct service calls, Viewer reads/Admin writes, recent reauth, audit, and redacted safe responses—never a `/v1` proxy or secret payload. `docs/decisions/0132-adaptive-browser-authentication-access.md` `docs/decisions/0135-browser-model-provider-credential-facade.md`

Design system: shadcn/Radix-style local primitives + compositions, Tailwind v4, Lucide, Spline fonts, light/dark CSS tokens: `apps/web/src/styles.css`. Reuse `PageHeader`, `Panel`, `DataTable`, `TextField`/`SelectField`, `Dialog`/`AlertDialog`, and `PageState`; there is no toast system (use inline `role="alert"`/live receipts).

Sidebar order: Operations → Configure → Administration → Conversations → Runtime → Workflows → Account, exactly as `apps/web/src/app/app-navigation.tsx`.

- Directory: `/people` + detail tabs—filters, URL state, table, empty state: `apps/web/src/features/people/routes/people-route.tsx`.
- Wizard/form: `/workflows/new` with React Hook Form + Zod, then workflow builder; currently preview-only.
- Secret-reference settings: Authentication & Access (`clientSecretRef`) and MCP-connect dialog; secrets stay server-side.
- Audit/activity: `/activity` filterable paged master/detail table, redacted payload: `apps/web/src/features/runtime/routes/activity-route.tsx`.

Provider management is the live mutation model: client checks `administrator`, sends same-origin credentials plus `browserCsrfHeader`, and invalidates the query afterward. The server—not this page—enforces the ten-minute hosted reauth; unlike Authentication & Access, provider/MCP screens currently show generic failures rather than a reauth redirect. Disable uses `window.confirm`; credential removal uses a dialog requiring the exact provider label: `apps/web/src/features/operations/routes/provider-dialogs.tsx`.

Adding a page + facade:

1. Add route declaration in apps/web/src/app/routes/*.ts(x), feature route/query files, and navigation item if intended.
2. Add apps/core/src/control/server/routes/browser-&lt;feature&gt;.ts, narrow safe DTOs, direct application-service call, validation, app tenancy, and audit-safe data.
3. Mount it before static UI in `apps/core/src/control/server/index.ts`, including Bearer rejection/no-store.
4. Read: `activeSession` + `browserRoleAllowsScope`; mutation: shared Origin/CSRF guard plus hosted recent-reauth.
5. Classify its Control scope in `apps/core/src/control/server/browser-scope-policy.ts` and add unit boundary tests under apps/core/test/unit/auth/browser-*-routes.test.ts.

A third UI role requires widening `BrowserSession`, `isBrowserRole`, auth access types/options, and all role capability guards; the server decision and scope policy must change too—today both explicitly model only two roles.

Testing: web uses Vitest only (`pnpm --filter @gantry/web test`), with static/source-contract tests rather than Playwright or browser-interaction tests: `apps/web/vitest.config.ts`. For a `user_facing: true` story, implementer tests + verify + three reviews are required; then functional-checker validates visible/end-to-end behavior and records a 0–10 artifact, requiring score ≥8 and acceptance evidence: `docs/QUALITY.md`, `factory/prompts/tester-functional.md`.

## Onboarding flows: CLI today, browser needs

Browser onboarding is not a frontend hookup yet: the needed durable `/v1` operations mostly exist, but browser sessions are blocked from them and no browser facade exists for agents, channel accounts, installs, approvers, People, or offboarding.

| Step | Inputs | Existing API/CLI | Missing for browser | Notes |
|---|---|---|---|---|
| Create agent | Required today: `appId`, nonblank `name`; optional `agentHarness` (`auto\|anthropic_sdk\|deepagents`) | `POST /v1/agents` generates `agent:<UUID`, active status; CLI setup also asks name (≤80) and model | Same-origin `/ui/api/agents` facade; one atomic/create workflow that also writes desired state | API does not accept persona, model alias, access preset, tool rules, or profile. Those are desired-state fields via CAS `PUT/POST /v1/settings/desired-state`; defaults export as persona `developer`, access `full`, model/harness inherited. Profile files are separate `PUT /v1/agents/:id/profile-files/{soul\|agents}`. |
| Connect Provider Account | Agent, provider, label; refs for provider secrets; optional config, external identity, enabled | `POST /v1/provider-accounts`; CLI `provider account connect <provider> --agent … --secret-ref key=ref` | Browser account facade plus provider-specific connect/validation flow | Validates agent/app, supported provider, ref targets; creates active account and syncs settings. CLI default label is `<Provider> Provider Account`; id is generated. |
| Create/use secret refs | Existing ref string: `gantry-secret:`, `env:`, or `aws-sm:` | CLI prompts for plaintext, then stores encrypted Gantry secret, writes `.env`, or records AWS reference | Secret-reference picker and/or dedicated secret-ingest endpoint | **No, not today:** a browser cannot create a Gantry-held provider secret ref without a new server-side endpoint. ADR 0135 is only for model-provider credentials; it prevents secrets being returned, but the browser still submits a newly entered value. A pre-existing AWS secret reference can be selected without exposing its value. |
| Discover and install a conversation | Provider account; search/query or manual ID; install: display name, trigger, requires-trigger, memory scope, optional thread | `POST /v1/provider-accounts/:id/discover-conversations`; `GET /v1/conversations`; `PUT/PATCH/DELETE /v1/agents/:agentId/conversation-installs/:conversationId` | Browser facades for all operations | Discovery uses Slack credentials / Teams Graph and upserts discovered conversations. Install defaults to conversation’s account, display name/title, `memoryScope: conversation`, `status: active`; validates agent/account/conversation ownership and duplicate/thread rules; syncs revision and projects runtime. |
| Scope approvers, owner, pause | Approver user IDs; proposed owner `PrincipalRef`; install status | `GET/PUT /v1/conversations/:id/approvers`, body `{userIds}` (max 200) | Browser facade; conversation owner model/API; explicit pause/resume API | Approvers live in `conversation_approvers` (the desired-state `control_approvers` projection); membership is validated. A disabled install is the closest current “pause”; job pause/resume is unrelated. No conversation owner exists today. |
| Connector Account + OAuth | Connector kind, exactly one owning agent, label, external identity, scopes, secret refs | None | Connector Account CRUD, OAuth start/callback/status/revoke, secret projection, MCP binding | Spec requires authorization-code + PKCE + state, declared-scope validation, encrypted refresh refs, and redacted audit. Existing Google console login/Vertex credentials must not be reused. |
| People and offboard | People pagination; aliases; merge inputs; offboard `personId` | Bearer-only: `GET /v1/people`, `GET /v1/people/:id`, alias add/retire, merge preview/apply, unmerge | `/ui/api/people` facade and the offboard use case/UI | `people:read/admin` are browser-eligible in policy but have no handler. Web People pages are fixture previews. Agent offboarding is specified, not implemented: atomically retire aliases, remove installs, disable accounts, revoke grants, cancel jobs, set offboarded, and emit audit/event/outbox. |

Recommended minimum wizard screens:

1. **Employee** — name; model alias; access preset (`full` default or `locked`); harness (`auto` default). Keep persona and profile optional/advanced.
2. **Channel seat** — provider, account label, required secret references, then provider validation. For Teams: client ID, tenant ID, and secret reference; Azure Bot/manifest and public endpoint remain deployment prerequisites.
3. **Scope** — search discovered conversations or enter an ID; choose the one conversation; memory scope (default `conversation`); trigger/default `@agentName`.
4. **Approvals** — one or more verified conversation approvers. Do not present an “owner” field until it has a real model and API.
5. **Review and activate** — show agent, account, conversation, approvers, and access; write only after confirmation; verify the native identity responds.
6. **Directory/offboard** — service Person and aliases, with the administrator-only offboard action once implemented.

Safe CLI deferrals for V1.0: provider-secret provisioning/rotation, advanced profile editing, non-default harness/model/tool selection, connector OAuth, People alias/merge administration, and Teams/Slack discovery beyond manual conversation ID.

Do not defer from the browser if the video must genuinely show “onboard → scope → approve → offboard”: basic agent creation, installing/scoping a conversation, setting approvers, and atomic offboarding all need browser facades. For a Teams Adaptive Card video, the real Teams transport, Azure Bot setup, and card-submit approval path are also mandatory; the current spec says the transport is still a stub.

## Directory, access, audit, people read models

Read-only exploration complete; no files changed.

### Directory read model (`/agents`)

| Column | Runtime source today | Exists / needs |
|---|---|---|
| Agent | `agents` + `GET /v1/agents` (`apps/core/src/adapters/storage/postgres/schema/agents.ts`, `apps/core/src/control/server/routes/agents.ts`) | Exists; browser facade needs UIFACADE-1 |
| Kind / service Person | `users.kind` supports `human|service`, but no immutable `agentId → Person` binding | Needs IDENT-2 |
| Aliases by kind | `user_aliases(provider, providerAccountId, externalUserId)` exists, including retirement state | Needs IDENT-2 for agent/provider-account/connector-account aliases |
| Conversation installs | `conversation_installs`; live per-agent route is `GET /v1/agents/:id/conversation-installs` (`apps/core/src/adapters/storage/postgres/schema/providers.ts`) | Exists; facade needs UIFACADE-1 |
| Status | Agent table has only `active|disabled`; preview’s pause is non-persistent | `active/disabled` exists; `paused` needs RBAC-1; `offboarded` needs IDENT-2 |
| Access preset | Desired-state agent config `accessPreset: full|locked` (`apps/core/src/config/settings/runtime-settings-types.ts`) | Exists; needs live facade |
| Tool-rules summary | Desired-state `toolRules`; effective sources/capabilities/tool access from `GET /v1/agents/:id/access` (`apps/core/src/control/server/routes/capability-catalog.ts`) | Exists; needs live facade |
| Owner | No agent-to-PrincipalRef relation | Needs RBAC-1 |
| Approvers | `conversation_approvers.external_user_id`, per conversation—not principals (`apps/core/src/adapters/storage/postgres/schema/conversations.ts`) | Needs IDENT-2 + RBAC-1 |
| Current-month tokens | `/v1/usage?from=&to=&agentId=`, aggregating `runtime_events` (`apps/core/src/control/server/routes/usage.ts`) | Exists for display; needs COST-1 |
| Last run | `agent_runs.agent_id/started_at`; no per-agent list/last-run API (`apps/core/src/adapters/storage/postgres/schema/runs.ts`) | Storage exists; needs read-model/facade |

The live directory should be one paged row projection, not today’s N+1 `/agents`, `/admin`, `/access`, installs, usage, and runs calls.

### Agent detail and Access tab

| View | V1.0 read-only fields | Later editable surface |
|---|---|---|
| Existing detail | Fixture-backed tabs: Identity, Profile, Sources, Capabilities, Skills, MCP, Access, Conversations (`apps/web/src/features/agents/routes/agent-detail-route.tsx`) | All visible controls only open the connection gate |
| Access | Preset; tool-rules summary; selected capability grants; tool/MCP/skill sources; install scope; connector-account state as “unavailable” until CONN-1 | Replace access document, modify bindings/rules, connect/disconnect accounts—admin, CSRF/Origin/reauth/audit |
| Guardrails | Preview cards for sandbox, egress, permission evaluation, denylist (`apps/web/src/features/runtime/routes/guardrails-route.tsx`) | Not an access editor; fixture-only and its buttons do not persist |

The real Control API already has bearer-only `GET|PUT /v1/agents/:id/access`; browser sessions are explicitly rejected from `/v1/*` (`apps/core/src/control/server/index.ts`).

### Audit read model

| Source | Unified row contribution | Agent filter today |
|---|---|---|
| `runtime_events` | `time, actor, eventType/action, agent/run/conversation target, payload/outcome` | Row has `agent_id`, but generic list lacks an `agentId` filter (`apps/core/src/adapters/storage/postgres/repositories/runtime-event-repository.postgres.ts`) |
| `permission_audit_events` | decision, actor, event type, payload, time | No reader or HTTP route |
| `permission_decisions` | decision/reason/effect/approver/run/tool/expiry | Get-by-ID only; no list, agent, conversation, or recency filter |
| `mcp_server_audit_events` | agent/server/binding/actor/reason/metadata/time | Repository filters only app/server/cursor, not agent/conversation |
| `person_merge_audit` | source/target Person, scalar actor, result snapshot/time | No list/read API; not agent-scoped |
| Identity audit | `IDENTITY_*` events are in `runtime_events`; no separate table | Same missing agent filter |

Target facade row: `time, actor: PrincipalRef, action, target {agent/person/resource}, conversation?, outcome, source, detail`. `PrincipalRef` itself needs AUDIT-1/IDENT-2; stored actors are currently mixed strings.

### People, approvals, and usage

| View | V1.0 minimum | Gap / V1.0.x |
|---|---|---|
| People | `/v1/people` returns paged people, kind, status, aliases—including retired aliases—and memory counts; `/v1/people/:id` returns detail (`apps/core/src/control/server/routes/people.ts`) | No browser facade: add `/ui/api/people` list/get; offboard action needs IDENT-4, reauth, CSRF/Origin, audit |
| Approvals | Read-only session conversation list can show pending interactions: time, tool, summary, expiry, available decisions | No per-agent/conversation queue or recent history. `pending_interactions` is app/run scoped; session route filters all-app rows in memory (`apps/core/src/control/server/session-interaction-approvals.ts`). No browser approval authority in V1.0. |
| Usage | Month picker, agent, request count, input/output tokens; label UTC range aggregation | COST-1 is V1.0.x display work. Mark memory extraction/dreaming and permission-classifier calls as **uncounted**: they report `onUsage` but do not emit `model.usage` (`docs/architecture/ai-employee-v1-gap-analysis.md`). |

Minimum screens: V1.0 live AI-employee directory, read-only Agent tabs (Overview, Access, Audit, Approvals), and People list/detail. V1.0.x adds usage, access editing, approval inbox/authority, and action controls only after their underlying IDENT-2, RBAC-1, IDENT-4, COST-1, and browser-facade work lands.

## Roles, connector accounts, sovereign, cost surfaces

Read-only audit complete; no files changed. Key conflict: active Decision 0132 still fixes two roles, while the confirmed RBAC spec requires three—reconcile that before implementation.

### 1. Sign-in and access administration

| Screen/control | Exists | Needs | Facade route(s) | Story |
|---|---|---|---|---|
| Sign-in | Partial: local one-time link; hosted generic PKCE/OIDC but Google-branded, one active issuer. `apps/web/src/features/auth/auth-pages.tsx`, `apps/core/src/control/server/browser-oidc.ts` | Issuer picker/label, multiple issuers incl. Entra | Existing `/auth/oidc/start`, callback; extend issuer-aware start | RBAC-1 |
| Authentication & Access | Yes: admin settings can test/activate one issuer, invite, list/disable grants and sessions. `apps/web/src/features/auth/authentication-access-route.tsx` | “Users & roles” is this page, but add `approver`, issuer collection, per-issuer `hd`/`tid` auto-grant policy, access/audit identity view | Existing `/ui/api/auth/config*`, `/access`, `/invitations`, `/sessions`; extend payloads | RBAC-1 |
| Access request/approval | Partial: ungranted login gets `GNT-…` reference; CLI `gantry auth access approve <ref> --role administrator\|viewer`; browser invitations/grant edits exist. `apps/core/src/control/server/routes/browser-auth.ts` | `approver` role in CLI, DB, browser unions and grant editor; no browser risky-action approval inbox in V1 | Existing auth facade; keep risky approvals API-key-only | RBAC-1 |
| Issuer policy | Missing: one `activeOidc.companyDomain`; adapter reads Google `hd`, not Entra `tid`. `apps/core/src/config/settings/runtime-settings-types.ts` | Per-issuer tenant/domain claim policy, issuer CRUD and test/activate lifecycle | Extend `/ui/api/auth/config/*` | RBAC-1 |

### 2. Agent owner, pause/resume, approvers

| Screen/control | Exists | Needs | Facade route(s) | Story |
|---|---|---|---|---|
| Directory row | Preview-only agent list; no owner, approvers, usage, or live mutation. `apps/web/src/features/agents/routes/agents-route.tsx` | Show status, owner, monthly usage; row pause/resume only as a quick action | New `GET /ui/api/agents`, `PATCH /ui/api/agents/:id/status` | RBAC-1, DIR-UI-1 |
| Agent detail | Preview pause button is connection-gated. `apps/web/src/features/agents/routes/agent-detail-route.tsx` | Put owner assignment, approver assignment, pause/resume, and offboard here; this is the primary control surface | New `PATCH /ui/api/agents/:id/{owner,status,approvers}`, plus principal picker read route | RBAC-1, DIR-UI-1 |
| Authorization | Missing | Owner may pause/resume and assign approvers; administrator may do both and offboard | Browser facade must enforce owner-or-admin; reuse atomic offboard use case | RBAC-1 |

### 3. Connector Accounts

| Screen/control | Exists | Needs | Facade route(s) | Story |
|---|---|---|---|---|
| MCP Servers | Yes: remote/local source add, sanitized credential mappings, bindings, diagnostics, replace/disable. `docs/specs/mcp-management-web-ui.md`, `apps/web/src/features/operations/routes/mcp-servers-route.tsx` | Keep separate: generic MCP bindings are optional/many-agent; a connector account must have one owning agent | Existing `/ui/api/mcp-servers*` remains source management | — |
| Connector Accounts list/detail | Missing | Configure > Connector Accounts: kind, account label, owner, external identity, scopes, OAuth status, generated MCP/binding, alias/audit, supervisor health/capacity | New `GET/POST /ui/api/connector-accounts`, `GET/PATCH/DELETE /:id`, health in list/detail | CONN-1 |
| Connect/revoke OAuth | Missing | “Connect” → authorization-code PKCE → callback → verified/failed status; reauthorize, revoke, retire; never show tokens or transport controls | `POST /:id/oauth/authorize`, callback endpoint, `POST /:id/revoke` | OAUTH-1, CONN-GSUITE-1 |

The generic local-process form must not become the connector UI: its stdio execution is not yet available, whereas Decision 0141 requires in-repo-only, per-account supervised stdio with health, backoff, retirement, and capacity.

### 4. Sovereign provider and egress

| Screen/control | Exists | Needs | Facade route(s) | Story |
|---|---|---|---|---|
| Model Providers | Yes: registry-backed provider list, write-only credential update, disable/remove, verify. `apps/web/src/features/operations/routes/providers-route.tsx`, `apps/core/src/control/server/routes/browser-model-providers.ts` | `openai_compatible` is not implemented, but once registered its Base URL + secret-ref fields and verify action fit this dialog with little/no special UI work | Existing `GET /ui/api/model-providers`; `PUT/PATCH/DELETE /:id`; `POST /:id/verify` | SOV-1 |
| Effective egress policy | Missing live surface. Diagnostics and Runtime Guardrails are preview data. `apps/web/src/features/operations/routes/diagnostics-route.tsx` | Read-only effective allowlist/default-deny result, protected components, and named violations; requires enforcement first | New browser-safe `GET /ui/api/doctor` or `/ui/api/runtime/egress-policy` | EGRESS-1 |

`/v1/doctor` is Bearer-only and currently reports only storage/auth; it cannot supply the required egress proof without both backend expansion and a browser facade.

### 5. Cost and secrets

| Screen/control | Exists | Needs | Facade route(s) | Story |
|---|---|---|---|---|
| Monthly agent usage | Missing: `/agents` is preview-backed and no page calls `/v1/usage`. `apps/core/src/control/server/routes/usage.ts` | Add a current-month token panel to agent detail, with a compact value in the directory row and incomplete-path disclosure | New `GET /ui/api/usage?agentId&from&to&group_by=agent` wrapping `/v1/usage` | COST-1 |
| V1.1 cap | Missing | Put cap alongside that detail “Usage & budget” panel, not runtime Capacity; needs a durable per-agent limit and enforcement story | New `PATCH /ui/api/agents/:id/usage-cap` | NEW: COST-2 UI |
| Secret references | Partial pattern only: provider values are write-only and never returned; MCP maps named credentials without values. `apps/web/src/features/operations/routes/provider-dialogs.tsx` | No reusable secret-ref component exists. Add a small shared validated `SecretRefField` for `env:`, `gantry-secret:`, or `aws-sm:` references; retain write-only input for raw-secret modes | Reuse model-provider facade pattern; connector/provider schemas validate refs | CONN-1, SOV-1 |

New roadmap UI story: **UI-CONN-ACCOUNTS-1**. CONN-1/OAUTH-1 define the account platform and OAuth behavior, but neither existing MCP management UI nor directory UI supplies the distinct account lifecycle, owner binding, OAuth receipt, and supervisor-health surface.


# Part 3 — roadmap review, product lens (2026-08-27)

Two independent read-only reviews of the 30-story roadmap: a Fable product review from the docs and a Codex review checking each journey against code. Resolutions: INTRO-1, BOOTSTRAP-1, INCIDENT-1, ADMIN-ALERT-1, OPS-DR-1 added to V1.0; LIFECYCLE-1, REVISION-1, SELF-1 to V1.0.x; MEMORY-CONSENT-1, QUAL-1, SUPPORT-1 to V1.1; decisions 0144–0149 proposed; acceptance criteria amended on HITL-1, RBAC-1, TEAMS-1, EGRESS-1, COST-1, WA-1, GUARD-1, DOCS-1, PKG-1 and the console stories (WCAG AA).

## Fable — product lifecycle review

| # | Gap | Why it matters | Milestone | Proposal | Severity |
|---|---|---|---|---|---|
| 1 | The AI employee never introduces itself; no first-contact story; Teams manifest branding only implied | The video opens on this moment; trust in a regulated org starts with disclosure | V1.0 | INTRO-1 intro card, about/help, manifest identity | blocker |
| 2 | Kill switch is per-agent, console-only; no deployment-wide freeze that works when console/IdP is down; paused agents say nothing | First security review: "how do you stop all of it in 60 seconds at 2am?" | V1.0 | INCIDENT-1 freeze/unfreeze, paused replies, approver pause from card | blocker |
| 3 | No backup/restore, upgrade with migration safety, version pinning, rollback; decision 0003 contradicts tagged releases | A failed upgrade with no restore path ends the engagement | V1.0 | OPS-DR-1; amend 0003 | blocker |
| 4 | Admins never told anything until COST-2 (V1.1) | The first incident happens silently | V1.0 | ADMIN-ALERT-1 one admin conversation, named events | blocker |
| 5 | Retention/deletion is person-shaped only; no erase for anonymous WhatsApp callers; no deployment decommission | DPDP/GDPR requests arrive the week WhatsApp goes live | V1.0.x | LIFECYCLE-1 | blocker |
| 6 | No quality signal: no feedback, sampling, resolution rate | Renewal needs more than "it didn't crash" | V1.0.x/V1.1 | QUAL-1 | should |
| 7 | Persona/prompt change control undefined: no versioning, diff, rollback | "Who changed what the agent is told to do" is the second audit question | V1.0.x | REVISION-1 | should |
| 8 | Approval expiry/reminder/fallback approver; last approver offboarded | Stuck approvals block work; dead approver silently disables the agent | V1.0 | HITL-1/RBAC-1 AC | should |
| 9 | Customer Teams tenant prerequisites (consent, catalog, least-privilege list) not a story | The customer's Teams admin, not KnackLabs, must click consent | V1.0 | TEAMS-1/DOCS-1 AC | should |
| 10 | Security packet thin: SBOM, licence report, disclosure policy, data-flow, no-telemetry statement | Procurement in BFSI is a questionnaire | V1.0.x | DOCS-1/PKG-1 AC | should |
| 11 | Open-core boundary undecided (voice engine licence, NOTICE) | Surprises poison OSS trust and contracts | V1.0 decision | decision 0149 | should |
| 12 | No support bundle, release notes, support tiers | "How do I send you a bug" | V1.1 | SUPPORT-1 | should |
| 13 | Multi-language for India (Hindi/Hinglish/Tamil), templates per locale, IN PII defaults | Support-assistant proof is for Indian clients | V1.0.x | WA-1/GUARD-1 AC | should |
| 14 | WhatsApp AI disclosure and privacy line on first contact | Meta policy and DPDP expect disclosure | V1.0.x | WA-1 AC | should |
| 15 | Cost-centre tag, CSV export, access-review export before V1.1 | Monthly/quarterly rituals hit at first renewal | V1.0.x | COST-1 AC | should |
| 16 | "Scope" in the video is a preset switch only; tool rules are CLI until ACCESS-UI-1 | "Where do I take away Drive?" | V1.0 | script the video honestly | should |
| 17 | No accessibility criteria | Gov/BFSI procurement asks WCAG AA | V1.0 | UI story AC | nice |
| 18 | No clone/duplicate agent for the 2nd–10th employee | Expansion friction | V1.0.x | later | nice |
| 19 | First-admin bootstrap and break-glass undocumented | Day-0 friction; audit question | V1.0 | DOCS-1 AC / BOOTSTRAP-1 | nice |

Verdict: V1.0 video sufficient on the admin side, not on the employee side (#1, #16). First client: not sufficient — product but not its operation (#2, #3, #4, #7, #10). Self-serve outsider: stalls at Teams/Entra admin steps, Day-0, first upgrade. Biggest add: the day-two pair OPS-DR-1 + ADMIN-ALERT-1 with INCIDENT-1.

## Codex — journeys checked against code

Read-only review complete; no files changed or tests run. I checked all 30 `ai-employee-v1` stories against the listed specs and code.

| # | Journey step | Exists today (path) | Roadmap coverage | Gap / contradiction | Severity (blocker/should/nice) | Proposed story or decision |
|---|---|---|---|---|---|---|
| 1 | Decision authority | 0136–0137 accepted; 0138–0143 remain `proposed` (decisions 0138–0143) | Many V1 stories rely on them | Handover calls all binding; the active-decision command excludes 0138–0143 | blocker | Accept, revise, or remove 0138–0143 before planning dependent stories |
| 2 | Org/app bootstrap | Seeded “Default Local App” / `personal` (`apps/core/src/adapters/storage/postgres/seeds.ts`) | PKG-1 only | No organisation-scoped bootstrap; default personal app conflicts with IT-owned org positioning | blocker | `BOOTSTRAP-1` + deployment-app identity decision |
| 3 | First administrator before IdP | Local one-time admin URL; OIDC approval via `gantry auth access approve` (`apps/core/src/cli/auth.ts`, `auth-access.ts`) | PKG-1, RBAC-1 | No tested local-admin → configured IdP → first real admin journey; invitations require an existing admin | blocker | `BOOTSTRAP-1`; add first-Entra-admin acceptance to RBAC-1 |
| 4 | Initial secrets | CLI setup/key custody; provider facade is write-only (`onboarding-config.ts`, `browser-model-providers.ts`) | ONBOARD-UI-1 relies on 0143 | Browser cannot safely ingest a Teams/Slack seat secret; 0143 is proposed | blocker | Accept 0143; include custody/rotation proof in `BOOTSTRAP-1` |
| 5 | Browser onboarding dependency order | Console is preview-backed (`apps/web/src/features/agents/agents-queries.ts`) | ONBOARD-UI-1 | Wizard requires an administrator, but does not depend on RBAC-1 | blocker | Add RBAC-1 dependency; require it in end-to-end video proof |
| 6 | Teams seat works | SDK factory returns `null` (`apps/core/src/channels/teams-sdk-client.ts`) | TEAMS-1, TEAMS-E2E-1 | Correctly planned, but no present Teams V1 capability | blocker | Keep TEAMS-1/TEAMS-E2E-1 as release prerequisites |
| 7 | Teams DM discovery | Discovery lists teams/channels, not chats (`teams-setup-discovery.ts`) | None | Unregistered DMs are dropped; no personal-app/DM first-contact contract | blocker | Teams first-contact decision + `TEAMS-DM-UX-1` |
| 8 | First greeting / “who are you?” | Generic prompt identity only (`gantry-agent-system-prompt.ts`) | None | No deterministic employee identity, access, capability, or data-use answer | should | `TEAMS-DM-UX-1`, derived from effective capability catalog |
| 9 | Report a bad answer | Observer-digest feedback exists (`teams-message-actions.ts`) | None | It is insight feedback, not reply-bound answer feedback | should | `EMP-FEEDBACK-1` with audited correction and review-only learning |
| 10 | Opt out of personal memory | DMs default to user memory (`app-memory-subject-resolver.ts`) | None | No data-subject opt-out; proactive-alert opt-out is unrelated | blocker | `PERSONAL-MEMORY-CONSENT` decision + `MEMORY-CONSENT-1` |
| 11 | Pause everywhere / per conversation | Jobs pause individually; installs only `active|disabled` (`job-management-service.ts`, `provider-conversation-routes.ts`) | RBAC-1; HANDOFF-1 promises conversation pause | No atomic agent/global pause, in-flight semantics, or distinct handoff pause state | blocker | `INCIDENT-1`; amend HANDOFF-1 |
| 12 | Incident alert and evidence | Job-specific delivery routes; capped runtime-event reads (`apps/core/src/jobs/delivery.ts`) | REPORT-1 in V1.1 | No admin incident recipient/deduplication or incident export bundle | should | Add to `INCIDENT-1`; amend REPORT-1 |
| 13 | Revert persona/prompt/access | Revisioned desired state (`settings-fleet-import.ts`) | ACCESS-UI-1 | Revisions list metadata only; no operator restore; code explicitly says no generic rollback | blocker | `REVISION-RECOVERY-1`—append a CAS-fenced corrective revision |
| 14 | Backup/restore and bad-release recovery | Safe serialized migrations (`postgres-migrate.ts`, `ops/docker/entrypoint.sh`) | None | No backup, restore drill, downgrade/forward-fix policy, or release recovery runbook | blocker | `OPS-DR-1` |
| 15 | Version-pinned deployment rollback | Build inputs pinned; mutable deployment tag (`ops/docker/Dockerfile`, deployment workflow) | PKG-1 partial | No selected prior digest, rollback command, or signed release manifest | should | `OPS-RELEASE-1` |
| 16 | Secret rotation | Model credential rotation exists (`apps/core/src/cli/credentials.ts`) | 0143 / ONBOARD-UI-1 partial | No generic dependency-aware rotate→verify→activate→retire lifecycle | should | `SECRET-LIFECYCLE-1` |
| 17 | Retention and deletion | 30-day live-admission sweep; tool-event deletion only (`live-admission-retention.ts`, `runtime-event-repository.postgres.ts`) | IDENT-4 covers person erasure only | No policy/hold/purge for messages, memory, or general audit | blocker | Data-lifecycle ADR + `LIFECYCLE-RETENTION-1` |
| 18 | Customer contract-end export | Per-agent audit export only planned in V1.1 REPORT-1 | REPORT-1 | No tenant export, deletion certificate, delivery expiry, or explicit exclusions | should | `LIFECYCLE-EXIT-1` |
| 19 | Sovereign egress / telemetry | Default-allow egress; OTLP can export content (`egress-gateway.ts`, `tracing.ts`) | EGRESS-1 in V1.0.x | No current default-deny proof for SDK, telemetry, MCP, browser, sandbox/direct paths | blocker | Expand EGRESS-1 with fail-closed no-connect proof |
| 20 | Evals, thumbs, conversation review | Observer and memory-review primitives exist | None | No response evals, thresholds, review workflow, or prompt/model revision linkage | should | `QUALITY-DECISION-1`, `EVAL-1`, `CONVERSATION-REVIEW-1` |
| 21 | Reviewable learning promise | Dreaming can auto-promote candidates (`app-memory-dreaming.ts`) | None | Contradicts brief: learning is reviewable, “never autonomous drift” | blocker | `MEMORY-GOVERNANCE` decision + console review facade |
| 22 | Hindi/regional WhatsApp | No WhatsApp or localisation implementation | WA-1, HANDOFF-1 | No BCP-47 preference, Indic fixtures, localized templates, or translation/egress decision | should | `WA-LANG-1` + translation-ownership decision |
| 23 | Console accessibility | Some accessible primitives exist | DESIGN-1, DIR-UI-1, ONBOARD-UI-1 | No WCAG target or keyboard, screen-reader, contrast, zoom, and assistive-tech acceptance | should | `A11Y-1` as V1 prerequisite |
| 24 | Calendar month/cap time zone | Usage is arbitrary ISO range and UTC grouping (`usage.ts`, `runtime-event-repository.postgres.ts`) | COST-1, COST-2 | No explicit month-boundary/display-zone contract or cap-ledger semantics | should | `COST-CALENDAR-1`; make COST-2 depend on it |
| 25 | MIT, SBOM, procurement | MIT `LICENSE`; CI produces CycloneDX SBOMs (`.github/workflows/ci.yml`) | PKG-1 provenance only | SBOMs are CI artifacts, not release-bound procurement evidence | should | `PROC-1` or amend PKG-1/DOCS-1 |
| 26 | WhatsApp release sequence | Accepted 0136 says WhatsApp and voice together in V1.1 | Handover/roadmap place WA-1/HANDOFF-1 in V1.0.x | Direct release-milestone contradiction | blocker | Amend/supersede 0136 or move WhatsApp chain to V1.1 |

Verdict:

- V1.0 video: not sufficient—core stories exist, but bootstrap, decision acceptance, secret ingest, and real Teams transport lack a joined proof path.
- First client deployment: not sufficient—incident containment, recovery, retention, personal-memory consent, and sovereign egress are unowned release risks.
- Self-serve outsider: not sufficient—backup/restore, lifecycle exit, release rollback, and procurement evidence are missing.
- The highest-leverage first move is to accept/reconcile 0138–0143, then add `BOOTSTRAP-1`, `INCIDENT-1`, and the lifecycle/DR stories.
- The WhatsApp V1.0.x versus V1.1 conflict needs an explicit human decision before any sequencing work.
