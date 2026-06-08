import type { AppId } from '../app/app.js';
import type { AgentId, AgentConfigVersionId } from '../agent/agent.js';
import type { ToolId } from '../tools/tools.js';
import type { BrandedId } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';
import {
  sanitizeSkillDirectoryName,
  type SkillActionPermission,
} from './skill-action-permissions.js';

export type SkillId = BrandedId<'SkillId'>;
export type AgentSkillBindingId = BrandedId<'AgentSkillBindingId'>;

export type SkillSource = 'bundled' | 'agent_created' | 'admin_uploaded';
export type SkillStatus = 'installed' | 'disabled';
export type SkillStorageType = 'local-filesystem' | 'object-store';

export const RESERVED_MATERIALIZED_SKILL_DIRECTORY_NAMES = [
  'gantry-admin',
  'gantry-browser',
] as const;

const RESERVED_MATERIALIZED_SKILL_DIRECTORY_NAME_SET = new Set<string>(
  RESERVED_MATERIALIZED_SKILL_DIRECTORY_NAMES.map((name) => name.toLowerCase()),
);

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
  source: SkillSource;
  status: SkillStatus;
  promptRefs: string[];
  toolIds: ToolId[];
  workflowRefs: string[];
  requiredEnvVars?: string[];
  actionPermissions?: SkillActionPermission[];
  storage?: SkillStorageRef;
  createdBy?: string;
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
  return skill.status === 'installed';
}

export function isSkillMaterializableLocally(skill: SkillCatalogItem): boolean {
  return isSkillUsableForBinding(skill) && !!skill.storage;
}

export function materializedSkillDirectoryNameFor(skillName: string): string {
  return sanitizeSkillDirectoryName(skillName);
}

export function reservedMaterializedSkillDirectoryNameFor(
  skillName: string,
): string | null {
  const directoryName = materializedSkillDirectoryNameFor(skillName);
  const normalized = directoryName.toLowerCase();
  return RESERVED_MATERIALIZED_SKILL_DIRECTORY_NAME_SET.has(normalized)
    ? normalized
    : null;
}
