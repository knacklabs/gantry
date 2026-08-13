---
slug: web-console-agent-directory-profile-refresh
title: Web Runtime Console: Agent directory and profile refresh
status: confirmed
saved: 2026-08-13T15:51:19+00:00
---

# Agent Directory and Profile Refresh

## Why

The private Gantry console exposes real agent inventory, but the directory and
detail page are still a foundation rather than a scannable operator view. An
operator needs to understand one agent's intended composition, safe skills and
capabilities, access condition, and observed work without confusing any of
those concepts or receiving Control API credentials in the browser.

## Behaviour

- Restyle only the Agents directory and the clicked-agent profile using the
  existing Gantry light/dark tokens and primitives. The treatment uses compact
  segmented controls, quiet surfaces, dashed section boundaries, dense status
  chips, and scannable activity rows; it adds no UI dependency.
- The directory filters locally after a 200ms debounce. Pressing Enter applies
  the pending filter immediately and neither navigates nor refetches. Its
  header says `Agents`, its description says `Inspect configured agent
  composition and recent activity from this Gantry deployment.`, and the
  search field is labelled `Search agents` with placeholder `Filter by agent
  name`.
- An agent profile is read-only and has five sections: Summary, Delegation,
  Skills & capabilities, Access, and Activity. Summary is eager; the other
  sections load only when selected. Existing legacy tab query values continue
  to open their matching canonical section without a redirect.
- Summary shows persisted agent state, agent ID, updated time, bound
  conversation count, and counts for configured delegates, bound skills,
  selected capabilities, and access needing attention. A dependent read that
  fails shows `Unavailable`, never zero.
- Delegation shows direct configured references plus their resolved callable
  agents, with a one-level tree rooted at the selected agent. It states:
  `Configured delegation is intended composition, not live execution.`
- Skills & capabilities safely joins current bindings/selections to their
  catalog records. Skills expose only name, optional description, binding
  status, and updated time. Capabilities expose only id, display name,
  category, risk, version, and concise can/cannot text.
- Access exposes only the existing Connected, Allowed, Needs attention, and
  Suggested cleanup safe summary groups.
- Activity shows the newest 20 app-owned runs for the selected agent and its
  bounded scheduled jobs. Runs link to the existing activity detail and task
  tree. The tab polls every 30 seconds only while a visible run is nonterminal.
- Browser reads remain same-origin `/ui/api/*`. The UI server holds the
  Control credential. There are no mutations, auth changes, roles, restarts,
  re-imports, reconciliation controls, raw event payloads, secrets, command
  templates, source references, storage references, or transport data.
- `GET /v1/activity` accepts optional `agentId` and `limit` query parameters.
  It retains its existing newest-50 behavior without them, requires
  `sessions:read`, rejects unknown/repeated/malformed/out-of-range parameters,
  and returns only app-owned runs. `limit` is 1 through 50; the UI facade uses
  20. The repository query has an `(app_id, agent_id, created_at DESC, id DESC)`
  index.

## Acceptance criteria

1. The Agents area alone receives the new visual treatment; all other console
   routes and shared global visual primitives remain unchanged.
2. The profile accurately distinguishes persisted agent state, configured
   delegation, selected permissions, and observed execution.
3. Summary and enriched relationship resources emit only their stated safe
   projections; a browser bundle and UI response never contain Control keys,
   capability internals, skill storage/configuration, raw events, or task
   correlation data.
4. Agent-scoped activity is app-owned, newest-first, bounded to 20 in the UI,
   and efficiently indexed without a data rewrite.
5. Core Control API, repository, SDK, and UI-server facade coverage proves
   filtering, bounds, redaction, partial availability, and safe projection.
   No React component, browser automation, snapshot, or visual-regression test
   suite is added; the changed user flow receives a manual local check.
