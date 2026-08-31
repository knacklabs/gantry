---
slug: skills-web-ui
title: Skills Web UI Design
status: confirmed
saved: 2026-08-31T05:41:53+00:00
---

# Skills Web UI Design

Date: 2026-08-31

## Why

Gantry will add a live Skills management page at `/ui/skills`. A Skill is an app-scoped installed instruction package. It may be attached to agents, while any actions declared by the package remain separately authorized capabilities.

The page supports inventory search, package inspection, ZIP installation, and agent attachment management. It does not add global skill enable, disable, removal, binary download, or capability editing.

## Goals

- Replace fixture-only skill management with browser-session-backed data.
- Let viewers inspect installed skills without exposing machine API keys or storage references.
- Let administrators install reviewed ZIP packages and manage agent attachments.
- Preserve the distinction between installed packages, agent source bindings, and action authority.
- Reuse the current Gantry shell, browser authorization policy, UI primitives, skill service, artifact store, and settings projection.

## Approaches Considered

### Selected: split inventory and detail

The Skills route keeps a searchable inventory on the left and the selected skill on the right. Overview, Files, Actions, and Agents are tabs within the detail panel. This matches the approved mockup, makes comparison fast, and avoids repeated route transitions.

### Rejected: list route plus separate detail route

A separate `/skills/:skillId` page would simplify narrow-screen layout and provide path-based detail links, but it slows inventory browsing and duplicates more page structure. The selected split layout retains shareable state through query parameters instead.

## Product Model and Authority

- **Installed skill:** an app-scoped catalog record with reviewed package metadata and optional artifact storage.
- **Agent attachment:** a durable source binding that makes an installed skill available to that agent on future runs.
- **Declared action:** a capability candidate described by the skill manifest.
- **Authorized capability:** durable agent authority managed from the Agent Access page.

Installing does not attach. Attaching does not authorize declared actions. Updating an installed package does not alter capability selections.

## Route and Layout

Add `Skills` under Configure in the main navigation. Its count is the number of installed skills visible to the current app.

`/ui/skills` uses these validated search parameters:

- `skill`: selected skill ID
- `q`: inventory search text
- `tab`: `overview`, `files`, `actions`, or `agents`

Invalid values fall back to the first matching skill and the Overview tab. When no skill matches, the detail panel shows no selection. At narrow widths, the inventory stacks above the detail panel so the page remains usable instead of blocking mobile users.

## Behaviour

### Header and inventory

- Page title: `Skills`
- Description: `Install and inspect instruction packages, then choose which agents receive them.`
- Administrator action: `Install skill`
- Search label: `Search skills`
- Search placeholder: `Name, description, or ID`
- Empty inventory: `No skills are installed yet.`
- Empty search: `No skills match this search.`
- Load error: `Skills could not be loaded.`
- Retry action: `Retry`

V1 has no status filter because the browser surface does not expose a user-controlled global skill lifecycle. Inventory rows show name, description, source, attached-agent count, and declared-action count.

### Detail tabs

Tabs are `Overview`, `Files`, `Actions`, and `Agents`.

The Overview tab shows safe catalog facts and this notice:

> Skills provide instructions, not automatic access. Attaching a skill helps an agent know how to work. Declared actions are authorized separately in Agent access.

Storage references and content hashes are never returned to React. Storage type and package size may be shown.

### Files

The Files tab lists reviewed package paths and sizes. File contents load only after the tab and a file are selected.

- UTF-8 text-like files receive a read-only preview.
- Binary files show path, content type, and size with `Preview unavailable for this file type.`
- V1 has no download action.
- A file-load failure shows `Skill file could not be loaded.` and `Retry` without clearing the selected skill.

### Actions

The Actions tab is read-only. Each action shows its trusted display name, risk, `can` boundary, `cannot` boundary, required credential names, and reviewed network hosts.

An instruction-only package shows:

> No actions declared. This skill supplies instructions only.

For attached agents, `Manage access` navigates to `/ui/agents/:agentId?tab=access`. The Skills page never edits capability selections.

### Install dialog

- Title: `Install skill`
- Description: `Add a ZIP package to Gantry’s skill inventory. Agent attachment is managed separately after installation.`
- Picker action: `Choose a skill ZIP`
- Picker hint: `ZIP only · Maximum 5 MB`
- Warning: `Installing a package with the same skill name updates it in place. Attached agents receive the updated instructions on their next run.`
- Initial actions: `Cancel`, `Install skill`
- Success message: `Skill installed.`
- Success actions: `View skill`, `Attach agents`

