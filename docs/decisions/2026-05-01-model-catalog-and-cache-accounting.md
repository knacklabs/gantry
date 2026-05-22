# Model Catalog and Cache Accounting

## Context

Gantry needs model selection to work the same way from chat commands, API/SDK
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

Gantry owns a provider-neutral catalog in application code. Users select models
through friendly aliases such as `opus`, `sonnet`, `haiku`, and `kimi`; aliases
are case-insensitive and punctuation-insensitive. Raw provider IDs such as
`claude-opus-4-7` and `moonshotai/kimi-k2.6` are rejected at user/API/job/MCP
boundaries unless registered as catalog aliases.

Catalog entries declare workload eligibility for chat, one-time jobs,
recurring jobs, memory extraction, memory dreaming, and memory consolidation.
A cataloged alias can still be rejected when it is not eligible for the
requested workload. `/v1/models` exposes aliases, response family, diagnostic
model route metadata, execution provider id, credential profile reference,
capability descriptors, and supported workloads without exposing raw credential
details or treating provider model IDs as selectors.

Vocabulary:

- `modelAlias`: the normal user-facing selector.
- `responseFamily`: the canonical API shape, currently `anthropic` plus
  schema-only `openai`.
- `modelRoute`: diagnostic/source metadata such as Anthropic or OpenRouter,
  including metadata-only provider model IDs.
- `executionProviderId`: the adapter projection id resolved by the runtime.
- `credentialProfileRef`: the model-access credential profile, currently
  `gantry-model-access`.
- `capabilities`: observable support/readiness descriptors for streaming, tool
  use, MCP/browser/sandbox projection, session resume, thinking controls,
  token/cache accounting, and structured output.

Interactive model precedence is:

1. session `/model` override
2. agent interactive default (`agent.default_model`)
3. system default `opus`

Job model precedence is:

1. explicit job `modelAlias`
2. job-kind default (`agent.one_time_job_default_model` or
   `agent.recurring_job_default_model`)
3. agent interactive default
4. system default `opus`

Memory model precedence is runtime-owned and settings-backed:

1. memory task default in `memory.llm.models`
2. preset-managed defaults for the current model route
3. system memory defaults

Model presets are:

- `anthropic`: chat `opus`; one-time and recurring jobs inherit chat; memory
  defaults use extractor `haiku`, dreaming `sonnet`, consolidation `sonnet`.
- `openrouter`: chat uses `kimi`; jobs inherit chat; extractor, dreaming, and
  consolidation use `kimi`.

`gantry setup`, `gantry model use-preset`, `gantry model set chat`,
`gantry model set jobs`, `gantry model reset`, and `PATCH /v1/models/defaults`
all write `settings.yaml`. Postgres projections are not the source of truth for
model defaults. Memory extraction, dreaming, and consolidation read the current
validated settings at call time so new runs pick up model changes without a
service restart.

Catalog entries expose `responseFamily` as the canonical API shape, currently
`anthropic` with `openai` reserved for schema-only future support. OpenRouter is
route metadata on Anthropic-family aliases, not a core response family or
execution provider selector.

Provider SDK response usage is normalized into input tokens, output tokens,
cache read tokens, cache write tokens, cache provider/status, and estimated
cost when known. Job lifecycle events include the resolved catalog entry ID,
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
- CLI onboarding asks for a preset first, then shows catalog-generated aliases
  for that route. Memory defaults remain preset-managed.
- Raw provider model IDs stay out of normal UX and are visible only under
  diagnostic route metadata.
- New providers require catalog entries and adapter projection rules before they
  can be selected.
- Raw provider credentials remain wrong-lane config and must not be accepted
  from Gantry `.env` or ambient process env.
