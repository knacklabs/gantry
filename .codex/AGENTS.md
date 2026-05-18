# Factory Prompt Layer

## Scope

This folder owns factory prompts, hook wiring, agent prompt contracts, and tests for prompt drift.

## Rules

- Keep prompts decision-complete and behavior-focused. Do not pad them with generic process language.
- Prefer changed-behavior tests, regression coverage, edge-case review, and bug finding over repo-wide coverage targets.
- Keep hook behavior adaptive for local work unless a formal factory gate truly requires hard enforcement.
- Prefer native Codex rules for command policy. Keep any `PreToolUse` coverage narrow, silent on allow, and limited to command semantics that prefix rules cannot express.
- Avoid prompt duplication. If a rule belongs in a shared checklist, put it in `prompts/self-check.md` and reference it from other prompts.
- When adding prompt policy, add or update tests under `.codex/scripts/tests/` so the contract does not silently drift.
- Do not let prompt changes invent new product behavior or bypass the existing PR-ready review gates.
- Deterministic verify includes an architecture phase (`python3 .codex/scripts/check_architecture.py`) before typecheck/tests.
- Architecture exceptions belong in `.codex/architecture-exceptions.json`, use the file/rule/reason/removeByPhase schema, and should stay empty unless a narrow temporary waiver makes the codebase stronger. File line-budget violations are strict and must not be excepted.
- Anthropic/Claude provider-boundary debt belongs in `.codex/provider-boundary-exceptions.json` with exact file paths and exact token counts. Do not approve broad config, memory, or shared paths for this gate.
- Direct provider-send guardrails must cover alias receiver forms, not just canonical local names. Keep Slack `*.chat.postMessage`, Telegram `*.sendMessage`, and Teams SDK `*.sendMessage` regressions covered in `.codex/scripts/tests/test_check_architecture.py`.
- Refactor line-delta checks have two explicit modes: phase progress reads a recorded T0 commit with `--baseline-file`, while final/overall deletion-budget checks use `--base-ref`. Keep both filtered to the source extensions counted by `--baseline`.
