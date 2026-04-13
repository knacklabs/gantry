# Codex Factory

MyClaw can run a doc-driven Codex factory mode with optional ACP/ACPX orchestration.

## Runtime Model

- Product intent lives in `docs/product/BRIEF.md`.
- Architecture and decision docs live in the repo before planning starts.
- A planner owns decomposition and writes a task graph that can be mirrored into Linear.
- Plain Codex or Codex with ACP/ACPX orchestration handles implementation.
- Codex custom subagents handle testing and isolated review.
- Use Linear when you want task tracking outside the repo.
- Use GitHub when you want PR and branch status outside the repo.

## Why ACP/ACPX Is Optional

ACP/ACPX helps when you want longer-running orchestration, but this repo must still work cleanly in plain Codex.

## Why Custom Subagents

Codex subagents are explicit, parallel, and configurable per role. Project-scoped agents under `.codex/agents/*.toml` let the implementation session split work cleanly without mixing every concern into one thread.

The default specialist set is:

- `planner-high`
- `docs-decomposer`
- `automated-tester`
- `functional-checker`
- `quality-reviewer`
- `performance-reviewer`
- `security-reviewer`

## Factory Directories

- `.codex/` for hooks, agents, prompts, and deterministic scripts
- `.factory/` for machine-readable run state
- `plans/` for durable plan history
- `docs/product/` for product intent
- `docs/architecture/` and `docs/decisions/` for in-repo source of truth

## Golden Path

1. Run intake to initialize `.factory/run.json`
2. Review product, architecture, and decision docs
3. Produce and approve a plan
4. Record decomposition from the docs
5. Implement one bounded leaf task
6. Run automated testing and deterministic verify
7. Spawn the three review subagents and wait for all results
8. Run the functional checker
9. Mark PR ready and sync GitHub plus Linear
