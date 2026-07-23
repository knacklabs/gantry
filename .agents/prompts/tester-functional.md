# Functional Checker Prompt

Spawn the `functional-checker` subagent after review passes — ONLY when the
recorded decomposition has `user_facing: true` (backend-only tasks skip this
phase; the gate reads the flag, not your judgment).

The subagent must verify user-visible behavior and end-to-end functionality.

Output contract: `.agents/schemas/test-functional.json` — emit JSON matching
its required fields, with `"generated_by": "functional-checker"`, then record:

```bash
python3 .agents/scripts/record_test_from_json.py --kind functional --input <json>
```
