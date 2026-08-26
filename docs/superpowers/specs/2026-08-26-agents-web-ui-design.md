# Agents Web UI Design

## Status

Approved in interactive design review on 2026-08-26.

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

The selected tab, agent, search query, filters, sorting, page, and page size are
represented in the URL. Refresh, browser history, and shared links preserve the
current view.

## Agents Directory

### Desktop Layout

Use a responsive master-detail layout:

- left: bounded, searchable, paginated agent list;
- right: selected-agent summary and detail navigation;
- top-right: primary `New agent` action.

Each row shows:

- agent name;
- active or disabled status;
- selected role snapshot name;
- model alias or `Deployment default`;
- connected-conversation count.

The selected summary shows:

- `Active`, `Disabled`, or current setup warnings;
- `Not connected` or the number of connected conversations;
- scheduled-job count as a separate fact;
- current config version;
- model and role snapshot;
- links to the four detail sections.

Do not use `deployed`, `running`, or `online` for an enabled configuration.
Preferred labels are:

- `Active · Not connected`
- `Active · 3 conversations`
- `Disabled · 3 conversations`
- `2 scheduled jobs`

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

## Agent Creation Flow

The guided flow has four steps.

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

## Agent Detail

### Overview

Show status, role snapshot, model, config version, connected conversations,
scheduled-job count, and current setup warnings. Conversation and job counts
are separate. Connections are managed by their owning conversation surface.

### Instructions

Show:

- copied role name and role prompt;
- agent-specific additional instructions;
- version metadata;
- existing `SOUL.md` and `AGENTS.md` advanced profile concepts where they can
  be represented truthfully.

Editing the agent's instructions creates a new agent configuration/profile
version. It never updates the source role template.

### Access

Use the existing `AgentAccessSummary` language and grouping:

- `Connected`: attached skills, MCP servers with per-agent tool scope, and
  tools;
- `Allowed`: durable selected capabilities and configured current access;
- `Needs attention`: only blockers actually present in the agent projection;
- `Suggested cleanup`: only conservative derivable suggestions.

Do not invent per-agent pending-request rows from app-wide counts. Do not merge
source inventory and durable authority into one field.

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

## Access And Permission Language

Use this explanation throughout the flow:

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
- preserve desired-state revision, settings export, validation,
  reconciliation, audit, and next-run activation.

The exact schema and migration plan belong in implementation planning. Do not
store prompt templates only in browser state, add parallel access fields, or
write directly to settings from the Web route.

## Accessibility And Interaction

- Use semantic links for agent and role navigation.
- Use buttons for actions and real tab/combobox semantics for selection.
- Preserve visible keyboard focus and complete keyboard operation.
- Associate every field with a label and inline error.
- Announce asynchronous save results without relying on color.
- Keep status text next to status color.
- Make destructive role deletion and agent disablement confirmed actions.
- Keep sticky headers and footers from covering the focused row or control.
- On mobile, avoid nested horizontal and vertical table scrolling.

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
    approval are related but separate states.
