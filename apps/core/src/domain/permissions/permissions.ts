import type { AppId } from '../app/app.js';
import type { AgentRunId } from '../events/events.js';
import type { ToolId } from '../tools/tools.js';
import type { BrandedId } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';

export type PermissionPolicyId = BrandedId<'PermissionPolicyId'>;
export type PermissionRuleId = BrandedId<'PermissionRuleId'>;
export type PermissionDecisionId = BrandedId<'PermissionDecisionId'>;

export type PermissionEffect =
  | 'allow'
  | 'deny'
  | 'require_approval'
  | 'require_sandbox';

export interface PermissionPolicy {
  id: PermissionPolicyId;
  appId: AppId;
  name: string;
  description?: string;
  status: 'active' | 'disabled';
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface PermissionRule {
  id: PermissionRuleId;
  appId: AppId;
  policyId: PermissionPolicyId;
  priority: number;
  effect: PermissionEffect;
  match: Record<string, unknown>;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface PermissionDecision {
  id: PermissionDecisionId;
  appId: AppId;
  policyId?: PermissionPolicyId;
  ruleIds: PermissionRuleId[];
  runId?: AgentRunId;
  toolId?: ToolId;
  effect: PermissionEffect;
  reason: string;
  approverRef?: string;
  expiresAt?: IsoTimestamp;
  createdAt: IsoTimestamp;
}
