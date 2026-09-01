export type JobSemanticCheckpointMilestone = string;

export interface JobCheckpointArtifactReference {
  artifactId: string;
  contentHash: string;
  kind: string;
}

export interface JobSemanticCheckpointPayload {
  safePhase: string;
  artifactRefs: JobCheckpointArtifactReference[];
  evaluatorInvocationRef?: string | null;
  pendingInteractionRef?: string | null;
  nextAction: string;
  cumulativeRuntimeMs: number;
}

export interface JobSemanticCheckpoint {
  id: string;
  appId: string;
  agentId: string;
  jobId: string;
  runId: string;
  sequence: number;
  workerInstanceId: string;
  fencingVersion: number;
  milestone: JobSemanticCheckpointMilestone;
  payload: JobSemanticCheckpointPayload;
  payloadHash: string;
  createdAt: string;
}

export type AppendJobSemanticCheckpointResult =
  | { outcome: 'persisted'; checkpoint: JobSemanticCheckpoint }
  | { outcome: 'replayed'; checkpoint: JobSemanticCheckpoint }
  | { outcome: 'fenced' }
  | { outcome: 'sequence_conflict'; latestSequence: number };

export interface JobSemanticCheckpointRepository {
  appendCheckpoint(input: {
    id: string;
    appId: string;
    agentId: string;
    jobId: string;
    runId: string;
    leaseToken: string;
    expectedPreviousSequence: number;
    milestone: JobSemanticCheckpointMilestone;
    payload: JobSemanticCheckpointPayload;
    now?: string;
  }): Promise<AppendJobSemanticCheckpointResult>;

  getLatestCheckpoint(input: {
    appId: string;
    agentId: string;
    jobId: string;
  }): Promise<JobSemanticCheckpoint | null>;

  getCheckpoint(input: {
    appId: string;
    agentId: string;
    jobId: string;
    sequence: number;
  }): Promise<JobSemanticCheckpoint | null>;
}

export function jobArtifactScope(jobId: string): string {
  return `job-${stableSha256Json({ jobId }).slice(0, 32)}`;
}
import { stableSha256Json } from '../../shared/stable-hash.js';
