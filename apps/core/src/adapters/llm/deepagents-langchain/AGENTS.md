# DeepAgents (LangChain) Execution Adapter

`deepagents:langchain` execution adapter + adapter-owned runner. It is the
DeepAgents harness implementation for Gantry. `agentHarness: auto`
reaches this adapter when the resolved model route derives the DeepAgents lane:
OpenAI, OpenRouter, Bedrock, Vertex, and other OpenAI-compatible providers.
Public durable `agentHarness` / `agent_harness` values are `auto`,
`anthropic_sdk`, and `deepagents`; `executionProviderId` stays internal/read-only
diagnostic detail. Claude OAuth/subscription is
Anthropic-SDK-only. This is an **approved provider-boundary path**
(`.codex/architecture-map.json` + `architecture_rules.py`): DeepAgents /
LangChain / `@langchain/openrouter` imports and `OPENAI_`/`ANTHROPIC_` env keys
live only here.

## Model construction (library-driven, provider-driven)

Model construction is **library-driven**, not env-sniffing. The host
(`execution-adapter.ts`) projects the resolved model's provider string
(`GANTRY_DEEPAGENTS_MODEL_PROVIDER`) beside the model id
(`GANTRY_DEEPAGENTS_MODEL_ID`) and one loopback gateway base-URL + run-scoped
`gtw_` token (carried in the gateway-projected `OPENAI_BASE_URL`/`OPENAI_API_KEY`
modelCredentialEnv). `runner/model-factory.ts` selects the LangChain class from the
provider string:

- OpenAI-compatible providers (`openai` + `groq`/`deepseek`/`xai`/`together`/
  `fireworks`/`cerebras`/`perplexity`/`gemini`/`bedrock`/`vertex`):
  `await initChatModel("openai:<id>", { apiKey, configuration: { baseURL }, streamUsage: true })`.
  The class prefix is **always** `openai:` (ChatOpenAI) — these hit OUR loopback
  gateway, not api.openai.com; the gateway routes to the real upstream by
  `pathSegment`. `baseURL` is the RAW loopback gateway base
  (`http://127.0.0.1:<port>/<seg>`, no `/v1`); the OpenAI SDK posts
  `<baseURL>/chat/completions`, and the gateway prepends each provider's real
  `upstreamPathPrefix`: groq `/openai/v1`, fireworks `/inference/v1`,
  perplexity no extra prefix, gemini `/v1beta/openai`, and
  deepseek/xai/together/cerebras `/v1`. Bedrock resolves to the regional
  Bedrock Runtime `/v1` endpoint and, for this OpenAI-compatible route,
  accepts only the Amazon Bedrock API-key credential mode; AWS credentials,
  SigV4, and default-chain identity require a separate non-OpenAI Bedrock API
  family lane. Vertex resolves its upstream prefix from encrypted Model Access
  location/project fields at gateway request time, currently accepts only
  `global`, and uses the OpenAI-compatible `v1` endpoint prefix under
  `https://aiplatform.googleapis.com`; regional/multi-region Vertex routing is
  deferred until explicitly implemented and verified. The gateway allowlist permits
  `/chat/completions` and
  `/v1/chat/completions` for the DeepAgents lane; upstream confinement is
  enforced by `upstreamPathPrefix`. Adding a provider requires the factory
  allowlist, provider registry, catalog entry, gateway auth/upstream behavior
  when credentials are not a plain bearer key, and official-doc-backed tests for
  the provider/model/API family pairing. Cache-read field varies by provider:
  the stream-normalizer reads `prompt_tokens_details.cached_tokens`,
  `prompt_cache_hit_tokens` (DeepSeek), and flat `cached_tokens` (Together).
  Memory workloads are NOT enabled for these in v1 (kept to gpt/kimi).
- `openrouter`: `new ChatOpenRouter({ model: <id>, apiKey, baseURL: <gateway>/v1, streamUsage: true, sessionId? })`
  from `@langchain/openrouter` (`initChatModel` does not know `openrouter`).
  `ChatOpenRouter.buildUrl()` appends `/chat/completions` to `baseURL`, so the
  factory passes `<gateway>/v1` -> loopback `/openrouter/v1/chat/completions` ->
  `openrouter.ai/api/v1/chat/completions` (bearer auth).
  Optional catalog `providerRouting.openrouter` metadata is host-projected as
  `GANTRY_DEEPAGENTS_OPENROUTER_PROVIDER_ROUTING` and passed to
  `ChatOpenRouter`'s request-body `provider` object. Keep those preferences
  OpenRouter-route-only; do not model them as Gantry regions, locations, raw
  user-facing aliases, or durable authority.
