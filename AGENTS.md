# MyClaw

## What This Repo Is

MyClaw is a single-process Node.js personal assistant runtime with skill-based channels.
Messages are ingested from channels, persisted in SQLite, then routed to Codex agents through the host runtime.

Primary surfaces:

- `apps/core/src/index.ts`: orchestrator loop and runtime wiring
- `apps/core/src/runtime/group-queue.ts`: per-group queue and retry behavior
- `apps/core/src/runtime/agent-spawn.ts`: host execution path
- `apps/core/src/runtime/runtime-diagnostics.ts`: host runtime health checks
- `apps/core/src/session/session-commands.ts`: host-managed slash commands
- `apps/core/src/storage/db.ts`: persistence for groups, messages, tasks, and sessions

## Mandatory Read Order

1. [README.md](README.md)
2. [WORKFLOW.md](WORKFLOW.md)
3. [docs/FACTORY.md](docs/FACTORY.md)
4. [docs/QUALITY.md](docs/QUALITY.md)
5. [CONTRIBUTING.md](CONTRIBUTING.md)

Use `python3 .codex/scripts/stage_orchestrator.py` to get current phase commands and required artifacts.

## Runtime Modes

- Host runtime is the only supported mode in this repo today.
- Docker Compose/container runtime support is deferred to future work and must not be documented as active.

Important constraints:

- `/new` clears persisted session state but preserves the group model override
- transcript archive during `/new` is best-effort and must not block reset success
- per-agent memory remains isolated in `~/myclaw/agents/<folder>/`

## Docs Rules

- User-facing and project-facing docs must use `MyClaw` naming.
- Do not reintroduce legacy branding in active docs or instructions.
- Avoid fork/upstream framing in active guidance. Prefer neutral repo, branch, or shared-remote wording.
- Prefer local repo docs over speculative external docs links unless the external target is verified current.
- When docs policy changes, update this file in the same PR.

## Development Policy

- MyClaw is early-stage: do not add legacy compatibility layers for breaking changes unless explicitly requested by the user.
- Prefer clean cutovers over dual-path behavior (no fallback branches, shim flags, or backward-compat code by default).
- Remove obsolete code paths in the same change when introducing a breaking replacement.
- Every implementation task must end with a subagent review pass before marking the work complete.

## Hard Gates

Before merge or release:

1. `npm run build`
2. `npm test`
3. `python3 .codex/scripts/verify.py`
4. `python3 .codex/scripts/validate_artifacts.py --allow-missing-run`

If running full factory mode:

1. `python3 .codex/scripts/validate_work.py`
2. required artifacts must exist for decomposition, testing, and review
3. `python3 .codex/scripts/pr_ready.py` must pass

## Repo Hygiene

- Do not track generated artifacts from local runs or hooks, including `__pycache__`, `*.pyc`, coverage output, and `.factory/tool-history.jsonl`.
- Do not commit active `.factory/` run artifacts or package tarballs; keep the repo snapshot free of local verification output.
- Background maintenance timers must be stoppable so tests and CI can exit cleanly.
- Keep docs concise, non-duplicative, and aligned with the current product behavior.
- When changing the npm publish surface, update `package.json` publish entries and verify `npm pack --dry-run` does not ship internal scaffolding.
