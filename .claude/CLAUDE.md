# Claude Code adapter — Symphony Forge

<!-- canon: AGENTS.md -->
Read `AGENTS.md` first; it is the contract. Standards live in `constitution/`
(<!-- canon: constitution/README.md -->) and phase ownership in `harness.yaml`.

## Role split (enforced)

- Claude Code coordinates: discovery, planning, decisions, orchestration.
- Codex executes: exploration, implementation, testing. Review is Claude's —
  run the autoreview skill DIRECTLY, loop until clean post-rescue (0011).
- During planning, do NOT grep/read application code yourself — delegate:
  `/codex:rescue --model gpt-5.6-terra --effort high "<question>"` (read-only
  by default). NEVER raw `codex exec` — the hook blocks it.

## codex-plugin-cc

- `./forge delegate <task-id>` composes the brief and runs the installed companion
  with a fixed shell-free argv, deriving `--write` from stage state.
  All direct companion Bash calls are routed back to `forge delegate`.
- WATCH it: `./forge codex status` (still moving?) and Monitor
  `.factory/signals.jsonl` — workers raise contradiction/confusion/blocked/
  scope-change and PAUSE; `./forge signal resolve <id> --notes "<answer>"`, then
  resume. `stage done` MEASURES the diff; partial work is `--incomplete "<gap>"`.
- PARALLELIZE whenever separation allows: `./forge roadmap parallel` → one
  worktree + companion per unblocked story. Tasks inside a story stay sequential;
  parallel work belongs in separate story worktrees (WORKFLOW.md Concurrency).
- The Stop-hook review gate must stay DISABLED (`/codex:setup --disable-review-gate`).
- If the plugin is unavailable, follow `docs/degraded-mode.md`.

## Ground rules
- The planning lock is always armed. Enter PLAN MODE per `factory/prompts/planner.md`
  or run `./forge quickfix start "<reason>"`; do not fight the hook. Grill the plan
  (`/grill-me`); it is approved only when saved with `forge.py plan save`.
- Decisions: `./forge decision new <slug>`; acceptance is HUMAN chat
  confirmation — then run accept/sign-off yourself, `--by "<name>"` + trailer.
- Recording sign-off requires confirmed specs and their derived roadmap.
- Project facts go in `docs/memory/` (0012); user-level memory is personal only.
- `python3 factory/scripts/check_dual_runtime.py` must stay green.
- gstack `/codex` and `/ship` are disabled in factory repos (see `harness.yaml`).
