import type { CanonicalJobCoordinationUpdate } from './canonical-job-coordination.postgres.js';

export interface CanonicalJobRecord {
  id: string;
  agentId: string | null;
  name: string;
  prompt: string;
  model: string | null;
  scheduleJson: string;
  status: string;
  targetJson: string;
  silent: boolean;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  consecutiveFailures: number;
  maxConsecutiveFailures: number | null;
  pauseReason: string | null;
  setupState: unknown;
  nextRunAt: string | null;
  lastRunAt: string | null;
  leaseRunId: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobRecordInput {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  model: string | null;
  scheduleJson: string;
  status: string;
  targetJson: string;
  silent: boolean;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  leaseRunId: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CanonicalRunRecord {
  id: string;
  shortId: number | null;
  jobId: string | null;
  executionProviderId: string;
  providerRunId: string | null;
  providerSessionId: string | null;
  workerId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  status: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  resultSummary: string | null;
  errorSummary: string | null;
  notifiedAt: string | null;
}

export interface CanonicalJobTerminalUpdate {
  status?: string;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  leaseRunId?: string | null;
  leaseExpiresAt?: string | null;
  updatedAt: string;
  coordination: CanonicalJobCoordinationUpdate;
}

export interface CanonicalJobEventRecord {
  id: string;
  appId: string;
  runId: string;
  jobId: string;
  type: string;
  payloadJson: string;
  createdAt: string;
}
