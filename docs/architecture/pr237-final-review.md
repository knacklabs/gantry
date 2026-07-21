# PR 237 final branch review (develop vs main)

Date: 2026-07-21. Reviewer: independent Codex xhigh, read-only, adversarial.
Basis: mcp-skill-acquisition-alignment-goal-prompt.md R4.

## P1 blockers

1. **`mcp_pattern` calls bypass the per-agent source scope.** Source materialization defines the binding patterns as a restriction at [mcp-server-materialization.ts:44](apps/core/src/application/mcp/mcp-server-materialization.ts:44). Exact authorities are intersected with that scope at [mcp-tool-proxy-capabilities.ts:95](apps/core/src/application/mcp/mcp-tool-proxy-capabilities.ts:95), but patterns are filtered only by server prefix at [mcp-tool-proxy-capabilities.ts:98](apps/core/src/application/mcp/mcp-tool-proxy-capabilities.ts:98), then accepted without another source-scope check at [mcp-tool-authorization.ts:26](apps/core/src/application/mcp/mcp-tool-authorization.ts:26).

   Failure: a source binding restricted to `read_*` plus a selected `search_*` capability can execute `search_delete`, even though it is outside the agent’s reviewed source scope.

2. **Pattern authority is absent from direct runner projection.** Pattern capabilities emit wildcard runtime rules at [agent-tool-runtime-rules.ts:222](apps/core/src/application/agents/agent-tool-runtime-rules.ts:222), but `resolveRunnerMcpProjection` calls the exact-name-only extractor at [agent-spawn-runtime-policy.ts:275](apps/core/src/runtime/agent-spawn-runtime-policy.ts:275) and derives projected servers only from those exact names at [agent-spawn-runtime-policy.ts:281](apps/core/src/runtime/agent-spawn-runtime-policy.ts:281). The receipt nevertheless promises next-message projection at [service-formatters.ts:28](apps/core/src/runner/mcp/tools/service-formatters.ts:28).

   Failure: a pattern-only capability works through `mcp_call_tool` but never produces the promised direct Anthropic SDK MCP tools on the next turn.

3. **Legacy exact `mcp_tool` remains a second action authority.** It remains a valid capability binding at [semantic-capabilities.ts:24](apps/core/src/shared/semantic-capabilities.ts:24), projects exact authority at [agent-tool-runtime-rules.ts:211](apps/core/src/application/agents/agent-tool-runtime-rules.ts:211), and is accepted before pattern checks at [mcp-tool-authorization.ts:25](apps/core/src/application/mcp/mcp-tool-authorization.ts:25). The integration fixture still constructs this authority at [ipc-mcp-stdio.test.ts:634](apps/core/test/unit/runner/ipc-mcp-stdio.test.ts:634).

   Failure: selecting an exact `mcp_tool` capability authorizes an MCP action with no `mcp_pattern` binding, contradicting the locked single-authority cutover.

4. **An authoritative settings revision cannot explicitly remove an active agent-installed binding.** Reconcile always unions active agent-created bindings at [desired-state-capability-reconcile.ts:84](apps/core/src/config/settings/desired-state-capability-reconcile.ts:84), preserving skills at [desired-state-capability-reconcile.ts:147](apps/core/src/config/settings/desired-state-capability-reconcile.ts:147) and MCP bindings at [desired-state-capability-reconcile.ts:172](apps/core/src/config/settings/desired-state-capability-reconcile.ts:172). The purported explicit-removal test pre-disables the database rows instead of removing active rows through a revision at [settings-desired-state-service.test.ts:3959](apps/core/test/unit/config/settings-desired-state-service.test.ts:3959).

   Failure: removing an active agent-request MCP source or skill from authoritative settings immediately unions it back into the replacement set.

5. **Provider-account identity is still dropped by MCP acquisition.** Service tasks include `providerAccountId` at [service.ts:694](apps/core/src/runner/mcp/tools/service.ts:694), but the MCP handler omits it when starting review at [ipc-admin-handlers.ts:267](apps/core/src/jobs/ipc-admin-handlers.ts:267); the review contract has no such field at [ipc-admin-handlers.ts:704](apps/core/src/jobs/ipc-admin-handlers.ts:704), and delivery supplies only `threadId` at [ipc-admin-handlers.ts:801](apps/core/src/jobs/ipc-admin-handlers.ts:801).

   Failure: a `request_mcp_server` originating from a non-default Slack account renders approval or outcome through the wrong connection, or fails with no route.

## P2 should-fix

1. **`mcp_search_tools` is not a reliable cross-inventory FTS.** With multiple sources, uncached inventories are deliberately not fetched at [mcp-tool-proxy.ts:153](apps/core/src/application/mcp/mcp-tool-proxy.ts:153) and are returned as deferred at [mcp-tool-proxy.ts:190](apps/core/src/application/mcp/mcp-tool-proxy.ts:190). Matching is also one contiguous substring in one field at [mcp-tool-inventory.ts:187](apps/core/src/application/mcp/mcp-tool-inventory.ts:187), rather than tokenized FTS across fields.

   Failure: the first search with two newly connected sources returns no matches; after warming, `github create issue` still misses “Create an issue in GitHub.”

2. **The byte budget overflows for multibyte skill content.** The formatter measures UTF-8 bytes at [service-formatters.ts:412](apps/core/src/runner/mcp/tools/service-formatters.ts:412), but truncates using a byte count as a JavaScript UTF-16 index at [service-formatters.ts:424](apps/core/src/runner/mcp/tools/service-formatters.ts:424). The test uses ASCII only at [locked-introspection.test.ts:589](apps/core/test/unit/runner/mcp/locked-introspection.test.ts:589).

   Failure: emoji or CJK skill bodies can exceed `SAME_SESSION_SKILL_CONTEXT_MAX_BYTES` by roughly 2–4×.

3. **Collision validation is stale by installation time and cannot distinguish identity.** The check receives only a name and treats the first installed same-key row as the replacement at [skill-service.ts:223](apps/core/src/application/skills/skill-service.ts:223). Permission review runs the check before potentially long approval at [ipc-skill-permission-review.ts:84](apps/core/src/jobs/ipc-skill-permission-review.ts:84), while the later locked install block at [ipc-skill-permission-review.ts:157](apps/core/src/jobs/ipc-skill-permission-review.ts:157) does not recheck.

   Failure: a distinct same-key skill selected while approval is pending is overwritten/coalesced rather than rejected honestly at install time.

4. **Stage R4’s required integration coverage is not present.** The matrix marks projection, reconcile, collision, and FTS rows as integration-green at [agent-e2e-test-matrix.md:91](docs/architecture/agent-e2e-test-matrix.md:91), but its cited tests live under `test/unit`; the only changed integration test merely adds an async wait at [skills-registry-flow.integration.test.ts:901](apps/core/test/integration/skills-registry-flow.integration.test.ts:901).

   Failure: persistence, real projection, provider-account routing, and request→approve→next-turn behavior can regress while the matrix remains green.

Unpinned behaviors: pattern projection, pattern/source-scope intersection, active-row removal through a revision, cold multi-server search, tokenized FTS, multibyte budget enforcement, collision recheck/identity, and MCP provider-account delivery. No P3 findings.

R1 deletion sweep found no dangling production references; remaining removed-surface names are historical descriptions in the three governing review documents. `git diff --check origin/main...HEAD` passed; test suites were not executed during this read-only review.

**Overall verdict: REWORK**

