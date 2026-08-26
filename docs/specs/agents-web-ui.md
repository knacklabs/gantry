---
slug: agents-web-ui
title: Agents Web UI
status: draft
saved: 2026-08-26T15:41:45+00:00
---

# Agents Web UI Design

## Why

Gantry needs one truthful browser workflow for durable agents. Operators must
be able to see what an agent is, create it from a visible role snapshot,
configure its reviewed sources and durable authority, and manage its status
without confusing source visibility, conversation usage, or runtime approval.

## Behaviour

The shipped Web UI provides a bounded, server-paginated Agents directory and a
separate Roles library. An operator can create a base agent first, then
independently save optional Sources and Capabilities setup. Agent details show
only projected configuration, access, warnings, and version history that are
real for that agent. Custom-role edits and deletion affect future selection
only; agents retain their copied role snapshots. Disabling rejects new sessions
and delegation without deleting history or already-running work.

The detailed product, authority, API, accessibility, and validation contract
is the remainder of this specification.

## Acceptance criteria

1. The Agents directory is a truthful, URL-backed, server-paginated table with
   loading, empty, error, retry, filter, sort, page-size, and narrow-screen
   behavior.
2. Roles can be viewed; custom roles can be created, edited, duplicated, and
   deleted while preserving existing agent snapshots.
3. Creation persists Step 1 before optional source and capability setup;
   later failure never removes earlier saved work.
4. Source attachment, durable capability authority, runtime checks, and
   conversation binding remain visibly and technically separate.
5. Agent detail, settings, disable confirmation, and version history expose
   only real projected data and every visible control has a defined result.
6. Browser mutations are authenticated, administrator-authorized,
   Origin/CSRF-protected, and use sanitized same-origin façade DTOs.
7. Focus, keyboard operation, dialogs/drawers, status announcements, and
   narrow layouts meet the interaction requirements in this specification.

## Status

Final design approved in interactive design review on 2026-08-26 and updated
after the interactive-control audit.

This design replaces the orphaned local `WEB-CONSOLE-6` concept. Current
`main` remains the implementation source of truth; the supplied standalone
prototypes are visual references only.

## Goal

Give Gantry operators one truthful browser workflow for finding, creating,
understanding, configuring, enabling, and disabling durable agents.

The workflow must explain the product in ordinary language:

- Gantry is the runtime and control plane, not a parent agent.
- An agent is a reusable, versioned configuration that Gantry starts when work
  reaches it. It is not an always-running bot.
- An active agent is enabled to accept new work.
- A connected agent is bound to one or more conversations. Activity and
  connection are separate states.
- Skills and MCP servers are connected sources. Selected capabilities are the
  agent's durable authority. Source attachment alone never grants every action.

## Current Repository Truth

Current `main` provides preview-only Agents directory and detail routes backed
by static data. Their mutation controls stop at the connection gate.

The live Control API currently supports:

- listing every app agent without pagination;
- creating an active agent from `appId`, `name`, and optional harness intent;
- updating name, active/disabled status, and harness intent;
- reading and versioning agent-owned `SOUL.md` and `AGENTS.md` profile files;
- reading and replacing agent access sources and capability selections;
- binding agents to conversations through conversation-owned configuration.

It does not currently support:

- a live browser Agents management façade;
- server-paginated agent listing;
- custom reusable roles;
- role CRUD or a role catalog API;
- role or model selection in the agent-create request;
- an atomic create-and-access-configuration request;
- hard agent deletion.

The six current role prompts are code-owned personas: `developer`,
`generalist`, `sales`, `marketing`, `operations`, and `research`. Gantry
combines the selected persona with protected runtime rules, capability
guidance, operating guidance, profile files, and current run context.

## Product Scope

The first release covers:

- the live Agents directory;
- a reusable Roles library;
- built-in role-prompt visibility;
- custom role creation, editing, duplication, and deletion;
- guided agent creation;
- optional source and capability selection during setup;
- truthful agent detail for overview, instructions, access, and settings;
- read-only configuration version history backed by real version snapshots;
- enable and disable actions.

The release does not add:

