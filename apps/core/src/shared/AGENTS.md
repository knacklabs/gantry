## Shared Runtime Safety

- Shared timeout helpers must preserve cancellation semantics, not just return
  early with `Promise.race`. If a helper enforces a deadline for mutating
  runtime work, it must expose an `AbortSignal` and a disposable timer so the
  owning service can stop provider calls and finalize durable state.
- Bash parsing must treat common non-destructive file-descriptor duplication,
  such as `2>&1`, as redirect metadata instead of malformed shell syntax.
  Keep destructive output writes fail-closed, and require every pipeline leaf to
  match its own scoped rule.
- Semantic `capability:skill.*` permission rules require trusted host-projected
  selected-skill action definitions. Do not treat agent-authored tool input,
  request labels, or embedded semantic definitions as authority for skill
  actions.
- Generated `.llm-runtime/claude/skills/...` paths are runner projections, not
  durable command authority. Permission UX and persistent suggestions must
  canonicalize them to selected skill action capabilities or stable
  `skills/<skill>/...` reviewed command wrappers, and persistent validation must
  reject raw generated runtime paths.
- Semantic `local_cli` protected paths are credential-read boundaries: they
  should be readable by the reviewed executable and write-protected from the
  agent/runtime sandbox. Do not model them as deny-read secrets.
- `CapabilityRuntimeAccess` is the typed internal projection contract. Add new
  capability access types there instead of passing untyped host/path/tool
  authority across runtime boundaries.
- The model catalog is the only shared selectable-model source. User/API/job/MCP
  inputs must resolve friendly aliases through it; raw provider slugs are
  display/source metadata only unless explicitly registered as aliases.
- Catalog response families are simple API-shape labels, currently `anthropic`
  and schema-only `openai`. OpenRouter belongs in `modelRoute` metadata and
  provider defaults, not in `responseFamily` or raw user-facing model selectors.
- `model-families.ts` is a SEPARATE selector namespace, not part of the catalog
  `ALIAS_INDEX`. A family alias (e.g. `gpt-oss`, `llama-70b`) maps to ordered
  EXISTING concrete catalog member aliases; the load-time guard throws if a
  family alias collides with a catalog alias or a member is unknown. The pure
  resolver (`resolveModelFamilyAlias`) takes an injected `isProviderConfigured`
  predicate and never touches the repo/IO; it returns the first member whose
  provider is configured, falling back to the first member (loud-failure path)
  when none are. Credential-driven provider pick happens at the runtime spawn/job
  seams via `rewriteModelFamilyAliasForApp`, sourced from the model credential
  repo — do not push that lookup into the pure resolver.
- Provider-side cache support belongs in provider registry metadata and
  route-aware model helpers. Do not add local semantic response caches,
  decrypted credential caches, or response-family-derived cache assumptions.
- Curated context windows: deepagents-lane ids that LangChain has no built-in
  profile for declare an OPTIONAL `contextWindowTokens` in `model-catalog.ts` /
  `model-catalog-openai-compatible.ts` — the catalog is the source of truth for
  window-aware compaction + context-usage reporting on those models (host
  projects it to the runner profile's `maxInputTokens`). The library profile is
  preferred when present (gpt-5.5/gpt-5.4 OMIT the field). Per-token pricing may
  live in the catalog when verified from official provider docs; unknown pricing
  must stay omitted and render as unknown. `formatContextWindow`
  (`model-catalog-format.ts`) renders the `/models` + `gantry model list`
  Context column ("1.0M"/"131K"/"—").
  Keep provider PROPER NOUNS (Gemini/Llama/OpenAI/Anthropic) OUT of comments in
  these two catalog files: the provider-specific-path checker counts those bare
  words and both files sit at their exact `maxViolations` cap.
- Bedrock catalog entries for the current `bedrock` model route must use
  `bedrock-runtime` model IDs, not `bedrock-mantle` sample IDs. Some AWS model
  cards show both forms; the Gantry route resolves to the regional Runtime
  `/v1` Chat Completions endpoint.
- Shared parsers used by both config and adapters belong in `shared/`, with
  config modules re-exporting them when needed. Adapters must not import from
  `config/` just to reuse parsing behavior.
- Provider-native task/todo/delegation names (`Agent`, `Task*`, `TodoWrite`,
  DeepAgents task/todo/async task tools) are not durable authority. Shared tool
  rule matching must keep canonical `AgentDelegation` separate from raw
  provider projections unless a Gantry-owned wrapper explicitly performs the
  provider call after policy and lifecycle checks. Anthropic native `Task*`
  subagent aliases must be rejected; use native `Agent` only.
- Durable-memory tool-use guards are shared policy, not runner-only behavior.
  Keep `memory-boundary.ts` usable from jobs and runner adapters so async
  command execution and provider SDK tool callbacks deny the same high-risk
  memory-sourced requests.
