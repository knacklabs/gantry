# Goal Prompt: OTel-First LLM Observability (Langfuse / LangSmith via OTLP)

## Objective

Give Gantry operators full LLM observability — traces, token detail (input/output/cache), and backend-computed cost — by instrumenting the runtime once with OpenTelemetry GenAI conventions and exporting OTLP to any backend (Langfuse, LangSmith, generic collector). No `langfuse`/`langsmith` SDKs in the runtime. Evals happen server-side in the backend over ingested traces.

Use ponytail. Fail-open everywhere: observability must never break or slow an LLM call. Tracing disabled (default) must be a pure no-op.

## Locked Decisions (do not re-litigate)

- OTel-first, OTLP export only; backend choice is operator config.
- Trace = one agent turn (`invoke_agent` root span); LLM calls are `chat` child spans; correlation via in-process `runId → Span` registry (host and gateway share a process).
- Attach point is the model gateway (`apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway.ts`) — every lane crosses it. No subprocess instrumentation.
- Content capture ON by default (configuring an endpoint = consent); `capture_content: false` keeps timing/tokens/metadata only. Truncation: 16k chars per message, 32k per attribute.
- Usage completeness is a hard requirement: every `chat` span carries input/output/cache token detail. For OpenAI-format streams the gateway injects `stream_options.include_usage` when absent and strips the synthetic usage-only frame downstream.
- Content keys: legacy `gen_ai.prompt` / `gen_ai.completion` (what Langfuse + LangSmith map natively today).
- Settings: global `observability.tracing` block (enabled/endpoint/capture_content/sample_rate/environment), restart-owned; auth headers via `GANTRY_OTEL_TRACES_HEADERS` env secret; standard `OTEL_EXPORTER_OTLP_TRACES_*` env as fallback. Private in v1 — NOT in the public settings projection or contracts.
- Full plan of record: `docs/architecture/otel-llm-observability-goal-prompt.md` is the stage contract; the approved plan lives at `~/.claude/plans/analyse-the-current-code-encapsulated-origami.md`.
- Assumptions ledger: every stage records assumptions forced by missing information in `docs/architecture/otel-llm-observability-assumptions.md` (structured table per stage; orchestrator validates each row before the stage commit).

## Already Landed (working tree, do not rebuild)

- Deps in root `package.json`: `@opentelemetry/api`, `@opentelemetry/sdk-trace-node`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/resources`.
- `apps/core/src/infrastructure/observability/tracing.ts` — provider lifecycle (`initTracing`/`shutdownTracing`), turn-span registry (`startTurnSpan`/`getTurnSpan`), `parseOtlpHeaders`, content bounding. Provider-neutral by design (architecture gate).
- `apps/core/src/adapters/llm/observability/genai-spans.ts` — `observeGatewayCall()` gateway entry point: span creation/parenting, gen_ai.* attribute mapping, include_usage injection, stream tap with frame stripping, cost via `normalizeModelUsage`.
- `apps/core/src/adapters/llm/observability/sse-accumulator.ts` — SSE frame splitter + Anthropic/OpenAI stream accumulators, `isOpenAiUsageOnlyFrame`.
- Typecheck clean, architecture gate clean (provider-specific files live under the approved `apps/core/src/adapters/llm` path).

## Stages

### Stage A — Unit tests for the observability module

New test files (create): `observability-tracing.test.ts` and `observability-genai-spans.test.ts` under `apps/core/test/unit/core/` (mirror neighbouring test style; import from source modules via `@core/...`).

Cover, using `InMemorySpanExporter` through the `initTracing(config, testExporter)` hook (call `shutdownTracing()` in afterEach):

- Registry parenting: `startTurnSpan` then `observeGatewayCall` with matching runId → same traceId, parentSpanId = turn span; unmatched runId → root span with `gantry.component` (`llm-api` for apiKeyId, `memory` for `memory-query:` prefix, `permission-classifier` for `permission-classifier:` prefix, else `unattributed`).
- Attribute mapping fixtures: Anthropic non-streaming response (usage incl. `cache_read_input_tokens`/`cache_creation_input_tokens`), OpenAI non-streaming (usage incl. `prompt_tokens_details.cached_tokens`); `gen_ai.request.model`, `gen_ai.response.model`, finish reasons, `gen_ai.prompt`/`gen_ai.completion` JSON shape.
- `captureContent: false` → no `gen_ai.prompt`/`gen_ai.completion`, tokens still present.
- Truncation: >16k char message content is bounded.
- SSE accumulator: Anthropic frame sequence (message_start → content_block_delta×N → message_delta) yields model/usage/completion/stop_reason; OpenAI with usage chunk; OpenAI without usage chunk (no token attrs); mid-stream garbage frame → parser dead, no throw, prior data kept; CRLF frames; `[DONE]` handling.
- Injection: OpenAI streaming request without `stream_options` → rewritten body has `include_usage: true`; tap strips the usage-only frame; caller-set `include_usage` → body unchanged (same Buffer), frame passes through.
- `parseOtlpHeaders`: `k=v,k2=v2`, whitespace, empty → undefined.
- Fail-open: disabled tracing → `observeGatewayCall` returns undefined; `startTurnSpan` returns no-op handle.

Bounded write scope: the two new test files only. Nothing else. If a test exposes a real module bug, fix it in the module file it lives in and note it.

### Stage B — Settings schema + env secret

- `apps/core/src/config/settings/runtime-settings-types.ts`: `RuntimeObservabilitySettings { tracing: { enabled: boolean; endpoint: string; captureContent: boolean; sampleRate: number; environment?: string } }`; add `observability` to `RuntimeSettings`.
- New parser file (create, basename `runtime-settings-observability-parser.ts`) in `apps/core/src/config/settings/`, strict-parse modeled on `apps/core/src/config/settings/runtime-settings-limits-parser.ts`: only `tracing` under `observability`, only the five leaf keys, loud error on unknown keys, validate sample_rate ∈ [0,1].
- Register the root key + parser in `apps/core/src/config/settings/runtime-settings-parser.ts` (allowed root-key list and its error message).
- Defaults in `apps/core/src/config/settings/runtime-settings-defaults.ts`: `{ tracing: { enabled: false, endpoint: '', captureContent: true, sampleRate: 1 } }`.
- Renderer: omit-when-default block in `apps/core/src/config/settings/runtime-settings-optional-blocks-renderer.ts` + call site in `apps/core/src/config/settings/runtime-settings-renderer.ts` (same pattern as the limits block).
- Revisions: serialize the block in `settingsToRevisionDocument()` in `apps/core/src/config/settings/settings-import-service.ts` and bump `CURRENT_SETTINGS_READER_VERSION` (older readers hard-fail on the new root key).
- Secret: add `GANTRY_OTEL_TRACES_HEADERS` via `runtimeSecret(...)` in `apps/core/src/config/source-classification.ts`.
- `.env.example`: commented `GANTRY_OTEL_TRACES_HEADERS=` with the two backend recipes (Langfuse `Authorization=Basic <base64 pk:sk>` + `/api/public/otel/v1/traces`; LangSmith `x-api-key=<key>,Langsmith-Project=<project>` + `https://api.smith.langchain.com/otel/v1/traces`).
- Tests: extend existing settings parser/renderer suites + `apps/core/test/unit/config/settings-import-service.test.ts` with accept/reject/defaults/render round-trip/revision round-trip cases.

