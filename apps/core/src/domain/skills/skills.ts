import type { AppId } from '../app/app.js';
import type { AgentId, AgentConfigVersionId } from '../agent/agent.js';
import type { ToolId } from '../tools/tools.js';
import type { BrandedId } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';

export type SkillId = BrandedId<'SkillId'>;
export type AgentSkillBindingId = BrandedId<'AgentSkillBindingId'>;

export type SkillSource =
  | 'bundled'
  | 'agent_created'
  | 'admin_uploaded'
  | 'provider_managed';
export type SkillStatus = 'draft' | 'approved' | 'rejected' | 'disabled';
export type SkillStorageType = 'local-filesystem' | 'object-store';
export type SkillProvider = string;
export type SkillProviderType = string;

export interface SkillProviderRef {
  provider: SkillProvider;
  skillId: string;
  type: SkillProviderType;
  version?: string;
}

export interface SkillStorageRef {
  storageType: SkillStorageType;
  storageRef: string;
  contentHash: string;
  sizeBytes: number;
}

export interface SkillCatalogItem {
  id: SkillId;
  appId: AppId;
  agentId?: AgentId;
  name: string;
  description?: string;
  version: string;
  source: SkillSource;
  status: SkillStatus;
  promptRefs: string[];
  toolIds: ToolId[];
  workflowRefs: string[];
  storage?: SkillStorageRef;
  providerRef?: SkillProviderRef;
  createdBy?: string;
  approvedBy?: string;
  approvedAt?: IsoTimestamp;
  rejectedBy?: string;
  rejectedAt?: IsoTimestamp;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface AgentSkillBinding {
  id: AgentSkillBindingId;
  appId: AppId;
  agentId: AgentId;
  skillId: SkillId;
  configVersionId?: AgentConfigVersionId;
  status: 'active' | 'disabled';
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export function isSkillUsableForBinding(skill: SkillCatalogItem): boolean {
  return skill.status === 'approved';
}

export function isSkillMaterializableLocally(skill: SkillCatalogItem): boolean {
  return (
    isSkillUsableForBinding(skill) && !!skill.storage && !skill.providerRef
  );
}
