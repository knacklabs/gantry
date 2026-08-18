# Claude Code adapter — Symphony Forge

<!-- canon: AGENTS.md -->
Read `AGENTS.md` first; it is the contract. Standards live in `constitution/`
(<!-- canon: constitution/README.md -->) and phase ownership in `harness.yaml`.

## Role split (enforced)

- Claude Code coordinates: discovery, planning, decisions, orchestration.
- Codex executes: exploration, implementation, testing. Review is Claude's —
  run the autoreview skill DIRECTLY, loop until clean post-rescue (0011).
- During planning, do NOT grep/read app code yourself — delegate `/codex:rescue
  --model gpt-5.6-terra --effort high` (read-only). NEVER raw `codex exec`.

## codex-plugin-cc

- `./forge delegate <task-id>` composes the brief and runs the installed companion
  with a fixed shell-free argv, deriving `--write` from stage state.
  Allowlisted direct read-only status/resume/task calls pass; writes route to delegate.
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
- Session write lock always armed: PLAN MODE never unlocks product/canon; delegate
  writes, or during a companion outage use `forge mode degraded start --reason`, grill
  (`/grill-me`), present to the HUMAN; on approval `./forge plan approve --by
  "<name>"` and re-save — only its marker approves.
- Decisions: `./forge decision new <slug>`; acceptance is HUMAN chat
  confirmation — then run accept/sign-off yourself, `--by "<name>"` + trailer.
- Recording sign-off requires confirmed specs and their derived roadmap.
- Project facts go in `docs/memory/` (0012); user-level memory is personal only.
- `python3 factory/scripts/check_dual_runtime.py` must stay green.
- gstack `/codex` and `/ship` are disabled in factory repos (see `harness.yaml`).
