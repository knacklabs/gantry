# MyClaw

## What This Repo Is

MyClaw is a single-process Node.js personal assistant runtime with skill-based channels.
Messages are ingested from channels, persisted in the configured runtime store, then routed to Codex agents through the host runtime.

Primary surfaces:

- `apps/core/src/index.ts`: package/runtime entrypoint
- `apps/core/src/app/bootstrap/runtime-app.ts`: runtime wiring and lifecycle
- `apps/core/src/runtime/group-queue.ts`: per-group queue and retry behavior
- `apps/core/src/runtime/agent-spawn.ts`: host execution path
- `apps/core/src/session/session-commands.ts`: host-managed slash commands
- `apps/core/src/infrastructure/postgres/schema/`: Postgres persistence for groups, messages, jobs, control events, and memory

## Mandatory Read Order

1. [README.md](README.md)
2. [WORKFLOW.md](WORKFLOW.md)
3. [docs/FACTORY.md](docs/FACTORY.md)
4. [docs/QUALITY.md](docs/QUALITY.md)

Use `python3 .codex/scripts/stage_orchestrator.py` to get current phase commands and required artifacts.

## Runtime Modes

- Host runtime is the only supported mode in this repo today.

Important constraints:

- `/new` clears persisted session state but preserves the group model override
- transcript archive during `/new` is best-effort and must not block reset success
- durable memory lives under the configured memory root; do not load `~/myclaw/agents/<folder>/memory/`

## Docs Rules

- User-facing and project-facing docs must use `MyClaw` naming.
- Do not reintroduce legacy branding in active docs or instructions.
- Avoid fork/upstream framing in active guidance. Prefer neutral repo, branch, or shared-remote wording.
- Prefer local repo docs over speculative external docs links unless the external target is verified current.
- Always add or update the documentation as we develop or changes features as it helps developers to understand
- When docs policy changes, update this file in the same PR.

## Development Policy

- MyClaw is early-stage: do not add legacy compatibility layers for breaking changes unless explicitly requested by the user.
- Prefer clean cutovers over dual-path behavior (no fallback branches, shim flags, or backward-compat code by default).
- Do not add migration compatibility commands, auto-migration flows, cleanup shims, or runtime branches that exist only to support old local state. If a breaking change requires moving local data or config, document the one-time manual cleanup steps and keep the shipped runtime on the new single path.
- Remove obsolete code paths in the same change when introducing a breaking replacement.
- Do not add test-only or local-checkout branches to production code. Keep shipped behavior deterministic for the supported install/runtime path; handle local testing differences manually in local runtime files or inside test harnesses.
- For every change or feature implementation, own the holistic architecture, not only the literal user request. If the request omits provider boundaries, configuration ownership, onboarding, security, testing, docs, or operational impacts, identify those implications, explain the needed corrections to the user, and implement the coherent architecture rather than waiting for every detail to be enumerated.
- Classify every new config value before implementation: non-secret configuration belongs in `settings.yaml`, runtime-owned secrets belong behind `RuntimeSecretProvider`, and agent-accessed credentials belong behind `AgentCredentialBroker`. Do not add new `.env` or process-env config keys unless they are runtime-owned secrets.
- Wrong-lane credential/config values must fail loudly. Raw model/provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `CLAUDE_CODE_OAUTH_TOKEN` must never be accepted from MyClaw `.env` or process env; move them to the selected credential broker.
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

- Do not track generated artifacts from local runs or hooks, including `__pycache__`, `*.pyc`, coverage output, and validation reports.
- Do not commit active `.factory/` run artifacts or package tarballs; keep the repo snapshot free of local verification output.
- Background maintenance timers must be stoppable so tests and CI can exit cleanly.
- Keep docs concise, non-duplicative, and aligned with the current product behavior.
- When changing the npm publish surface, update `package.json` publish entries and verify `npm pack --dry-run` does not ship internal scaffolding.
- We need single cut feature with no support for legacy or backward compatibility, no runtime behavior to handle deleting legacy files, and no migration commands for old local state. Keep it clean; any one-time migration is manual and documented.
- Always follow provider pattern for any external sources.
- Always follow single responsibility principle applied.
