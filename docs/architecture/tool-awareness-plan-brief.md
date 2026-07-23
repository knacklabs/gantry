# Tool awareness — research brief for the Codex plan

Problem (user): after tools/MCP/skills are available, the agent doesn't
naturally reach for them — the user keeps re-telling it "use X". We want agents
to KNOW their tools easily, on BOTH runtimes: the Claude Agent SDK lane
(anthropic_sdk) AND the DeepAgents/LangChain lane (gpt/openai). Produce the
best plan.

## Anthropic research (2025-11, gathered from official docs — treat as facts)

Anthropic **Tool Search Tool** (advanced tool use):

- Solves two things as tool sets grow: context cost (50 tools ~10-20K tokens)
  and selection ACCURACY (degrades past 30-50 loaded tools). MCP-eval accuracy
  jumped materially with it on (Opus 4 49%->74%, Opus 4.5 79.5%->88.1%).
- Tool defs are withheld; the agent gets a SUMMARY of available tools and
  searches on demand; up to 5 most-relevant tools load per search and persist.
- Variants: `tool_search_tool_regex_20251119`, `tool_search_tool_bm25_20251119`.
- SDK control: `ENABLE_TOOL_SEARCH` env (unset/true/`auto`/`auto:N`/false).
  **Auto-DISABLED when ANTHROPIC_BASE_URL is a non-first-party host** (proxies
  usually don't forward `tool_reference` blocks). Gantry routes through its own
  gateway, so it force-enables via a `tool_reference` pass-through
  (runner/tool-search-decision.ts, reason
  `gantry_gateway_tool_reference_pass_through`, currently auto:10).
- **Search matches tool NAMES + DESCRIPTIONS.** `search_slack_messages` beats
  `query_slack`; keyword-rich descriptions match more queries.
- **Anthropic's explicit recommendation for discoverability: add a system-prompt
  section listing available tool CATEGORIES** so the agent knows what to search
  for (systemPrompt preset `append`).
- Limits: 10,000 tools, 5 results/search.

Anthropic **writing-tools-for-agents** best practices:

- Namespacing by service/resource (`asana_search`, `asana_projects_search`).
- Natural-language names, no cryptic ids (resolve UUIDs to semantic names).
- Descriptions: describe as to a new teammate; make implicit context explicit
  (formats, niche terms, resource relationships).
- Tool consolidation (`schedule_event` over list/create primitives).
- `input_examples` field for complex/nested/format-sensitive tools.
- Meaningful, high-signal response context.
- Evaluation-driven description refinement (small tweaks -> large gains).

## The runtime-agnostic insight

The Claude Tool Search is a Claude-lane optimization; DeepAgents has NO
equivalent. The durable answer is a RUNTIME-AGNOSTIC tool-awareness layer both
lanes share, with lane-specific optimizations on top. The shared seam is the
system-prompt assembly (`apps/core/src/application/agents/prompt-profile-service.ts`, the
`CAPABILITY_GUIDANCE` section, budget 1500; note memory: the live agent prompt
is OPERATING_GUIDANCE_BLOCK, CAPABILITY_GUIDANCE may be underused) — BOTH lanes
compile through it.

## What the plan must cover (investigate current state for each, both lanes)

1. **System-prompt capability catalog (BIGGEST LEVER, runtime-agnostic):** a
   budget-managed, cache-safe section listing the agent's connected MCP servers,
   installed skills, and SELECTED reviewed capabilities — each with a
   search-friendly name + one-line description + how to discover/acquire more
   (mcp_search_tools) — so the agent knows what it can do and what to search
   for, WITHOUT the user re-telling it. Must respect the static/dynamic
   prompt-cache boundary (#236): it changes with the access fingerprint (config)
   not per-turn, so it belongs in the semi-static region keyed on that
   fingerprint. Populate it for BOTH lanes.
2. **Description + naming quality across the capability/tool model:** MCP tools,
   reviewed capabilities, and skills carry keyword-rich descriptions and
   search-friendly names; surface MCP server `instructions`. Consider a
   lint/guidance so agent-authored/curated capabilities get good descriptions
   (search — FTS AND the planned semantic layer — is only as good as these).
3. **gantry `mcp_search_tools` parity across lanes:** it exists for inventory
   discovery; confirm/ensure the DeepAgents lane exposes it too, and that its
   results tell the agent what's callable-now vs acquire-first (honest, ties to
   receipts). Relationship to SDK tool search: SDK search ranks REGISTERED
   (projected) tools; gantry search covers INVENTORY (not-yet-projected, for
   acquisition) — the agent should understand both.
4. **Lane-specific:**
   - Claude SDK: native Tool Search is already force-enabled via the gateway
     pass-through. Align its tool SUMMARY/categories with the capability catalog;
     tune the auto:N threshold; add `input_examples` where supported.
   - DeepAgents (LangChain): NO native tool search. Rely on the system-prompt
     catalog + gantry mcp_search_tools; ensure tool descriptions reach the
     LangChain tool binding; consider a retrieval/selection step if the tool set
     is large. Inspect deepagents-langchain/execution-adapter.ts +
     skill-projection.ts + runner/.
5. **Post-acquisition awareness (closes the user's exact complaint):** right
   after an install/approval, the NEXT-turn catalog reflects the new capability
   with its description, so the agent reaches for it unprompted. Ties to honest
   now/next-turn receipts and the in-flight capability-authoring work.

## Deliverable

A plan doc: current-state per lane (cited seams), the layered design above with
a PRIORITIZED rollout (ponytail — biggest-lever-first; reuse the existing prompt
assembly and capability model, do not over-build), explicit runtime-agnostic vs
lane-specific split, cache-safety notes, and a test/eval strategy (behavioral:
agent selects the right tool without being told; description-quality eval).
Flag anything that should be its own PR vs folded into #237's acquisition work.
Do NOT implement — plan only.
