// User-facing labels for technical tool names on permission surfaces.
// Data-only sibling of permission-interaction.ts (line-budget split).
export const USER_FACING_TOOL_LABELS: Record<string, string> = {
  RunCommand: 'exact command access',
  Bash: 'exact command access',
  Browser: 'Browser',
  WebSearch: 'web search',
  WebRead: 'web page access',
  WebFetch: 'web page access',
  FileSearch: 'file search',
  Glob: 'file search',
  Grep: 'file search',
  FileRead: 'file reading',
  Read: 'file reading',
  FileEdit: 'file editing',
  Edit: 'file editing',
  MultiEdit: 'file editing',
  FileWrite: 'file writing',
  Write: 'file writing',
  AgentDelegation: 'agent delegation',
  Agent: 'agent delegation',
  Task: 'agent delegation',
  mcp__gantry__mcp_call_tool: 'MCP Call Tool (any connected server)',
};
