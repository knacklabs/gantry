import { RegisteredGroup } from '../core/types.js';
import { IpcDeps } from './ipc-domain-types.js';

export interface TaskIpcData {
  type: string;
  authThreadId?: string;
  taskId?: string;
  prompt?: string;
  model?: string;
  name?: string;
  scheduleType?: string;
  scheduleValue?: string;
  contextMode?: string;
  script?: string;
  jobId?: string;
  linkedSessions?: string[];
  deliverTo?: string[];
  groupScope?: string;
  threadId?: string;
  createdBy?: 'agent' | 'human';
  silent?: boolean;
  timeoutMs?: number;
  cleanupAfterMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  maxConsecutiveFailures?: number;
  executionMode?: string;
  serialize?: boolean;
  statuses?: string[];
  runId?: string;
  eventType?: string;
  sinceId?: number;
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
  registeredGroups: Record<string, RegisteredGroup>;
  sourceGroupJids: string[];
}

export type TaskHandler = (context: TaskContext) => Promise<void> | void;
