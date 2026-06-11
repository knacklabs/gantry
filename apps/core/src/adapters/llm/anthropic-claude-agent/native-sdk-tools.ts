// The native tool-name vocabulary lives in `shared/native-sdk-tool-names`
// (importable by config + adapters); re-exported here so existing importers
// keep their stable path.
export {
  SAFE_NATIVE_SDK_TOOLS,
  DEVELOPER_NATIVE_SDK_TOOLS,
  PERMISSION_GATED_NATIVE_SDK_TOOLS,
  AVAILABLE_NATIVE_SDK_TOOLS,
} from '../../../shared/native-sdk-tool-names.js';

export const UNSUPPORTED_CLAUDE_CODE_BUILTIN_TOOLS = [
  'AskUserQuestion',
  'SendMessage',
  'CronCreate',
  'CronDelete',
  'RemoteTrigger',
  'ScheduleWakeup',
  'PushNotification',
  'TeamCreate',
  'TeamDelete',
  'TaskOutput',
  'TaskStop',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'Monitor',
  'TodoWrite',
  'ListMcpResources',
  'ReadMcpResource',
] as const;