- hard agent deletion or historical-data removal;
- conversation creation or channel onboarding;
- scheduled-job creation;
- skill installation;
- MCP server connection or credential setup;
- capability-definition authoring;
- bulk agent operations;
- harness selection;
- configuration-version restoration;
- a redesign of the broader Web console.

Existing source, capability, conversation, credential, and job flows remain
owned by their current product surfaces. The Agents flow selects existing
reviewed inventory and links to the owning surface when setup is missing.

## Information Architecture

The Agents area has two primary tabs:

1. `Agents`
2. `Roles`

The agent detail view has four sections:

1. `Overview`
2. `Instructions`
3. `Access`
4. `Settings`

The selected area, agent, detail section, search query, filters, sorting, page,
and page size are represented in the URL. Refresh, browser history, shared
links, and returning from detail preserve the current view.

## Agents Directory

### Desktop Layout

Use one full-width, bounded, searchable, server-paginated table. There is no
selected-agent side panel. Selecting an agent opens its routed detail page.
`New agent` is the only primary page action and appears at the top right.

The toolbar contains:

- a labeled `Search agents` field;
- a labeled status selector;
- a labeled role selector using actual role values;
- `Clear filters` only while at least one filter is active.

Search fetches after a 300-400 ms debounce. Enter fetches immediately. Filter,
sort, page-size, and pagination changes fetch immediately. There is no Search
button.

Each row shows:

- agent name;
- active or disabled status;
- selected role snapshot name;
- model alias or `Deployment default`;
- connected-conversation count.

The agent-name link is the row's single keyboard focus target. Pointer clicks
elsewhere in the row activate the same link. The implementation must preserve
normal link behavior, including open-in-new-tab and Command/Control-click.

Do not use `deployed`, `running`, or `online` for an enabled configuration.
Preferred labels are:

- `Active · Not connected`
- `Active · 3 conversations`
- `Disabled · 3 conversations`
- `2 scheduled jobs`

`Not connected` is neutral usage information, not a setup warning. Only a
blocker present in the agent projection receives warning treatment.

### Narrow Layout

On narrow screens, use a compact agent list and a separate routed detail
screen. Do not force the desktop table or split panel into a small viewport.

### Empty And Loading States

- Initial empty state explains that an agent is a reusable configuration and
  offers `Create agent`.
- Filtered empty state offers `Clear filters` without repeating onboarding.
- Loading uses stable skeleton rows rather than a blank page.
- Failure preserves URL state and offers a scoped retry.

### Pagination And Overflow

Agent pagination is server-owned. Reuse Gantry's existing page contracts
instead of adding another pagination shape.

Request fields:

- `page`, starting at 1;
- `pageSize`, default 25 with 50 and 100 options;
- `search`;
- `status`;
- `role`;
- `sort` and `direction`.

Response fields:

- `data`;
- `page`;
- `pageSize`;
- `total`;
- `hasNext`.

Search, filters, and sort execute on the server and reset the view to page 1.
Returning from detail preserves the previous list state.

The table/list region has a viewport-relative maximum height, one vertical body
scroll, a sticky header, and a sticky pagination footer. Wide tables use one
horizontal scroll container. Individual columns never become separate scroll
regions. Keep the agent-name column visible where practical, truncate long
values safely, and expose the full value on hover and keyboard focus.

Rows are real links so keyboard activation, open-in-new-tab, and
Command/Control-click work normally. Do not add selection checkboxes until bulk
actions exist.

The visible row range, total, page badge, enabled pagination controls, and
rendered records must always agree with the server response. While a request is
pending, preserve the table dimensions, mark the region busy, and prevent
duplicate page requests. No static or estimated totals are shown.

## Role Model

### Prompt Layers

The effective agent prompt remains layered:

1. Gantry-owned runtime and safety rules;
2. one role block, built-in or custom;
3. optional agent-specific additional instructions;
4. run-time capability, session, tool, memory, and continuity context.

Built-in and custom role prompts are visible in full. Openness is not a reason
to merge Gantry's generated runtime and safety context into the editable role
field.