Bounded write scope: the files above only. Nothing else.

### Stage C — Bootstrap wiring + turn span in spawnAgent

- `apps/core/src/app/index.ts` (`startGantryRuntime`): after settings load, build `TracingRuntimeConfig` from `observability.tracing` + `parseOtlpHeaders(process.env.GANTRY_OTEL_TRACES_HEADERS)` and call `initTracing(...)` in try/catch (warn, never fatal). Wire `shutdownTracing` as a `closeTracing` step in `apps/core/src/app/bootstrap/shutdown.ts` (optional step, runs before storage close; mirror existing step pattern).
- `apps/core/src/runtime/agent-spawn.ts`: mint the turn correlation id — `input.runId ?? 'credential-run:' + randomUUID()` — BEFORE the `credentials(...)` call; pass it as `runId` in the credentials options (agent-spawn-host already honors `options.runId` first); open `startTurnSpan({ runId: correlationId, appId, agentId, agentName: group.name, conversationId: input.chatJid, threadId, jobId, userId })` there; set turn input from the user message when available (capture-gated inside the handle); end the span with success/error/stopped + set output from the final result in a finally around the execution. Tracing disabled → all of this is a no-op through the existing no-op handle.
- Do NOT change `group-agent-runner.ts` or run-lease semantics. Do NOT thread the id anywhere else.
- Tests: focused unit coverage only if a seam already exists; otherwise rely on Stage A registry tests + Stage D integration test. Existing spawn/runner suites must stay green.

Bounded write scope: `apps/core/src/app/index.ts`, `apps/core/src/app/bootstrap/shutdown.ts`, `apps/core/src/runtime/agent-spawn.ts` (and its host helper ONLY if the credentials options type needs the field exposed: `apps/core/src/runtime/agent-spawn-host.ts`). Nothing else.

### Stage D — Gateway wiring + integration tests

