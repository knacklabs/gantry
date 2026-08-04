---
status: proposed
confirmed_by: ""
date: 2026-07-22
---

# Github Pm Mirror

## Context

The client wants goals/stages visible in GitHub as the project-management
surface (directive 2026-07-22). Decision 0002 deliberately moved task
authority OFF an external tracker (Linear-first) into `plans/roadmap.json`
because harness gates are deterministic and digest-bound; an external
mutable authority would make evidence unverifiable again. The client's
requirement: the mirror must be updated "religiously" — reliability must be
structural, not habitual.

## Decision

GitHub is a ONE-WAY MIRROR, never the authority. A future harness verb
(`forge roadmap sync-github`) mirrors epics -> milestones, stories -> issues
(title, acceptance criteria, depends_on in body), and status transitions ->
labels/close. The sync call is embedded INSIDE the forge lifecycle verbs
(roadmap import, stage/story transitions) so it cannot be forgotten — plus a
`sync-github --check` drift report. Sync is best-effort and never a gate
input; story keys in branch names auto-link PRs to issues.

## Consequences

- `plans/roadmap.json` remains the sole source of truth; GitHub edits are
  re-grooming signals, never auto-imported.
- v1 scope excludes Projects boards and two-way sync (milestones + issues +
  auto-closing PRs cover visibility); the build lands in the symphony-forge
  harness and reaches client repos via `forge upgrade`.
- Backlogged in the harness repo; implementation is future work, not part of
  any current story.