- `anthropic` is NOT accepted by this adapter today; the factory throws. Do not
  route Claude OAuth/subscription here. Any future Anthropic API-key DeepAgents
  route must be explicit, official-doc-backed, gateway-brokered, and tested.

The built `BaseChatModel` instance is passed to `createDeepAgent({ model })`.
Loopback-URL + `gtw_`-token guards are enforced in the factory; the runtime
`model.profile` (context window etc.) is read from the resolved instance.

## OpenRouter prompt caching

OpenRouter is the OpenAI-chat-completions-compatible lane, so prompt caching is
correct-by-construction:

- **Cache accounting** (`runner/stream-normalizer.ts`): reads
  `prompt_tokens_details.cached_tokens` / `cache_write_tokens` off the final usage
  chunk (with a LangChain `usage_metadata.input_token_details.cache_read` fallback)
  and computes `cacheReadTokens` / `cacheWriteTokens` / `totalBillableInputTokens` /
  `cacheProvider` / `cacheStatus` + the `contextUsage` cache fields. This also fixes
  the OpenAI gpt lane (both replace the previous hardcoded zeros).
- **Sticky routing** (`runner/model-factory.ts`): `ChatOpenRouter` receives a stable
  `session_id` (the durable session id) on the request body so OpenRouter routes
  follow-up turns to the same upstream provider and cache hits persist across turns.
  The OpenAI lane has no `session_id` concept and is unaffected.
- **Gated `cache_control` breakpoints** (`runner/cache-control.ts`): the host
  projects `GANTRY_DEEPAGENTS_CACHE_PROMPT_CONTROL` (`automatic` | `explicit` |
  `none`) from the model's cache descriptor. On `explicit` the runner injects
  ephemeral `cache_control: { type: 'ephemeral' }` on the stable prefix (system
  prompt + memory block content parts, <= 4 breakpoints). **Automatic-prefix
  providers (Kimi/Moonshot via OpenRouter, OpenAI gpt) inject nothing** — explicit
  breakpoints are only for Anthropic/Gemini/Qwen sub-models (none shipped today).
- **Library limitation:** `@langchain/openrouter` 0.3.0 surfaces cache _reads_ but
  not _writes_ on streamed chunks; the normalizer captures writes from raw usage if
  a later version exposes them.

## Layout

- `execution-adapter.ts` — `AgentExecutionAdapter`. Resolves the dist runner
  (`<runnerDistDir>/../adapters/llm/deepagents-langchain/runner/index.js`),
  validates the credential projection, projects gateway model env (including
  `GANTRY_DEEPAGENTS_MODEL_PROVIDER`, `GANTRY_DEEPAGENTS_MODEL_ID`, and
  `GANTRY_DEEPAGENTS_CACHE_PROMPT_CONTROL`), points the runner at an adapter-owned
  sessions dir.
- `credential-validation.ts` — credential-mode guard / defensive backstop. The
  engine is derived from the provider, so an OAuth pairing can't be configured;
  this still enforces `supportedCredentialModes: ['api_key']` here as a fail-closed
  boundary: Claude OAuth is rejected with the locked copy; missing Model Access uses
  the setup-required copy.
- `model-credential-env.ts` — allowlist (`OPENAI_*`, `ANTHROPIC_*`,
  `NODE_EXTRA_CA_CERTS`) projected to `runnerInputPatch.modelCredentialEnv` only.
- `runner/` — the child process. `model-factory.ts` builds the LangChain instance
  from the projected provider string (`initChatModel("openai:<id>", ...)` /
  `ChatOpenRouter`) — see "Model construction" above. `cache-control.ts` applies the
  gated `cache_control` breakpoints. `stream-normalizer.ts` is a pure
  function over `streamEvents(..., {version:'v2'})` → neutral runner frames
  (unit-tested without network). `session-store.ts` is the adapter-private
  LangGraph checkpoint projection for live resume. `deep-agent-runner.ts` wires
  `createDeepAgent`.