- `apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway.ts` `handleRequest()`: after body read and **BEFORE `injectProviderAuth`**, call `observeGatewayCall({ token: tokenRecord, providerId, upstreamUrl, requestBody: body })` and use `observation?.requestBody ?? body` as THE body from that point on — `injectProviderAuth` must receive the final (possibly rewritten) body because Bedrock SigV4 signs the body (`gantry-model-gateway-routing.ts` `injectProviderAuth`); rewriting after signing would 403. `sanitizeProxyHeaders` never forwards content-length and fetch recomputes it. Non-streaming: `observation?.finish({ status, responseJson: await response.clone().json() (guarded), normalizedUsage: usage })`; streaming: obtain the tap via `observation.streamTapFor(response.headers.get('content-type'))` — it returns undefined for non-SSE bodies (a streaming request can still get a plain-JSON error response, which must pass through untouched) — pass it into `pipeUpstreamBody` and call `finish` when the pipe settles (success or error/abort → errorMessage). Skip observation entirely on the pre-fetch rejection paths (401/405/413/429/503).
- `apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway-http.ts` `pipeUpstreamBody(response, res, tap?)`: optional tap `{ transform(chunk): Buffer; flush(): Buffer }` wired as a Transform inside the existing `pipeline()`; tap calls guarded try/catch → on throw forward the raw chunk; without a tap behavior is byte-identical to today.
- Do NOT change `extractGatewayResponseUsage` (existing test asserts streaming usage is skipped there).
- New test file (create, basename `gantry-model-gateway-tracing.test.ts`) in `apps/core/test/unit/core/`, following the real-broker + stub-upstream harness of `apps/core/test/unit/core/gantry-model-gateway.test.ts`:
  - Non-streaming JSON call → one `chat` span, usage + cost attrs, correct parenting under a registered turn span.
  - Chunked SSE (Anthropic shape) → client receives byte-identical stream; span has streamed usage + completion.
  - Chunked SSE (OpenAI shape, caller without include_usage) → upstream request body contains the injected flag; client stream has NO usage-only frame; span has usage incl. cached tokens.
  - OpenAI SSE with caller-set include_usage → body forwarded unchanged; usage frame reaches the client.
  - Tracing disabled → no spans, gateway behavior byte-identical.
  - A throwing exporter/tap never affects proxied status/body.
- Existing `gantry-model-gateway.test.ts` suite stays green.

Bounded write scope: the two gateway files + the new test file. Nothing else.

## Surface Impact Matrix

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Additive | Tracing off by default; enabled → spans exported, OpenAI streaming bodies gain `include_usage`. |
| `settings.yaml` | Optional additive | New `observability.tracing` block, omit-when-default. |
| Postgres | Unchanged | No new tables; runtime events untouched. |
| Control API / contracts | Unchanged | Block deliberately excluded from public settings projection. |
| SDK (`packages/sdk`) | Unchanged | No surface change. |
| CLI | Unchanged | No new command in v1. |
| Env/secrets | Additive | `GANTRY_OTEL_TRACES_HEADERS` runtime secret + standard `OTEL_*` fallback. |
| Settings revisions | Changed | New block serialized; reader version bumped. |
| Docs/prompts | Additive | `.env.example` recipes; smoke steps in PR. |
| Tests | Additive | New unit + gateway integration suites. |

## Acceptance Criteria

- Turn span + gateway `chat` span share a trace for a normal message turn (registry hit via the minted correlation id passed into the credential binding).
- Every `chat` span on the parsed generation routes (openai-format `/chat/completions`, Anthropic `/messages`) carries input/output tokens; cache detail present when the provider reports it; `gen_ai.usage.cost` present when the catalog prices the model. Other gateway-allowed generation-ish routes (Bedrock invoke, OpenAI Responses) get best-effort generic spans in v1 (ledger D.14).
- OpenAI-format streaming without caller `include_usage`: span has full usage AND the client stream contains no usage-only frame.
- `capture_content: false` removes prompt/completion content but keeps tokens/timing.
- Tracing disabled: zero spans, zero behavior change (gateway byte-identical, spawnAgent no-op).
- Settings block round-trips through parser → renderer → revision document; unknown keys rejected loudly.
- Architecture check introduces no NEW violations vs the branch base (pre-existing: `permission-classifier.ts` size, `text-styles.ts` telegram).
- Full `npm run build` + unit suites green.

## Focused Verification (per stage)

```bash
npm run build
python3 .codex/scripts/check_architecture.py
npm run test:unit -- apps/core/test/unit/core/gantry-model-gateway.test.ts
```

Plus per-stage focused vitest files named in each stage.

## Runtime Smoke (closeout)

`npm run build`, restart the service, `gantry status`; with a local Langfuse (docker, external setup) configured via `observability.tracing` + `GANTRY_OTEL_TRACES_HEADERS`, run one real agent turn and verify in the Langfuse UI: one trace, `invoke_agent` root with input/output preview, `chat` children with prompt/completion/token/cost detail. Capture exact blockers if any step cannot run.

## PR Closeout

Branch `feature/otel-llm-observability`; PR carries implementation summary, verification evidence, smoke results/blockers, autoreview clean result, remaining risks (BatchSpanProcessor drop-on-outage, restart-owned settings, injection scope).
