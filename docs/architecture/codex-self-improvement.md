# Codex Self-Improvement Harness

The self-improvement harness helps future coding agents reuse architecture
lessons without adding a new workflow engine. It is intentionally local,
dependency-free, and compatible with plain Codex.

## Files

- `.codex/lessons.jsonl` stores one lesson per line.
- `.codex/scripts/record_lesson.py` appends validated lessons.
- `.codex/scripts/select_relevant_lessons.py` selects lessons for a prompt or changed file list.
- `.codex/scripts/check_task_completion.py` warns about likely missing tests or docs before final handoff.
- `.codex/skills/*/SKILL.md` provides focused workflows for architecture refactors, permission safety, schema changes, and provider adapters.

## Lesson Workflow

Record a lesson after a repeated failure, review finding, architecture exception, or surprising verification miss:

```bash
python3 .codex/scripts/record_lesson.py \
  --topic "permission safety" \
  --lesson "Risky browser actions must pass through deterministic permission decisions before runner access." \
  --source "quality review 2026-04-26" \
  --applies-to "apps/core/src/runtime/**" \
  --applies-to "apps/core/src/adapters/browser/**" \
  --severity high
```

Select relevant lessons before implementation or review:

```bash
python3 .codex/scripts/select_relevant_lessons.py \
  --prompt "refactor sandbox browser permissions" \
  --changed-file apps/core/src/adapters/browser/session.ts
```

JSON output is available for future tooling:

```bash
python3 .codex/scripts/select_relevant_lessons.py --json --prompt "Postgres schema migration"
```

## Completion Check

Before a final response, run:

```bash
python3 .codex/scripts/check_task_completion.py
```

The script discovers changed files with Git when no files are passed. It runs the architecture check when available and emits warnings for likely missing tests or docs, including schema, permission, provider, and channel adapter changes. Warning-only gaps do not fail the command; architecture failure exits nonzero.

For targeted checks:

```bash
python3 .codex/scripts/check_task_completion.py \
  --changed-file apps/core/src/adapters/storage/postgres/schema/schema.ts
```

## Hooks

This repo already has hooks configured in `.codex/hooks.json`, and `.codex/config.toml` enables `codex_hooks` and `skills`. The current hooks provide startup context, user prompt guidance, destructive command safety, and non-blocking stop behavior.

The self-improvement harness is not wired into hooks by default. Completion checks are intentionally manual unless a future PR updates hook policy, hook tests, and the docs together. Plain Codex sessions that do not auto-load local skills should read the relevant `.codex/skills/*/SKILL.md` file directly.