A custom role replaces the built-in role block. It is not appended on top of a
hidden built-in persona. This requires extending the current fixed-persona
runtime contract with a custom role snapshot or reference whose prompt can be
compiled into the `PERSONA` section.

Gantry-owned runtime and safety sections remain protected and are never copied
into the role editor.

### Built-In Roles

The six built-ins come from the current canonical prompt definitions. The UI
does not maintain a duplicate text copy.

Built-ins are:

- visible;
- selectable;
- immutable;
- not deletable;
- duplicable into a custom role.

### Custom Roles

A custom role is app-scoped reusable template data with:

- stable id;
- unique app-scoped display name;
- editable role prompt;
- optional source built-in or custom role metadata;
- created and updated timestamps.

The runtime does not live-link an agent to mutable template content. When an
agent is created, Gantry stores a versioned snapshot of the selected role name
and prompt with that agent's configuration. Later role edits affect future
agent creation only.

Deleting a custom role removes the template from the library and future role
selectors. Existing agents retain their snapshots and continue unchanged.
Deletion confirmation reports how many existing agents retain copies. No
archive lifecycle or recycle bin is added in the first release.

## Roles Page

The Roles tab contains:

- one small fixed section for the six built-in roles;
- one server-paginated custom-role table;
- a primary `New custom role` action.

Built-in actions:

- `View prompt`;
- `Duplicate and customize`.

Custom-role actions:

- `View`;
- `Edit`;
- `Duplicate`;
- `Delete`.

Selecting a built-in role opens a read-only role detail panel with the full
canonical prompt and `Duplicate and customize`. Selecting a custom role opens
the same panel in editable mode with `Save changes`, `Duplicate`, and `Delete`.
`New custom role` opens a blank editor with required name and prompt fields.

Custom-role deletion uses a confirmation dialog. Its body states how many
existing agents retain snapshots and that those agents will not change. The
confirming action is `Delete role`; the cancelling action is `Cancel`.

The custom-role table columns are:

- role name;
- source role;
- prompt summary;
- number of agents created from it;
- updated time;
- actions.

Custom-role pagination, search, sorting, bounded height, sticky header/footer,
overflow behavior, URL state, and default page size follow the Agents table
contract. Built-ins are six fixed records and are not paginated.

The table stays read-only. Selecting a role opens a detail/editor panel so
long-form prompt editing does not destabilize row layout.

Every role action above is required. No overflow menu appears unless it
contains at least two valid actions. The role page has no decorative cards,
metrics, or inactive controls.

## Role Selector

Agent creation uses a searchable combobox instead of role pills.

Options are grouped under:

- `Built-in roles`
- `Custom roles`

Each option shows its name and a one-line purpose. The dropdown footer offers
`Create custom role`. Selecting a role reveals a full prompt preview plus:

- `Duplicate and customize` for built-ins and existing custom roles;
- `Create custom role` for a blank role.

Role results are fetched in bounded pages. Do not preload an unbounded custom
role library. Pills may be considered later for a small recent-role shortcut,
but they are not the primary selector.

Typing filters after a 300-400 ms debounce and Enter fetches immediately. The
combobox provides loading, no-results, failure, retry, and keyboard-selection
states. Selecting a role updates the prompt preview immediately.

## Agent Creation Flow

The guided flow has four steps.

Only the current step and completed steps are interactive. Steps 2-4 remain
disabled until Step 1 successfully creates the base agent. After creation,
completed steps may be revisited without discarding later saved work.

### Step 1: Agent

Fields:

- `Agent name`, required;
- `Role`, required, using the grouped searchable selector;
- full selected-role prompt preview;
- `Additional instructions`, optional and agent-specific;
- `Model`, optional and preselected to `Use deployment default`.

Harness is omitted. The backend uses Gantry's `auto` harness intent. Harness
may appear later as read-only diagnostics; it is not a normal creation choice.

`Create and continue` creates the agent immediately as active. It stores the
role snapshot and additional instructions in the versioned agent prompt
profile, applies the optional model selection, and opens setup Step 2.

The resulting agent is valid even if the user leaves setup. With no
conversation bindings its directory label is `Active · Not connected`.

