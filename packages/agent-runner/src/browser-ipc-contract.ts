export const BROWSER_IPC_ACTIONS = [
  'browser_profile_list',
  'browser_launch',
  'browser_close',
  'browser_status',
] as const;

export type BrowserIpcAction = (typeof BROWSER_IPC_ACTIONS)[number];
