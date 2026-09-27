---
name: gantry-change-contract
description: Enforces Gantry planning and handoff discipline for meaningful feature, fix, refactor, or replacement work. Use when a task needs a plan, Surface Impact Matrix, no-legacy cleanup evidence, verification selection, or PR-ready handoff.
---

# Gantry Change Contract

Use this skill before implementation when a change affects runtime behavior,
configuration, persistence, APIs, CLI, MCP/admin tools, docs/prompts, audit
events, or tests.

## Required Workflow

1. Read `AGENTS.md` and `docs/architecture/current-verification-commands.md`.
2. Convert vague requests into acceptance criteria and bounded write scopes before editing.
3. Include a Surface Impact Matrix with these surfaces: runtime behavior, `settings.yaml`, Postgres/runtime projection, control API, SDK/contracts, CLI, Gantry MCP tools/admin skill, channel/provider adapters, docs/prompts, audit/events, and tests/verification.
4. Classify each surface as `Changed`, `Read-only/observable`, `Unchanged by design`, `Deferred`, or `Not applicable`.
5. Give a short reason for every `Deferred` and `Unchanged by design` entry.
6. For replacement work, include cleanup search terms for old type names, table names, imports, entrypoints, and legacy behavior.
7. Choose the smallest relevant verification commands from `docs/architecture/current-verification-commands.md`, then run broader gates when the surface or risk requires them.

## Evidence To Provide

- Acceptance criteria and bounded write scope.
- Surface Impact Matrix with reasons for non-changed surfaces.
- Cleanup search results for clean-cut or no-legacy work.
- Verification commands run and any commands intentionally skipped.
