Seven findings, verified in current source. No files changed. Paths below are under `apps/core/src`; this was a static audit, without running agents.

1. **Inline agents cannot use the attachment reader their prompt requires — UX / parallel**

   **Today:** Both inline engines receive instructions to open attachments with `attachment_open`, but their first-party registry has no attachment tools. An inline agent therefore lacks Gantry’s prescribed route for reading an uploaded document.

   **Locations:** Instructions: [runner/gantry-agent-system-prompt.ts:234](../../../../apps/core/src/runner/gantry-agent-system-prompt.ts#L234). Inline inventory: [runtime/core-tools/registry.ts:81](../../../../apps/core/src/runtime/core-tools/registry.ts#L81). Its two projections: [Claude inline/index.ts:404](../../../../apps/core/src/adapters/llm/anthropic-claude-agent/inline-lane/index.ts#L404), [DeepAgents inline/index.ts:485](../../../../apps/core/src/adapters/llm/deepagents-langchain/inline-lane/index.ts#L485). Worker implementation: [runner/mcp/tools/attachment.ts:38](../../../../apps/core/src/runner/mcp/tools/attachment.ts#L38).

   **Survive / merge:** Keep the host’s conversation-scoped attachment operation. Share its tool definition and mount it through both inline projections; merge the independent first-party inventories.

   **Size:** Large story. **Risk:** Preserve attachment authorization, bounded extraction and image-result handling.

2. **The second memory-save definition advertises unusable scopes — duplicate / UX**

   **Today:** Inline models can choose `user`, `group` or `global`. A scope different from the trusted conversation scope fails. Worker models never receive that choice: the worker derives scope automatically.

   **Locations:** Inline schema: [runtime/core-tools/schemas.ts:126](../../../../apps/core/src/runtime/core-tools/schemas.ts#L126); passthrough: [registry.ts:295](../../../../apps/core/src/runtime/core-tools/registry.ts#L295). Worker schema: [runner/mcp/tools/memory.ts:107](../../../../apps/core/src/runner/mcp/tools/memory.ts#L107); trusted projection: [memory-payload.ts:13](../../../../apps/core/src/runner/mcp/tools/memory-payload.ts#L13). Host rejection: [memory/memory-ipc.ts:184](../../../../apps/core/src/memory/memory-ipc.ts#L184).

   **Survive / delete:** Keep automatic conversation scope and host validation. Remove inline’s scope selector and reuse the same payload construction.

   **Size:** Small. **Risk:** Do not relax the host boundary to accommodate the divergent schema.

3. **DeepAgents retains an unreachable direct-MCP implementation — dead**

   **Today:** Developers maintain connection, collision and wrapping code for servers that startup always rejects. `readExternalMcpServers` either returns an empty object or throws.

   **Locations:** [DeepAgents runner/mcp-tools.ts](../../../../apps/core/src/adapters/llm/deepagents-langchain/runner/mcp-tools.ts#L415): rejection at **415/438**; unreachable connection loop **130**, third-party wrapping **186/191**, collision helper **339**, transport conversion **459**. The wrapper and its private invocation/name helpers are in [third-party-mcp-gate.ts:123](../../../../apps/core/src/adapters/llm/deepagents-langchain/runner/third-party-mcp-gate.ts#L123), **131/200/208**. Their only production route is that unreachable branch.

   **Survive / delete:** Keep explicit rejection and the live Gantry facade connection. Delete direct-server conversion, collision filtering and unreachable wrappers, including tests devoted solely to them.

   **Size:** Small. **Risk:** Preserve shared denial helpers used by the live shell/file/web facades.

4. **Nine memory handlers copy an existing, unused response helper — duplicate / dead**

   **Today:** A change to memory error or success formatting must be repeated across nine handlers, despite an existing helper implementing that operation.

   **Locations:** [runner/mcp/tools/memory.ts](../../../../apps/core/src/runner/mcp/tools/memory.ts#L43): unused `memoryToolResult` at **43**; copies in handlers starting at **69, 107, 155, 189, 249, 284, 312, 340, 374**—search, save, patch, procedure save/patch, consolidate, dream and both review tools.

   **Survive / merge:** Keep the helper’s request/error/format sequence. Route those handlers through it and delete their repeated response blocks.

   **Size:** Small. **Risk:** Preserve each handler’s payload preparation, defaults and exact error wording.

5. **Tool failure classification has four copies that already disagree — duplicate**

   **Today:** Developers must update four recursive predicates when a result shape changes. Three recognize `is_error`; the DeepAgents MCP predicate omits it. These predicates control activity outcomes and successful-tool prerequisites. I did not establish a live invocation affected by that difference.

   **Locations:** [Claude runner/query-tool-success-ledger.ts:6](../../../../apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-tool-success-ledger.ts#L6); [DeepAgents runner/mcp-tools.ts:316](../../../../apps/core/src/adapters/llm/deepagents-langchain/runner/mcp-tools.ts#L316); [DeepAgents runner/stream-normalizer.ts:373](../../../../apps/core/src/adapters/llm/deepagents-langchain/runner/stream-normalizer.ts#L373); [llm/inline-lane-tool-activity.ts:239](../../../../apps/core/src/adapters/llm/inline-lane-tool-activity.ts#L239).

   **Survive / merge:** Keep one provider-neutral recursive predicate recognizing the supported error markers; remove all four local implementations.

   **Size:** Medium story when including shared extraction and verification. **Risk:** Misclassification changes both progress reporting and prerequisite enforcement.

6. **Skill-file reconciliation is implemented twice — duplicate**

   **Today:** Worker and inline DeepAgents separately inspect checkpoint files, copy current skills and write null entries for removed skills. A revocation-related change requires two edits.

   **Locations:** [DeepAgents skill-projection.ts:66](../../../../apps/core/src/adapters/llm/deepagents-langchain/skill-projection.ts#L66), used by [inline/index.ts:175](../../../../apps/core/src/adapters/llm/deepagents-langchain/inline-lane/index.ts#L175); second implementation and checkpoint parsing: [runner/deep-agent-runner.ts:494](../../../../apps/core/src/adapters/llm/deepagents-langchain/runner/deep-agent-runner.ts#L494), **513**.

   **Survive / merge:** Keep one pure reconciliation function. Leave checkpoint loading with each caller and delete the worker’s second reconciliation/parser implementation.

   **Size:** Small. **Risk:** Preserve removal entries so resumed sessions cannot retain withdrawn skill files.

7. **OpenRouter preferences are translated twice — duplicate**

   **Today:** Every routing option must be mapped independently for worker and inline execution. Both blocks translate the same camel-case catalog fields to OpenRouter’s snake-case fields.

   **Locations:** [DeepAgents execution-adapter.ts:35](../../../../apps/core/src/adapters/llm/deepagents-langchain/execution-adapter.ts#L35); [DeepAgents inline/index.ts:457](../../../../apps/core/src/adapters/llm/deepagents-langchain/inline-lane/index.ts#L457).

   **Survive / merge:** Keep one object mapper; the worker serializes its result, while inline passes it directly. Delete the second mapping block.

   **Size:** Small. **Risk:** Preserve explicit `false` values and array contents.

Already covered:

- **covered by PERMFLOW-1:** Independent engine permission gates, including [Claude’s callback:109](../../../../apps/core/src/adapters/llm/anthropic-claude-agent/runner/tool-permission-gate.ts#L109) and [inline’s coordinator:54](../../../../apps/core/src/runtime/core-tools/core-tool-permission-coordinator.ts#L54).
- **covered by PERMFLOW-3/4:** DeepAgents’ scheduled-denial termination/setup recovery, [deep-agent-runner.ts:134](../../../../apps/core/src/adapters/llm/deepagents-langchain/runner/deep-agent-runner.ts#L134).
- **covered by UX-1:** Separate acknowledgement, todo and rich-progress instructions, [gantry-agent-system-prompt.ts:194](../../../../apps/core/src/runner/gantry-agent-system-prompt.ts#L194).

Ranked value:

1. **#1:** Restore attachment access across lanes.
2. **#2:** Remove model-facing choices that fail.
3. **#3:** Largest clearly unreachable implementation.
4. **#4:** Nine repeated response blocks.
5. **#5:** Four drifting outcome classifiers.
6. **#6:** Duplicate skill reconciliation.
7. **#7:** Duplicate provider-option mapping.
