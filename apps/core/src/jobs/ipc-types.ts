import { ConversationRoute, JobAccessRequirement } from '../domain/types.js';
import { IpcDeps } from '../runtime/ipc-domain-types.js';

export interface TaskIpcData {
  type: string;
  appId?: string;
  authThreadId?: string;
  responseKeyId?: string;
  taskId?: string;
  runHandle?: string;
  prompt?: string;
  modelAlias?: string | null;
  name?: string;
  scheduleType?: string;
  scheduleValue?: string;
  contextMode?: string;
  jobId?: string;
  executionContext?: {
    conversationJid: string;
    threadId: string | null;
    workspaceKey: string;
    sessionId?: string | null;
  };
  notificationRoutes?: Array<{
    conversationJid: string;
    threadId: string | null;
    label: string;
  }>;
  accessRequirements?: JobAccessRequirement[];
  workspaceKey?: string;
  threadId?: string | null;
  createdBy?: 'agent' | 'human';
  silent?: boolean;
  timeoutMs?: number;
  cleanupAfterMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  maxConsecutiveFailures?: number;
  confirm?: boolean;
  confirmationToken?: string;
  statuses?: string[];
  kind?: 'manual' | 'once' | 'recurring';
  runId?: string;
  eventType?: string;
  sinceId?: number;
  since?: string;
  limit?: number;
  workspaceFolder?: string;
  chatJid?: string;
  targetJid?: string;
  jid?: string;
  folder?: string;
  trigger?: string;
  requiresTrigger?: boolean;
  agentConfig?: ConversationRoute['agentConfig'];
  payload?: Record<string, unknown>;
}

export interface TaskContext {
  data: TaskIpcData;
  sourceAgentFolder: string;
  ipcBaseDir?: string;
  deps: IpcDeps;
  conversationBindings: Record<string, ConversationRoute>;
  sourceAgentFolderJids: string[];
}

export type TaskHandler = (context: TaskContext) => Promise<void> | void;