The submit action is disabled until one `.zip` file is selected. Existing server validation remains authoritative: packages require `SKILL.md`, reject unsafe paths and symlinks, and enforce compressed, expanded, and file-count limits. A failure remains in the dialog and shows the safe browser-facade reason.

Installation adds or updates inventory only. A same-materialized-name package updates the existing installed skill in place. Existing attachments receive the updated package on their next run; already-running work is unchanged.

### Attach agents dialog

- Title: `Attach agents`
- Description: `Choose which agents receive this skill’s instructions on their next run.`
- Notice: `Attachment is not authorization. Declared actions must still be enabled from each agent’s Access tab.`
- Actions: `Cancel`, `Save attachments`
- Success: `Attachments saved. Changes apply on each agent’s next run.`
- Failure: `Attachments could not be saved.`

Active and disabled agents are selectable. A disabled agent is labeled `Disabled · available when the agent is enabled.` The dialog supports up to 100 distinct selected agents, matching the existing bounded bulk-attachment convention.

Saving replaces the complete desired attachment set atomically. All attachments change or none do. A failure leaves the dialog open and preserves the last confirmed server state.

## Browser Authorization and Security

- Viewer and administrator sessions may read inventory and files through the existing `skills:read` browser policy.
- Only administrators may install or change attachments through `skills:admin`.
- Mutations require the existing browser session, canonical Origin, and CSRF protections.
- Hosted-mode mutations retain the existing recent-reauthentication requirement used by administrative browser routes.
- Every lookup is scoped to the active session app. Cross-app skill or agent IDs return a safe not-found response.
- Browser responses exclude artifact storage references, content hashes, raw upstream errors, credentials, secrets, stack traces, and machine Bearer tokens.
- Text previews render as text, never interpreted HTML.

## Browser Facade

Add browser-session routes following the established MCP management pattern:

- `GET /ui/api/skills`
  - returns console role and sanitized installed-skill inventory with attached-agent summaries
- `GET /ui/api/skills/:skillId/files`
  - returns safe file metadata
- `GET /ui/api/skills/:skillId/files/:path`
  - returns UTF-8 text content or binary metadata without binary payload
- `POST /ui/api/skills/install`
  - accepts `application/zip` and returns the sanitized installed skill
- `PUT /ui/api/skills/:skillId/agents`
  - accepts `{ agentIds: string[] }` with zero to 100 distinct IDs and replaces the attachment set

The browser routes reuse `SkillService`, `parseSkillZipUpload`, the skill artifact store, existing repositories, and `syncSettingsFromProjection`. They do not call the Bearer-protected `/v1` routes and do not expose Control API keys to the browser.

## Attachment Data Flow

1. Validate the session, administrator role, Origin, CSRF token, skill ID, and bounded distinct agent IDs.
2. Confirm the installed skill and every selected agent belong to the session app. Disabled agents remain valid.
3. In one Postgres transaction, activate bindings for selected agents and disable active bindings for agents omitted from the desired set.
4. Commit the binding set.
5. Run the existing settings projection once.
6. Return the sanitized attached-agent summaries and invalidate Skills and affected Agent queries.

If validation or the transaction fails, no bindings change. If settings projection fails after commit, the browser route returns the safe failure and the existing projection reconciliation remains responsible for converging the persisted desired state; the UI refetches before permitting another save.

## Web Components and State

Create a focused Skills feature slice:

- route component for split inventory/detail layout and URL state
- React Query definitions for inventory, file metadata/content, install, and attachment replacement
- install dialog
- attachment dialog
- file preview
- declared-action cards

Reuse the current `PageHeader`, `Panel`, `Tabs`, `Dialog`, `Button`, `Input`, status badges, skeletons, query client, and browser-auth fetch helper. Do not add a component library, generic source catalog abstraction, or separate detail route.

Inventory search is local over the loaded installed-skill list. File content is lazy. Successful mutations invalidate the Skills inventory and affected Agent source/capability queries.

## Error and Loading Behavior

