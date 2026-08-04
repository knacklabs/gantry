UPDATE permission_decisions
SET tool_id = NULL
WHERE tool_id IN (
  'tool:AskUserQuestion',
  'tool:Config',
  'tool:TaskOutput',
  'tool:TaskStop',
  'tool:TodoWrite',
  'tool:ExitPlanMode',
  'tool:EnterWorktree',
  'tool:ExitWorktree',
  'tool:ListMcpResources',
  'tool:ReadMcpResource'
);

DELETE FROM agent_tool_bindings
WHERE tool_id IN (
  'tool:AskUserQuestion',
  'tool:Config',
  'tool:TaskOutput',
  'tool:TaskStop',
  'tool:TodoWrite',
  'tool:ExitPlanMode',
  'tool:EnterWorktree',
  'tool:ExitWorktree',
  'tool:ListMcpResources',
  'tool:ReadMcpResource'
);

DELETE FROM tool_catalog
WHERE id IN (
  'tool:AskUserQuestion',
  'tool:Config',
  'tool:TaskOutput',
  'tool:TaskStop',
  'tool:TodoWrite',
  'tool:ExitPlanMode',
  'tool:EnterWorktree',
  'tool:ExitWorktree',
  'tool:ListMcpResources',
  'tool:ReadMcpResource'
);
