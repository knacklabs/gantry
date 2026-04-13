# Factory Prompt Layer

## Scope

This folder owns factory prompts, hook wiring, agent prompt contracts, and tests for prompt drift.

## Rules

- Keep prompts decision-complete and behavior-focused. Do not pad them with generic process language.
- Prefer changed-behavior tests, regression coverage, edge-case review, and bug finding over repo-wide coverage targets.
- Keep hook behavior adaptive for local work unless a formal factory gate truly requires hard enforcement.
- Avoid prompt duplication. If a rule belongs in a shared checklist, put it in `prompts/self-check.md` and reference it from other prompts.
- When adding prompt policy, add or update tests under `.codex/scripts/tests/` so the contract does not silently drift.
- Do not let prompt changes invent new product behavior or bypass the existing PR-ready review gates.