Name and role validation is inline. A duplicate or invalid name keeps entered
values, explains the problem next to the field, and moves focus to the first
invalid field. Closing before creation warns only when the form is dirty.
Closing after creation states that the saved agent will remain and offers
`Continue setup` or `Leave setup`.

### Step 2: Sources

Use one Sources step with two tabs:

1. `Skills`
2. `MCP servers`

Each tab has independent search, server pagination, selected count, loading,
empty, and failure states. The step summary says, for example,
`2 skills · 1 MCP server selected`.

Only existing reviewed source inventory appears. Source creation, skill
installation, MCP connection, and credential configuration remain outside this
wizard.

Each source row shows:

- human-readable name and purpose;
- ready or needs-setup state;
- the concrete next action when setup is missing.

Ready sources are selectable. Sources that cannot currently be attached remain
visible but disabled with their next action. The selected-source summary stays
visible while the list scrolls.

The step states: `Connecting a source does not grant its actions.` It is
optional and offers `Skip for now`.

`Clear selections` appears only when the active source step has a selection
and clears the current saved draft after confirmation if clearing would remove
already-saved sources. `Skip for now` saves no new sources and advances to
Capabilities.

### Step 3: Allowed Capabilities

Show capabilities derived from selected sources plus available built-in
capabilities. Group them by source and risk.

Each row shows:

- human-readable capability name;
- what it can do;
- what it cannot do;
- read, write, or admin risk;
- current readiness.

Raw capability ids and implementation bindings stay under `Details`. Selecting
a capability creates durable agent-owned authority through the existing
reviewed capability lifecycle. It does not create conversation- or job-owned
authority.

The step is optional and offers `Skip for now`.

`How access works` opens a short read-only drawer containing the three-part
flow `Connected sources -> Allowed capabilities -> Runtime checks` and the
single explanation: `Connected sources provide tools. Allowed capabilities
authorize actions. Some risky actions may still require approval.` The drawer
does not repeat the current selection summary or add a second setup status.

`Skip for now` saves no new capabilities and advances to Review.

### Step 4: Review

Review displays:

- agent identity;
- role snapshot and expandable prompt;
- additional instructions;
- model;
- connected sources;
- allowed capabilities grouped by risk;
- skipped setup;
- missing or unavailable setup warnings;
- `Available next run` activation language for access changes.

The primary action is `Finish setup`, not `Create agent`, because the agent was
created after Step 1. Secondary actions return to a step or leave setup.
Completion opens agent detail at Overview.

Review is derived from the current saved and unsaved wizard state; it never
uses placeholder counts, source names, capabilities, warnings, or instruction
lengths. Each `Edit` action returns to its corresponding completed step.

## Save And Failure Behavior

The flow matches Gantry's separate lifecycle boundaries rather than pretending
to be one atomic operation:

- Step 1 creates the base agent and role snapshot.
- Source selections save as their own durable desired-state revision.
- Capability selections save as their own durable desired-state revision.
- Successful earlier stages remain when a later stage fails.
- A failed stage reports exactly what saved and offers a scoped retry.
- Leaving after creation never deletes the agent.
- Skipping access creates a valid agent with baseline Gantry behavior and no
  additional selected sources or capabilities.

Forms keep entered non-secret values after recoverable errors. Validation is
inline, moves focus to the first invalid field, and does not rely on a toast
alone. Unsaved prompt edits warn before navigation.

Each save disables only its submitting action, announces progress, and returns
one of these outcomes:

- `Agent created. Continue setup.`
- `Sources saved. Available next run.`
- `Capabilities saved. Available next run.`
- a scoped error that identifies the unsaved stage and offers `Retry`.

## Agent Detail

Agent detail is a routed page, not a side panel. Its header contains the agent
name, purpose, status, neutral conversation count, separate scheduled-job
count, `Version history`, and `Disable` or `Enable`. It contains no overflow
menu. `Back to agents` restores the directory URL and focus to the originating
agent link.

### Overview

Show status, role snapshot, model, config version, connected conversations,
scheduled-job count, and current setup warnings. Conversation and job counts
are separate. Connections are managed by their owning conversation surface.