- Inventory and selected-detail loading use existing skeleton patterns.
- A relation-tab failure is isolated to that tab; it does not replace the inventory or other tabs.
- Mutation buttons disable while pending and prevent duplicate submission.
- Closing the install dialog is blocked while upload/validation is pending.
- Failed mutations keep user input visible and show one safe actionable message.
- Retry repeats only the failed query.
- Stale selected skill IDs are removed from the URL after the inventory confirms they are unavailable.

## Acceptance criteria

1. `/ui/skills` appears under Configure and restores `skill`, `q`, and `tab` state from the URL.
2. The split layout stacks at narrow widths and remains keyboard accessible.
3. Viewers can search and inspect sanitized skill data but cannot see or invoke mutation controls.
4. Administrators can install a valid ZIP without attaching an agent.
5. Same-name installation updates the existing skill after displaying the approved warning.
6. Files are lazy-loaded; text is previewed safely and binary content is metadata-only.
7. Declared actions remain read-only and are never authorized from the Skills page.
8. Attachment replacement is atomic, supports disabled agents, and synchronizes through existing settings projection.
9. Attached instructions become available on the agent’s next run; existing runs do not change.
10. Errors preserve the last confirmed UI state and disclose no sensitive implementation detail.

## Verification

### Browser facade

- authentication required for every route
- viewer reads and administrator mutations
- viewer mutation rejection
- canonical-Origin, CSRF, and hosted recent-reauthentication enforcement
- app isolation for skills and agents
- sanitized inventory and file responses
- ZIP media type, size, unsafe-path, symlink, required-file, expanded-size, and file-count validation
- same-name update behavior
- UTF-8 text preview and binary metadata-only behavior
- distinct-agent and 100-agent bounds
- atomic attachment activation and detachment, including disabled agents
- rollback on validation or transaction failure
- one settings projection after a successful attachment replacement

### Web UI

- navigation and count
- URL restoration and invalid-value fallback
- inventory search and empty states
- viewer read-only behavior
- install selection, pending, success, and failure states
- same-name warning
- lazy Files behavior and isolated retry
- instruction-only and declared-action rendering
- disabled-agent label and selection
- attachment success and failure behavior
- navigation to the Agent Access tab
- keyboard operation, focus return, labels, live status announcements, and narrow-width stacking

### Functional check

Run the real local web console and API. Install a fixture ZIP, inspect its text and binary entries, attach active and disabled agents, verify the next-run wording, navigate to Agent Access, detach the agents, and confirm action authority did not change.

Implementation verification must use the repository's deterministic `verify.py` gate and record the required automated and functional evidence in `.factory/`.

## Surface Impact Matrix

| Surface | Status | Reason |
|---|---|---|
| Runtime behavior | Unchanged by design | Existing selected-skill projection handles future runs. |
| `settings.yaml` | Changed | Attachment changes synchronize through the existing projection path. |
| Postgres/runtime projection | Changed | Existing skill-binding rows change; no schema migration is required. |
| Control API | Unchanged by design | Existing `/v1` behavior remains intact; browser-session routes are separate. |
| SDK/contracts | Changed | Add the bounded browser attachment request schema; no public SDK method changes. |
| CLI | Unchanged by design | CLI install/remove behavior remains agent-oriented. |
| Gantry MCP tools/admin skill | Unchanged by design | No new agent-admin authority is introduced. |
| Channel/provider adapters | Not applicable | Skills management is console-only. |
| Docs/prompts | Changed | Record the Skills UI contract and next-run semantics. |
| Audit/events | Unchanged by design | Reuse the current skill lifecycle without adding a new event model. |
| Tests/verification | Changed | Add browser-facade, web, and functional coverage. |

## Explicitly Out of Scope

- global skill enable, disable, or deletion
- artifact garbage collection
- binary file download
- editing package files
- installing from a marketplace, URL, Git repository, or provider catalog
- inline capability selection or credential management
- changing Control API or CLI skill semantics
- adding compatibility routes, legacy mappings, or fixture fallbacks

## Locked Decisions

- Use the split inventory/detail layout.
- Use query parameters rather than a separate detail route.
- Install into inventory first; attachment is optional and separate.
- Preserve same-name in-place updates with an explicit warning.
- Preview text only; binary files are metadata-only.
- Keep declared actions read-only and link to Agent Access.
- Allow disabled-agent attachment with explicit wording.
- Viewer reads; administrator mutates.
- Save the desired attachment set atomically.
- Keep installed packages, agent attachments, and action authority as separate lifecycle lanes.
