import type { AppId } from '../app/app.js';
import type { ToolId } from '../tools/tools.js';
import type { SkillId } from '../skills/skills.js';
import type { PermissionPolicyId } from '../permissions/permissions.js';
import type {
  SandboxProfileId,
  WorkspaceSnapshotId,
} from '../sandbox/sandbox.js';
import type { BrandedId } from '../../shared/ids/branded-id.js';
import type { DurationMs, IsoTimestamp } from '../../shared/time/primitives.js';

export type AgentId = BrandedId<'AgentId'>;
export type AgentConfigVersionId = BrandedId<'AgentConfigVersionId'>;
export type LlmProfileId = BrandedId<'LlmProfileId'>;

export type ThinkingMode = 'adaptive' | 'enabled' | 'disabled';
export type ThinkingEffort = 'low' | 'medium' | 'high' | 'max';

export interface LlmProfile {
  id: LlmProfileId;
  appId: AppId;
  purpose: 'chat' | 'planning' | 'coding' | 'embedding' | 'summarization';
  modelAlias: string;
  thinking?: {
    mode: ThinkingMode;
    effort?: ThinkingEffort;
    budgetTokens?: number;
  };
  budget?: {
    maxInputTokens?: number;
    maxOutputTokens?: number;
    timeoutMs?: DurationMs;
  };
  credentialProfileRef?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface Agent {
  id: AgentId;
  appId: AppId;
  name: string;
  status: 'active' | 'disabled';
  currentConfigVersionId?: AgentConfigVersionId;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface AgentConfigVersion {
  id: AgentConfigVersionId;
  appId: AppId;
  agentId: AgentId;
  version: number;
  promptProfileRef: string;
  llmProfileId: LlmProfileId;
  toolIds: ToolId[];
  skillIds: SkillId[];
  permissionPolicyIds: PermissionPolicyId[];
  sandboxProfileId?: SandboxProfileId;
  workspaceSnapshotId?: WorkspaceSnapshotId;
  runtimeLimits?: {
    timeoutMs?: DurationMs;
    maxRetries?: number;
  };
  createdAt: IsoTimestamp;
}
