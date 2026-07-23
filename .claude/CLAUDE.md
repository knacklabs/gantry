# Claude Code adapter — Symphony Forge

<!-- canon: AGENTS.md -->
Read `AGENTS.md` first; it is the contract. Standards live in `constitution/`
(<!-- canon: constitution/README.md -->) and phase ownership in `harness.yaml`.

## Role split (enforced)

- Claude Code coordinates: discovery, planning, decisions, orchestration.
- Codex executes: exploration, implementation, testing, review.
- During planning, do NOT grep/read application code yourself — delegate:
  `/codex:rescue --model gpt-5.6-terra --effort high "<question>"` (read-only
  by default). NEVER raw `codex exec` — the hook blocks it, no exceptions.

## codex-plugin-cc

- Delegate implementation with `/codex:rescue --background` (gpt-5.6-sol @
  medium; effort `high` for migrations/cross-domain/security). Then WATCH
  the event channel: Monitor `.factory/signals.jsonl` alongside the job —
  workers raise contradiction/confusion/blocked/scope-change signals and
  PAUSE instead of guessing. On an event: `./forge signal resolve <id>
  --notes "<answer>"`, then resume the rescue with the resolution.
- PARALLELIZE whenever separation allows: `./forge roadmap parallel` → one
  worktree + background rescue per unblocked story; within a task fan out
  only across disjoint write_scope (contract: WORKFLOW.md Concurrency).
- Review = ONE autoreview run in Codex, three lenses (`.agents/prompts/reviewer.md`).
- The Stop-hook review gate must stay DISABLED (`/codex:setup --disable-review-gate`).
- If the plugin is unavailable, follow `docs/degraded-mode.md`.

## Ground rules

- Per-task planning is MANDATORY in PLAN MODE here (`.agents/prompts/planner.md`);
  the hook blocks product-code edits while unplanned — switch modes, don't
  fight it. Grill the plan (`/grill-me`), then it's approved only when saved:
  `python3 .agents/scripts/forge.py plan save --from <plan-file>`.
- Decisions land via `./forge decision new <slug>`; acceptance is HUMAN — an
  explicit chat confirmation lets you run the accept with `--by "<name>"`.
- Phases ≥ planning require client sign-off (`python3 .agents/scripts/record_signoff.py`).
- `python3 .agents/scripts/check_dual_runtime.py` must stay green.
- gstack `/codex` and `/ship` are disabled in factory repos (see `harness.yaml`).
