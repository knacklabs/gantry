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
- Architecture exceptions belong in `.codex/architecture-exceptions.json`, must include owner/reason/expiry, and should be temporary caps instead of permanent waivers.
