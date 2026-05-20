import type { AppId } from '../app/app.js';
import type { PermissionPolicyId } from '../permissions/permissions.js';
import type { SandboxProfileId } from '../sandbox/sandbox.js';
import type { BrandedId } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';

export type ToolId = BrandedId<'ToolId'>;
export type AgentToolBindingId = BrandedId<'AgentToolBindingId'>;

export type ToolCatalogKind = 'host' | 'browser' | 'channel' | 'local_cli';
export type ToolCatalogProvider = string;
export type ToolCatalogCategory =
  | 'files'
  | 'search'
  | 'execution'
  | 'web'
  | 'agent'
  | 'mcp'
  | 'channel'
  | 'admin'
  | 'productivity';
export type ToolCatalogStatus = 'active' | 'disabled' | 'error';
export type ToolCatalogProviderToolName = string;

export interface ToolCatalogItem {
  id: ToolId;
  appId: AppId;
  name: string;
  kind: ToolCatalogKind;
  provider: ToolCatalogProvider;
  providerToolName?: ToolCatalogProviderToolName;
  displayName: string;
  description?: string;
  category: ToolCatalogCategory;
  inputSchema?: unknown;
  outputSchema?: unknown;
  risk: 'low' | 'medium' | 'high';
  selectable: boolean;
  status: ToolCatalogStatus;
  permissionPolicyId?: PermissionPolicyId;
  sandboxProfileId?: SandboxProfileId;
  adapterRef: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface AgentToolBinding {
  id: AgentToolBindingId;
  appId: AppId;
  agentId: BrandedId<'AgentId'>;
  toolId: ToolId;
  configVersionId?: BrandedId<'AgentConfigVersionId'>;
  status: 'active' | 'disabled';
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}