Do not show a separate positive `Ready for new work` card. The status in the
header is sufficient. The warnings region is absent when no real projected
warning exists.

### Instructions

Show:

- copied role name and role prompt;
- agent-specific additional instructions;
- version metadata;
- existing `SOUL.md` and `AGENTS.md` advanced profile concepts where they can
  be represented truthfully.

Editing the agent's instructions creates a new agent configuration/profile
version. It never updates the source role template.

`View source role` appears only when the source role template still exists and
the current user may read it. Advanced profile source labels such as
`AGENTS.md` appear only when the projection identifies that exact source.

### Access

Use the existing `AgentAccessSummary` language and grouping:

- `Connected`: attached skills, MCP servers with per-agent tool scope, and
  tools;
- `Allowed`: durable selected capabilities and configured current access;
- `Needs attention`: only blockers actually present in the agent projection;
- `Suggested cleanup`: only conservative derivable suggestions.

Do not invent per-agent pending-request rows from app-wide counts. Do not merge
source inventory and durable authority into one field.

`Edit sources` and `Edit capabilities` open the corresponding setup editor for
this agent. Empty groups are omitted. A GitHub, credential, or source warning
appears only when returned for this agent.

### Settings

Support:

- rename;
- model change;
- enable;
- disable.

Disable confirmation states:

> Gantry will reject new sessions and delegation to this agent. Existing
> configuration, history, memory, and audit records remain available. Work
> already running is not cancelled.

The first release has no Delete Agent action. Current removal is a CLI/settings
cleanup lifecycle that preserves historical projection; the Web UI must not
represent it as hard deletion.

The Settings availability copy is one sentence: `Disabling preserves this
agent's configuration and history.` It does not display a separate `No Web
delete action` notice.

### Version History

`Version history` opens a read-only drawer only when the browser projection can
return real version records. Each record includes version id, timestamp,
actor/source, change summary, and the stored snapshot fields available for
that version. Selecting a version updates the preview without changing the
agent.

The drawer states `Read-only history`. It supports loading, empty, failure,
retry, and keyboard navigation. It does not fabricate missing snapshots,
infer historical values from the current agent, show a Restore action, or
compare fields the service cannot project truthfully.

## Interaction And Copy Discipline

Every visible control must do one of three things:

1. navigate to a real route;
2. change local view state with an observable result; or
3. invoke a defined browser-facade operation with loading, success, and failure
   states.

Controls with no first-release behavior are omitted rather than disabled or
left decorative. The shipped page contains no prototype variant switcher,
design rationale, metric strip, setup-attention rail, inactive sidebar item,
decorative overflow menu, or Search button.

Explanatory notes are limited to behavior users could otherwise misunderstand:

- role prompts exclude protected Gantry runtime and safety layers;
- connecting a source does not grant its actions;
- access changes are `Available next run`;
- disabling rejects new sessions and delegation while preserving records;
- deleting a custom role does not change existing agent snapshots.

Positive status, section-purpose text, and source-versus-capability explanations
are not repeated across cards, summaries, and drawers. Empty space is preferred
to redundant instructional UI.

### Required State Copy

Use these concise messages rather than generic or decorative notices:

- initial directory empty: `No agents yet.` and `Create an agent to define a
reusable identity for Gantry work.` with `Create agent`;
- filtered directory empty: `No agents match these filters.` with
  `Clear filters`;
- directory failure: `Agents could not be loaded.` with `Retry`;
- role results empty: `No roles match this search.` with `Clear search`;
- source results empty: `No available sources match this search.` with
  `Clear search`;
- recoverable stage failure: `<Stage> was not saved. Earlier setup is still
available.` with `Retry`;
- post-creation exit: `This agent has been created. You can finish setup now or
return later.` with `Continue setup` and `Leave setup`.

Loading states use skeleton rows or a local progress label and retain layout.
Success messages may use a polite live region or toast, but errors and required
actions remain visible in the affected section.

## Access And Permission Language

Use this as the canonical access explanation. Show it once in the creation flow
and again only where the user explicitly requests access help:

