# Assumptions Ledger: OTel LLM Observability

Companion to `docs/architecture/otel-llm-observability-goal-prompt.md`. Every
implementation stage records assumptions it made because information was
missing — one row per assumption, under its stage section. The orchestrator
fills `Validated` (`ok` / `fixed` / `escalate`) before the stage commit. A
stage with no assumptions writes "None."

Format:

| # | Assumption | Missing info that forced it | Choice taken | Impact if wrong | Validated |
| --- | --- | --- | --- | --- | --- |

## Stage 0 — Module scaffold (orchestrator-authored, pre-pipeline)

| # | Assumption | Missing info that forced it | Choice taken | Impact if wrong | Validated |
| --- | --- | --- | --- | --- | --- |
| 0.1 | Both Langfuse and LangSmith map legacy `gen_ai.prompt`/`gen_ai.completion`, not yet `gen_ai.input.messages` | Backend mapping tables are external docs, may drift | Emit legacy pair only, comment marks the future flip | Content invisible in backend UI until keys flipped | ok (verified against both vendors' docs 2026-07-14) |
| 0.2 | OpenAI-compatible upstreams (incl. OpenRouter) accept `stream_options.include_usage` | Not every openai-compatible provider documents it | Inject only when tracing enabled; malformed-response risk limited to traced runs | Upstream 400s on traced streaming calls — surfaces immediately in smoke | |
| 0.3 | Normalizing stripped-frame delimiters to `\n\n` is safe for SSE clients | Client parsers unobserved | Frame-aligned tap only in injected mode | A CRLF-strict client misparses — none known in-repo | |
| 0.4 | Chunk boundaries can split multibyte UTF-8 | Found by autoreview r1 (P2) | Splitter uses `StringDecoder`; fixed pre-commit | Corrupted span content + corrupted re-emitted frames in inject mode | fixed |
| 0.5 | Body rewrite is orthogonal to auth injection | Found by autoreview r1 (P2): Bedrock SigV4 signs the body | Stage D contract reordered: observe/rewrite BEFORE `injectProviderAuth` | Signed-body mismatch → upstream 403 on Bedrock streaming | fixed |
| 0.6 | A `stream:true` request always gets an SSE response | Found by autoreview r2 (P2): upstream errors return plain JSON | Tap accessor is `streamTapFor(contentType)` — engages only on `text/event-stream`, memoized | Frame tap corrupts JSON error bodies for strict clients | fixed |

## Stage A — Unit tests for the observability module

_(Backfilled by the orchestrator — stage launched before the ledger rule; rows derived from Codex's reported test-proven fixes.)_

| # | Assumption | Missing info that forced it | Choice taken | Impact if wrong | Validated |
| --- | --- | --- | --- | --- | --- |
| A.1 | A caller that explicitly sets `include_usage: false` opted out deliberately | Contract said inject "when absent" — silent on explicit false | No injection when the key exists with any value (`Object.hasOwn` guard) | Those streams' spans lack token counts — caller-owned tradeoff | ok |
| A.2 | A terminal SSE frame may arrive without its trailing blank line | SSE producers differ on final-frame termination | Pass-through tap `flush()` feeds a synthetic `\n\n` so the accumulator parses the last frame | Final-frame usage (Anthropic `message_delta`) silently dropped | ok |

## Stage B — Settings schema + env secret

| # | Assumption | Missing info that forced it | Choice taken | Impact if wrong | Validated |
| --- | --- | --- | --- | --- | --- |
| B.1 | Approved global decimal scalar typing makes lexical integral decimals such as `1.0` become numeric `1`, so existing integer validators accept them | No field-by-field lexeme compatibility contract | Preserve existing validators under the approved scalar parser change | Previously rejected `1.0` spellings become accepted | fixed — global change reverted |
| B.2 | Unquoted two-part decimal-looking strings now type as numbers; strict string ids reject them and numeric agent source/capability versions such as `1.0` normalize to `"1"`, while quoting preserves string spelling | No per-field escape/compat rule | Preserve global YAML scalar semantics and require quoting for string intent | Existing unquoted decimal-looking ids or versions may reject or normalize | fixed — impact confirmed real (Slack `thread_id: 171.222` export test broke). Orchestrator reverted the global yaml.ts change (parse AND quote); `sample_rate` now coerces numeric strings locally in its strict parser instead |

## Stage C — Bootstrap wiring + turn span in spawnAgent

| # | Assumption | Missing info that forced it | Choice taken | Impact if wrong | Validated |
| --- | --- | --- | --- | --- | --- |
| C.1 | A user/host stop is detectable only from the error text | `AgentOutput.status` is `'success' \| 'error'` — no stopped variant | Turn outcome `'stopped'` inferred via `/\bstopped by request\b/i` on `output.error` (same marker `failover-eligibility.ts` keys on) | A stop renders as `error` in traces — cosmetic only | ok — marker produced by `agent-spawn-process.ts:561` and documented as semantic in `failover-eligibility.ts` |
| C.2 | Final `AgentOutput.result` carries the turn's visible text | Autoreview r1 (P1): streamed runs deliver text via `onOutput` frames and return `result: null` | `spawnAgent` wraps `onOutput` to accumulate visible frames; span output = accumulated frames, falling back to final result | Turn spans lose their output preview on every production run | fixed |
| C.3 | Inline-runtime turns (`agentRuntime === 'inline'`) get no turn span | `runInlineAgent` returns before the spawn path's credential/span seam | Per contract: paths bypassing the seam fall back to root LLM spans with `gantry.component` | Inline turns appear as ungrouped `chat` spans, not turn traces — acceptable v1, revisit if inline becomes a primary lane | ok |
| C.4 | Setup failures (credential projection throw, adapter prepare error) must still end the turn span | Autoreview r3 (P2): span opened before setup, try/finally started after | `spawnAgent`'s try widened to cover setup; outer finally owns span end AND credential revocation (inner redundant revoke removed) | Leaked registry entries + never-exported traces on repeated setup failures | fixed |
| C.5 | Span rotation may happen after the host output callback | Autoreview r3 (P2): runner starts the buffered follow-up immediately; callback does slow persistence work first | Tracker rotates the span BEFORE awaiting `onOutput` delivery | Follow-up turn's first LLM calls parent under the previous turn's span | fixed |
| C.6 | Session-expiry retries / model-family failover re-invoke `spawnAgent` per attempt | Autoreview r3 (P2): one user turn can produce N attempt traces | Accepted v1 semantic: one trace PER ATTEMPT (each with its own outcome), grouped by shared `session.id` (+ same `gantry.run_id` for jobs). Fixing it needs the span to wrap group-agent-runner's retry loop, which the stage contract explicitly forbade touching | Failed+successful attempt traces appear side by side for one turn; cost still aggregates via session/run ids | ok — documented decision, revisit with the retry-loop refactor |
| C.7 | Cleanup revocation is fail-open | Autoreview r4 (P2): a rejecting `revoke()` in `finally` replaces the pending return value | `finally` revocation wrapped in catch+warn | Materialization errors masked by revocation errors | fixed |
| C.8 | Buffered-follow-up turn spans are best-effort in v1 | Autoreview r4 (P2 ×2): rotation runs behind the host output chain (narrow misparent race) and the follow-up prompt lives runner-side (rotated span has no input) | Rotated spans carry `gantry.continuation: true`; race + missing input accepted for the buffered-follow-up edge case | Occasional misparented first LLM call and input-less continuation traces | ok — revisit path: synchronous frame hook in `agent-spawn-process.ts` + follow-up prompt plumbing |

## Stage E — Closeout (branch-wide review + verification)

| # | Assumption | Missing info that forced it | Choice taken | Impact if wrong | Validated |
| --- | --- | --- | --- | --- | --- |
| E.1 | Renderer number formatting and parser coercion agree | Branch autoreview (P2): `sampleRate: 1e-7` renders in scientific notation; the fixed-decimal regex rejected it → revision round-trip/startup failure | Coercion accepts any finite `Number()`-parseable string; round-trip test with `1e-7` added | Accepted settings revisions could brick startup | fixed |
| E.2 | `agent-runner-ipc` failures were main's, not ours | 44 spawned-runner tests red — `bfe906c59` (PR #215, main) added a `runtime-env-command` import without extending the fixture copy list | Drive-by one-line copy-list fix committed on this branch | — | fixed (verified import landed on main pre-branch) |

## Stage D — Gateway wiring + integration tests

| # | Assumption | Missing info that forced it | Choice taken | Impact if wrong | Validated |
| --- | --- | --- | --- | --- | --- |
| D.1 | Tracing bootstrap may live in the runtime layer | `infrastructure/` is adapters-layer per the architecture map; runtime→adapters crossings are capped baseline debt | Init moved from `apps/core/src/app/index.ts` into `runStartup` (settings-adjacent) + the startup bootstrap's `forbidden_import_by_layer` cap bumped 5→6 with a dated reason naming the revisit (domain port) | One more reasoned debt entry in the exceptions ledger | ok — orchestrator decision, visible in `.codex/architecture-exceptions.json` |
| D.2 | A thrown upstream `fetch`/auth-injection still produces a span | Codex's in-stage autoreview flagged it but rejected the fix as out of scope — overruled by the orchestrator: error traces on timeouts are core to the debugging goal | Gateway wraps auth injection and fetch; failures finish the span as 502 with the error message (`gantry-model-gateway-observability.ts`) | Upstream timeouts/network failures would export no trace at all | fixed |
| D.3 | Provider-capability gating for `include_usage` injection and skipping response cloning on errors are unnecessary | Codex autoreview raised both; injection is already scoped to openai-format paths (ledger 0.2 covers the residual risk) and the clone is once per non-streaming call | Both rejections upheld | Injection 400s on an exotic openai-compatible upstream would surface in smoke | ok |
| D.11 | `stream_options` is not a universal openai-compatible field | Autoreview r7 (P2): Cerebras' contract lacks it — injection could 4xx a valid call | Injection inverted to an allowlist (`openai` only); all other providers stay byte-identical and get usage when the CALLER opts in (LangChain's ChatOpenAI does by default, covering the runner lanes) | Hand-rolled clients on exotic providers lack streamed token counts unless they opt in | fixed |
| D.12 | Path exclusion by substring is unsafe with dynamic segments | Autoreview r7 (P2): a Vertex project named `embeddings-prod` would disable tracing for its generations | Non-generation exclusion switched to suffix matching | Silent tracing gaps on innocent resource names | fixed |
| D.13 | HTTP 200 SSE streams can carry terminal `error` chunks | Autoreview r7 (P2): OpenRouter documents mid-stream failures behind 200 | Accumulator captures top-level `error` (openai) / `error` events (anthropic); span status becomes ERROR with the provider message | Failed generations exported as successes | fixed |
| D.14 | OpenAI Responses API traces are generic in v1 | Autoreview r7 (P2): `/v1/responses` is gateway-allowed but its stream shape is unparsed | Accepted v1 gap: Responses calls get a generic span (timing/status/request model); dedicated parsing when that route sees real use | Responses-API spans lack usage/content detail | ok — documented, revisit on demand |
| D.8 | OpenRouter streams its usage frame natively | Autoreview r6 (P2), confirmed against OpenRouter's API reference | No injection for `openrouter` (`NATIVE_STREAM_USAGE_PROVIDERS`) — pass-through tap accumulates the native frame; callers keep receiving it | Stripping would delete response data the OpenRouter runner lane parses | fixed |
| D.9 | Successful-but-odd upstream JSON (e.g. `null`) must still proxy | Autoreview r6 (P2): my r5 refactor moved payload deref + normalization outside the catch | Payload validated as a non-null object; `usageFromGatewayPayload` wrapped fail-open | A 200 with unusual JSON became a gateway 502 | fixed |
| D.10 | Only generation endpoints are traced in v1 | Autoreview r6 (P2): `/embeddings` + `/count_tokens` were emitted as `chat` spans | `observeGatewayCall` skips `NON_GENERATION_PATHS` (embeddings, count_tokens, moderations, rerank); unknown generation-ish paths (e.g. Bedrock invoke) keep generic spans | Non-generation calls inflate chat counts with junk usage; embeddings spans are a later dedicated op type | fixed |
| D.7 | Traced non-streaming calls must not parse the response twice | Autoreview r5 (P2): usage extraction and span finalization each cloned+parsed the body | Single shared clone+parse (`readGatewayResponsePayload`/`usageFromGatewayPayload` in `gantry-model-gateway-http.ts`); `extractGatewayResponseUsage` kept as a thin wrapper preserving its contract | Duplicate deserialization + transient double buffering on the hot path | fixed |
| D.6 | Error-response bodies must never be awaited before proxying | Autoreview r4 (P2): a 4xx/5xx upstream that stalls after headers would hang the gateway (timeout already cleared) solely because tracing is on | Non-OK non-streaming spans finish from status + statusText without reading the body (mirrors `extractGatewayResponseUsage`'s OK-only body read) | Tracing-enabled gateways hang on trickling error responses | fixed |
| D.5 | Sampling must suppress traffic mutation, not just export | Autoreview r3 (P2): a sampled-out span still triggered usage injection + the stream tap | `observeGatewayCall` bails (span ended, no observation) when the created span is not recording — sampled-out requests pass byte-identical; covered by a real-gateway `sampleRate: 0` test | Unsampled traffic mutated with zero observability gain | fixed |
| D.4 | Tracing must configure from AUTHORITATIVE settings only | Autoreview r2 (P1): split fleet roles enter `runStartup` with file authority; the revision loads later via `prepareFleetSettings` | `runStartup` returns an init closure; the runtime entry invokes it once after fleet prep + preflight, and skips init entirely when no revision is loaded (stale mirrors never configure exporters). Fleet workers that receive their first revision via the late settings listener get tracing at next restart (restart-owned, consistent with the settings-reload stance) | Fresh workers trace with stale endpoints/content-capture, or miss tracing the revision enables | fixed |
