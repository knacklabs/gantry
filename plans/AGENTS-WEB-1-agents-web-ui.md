---
decisions_reviewed: [0000-credential-broker-boundary, 0001-agent-runtime-platform, 0002-symphony-forge-adoption, 0003-early-stage-no-backcompat, 0004-gantry-naming-and-public-repo, 0005-runtime-stack, 0006-config-secret-source-boundary, 0007-settings-runtime-truth, 0008-storage-backend-cutover, 0009-canonical-domain-schema-cutover, 0010-claude-runtime-materialization, 0011-provider-session-artifact-store, 0012-browser-capability-boundary, 0013-runtime-event-exchange, 0014-external-ingress-vs-outbound-webhooks, 0015-model-catalog-and-cache-accounting, 0016-event-bus-outbox-boundary, 0017-jsonb-runtime-payload-boundary, 0018-provider-neutral-agent-execution-adapter, 0019-simple-permission-and-job-tool-lifecycle, 0020-mcp-source-vs-action-capability, 0021-capability-artifacts, 0022-delivery-vehicle, 0023-deployment-modes, 0024-locked-preset, 0025-settings-authority, 0027-process-roles-and-multi-live, 0028-agent-harness-selection, 0029-agent-communication-reaction-binding, 0030-agent-communication-reasoning-safety, 0031-send-message-files-authority, 0032-signed-artifact-links-deferred, 0033-teams-reactions-deferred, 0034-client-signoff, 0035-epics-approved, 0040-permission-execution-two-axis-model, 0041-client-signoff, 0042-decision-view-16k-prefix-stripped, 0043-classifier-risk-only-engine-authz, 0044-ci-runner-isolation, 0045-inbound-attachment-descriptor-writer, 0046-llm-process-local-admission, 0050-agent-removal-projection-cleanup, 0051-client-signoff, 0052-birthright-self-surface, 0053-permission-no-timeout-interactive, 0054-decision-provenance-and-risk-label, 0055-client-signoff, 0056-durable-cancellation-invariant, 0057-arch1-client-signoff, 0058-readonly-scheduler-birthright, 0062-perm6-client-signoff, 0063-perm7-client-signoff, 0064-client-signoff, 0065-perm8-client-signoff, 0066-race-1-skill-artifact-app-isolation, 0067-client-signoff, 0068-race-2-cluster-fenced-settings-projection, 0069-client-signoff, 0070-client-signoff, 0071-race-4-browser-profile-lock-aba, 0072-client-signoff, 0073-race-6-profile-mirror-version-guard, 0074-race-8-mandatory-atomic-async-admission, 0075-race-9-serialize-file-backed-settings-write, 0076-client-signoff, 0077-race-5-lease-loss-lifecycle, 0078-lat-3a-single-memory-hydration-per-turn, 0079-client-signoff, 0080-lat-3b-retain-authoritative-second-fetch, 0081-client-signoff, 0082-fence-1-durable-lease-generation, 0083-conv-001-client-signoff, 0084-client-signoff, 0085-lat-4a-fused-inbound-envelope-transaction, 0086-client-signoff, 0087-lat-5-durable-provider-history-coverage, 0088-client-signoff, 0089-thread-turns-read-channel-context, 0090-sender-allowlist-trigger-only, 0091-client-signoff, 0092-client-signoff, 0093-client-signoff-is-a-pinned-project-gate, 0094-conversation-file-trust-program, 0095-client-signoff, 0096-thread-recency-message-timestamp, 0097-public-session-conversation-aggregate, 0098-streamed-message-projection-timing, 0099-rate-limits-singleton-authority, 0100-mig-1-client-signoff, 0101-oidc-generic-google-first, 0102-runtime-hardening-audit-harvest, 0103-live-admission-terminal-retention, 0104-co-1-recovery-intent-reframe, 0105-physical-attachment-workspace-handoff, 0106-scheduled-runs-cannot-mutate-jobs, 0107-typed-permission-decision-provenance, 0108-job-definition-revision-fencing, 0109-semantic-capability-job-dependencies, 0110-live-ux-capability-dispatcher, 0112-legacy-single-canonical-shape, 0113-enforce-no-backcompat-architecture-check, 0114-canonical-job-owner, 0115-autonomous-tool-denial-terminal, 0117-scheduled-job-declare-tools-at-creation, 0118-identity-scoped-approval-and-grants, 0119-provider-neutral-group-approver-bootstrap, 0120-local-cli-structured-invocation, 0121-autodet-no-classifier-autonomous, 0122-capability-template-amendment, 0123-recovery-proposal-birthright, 0124-bounded-durable-card-delivery, 0125-host-only-template-amendment, 0126-typed-terminal-denial-event, 0127-tagged-setup-action-model, 0128-permission-approval-result, 0129-capsafe-local-cli-terminal-wildcard, 0130-capsafe-capability-run-dispatch-only, 0132-adaptive-browser-authentication-access, 0133-gantry-tool-correlation-response-meta, 0135-browser-model-provider-credential-facade]
---

