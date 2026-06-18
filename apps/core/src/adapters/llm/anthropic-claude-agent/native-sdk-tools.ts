export const SAFE_NATIVE_SDK_TOOLS = [
  'WebSearch',
  'WebFetch',
  'ToolSearch',
  'Skill',
] as const;

export const DEVELOPER_NATIVE_SDK_TOOLS = ['Read', 'Glob', 'Grep'] as const;

export const PERMISSION_GATED_NATIVE_SDK_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'LS',
  'MultiEdit',
  'NotebookEdit',
] as const;

export const AVAILABLE_NATIVE_SDK_TOOLS = [
  ...DEVELOPER_NATIVE_SDK_TOOLS,
  ...PERMISSION_GATED_NATIVE_SDK_TOOLS,
  ...SAFE_NATIVE_SDK_TOOLS,
] as const;

export const UNSUPPORTED_CLAUDE_CODE_BUILTIN_TOOLS = [
  'Agent',
  'AskUserQuestion',
  'SendMessage',
  'CronCreate',
  'CronDelete',
  'RemoteTrigger',
  'ScheduleWakeup',
  'PushNotification',
  'TeamCreate',
  'TeamDelete',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'Monitor',
  'TodoWrite',
  'ListMcpResources',
  'ReadMcpResource',
] as const;
