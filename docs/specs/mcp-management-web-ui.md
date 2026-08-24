---
slug: mcp-management-web-ui
title: MCP Management Web UI
status: draft
saved: 2026-08-24T19:33:34+00:00
---

# MCP Management Web UI Design

## Status

Approved in interactive design review on 2026-08-25.

## Why

MCP sources are already manageable through Gantry's CLI and Bearer Control API,
but web-console operators need the same safe workflow without receiving an API
key, a secret value, or accidental authority to execute a source's tools.

## Behaviour

The web console provides a dedicated Configure page for sanitized MCP source
inventory. Viewers can inspect it. Administrators can connect remote or
approved local-process sources, optionally attach compatible agents with a
scope that can only narrow, run diagnostics, replace an immutable definition,
and disable a source. All browser mutations use the existing MCP application
service and settings projection. Connecting or binding a source never grants
semantic capability authority.

## Acceptance criteria

- Operators can manage MCP source inventory and agent source bindings from one
  dedicated web page.
- Browser access is session-bound, role-aware, CSRF/Origin protected, and
  never exposes Bearer credentials or raw secrets.
- Remote and local-process forms expose only backend-supported safe inputs.
- Source connection, binding, and semantic capability authority remain
  separate.
- Replacement and partial attachment failures are explicit and recoverable.

## Goal

Give Gantry operators one efficient browser page for connecting and managing
third-party MCP server sources without exposing Control API keys, raw
credentials, or low-level persistence records to the browser.

The first release supports both adding MCP servers and managing existing
servers. It uses real backend agents in attachment selectors even though the
broader Agents UI remains outside this work.

## Product Boundaries

An MCP server connection is source inventory, not tool-call authority. Attaching
the source to an agent also does not grant that agent permission to call its
tools. Durable action authority remains a separately reviewed semantic
capability mapped to exact MCP operations.

The page manages:

- app-wide MCP server definitions;
- agent MCP source bindings and per-agent narrowing;
- explicit diagnostics;
- disablement and guided configuration replacement.

It does not manage semantic capability authoring, raw secrets, agent identities,
background monitoring, or historical diagnostic results.

## Navigation And Page Structure

Add `MCP servers` under the existing `Configure` navigation group, beside Model
Providers. Use a dedicated page instead of putting MCP-specific transport,
credential, diagnostic, and binding controls inside the mixed `Sources &
access` catalog.

The desktop page uses the existing Gantry shell and a two-column workspace:

- left: searchable server inventory with `All`, `Active`, and `Disabled`
  status filters;
- right: the selected server's sanitized definition, attached agents, allowed
  tool names, diagnostics, replacement, and disable actions.

Only `active` and `disabled` are durable server statuses. The UI must not invent
background health, last-test, or readiness history. Diagnostics are explicit
and their result is shown as a current action receipt.

Viewer sessions see the same inventory and details without mutation controls.
Administrator sessions can add, attach, update bindings, detach, diagnose,
replace, and disable.

## Add MCP Server Flow

Use one modal with two task-oriented tabs.

### Remote Server

The common fields are:

- stable source name;
- server URL;
- protocol: HTTP or SSE.

Non-loopback remote URLs require HTTPS. Validation, DNS pinning, private-host
rejection, redirect policy, and the global egress denylist remain owned by the
existing MCP application service and proxy.

### Local Process

The common fields are:

- stable source name;
- approved launcher;
- launcher-specific value;
- required sandbox profile.

The primary launcher is `npx-package`, presented as `npm package (npx)`. It
accepts exactly one safe registry package name. The UI does not expose an
arbitrary executable, shell command, flags field, URL, or Git source.

`node-script` may appear only as a preconfigured launcher. The current backend
does not accept user-authored arguments for it, so the UI must not imply that it
can launch an arbitrary script.

Local-process sources are compatible with worker agents only. The UI explains
this before connection and rejects attachment to inline agents.

### Advanced Fields

Both tabs keep the following controls under a collapsed `Advanced` section:

- `Allowed tool names`: exact tool names or suffix-wildcard patterns such as
  `read_*`. Empty means all discovered tools are visible from the source. Helper
  text states that this does not grant execution authority.
- `Credentials (optional)`: mappings from existing Gantry Credential names to
  an HTTP header or environment-variable destination. Remote sources may use
  either target. Local processes use environment variables. No secret value is
  entered, returned, logged, or persisted in the MCP definition.
- `Source risk`: low, medium, or high, defaulting to medium. Helper text states
  that this classification contributes to later semantic-capability review and
  should only be lowered after explicit source review.
