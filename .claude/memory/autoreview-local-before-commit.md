---
name: autoreview-local-before-commit
description: "Feedback: autoreview each stage's LOCAL uncommitted diff before committing; run the branch-wide pass only once at closeout for integration issues"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 60294553-f2ce-49f9-a192-c146585f09cc
---

**MANDATORY FOR ALL COMMITS (user, 2026-07-22):** local autoreview is required before EVERY commit — no exceptions. This explicitly INCLUDES the orchestrator's own main-shell commits: (a) committing a Codex lane's staged handoff from the main shell (Codex sandbox blocks its own commit), and (b) the orchestrator's own hand-edits/fixes/dep changes (e.g. a security-override commit like #263). Previously these main-shell commits skipped autoreview — that gap is closed. Command: `python3 ~/.codex/skills/autoreview/scripts/autoreview --mode local` on the staged/uncommitted diff; triage + fix accepted findings while uncommitted; only `git commit` when autoreview is clean. Never commit unreviewed.

In staged codex builds (the [[dev-experience-gap-analysis]] / gantry-goal-pipeline flow), run `autoreview --mode local` (reviews the uncommitted working tree) on each stage's diff BEFORE committing, fix findings while still uncommitted, then commit clean. Run the whole-branch `autoreview --mode branch --base origin/main` only ONCE at closeout, as the integration pass.

**Why:** reviewing the whole branch after every commit re-reviews already-reviewed committed code, is slow (the branch bundle grows each round ~196KB), and only catches a stage's defects after they are already in history. Per-stage local review is faster (just that stage's diff), keeps defects out of git history, and still leaves the final branch pass to catch cross-stage integration issues a per-stage review can't see.

**How to apply:** codified in `.claude/skills/gantry-goal-pipeline/SKILL.md` §3.3 (per-stage local review before commit) and §4 (final branch pass = integration only). `autoreview` supports `--mode local` (alias `uncommitted`) and `--mode auto` (local when dirty). Run it via the same codex plain-command handoff as the branch pass, with `--mode local` and no `--base`.

**Codex effort policy (user, 2026-07-13):** `--effort high` for ALL code implementation and code exploration handoffs; `--thinking xhigh` for autoreview runs only (local and branch). xhigh is reserved for the review pass, not implementation. Codified in the same skill (§2 impl handoff line, §3.3 local review, §4 branch pass).
