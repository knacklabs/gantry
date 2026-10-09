Eight findings, verified in the current code. No files changed. Locations below are relative to `apps/core/src`.

1. **API doctor reports success without checking — parallel / UX**

   During a database outage, `/v1/doctor` still returns “Postgres control store available.” Operators get conflicting answers from doctor and readiness.

   **Locations:** [control/server/routes/system.ts:158](../../../../apps/core/src/control/server/routes/system.ts#L158) hardcodes storage success; [control/server/system-health.ts:98](../../../../apps/core/src/control/server/system-health.ts#L98) actually queries storage; [cli/doctor.ts:644](../../../../apps/core/src/cli/doctor.ts#L644) runs another genuine storage check.

   **Survive:** measured checks, with readiness retaining its role-specific routing decisions. **Merge/delete:** replace the API doctor’s invented storage result with measured evidence and actionable failure details.

   **Size:** small. **Risk:** preserve the distinction between process liveness and readiness.

2. **Status discards doctor failures on its normal path — parallel / UX**

   When repository reads succeed, status formats the repository model directly. Blocking doctor failures, such as unsupported Node or invalid credential encryption, influence only the fallback model. The normal summary can therefore omit the runtime blocker it just detected.

   **Locations:** [cli/status.ts:519](../../../../apps/core/src/cli/status.ts#L519) selects these two paths; [application/control-plane/control-plane-storage-model.ts:330](../../../../apps/core/src/application/control-plane/control-plane-storage-model.ts#L330) builds without `runtimeBlocked`; [application/control-plane/control-plane-read-model.ts:288](../../../../apps/core/src/application/control-plane/control-plane-read-model.ts#L288) owns blocker precedence.

   **Survive:** the shared read model and doctor’s measured failures. **Merge/delete:** use one projection that receives both repository facts and operational failures; remove the divergent fallback-only blocker handling.

   **Size:** small. **Risk:** keep setup needs distinct from runtime failures.

3. **Tool execution has two independent diagnostic accounts — parallel / over-complicated**

   Operators receive actual terminal tool events, while tracing reconstructs execution from model responses and subsequent request history. Its latency measures that wider interval; missing follow-up evidence becomes `tool_result_missing`, regardless of the terminal event stream.

   **Locations:** [adapters/llm/observability/genai-spans.ts:185](../../../../apps/core/src/adapters/llm/observability/genai-spans.ts#L185), [:269](../../../../apps/core/src/adapters/llm/observability/genai-spans.ts#L269), and [:492](../../../../apps/core/src/adapters/llm/observability/genai-spans.ts#L492) reconstruct calls; [genai-tool-spans.ts:111](../../../../apps/core/src/adapters/llm/observability/genai-tool-spans.ts#L111), [:165](../../../../apps/core/src/adapters/llm/observability/genai-tool-spans.ts#L165), and [:257](../../../../apps/core/src/adapters/llm/observability/genai-tool-spans.ts#L257) maintain inferred lifecycles. Actual events come from [anthropic-claude-agent/runner/tool-permission-events.ts:130](../../../../apps/core/src/adapters/llm/anthropic-claude-agent/runner/tool-permission-events.ts#L130) and [deepagents-langchain/runner/stream-normalizer.ts:227](../../../../apps/core/src/adapters/llm/deepagents-langchain/runner/stream-normalizer.ts#L227).

   **Survive:** actual execution hooks, terminal events, and gateway model-call spans. **Merge/delete:** derive tool spans from those hooks; remove request-history reconstruction and duplicate pending state.

   **Size:** large story. **Risk:** preserve delegation parentage, cancellation, and coverage before removing reconstruction.

4. **Runner diagnostics require different switches — parallel / UX**

   Claude writes diagnostic lines unconditionally; DeepAgents suppresses its diagnostic logger unless `GANTRY_RUNNER_LOG=1`. Both reach a host reader that logs stderr at debug level. Enabling host debug therefore gives different diagnostic coverage by engine.

   **Locations:** [adapters/llm/anthropic-claude-agent/runner/logging.ts:3](../../../../apps/core/src/adapters/llm/anthropic-claude-agent/runner/logging.ts#L3), [deepagents-langchain/runner/index.ts:44](../../../../apps/core/src/adapters/llm/deepagents-langchain/runner/index.ts#L44), [runtime/agent-spawn-process.ts:319](../../../../apps/core/src/runtime/agent-spawn-process.ts#L319).

   **Survive:** one sanitized stderr writer and host log-level filtering. **Merge/delete:** merge runner writers and remove the extra engine-specific switch.

   **Size:** small. **Risk:** stdout must remain exclusively the runner protocol.

5. **Telemetry exports legacy and current representations together — parallel / legacy**

   Developers maintain two message encodings, two provider attributes, and duplicate cache-token spellings. Gateway messages get both schemas; turn messages still get only the legacy schema.

   **Locations:** [adapters/llm/observability/genai-message-attributes.ts:190](../../../../apps/core/src/adapters/llm/observability/genai-message-attributes.ts#L190), [:296](../../../../apps/core/src/adapters/llm/observability/genai-message-attributes.ts#L296), [:324](../../../../apps/core/src/adapters/llm/observability/genai-message-attributes.ts#L324), [:587](../../../../apps/core/src/adapters/llm/observability/genai-message-attributes.ts#L587), [:628](../../../../apps/core/src/adapters/llm/observability/genai-message-attributes.ts#L628); [genai-spans.ts:195](../../../../apps/core/src/adapters/llm/observability/genai-spans.ts#L195), [:247](../../../../apps/core/src/adapters/llm/observability/genai-spans.ts#L247), [:454](../../../../apps/core/src/adapters/llm/observability/genai-spans.ts#L454), [:469](../../../../apps/core/src/adapters/llm/observability/genai-spans.ts#L469); [infrastructure/observability/tracing.ts:40](../../../../apps/core/src/infrastructure/observability/tracing.ts#L40), [:390](../../../../apps/core/src/infrastructure/observability/tracing.ts#L390).

   **Survive:** one consistent message/provider/usage representation across turn and model spans. **Delete:** legacy conversion and duplicate attribute emission; merge raw/normalized usage writing.

   **Size:** medium story. **Risk:** repository comments document legacy backend mappings. Current external backend support is unverified; dashboard ingestion needs verification.

6. **Status repeats storage setup and approval counting — duplicate**

   One status command creates and closes three storage runtimes for consecutive reads. It also counts pending approvals separately and again inside the repository read model.

   **Locations:** [cli/status.ts:208](../../../../apps/core/src/cli/status.ts#L208), [:234](../../../../apps/core/src/cli/status.ts#L234), [:267](../../../../apps/core/src/cli/status.ts#L267); repeated count at [application/control-plane/control-plane-storage-model.ts:320](../../../../apps/core/src/application/control-plane/control-plane-storage-model.ts#L320).

   **Survive:** repository model collection and capacity queries. **Merge/delete:** share one storage lifetime; reuse the model’s approval count and remove repeated lifecycle blocks.

   **Size:** small. **Risk:** preserve partial diagnostics when an individual read fails.

7. **Tool-payload bounding is copied and has drifted — duplicate**

   Streamed and non-streamed arguments use nearly identical recursive traversal and geometric shrinking. One string limiter includes the truncation suffix within its cap; the other appends it beyond the cap.

   **Locations:** [adapters/llm/observability/sse-accumulator.ts:88](../../../../apps/core/src/adapters/llm/observability/sse-accumulator.ts#L88), [:93](../../../../apps/core/src/adapters/llm/observability/sse-accumulator.ts#L93), [:133](../../../../apps/core/src/adapters/llm/observability/sse-accumulator.ts#L133); [genai-message-attributes.ts:43](../../../../apps/core/src/adapters/llm/observability/genai-message-attributes.ts#L43), [:338](../../../../apps/core/src/adapters/llm/observability/genai-message-attributes.ts#L338).

   **Survive:** one bounded encoder with inclusive string limits. **Delete:** the second traversal/shrinking implementation.

   **Size:** small. **Risk:** retain depth, collection, and serialized-size limits.

8. **Provider-session redaction is duplicated exactly — duplicate**

   Adding a protected session field requires updating separate logging and shared-redaction implementations.

   **Locations:** [infrastructure/logging/logger.ts:83](../../../../apps/core/src/infrastructure/logging/logger.ts#L83), [:120](../../../../apps/core/src/infrastructure/logging/logger.ts#L120), [:198](../../../../apps/core/src/infrastructure/logging/logger.ts#L198); [shared/provider-session-redaction.ts:1](../../../../apps/core/src/shared/provider-session-redaction.ts#L1), [:17](../../../../apps/core/src/shared/provider-session-redaction.ts#L17), [:36](../../../../apps/core/src/shared/provider-session-redaction.ts#L36), [:41](../../../../apps/core/src/shared/provider-session-redaction.ts#L41).

   **Survive:** the existing shared helper, already used by durable job/session diagnostics. **Delete:** logger’s copied session patterns; delegate to that helper.

   **Size:** small. **Risk:** preserve structured-field redaction and replacement behavior.

covered by MSG-1..4: inbox-to-turn-to-outbox trace continuity; explicitly required by [one-messaging-pipeline.md:173](../../../../docs/specs/one-messaging-pipeline.md#L173).

The supplied UX and provider-native spec paths are absent in this checkout; their described exclusions were honored.

Ranked by value, prioritizing operator impact, then deletion opportunity:

1. API doctor’s unchecked success.
2. Status losing operational blockers.
3. Parallel tool lifecycle diagnostics.
4. Engine-specific diagnostic switches.
5. Dual telemetry schemas.
6. Repeated status storage collection.
7. Copied payload bounding.
8. Copied session redaction.
