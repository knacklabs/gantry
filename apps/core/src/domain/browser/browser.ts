import type { AgentId } from '../agent/agent.js';
import type { AppId } from '../app/app.js';
import type { PermissionPolicyId } from '../permissions/permissions.js';
import type { BrandedId } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';

export type BrowserProfileId = BrandedId<'BrowserProfileId'>;

export interface BrowserProfile {
  id: BrowserProfileId;
  appId: AppId;
  agentId?: AgentId;
  label: string;
  storageStateRef?: string;
  authMarkers: string[];
  permissionPolicyId?: PermissionPolicyId;
  status: 'active' | 'disabled';
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}
