# Model Catalog and Cache Accounting

## Context

MyClaw needs model selection to work the same way from chat commands, API/SDK
job creation, CLI defaults, recurring jobs, one-time jobs, and internal MCP
scheduler tools. Raw provider model IDs are hard to remember and make provider
details leak into user workflows.

The supported catalog for this cut is intentionally small: Anthropic Opus 4.7,
Opus 4.6, Sonnet 4.6, Haiku 4.5, and OpenRouter Kimi K2.6. Anthropic documents
Opus 4.7, Sonnet 4.6, and Haiku 4.5 IDs, context windows, max outputs, and
pricing in its model overview. Anthropic prompt caching reports
`cache_creation_input_tokens` and `cache_read_input_tokens`. OpenRouter's
Anthropic Agent SDK route uses `https://openrouter.ai/api`,
`ANTHROPIC_AUTH_TOKEN`, and an explicitly blank `ANTHROPIC_API_KEY`.
OpenRouter lists Kimi K2.6 as `moonshotai/kimi-k2.6` with a 262,142-token
context window.

## Decision

MyClaw owns a provider-neutral catalog in application code. Users select models
through friendly aliases such as `opus`, `sonnet`, `haiku`, and `kimi`; aliases
are case-insensitive and punctuation-insensitive. Raw provider IDs such as
`claude-opus-4-7` and `moonshotai/kimi-k2.6` are rejected at user/API/job/MCP
boundaries unless registered as catalog aliases.

Interactive model precedence is:

1. session `/model` override
2. agent interactive default (`agent.default_model`)
3. system default `opus`

Job model precedence is:

1. explicit job `modelAlias` or `modelProfileId`
2. job-kind default (`agent.one_time_job_default_model` or
   `agent.recurring_job_default_model`)
3. agent interactive default
4. system default `opus`

Provider SDK response usage is normalized into input tokens, output tokens,
cache read tokens, cache write tokens, cache provider/status, and estimated
cost when known. Job lifecycle events include the resolved catalog profile ID,
alias, model source, cache policy, and token usage when the provider reports it.

OpenRouter remains an Anthropic SDK adapter projection, not a core runtime
provider branch. For cataloged OpenRouter models, the child process receives
`ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL=https://openrouter.ai/api`,
`ANTHROPIC_AUTH_TOKEN` from `AgentCredentialBroker`, and blank
`ANTHROPIC_API_KEY`. OpenRouter response caching stays disabled; only provider
prompt-cache token fields are normalized.

## Consequences

- `/models`, `/model`, `/status`, CLI model commands, API/SDK job creation, and
  MCP scheduler tools share the same resolver.
- Provider slugs stay out of normal UX and are visible only as catalog/admin
  implementation details.
- New providers require catalog entries and adapter projection rules before they
  can be selected.
- Raw provider credentials remain wrong-lane config and must not be accepted
  from MyClaw `.env` or ambient process env.
