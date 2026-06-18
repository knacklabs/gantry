# Gantry Agent System Prompt

Gantry owns the agent system prompt for assistant and employee runs. Provider
or harness defaults are adapter scaffolding only; they are not the product
prompt.

## Renderer Boundary

`apps/core/src/runner/gantry-agent-system-prompt.ts` is the shared pure
renderer. Runtime adapters pass resolved inputs into it:

- prompt mode: `full`, `minimal`, or `none`
- assistant name and persona
- compiled profile prompt and durable-memory boundary state
- selected public tool rules
- workspace, conversation, thread, scheduled-run, sandbox, and timestamp facts

The renderer returns a stable prompt prefix and a dynamic prompt suffix. The
Anthropic adapter inserts the SDK dynamic-boundary marker between those parts.
The DeepAgents adapter receives the same rendered Gantry prompt as one string.

## Sections

Full mode renders sections in this order:

1. Identity
2. Tooling
3. Execution Bias
4. Safety
5. Skills
6. Gantry Control
7. Self-Update
8. Workspace
9. Documentation
10. Workspace Files
11. Sandbox
12. Current Date & Time
13. Assistant Output Directives
14. Runtime
15. Reasoning

Stable identity/tooling/safety/control text stays above the cache boundary.
Volatile workspace, channel, sandbox, date/time, and runtime facts stay below it.

## Public Tool Contract

The prompt names Gantry public tools, not provider-native tools:

- `WebSearch` for discovery and `WebRead` for exact source reading
- `FileSearch`, `FileRead`, `FileEdit`, and `FileWrite` for approved host file
  work
- `file` only for Gantry FileArtifacts
- `mcp_list_tools`, `mcp_describe_tool`, and `mcp_call_tool` for MCP/app tools
- `RunCommand(<argv pattern>)` for scoped command fallback
- `todo_update` for visible task state

Gantry delegation tools stay out of the active prompt and runner surface until a
real delegated-task executor is mounted. Raw provider or harness subagents must
remain hidden.

Tool states are `Ready`, `Needs approval`, `Needs setup`, and `Unavailable in
this mode`. Permission prompt titles use the public shape `Allow <agent> to use
<public tool label>?`.

## Harness Projection

The Anthropic adapter keeps native web/file/command tools as private
projections. Assistant/employee runs use the Gantry prompt; developer persona
runs may keep the Claude Code preset path.

The DeepAgents adapter receives the same Gantry prompt and keeps raw built-ins
hidden. Raw `execute`, `task`, `write_todos`, `write_file`, and `edit_file`
remain unavailable. Raw `ls`, `read_file`, `glob`, and `grep` are visible only
for selected-skill read-only access under virtual `/skills/**`.

DeepAgents web/file parity comes through Gantry-owned wrappers:

- `WebSearch`
- `WebRead`
- `FileSearch`
- `FileRead`
- `FileEdit`
- `FileWrite`

Those wrappers run through Gantry policy and permission IPC using the public
facade names. `RunCommand` remains the separate Gantry-owned LangChain shell
tool, not raw DeepAgents execution.