- `Expected network destinations`: exact `host` or `host:port` review metadata.
  For remote sources, the backend derives the URL host automatically. The UI
  states that these values are not an allowlist and that the global egress
  denylist remains authoritative.

The credential action is named `Add credential mapping`, not `Add reference`.
The selector receives safe credential-name/configured metadata only. When a
required credential is missing, the page gives existing operator setup
guidance; this feature does not add a Credential Center UI or a broken link to
one.

### Completion And Optional Attachment

Connection is the first durable stage. After it succeeds, the modal offers an
optional second stage for attaching one or more real backend agents. The user
may skip attachment and manage it later from server detail.

If connection succeeds but an attachment fails, the UI reports both facts:

> Server connected; agent attachment failed.

It retains the connected source and offers attachment retry. It does not claim
that the entire operation rolled back.

## Existing Server Management

### Mutable Operations

Operators may:

- attach or detach an agent;
- choose whether the agent inherits the server-wide allowed tool names or uses
  a narrower subset;
- mark the source required for agent startup;
- rotate the underlying secret through the existing credential-management
  path without changing the MCP credential mapping;
- run diagnostics;
- disable the source.

An agent binding can narrow but never widen the server definition's reviewed
tool-name scope. Permission-policy identifiers remain implementation details
and are not exposed as primary UI controls.

### Immutable Definition And Replacement

The security-reviewed definition is immutable after connection:

- source name and transport;
- endpoint, package, or approved launcher;
- credential mappings;
- source risk;
- expected network destinations;
- server-wide allowed tool names.

The UI labels the correction action `Replace configuration`. It opens the Add
flow with non-secret fields prefilled and requires a new source name, matching
the current definition-fingerprint contract.

The old source remains active after the replacement connects. The success
receipt offers an explicit `Disable old source` action. Bindings and semantic
capabilities are not silently copied because the new definition may expose a
different trust boundary and exact MCP tool identity.

## Diagnostics

The detail page uses `Run diagnostics`, not `Test connection` or a persistent
health badge.

- Without an attached agent, diagnostics validate the current definition,
  transport safety, credentials references, and remote destination policy.
- With an attached agent, diagnostics also discover visible tools and report
  tools blocked by missing reviewed semantic-capability bindings.

The result is an ephemeral receipt. No background polling or diagnostic-history
store is added.

## Browser Architecture

The browser uses a narrow same-origin façade under `/ui/api/mcp-servers`. It
never calls Bearer-only `/v1/*` routes and never receives a Control API key.

The façade follows the existing browser Model Providers boundary:

- require an active browser session for reads;
- allow viewers to read sanitized projections;
- require an administrator session for mutations;
- require canonical Origin and CSRF validation for mutations;
- require recent reauthentication for hosted-mode mutations;
- reject browser-session and Bearer-credential crossover;
- return stable safe errors without upstream payloads, secret values, socket
  paths, or database rows.

The browser façade delegates to the existing `McpServerService`, repositories,
settings projection, and agent repositories. It does not introduce a second MCP
configuration service.

## Browser View Model

One inventory request returns the page's bounded read model so the browser does
not perform per-row request fan-out. Each server projection contains only what
the page needs:

- id, name, display metadata, active/disabled status, transport, and sanitized
  transport details;
- allowed tool names, source risk, and normalized network destinations;
- credential mapping names, destinations, and configured/missing state, never
  values;
- attached real-agent summaries and binding options;
- role-derived available actions.

The frontend keeps this mapping explicit rather than treating Control API,
repository, or settings documents as browser contracts.

After a mutation, invalidate the single MCP inventory query. Reuse the existing
`browserFetch`, CSRF helper, query client, dialog, button, field, select, badge,
panel, page-state, and receipt primitives.

## Error Handling

- Validation errors stay attached to the relevant field when the safe server
  response identifies it; otherwise show a concise dialog-level error.
- A network or server error retains entered non-secret form values.
- A missing credential never reveals lookup internals; show the credential name
  and existing setup guidance.
- Attachment failure after successful connection preserves and selects the new
  source, then offers retry.
- Settings-sync failure uses the existing binding rollback behavior and reports
  that the attachment was not saved.
- Local-process/inline-agent incompatibility is rejected before mutation.
- Disable uses a confirmation dialog and states that future materialization
  stops while audit history remains.
- Replacement never disables the old source automatically.

## Component Boundaries

Keep route and page modules under the repository's practical 300-line guidance
when a real ownership boundary exists:

- route: search state, selected server, role, and page composition;
- query/view-model module: browser projection types and fetch functions;
- server list/detail components: inventory selection and read-only display;
- add/replace dialog: transport-specific form state and submission stages;
- attachment dialog: bind/update/unbind controls;
- diagnostic and disable receipts/dialogs.

