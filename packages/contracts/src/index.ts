export const MEMORY_IPC_ACTIONS = [
  'memory_search',
  'memory_save',
  'memory_patch',
  'memory_consolidate',
  'memory_dream',
  'procedure_save',
  'procedure_patch',
] as const;

export type MemoryIpcAction = (typeof MEMORY_IPC_ACTIONS)[number];

export interface MemoryIpcRequest {
  requestId: string;
  action: MemoryIpcAction;
  payload: Record<string, unknown>;
}

export interface MemoryIpcResponse {
  ok: boolean;
  requestId: string;
  provider?: string;
  data?: unknown;
  error?: string;
}

export const BROWSER_IPC_ACTIONS = [
  'browser_profile_list',
  'browser_launch',
  'browser_close',
  'browser_status',
] as const;

export type BrowserIpcAction = (typeof BROWSER_IPC_ACTIONS)[number];
