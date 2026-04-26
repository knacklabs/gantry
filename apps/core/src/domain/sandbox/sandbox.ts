import type { AppId } from '../app/app.js';
import type { AgentRunId } from '../events/events.js';
import type { PermissionDecisionId } from '../permissions/permissions.js';
import type { BrandedId } from '../../shared/ids/branded-id.js';
import type { DurationMs, IsoTimestamp } from '../../shared/time/primitives.js';

export type SandboxProfileId = BrandedId<'SandboxProfileId'>;
export type SandboxLeaseId = BrandedId<'SandboxLeaseId'>;
export type WorkspaceSnapshotId = BrandedId<'WorkspaceSnapshotId'>;

export interface SandboxProfile {
  id: SandboxProfileId;
  appId: AppId;
  name: string;
  filesystem: 'none' | 'read_only' | 'workspace_write' | 'host';
  network: 'none' | 'restricted' | 'full';
  process: 'none' | 'restricted' | 'host';
  browser: 'none' | 'profiled';
  credentialAccess: 'none' | 'brokered';
  timeoutMs: DurationMs;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface SandboxLease {
  id: SandboxLeaseId;
  appId: AppId;
  profileId: SandboxProfileId;
  runId: AgentRunId;
  permissionDecisionId: PermissionDecisionId;
  status: 'active' | 'expired' | 'released';
  grantedAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  releasedAt?: IsoTimestamp;
}

export interface WorkspaceSnapshot {
  id: WorkspaceSnapshotId;
  appId: AppId;
  rootRef: string;
  mounts: Array<{
    ref: string;
    writable: boolean;
  }>;
  promptRefs: string[];
  contextRefs: string[];
  createdAt: IsoTimestamp;
}