Do not create a generic source-management abstraction, a second API client, or
new UI primitives for this feature.

## Repository Evidence

- CLI connect already performs source creation followed by agent binding:
  `apps/core/src/cli/mcp.ts`.
- Current MCP routes already support list, get, connect, test, bind/update,
  unbind, and disable: `apps/core/src/control/server/routes/mcp-servers.ts`.
- Validation, audit, materialization, and binding rules already live in
  `apps/core/src/application/mcp/mcp-server-service.ts` and
  `apps/core/src/application/mcp/mcp-server-policy.ts`.
- Source inventory and semantic action authority are intentionally separate:
  `docs/decisions/0020-mcp-source-vs-action-capability.md`.
- The browser authentication and mutation pattern exists in
  `apps/core/src/control/server/routes/browser-model-providers.ts`.
- The page/query/dialog composition pattern exists in
  `apps/web/src/features/operations/routes/providers-route.tsx`,
  `apps/web/src/features/operations/routes/provider-dialogs.tsx`, and
  `apps/web/src/features/operations/operations-queries.ts`.
- The current `Sources & access` and Agent MCP surfaces are fixture-backed:
  `apps/web/src/features/agents/agents-queries.ts` and
  `apps/web/src/features/agents/components/agent-detail-section.tsx`.

## Surface Impact

| Surface | Impact |
| --- | --- |
| Runtime behavior | No new MCP execution path; existing service behavior is reused. |
| `settings.yaml` | Existing bind, update, detach, and disable projection remains authoritative. |
| Postgres | No schema change; existing server, binding, credential, audit, and settings-revision repositories are reused. |
| Control API | Existing Bearer routes remain unchanged. |
| Browser API | Add sanitized session-authenticated MCP read and mutation routes. |
| Web UI | Add dedicated route, navigation entry, queries, inventory/detail view, and dialogs. |
| Agent UI | No broader Agents UI implementation; only real agent summaries are consumed by MCP selectors. |
| Credentials | Read safe name/configured metadata; no secret mutation UI is added. |
| Capability authority | Unchanged; connecting or binding a source never changes semantic capability selections. |
| Audit | Reuse existing MCP audit events; browser actor attribution must be explicit. |

## Verification And Regression Coverage

Focused proof must cover:

- browser reads require a session and safe viewer scope;
- browser mutations require administrator role, canonical Origin, CSRF, and
  hosted recent reauthentication;
- Bearer credentials and browser sessions remain mutually rejected;
- inventory and error responses contain no secret values or raw upstream
  payloads;
- remote and local form mapping matches current contracts;
- invalid URL, private destination, raw secret, unsafe npm package, missing
  sandbox profile, invalid tool pattern, and invalid network destination fail
  closed;
- connection success plus attachment failure remains visible and retryable;
- binding scope can narrow but cannot widen the server definition;
- local-process attachment rejects inline agents;
- diagnostics with and without an attached agent produce the correct bounded
  receipt;
- disable confirmation and result are accurate;
- replacement leaves the old source active and copies no binding or semantic
  authority;
- viewer UI omits mutation controls and administrator UI exposes them;
- loading, empty, filtered-empty, validation, offline, and server-error states
  remain accessible;
- existing CLI, Control API, MCP management, settings round-trip, browser-auth,
  and runtime-materialization tests remain green;
- deterministic repository verification runs through
  `python3 factory/scripts/verify.py` during implementation.

## Non-Goals

- full Agents UI implementation;
- Credential Center web UI or raw secret entry;
- semantic capability authoring or approval UI;
- arbitrary local command execution;
- editing an existing MCP definition in place;
- automatic binding/capability migration during replacement;
- background health monitoring or diagnostic history;
- server deletion or audit-history removal;
- schema migrations or compatibility shims.

## Acceptance Criteria

- Operators can find, inspect, connect, diagnose, attach, scope, detach,
  replace, and disable MCP sources from one dedicated page.
- Viewer and administrator capabilities match the existing browser role model.
- Remote and local-process setup expose only fields supported by current MCP
  contracts and validators.
- The browser receives no Control API key, raw credential value, or unsafe
  persistence payload.
- UI language consistently distinguishes source connection from semantic
  action authority.
- Partial success and replacement behavior are explicit and recoverable.
- Existing MCP CLI and Control API behavior remains compatible and covered.

## Approved Visual References

The interactive mockups are preserved under `.superpowers/brainstorm/` and are
design references only. They are not production assets and must not be shipped
or imported by the web application.
