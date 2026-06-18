# Model Catalog and Cache Accounting

> **Status note (2026-06-14):** the model catalog and cache-accounting decision
> remains useful, but all writable `agentEngine`, provider-derived-only, and
> `agent_engine` selector language in this document is historical where it
> conflicts with
> [Agent Harness Selection](./2026-06-14-agent-harness-selection.md). The active
> public contract is `agentHarness` (`agent_harness` in `settings.yaml`), while
> `agentEngine` remains the effective read-only diagnostic.

## Context

Gantry needs model selection to work the same way from chat commands, API/SDK
job creation, CLI defaults, recurring jobs, one-time jobs, and internal MCP
scheduler tools. Raw provider model IDs are hard to remember and make provider
details leak into user workflows.

The supported catalog for this cut is intentionally small: Anthropic Opus 4.8,
Opus 4.7, Opus 4.6, Sonnet 4.6, Haiku 4.5, and OpenRouter Kimi K2.6.
Anthropic documents Opus 4.8, Sonnet 4.6, and Haiku 4.5 IDs, context windows,
max outputs, and pricing in its model overview. Anthropic prompt caching reports
`cache_creation_input_tokens` and `cache_read_input_tokens`. OpenRouter lists
Kimi K2.6 as `moonshotai/kimi-k2.6` with a 262,142-token context window.

## Decision

Gantry owns a provider-neutral catalog in application code. Users select models
through friendly aliases such as `opus`, `sonnet`, `haiku`, and `kimi`; aliases
are case-insensitive and punctuation-insensitive. Raw provider IDs such as
`claude-opus-4-8` and `moonshotai/kimi-k2.6` are rejected at user/API/job/MCP
boundaries unless registered as catalog aliases.

Catalog entries declare workload eligibility for chat, one-time jobs,
recurring jobs, memory extraction, memory dreaming, and memory consolidation.
A cataloged alias can still be rejected when it is not eligible for the
requested workload. `/v1/models` exposes aliases, response family, diagnostic
model route metadata, per-engine execution routes, credential profile reference,
capability descriptors, and supported workloads without exposing raw credential
details or treating provider model IDs as selectors.

Model selection resolves `modelAlias + agentEngine -> executionRoute`. The model
alias chooses the model and its provider route fixes the endpoint family
(`responseFamily`); the per-agent `agentEngine` chooses the harness adapter.
Each provider route declares an `executionRoutes` array keyed by engine, with the
endpoint family, credential modes, supported workloads, and the internal
`executionProviderId`. A pairing whose provider route has no execution route for
the selected engine is rejected before runner spawn rather than re-routed to a
different engine.

> Historical note: this 2026-06-13 provider-derived-only text is superseded by
> `docs/decisions/2026-06-14-agent-harness-selection.md`. Its derivation rules
> are now the behavior of `agentHarness: auto`. The cache-accounting parts of
> this ADR are unchanged; only the public selector framing is superseded.

Vocabulary:

- `modelAlias`: the normal user-facing selector.
- `agentEngine`: the durable per-agent harness choice, `anthropic_sdk`
  (Anthropic SDK, the Claude OAuth/subscription lane) or `deepagents`
  (DeepAgents, the API-key engine). Jobs and conversations inherit the bound
  agent's engine; there is no job- or conversation-level engine selector.
- `responseFamily`: the canonical API shape, `anthropic` or `openai`.
- `modelRoute`: diagnostic/source metadata such as Anthropic or OpenRouter,
  including metadata-only provider model IDs.
- `executionProviderId`: the adapter projection id resolved by the runtime per
  engine; read-only diagnostic.
- `credentialProfileRef`: the model-access credential profile, currently
  `gantry-model-access`.
- `capabilities`: observable support/readiness descriptors for streaming, tool
  use, MCP/browser/sandbox projection, session resume, thinking controls,
  token/cache accounting, and structured output.

The Anthropic-family aliases run on either engine where the provider route
declares both execution routes; OpenAI-endpoint chat models run on the
`deepagents:langchain` lane only. For the DeepAgents lane, catalog entries
declare identity and route only: context window, output limits, and capability
flags are reported at runtime from the LangChain model profile, and pricing is
intentionally not declared. Anthropic SDK plus an OpenAI-endpoint model, and
DeepAgents plus Claude OAuth/subscription credentials, are both rejected before
the run starts.

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

Catalog entries expose `responseFamily` as the canonical API shape, `anthropic`
or `openai`. OpenAI-endpoint chat models are executable through the
`deepagents:langchain` lane, not just schema. OpenRouter is route metadata on
Anthropic-family aliases, not a core response family or execution provider
selector.

Provider-side cache support means upstream model-provider prompt or response
caching that can reduce cost or latency. It does not mean Gantry caches
decrypted credentials, semantic model responses, or gateway upstream responses.
Gateway requests continue to resolve the active credential at request time.

Provider SDK response usage is normalized into input tokens, output tokens,
cache read tokens, cache write tokens, cache provider/status, and estimated
cost when known. Cache provider/status is derived from the provider registry
plus the selected catalog route, not from `responseFamily` alone. Job lifecycle
events include the resolved catalog entry ID, alias, model source, cache policy,
and token usage when the provider reports it.

Memory LLM clients also normalize usage into the same input/output/cache
read/cache write fields through `MemoryLlmQueryOpts.onUsage`;
extraction/dreaming logs consume that callback.

Provider cache behavior is intentionally provider-defined:

- Anthropic prompt caching is explicit request shaping through Agent SDK
  prompt-shaping options and, for lower-level content blocks such as memory LLM
  user blocks, Anthropic `cache_control` blocks. The Anthropic adapter lane owns
  those controls and the normalized usage fields are
  `cache_creation_input_tokens` and `cache_read_input_tokens`.
  Anthropic memory LLM queries keep extraction instructions in a cacheable SDK
  system-prompt prefix and mark only static user prompt blocks with
  `cache_control`; dynamic conversation evidence remains uncached user content.
- OpenRouter prompt caching for Anthropic-compatible routes also uses
  Anthropic-style `cache_control` blocks. Normalized prompt-cache usage comes
  from `prompt_tokens_details.cached_tokens` and
  `prompt_tokens_details.cache_write_tokens` when OpenRouter reports them.
- OpenAI prompt caching is automatic prefix caching. Gantry treats it as
  accounting-only until an adapter exposes explicit OpenAI cache controls.
- OpenRouter response caching can replay an identical full response and is
  disabled by default in this cut. Gantry exposes support metadata only; a
  later explicit setting is required before sending `X-OpenRouter-Cache`.

OpenRouter remains an Anthropic-compatible catalog route, not a core runtime
provider branch. For cataloged OpenRouter models, the child process receives
`ANTHROPIC_MODEL`, a Gantry Model Gateway loopback `ANTHROPIC_BASE_URL`, and
`gtw_*` run-scoped gateway tokens from `AgentCredentialBroker`; it never
receives the upstream OpenRouter API key or direct OpenRouter base URL.
OpenRouter response caching stays disabled; only provider prompt-cache token
fields are normalized.

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
