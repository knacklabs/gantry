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
- Agent planning tools are Gantry facades: `todo_update` is a baseline
  non-authority render/update signal, not durable lifecycle storage. Do not
  back display-only plan state with Postgres tables, and do not register
  `delegate_task`, `task_get`, or `task_cancel` until both the canonical
  `AgentDelegation` capability and a real Gantry delegated-task executor exist.
  Never expose provider-native task/todo/subagent tool names here.