- Resumed live sessions must still inject the current host-provided
  `memoryContextBlock` on the first turn of each runner process. LangGraph
  checkpoints preserve old messages, not newly retrieved durable memory for the
  current turn.
- `runner/mcp-tools.ts` — connects Gantry-owned MCP authority via
  `@langchain/mcp-adapters` `MultiServerMCPClient`: it spawns the Gantry facade
  stdio server (`GANTRY_MCP_SERVER_PATH`) with the projected env block, filters
  the facade tools to the host-selected name set, and rejects any external
  third-party MCP config in `GANTRY_MCP_CONFIG_FILE` until Gantry owns a
  DNS-pinned dispatcher/proxy path. DeepAgents has no autonomous MCP; this is
  the only place tools enter the graph.
- `runner/gantry-mcp-env.ts` — builds the Gantry facade server env block from the
  runner's process env + `agentInput.allowedTools`, reusing the shared
  `gantry-mcp-tool-surface` selection helpers. Strips `browser_*` tools unless the
  host provided `GANTRY_BROWSER_IPC_AUTH_TOKEN` AND the agent selected `Browser`.
- `runner/third-party-mcp-gate.ts` — contains the neutral runner tool gate for
  future/proxy-provided third-party MCP tools (`runner/tool-gate-core.ts`) + the
  neutral permission-IPC client (`runner/permission-ipc-client.ts`) before
  execution.
- `skill-projection.ts` — host-side selected-skill projection. It reads only
  Gantry-reviewed selected skill artifacts, validates DeepAgents-compatible
  `SKILL.md` metadata/paths before runner spawn, and serializes virtual
  `/skills/**` files for the child runner.
- `runner/builtin-tool-exclusion.ts` — a `langchain` `createMiddleware`
  `wrapModelCall` that strips raw DeepAgents built-ins from the model-visible
  tool list. `task`, `write_todos`, `write_file`, and `edit_file` stay hidden;
  `ls`/`read_file`/`glob`/`grep` are visible only when a validated selected-skill
  projection exists (see task/write_todos and skills decisions below).
- `runner/runtime-env.ts` — reads the common `GANTRY_*` host env and builds the
  `PermissionIpcRuntimeEnv` for the neutral permission-IPC client.

## Authority bridge (packet D)

Projected tool inventory for a run, all reachable only through Gantry policy:

- **Gantry facade tools** (`send_message`, `ask_user_question`, `memory_*`,
  `file`, `request_*`, `scheduler_*`, `mcp_list_tools`, `mcp_call_tool`, …): from
  the Gantry facade stdio MCP server, filtered to `selectedGantryMcpToolNames`.
- **Canonical Browser gateway tools** (`browser_status/open/inspect/act/close`):
  same server, mounted only when browser IPC is enabled.
- **Third-party MCP tools** (`mcp__<server>__<tool>`): not projected directly to
  DeepAgents today. Keep them behind Gantry-owned proxy/facade paths until a
  DNS-pinned dispatcher exists.

Third-party MCP permission flow (end to end): the wrapped tool's `func` runs the
neutral pre-checks (protected-capability + memory-boundary hard denials), then
`ToolExecutionPolicyService.evaluate` against the agent's selected rules. Allowed
→ the underlying tool runs. Otherwise → `requestPermissionApprovalViaIpc` writes
a signed `permission-requests/<id>.json` file; the HOST (`runtime/ipc.ts`) turns
it into a durable `pending_interactions` row BEFORE any prompt renders, then
returns a signed decision. Approved → the underlying tool runs; denied → the gate
returns a deny string to the model (imitating the anthropic-lane deny copy)
without invoking the tool. Locked-preset agents are hard-denied without prompting.

Raw DeepAgents authority stays disabled: default `StateBackend` (no `execute`),
deny-all filesystem `permissions` when no skills are projected, read-only
`/skills/**` filesystem permission when Gantry projected selected skills, and
never `LocalShellBackend`/`FilesystemBackend`.

