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

_(Codex fills this in.)_

## Stage D — Gateway wiring + integration tests

_(Codex fills this in.)_