# AGENTS-WEB-1 Plan: Truthful Agents Management UI

## 1. Problem

The current Web Agents routes are fixture-backed previews whose create, edit,
pause, and source actions stop at a connection gate. Gantry needs a real,
same-origin administrator workflow for durable agent configuration and reusable
role templates. The workflow must be honest about what is persisted: a source
is inventory, a selected semantic capability is agent-owned authority, a
conversation is a separate installation, and a disabled agent preserves history
and rejects only new work.

## 2. Scope / Non-goals

In scope:

- Replace the fixture Agents routes with browser-facade-backed, URL-stateful,
  paginated Agents and Roles management screens.
- Add app-scoped custom role templates and snapshot selected role content into
  the agent's versioned prompt/profile state.
- Add browser-safe projections and mutations for agents, roles, source setup,
  capability selections, profile instructions, model, status, and read-only
  version history.
- Build the approved four-step creation flow and routed agent detail UI with
  loading, empty, failure, retry, validation, keyboard, and narrow layouts.
- Remove obsolete fixture data, preview queries, connection-gate actions, and
  controls with no real action from the shipped Agents surface.

Non-goals:

- No hard agent delete, profile/version restore, bulk actions, harness picker,
  role-to-agent live links, source installation, MCP connection, credential
  setup, capability-definition authoring, conversation creation, or job
  creation.
- No direct browser use of Bearer `/v1/*` routes, raw settings writes, or
  parallel authorization model.
- No compatibility shim for the preview contract; the fixture-only route and
  tests are removed in the replacement task under decision 0003.

## 3. Acceptance Criteria

1. A browser-authenticated administrator can use a bounded server-paginated
   Agents directory with URL-backed search, status/role filters, sorting,
   page-size, load/empty/error/retry states, truthful totals, and a compact
   narrow-screen list.
2. Agent links open a routed Overview, Instructions, Access, and Settings
   detail page that projects only real data. Version history is read-only and
   only shows real snapshots.
3. Built-in roles are canonical read-only prompt projections. Custom roles can
   be created, viewed, edited, duplicated, searched, paginated, and deleted;
   existing agents retain their snapshots after template change or deletion.
4. Step 1 creates an active base agent with validated name, selected role
   snapshot, optional additional instructions, and optional model. Sources and
   capabilities save separately; later failure cannot erase earlier success.
5. Sources never imply tool authority; selected reviewed semantic capabilities
   remain durable agent authority and risky use may still require a runtime
   approval.
6. Browser reads use authenticated sessions; mutations require Administrator,
   canonical Origin, CSRF, and existing hosted reauthentication policy. DTOs
   expose no secrets, raw persistence records, or Bearer Control API access.
7. Every visible control navigates, changes observable local state, or calls a
   defined browser operation with progress, success, and failure states.
8. The shipped UI removes preview data, connection-gate controls, selected-agent
   side-panel patterns, no-op controls, design variant controls, and fabricated
   detail/version content.

## 4. Technical Approach

Create the smallest missing backend seam first: a role-template domain and
repository with app-scoped names and audit-safe records, plus role snapshots in
the agent profile/version model. Reuse the existing agent, profile, desired
state, source, capability, model, conversation, and audit services; do not
create a browser-specific source-of-truth.

Add narrow `/ui/api` browser routes next. They authenticate and authorize via
the existing browser boundary, map request values to application services, and
return explicit browser DTOs. They reuse the repository's page contract for
agent and role lists. Agent access uses existing `AgentAccessSummary` language;
the facade does not translate source inventory into authority.

Replace the Agents feature by responsibility: query/client DTO modules;
directory/role-library components; creation-step components; agent-detail
components; and small dialogs/drawers. Existing Web primitives, TanStack Router,
TanStack Query, React Hook Form only if already installed, Zod contracts,
Tailwind, and the shared DataTable/PageState/RouteTabs components are the best
fit because they are the project-standard, already-installed UI stack. No new
dependency is added.

## 5. Decisions

- No new decision record. The approved spec and accepted decisions 0003, 0020,
  0050, and 0132 already determine replacement, authority, removal, and browser
  trust behavior.
