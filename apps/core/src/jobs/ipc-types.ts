import { RegisteredGroup } from '../domain/types.js';
import { IpcDeps } from '../runtime/ipc-domain-types.js';

export interface TaskIpcData {
  type: string;
  authThreadId?: string;
  taskId?: string;
  prompt?: string;
  modelAlias?: string | null;
  modelProfileId?: string | null;
  name?: string;
  scheduleType?: string;
  scheduleValue?: string;
  contextMode?: string;
  script?: string;
  jobId?: string;
  linkedSessions?: string[];
  deliverTo?: string[];
  groupScope?: string;
  threadId?: string | null;
  createdBy?: 'agent' | 'human';
  silent?: boolean;
  timeoutMs?: number;
  cleanupAfterMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  maxConsecutiveFailures?: number;
  executionMode?: string;
  serialize?: boolean;
  allowedTools?: string[];
  statuses?: string[];
  kind?: 'manual' | 'once' | 'recurring';
  runId?: string;
  eventType?: string;
  sinceId?: number;
  since?: string;
  limit?: number;
  groupFolder?: string;
  chatJid?: string;
  targetJid?: string;
  jid?: string;
  folder?: string;
  trigger?: string;
  requiresTrigger?: boolean;
  agentConfig?: RegisteredGroup['agentConfig'];
  payload?: Record<string, unknown>;
}

export interface TaskContext {
  data: TaskIpcData;
  sourceGroup: string;
  isMain: boolean;
  deps: IpcDeps;
  conversationBindings: Record<string, RegisteredGroup>;
  sourceGroupJids: string[];
}

export type TaskHandler = (context: TaskContext) => Promise<void> | void;