> Connected sources provide tools. Allowed capabilities authorize actions.
> Some risky actions may still require approval.

Do not say `Capability is not permission`. A selected capability is durable
agent authority. A conversation may be the place an approval is requested and
recorded, but it does not own the durable grant. Jobs inherit the target
agent's access and do not receive job-local grants.

## Browser Architecture

The Web application uses narrow same-origin browser façades. It never calls
Bearer-only `/v1/*` routes with browser credentials and never receives a
Control API key.

The browser surface must:

- require an authenticated browser session for reads;
- require administrator authority for mutations;
- enforce Origin and CSRF checks for mutations;
- preserve any hosted recent-reauthentication requirement;
- reject browser-session/Bearer crossover;
- return explicit sanitized DTOs rather than persistence or settings records;
- delegate to existing agent, prompt-profile, desired-state, access, model,
  skill, MCP, conversation-binding, and audit application services.

The façade is orchestration, not a second source of truth. Role management adds
one new app-scoped role-template domain/application contract. Built-in role
text is projected from the canonical runtime definitions.

## API And Contract Changes

Planning must account for these clean contract changes:

- paginate the agent list at repository/application/API/browser boundaries;
- add server-side agent search, status/role filtering, and sorting;
- add app-scoped custom-role create, list, read, update, duplicate, and delete;
- paginate custom-role list and role-combobox search;
- expose built-in role metadata and canonical prompt text read-only;
- let agent creation store a role snapshot and optional additional
  instructions;
- let a custom role snapshot replace the runtime `PERSONA` block;
- accept or apply an optional model selection through the existing model
  configuration service;
- reuse existing source attachment and capability replacement services for
  setup Steps 2 and 3;
- expose the existing agent access summary through the browser projection;
- expose real read-only configuration version metadata and available snapshot
  fields through the existing profile/version service boundary;
- preserve desired-state revision, settings export, validation,
  reconciliation, audit, and next-run activation.

The exact schema and migration plan belong in implementation planning. Do not
store prompt templates only in browser state, add parallel access fields, or
write directly to settings from the Web route.

## Accessibility And Interaction

- Use semantic links for agent and role navigation.
- Use buttons for actions and real tab/combobox semantics for selection.
- Preserve visible keyboard focus and complete keyboard operation.
- Give each linked table row one keyboard focus target.
- Associate every field with a label and inline error.
- Announce asynchronous save results without relying on color.
- Keep status text next to status color.
- Make destructive role deletion and agent disablement confirmed actions.
- Trap focus inside open dialogs and drawers, make the background inert, close
  with Escape, and restore focus to the opening control.
- Use at least 44 by 44 CSS-pixel touch targets on narrow screens.
- Keep sticky headers and footers from covering the focused row or control.
- On mobile, avoid nested horizontal and vertical table scrolling.

## Surface Impact Matrix

| Surface                      | Status               | Final-design impact                                                                                                                         |
| ---------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior             | Changed              | Custom role snapshots replace the fixed persona block for those agents; existing Gantry runtime and safety layers remain protected.         |
| `settings.yaml`              | Changed              | Agent, source, capability, model, and active-state mutations continue through desired-state services and revision handling.                 |
| Postgres/runtime projection  | Changed              | Add app-scoped custom roles, paginated queries, role snapshots, and truthful read projections required by the UI.                           |
| Control API                  | Changed              | Add pagination/filtering, role management, model/role-aware creation, access setup, and version-history reads through application services. |
| SDK/contracts                | Changed              | Add sanitized paginated browser DTO inputs/results and role/version contracts without exposing persistence records.                         |
| CLI                          | Read-only/observable | Existing agent/profile behavior remains an implementation reference; no new CLI UX is required for the Web release.                         |
| Gantry MCP tools/admin skill | Unchanged by design  | Agent Web management does not add a parallel MCP administration lifecycle.                                                                  |
| Channel/provider adapters    | Unchanged by design  | Conversation binding remains conversation-owned and provider rendering does not change.                                                     |
| Docs/prompts                 | Changed              | Document custom-role prompt compilation, snapshot behavior, access language, and operator workflow.                                         |
| Audit/events                 | Changed              | Record role mutations, agent creation/profile changes, source/capability revisions, model changes, and enable/disable operations.           |
| Tests/verification           | Changed              | Add contract, application, browser-facade, Web interaction, accessibility, responsive, pagination, and functional-flow coverage.            |