Gantry-owned shell tool (Phase 4): the ONLY execution surface is a `RunCommand`-
named LangChain tool in `gantry-shell-tool.ts` (NOT `execute`/`ls`/`read_file`/etc
— those collide with deepagents' baked-in tool names). `mcp-tools.ts` injects it
into `tools` ONLY when `GANTRY_DEEPAGENTS_SHELL_ENABLED==='1'` (host flag) AND a
resolved `RunCommand(...)` rule is present (`shouldProjectGantryShellTool`). The
host sets that flag from `deepAgentsShellEnabledEnv` (= the pre-spawn guard's
allowed path: engine deepagents + RunCommand rule + enforcing `sandbox_runtime`);
the guard fails the spawn closed under `direct`/production-without-sandbox. The
tool shapes `{ command }` into a `Bash` policy request, runs the SAME neutral gate
as the third-party MCP tools (pre-checks → `evaluateNeutralToolPolicy` → durable
`requestPermissionApprovalViaIpc`), then on allow `spawn`s a child of the
already-sandboxed runner (inherits OS protected-path denies + the runner's
egress-proxy env). NEVER swap in a deepagents execution backend (it throws when
`permissions` is combined with an execution backend, and does not enforce
`permissions` on `execute`).

Gantry-owned web/file facade tools live in `runner/gantry-facade-tools.ts`.
They expose `WebSearch`, `WebRead`, `FileSearch`, `FileRead`, `FileEdit`, and
`FileWrite` as public Gantry names, map each call through the same neutral
policy/permission IPC path, and execute host web/file work without enabling raw
DeepAgents filesystem tools. `WebSearch`/`WebRead` are always mounted by this
runner, but `FileSearch`/`FileRead`/`FileEdit`/`FileWrite` may be mounted only
when the host projects `GANTRY_DEEPAGENTS_FILESYSTEM_ENABLED=1`, which is
derived from the same DeepAgents shell/filesystem sandbox guard and is true only
on the enforcing `sandbox_runtime` path. Under `direct`, File facades must stay
unmounted even for runtime approval prompts.

Skills decision: DeepAgents receives skills only from Gantry-reviewed selected
skill artifacts. The host passes `skills: ["/skills/"]` and graph input `files`
only after `skill-projection.ts` validates: selected id is enabled for the agent,
artifact storage exists, `SKILL.md` exists, paths cannot escape or use hidden
segments, the official frontmatter `name`/`description` are present and bounded,
and the `name` exactly matches the materialized lowercase hyphen directory.
Supporting files are projected as UTF-8 text only; unsupported binary assets
fail closed before spawn instead of corrupting JSON runner input. The runner
then exposes only read-only DeepAgents filesystem tools for virtual `/skills/**`
so DeepAgents' official progressive disclosure can show metadata first and read
full `SKILL.md` only after a match. Do not inject full skill bodies into system
prompt, memory context, or resume input as a shortcut.

`task` / `write_todos` decision: DeepAgents 1.10.2 bakes both middlewares into
`createDeepAgent` unconditionally — there is no config switch to omit them.
`createDeepAgent` itself uses a `wrapModelCall` middleware to exclude tools (its
private `_ToolExclusionMiddleware`); we use the identical supported pattern via
the public `middleware` param to strip `task` and `write_todos` from the
model-visible tool list today. Planned full-parity contract: `task` is
re-enabled only behind a Gantry delegation wrapper mapped to durable
`AgentDelegation` authority. The wrapper must evaluate Gantry policy before any
DeepAgents subagent task is invoked; a denied delegation request returns a denial
to the model and never calls raw `task`. Subagent definitions are host-resolved,
the model cannot persist durable subagent identities, and subagent tool scopes
replace rather than merge with parent tools. Raw DeepAgents tool names are
adapter-private and are not user-facing authority. Until that wrapper
implementation lands, keep stripping `task` and keep the raw spawner unreachable.

Async subagent decision: DeepAgents 1.10.2 also exposes JavaScript async
subagent middleware (`createAsyncSubAgentMiddleware` / `isAsyncSubAgent`) with
raw tools named `start_async_task`, `check_async_task`, `update_async_task`,
`cancel_async_task`, and `list_async_tasks`. That API is Agent Protocol based and
is not itself Gantry authority. Do not mount or pass those raw tools to the model
until the Gantry wrapper has created the durable task row, checked
`AgentDelegation`, verified sandbox/capability/model/harness authority, and
passed `runner/async-subagent-sentinel.ts` with a Gantry-owned Agent Protocol
transport/executor. Without that transport/executor, fail closed with
`Async delegation is unavailable for this DeepAgents version. Gantry did not
start delegated work.` and start no delegated provider work.

rg guard: this directory reads NO raw DeepAgents/MCP `.mcp.json` authority file —
`rg -n "\.mcp\.json" apps/core/src/adapters/llm/deepagents-langchain` must be
empty. Enforced by `deepagents-raw-authority-denial.test.ts`.

Memory context placement: the durable-memory block (host-tagged
`<gantry_memory_context trust="untrusted_data_only">`) is injected exactly once
as a leading user (`HumanMessage`) — model-visible prompt context, never system
authority. The system prompt carries the separate
`composeSystemPromptAppend` boundary-policy framing (not the tag). This matches
the anthropic lane and is asserted by `deepagents-memory-context.test.ts`.

Neutral extraction note: the runner-side tool gate decision core
(`runner/tool-gate-core.ts`) and the file-IPC permission-approval client
(`runner/permission-ipc-client.ts`) are provider-neutral and live under
`apps/core/src/runner/`. The anthropic lane keeps its own
`permission-callback.ts` (it owns run-scoped timed-grant batching the DeepAgents
v1 lane does not need) and delegates its protected-capability guard to
`tool-gate-core.ts`.

## Locked v1 constraints

- Model credentials reach the runner ONLY via the loopback gateway env
  (`runnerInputPatch.modelCredentialEnv`); never via `toolNetworkEnv`. Tokens are
  run-scoped `gtw_` gateway tokens, never raw provider secrets. Bedrock API keys,
  AWS access keys/session tokens, Vertex service-account JSON, and gateway-minted
  OAuth access tokens stay host-side inside the Gantry Model Gateway.
- Context-window figures are reported at runtime from `model.profile`
  (`maxInputTokens`); never hardcode them (catalog deepagents entries omit them).
- Frames must match the host parser (`runner/runner-frame.ts`, mirrors
  `AgentOutput` in `agent-spawn-types.ts`). Live turns emit, in order:
  1. a standalone **session-init** frame `{status:'success', result:null,
newSessionId, sessionInit:true}` so the host persists the provider session
     before any content (launchd-restart safety). `sessionInit:true` is a
     lane-neutral optional field: the host's `isAgentTurnCompleteMarker` excludes
     it, so this up-front frame is NOT mistaken for turn completion (which would
     idle + dequeue the next message at turn START). The session id still
     persists because the host reads `newSessionId` via
     `providerSessionExternalSessionId`.
  2. text-delta frames (the `stream-normalizer.ts` streams deltas ONLY; it no
     longer emits the terminal frame — it returns the terminal payload).
  3. exactly **one** terminal marker frame per user-visible turn (carrying
     `usage`/`contextUsage`), emitted by the runner index, NOT the normalizer.
     This mirrors the Anthropic query-loop's single per-`result` frame and
     guarantees the host completes/dequeues the turn exactly once. Scheduled jobs
     are ephemeral (no session persistence) and emit one terminal frame per turn
     the same way.
- Startup timing logs must keep `sessionInit` separate from first visible
  content: the first LangGraph event is diagnostic, and first visible reply
  timing begins only when the normalizer emits a non-empty text delta.
- Runner startup diagnostics must ride on the single terminal marker frame,
  never as a separate `{status:'success', result:null}` frame. The host treats
  non-`sessionInit` success/null frames as completion markers. Keep the
  `run.startup_diagnostic` payload count/timing-only: no prompts, raw schemas,
  tool args, paths, base URLs, or credentials. Tool readiness and tool activity
  diagnostics use elapsed milliseconds and counts, not raw tool inputs.
- Live-turn control parity (`runner/live-control.ts`): the shared runner
  `RuntimeSignalPump` watches the neutral IPC-input dir while a turn is in
  flight; fallback polling is missed-event recovery only. A `_close` sentinel (host
  `/stop` or close-stdin, both written by `continuation-input.ts`) aborts the
  in-flight LangGraph stream via an `AbortSignal` threaded into `streamEvents`.
  On a close-driven termination the runner returns WITHOUT emitting a completion
  marker (mirroring the Anthropic lane, which returns on `closedDuringQuery` with
  no final frame); the host settles the turn on process exit (`stopRequested` →
  error frame, or streamed-success on a plain close-stdin). Before the loop
  decides to break it runs one final synchronous `drainNow()` so a follow-up that
  lands between stream-end and the break decision is not orphaned, and a late
  `_close` in that same window folds into the no-marker close path. Mid-stream
  follow-ups are buffered and drive an additional turn; the terminal frame for
  the just-finished turn carries `continuedByFollowup` (the SINGLE marker for
  that turn — there is no separate continuation-only frame). The host delivery is
  engine-neutral, so no host code branches on engine.
- Session-store durability (`runner/session-store.ts`): live session continuity
  uses LangChain's official Postgres checkpointer (`PostgresSaver`) with
  `thread_id === sessionId`, not raw `{role,text}` message history, SQLite, a
  custom saver, or a bounded/reduced transcript. Follow-up turns pass only the
  new user input into `streamEvents` with the same `thread_id`; LangGraph
  checkpoint state supplies continuity. Do not add max-message or max-character
  trimming here because it silently lowers model quality. Missing, corrupt,
  unauthorized, or wrong-thread checkpoint state must fail before `sessionInit`,
  model gateway calls, MCP startup, tool execution, or permission prompts, and
  any opened saver must be closed before the error propagates. Startup
  diagnostics should report checkpoint load/write counts and milliseconds from
  the official saver methods only; do not log checkpoint values, thread ids,
  database URLs, schemas, prompts, or raw checkpoint blobs.
- Raw-authority denial (`runner/builtin-tool-exclusion.ts` +
  `runner/deep-agent-runner.ts`): by default the model-visible tool surface
  excludes the DeepAgents built-ins `task`, `write_todos`, and all filesystem
  tools (`ls`/`read_file`/`write_file`/`edit_file`/`glob`/`grep`). When the host
  projected reviewed selected skills, only the read-only filesystem tools
  (`ls`/`read_file`/`glob`/`grep`) are visible and filesystem permissions allow
  reads only under virtual `/skills/**`; `write_file`, `edit_file`, `task`, and
  `write_todos` remain hidden. The deny-all `/**` rule stays as the fallback
  backstop. `deepagents-raw-authority-denial.test.ts` asserts this against the
  ACTUAL `createDeepAgent` model surface (a fake model's `bindTools` captures the
  post-middleware tool list), with a negative control proving the baked-in tools
  appear without the exclusion middleware. When the `AgentDelegation` wrapper
  lands, raw DeepAgents names still stay hidden: delegation maps to
  Gantry-owned `AgentDelegation`, and non-skill web/filesystem access maps to
  `WebSearch`, `WebRead`, `FileSearch`, `FileRead`, `FileEdit`, and
  `FileWrite` with protected-path, symlink, sandbox, and audit enforcement.
- Scheduled-job heartbeat parity (`runner/job-heartbeat.ts`): scheduled runs
  emit a `JOB_HEARTBEAT` runtime-event frame every 15s (same shape as the
  Anthropic `job-heartbeat.ts`) so the host idle-stall detection
  (`agent-spawn-scheduled-idle.ts`) and lease activity tracking behave
  identically. Each streamed frame marks activity. Interactive runs emit none.
- Window-aware compaction (`runner/model-factory.ts` +
  `runner/gantry-chat-openrouter.ts` + host `execution-adapter.ts`): DeepAgents
  summarization reads `model.profile.maxInputTokens` and triggers at 85% of the
  window; with an EMPTY profile it falls back to a fixed 170k/6-message trigger
  (not the real window) and `stream-normalizer.ts` reports 0% context usage. For
  ids LangChain has no built-in profile for, the catalog declares a curated
  `contextWindowTokens` (source of truth); the host projects it as env
  `GANTRY_DEEPAGENTS_MAX_INPUT_TOKENS`, the runner threads it through
  `buildRunnerModel`, and the factory installs it as the model profile's
  `maxInputTokens`. openai lane: `initChatModel(spec, { profile: { maxInputTokens } })`
  (its `.profile` getter returns `_profile` first). openrouter lane:
  `GantryChatOpenRouter` overrides `get profile()` to prefer a `profileOverride`
  (base `ChatOpenRouter`'s getter is a hardcoded `PROFILES[model] ?? {}` with no
  override field). When NO window is projected (gpt-5.5/gpt-5.4 have a real
  library profile) the factory omits the override so the library profile is used
  unchanged — never clobber it. The same resolved model instance reaches both
  `createDeepAgent` and `readModelProfile` -> the normalizer, so the curated
  window drives compaction AND context-usage %.
