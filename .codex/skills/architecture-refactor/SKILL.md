---
name: architecture-refactor
description: Use for folder movement, layer boundaries, and domain/application/runtime/adapters refactors in Gantry.
---

# Architecture Refactor

Use this skill when a task moves files, changes layer ownership, changes imports across `domain`, `application`, `runtime`, or `adapters`, or updates architectural boundaries.

## Required Workflow

1. Read `docs/architecture/codebase-refactor-principles.md`, `docs/architecture/codex-harness.md`, and relevant `docs/decisions/` records before editing.
2. Keep `domain` provider-free and channel-free. Keep provider SDKs, channel SDKs, Postgres, CLI, HTTP, browser, and sandbox implementations behind ports or adapters.
3. Prefer clean deletion of obsolete paths over compatibility shims unless a decision record explicitly approves a transition path.
4. Use `gantry-change-contract` when the refactor needs a Surface Impact Matrix, cleanup search, or no-legacy handoff evidence.
5. Update `scripts/architecture-map.json` only when the desired ownership model changes, not to hide current debt.
6. Run `python3 scripts/check_architecture.py` before final handoff when possible.

## Evidence To Provide

- Architecture docs or decision records read.
- Boundary rule affected.
- Tests or verification command proving the refactor did not add provider leakage.
