import type { AppId } from '../app/app.js';
import type { PermissionPolicyId } from '../permissions/permissions.js';
import type { SandboxProfileId } from '../sandbox/sandbox.js';
import type { BrandedId } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';

export type ToolId = BrandedId<'ToolId'>;

export interface ToolCatalogItem {
  id: ToolId;
  appId: AppId;
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  risk: 'low' | 'medium' | 'high';
  permissionPolicyId?: PermissionPolicyId;
  sandboxProfileId?: SandboxProfileId;
  adapterRef: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface ToolAction {
  id: BrandedId<'ToolActionId'>;
  appId: AppId;
  toolId: ToolId;
  action: string;
  input: unknown;
  output?: unknown;
  status:
    | 'requested'
    | 'approved'
    | 'running'
    | 'completed'
    | 'failed'
    | 'denied';
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}