- Use existing React, TanStack Router/Query/Table, Zod, Tailwind, Vitest, and
  Playwright/agent-browser verification because they are installed, established
  in the Web feature architecture, and cover the required route, data, and UI
  tests without new runtime dependencies.
- Store custom roles as one app-scoped persistence domain because reuse across
  agents requires durable names/prompts; store agent role content as immutable
  version snapshots so editing/deleting a template cannot mutate running agent
  behavior.
- Reuse existing desired-state source/capability replacement boundaries rather
  than introducing an atomic wizard endpoint; this exactly preserves partial
  saves and the source-versus-authority model.
- The unrelated recurring `delivery-semantics` finding does not touch the
  Agents UI or its services. If this story's review produces a third finding in
  its own area, stop and create the required consolidation decision/refactor
  story rather than iterating a fourth local patch.

## 6. Surface Impact

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Agent role snapshots are compiled with protected runtime layers; source/capability authority remains unchanged in meaning. |
| API | Changed | New same-origin browser façade and paginated agent/role application/control contracts are required. |
| Data/schema | Changed | Custom role templates and agent role/version snapshot metadata require canonical persistence and migration work. |
| CLI/ops | Read-only | Existing CLI/profile/access behavior is reused as the reference; no new CLI UX is required. |
| UI | Changed | Replace fixture preview routes with the approved Agents, Roles, wizard, detail, dialog, and drawer screens. |
| Docs | Changed | Update architecture/API/product docs and remove preview-only guidance. |
| Tests | Changed | Contract, repository, application, browser-facade, UI, accessibility, responsive, and real local functional coverage are required. |

## 7. Task Decomposition

1. `AGENTS-WEB-1-1` — Add custom-role persistence, contracts, role-snapshot
   profile composition, and focused migration/application tests.
   `user_facing: false`. Serves criteria 3, 4, 5, and 8.
2. `AGENTS-WEB-1-2` — Add paginated agent/role application projections and
   same-origin browser façade reads/mutations with browser-boundary tests.
   `user_facing: false`. Serves criteria 1, 2, 3, 4, 5, and 6.
3. `AGENTS-WEB-1-3` — Replace fixture query/data modules with typed browser
   clients and build the Agents directory and Roles library screens.
   `user_facing: true`. Serves criteria 1, 3, 7, and 8.
4. `AGENTS-WEB-1-4` — Build the four-step agent-creation wizard with real
   independent saves, validation, role prompt preview, source/capability lists,
   access help, and review state.
   `user_facing: true`. Serves criteria 3, 4, 5, and 7.
5. `AGENTS-WEB-1-5` — Build routed agent detail, truthful access/instructions,
   settings, disable confirmation, and read-only version-history drawer;
   remove obsolete preview detail surfaces.
   `user_facing: true`. Serves criteria 2, 5, 7, and 8.
6. `AGENTS-WEB-1-6` — Add end-to-end route/UI coverage, real local functional
   flow, cleanup searches, accessibility/narrow-layout validation, and final
   documentation updates.
   `user_facing: true`. Serves criteria 1 through 8.

## 8. Risks

- Existing agent profile versions may not contain every historical field. The
  browser projection omits unavailable values rather than inferring them.
- Model availability, source readiness, and capabilities may change between
  list and save. Requests validate current server state and return a scoped
  error; the UI preserves unsaved non-secret input.
- Browser session and mutation security are sensitive. The new routes must use
  the existing browser policy composition, not duplicate validation.
- Migrations alter canonical persistence. Each migration includes schema, SQL,
  journal, snapshot, repository wiring, and migration checks.

## 9. Verify Plan

- Focused contract/repository/application tests for custom-role snapshots,
  pagination, source/capability separation, profile/version projection, and
  disable behavior.
- Browser facade tests for session versus Bearer rejection, Administrator
  mutation authorization, Origin/CSRF/reauth checks, sanitized DTOs, and scoped
  errors.
- Web unit/component tests for URL state, debounced fetches, filters,
  pagination, every wizard save/failure branch, role management, detail actions,
  dialogs/drawers, no-op-control cleanup, keyboard focus, and narrow layout.
- Real local browser smoke: create an agent, leave after Step 1, resume setup,
  attach a ready source, select a capability, inspect history/detail, disable,
  re-enable, refresh, and return to preserved directory state.
- Required gates: `python3 factory/scripts/verify.py`, one autoreview run,
  functional check, `python3 factory/scripts/pr_ready.py`, then Ponytail audit
  and review with all findings resolved before final handoff.
