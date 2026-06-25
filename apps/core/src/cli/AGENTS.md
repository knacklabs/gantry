# CLI

## Scope

- `apps/core/src/cli/` owns local operator commands, guided setup prompts, and
  runtime-home bootstrap flows.

## Rules

- First-run setup must choose channel and model before Model Access
  credentials. Do not prompt for harness in setup; persist `agentHarness: auto`
  so Gantry derives Anthropic SDK or DeepAgents from the selected model route.
  Credential prompts must derive required providers from the selected chat
  model, inherited job defaults, memory preset defaults, and enabled embedding
  settings; do not show unrelated model providers in first-run setup.
- Setup credential collection may bootstrap only the storage/env material needed
  for Credential Center writes before final config. Do not persist channel,
  agent, or conversation runtime config before the review/create step.
- Model setup must keep public selection in friendly catalog aliases. Raw
  provider model ids may appear only as internal `modelRoute.metadata` or
  runtime accounting input, not as setup/API/job/MCP selectors.
- Harness configuration is `agentHarness` / `agent_harness` with values `auto`,
  `anthropic_sdk`, and `deepagents`. First-run setup uses `auto`; explicit
  post-ready/admin model-harness mismatches must fail before runner spawn.
