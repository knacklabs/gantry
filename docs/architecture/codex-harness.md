> **Historical (2026-07-22):** this describes the pre-harness `.codex` factory, whose machinery was removed when the symphony-forge harness was adopted (see `docs/decisions/0002-symphony-forge-adoption.md`). Retained as architecture history; do not run the commands in it.
<!-- doc-references: frozen 2026-07-22 (decision 0036) -->

# Codex Architecture Harness

The Codex harness enforces the target Gantry architecture before large source refactors land. It is intentionally stricter than the current codebase, and the default exception file is empty so violations are visible instead of hidden by generated baselines.

## Run The Check

Use either command:

```bash
npm run check:architecture
python3 .codex/scripts/check_architecture.py
```

The full deterministic verify gate also runs the architecture check:

```bash
python3 .codex/scripts/verify.py
```

## What It Checks

The checker reads `.codex/architecture-map.json` and validates:

- forbidden imports by layer
- forbidden external/provider imports by layer
- provider-specific code outside approved adapter paths
- direct risky execution outside the sandbox adapter
- default browser profile paths
- files above the configured line budget
- empty source folders without a purpose
- wrapper-only files
- old architecture terms in production source
- active documentation links

## Exceptions

Exceptions live in `.codex/architecture-exceptions.json` as a JSON array:

```json
[
  {
    "file": "path/to/file.ts",
    "rule": "rule-name",
    "reason": "why temporary",
    "removeByPhase": "phase name or number"
  }
]
```

Counted rules should include a cap:

- `maxViolations` for import, provider, execution, and browser-path rules
- `maxOccurrences` for old-term rules

File line budgets are strict and do not support exceptions. If a file exceeds its configured line limit, split it or move responsibility into a better-owned module.

For exception-supported rules, the cap is deliberate. If a file already has five violations and a change adds a sixth, the check fails even though an exception exists.

## Removing Exceptions

Remove an exception in the same change that removes or moves the violation. The checker fails stale counted exceptions when the rule no longer sees the baseline violation.

Do not raise a cap as routine maintenance. If a cap must increase, the PR should explain why the cleanup cannot happen in that phase.

## Updating The Map

Update `.codex/architecture-map.json` when:

- a new top-level layer or package is added
- a directory changes architectural ownership
- a new adapter family becomes approved
- a new provider SDK or channel SDK is introduced
- the line-budget policy changes

The map should describe the desired architecture, not the current debt. Existing mismatches belong in `.codex/architecture-exceptions.json`.
