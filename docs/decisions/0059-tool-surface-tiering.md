---
status: proposed
confirmed_by: ""
date: 2026-07-26
---

# Tool Surface Tiering

**Status is `proposed` on purpose.** This is an architecture change and should be grilled
before any code is written. Numbered 0059 rather than 0058 because PERM-5 holds 0058 on an
unmerged branch — see [[decision-number-collision-parallel-branches]].

## Context

The gantry MCP server registers 65 tools. Every one that an agent is granted occupies prompt
space on every turn, of every agent, of every job — and competes for the model's attention
when it selects a tool.

### What was measured

Extracted each tool's description and input schema from `apps/core/src/runner/mcp/tools/*.ts`
and counted characters, converting at ~3.6 chars/token:

| | tools | ~tokens | share |
|---|---|---|---|
| Resident core (proposed) | 18 | 2,242 | 26% |
| Long tail | 47 | 6,703 | **74%** |
| Total | 65 | 8,946 | |

**This is a floor, not the real number.** It measures the zod/TypeScript source; MCP transmits
expanded JSON Schema, which is typically 1.5–2x larger. The realistic in-prompt cost is
therefore roughly **13,000–18,000 tokens**. Confirming it exactly requires dumping the emitted
tool manifest for one agent at runtime — worth doing before implementing, but it does not
change the shape of the finding.

The decisive fact is the distribution, which is robust to that uncertainty: **74% of the
schema weight sits in tools that are rarely used in any given turn.** The eight heaviest are
almost all long-tail:

```
scheduler_upsert_job              ~507 tok
request_skill_install             ~473 tok
scheduler_update_job              ~414 tok
request_mcp_server                ~412 tok
request_access                    ~407 tok
request_skill_dependency_install  ~403 tok
register_agent                    ~333 tok
request_agent_profile_update      ~268 tok
```

### The mechanisms already exist

Two findings that make this an extension rather than new architecture:

1. **Tool loading is already filtered per agent.** `filteredToolRegistrar`
   (`apps/core/src/runner/mcp/server.ts:34`) gates every registration against an `enabledTools`
   set built from `GANTRY_MCP_TOOL_NAMES_JSON`, `GANTRY_ADMIN_MCP_TOOLS_JSON`,
   `GANTRY_ASYNC_TASK_TOOLS_ENABLED` and an access preset (`locked`). 65 is the superset in
   source, not necessarily what any agent receives. The knob exists; the tiering is coarse.
2. **Just-in-time discovery already exists — for external MCP servers.**
   `mcp_search_tools` -> `mcp_describe_tool` -> `mcp_call_tool`. That is exactly the pattern
   proposed here, already proven in this codebase. Applying it to gantry's own long tail is a
   small conceptual step.

### Two axes that have been conflated

- **Residency** — is the schema in the prompt? Costs tokens AND selection accuracy.
- **Birthright** — if invoked, does it interrupt a human? Costs attention.

These are independent, and PERM-5 makes the point: `scheduler_get_dead_letter` was just granted
birthright (correct — it should never interrupt anyone) while remaining a textbook long-tail
tool that arguably should not occupy prompt space by default. The ideal for the long tail is
**both**: discovered on demand, then used without asking.

## Decision (proposed)

Tier the tool surface by residency, reusing the existing filter and the existing
search/describe/call pattern rather than adding machinery.

| Tier | Contents | Loading |
|---|---|---|
| Resident core | displays, `send_message`, `todo_update`, `memory_search`/`save`, `task_*`, `file`, `scheduler_list_jobs` | always in prompt |
| Long tail | `admin_*`, `register_agent`, `service_restart`, all `request_*`, skill install, `scheduler_get_dead_letter`, `memory_dream`/`consolidate`/`demote`, `pattern_candidate_decision` | schema fetched on demand |
| Workflow-bound | tools meaningful only inside one procedure | attached to a skill |

**Keep a resident index, drop the resident schemas.** One line per family — *"scheduler:
list/inspect jobs, runs, events, dead letters; call `mcp_describe_tool` for schemas"* — costs a
few hundred tokens and preserves the agent's awareness that the capability exists.

## Consequences

- Expected saving of roughly 6,700 source-measured tokens per turn (realistically ~9,000–13,000
  once JSON Schema expansion is accounted for), traded for one discovery round-trip on the
  rare turns that need a long-tail tool.
- **The principal risk is discovery blindness**: an agent will not search for a capability it
  cannot imagine having. This is the failure mode that kills naive lazy-loading — the tool
  exists, the agent never looks, the task silently degrades and nobody sees a failure. The
  resident index is the mitigation and is not optional; without it this change is a regression
  disguised as an optimisation. Any implementation must prove the index is sufficient, not
  assume it.
- Skills are the right home for workflow-bound tools only. A skill implies "you are doing this
  kind of work now", which is a poor fit for debug tools: `scheduler_get_dead_letter` is needed
  exactly when something breaks unexpectedly, which is when you can least rely on the right
  skill having been loaded. Debug tools want JIT-plus-birthright, not skill attachment.
- Tiering is a per-agent policy, so it interacts with the `locked` access preset and with agent
  access configuration. Those need to compose predictably rather than each filtering
  independently.
- No permission semantics change. Birthright, the hard-floor rails and the classifier are
  untouched; this is purely about what occupies the prompt.

## Open questions for the grill

1. Exact emitted JSON Schema size — dump the real manifest before committing to the saving.
2. Does the model reliably consult a one-line index, or does it need worked examples? This is
   the assumption the whole design rests on and it should be tested, not asserted.
3. Where does the index live — system prompt, a resident meta-tool, or the agent profile?
4. Should `locked` preset agents get the index at all, or is a smaller fixed set better for them?
5. Does a discovery round-trip interact badly with the interactive permission lane (a JIT fetch
   mid-turn while a prompt is pending)?
6. Is per-family granularity right, or should the index be per-tool one-liners?

See [[semantic-capabilities-are-the-feature]] for the capability layer this must not duplicate.