## Validation Plan

Focused automated coverage must prove:

- agent and custom-role pagination, filtering, sorting, totals, and URL inputs;
- built-in prompt projection without a duplicate browser-owned prompt copy;
- custom-role create, edit, duplicate, and delete, including retained agent
  snapshots after template edits or deletion;
- base-agent creation before optional setup, stage-specific persistence, and
  recovery when a later stage fails;
- truthful review/detail/version projections with no current-state fallback for
  missing historical data;
- source attachment remaining separate from capability authority;
- rename, model change, enable, and disable through existing services with
  desired-state revision, audit, and next-run behavior preserved;
- authenticated same-origin reads, administrator mutation checks, Origin,
  CSRF, recent reauthentication where required, sanitized DTOs, and rejection
  of browser-session/Bearer crossover;
- debounced search, immediate filters, server pagination, state restoration,
  loading/empty/error/retry states, and prevention of duplicate requests;
- keyboard and screen-reader operation for linked rows, comboboxes, tabs,
  dialogs, drawers, confirmation flows, focus restoration, and live results.

The functional check uses the real local Web UI to create an agent, leave after
Step 1, resume setup, attach one ready source, allow one capability, inspect the
saved detail and real version history, disable and re-enable the agent, and
confirm the directory state survives navigation and refresh. A narrow-screen
check verifies the compact list and routed detail without nested scrolling.

Cleanup searches must find no shipped prototype variant switcher, selected
agent side panel, decorative metrics/setup rail, Search button, standalone
browser prompt copy, hard-coded agent detail projection, or no-op visible
control.

## Repository Evidence

- Preview Agents routes and static data:
  `apps/web/src/features/agents/routes/agents-route.tsx`,
  `apps/web/src/features/agents/routes/agent-detail-route.tsx`, and
  `apps/web/src/features/agents/agents-preview.ts`.
- Current create/update/profile/access contracts:
  `packages/contracts/src/agents/index.ts`.
- Current unpaginated list and bounded create/update/profile routes:
  `apps/core/src/control/server/routes/agents.ts`.
- Current fixed persona set:
  `apps/core/src/shared/agent-persona.ts`.
- Current layered prompt compilation and canonical built-in role text:
  `apps/core/src/application/agents/prompt-profile-service.ts`.
- Current versioned profile CLI:
  `apps/core/src/cli/agent-profile.ts`.
- Existing page and cursor contract primitives:
  `packages/contracts/src/pagination/index.ts`.
- Existing reusable table composition:
  `apps/web/src/ui/compositions/data-table.tsx`.
- Canonical capability/source/grant lifecycle:
  `docs/architecture/capability-management.md` and accepted decisions `0019`,
  `0020`, and `0021`.
- Agent removal semantics:
  accepted decision `0050-agent-removal-projection-cleanup`.

## Acceptance Summary

The design is successful when an operator can:

1. find an agent in a bounded, server-paginated directory;
2. distinguish enabled state from conversation and job usage;
3. inspect every built-in role prompt;
4. create, edit, duplicate, and delete reusable custom role templates;
5. create an agent from a built-in or custom role snapshot;
6. add agent-specific instructions without mutating the role template;
7. optionally attach existing skills and MCP sources;
8. separately select reviewed durable capabilities;
9. leave setup without producing a broken or secretly deleted agent;
10. inspect the resulting identity, instructions, access, and settings;
11. enable or disable the agent without implying hard deletion;
12. understand that source visibility, durable authority, and transient
    approval are related but separate states;
13. open only controls that have a real route, local state result, or defined
    browser operation;
14. use loading, empty, error, retry, validation, and partial-save states
    without losing previously saved work;
15. use the directory, wizard, dialogs, drawers, role editor, and detail route
    with keyboard, screen reader, and narrow-screen navigation.
