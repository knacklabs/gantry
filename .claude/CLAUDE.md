# Claude Code adapter — Symphony Forge

<!-- canon: AGENTS.md -->
Read `AGENTS.md` first; it is the contract. Standards live in `constitution/`
(<!-- canon: constitution/README.md -->) and phase ownership in `harness.yaml`.

## Role split (enforced)

- Claude Code coordinates: discovery, planning, decisions, orchestration.
- Codex executes: exploration, implementation, testing, AND the review — ONE
  three-lens pass PER TASK via `./forge review <id>`, WATCHED (Codex engine, never nested; records the task's proof — 0011/0049); loop fixes→re-review until clean, then pr-ready → PR → poll CI green. Never stop at review, and never turn a finding into a menu for the human (AGENTS.md "Review findings are not a menu").
- READ BEFORE YOU ASSERT (planner.md): open the type/enum/route/decision you write a rule about — docs record the design, the grill checks what was built. Delegate BREADTH only: `/codex:rescue` read-only, NEVER raw `codex exec`.

## codex-plugin-cc

- `./forge delegate <task-id>` composes the brief and runs the installed companion
  with a fixed shell-free argv, deriving `--write` from stage state.
  Allowlisted direct read-only status/resume/task calls pass; writes route to delegate.
- WATCH it EVERY time — every Codex release (delegate, the read-only grill, AND the review),
  never fire-and-forget: `./forge codex status` + Monitor `.factory/signals.jsonl`;
  workers raise contradiction/confusion/blocked/scope-change and PAUSE — `./forge
  signal resolve <id>`, then resume. `stage done` MEASURES the diff; partial work is `--incomplete "<gap>"`.
- PARALLELIZE whenever separation allows: `./forge roadmap parallel` → one
  worktree + companion per unblocked story. Tasks inside a story stay sequential;
  parallel work belongs in separate story worktrees (WORKFLOW.md Concurrency).
- The Stop-hook review gate must stay DISABLED (`/codex:setup --disable-review-gate`).
- If the plugin is unavailable, follow `docs/degraded-mode.md`.

## Ground rules
- Session write lock always armed; plan authoring is mode-agnostic (0050) — never switch the session's mode to write a plan, and no mode unlocks product/canon: delegate
  writes, or during a companion outage `forge mode degraded start --reason`. Grill
  (`/grill-me`) = ONE read-only Codex `gpt-5.6-sol` @ high cold read (you authored it — never a Claude sub-agent, never inline), WATCHED. That is the WHOLE grill: resolve what the REPO answers yourself, put only the rest to the human in that grill (AskUserQuestion), amend once, record the pass against the amended version. Never cold-read twice — a second read returns a DIFFERENT frontier, not a shorter one. The plan then shows on the BOARD, the human reviews it THERE (not chat) and approves
  EXACTLY ONCE — `./forge plan approve --by "<name>"` + re-save. Never approve twice.
- Decisions: `./forge decision new <slug>`; acceptance is HUMAN chat
  confirmation — then run accept/sign-off yourself, `--by "<name>"` + trailer.
- Recording sign-off requires confirmed specs and their derived roadmap.
- Project facts go in `docs/memory/` (0012); user-level memory is personal only.
- `python3 factory/scripts/check_dual_runtime.py` must stay green.
- gstack `/codex` and `/ship` are disabled in factory repos (see `harness.yaml`).
