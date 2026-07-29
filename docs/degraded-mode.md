# Degraded Mode

`codex-plugin-cc` is a REQUIRED tool — `./forge doctor --fix` installs it on
every machine, so "the plugin isn't installed" is a setup failure, not a
workflow branch. If it breaks mid-project (upstream regression, cache
corruption), degraded mode is two moves — neither of which is raw
`codex exec`, which stays hook-blocked with no escape hatch:

## 1. Repair it

```bash
./forge doctor --fix
# or explicitly:
claude plugin marketplace add https://github.com/openai/codex-plugin-cc
claude plugin install codex@openai-codex
```

## 2. Meanwhile: work in Codex directly

The Codex CLI is itself a sanctioned runtime — a Codex session reads the same
`AGENTS.md`, `.codex/config.toml` (gpt-5.6-sol @ medium), agents, and skills:

- **Exploration**: a read-only Codex session, or `codex --profile explore`
  (gpt-5.6-terra @ high, `.codex/explore.config.toml`).
- **Planning**: the `planner-high` agent with `.agents/prompts/planner.md` —
  the plan grill and `forge plan save` gates apply unchanged.
- **Implementation**: a Codex session following
  `.agents/prompts/implementer.md`, one bounded task at a time.
- **Testing / review / functional**: same specialist agents, same recorders:

```bash
python3 .agents/scripts/record_test_from_json.py --kind automated --input /tmp/automated.json
python3 .agents/scripts/verify.py
python3 .agents/scripts/record_review_from_json.py --aspect quality --input /tmp/quality.json
python3 .agents/scripts/record_review_from_json.py --aspect performance --input /tmp/performance.json
python3 .agents/scripts/record_review_from_json.py --aspect security --input /tmp/security.json
python3 .agents/scripts/record_test_from_json.py --kind functional --input /tmp/functional.json
python3 .agents/scripts/pr_ready.py
```

The artifacts and gates never change — degraded mode swaps the coordinator,
never the contract. Return to Claude + `/codex:rescue` the moment the plugin
works again.
