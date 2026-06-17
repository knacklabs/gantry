# Runner MCP Guidance

## Local Rules

- MCP tool descriptions are channel-neutral by default. Do not mention concrete
  channel providers in descriptions or schema examples unless the tool lives in
  a provider adapter or the provider-specific wording is tracked by an exact
  temporary architecture exception.
- `mcp_list_tools` and `mcp_describe_tool` are source inventory, not execution
  authority. Keep search, pagination, `tool_ref`, one-tool schema detail, and
  call hints distinct from grants; `mcp_call_tool` must recheck reviewed
  current-run authority before every tool execution.
- Agent planning/delegation tools are Gantry facades: `todo_update` is
  baseline non-authority state, while `delegate_task`, `task_get`, and
  `task_cancel` mount only when the canonical `AgentDelegation` capability is
  selected. Never expose provider-native task/todo/subagent tool names here.
