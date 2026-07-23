---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-22
---

# Symphony Forge Adoption

## Context

The repo previously ran its own Codex factory: a Linear-first workflow
("Linear owns task and decomposition state", `docs/context/migrated-WORKFLOW.md`),
`.codex/` scripts/prompts/hooks as the workflow engine
(`docs/context/migrated-FACTORY.md`, `migrated-codex-hooks.json`,
`migrated-codex-config.toml`), a seven-specialist review/testing roster with a
gpt-5.5 / gpt-5.3-codex reasoning matrix (`migrated-QUALITY.md`), and the
mandatory gantry-goal-pipeline for all implementation
(`docs/context/migrated-AGENTS.md`, Execution Standards).

## Decision

Adopt the symphony-forge harness (vendored @ fb3b0f6f, commit 7a3b24798) as
the workflow engine, replacing the legacy `.codex` factory, the Linear-first
task authority, the old specialist roster, and the gantry-goal-pipeline
orchestration contract with the forge phase contract (`AGENTS.md`,
`WORKFLOW.md`, `harness.yaml`).

## Consequences

- Task/decomposition state moves from Linear to the forge roadmap ledger under
  `plans/` and `.factory/` artifacts; review collapses to one autoreview pass
  (three lenses).
- Pre-adopt rule docs are preserved verbatim under `docs/context/migrated-*`
  as the raw record; they are superseded as process, but their repo-specific
  facts stay canonical in `docs/architecture/` and `docs/decisions/`.
- Legacy `.codex` machinery (scripts, prompts, skills, tests) and the
  unnumbered/frontmatter-less decision records are intentionally untouched;
  rehoming them until `check_dual_runtime.py` is green is the documented
  follow-up.
